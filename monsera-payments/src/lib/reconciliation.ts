/**
 * Spec §8 — reconciliation calculations shared by the daily job, the
 * monthly job and the settlement gate. All amounts are integer kobo; sums
 * are done in Postgres (BIGINT) and converted once.
 */
import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { WALLET_B_ID, FUNDING_TYPES, COMMISSION_PAYOUT_TYPE, PRINCIPAL_RETURN_TYPE } from './wallets';
import { walletAIds, walletABalanceKobo } from './wallet-a';

const n = (v: unknown) => Number(v ?? 0);

/** Σ ledger rows for a wallet, optionally restricted to types and/or a time window [from, to). */
/** Sum of ledger rows for a wallet, or for several (Wallet A is all its rows: lib/wallet-a.ts). */
async function ledgerSum(walletId: number | number[], opts: { types?: readonly string[]; from?: Date; to?: Date } = {}) {
  const agg = await prisma.walletTransaction.aggregate({
    _sum: { amountKobo: true },
    where: {
      walletId: Array.isArray(walletId) ? { in: walletId } : walletId,
      ...(opts.types ? { type: { in: [...opts.types] } } : {}),
      ...(opts.from || opts.to ? { createdAt: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lt: opts.to }) } } : {}),
    },
  });
  return n(agg._sum.amountKobo);
}

/**
 * Outstanding obligations as at `asOf`, measured from obligation STATE
 * (remainingKobo now, plus whatever was recovered after `asOf`), so it can be
 * compared independently against the recovery EVENTS.
 */
export async function outstandingAt(asOf?: Date): Promise<number> {
  if (!asOf) {
    const agg = await prisma.obligation.aggregate({ _sum: { remainingKobo: true } });
    return n(agg._sum.remainingKobo);
  }
  const [row] = await prisma.$queryRaw<{ remaining: bigint | null; recovered_after: bigint | null }[]>`
    SELECT
      (SELECT SUM(o."remainingKobo") FROM "Obligation" o WHERE o."createdAt" < ${asOf}) AS remaining,
      (SELECT SUM(r."amountKobo") FROM "ObligationRecovery" r
         JOIN "Obligation" o ON o.id = r."obligationId"
        WHERE o."createdAt" < ${asOf} AND r."createdAt" >= ${asOf}) AS recovered_after`;
  return n(row?.remaining) + n(row?.recovered_after);
}

export interface IdentityResult {
  asOf: string;
  walletAKobo: number;
  walletBKobo: number;
  outstandingObligationsKobo: number;
  leftSideKobo: number;
  floatDeployedKobo: number;
  commissionAccruedKobo: number;
  commissionPaidOutKobo: number;
  commissionNotYetPaidOutKobo: number;
  rightSideKobo: number;
  discrepancyKobo: number;
  holds: boolean;
}

/**
 * The controlling identity, in the spec's terms:
 *
 *   Wallet A + Wallet B + outstanding obligations
 *     = total float deployed + commission not yet paid out
 *
 * - float deployed: money put into A/B from outside — top-ups, allocations
 *   from Wallet C, opening balances, less principal returned (FUNDING_TYPES).
 * - commission: the service charge, which accrues when it is netted at
 *   disbursement (§2; monthly check 4 measures accrual against disbursement).
 *   Not yet paid out = accrued − commission settled out of Wallet B.
 *
 * Every naira is in Wallet A, Wallet B or an outstanding obligation; if the
 * two sides differ by more than 1 kobo, something has leaked.
 *
 * `asOf` omitted = live (wallet balances as stored). With `asOf`, balances are
 * rebuilt from the ledger up to that instant (used at the monthly cut).
 */
