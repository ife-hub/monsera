import { Prisma } from '@prisma/client';

/** Wallet row ids. Configure via env; defaults match the seeded rows. */
export const WALLET_A_ID = () => Number(process.env.WALLET_A_ID ?? '1'); // credit wallet — funds disbursements
export const WALLET_B_ID = () => Number(process.env.WALLET_B_ID ?? '2'); // repayment wallet — receives recoveries
export const WALLET_C_ID = () => Number(process.env.WALLET_C_ID ?? '3'); // Monsera wallet — finance-house float

/**
 * WalletTransaction types that bring money into (or take it out of) the
 * A+B system from outside. Used by reconciliation as "float injected".
 * Internal movements (disbursement, recovery, sweep) are not funding.
 */
export const PRINCIPAL_RETURN_TYPE = 'withdrawal';
export const FUNDING_TYPES = ['top-up', 'allocation', PRINCIPAL_RETURN_TYPE, 'opening-balance'] as const;

/**
 * Monthly settlement of commission out of Wallet B (spec §7). Not a float
 * movement: it reduces "commission not yet paid out" in the identity.
 */
export const COMMISSION_PAYOUT_TYPE = 'commission-payout';

export class InsufficientWalletBalanceError extends Error {
  constructor(public walletId: number, public balanceKobo: number, public requestedKobo: number) {
    super(`Wallet ${walletId} has ${balanceKobo} kobo, cannot debit ${requestedKobo} kobo`);
    this.name = 'InsufficientWalletBalanceError';
  }
}

type Tx = Prisma.TransactionClient;

