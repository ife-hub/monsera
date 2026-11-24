import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { adjustWallet, InsufficientWalletBalanceError, WALLET_A_ID, WALLET_B_ID, WALLET_C_ID } from './wallets';

/**
 * Wallet A, split into sub-wallets.
 *
 * Every approved advance takes money out of Wallet A, and a wallet row stays
 * locked until its transaction commits, so with a single row advances can
 * only commit one at a time. Wallet A is therefore made of several rows:
 * Wallet A itself (WALLET_A_ID) plus sub-wallets that point at it
 * (Wallet.parentWalletId). Wallet A's balance is the sum of all of them, and
 * each row keeps its own ledger (its balance equals the sum of its
 * WalletTransaction rows, as for every wallet).
 *
 *  - An advance takes its amount from one row that has enough money and is
 *    not locked by another advance at that moment (SKIP LOCKED), so up to
 *    WALLET_A_SHARDS advances commit at the same time.
 *  - Money comes in (sweeps, float allocations, top-ups) on Wallet A itself;
 *    rebalanceWalletA() then spreads it evenly. A rebalance is a set of
 *    'rebalance' ledger rows that net to zero within Wallet A.
 *  - Reconciliation and the controlling identity treat all the rows as one
 *    Wallet A (walletAIds / walletABalanceKobo).
 *
 * WALLET_A_SHARDS (default 8) is the number of rows including Wallet A
 * itself; 1 turns the split off.
 */
export const WALLET_A_SHARDS = () => Math.max(1, Math.floor(Number(process.env.WALLET_A_SHARDS ?? 8)) || 1);

export const REBALANCE_TYPE = 'rebalance';

type Db = Prisma.TransactionClient | typeof prisma;

// Postgres advisory lock key for creating and rebalancing sub-wallets.
const WALLET_A_LOCK_KEY = 72_000_001;

/** Ids of every row that makes up Wallet A (Wallet A first). */
export async function walletAIds(db: Db = prisma): Promise<number[]> {
  const A = WALLET_A_ID();
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Wallet" WHERE id = ${A} OR "parentWalletId" = ${A} ORDER BY (id = ${A}) DESC, id`;
  return rows.length > 0 ? rows.map((r) => r.id) : [A];
}

/** Wallet A's balance in kobo: Wallet A plus its sub-wallets. */
export async function walletABalanceKobo(db: Db = prisma): Promise<number> {
  const A = WALLET_A_ID();
  const [row] = await db.$queryRaw<{ kobo: Prisma.Decimal | null }[]>`
    SELECT ROUND(COALESCE(SUM(balance), 0) * 100) AS kobo FROM "Wallet" WHERE id = ${A} OR "parentWalletId" = ${A}`;
  return Number(row?.kobo ?? 0);
}

export interface WalletADebit {
  walletId: number;
  newBalanceKobo: number;
  record: { id: number; walletId: number; type: string; amountKobo: number; description: string; referenceId: string | null; createdAt: Date };
}

interface DebitRow {
  id: number;
  balance: Prisma.Decimal | null;
  recordId: number;
  recordType: string;
  recordAmountKobo: number;
  recordDescription: string;
  recordReferenceId: string | null;
  recordCreatedAt: Date;
}

/**
 * The statement that takes `amountKobo` out of one Wallet A row and writes
 * its ledger row. `pick` decides which row:
 *  - skip-locked: any free row that can cover it, never waiting;
 *  - a given row id: wait for that one row (and only that one).
 * The UPDATE re-checks the balance under the row lock, so it never overdraws.
 */
async function takeStatement(tx: Prisma.TransactionClient, pick: Prisma.Sql, amountKobo: number, type: string, description: string, referenceId: string | null) {
  return tx.$queryRaw<DebitRow[]>`
    WITH pick AS (${pick}), updated AS (
      UPDATE "Wallet" w
         SET balance = COALESCE(w.balance, 0) - ${amountKobo}::numeric / 100, "updatedAt" = now()
        FROM pick
       WHERE w.id = pick.id AND COALESCE(w.balance, 0) * 100 >= ${amountKobo}::bigint
      RETURNING w.id, w.balance
    ), record AS (
      INSERT INTO "WalletTransaction" ("walletId", type, "amountKobo", description, "referenceId")
      SELECT id, ${type}, ${-amountKobo}::int, ${description}, ${referenceId} FROM updated
      RETURNING id, type, "amountKobo", description, "referenceId", "createdAt"
    )
    SELECT u.id, u.balance,
           r.id AS "recordId", r.type AS "recordType", r."amountKobo" AS "recordAmountKobo",
           r.description AS "recordDescription", r."referenceId" AS "recordReferenceId", r."createdAt" AS "recordCreatedAt"
      FROM updated u, record r`;
}