export async function controllingIdentity(asOf?: Date): Promise<IdentityResult> {
  // Wallet A = Wallet A and its sub-wallets; 'rebalance' rows between them net to zero.
  const A = await walletAIds();
  const B = WALLET_B_ID();
  const before = asOf ? { to: asOf } : {};

  const [walletAKobo, walletBKobo] = asOf
    ? await Promise.all([ledgerSum(A, before), ledgerSum(B, before)])
    : await Promise.all([
        walletABalanceKobo(),
        prisma.wallet.findUnique({ where: { id: B }, select: { balance: true } }).then((w) => Math.round(Number(w?.balance ?? 0) * 100)),
      ]);

  const [outstandingObligationsKobo, fundingA, fundingB, commissionPaidOutNeg, serviceAgg] = await Promise.all([
    outstandingAt(asOf),
    ledgerSum(A, { types: FUNDING_TYPES, ...before }),
    ledgerSum(B, { types: FUNDING_TYPES, ...before }),
    ledgerSum(B, { types: [COMMISSION_PAYOUT_TYPE], ...before }),
    prisma.obligation.aggregate({ _sum: { serviceKobo: true }, where: asOf ? { createdAt: { lt: asOf } } : {} }),
  ]);

  const floatDeployedKobo = fundingA + fundingB;
  const commissionAccruedKobo = n(serviceAgg._sum.serviceKobo);
  const commissionPaidOutKobo = -commissionPaidOutNeg;
  const commissionNotYetPaidOutKobo = commissionAccruedKobo - commissionPaidOutKobo;
  const leftSideKobo = walletAKobo + walletBKobo + outstandingObligationsKobo;
  const rightSideKobo = floatDeployedKobo + commissionNotYetPaidOutKobo;
  const discrepancyKobo = Math.abs(leftSideKobo - rightSideKobo);

  return {
    asOf: (asOf ?? new Date()).toISOString(),
    walletAKobo,
    walletBKobo,
    outstandingObligationsKobo,
    leftSideKobo,
    floatDeployedKobo,
    commissionAccruedKobo,
    commissionPaidOutKobo,
    commissionNotYetPaidOutKobo,
    rightSideKobo,
    discrepancyKobo,
    holds: discrepancyKobo <= 1,
  };
}

export interface DailyVerification {
  obligationsCreated: number;
  obligationsWithoutDisbursement: number[];
  recoveriesSettled: number;
  recoveriesWithoutObligation: number[];
  walletBRecoveriesWithoutRecoveryRows: number[];
  advancesIssued: { count: number; obligationKobo: number; disbursedKobo: number };
  recoveriesEffected: { count: number; amountKobo: number };
  sweepMovements: { count: number; principalKobo: number };
  passed: boolean;
}

/**
 * §8.1 daily checks over the window [start, end):
 *  - every obligation created has a matching disbursement (the Wallet A
 *    'disbursement' ledger row for its transaction, for the disbursed amount);
 *  - every recovery settled has a matching obligation and repayment
 *    transaction, and every Wallet B recovery credit is backed by recovery rows;
 *  - totals for advances issued, recoveries effected and sweep movements
 *    (the content of the daily transaction file).
 */
export async function dailyVerification(start: Date, end: Date): Promise<DailyVerification> {
  const A = await walletAIds();
  const B = WALLET_B_ID();

  const [unmatchedObligations, unmatchedRecoveries, unbackedWalletB, issued, recovered, swept, created, settled] = await Promise.all([
    prisma.$queryRaw<{ id: number }[]>`
      SELECT o.id FROM "Obligation" o
        JOIN "Transactions" t ON t.id = o."transactionId"
       WHERE o."createdAt" >= ${start} AND o."createdAt" < ${end}
         AND NOT EXISTS (
           SELECT 1 FROM "WalletTransaction" w
            WHERE w."walletId" IN (${Prisma.join(A)}) AND w.type = 'disbursement'
              AND w."referenceId" = t."transactionId" AND w."amountKobo" = -o."disbursedKobo")`,
    prisma.$queryRaw<{ id: number }[]>`
      SELECT r.id FROM "ObligationRecovery" r
        LEFT JOIN "Obligation" o ON o.id = r."obligationId"
        LEFT JOIN "Transactions" t ON t.id = r."recoveryTransactionId" AND t."transactionType" = 'repayment'
       WHERE r."createdAt" >= ${start} AND r."createdAt" < ${end}
         AND (o.id IS NULL OR t.id IS NULL)`,
    prisma.$queryRaw<{ id: number }[]>`
      SELECT w.id FROM "WalletTransaction" w
       WHERE w."walletId" = ${B} AND w.type = 'recovery'
         AND w."createdAt" >= ${start} AND w."createdAt" < ${end}
         AND w."amountKobo" <> COALESCE((SELECT SUM(r."amountKobo") FROM "ObligationRecovery" r WHERE r."walletBRecordId" = w.id), 0)`,
    prisma.transactions.aggregate({
      _count: true,
      _sum: { obligationKobo: true, disbursedKobo: true },
      where: { transactionType: 'debit', date: { gte: start, lt: end } },
    }),
    prisma.obligationRecovery.aggregate({ _count: true, _sum: { amountKobo: true }, where: { createdAt: { gte: start, lt: end } } }),
    prisma.walletTransaction.aggregate({ _count: true, _sum: { amountKobo: true }, where: { walletId: { in: A }, type: 'sweep', createdAt: { gte: start, lt: end } } }),
    prisma.obligation.count({ where: { createdAt: { gte: start, lt: end } } }),
    prisma.obligationRecovery.count({ where: { createdAt: { gte: start, lt: end } } }),
  ]);

  const result = {
    obligationsCreated: created,
    obligationsWithoutDisbursement: unmatchedObligations.map((r) => r.id),
    recoveriesSettled: settled,
    recoveriesWithoutObligation: unmatchedRecoveries.map((r) => r.id),
    walletBRecoveriesWithoutRecoveryRows: unbackedWalletB.map((r) => r.id),
    advancesIssued: { count: issued._count, obligationKobo: n(issued._sum.obligationKobo), disbursedKobo: n(issued._sum.disbursedKobo) },
    recoveriesEffected: { count: recovered._count, amountKobo: n(recovered._sum.amountKobo) },
    sweepMovements: { count: swept._count, principalKobo: n(swept._sum.amountKobo) },
  };
  return {
    ...result,
    passed:
      result.obligationsWithoutDisbursement.length === 0 &&
      result.recoveriesWithoutObligation.length === 0 &&
      result.walletBRecoveriesWithoutRecoveryRows.length === 0,
  };
}

