import { NextResponse } from '../../../../lib/next-server';
import * as Sentry from '../../../../lib/monitoring';
import prisma from '../../../../lib/prisma';
import { authorize, AuthenticatedRequest } from '../../../../middleware/auth';
import { UserType, Prisma } from '@prisma/client';
import { checkIdempotency, saveIdempotencyRecordTx } from '../../../../lib/idempotency';
import { recoveryQueue, addWithTimeout } from '../../../../lib/queues';
import { handleOptions, getCorsHeaders } from '../../../../lib/cors';
import { isEnabled } from '../../../../lib/feature-flags';
import { adjustWallet, WALLET_B_ID } from '../../../../lib/wallets';
import { classifyObligation } from '../../../../lib/recovery-window';
import { recordPartnerChanges } from '../../../../lib/partner-totals';
import { MONEY_TX_OPTIONS, callerGone, isDatabaseOverloaded, overloadedResponse } from '../../../../lib/db-overload';


export function OPTIONS(request: Request) {
  return handleOptions(request);
}

async function creditHandler(request: AuthenticatedRequest) {
  try {
    const creditEnabled = await isEnabled('credit_enabled');
    if (!creditEnabled) {
      return NextResponse.json(
        {
          success: true,
          decision: 'declined',
          reason: 'Credit temporarily unavailable. Please try again later.',
        },
        { status: 200, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }
    // A body that is missing, truncated (e.g. the caller disconnected
    // mid-request) or not JSON is a malformed request: 400, not 500.
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: 'Request body must be valid JSON' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }
    const { meterToken, amountKobo, disco } = body ?? {};

    // amountKobo must be a positive integer: fractional kobo can't be stored in
    // the Int columns and previously surfaced as a 500.
    if (!meterToken || typeof meterToken !== 'string' || !Number.isInteger(amountKobo) || amountKobo <= 0) {
      return NextResponse.json(
        { success: false, message: 'Missing or invalid required fields: meterToken, amountKobo, disco' },
        { status: 400, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const userType = request.user?.userType;
    const isAggregator = userType === UserType.AGGREGATOR;
    const isDisco = userType === UserType.DISCO_ADMIN;

    if (!isAggregator && !isDisco) {
      return NextResponse.json(
        { success: false, message: 'Only aggregators or disco admins can perform credit transactions' },
        { status: 403, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }

    const [aggregator, discoAdmin] = await Promise.all([
      isAggregator
        ? prisma.aggregator.findUnique({ where: { userId: request.user!.userId }, include: { user: { select: { id: true, email: true, name: true } } } })
        : Promise.resolve(null),
      isDisco
        ? prisma.discoAdmin.findUnique({ where: { userId: request.user!.userId }, include: { user: { select: { id: true, email: true, name: true } } } })
        : prisma.discoAdmin.findUnique({ where: { name: disco }, include: { user: { select: { id: true, email: true, name: true } } } }),
    ]);

    if (isAggregator && !aggregator) {
      return NextResponse.json({ success: false, message: 'Aggregator account not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });
    }
    if (!discoAdmin) {
      return NextResponse.json({ success: false, message: 'Disco not found' }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const callerType = isAggregator ? 'aggregator' : 'disco';
    const callerId = isAggregator ? aggregator!.id : discoAdmin.id;

    const idempotencyKey = request.headers.get('Idempotency-Key');
    const idempotencyReplay = await checkIdempotency(idempotencyKey ?? '', callerId, callerType, getCorsHeaders(request.headers.get('origin')));
    if (idempotencyReplay) return idempotencyReplay;

    const apiKey = request.headers.get('API-Key');
    if (!apiKey) {
      return NextResponse.json({ success: false, message: 'API key is required' }, { status: 401, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const expectedApiKey = isAggregator ? aggregator!.apiKey : discoAdmin.apiKey;
    if (expectedApiKey !== apiKey) {
      return NextResponse.json({ success: false, message: 'Invalid API key' }, { status: 403, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const callerStatus = isAggregator ? aggregator!.status : discoAdmin.status;
    if (callerStatus.toLowerCase() !== 'active') {
      return NextResponse.json({ success: false, message: 'Account is not active' }, { status: 403, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const customer = await prisma.customer.findUnique({ where: { meterToken } });
    if (!customer) {
      return NextResponse.json({ success: false, message: 'Customer not found', meterToken }, { status: 404, headers: getCorsHeaders(request.headers.get('origin')) });
    }

    const walletBId = WALLET_B_ID();

    // Don't open a transaction for a caller that has already gone.
    const gone = callerGone(request);
    if (gone) return gone;

    const result = await prisma.$transaction(async (tx) => {
      // Spec Section 4.2 — Lock customer and wallet records
      // (Wallet B is locked by adjustWallet below.)
      await tx.$executeRaw`SELECT id FROM "Customers" WHERE id = ${customer.id} FOR UPDATE`;

      // Spec Section 4.2 — Read outstanding obligations in FIFO order
      const outstandingObligations = await tx.obligation.findMany({
        where: {
          customerId: customer.id,
          discoAdminId: discoAdmin.id,
          // Defaulted obligations must stay recoverable — excluding them meant
          // the most overdue debt was exactly the debt that could not be repaid.
          status: { in: ['Current', 'Watch', 'Delayed', 'Default'] },
          remainingKobo: { gt: 0 },
        },
        orderBy: { disbursementDate: 'asc' }, // FIFO
        include: { suspensions: { select: { reason: true, startedAt: true, endedAt: true } } },
      });

      if (outstandingObligations.length === 0) {
        throw new Error('NO_OUTSTANDING_OBLIGATIONS');
      }

      const totalOutstandingKobo = outstandingObligations.reduce((sum, o) => sum + o.remainingKobo, 0);

      // Spec Section 4.3 — Apply vend value against obligations FIFO
      // Partial recovery is permitted — reduces remainingKobo
      const recoveries: Array<{
        obligationId: number;
        amountKobo: number;
        principalKobo: number;
        serviceKobo: number;
        fullyDischarged: boolean;
      }> = [];

      let remainingPaymentKobo = amountKobo;

      for (const obligation of outstandingObligations) {
        if (remainingPaymentKobo <= 0) break;

        const applyKobo = Math.min(remainingPaymentKobo, obligation.remainingKobo);
        const newRemainingKobo = obligation.remainingKobo - applyKobo;
        const fullyDischarged = newRemainingKobo === 0;

        // Split recovery into principal and service proportionally
        const principalRatio = obligation.disbursedKobo / obligation.obligationKobo;
        const principalKobo = Math.floor(applyKobo * principalRatio);
        const serviceKobo = applyKobo - principalKobo;

        await tx.obligation.update({
          where: { id: obligation.id },
          data: {
            remainingKobo: newRemainingKobo,
            recoveredKobo: { increment: applyKobo },
            principalRecoveredKobo: { increment: principalKobo },
            serviceRecoveredKobo: { increment: serviceKobo },
            // §4.6: discharged when fully recovered; a residual has its status
            // recomputed from its registered windows and suspension history.
            status: fullyDischarged ? 'Discharged' : classifyObligation(obligation).status,
            updatedAt: new Date(),
          },
        });

        recoveries.push({ obligationId: obligation.id, amountKobo: applyKobo, principalKobo, serviceKobo, fullyDischarged });
        remainingPaymentKobo -= applyKobo;
      }

      const totalRecoveredKobo = amountKobo - remainingPaymentKobo;
      const surplusKobo = remainingPaymentKobo; // Spec Section 4.4 — surplus released to customer

      const totalPrincipalKobo = recoveries.reduce((s, r) => s + r.principalKobo, 0);
      const totalServiceKobo = recoveries.reduce((s, r) => s + r.serviceKobo, 0);

      // Create the repayment transaction first so every recovery row can
      // reference it (recoveryTransactionId used to be left as 0).
      const repaymentTxnId = `REP-${Date.now()}-${Math.random().toString(36).slice(2, 11).toUpperCase()}`;
      const repaymentTransaction = await tx.transactions.create({
        data: {
          date: new Date(),
          transactionId: repaymentTxnId,
          aggregatorId: isAggregator ? aggregator!.id : null,
          customerId: customer.id,
          branch: meterToken,
          amount: new Prisma.Decimal(totalRecoveredKobo).div(100),
          obligationKobo: totalRecoveredKobo,
          disbursedKobo: totalPrincipalKobo,
          serviceKobo: totalServiceKobo,
          rateBps: outstandingObligations[0]?.rateBps ?? 1000,
          transactionType: 'repayment',
          transactionStatus: 'successful',
          paymentStatus: 'paid',
          discoAdminId: discoAdmin.id,
        },
      });

      // Spec Section 4.5 — 100% of recovered amount lands in Wallet B
      const { record: walletBRecord } = await adjustWallet(
        tx,
        walletBId,
        totalRecoveredKobo,
        'recovery',
        `Recovery for meter ${meterToken}: ${totalRecoveredKobo} kobo (principal: ${totalPrincipalKobo}, service: ${totalServiceKobo})`,
        repaymentTxnId
      );

      for (const recovery of recoveries) {
        await tx.obligationRecovery.create({
          data: {
            obligationId: recovery.obligationId,
            recoveryTransactionId: repaymentTransaction.id,
            amountKobo: recovery.amountKobo,
            principalKobo: recovery.principalKobo,
            serviceKobo: recovery.serviceKobo,
            walletBRecordId: walletBRecord.id,
          },
        });
      }

      // Mark the originating debit transactions paid once their obligation is discharged.
      const dischargedIds = recoveries.filter((r) => r.fullyDischarged).map((r) => r.obligationId);
      if (dischargedIds.length > 0) {
        const debitTxnIds = outstandingObligations
          .filter((o) => dischargedIds.includes(o.id))
          .map((o) => o.transactionId);
        await tx.transactions.updateMany({
          where: { id: { in: debitTxnIds } },
          data: { paymentStatus: 'paid', updatedAt: new Date() },
        });
      }

      // Update customer outstanding
      const updatedCustomer = await tx.customer.update({
        where: { id: customer.id },
        data: {
          outstanding: { decrement: new Prisma.Decimal(totalRecoveredKobo).div(100) },
          lastInteraction: new Date(),
        },
      });

      // Update disco outstanding
      // Disco/aggregator running totals: recorded as pending changes, not as
      // updates to the partner rows every repayment would queue on; folded in
      // within seconds (lib/partner-totals.ts).
      await recordPartnerChanges(tx, [
        { partnerType: 'disco', partnerId: discoAdmin.id, outstandingDeltaKobo: -totalPrincipalKobo, reference: repaymentTransaction.transactionId },
        ...(isAggregator && aggregator
          ? [{ partnerType: 'aggregator' as const, partnerId: aggregator.id, outstandingDeltaKobo: -totalPrincipalKobo, reference: repaymentTransaction.transactionId }]
          : []),
      ]);

      // MonseraEarnings — service charge component is Monsera's fee
      const monseraEarning = await tx.monseraEarnings.create({
        data: {
          amount: new Prisma.Decimal(totalServiceKobo / 100),
          customerId: customer.id,
          aggregatorId: isAggregator ? aggregator!.id : null,
          discoAdminId: discoAdmin.id,
          transactionId: repaymentTransaction.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await tx.audit.create({
        data: {
          userId: request.user!.userId,
          employeeName: request.user!.email,
          emailAddress: request.user!.email,
          activity: `Recovery ${repaymentTxnId}: meter=${meterToken}, recovered=${totalRecoveredKobo}k, principal=${totalPrincipalKobo}k, service=${totalServiceKobo}k, surplus=${surplusKobo}k, obligations_discharged=${recoveries.filter(r => r.fullyDischarged).length}`,
          meterId: meterToken,
        },
      });

      // ── IDEMPOTENCY WRITE INSIDE TRANSACTION ──────────────────────────
      // Written here so it is atomic with the balance change.
      // A concurrent request with the same key will hit the unique constraint
      // on idempotencyRecord.key and the entire transaction will roll back,
      // preventing double repayment — the failure mode that costs real money.
      const responseBodyForIdempotency = {
        success: true,
        message: 'Recovery processed successfully',
        data: {
          repaymentTransactionId: repaymentTransaction.transactionId,
          totalRecoveredKobo,
          totalPrincipalKobo,
          totalServiceKobo,
          surplusKobo,
          obligationsFullyDischarged: recoveries.filter(r => r.fullyDischarged).length,
        },
      };

      await saveIdempotencyRecordTx(
        tx,
        idempotencyKey!,
        callerId,
        callerType,
        201,
        responseBodyForIdempotency
      );

      // this return statement already exists — just add the idempotency write above it
      return {
        repaymentTransaction,
        recoveries,
        updatedCustomer,
        monseraEarning,
        totalRecoveredKobo,
        totalPrincipalKobo,
        totalServiceKobo,
        surplusKobo,
        totalOutstandingKobo,
      };
    }, MONEY_TX_OPTIONS);

    // Queue the post-commit audit job. The repayment has already committed,
    // so a Redis failure must not turn a successful repayment into a 500.
    if (Number(result.updatedCustomer.outstanding) > 0) {
      try {
        await addWithTimeout(recoveryQueue, 'recovery-sweep', {
          customerId: customer.id,
          meterToken,
          amountPaidKobo: amountKobo,
          remainingOutstandingKobo: Math.round(Number(result.updatedCustomer.outstanding) * 100),
        });
      } catch (queueError) {
        Sentry.captureException(queueError, { tags: { queue: 'recovery' } });
      }
    }

    const responseBody = {
      success: true,
      message: 'Recovery processed successfully',
      data: {
        repaymentTransaction: result.repaymentTransaction,
        recoveries: result.recoveries,
        monseraEarnings: {
          id: result.monseraEarning.id,
          serviceChargeKobo: Math.round(Number(result.monseraEarning.amount) * 100),
        },
        summary: {
          totalRecoveredKobo: result.totalRecoveredKobo,
          totalPrincipalKobo: result.totalPrincipalKobo,
          totalServiceKobo: result.totalServiceKobo,
          surplusKobo: result.surplusKobo, // Spec Section 4.4 — released to customer
          obligationsFullyDischarged: result.recoveries.filter(r => r.fullyDischarged).length,
          obligationsPartiallyRecovered: result.recoveries.filter(r => !r.fullyDischarged).length,
        },
        customer: {
          id: result.updatedCustomer.id,
          meterToken: result.updatedCustomer.meterToken,
          previousOutstandingKobo: Math.round((Number(result.updatedCustomer.outstanding) + result.totalRecoveredKobo / 100) * 100),
          newOutstandingKobo: Math.round(Number(result.updatedCustomer.outstanding) * 100),
          status: result.updatedCustomer.status,
        },
      },
    };

    return NextResponse.json(responseBody, { status: 201, headers: getCorsHeaders(request.headers.get('origin')) });

  } catch (error: any) {
    if (error.message === 'NO_OUTSTANDING_OBLIGATIONS') {
      return NextResponse.json(
        { success: false, message: 'No outstanding obligations found for this meter' },
        { status: 404, headers: getCorsHeaders(request.headers.get('origin')) }
      );
    }
    if (isDatabaseOverloaded(error)) {
      return overloadedResponse(getCorsHeaders(request.headers.get('origin')), 'credit', error);
    }
    Sentry.captureException(error);
    console.error('Credit transaction error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process credit transaction' },
      { status: 500, headers: getCorsHeaders(request.headers.get('origin')) }
    );
  }
}

/**
 * @swagger
 * /api/transactions/credit:
 *   post:
 *     summary: Process a credit (recovery) transaction against a customer's outstanding obligations
 *     description: >
 *       Applies an incoming vend value against the customer's outstanding obligations in FIFO
 *       order (oldest disbursement first), splitting each recovery into principal and service
 *       components. 100% of the recovered amount is credited to Wallet B. Any amount beyond
 *       what's owed is tracked as surplus. Requires both a bearer token and an API-Key header.
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
 *         description: Unique key to safely retry the same credit request.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [meterToken, amountKobo, disco]
 *             properties:
 *               meterToken:
 *                 type: string
 *               amountKobo:
 *                 type: integer
 *                 description: Vend amount in kobo to apply against outstanding obligations.
 *               disco:
 *                 type: string
 *                 description: Disco name (used when the caller is an aggregator).
 *     responses:
 *       201:
 *         description: Recovery processed successfully.
 *       200:
 *         description: Credit declined (e.g. the credit feature is temporarily disabled).
 *       400:
 *         description: Missing or invalid required fields.
 *       401:
 *         description: Missing API key.
 *       403:
 *         description: Invalid API key, caller not active, or caller role not permitted.
 *       404:
 *         description: Aggregator, disco, or customer not found, or no outstanding obligations for this meter.
 *       500:
 *         description: Failed to process credit transaction.
 */
export const POST = authorize(UserType.AGGREGATOR, UserType.DISCO_ADMIN)(creditHandler);