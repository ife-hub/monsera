import { Prisma } from '@prisma/client';
import prisma from './prisma';

/**
 * Disco and aggregator running totals (DiscoAdmins.balance/outstanding,
 * Aggregators.outstanding, lastInteraction), kept off the advance's
 * critical path.
 *
 * Every advance and repayment through a partner used to update that
 * partner's row inside its money transaction. A row stays locked until the
 * transaction commits, so with one disco (APLE) every advance queued on that
 * one row. These totals are reporting figures: nothing approves or refuses
 * an advance from them (Wallet A is the only funding check), so they may lag
 * by a few seconds.
 *
 * Instead, the money transaction appends a PartnerBalanceChange row (an
 * insert never waits for another), and foldPartnerChanges() adds the pending
 * rows into the partner rows every couple of seconds. partnerTotals() gives
 * the exact current figure (row + pending changes) where one is needed, e.g.
 * the disco's new balance in an advance's response.
 */

export type PartnerType = 'disco' | 'aggregator';

export interface PartnerChange {
  partnerType: PartnerType;
  partnerId: number;
  balanceDeltaKobo?: number;
  outstandingDeltaKobo?: number;
  reference?: string;
}

/** Records changes to partner totals inside the caller's transaction. */
export async function recordPartnerChanges(tx: Prisma.TransactionClient, changes: PartnerChange[], at: Date = new Date()) {
  const rows = changes
    .filter((c) => (c.balanceDeltaKobo ?? 0) !== 0 || (c.outstandingDeltaKobo ?? 0) !== 0)
    .map((c) => ({
      partnerType: c.partnerType,
      partnerId: c.partnerId,
      balanceDeltaKobo: Math.round(c.balanceDeltaKobo ?? 0),
      outstandingDeltaKobo: Math.round(c.outstandingDeltaKobo ?? 0),
      interactionAt: at,
      reference: c.reference ?? null,
    }));
  if (rows.length > 0) await tx.partnerBalanceChange.createMany({ data: rows });
}

/** A partner's exact current totals in kobo: its row plus changes not yet folded in. */
export async function partnerTotals(partnerType: PartnerType, partnerId: number): Promise<{ balanceKobo: number; outstandingKobo: number }> {
  const table = partnerType === 'disco' ? Prisma.sql`"DiscoAdmins"` : Prisma.sql`"Aggregators"`;
  const [row] = await prisma.$queryRaw<{ balance: Prisma.Decimal | null; outstanding: Prisma.Decimal | null }[]>`
    SELECT
      ROUND(COALESCE(p.balance, 0) * 100)
        + COALESCE((SELECT SUM("balanceDeltaKobo") FROM "PartnerBalanceChange"
                     WHERE "partnerType" = ${partnerType} AND "partnerId" = ${partnerId} AND "appliedAt" IS NULL), 0) AS balance,
      ROUND(COALESCE(p.outstanding, 0) * 100)
        + COALESCE((SELECT SUM("outstandingDeltaKobo") FROM "PartnerBalanceChange"
                     WHERE "partnerType" = ${partnerType} AND "partnerId" = ${partnerId} AND "appliedAt" IS NULL), 0) AS outstanding
    FROM ${table} p WHERE p.id = ${partnerId}`;
  return { balanceKobo: Number(row?.balance ?? 0), outstandingKobo: Number(row?.outstanding ?? 0) };
}

interface PendingRow {
  id: number;
  partnerType: PartnerType;
  partnerId: number;
  balanceDeltaKobo: number;
  outstandingDeltaKobo: number;
  interactionAt: Date;
}

/**
 * Adds pending changes into the partner rows. Safe to run from several
 * instances at once: each claims its own rows (SKIP LOCKED), and partner rows
 * are updated in a fixed order (discos, then aggregators, by id), so two
 * folds cannot deadlock.
 */
export async function foldPartnerChanges(batchSize = 5000): Promise<{ applied: number; partners: number }> {
  return prisma.$transaction(
    async (tx) => {
      const pending = await tx.$queryRaw<PendingRow[]>`
        SELECT id, "partnerType", "partnerId", "balanceDeltaKobo", "outstandingDeltaKobo", "interactionAt"
          FROM "PartnerBalanceChange"
         WHERE "appliedAt" IS NULL
         ORDER BY id
         LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED`;
      if (pending.length === 0) return { applied: 0, partners: 0 };

      const totals = new Map<string, { type: PartnerType; id: number; balance: number; outstanding: number; lastAt: Date }>();
      for (const r of pending) {
        const key = `${r.partnerType}:${r.partnerId}`;
        const t = totals.get(key) ?? { type: r.partnerType, id: r.partnerId, balance: 0, outstanding: 0, lastAt: r.interactionAt };
        t.balance += r.balanceDeltaKobo;
        t.outstanding += r.outstandingDeltaKobo;
        if (r.interactionAt > t.lastAt) t.lastAt = r.interactionAt;
        totals.set(key, t);
      }

      const ordered = [...totals.values()].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === 'disco' ? -1 : 1));
      for (const t of ordered) {
        if (t.type === 'disco') {
          await tx.$executeRaw`
            UPDATE "DiscoAdmins"
               SET balance = COALESCE(balance, 0) + ${t.balance}::numeric / 100,
                   outstanding = COALESCE(outstanding, 0) + ${t.outstanding}::numeric / 100,
                   "lastInteraction" = GREATEST("lastInteraction", ${t.lastAt})
             WHERE id = ${t.id}`;
        } else {
          await tx.$executeRaw`
            UPDATE "Aggregators"
               SET balance = CASE WHEN ${t.balance}::int = 0 THEN balance ELSE COALESCE(balance, 0) + ${t.balance}::numeric / 100 END,
                   outstanding = COALESCE(outstanding, 0) + ${t.outstanding}::numeric / 100,
                   "lastInteraction" = GREATEST("lastInteraction", ${t.lastAt})
             WHERE id = ${t.id}`;
        }
      }

      await tx.$executeRaw`
        UPDATE "PartnerBalanceChange" SET "appliedAt" = now() WHERE id IN (${Prisma.join(pending.map((r) => r.id))})`;
      return { applied: pending.length, partners: ordered.length };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}

/** Folds until nothing is pending (or `maxRounds` batches). Never throws. */
export async function foldAllPartnerChanges(maxRounds = 20): Promise<number> {
  let applied = 0;
  try {
    for (let i = 0; i < maxRounds; i++) {
      const r = await foldPartnerChanges();
      applied += r.applied;
      if (r.applied === 0) break;
    }
  } catch (error: any) {
    console.error(`Folding partner totals failed (will retry): ${error.message}`);
  }
  return applied;
}