/**
 * Runs one attempt inside a savepoint. A row the attempt locked but did not
 * use (Postgres keeps such a lock until the transaction ends) is released
 * by rolling back to the savepoint, so a failed attempt leaves this
 * transaction holding no Wallet A row. That is what makes the gather step
 * below deadlock-free.
 */
async function attempt(tx: Prisma.TransactionClient, run: () => Promise<DebitRow[]>): Promise<DebitRow[]> {
  await tx.$executeRawUnsafe('SAVEPOINT wallet_a_take');
  const rows = await run();
  // On success the savepoint is simply left for the commit to discard: no
  // extra round trip while this transaction holds the row lock.
  if (rows.length === 0) await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT wallet_a_take');
  return rows;
}

/**
 * Takes a disbursement (or any debit) out of Wallet A. Must run inside the
 * caller's transaction; the row it used stays locked until that commits.
 *
 *  1. A free row that can cover the amount, without waiting.
 *  2. Every such row is busy: pick one that can cover it and wait for that
 *     row alone (a few tries, as another advance may empty it first).
 *  3. No single row can cover it but Wallet A in total can: gather the money
 *     onto Wallet A itself, inside this transaction, and take it there.
 *  4. Otherwise InsufficientWalletBalanceError, reporting Wallet A's total.
 *
 * Deadlock-free: steps 1 and 2 never hold one Wallet A row while waiting for
 * another, and a failed attempt releases what it locked (see `attempt`); the
 * gather takes the Wallet A advisory lock and then every row in id order,
 * like every other gather and rebalance.
 */