/** Locks a wallet row for the rest of the transaction and returns its balance in kobo. */
export async function lockWallet(tx: Tx, walletId: number): Promise<number> {
  const rows = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
    SELECT balance FROM "Wallet" WHERE id = ${walletId} FOR UPDATE`;
  if (rows.length === 0) throw new Error(`Wallet ${walletId} not found`);
  return Math.round(Number(rows[0].balance ?? 0) * 100);
}

/**
 * Atomically moves a wallet balance by `deltaKobo` (negative = debit) and
 * writes the matching WalletTransaction ledger row. Must be called inside
 * prisma.$transaction. A debit that would take the balance below zero
 * throws InsufficientWalletBalanceError and changes nothing.
 *
 * One SQL statement does the check, the move and the ledger row. The UPDATE
 * takes the wallet's row lock and holds it until the surrounding transaction
 * commits, so concurrent callers queue on it; Postgres re-checks the
 * "stays at or above zero" condition against the latest balance once the
 * lock is granted, so a balance can never go negative. Doing it in one
 * round trip (it used to be three: lock-and-read, update, insert) keeps the
 * lock held for as short a time as possible: every approved advance takes
 * Wallet A's lock, so this is what limits how many advances per second the
 * platform can disburse.
 *
 * Balances are stored in naira (Decimal); the delta is applied as an
 * increment, never as a read-modify-write of the absolute value.
 */
export async function adjustWallet(
  tx: Tx,
  walletId: number,
  deltaKobo: number,
  type: string,
  description: string,
  referenceId?: string
) {
  if (!Number.isInteger(deltaKobo) || deltaKobo === 0) {
    throw new Error(`Wallet adjustment must be a non-zero integer kobo amount, got ${deltaKobo}`);
  }
  if (Math.abs(deltaKobo) <= MAX_LEDGER_ROW_KOBO) {
    return adjustWalletOnce(tx, walletId, deltaKobo, type, description, referenceId);
  }

  // Larger than one ledger row can hold (amountKobo is a 32-bit column): the
  // same movement as several rows of at most MAX_LEDGER_ROW_KOBO, with the
  // same type and reference. A debit is checked in full first, under the
  // wallet's lock, so it moves all of it or nothing.
  const sign = Math.sign(deltaKobo);
  if (sign < 0) {
    const balanceKobo = await lockWallet(tx, walletId);
    if (balanceKobo + deltaKobo < 0) throw new InsufficientWalletBalanceError(walletId, balanceKobo, -deltaKobo);
  }
  let result: Awaited<ReturnType<typeof adjustWalletOnce>> | undefined;
  const records = [];
  let firstPrevious: number | undefined;
  for (let left = Math.abs(deltaKobo); left > 0; left -= MAX_LEDGER_ROW_KOBO) {
    result = await adjustWalletOnce(tx, walletId, sign * Math.min(left, MAX_LEDGER_ROW_KOBO), type, description, referenceId);
    firstPrevious ??= result.previousBalanceKobo;
    records.push(result.record);
  }
  return { ...result!, previousBalanceKobo: firstPrevious!, records };
}

/**
 * Largest amount one WalletTransaction row holds (its amountKobo column is a
 * 32-bit integer, max 2,147,483,647). ₦20,000,000.
 */
export const MAX_LEDGER_ROW_KOBO = 2_000_000_000;

/** One balance move and its ledger row, in one statement (|deltaKobo| <= MAX_LEDGER_ROW_KOBO). */
async function adjustWalletOnce(
  tx: Tx,
  walletId: number,
  deltaKobo: number,
  type: string,
  description: string,
  referenceId?: string
) {
  const rows = await tx.$queryRaw<AdjustedRow[]>`
    WITH updated AS (
      UPDATE "Wallet"
      SET balance = COALESCE(balance, 0) + ${deltaKobo}::numeric / 100, "updatedAt" = now()
      WHERE id = ${walletId}
        AND (${deltaKobo}::bigint >= 0 OR COALESCE(balance, 0) * 100 + ${deltaKobo}::bigint >= 0)
      RETURNING id, "walletType", balance, "createdAt", "updatedAt"
    ), record AS (
      INSERT INTO "WalletTransaction" ("walletId", type, "amountKobo", description, "referenceId")
      SELECT id, ${type}, ${deltaKobo}::int, ${description}, ${referenceId ?? null} FROM updated
      RETURNING id, "walletId", type, "amountKobo", description, "referenceId", "createdAt"
    )
    SELECT u.id, u."walletType", u.balance, u."createdAt", u."updatedAt",
           r.id AS "recordId", r.type AS "recordType", r."amountKobo" AS "recordAmountKobo",
           r.description AS "recordDescription", r."referenceId" AS "recordReferenceId", r."createdAt" AS "recordCreatedAt"
    FROM updated u, record r`;

  if (rows.length === 0) {
    // Nothing moved: the wallet is missing, or the debit would overdraw it.
    // (Rare path, so the extra read only happens here.)
    const balanceKobo = await lockWallet(tx, walletId); // throws "not found"
    throw new InsufficientWalletBalanceError(walletId, balanceKobo, -deltaKobo);
  }

  const row = rows[0];
  const wallet = { id: row.id, walletType: row.walletType, balance: row.balance, createdAt: row.createdAt, updatedAt: row.updatedAt };
  const record = {
    id: row.recordId,
    walletId: row.id,
    type: row.recordType,
    amountKobo: row.recordAmountKobo,
    description: row.recordDescription,
    referenceId: row.recordReferenceId,
    createdAt: row.recordCreatedAt,
  };
  const newBalanceKobo = Math.round(Number(row.balance ?? 0) * 100);
  return { wallet, record, records: [record], previousBalanceKobo: newBalanceKobo - deltaKobo, newBalanceKobo };
}

interface AdjustedRow {
  id: number;
  walletType: string;
  balance: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
  recordId: number;
  recordType: string;
  recordAmountKobo: number;
  recordDescription: string;
  recordReferenceId: string | null;
  recordCreatedAt: Date;
}

/** Parses a naira amount (number or numeric string, max 2 dp) into positive integer kobo, or null. */
export function nairaToKobo(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const kobo = Math.round(n * 100);
  if (Math.abs(kobo - n * 100) > 1e-6) return null; // more than 2 decimal places
  return kobo;
}