export interface MonthlyCheck {
  check: string;
  rule: string;
  values: Record<string, number>;
  expectedKobo: number;
  actualKobo: number;
  differenceKobo: number;
  passed: boolean;
  note?: string;
}

const check = (check: string, rule: string, values: Record<string, number>, expectedKobo: number, actualKobo: number, note?: string): MonthlyCheck => ({
  check, rule, values, expectedKobo, actualKobo,
  differenceKobo: actualKobo - expectedKobo,
  passed: actualKobo === expectedKobo,
  ...(note && { note }),
});

/**
 * §8.2 monthly — four checks over the WAT month [start, end). Each side of
 * every check comes from a different record, so a missing or wrong entry
 * shows up as a difference (zero tolerance throughout).
 */
export async function monthlyChecks(start: Date, end: Date): Promise<MonthlyCheck[]> {
  const A = await walletAIds();
  const B = WALLET_B_ID();
  const win = { from: start, to: end };

  const [
    openingA, closingA, topUpsA, principalReturnedA, sweepsInA,
    openingB, closingB, sweepsOutB, commissionPaidB,
    debits, repayments,
    openingOutstanding, closingOutstanding, createdAgg, recoveredAgg,
    newObligations, serviceReceived,
  ] = await Promise.all([
    ledgerSum(A, { to: start }),
    ledgerSum(A, { to: end }),
    ledgerSum(A, { types: FUNDING_TYPES.filter((t) => t !== PRINCIPAL_RETURN_TYPE), ...win }),
    ledgerSum(A, { types: [PRINCIPAL_RETURN_TYPE], ...win }),
    ledgerSum(A, { types: ['sweep'], ...win }),
    ledgerSum(B, { to: start }),
    ledgerSum(B, { to: end }),
    ledgerSum(B, { types: ['sweep'], ...win }),
    ledgerSum(B, { types: [COMMISSION_PAYOUT_TYPE], ...win }),
    // Independent sources: the transaction book, not the wallet ledger.
    prisma.transactions.aggregate({ _sum: { disbursedKobo: true }, where: { transactionType: 'debit', date: { gte: start, lt: end } } }),
    prisma.transactions.aggregate({ _sum: { obligationKobo: true }, where: { transactionType: 'repayment', date: { gte: start, lt: end } } }),
    outstandingAt(start),
    outstandingAt(end),
    prisma.obligation.aggregate({ _sum: { obligationKobo: true }, where: { createdAt: { gte: start, lt: end } } }),
    prisma.obligationRecovery.aggregate({ _sum: { amountKobo: true }, where: { createdAt: { gte: start, lt: end } } }),
    prisma.obligation.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { obligationKobo: true, disbursedKobo: true, serviceKobo: true, rateBps: true },
    }),
    prisma.$queryRaw<{ expected: bigint | null; received: bigint | null }[]>`
      SELECT SUM(o."serviceKobo") AS expected, SUM(o."serviceRecoveredKobo") AS received
        FROM "Obligation" o
       WHERE o.status = 'Discharged'
         AND (SELECT MAX(r."createdAt") FROM "ObligationRecovery" r WHERE r."obligationId" = o.id) >= ${start}
         AND (SELECT MAX(r."createdAt") FROM "ObligationRecovery" r WHERE r."obligationId" = o.id) < ${end}`,
  ]);

  const totalDisbursed = n(debits._sum.disbursedKobo);
  const totalRecovered = n(repayments._sum.obligationKobo);
  const created = n(createdAgg._sum.obligationKobo);
  const recoveredInMonth = n(recoveredAgg._sum.amountKobo);
  const writtenOff = 0; // no write-off mechanism exists yet; Default obligations stay outstanding

  // Check 4: commission accrued vs the netting formula, per advance.
  const accrued = newObligations.reduce((s, o) => s + o.serviceKobo, 0);
  const nettingExpected = newObligations.reduce(
    (s, o) => s + (o.obligationKobo - Math.floor((o.obligationKobo * 10000) / (10000 + o.rateBps))),
    0
  );
  const disbursedNew = newObligations.reduce((s, o) => s + o.disbursedKobo, 0);
  const literalTenPercent = newObligations.reduce((s, o) => s + (o.disbursedKobo * o.rateBps) / 10000, 0);
  const [received] = serviceReceived;

  return [
    check('1 Wallet A', 'Opening + top-ups + sweeps received − total disbursed (− principal returned) = closing',
      { openingKobo: openingA, topUpsKobo: topUpsA, sweepsReceivedKobo: sweepsInA, totalDisbursedKobo: totalDisbursed, principalReturnedKobo: -principalReturnedA },
      openingA + topUpsA + sweepsInA - totalDisbursed + principalReturnedA, closingA,
      'Disbursed is taken from the transaction book; a difference means a disbursement was not recorded in the wallet ledger, or a sweep did not land.'),
    check('2 Wallet B', 'Opening + total recovered − sweeps to A − commission paid = closing',
      { openingKobo: openingB, totalRecoveredKobo: totalRecovered, sweepsToAKobo: -sweepsOutB, commissionPaidKobo: -commissionPaidB },
      openingB + totalRecovered + sweepsOutB + commissionPaidB, closingB,
      'Recovered is taken from the repayment transactions; a difference means a recovery did not arrive intact.'),
    check('3 Obligation registry', 'Opening outstanding + created − discharged − written off = closing outstanding',
      { openingOutstandingKobo: openingOutstanding, createdKobo: created, recoveredKobo: recoveredInMonth, writtenOffKobo: writtenOff },
      openingOutstanding + created - recoveredInMonth - writtenOff, closingOutstanding,
      'Outstanding balances are measured from obligation state; created and recovered from the registry events. "Discharged" counts every recovered kobo, partial recoveries included.'),
    check('4 Service charge accrual', 'Commission accrued = rate_bps of total disbursed, per the §2 netting formula',
      { advances: newObligations.length, disbursedKobo: disbursedNew, accruedKobo: accrued, literalRateTimesDisbursedKobo: literalTenPercent },
      nettingExpected, accrued,
      `Zero tolerance against service = obligation − floor(obligation × 10000 / (10000 + rate_bps)) for each advance. ` +
      `A literal rate × disbursed (${literalTenPercent.toFixed(2)} kobo) can never match exactly in whole kobo — e.g. the ₦7,000 tier nets 63,637 kobo against 10% × 636,363 = 63,636.3 — ` +
      `so the residue (${(accrued - literalTenPercent).toFixed(2)} kobo, under 1 kobo per advance) is reported, not failed.`),
    check('4b Commission received into B', 'Service charge received for obligations discharged this month = their service charge',
      { expectedKobo: n(received?.expected), receivedKobo: n(received?.received) },
      n(received?.expected), n(received?.received)),
  ];
}
