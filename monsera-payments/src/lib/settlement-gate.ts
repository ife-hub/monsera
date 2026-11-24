import prisma from './prisma';

/**
 * Spec §8.3: settlement runs after reconciliation has passed. Returns null if
 * commission for `period` (YYYY-MM, WAT) may be settled, else the reason not.
 */
export async function monthlySettlementBlocker(period: string): Promise<string | null> {
  const latest = await prisma.reconciliationRun.findFirst({
    where: { kind: 'monthly', period },
    orderBy: { createdAt: 'desc' },
    select: { passed: true, createdAt: true },
  });
  if (!latest) return `Monthly reconciliation for ${period} has not been run`;
  if (!latest.passed) return `Monthly reconciliation for ${period} failed (${latest.createdAt.toISOString()}); resolve it and re-run before settling`;
  return null;
}
