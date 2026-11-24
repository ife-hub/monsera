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
 * prisma.$transaction. The row is locked first, so concurrent callers
 * serialise instead of overwriting each other; a debit that would take the
 * balance below zero throws InsufficientWalletBalanceError.
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
  const balanceKobo = await lockWallet(tx, walletId);
  if (deltaKobo < 0 && balanceKobo + deltaKobo < 0) {
    throw new InsufficientWalletBalanceError(walletId, balanceKobo, -deltaKobo);
  }

  const wallet = await tx.wallet.update({
    where: { id: walletId },
    data: {
      balance: { increment: new Prisma.Decimal(deltaKobo).div(100) },
      updatedAt: new Date(),
    },
  });

  const record = await tx.walletTransaction.create({
    data: { walletId, type, amountKobo: deltaKobo, description, referenceId: referenceId ?? null },
  });

  return { wallet, record, previousBalanceKobo: balanceKobo, newBalanceKobo: balanceKobo + deltaKobo };
}

/** Parses a naira amount (number or numeric string, max 2 dp) into positive integer kobo, or null. */
export function nairaToKobo(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const kobo = Math.round(n * 100);
  if (Math.abs(kobo - n * 100) > 1e-6) return null; // more than 2 decimal places
  return kobo;
}
