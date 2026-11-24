import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import prisma from '../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { calculateDisbursement, validateDisbursement } from '../../../../lib/calculation';
import { getActiveCreditParameters } from '../../../../lib/credit-parameters';
import { checkIdempotency, saveIdempotencyRecordTx } from '../../../../lib/idempotency';
import { handleOptions, getCorsHeaders } from '../../../../lib/cors';
import { isEnabled } from '../../../../lib/feature-flags';
import { adjustWallet, WALLET_A_ID, InsufficientWalletBalanceError } from '../../../../lib/wallets';
import { isInCohort } from '../../../../lib/cohort';
import { recordDecision, type DecisionRecord } from '../../../../lib/decision-log';
import { computeWindows } from '../../../../lib/recovery-window';
import { getActiveWindowParameters, getDailyRateKobo } from '../../../../lib/obligation-status';
import { MONEY_TX_OPTIONS, callerGone, isDatabaseOverloaded, overloadedResponse } from '../../../../lib/db-overload';

/** Customer statuses that may never receive a new advance. */
const BLOCKED_CUSTOMER_STATUSES = ['blacklisted', 'inactive', 'suspended', 'blocked'];
const OPEN_OBLIGATION_STATUSES = ['Current', 'Watch', 'Delayed', 'Default'] as const;
const SCORING_TIMEOUT_MS = 8000; // §3.4 / §9.2: hard timeout, decline on expiry

/** A decline decided inside the disbursement transaction (rolls it back). */
class DeclineError extends Error {
  constructor(public reason: string, public rule: string, public extraFeatures: Record<string, unknown> = {}) {
    super(reason);
  }
}

export function OPTIONS(request: Request) {
  return handleOptions(request);
}

/**
 * POST /api/transactions/debit — spec §3 disbursement sequence.
 *
 *   validate request (4xx) → caller, idempotency, API key → operational
 *   controls → §2 calculation + envelope/tier validation (4xx) → §3.2 cohort
 *   check → platform rules (blacklist, concurrency) → §3.4 scoring (8s,
 *   envelope clamp) → one DB transaction: customer lock + re-check,
 *   obligation with §5 windows, decision record, ledger, §3.3 Wallet A guard.
 *
 * Every decline is HTTP 200 with a decision payload (§9.1) and every
 * decision, approved or declined, is written to DecisionLog (§6.1).
 */