export async function debitWalletA(
  tx: Prisma.TransactionClient,
  amountKobo: number,
  type: string,
  description: string,
  referenceId?: string
): Promise<WalletADebit> {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw new Error(`Wallet A debit must be a positive integer kobo amount, got ${amountKobo}`);
  }
  const A = WALLET_A_ID();
  const ref = referenceId ?? null;
  const take = (pick: Prisma.Sql) => attempt(tx, () => takeStatement(tx, pick, amountKobo, type, description, ref));

  // 1. A free row that can cover it.
  let rows = await take(Prisma.sql`
    SELECT id FROM "Wallet"
     WHERE (id = ${A} OR "parentWalletId" = ${A}) AND COALESCE(balance, 0) * 100 >= ${amountKobo}::bigint
     ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED`);

  // 2. All busy: wait for one specific row that can cover it.
  for (let i = 0; rows.length === 0 && i < 3; i++) {
    const [candidate] = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Wallet"
       WHERE (id = ${A} OR "parentWalletId" = ${A}) AND COALESCE(balance, 0) * 100 >= ${amountKobo}::bigint
       ORDER BY random() LIMIT 1`;
    if (!candidate) break;
    rows = await take(Prisma.sql`SELECT id FROM "Wallet" WHERE id = ${candidate.id} FOR UPDATE`);
  }

  // 3. Spread too thin: gather onto Wallet A itself, then take it there.
  if (rows.length === 0) {
    const totalKobo = await walletABalanceKobo(tx);
    if (totalKobo < amountKobo) throw new InsufficientWalletBalanceError(A, totalKobo, amountKobo);
    const { totalKobo: lockedTotal } = await moveWithinWalletA(tx, { gatherKobo: amountKobo });
    // This transaction now holds every Wallet A row, so no waiting here.
    rows = await takeStatement(tx, Prisma.sql`SELECT id FROM "Wallet" WHERE id = ${A}`, amountKobo, type, description, ref);
    if (rows.length === 0) throw new InsufficientWalletBalanceError(A, lockedTotal, amountKobo);
  }

  const row = rows[0];
  return {
    walletId: row.id,
    newBalanceKobo: Math.round(Number(row.balance ?? 0) * 100),
    record: {
      id: row.recordId,
      walletId: row.id,
      type: row.recordType,
      amountKobo: row.recordAmountKobo,
      description: row.recordDescription,
      referenceId: row.recordReferenceId,
      createdAt: row.recordCreatedAt,
    },
  };
}

/**
 * Creates the sub-wallets WALLET_A_SHARDS asks for (never removes any).
 * Safe to run from several instances at once.
 */
export async function ensureWalletASubWallets(): Promise<number[]> {
  const A = WALLET_A_ID();
  const wanted = WALLET_A_SHARDS() - 1;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WALLET_A_LOCK_KEY})`;
    const walletA = await tx.wallet.findUnique({ where: { id: A }, select: { id: true } });
    if (!walletA) return [];
    const existing = await tx.wallet.count({ where: { parentWalletId: A } });
    if (existing < wanted) {
      // Wallets are often seeded with explicit ids, which leaves the id
      // sequence behind. Move it past the highest existing id and past the
      // configured Wallet A/B/C ids, so a sub-wallet can never take an id
      // that WALLET_B_ID or WALLET_C_ID points at (even before that row exists).
      const reserved = Math.max(A, WALLET_B_ID(), WALLET_C_ID());
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('"Wallet"', 'id'), GREATEST((SELECT MAX(id) FROM "Wallet"), ${reserved}::int))`;
    }
    for (let i = existing; i < wanted; i++) {
      await tx.wallet.create({ data: { walletType: 'A', balance: 0, parentWalletId: A } });
    }
    return walletAIds(tx);
  });
}

/**
 * Spreads Wallet A's money evenly over its rows (the remainder stays on
 * Wallet A itself), in its own short transaction. With `gatherKobo`, instead
 * makes sure Wallet A itself holds at least that much, moving as little as
 * possible.
 */
export async function rebalanceWalletA(opts: { gatherKobo?: number } = {}) {
  return prisma.$transaction((tx) => moveWithinWalletA(tx, opts), { maxWait: 10_000, timeout: 30_000 });
}

/**
 * The moves behind rebalanceWalletA, inside the caller's transaction. Takes
 * the Wallet A advisory lock, then locks every Wallet A row in id order
 * (waiting for advances in flight to commit), and writes one 'rebalance'
 * ledger row per row that changes; they net to zero.
 */
async function moveWithinWalletA(tx: Prisma.TransactionClient, opts: { gatherKobo?: number }) {
  const A = WALLET_A_ID();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WALLET_A_LOCK_KEY})`;
  const rows = await tx.$queryRaw<{ id: number; balance: Prisma.Decimal | null }[]>`
    SELECT id, balance FROM "Wallet" WHERE id = ${A} OR "parentWalletId" = ${A} ORDER BY id FOR UPDATE`;
  if (rows.length <= 1) return { moves: 0, totalKobo: rows.length ? Math.round(Number(rows[0].balance ?? 0) * 100) : 0 };

  const current = new Map(rows.map((r) => [r.id, Math.round(Number(r.balance ?? 0) * 100)]));
  const totalKobo = [...current.values()].reduce((s, v) => s + v, 0);
  const target = new Map<number, number>();

  if (opts.gatherKobo !== undefined) {
    // Top Wallet A itself up to the amount needed, from the fullest rows first.
    let need = Math.max(0, opts.gatherKobo - (current.get(A) ?? 0));
    for (const [id, kobo] of current) target.set(id, kobo);
    const donors = [...current.entries()].filter(([id]) => id !== A).sort((a, b) => b[1] - a[1]);
    for (const [id, kobo] of donors) {
      if (need <= 0) break;
      const take = Math.min(kobo, need);
      target.set(id, kobo - take);
      target.set(A, (target.get(A) ?? 0) + take);
      need -= take;
    }
  } else {
    const share = Math.floor(totalKobo / rows.length);
    for (const { id } of rows) target.set(id, share);
    target.set(A, share + (totalKobo - share * rows.length));
  }

  const reference = `rebalance-${Date.now()}`;
  const description = opts.gatherKobo !== undefined ? `Wallet A: gathered for a ${opts.gatherKobo} kobo debit` : 'Wallet A: spread evenly over sub-wallets';
  // Debits first, so no row ever dips below zero in between.
  const changes = rows
    .map(({ id }) => ({ id, delta: (target.get(id) ?? 0) - (current.get(id) ?? 0) }))
    .filter((c) => c.delta !== 0)
    .sort((a, b) => a.delta - b.delta);
  for (const { id, delta } of changes) {
    await adjustWallet(tx, id, delta, REBALANCE_TYPE, description, reference);
  }
  return { moves: changes.length, totalKobo };
}

/**
 * Rebalance after money arrives on Wallet A. Never throws: if it fails, the
 * scheduled rebalance and the gather step in debitWalletA still cover it.
 */
export async function rebalanceWalletAQuietly(): Promise<void> {
  try {
    await rebalanceWalletA();
  } catch (error: any) {
    console.error(`Wallet A rebalance failed (will retry on schedule): ${error.message}`);
  }
}
