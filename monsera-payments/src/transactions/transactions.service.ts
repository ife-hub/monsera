import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationService } from '../calculation/calculation.service';
import { ObligationStatusService } from '../obligation-status/obligation-status.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { DebitDto } from './dto/debit.dto';
import { CreditDto } from './dto/credit.dto';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

type CallerType = 'aggregator' | 'disco';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  constructor(
    private prisma: PrismaService,
    private calc: CalculationService,
    private obligationStatus: ObligationStatusService,
    private idempotency: IdempotencyService,
    @InjectQueue('recovery') private recoveryQueue: Queue,
  ) {}

 private async resolveCaller(user: JwtPayload, disco: string | undefined, apiKey: string | undefined) {
    const isAggregator = user.userType === UserType.AGGREGATOR;
  const isDisco = user.userType === UserType.DISCO_ADMIN;
  if (!isAggregator && !isDisco) {
    throw new ForbiddenException({ success: false, message: 'Only aggregators or disco admins can perform this transaction' });
  }

  // Aggregators act on behalf of a disco, so they must say which one
  if (isAggregator && !disco?.trim()) {
    throw new BadRequestException({ success: false, message: 'disco is required for aggregator requests' });
  }

  const [aggregator, discoAdmin] = await Promise.all([
    isAggregator ? this.prisma.aggregator.findUnique({ where: { userId: user.userId } }) : Promise.resolve(null),
    isDisco
      ? this.prisma.discoAdmin.findUnique({ where: { userId: user.userId } })
      : this.prisma.discoAdmin.findUnique({ where: { name: disco!.trim() } }),
  ]);

    if (isAggregator && !aggregator) throw new NotFoundException({ success: false, message: 'Aggregator account not found' });
    if (!discoAdmin) throw new NotFoundException({ success: false, message: 'Disco not found' });

    const callerType: CallerType = isAggregator ? 'aggregator' : 'disco';
    const callerId = isAggregator ? aggregator!.id : discoAdmin.id;

    if (!apiKey) throw new UnauthorizedException({ success: false, message: 'API key is required' });
    const expectedApiKey = isAggregator ? aggregator!.apiKey : discoAdmin.apiKey;
    if (expectedApiKey !== apiKey) throw new ForbiddenException({ success: false, message: 'Invalid API key' });

    const callerStatus = isAggregator ? aggregator!.status : discoAdmin.status;
    if (callerStatus.toLowerCase() !== 'active') throw new ForbiddenException({ success: false, message: 'Account is not active' });

    return { isAggregator, isDisco, aggregator, discoAdmin, callerType, callerId };
  }

  async debit(dto: DebitDto, user: JwtPayload, apiKey: string | undefined, idempotencyKey: string | undefined) {
    const { isAggregator, aggregator, discoAdmin, callerType, callerId } = await this.resolveCaller(user, dto.disco, apiKey);

    await this.idempotency.checkIdempotency(idempotencyKey, callerId, callerType); // throws on replay/invalid

    let customer = await this.prisma.customer.findUnique({ where: { meterToken: dto.meterToken } });
    const walletAId = Number(process.env.WALLET_A_ID ?? '1');

    const calcResult = this.calc.calculateDisbursement(dto.amount, this.calc.RATE_BPS);
    try {
      this.calc.validateDisbursement(calcResult);
    } catch (err: any) {
      throw new BadRequestException({ success: false, message: err.message });
    }

    // Scoring params — ported as-is from calculateScoringParameters; see
    // the open item in this build about replacing this with
    // CustomerVendMetrics once that wiring lands.
        const vendMetrics = await this.prisma.customerVendMetrics.findUnique({ where: { meterToken: dto.meterToken } });

    // A brand-new customer has no obligations. Without this guard, Prisma would
    // treat customerId: undefined as "no filter" and match ANY open obligation.
    const activeObligation = customer
      ? await this.prisma.obligation.findFirst({
          where: { customerId: customer.id, status: { in: ['Current', 'Watch', 'Delayed', 'Default'] }, remainingKobo: { gt: 0 } },
          select: { id: true },
        })
      : null;

    const scoringParams = {
      meter_id: dto.meterToken,
      meter_status: vendMetrics?.meterStatus ?? customer?.status ?? 'Unknown',
      total_vends: vendMetrics?.totalVends ?? 0,
      vend_count_last_60_days: vendMetrics?.vendCountLast60Days ?? 0,
      days_since_last_vend: vendMetrics?.daysSinceLastVend ?? 0,
      median_vend_amount: vendMetrics?.medianVendAmountNaira ? Number(vendMetrics.medianVendAmountNaira) : 0,
      vend_amount_volatility: vendMetrics?.vendAmountVolatility ? Number(vendMetrics.vendAmountVolatility) : 0,
      inter_vend_variance: vendMetrics?.interVendVarianceDays ? Number(vendMetrics.interVendVarianceDays) : 0,
      failed_vend_ratio: vendMetrics?.failedVendRatio ? Number(vendMetrics.failedVendRatio) : 0,
      has_active_obligation: !!activeObligation,
    };

    const decisionId = randomUUID();
    const scoringStart = Date.now();

    // try {
    //   const response = await fetch(`${process.env.SCORING_ENGINE_URL}/decision`, {
    //     method: 'POST',
    //     signal: AbortSignal.timeout(8000),
    //     headers: { Authorization: `Bearer ${process.env.SCORING_ENGINE_SECRET}`, 'Content-Type': 'application/json' },
    //     body: JSON.stringify(scoringParams),
    //   });
    //   if (!response.ok) throw new Error(`Scoring engine returned status ${response.status}`);
    //   scoringResponse = await response.json();
    // } catch (error: any) {
    //   await this.prisma.decisionLog.create({
    //     data: {
    //       decisionId, meterToken: dto.meterToken, band: customer?.band ?? 'B', features: scoringParams,
    //       modelVersion: 'unknown', parameterVersion: process.env.CREDIT_PARAMETER_VERSION ?? 'v1.0',
    //       decision: 'declined', declineReason: `Scoring engine error: ${error.message}`,
    //       requestedKobo: calcResult.obligationKobo, latencyMs: Date.now() - scoringStart, timestampUtc: new Date(),
    //     },
    //   });
    //   return { success: true, decision: 'declined', reason: 'Scoring service unavailable. Please retry.', requestedKobo: calcResult.obligationKobo };
    // }

    let scoringResponse: any;
const scoringUrl = `${process.env.SCORING_ENGINE_URL}/decision`;

try {
  const response = await fetch(scoringUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${process.env.SCORING_ENGINE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(scoringParams),
  });

  if (!response.ok) {
    // Read the actual body the scoring engine sent back
    const errorBody = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      `Scoring engine returned status ${response.status} ${response.statusText} | body: ${errorBody.slice(0, 1000)}`,
    );
  }

  scoringResponse = await response.json();
} catch (error: any) {
  // fetch network errors hide the real reason in error.cause
  const cause = error?.cause
    ? ` | cause: ${error.cause.code ?? ''} ${error.cause.message ?? error.cause}`
    : '';
  const detail = `${error.name}: ${error.message}${cause}`;

  this.logger.error(
    `Scoring engine call failed. url=${scoringUrl} detail=${detail}`,
    error.stack,
  );

  await this.prisma.decisionLog.create({
    data: {
      decisionId,
      meterToken: dto.meterToken,
      band: customer?.band ?? 'B',
      features: scoringParams,
      modelVersion: 'unknown',
      parameterVersion: process.env.CREDIT_PARAMETER_VERSION ?? 'v1.0',
      decision: 'declined',
      declineReason: `Scoring engine error: ${detail}`.slice(0, 1000),
      requestedKobo: calcResult.obligationKobo,
      latencyMs: Date.now() - scoringStart,
      timestampUtc: new Date(),
    },
  });

  return {
    success: true,
    decision: 'declined',
    reason: 'Scoring service unavailable. Please retry.',
    requestedKobo: calcResult.obligationKobo,
  };
}

    await this.prisma.decisionLog.create({
      data: {
        decisionId, meterToken: dto.meterToken, band: customer?.band ?? 'B', features: scoringParams,
        modelVersion: scoringResponse.model_version ?? 'unknown', parameterVersion: process.env.CREDIT_PARAMETER_VERSION ?? 'v1.0',
        decision: scoringResponse.eligible ? 'approved' : 'declined',
        declineReason: scoringResponse.eligible ? null : (scoringResponse.reason ?? 'Not eligible'),
        approvedLimitKobo: scoringResponse.eligible ? Math.round(scoringResponse.approved_amount * 100) : null,
        requestedKobo: calcResult.obligationKobo, latencyMs: Date.now() - scoringStart, timestampUtc: new Date(), correlationId: null,
      },
    });

    if (!scoringResponse.eligible) {
      return { success: true, decision: 'declined', reason: scoringResponse.reason ?? 'Not eligible based on scoring evaluation', requestedKobo: calcResult.obligationKobo };
    }
    if (Math.round(scoringResponse.approved_amount * 100) < calcResult.obligationKobo) {
      return { success: true, decision: 'declined', reason: 'Requested amount exceeds approved limit', requestedKobo: calcResult.obligationKobo };
    }

    const burnRate = await this.prisma.burnRate.findFirst({ where: { band: customer?.band ?? 'B' }, orderBy: { effectiveFrom: 'desc' } });
    const dailyBurnNaira = burnRate?.dailyBurnNaira ?? 650;
    const disbursementDate = new Date();
    const windows = this.obligationStatus.computeStatusWindows(calcResult.disbursedKobo, customer?.band ?? 'B', dailyBurnNaira, disbursementDate);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "DiscoAdmins" WHERE id = ${discoAdmin.id} FOR UPDATE`;
        await this.idempotency.checkIdempotency(idempotencyKey, callerId, callerType, tx);
        const walletA = await tx.wallet.findUnique({ where: { id: walletAId } });
        const walletABalanceKobo = Math.round(Number(walletA?.balance ?? 0) * 100);
        if (walletABalanceKobo < calcResult.disbursedKobo) throw new Error('INSUFFICIENT_WALLET_A_BALANCE');

        const txCustomer = await tx.customer.upsert({
          where: { meterToken: dto.meterToken },
          update: {},
          create: { meterToken: dto.meterToken, lastInteraction: new Date(), riskLevel: 'low', outstanding: new Prisma.Decimal(0), status: 'active', state: 'active', band: 'B', dateAdded: new Date() },
        });
        customer = txCustomer; // the rest of the transaction keeps using `customer!`

        // The earlier obligation check ran before we held the lock, so re-check it here.
        const openObligation = await tx.obligation.findFirst({
          where: { customerId: txCustomer.id, status: { in: ['Current', 'Watch', 'Delayed', 'Default'] }, remainingKobo: { gt: 0 } },
          select: { id: true },
        });
        if (openObligation) throw new Error('OPEN_OBLIGATION_EXISTS');

        const updatedCustomer = await tx.customer.update({
          where: { id: customer!.id },
          data: { outstanding: { increment: new Prisma.Decimal(calcResult.obligationKobo / 100) }, lastInteraction: new Date() },
        });

        const updatedDiscoAdmin = await tx.discoAdmin.update({
          where: { id: discoAdmin.id },
          data: { balance: { decrement: new Prisma.Decimal(calcResult.disbursedKobo / 100) }, outstanding: { increment: new Prisma.Decimal(calcResult.disbursedKobo / 100) }, lastInteraction: new Date() },
        });

        await tx.wallet.update({ where: { id: walletAId }, data: { balance: { decrement: new Prisma.Decimal(calcResult.disbursedKobo / 100) }, updatedAt: new Date() } });
        await tx.walletTransaction.create({ data: { walletId: walletAId, type: 'disbursement', amountKobo: -calcResult.disbursedKobo, description: `Disbursement for meter ${dto.meterToken}: ${calcResult.disbursedKobo} kobo` } });

        if (isAggregator && aggregator) {
          await tx.aggregator.update({ where: { id: aggregator.id }, data: { outstanding: { increment: new Prisma.Decimal(calcResult.disbursedKobo / 100) }, lastInteraction: new Date() } });
        }

        const transactionId = `DBT-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        const transaction = await tx.transactions.create({
          data: {
            date: disbursementDate, transactionId, aggregatorId: isAggregator ? aggregator!.id : null, customerId: customer!.id,
            branch: dto.meterToken, amount: new Prisma.Decimal(dto.amount), obligationKobo: calcResult.obligationKobo,
            disbursedKobo: calcResult.disbursedKobo, serviceKobo: calcResult.serviceKobo, rateBps: calcResult.rateBps,
            transactionType: 'debit', transactionStatus: 'successful', paymentStatus: 'unpaid', discoAdminId: discoAdmin.id,
          },
        });

        const obligation = await tx.obligation.create({
          data: {
            transactionId: transaction.id, meterToken: dto.meterToken, customerId: customer!.id, discoAdminId: discoAdmin.id,
            obligationKobo: calcResult.obligationKobo, disbursedKobo: calcResult.disbursedKobo, serviceKobo: calcResult.serviceKobo,
            remainingKobo: calcResult.obligationKobo, rateBps: calcResult.rateBps, status: 'Current', band: customer!.band,
            disbursementDate, expectedRecoveryDate: windows.expectedRecoveryDate, watchDate: windows.watchDate,
            delayedDate: windows.delayedDate, defaultDate: windows.defaultDate,
          },
        });

        await tx.decisionLog.update({ where: { decisionId }, data: { correlationId: transactionId } });

        const newWalletABalanceKobo = walletABalanceKobo - calcResult.disbursedKobo;
        const lowBalanceThreshold = Number(process.env.LOW_WALLET_A_BALANCE_KOBO ?? '5000000');
        if (newWalletABalanceKobo < lowBalanceThreshold) {
          await tx.audit.create({ data: { employeeName: 'System', emailAddress: 'system@monsera.com', activity: `ALERT: Wallet A balance low. Remaining: ${newWalletABalanceKobo} kobo. Top up required.` } });
        }

        await tx.audit.create({
          data: { userId: user.userId, employeeName: user.email, emailAddress: user.email, activity: `Debit ${transactionId}: meterToken=${dto.meterToken}, obligation=${calcResult.obligationKobo}k, disbursed=${calcResult.disbursedKobo}k, service=${calcResult.serviceKobo}k`, meterId: dto.meterToken },
        });

        const responseBody = {
          success: true, decision: 'approved', message: 'Debit transaction processed successfully',
          data: {
            transaction, obligation: { id: obligation.id, status: obligation.status, obligationKobo: obligation.obligationKobo, disbursedKobo: obligation.disbursedKobo, serviceKobo: obligation.serviceKobo, remainingKobo: obligation.remainingKobo, expectedRecoveryDate: obligation.expectedRecoveryDate },
            calculation: { obligationKobo: calcResult.obligationKobo, disbursedKobo: calcResult.disbursedKobo, serviceKobo: calcResult.serviceKobo, rateBps: calcResult.rateBps, obligationNaira: calcResult.obligationKobo / 100, disbursedNaira: calcResult.disbursedKobo / 100, serviceNaira: calcResult.serviceKobo / 100 },
            customer: { id: updatedCustomer.id, meterToken: updatedCustomer.meterToken, newOutstanding: Number(updatedCustomer.outstanding), status: updatedCustomer.status },
            disco: { id: updatedDiscoAdmin.id, name: updatedDiscoAdmin.name, newBalance: Number(updatedDiscoAdmin.balance) },
            scoringEvaluation: { decision: 'approved', score: scoringResponse.score, band: scoringResponse.band, approvedLimitKobo: Math.round(scoringResponse.approved_amount * 100), requestedKobo: calcResult.obligationKobo, decisionId },
          },
        };

        if (idempotencyKey) await this.idempotency.saveRecordTx(tx, idempotencyKey, callerId, callerType, 201, responseBody);
        return responseBody;
      }, { timeout: 30000, maxWait: 10000 });

      return result;
    } catch (error: any) {
      if (error.message === 'INSUFFICIENT_WALLET_A_BALANCE') {
        return { success: true, decision: 'declined', reason: 'Credit wallet exhausted. New advances temporarily unavailable.' };
      }
      if (error.message === 'OPEN_OBLIGATION_EXISTS') {
        return { success: true, decision: 'declined', reason: 'Meter already has an outstanding obligation', requestedKobo: calcResult.obligationKobo };
      }
      throw error; // P2002 and anything else go to the global filter
    }
  }

  async credit(dto: CreditDto, user: JwtPayload, apiKey: string | undefined, idempotencyKey: string | undefined) {
    const { isAggregator, aggregator, discoAdmin, callerType, callerId } = await this.resolveCaller(user, dto.disco, apiKey);
    await this.idempotency.checkIdempotency(idempotencyKey, callerId, callerType);

    const customer = await this.prisma.customer.findUnique({ where: { meterToken: dto.meterToken } });
    if (!customer) throw new NotFoundException({ success: false, message: 'Customer not found', meterToken: dto.meterToken });

    const walletBId = Number(process.env.WALLET_B_ID ?? '2');

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "Customers" WHERE id = ${customer.id} FOR UPDATE`;
        await tx.$executeRaw`SELECT id FROM "Wallet" WHERE id = ${walletBId} FOR UPDATE`;

        const outstandingObligations = await tx.obligation.findMany({
          where: { customerId: customer.id, discoAdminId: discoAdmin.id, status: { in: ['Current', 'Watch', 'Delayed'] }, remainingKobo: { gt: 0 } },
          orderBy: { disbursementDate: 'asc' },
        });
        if (outstandingObligations.length === 0) throw new Error('NO_OUTSTANDING_OBLIGATIONS');

        const recoveries: Array<{ obligationId: number; amountKobo: number; principalKobo: number; serviceKobo: number; fullyDischarged: boolean }> = [];
        let remainingPaymentKobo = dto.amountKobo;

        for (const obligation of outstandingObligations) {
          if (remainingPaymentKobo <= 0) break;
          const applyKobo = Math.min(remainingPaymentKobo, obligation.remainingKobo);
          const newRemainingKobo = obligation.remainingKobo - applyKobo;
          const fullyDischarged = newRemainingKobo === 0;
          const principalRatio = obligation.disbursedKobo / obligation.obligationKobo;
          const principalKobo = Math.floor(applyKobo * principalRatio);
          const serviceKobo = applyKobo - principalKobo;

          await tx.obligation.update({
            where: { id: obligation.id },
            data: { remainingKobo: newRemainingKobo, recoveredKobo: { increment: applyKobo }, principalRecoveredKobo: { increment: principalKobo }, serviceRecoveredKobo: { increment: serviceKobo }, status: fullyDischarged ? 'Discharged' : obligation.status, updatedAt: new Date() },
          });
          recoveries.push({ obligationId: obligation.id, amountKobo: applyKobo, principalKobo, serviceKobo, fullyDischarged });
          remainingPaymentKobo -= applyKobo;
        }

        const totalRecoveredKobo = dto.amountKobo - remainingPaymentKobo;
        const surplusKobo = remainingPaymentKobo;
        const totalPrincipalKobo = recoveries.reduce((s, r) => s + r.principalKobo, 0);
        const totalServiceKobo = recoveries.reduce((s, r) => s + r.serviceKobo, 0);

        await tx.wallet.update({ where: { id: walletBId }, data: { balance: { increment: new Prisma.Decimal(totalRecoveredKobo / 100) }, updatedAt: new Date() } });
        const walletBRecord = await tx.walletTransaction.create({ data: { walletId: walletBId, type: 'recovery', amountKobo: totalRecoveredKobo, description: `Recovery for meter ${dto.meterToken}: ${totalRecoveredKobo} kobo` } });

        for (const recovery of recoveries) {
          await tx.obligationRecovery.create({ data: { obligationId: recovery.obligationId, recoveryTransactionId: 0, amountKobo: recovery.amountKobo, principalKobo: recovery.principalKobo, serviceKobo: recovery.serviceKobo, walletBRecordId: walletBRecord.id } });
        }

        const updatedCustomer = await tx.customer.update({ where: { id: customer.id }, data: { outstanding: { decrement: new Prisma.Decimal(totalRecoveredKobo / 100) }, lastInteraction: new Date() } });
        const updatedDiscoAdmin = await tx.discoAdmin.update({ where: { id: discoAdmin.id }, data: { outstanding: { decrement: new Prisma.Decimal(totalPrincipalKobo / 100) }, lastInteraction: new Date() } });

        if (isAggregator && aggregator) {
          await tx.aggregator.update({ where: { id: aggregator.id }, data: { outstanding: { decrement: new Prisma.Decimal(totalPrincipalKobo / 100) }, lastInteraction: new Date() } });
        }

        const repaymentTxnId = `REP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        const repaymentTransaction = await tx.transactions.create({
          data: { date: new Date(), transactionId: repaymentTxnId, aggregatorId: isAggregator ? aggregator!.id : null, customerId: customer.id, branch: dto.meterToken, amount: new Prisma.Decimal(totalRecoveredKobo / 100), obligationKobo: totalRecoveredKobo, disbursedKobo: totalPrincipalKobo, serviceKobo: totalServiceKobo, rateBps: outstandingObligations[0]?.rateBps ?? 1000, transactionType: 'repayment', transactionStatus: 'successful', paymentStatus: 'paid', discoAdminId: discoAdmin.id },
        });

        const monseraEarning = await tx.monseraEarnings.create({
          data: { amount: new Prisma.Decimal(totalServiceKobo / 100), customerId: customer.id, aggregatorId: isAggregator ? aggregator!.id : null, discoAdminId: discoAdmin.id, transactionId: repaymentTransaction.id, createdAt: new Date(), updatedAt: new Date() },
        });

        await tx.audit.create({ data: { userId: user.userId, employeeName: user.email, emailAddress: user.email, activity: `Recovery ${repaymentTxnId}: meter=${dto.meterToken}, recovered=${totalRecoveredKobo}k, principal=${totalPrincipalKobo}k, service=${totalServiceKobo}k, surplus=${surplusKobo}k`, meterId: dto.meterToken } });

        const responseBody = {
          success: true, message: 'Recovery processed successfully',
          data: {
            repaymentTransaction, recoveries,
            monseraEarnings: { id: monseraEarning.id, serviceChargeKobo: Math.round(Number(monseraEarning.amount) * 100) },
            summary: { totalRecoveredKobo, totalPrincipalKobo, totalServiceKobo, surplusKobo, obligationsFullyDischarged: recoveries.filter((r) => r.fullyDischarged).length, obligationsPartiallyRecovered: recoveries.filter((r) => !r.fullyDischarged).length },
            customer: { id: updatedCustomer.id, meterToken: updatedCustomer.meterToken, newOutstandingKobo: Math.round(Number(updatedCustomer.outstanding) * 100), status: updatedCustomer.status },
          },
        };

        if (idempotencyKey) await this.idempotency.saveRecordTx(tx, idempotencyKey, callerId, callerType, 201, responseBody);
        return { responseBody, updatedCustomerOutstanding: Number(updatedCustomer.outstanding), customerId: customer.id, amountPaidKobo: dto.amountKobo };
      }, { timeout: 30000, maxWait: 10000 });

      // Recovery job — queued, not awaited for completion, matches the
      // "doesn't block the caller" reasoning from earlier in this build.
      if (result.updatedCustomerOutstanding > 0) {
        await this.recoveryQueue.add('recovery-sweep', {
          customerId: result.customerId, meterToken: dto.meterToken, amountPaidKobo: result.amountPaidKobo,
          remainingOutstandingKobo: Math.round(result.updatedCustomerOutstanding * 100),
        });
      }

      return result.responseBody;
    } catch (error: any) {
      if (error.message === 'NO_OUTSTANDING_OBLIGATIONS') {
        throw new NotFoundException({ success: false, message: 'No outstanding obligations found for this meter' });
      }
      throw error;
    }
  }
}