async function debitHandler(request: AuthenticatedRequest) {
  const cors = getCorsHeaders(request.headers.get('origin'));
  const json = (body: object, status: number) => NextResponse.json(body, { status, headers: cors });

  try {
    // ── 1. Request validation (malformed = 4xx, §9.1) ──────────────────────
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: 'Request body must be valid JSON' }, 400);
    }
    const { meterToken, amount, disco } = body ?? {};
    if (!meterToken || typeof meterToken !== 'string' || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return json({ success: false, message: 'Missing or invalid required fields: meterToken, amount, disco' }, 400);
    }

    // ── 2. Caller, idempotency, API key ────────────────────────────────────
    const userType = request.user?.userType;
    const isAggregator = userType === UserType.AGGREGATOR;
    const isDisco = userType === UserType.DISCO_ADMIN;
    if (!isAggregator && !isDisco) {
      return json({ success: false, message: 'Only aggregators or disco admins can perform debit transactions' }, 403);
    }

    const [aggregator, discoAdmin] = await Promise.all([
      isAggregator ? prisma.aggregator.findUnique({ where: { userId: request.user!.userId } }) : Promise.resolve(null),
      isDisco
        ? prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId } })
        : prisma.discoAdmin.findUnique({ where: { name: disco } }),
    ]);
    if (isAggregator && !aggregator) return json({ success: false, message: 'Aggregator account not found' }, 404);
    if (!discoAdmin) return json({ success: false, message: 'Disco not found' }, 404);

    const callerType = isAggregator ? 'aggregator' : 'disco';
    const callerId = isAggregator ? aggregator!.id : discoAdmin.id;

    const idempotencyKey = request.headers.get('Idempotency-Key');
    const idempotencyReplay = await checkIdempotency(idempotencyKey ?? '', callerId, callerType, cors);
    if (idempotencyReplay) return idempotencyReplay;

    const apiKey = request.headers.get('API-Key');
    if (!apiKey) return json({ success: false, message: 'API key is required' }, 401);
    const expectedApiKey = isAggregator ? aggregator!.apiKey : discoAdmin.apiKey;
    if (expectedApiKey !== apiKey) return json({ success: false, message: 'Invalid API key' }, 403);

    const callerStatus = isAggregator ? aggregator!.status : discoAdmin.status;
    if (callerStatus.toLowerCase() !== 'active') return json({ success: false, message: 'Account is not active' }, 403);

    // ── 3. Operational controls ────────────────────────────────────────────
    if (await isEnabled('maintenance_mode')) {
      return json({ success: false, message: 'System is under maintenance. Please try again shortly.' }, 503);
    }

    // ── 4. §2 calculation and envelope validation (rejects write nothing) ─
    const params = await getActiveCreditParameters();
    let calc;
    try {
      calc = calculateDisbursement(amount, params.rateBps);
      validateDisbursement(calc, {
        minObligationKobo: params.minObligationKobo,
        maxObligationKobo: params.maxObligationKobo,
        obligationTiersKobo: params.obligationTiersKobo,
      });
    } catch (validationError: any) {
      return json({ success: false, message: validationError.message }, 400);
    }

    const decisionId = randomUUID();
    let customer = await prisma.customer.findUnique({ where: { meterToken } });
    const baseDecision = {
      decisionId,
      meterToken,
      parameterVersion: params.version,
      requestedKobo: calc.obligationKobo,
    };
    // Platform-rule declines: logged (§6.1) and returned as HTTP 200 (§9.1).
    const declineByRule = async (
      rule: string,
      reason: string,
      features: Record<string, unknown>,
      band: string,
      extra: object = {}
    ) => {
      await recordDecision({
        ...baseDecision,
        band,
        features,
        modelVersion: `rule:${rule}`,
        decision: 'declined',
        declineReason: reason,
        latencyMs: 0,
      });
      return json({ success: true, decision: 'declined', reason, requestedKobo: calc!.obligationKobo, decisionId, ...extra }, 200);
    };

    if (!(await isEnabled('disbursements_enabled'))) {
      return declineByRule('disbursements_suspended', 'Disbursements are temporarily suspended. Please try again later.',
        { meter_id: meterToken, disbursements_enabled: false }, customer?.band ?? 'B');
    }

    // ── 5. §3.2 cohort check — no scoring call outside the cohort ─────────
    if (!(await isInCohort(meterToken))) {
      return declineByRule('cohort', 'Meter is not in the participating cohort',
        { meter_id: meterToken, in_cohort: false }, customer?.band ?? 'B');
    }

    // ── 6. Feature vector ──────────────────────────────────────────────────
    const vendMetrics = await prisma.customerVendMetrics.findUnique({ where: { meterToken } });
    const band = customer?.band ?? vendMetrics?.tariffBand ?? 'B';
    // A brand-new customer has no obligations. (`customerId: undefined` used
    // to drop the filter and match any customer's loan.)
    const openObligationCount = customer
      ? await prisma.obligation.count({
          where: { customerId: customer.id, status: { in: [...OPEN_OBLIGATION_STATUSES] }, remainingKobo: { gt: 0 } },
        })
      : 0;

    const scoringParams = {
      meter_id: meterToken,
      meter_status: vendMetrics?.meterStatus ?? 'Unknown',
      total_vends: vendMetrics?.totalVends ?? 0,
      vend_count_last_60_days: vendMetrics?.vendCountLast60Days ?? 0,
      days_since_last_vend: vendMetrics?.daysSinceLastVend ?? 0,
      median_vend_amount: vendMetrics?.medianVendAmountNaira ? Number(vendMetrics.medianVendAmountNaira) : 0,
      vend_amount_volatility: vendMetrics?.vendAmountVolatility ? Number(vendMetrics.vendAmountVolatility) : 0,
      inter_vend_variance: vendMetrics?.interVendVarianceDays ? Number(vendMetrics.interVendVarianceDays) : 0,
      failed_vend_ratio: vendMetrics?.failedVendRatio ? Number(vendMetrics.failedVendRatio) : 0,
      has_active_obligation: openObligationCount > 0,
    };
    // Inputs to the platform rules, logged alongside the scoring features.
    const ruleFeatures = {
      in_cohort: true,
      customer_status: customer?.status ?? 'new',
      open_obligation_count: openObligationCount,
      max_concurrent_obligations: params.maxConcurrentObligations,
      max_obligation_kobo: params.maxObligationKobo,
    };
    const features = { ...scoringParams, ...ruleFeatures };

    // ── 7. Platform rules (§6.3 envelope exclusions) ───────────────────────
    if (customer && BLOCKED_CUSTOMER_STATUSES.includes(customer.status.toLowerCase())) {
      return declineByRule('eligibility_exclusion', 'Meter is not eligible for advances', features, band);
    }
    if (openObligationCount >= params.maxConcurrentObligations) {
      return declineByRule('concurrent_obligations', 'Meter already has the maximum number of outstanding advances', features, band);
    }
    if (!(await isEnabled('scoring_engine_enabled'))) {
      return declineByRule('scoring_disabled', 'Eligibility check temporarily unavailable. Please try again later.', features, band);
    }

    // Don't call the scoring engine for a caller that has already gone.
    const goneBeforeScoring = callerGone(request);
    if (goneBeforeScoring) return goneBeforeScoring;

    // ── 8. §3.4 scoring — 8s hard timeout, decline rather than proceed ────
    const scoringStartMs = Date.now();
    let scoringResponse: any;
    try {
      const response = await fetch(`${process.env.SCORING_ENGINE_URL}/decision`, {
        method: 'POST',
        signal: AbortSignal.timeout(SCORING_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${process.env.SCORING_ENGINE_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(scoringParams),
      });
      if (!response.ok) throw new Error(`Scoring engine returned status ${response.status}`);
      scoringResponse = await response.json();
    } catch (error: any) {
      // §10: scoring service unavailability is a financial-action alert.
      Sentry.captureException(error, { tags: { component: 'scoring-engine', type: 'scoring_unavailable' } });
      await recordDecision({
        ...baseDecision, band, features, modelVersion: 'unknown', decision: 'declined',
        declineReason: `Scoring engine error: ${error.message}`, latencyMs: Date.now() - scoringStartMs,
      });
      return json({ success: true, decision: 'declined', reason: 'Scoring service unavailable. Please retry.', requestedKobo: calc.obligationKobo, decisionId }, 200);
    }
    const scoringLatencyMs = Date.now() - scoringStartMs;
    const modelVersion = scoringResponse?.model_version ?? 'unknown';

    // §6.3: the envelope is a hard constraint — a returned limit never
    // exceeds the maximum advance, whatever the score. A missing or invalid
    // limit is a decline (Math.round(NaN) used to compare false and pass).
    const engineLimitKobo = Number.isFinite(Number(scoringResponse?.approved_amount))
      ? Math.round(Number(scoringResponse.approved_amount) * 100)
      : null;
    const approvedLimitKobo = engineLimitKobo === null ? null : Math.min(engineLimitKobo, params.maxObligationKobo);
    const scoredFeatures = { ...features, engine_limit_kobo: engineLimitKobo, score: scoringResponse?.score ?? null };

    let declineReason: string | null = null;
    if (scoringResponse?.eligible !== true) {
      declineReason = scoringResponse?.reason ?? 'Not eligible based on scoring evaluation';
    } else if (approvedLimitKobo === null || approvedLimitKobo <= 0) {
      declineReason = 'Scoring engine approved without a valid approved_amount';
    } else if (approvedLimitKobo < calc.obligationKobo) {
      declineReason = 'Requested amount exceeds approved limit';
    }
    if (declineReason) {
      await recordDecision({
        ...baseDecision, band, features: scoredFeatures, modelVersion, decision: 'declined', declineReason,
        approvedLimitKobo: null, latencyMs: scoringLatencyMs,
      });
      return json({
        success: true, decision: 'declined', reason: declineReason, requestedKobo: calc.obligationKobo,
        approvedKobo: approvedLimitKobo, decisionId,
        scoringEvaluation: { score: scoringResponse?.score, band: scoringResponse?.band },
      }, 200);
    }

    // ── 9. §5 recovery windows, fixed at disbursement ─────────────────────
    const disbursementDate = new Date();
    const [windowParams, dailyRate] = await Promise.all([
      getActiveWindowParameters(),
      getDailyRateKobo(band, disbursementDate),
    ]);
    const windows = computeWindows(calc.disbursedKobo, dailyRate, disbursementDate, windowParams);
    const approvedDecision: DecisionRecord = {
      ...baseDecision, band, features: scoredFeatures, modelVersion, decision: 'approved',
      approvedLimitKobo, latencyMs: scoringLatencyMs,
    };

    // ── 10. One transaction: register, book, guard Wallet A ───────────────
    // Order matters for throughput: per-meter work first; rows shared by
    // every advance (disco, aggregator, Wallet A) last, so their locks are
    // held for milliseconds. Wallet A is locked and re-checked before it is
    // debited (§3.3); if it is short, everything rolls back.
    // Nor open the disbursement transaction for one (nothing has been written).
    const goneBeforeTx = callerGone(request);
    if (goneBeforeTx) return goneBeforeTx;

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Customer: create if new (race-safe), lock, re-check. Two first-ever
        // advances for one meter must not both pass or 500 on the unique key.
        if (!customer) {
          await tx.$executeRaw`
            INSERT INTO "Customers"
              ("meterToken", "lastInteraction", "riskLevel", outstanding, status, state, band, "dateAdded")
            VALUES
              (${meterToken}, NOW(), 'low', 0, 'active', 'active', ${band}::"TariffBand", NOW())
            ON CONFLICT ("meterToken") DO NOTHING`;
        }
        const lockedCustomer = await tx.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Customers" WHERE "meterToken" = ${meterToken} FOR UPDATE`;
        customer = await tx.customer.findUniqueOrThrow({ where: { id: lockedCustomer[0].id } });

        if (BLOCKED_CUSTOMER_STATUSES.includes(customer.status.toLowerCase())) {
          throw new DeclineError('Meter is not eligible for advances', 'eligibility_exclusion', { customer_status: customer.status });
        }
        const openNow = await tx.obligation.count({
          where: { customerId: customer.id, status: { in: [...OPEN_OBLIGATION_STATUSES] }, remainingKobo: { gt: 0 } },
        });
        if (openNow >= params.maxConcurrentObligations) {
          throw new DeclineError('Meter already has the maximum number of outstanding advances', 'concurrent_obligations', { open_obligation_count: openNow });
        }

        const transactionId = `DBT-${Date.now()}-${Math.random().toString(36).slice(2, 11).toUpperCase()}`;
        const transaction = await tx.transactions.create({
          data: {
            date: disbursementDate,
            transactionId,
            aggregatorId: isAggregator ? aggregator!.id : null,
            customerId: customer.id,
            branch: meterToken,
            amount: new Prisma.Decimal(calc.obligationKobo).div(100),
            obligationKobo: calc.obligationKobo,
            disbursedKobo: calc.disbursedKobo,
            serviceKobo: calc.serviceKobo,
            rateBps: calc.rateBps,
            transactionType: 'debit',
            transactionStatus: 'successful',
            paymentStatus: 'unpaid',
            discoAdminId: discoAdmin.id,
          },
        });

        // §3.7: full obligation registered against the meter, status Current.
        const obligation = await tx.obligation.create({
          data: {
            transactionId: transaction.id,
            meterToken,
            customerId: customer.id,
            discoAdminId: discoAdmin.id,
            obligationKobo: calc.obligationKobo,
            disbursedKobo: calc.disbursedKobo,
            serviceKobo: calc.serviceKobo,
            remainingKobo: calc.obligationKobo,
            rateBps: calc.rateBps,
            status: 'Current',
            band: customer.band,
            disbursementDate,
            expectedRecoveryDate: windows.expectedRecoveryDate,
            watchDate: windows.watchDate,
            delayedDate: windows.delayedDate,
            defaultDate: windows.defaultDate,
            windowParameterVersion: windowParams.version,
          },
        });

        // The approved decision is written with the disbursement, so a log entry
        // saying "approved" always has a transaction behind it.
        await recordDecision({ ...approvedDecision, correlationId: transactionId }, tx);

        const updatedCustomer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            outstanding: { increment: new Prisma.Decimal(calc.obligationKobo).div(100) },
            lastInteraction: new Date(),
          },
        });

        await tx.audit.create({
          data: {
            userId: request.user!.userId,
            employeeName: request.user!.email,
            emailAddress: request.user!.email,
            activity: `Debit ${transactionId}: meterToken=${meterToken}, obligation=${calc.obligationKobo}k, disbursed=${calc.disbursedKobo}k, service=${calc.serviceKobo}k, decision=${decisionId}`,
            meterId: meterToken,
          },
        });

        const responseBodyForIdempotency = {
          success: true,
          decision: 'approved',
          message: 'Debit transaction processed successfully',
          data: {
            transactionId,
            obligationId: obligation.id,
            decisionId,
            calculation: {
              obligationKobo: calc.obligationKobo,
              disbursedKobo: calc.disbursedKobo,
              serviceKobo: calc.serviceKobo,
              rateBps: calc.rateBps,
            },
          },
        };
        await saveIdempotencyRecordTx(tx, idempotencyKey!, callerId, callerType, 201, responseBodyForIdempotency);

        // ── Shared rows last ──
        const updatedDiscoAdmin = await tx.discoAdmin.update({
          where: { id: discoAdmin.id },
          data: {
            balance: { decrement: new Prisma.Decimal(calc.disbursedKobo).div(100) },
            outstanding: { increment: new Prisma.Decimal(calc.disbursedKobo).div(100) },
            lastInteraction: new Date(),
          },
        });
        if (isAggregator && aggregator) {
          await tx.aggregator.update({
            where: { id: aggregator.id },
            data: {
              outstanding: { increment: new Prisma.Decimal(calc.disbursedKobo).div(100) },
              lastInteraction: new Date(),
            },
          });
        }
        // §3.3/§7.2: Wallet A locked and re-checked; never negative. §3.6: only
        // the disbursed (token) value leaves Wallet A; Wallet B is untouched.
        const { newBalanceKobo } = await adjustWallet(
          tx, WALLET_A_ID(), -calc.disbursedKobo, 'disbursement',
          `Disbursement for meter ${meterToken}: ${calc.disbursedKobo} kobo`, transactionId
        );

        return { transaction, obligation, updatedCustomer, updatedDiscoAdmin, newWalletABalanceKobo: newBalanceKobo };
      }, MONEY_TX_OPTIONS);
    } catch (txError: any) {
      // Declined inside the transaction (it rolled back, nothing was
      // written): record the final decision (§6.1) and return 200 (§9.1).
      if (txError instanceof DeclineError || txError instanceof InsufficientWalletBalanceError) {
        const isWallet = txError instanceof InsufficientWalletBalanceError;
        const reason = isWallet ? 'Credit wallet exhausted. New advances temporarily unavailable.' : txError.reason;
        await recordDecision({
          ...approvedDecision,
          decision: 'declined',
          declineReason: isWallet ? `Wallet A balance insufficient: ${reason}` : `${reason} (rule:${(txError as DeclineError).rule})`,
          approvedLimitKobo: null,
          features: {
            ...scoredFeatures,
            ...(isWallet
              ? { wallet_a_balance_kobo: (txError as InsufficientWalletBalanceError).balanceKobo }
              : (txError as DeclineError).extraFeatures),
          },
        });
        return json({ success: true, decision: 'declined', reason, requestedKobo: calc.obligationKobo, decisionId }, 200);
      }
      throw txError;
    }

    // §7.2: configurable low-balance threshold raises an alert.
    const lowBalanceThreshold = Number(process.env.LOW_WALLET_A_BALANCE_KOBO ?? '5000000');
    if (result.newWalletABalanceKobo < lowBalanceThreshold) {
      const message = `ALERT: Wallet A balance low. Remaining: ${result.newWalletABalanceKobo} kobo. Top up required.`;
      Sentry.captureMessage(message, { level: 'warning', tags: { type: 'low_wallet_a_balance' } });
      await prisma.audit.create({ data: { employeeName: 'System', emailAddress: 'system@monsera.com', activity: message } });
    }

    return json({
      success: true,
      decision: 'approved',
      message: 'Debit transaction processed successfully',
      data: {
        transaction: result.transaction,
        obligation: {
          id: result.obligation.id,
          status: result.obligation.status,
          obligationKobo: result.obligation.obligationKobo,
          disbursedKobo: result.obligation.disbursedKobo,
          serviceKobo: result.obligation.serviceKobo,
          remainingKobo: result.obligation.remainingKobo,
          expectedRecoveryDate: result.obligation.expectedRecoveryDate,
          watchDate: result.obligation.watchDate,
          delayedDate: result.obligation.delayedDate,
          defaultDate: result.obligation.defaultDate,
        },
        calculation: {
          obligationKobo: calc.obligationKobo,
          disbursedKobo: calc.disbursedKobo,
          serviceKobo: calc.serviceKobo,
          rateBps: calc.rateBps,
        },
        customer: {
          id: result.updatedCustomer.id,
          meterToken: result.updatedCustomer.meterToken,
          newOutstanding: Number(result.updatedCustomer.outstanding),
          status: result.updatedCustomer.status,
        },
        disco: {
          id: result.updatedDiscoAdmin.id,
          name: result.updatedDiscoAdmin.name,
          newBalance: Number(result.updatedDiscoAdmin.balance),
        },
        scoringEvaluation: {
          decision: 'approved',
          score: scoringResponse?.score,
          band: scoringResponse?.band,
          approvedLimitKobo,
          requestedKobo: calc.obligationKobo,
          decisionId,
        },
      },
    }, 201);
  } catch (error: any) {
    if (isDatabaseOverloaded(error)) return overloadedResponse(cors, 'debit', error);
    Sentry.captureException(error, { tags: { type: 'disbursement_failure' } });
    console.error('Debit transaction error:', error);
    return json({ success: false, message: 'Failed to process debit transaction' }, 500);
  }
}

/**
 * @swagger
 * /api/transactions/debit:
 *   post:
 *     summary: Process a debit (disbursement) transaction for a customer
 *     description: >
 *       Runs eligibility scoring and, if approved, disburses funds against the disco's wallet,
 *       creates a customer obligation, and logs the credit decision. Requires both a bearer
 *       token and an API-Key header. Declined outcomes (scoring, insufficient balance, disabled
 *       features) are returned as HTTP 200 with `decision: "declined"`, not as errors.
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique key to safely retry the same debit request.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [meterToken, amount, disco]
 *             properties:
 *               meterToken:
 *                 type: string
 *               amount:
 *                 type: number
 *                 description: >
 *                   Obligation (amount repayable) in naira. Must be one of the
 *                   configured tiers — ₦2,000, ₦4,000 or ₦7,000 for the pilot.
 *               disco:
 *                 type: string
 *                 description: Disco name (used when the caller is an aggregator).
 *     responses:
 *       201:
 *         description: Debit approved and processed successfully.
 *       200:
 *         description: >
 *           Application declined — meter outside the cohort, blacklisted, already
 *           holding the maximum number of advances, scoring decline or timeout,
 *           insufficient Wallet A balance, or disbursements suspended.
 *       400:
 *         description: Missing or invalid required fields.
 *       401:
 *         description: Missing API key.
 *       403:
 *         description: Invalid API key, caller not active, or caller role not permitted.
 *       404:
 *         description: Aggregator or disco account not found.
 *       500:
 *         description: Failed to process debit transaction.
 */
export const POST = authorize(UserType.AGGREGATOR, UserType.DISCO_ADMIN)(debitHandler);