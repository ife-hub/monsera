import prisma from './prisma';

/**
 * Spec §3.2 cohort check: a meter is in the participating cohort if APLE has
 * shared it (CohortMeter row) and its ring-fence has not been released.
 * Meters outside the cohort are declined before any scoring call is made.
 */
export async function isInCohort(meterToken: string): Promise<boolean> {
  const row = await prisma.cohortMeter.findUnique({
    where: { meterToken },
    select: { removedAt: true },
  });
  return !!row && row.removedAt === null;
}

/**
 * Adds meters to the cohort (or re-admits previously removed ones).
 * Returns how many rows were new or re-admitted.
 */
export async function addToCohort(meterTokens: string[], source: string | null): Promise<number> {
  const tokens = [...new Set(meterTokens.map((t) => t.trim()).filter(Boolean))];
  let changed = 0;
  for (let i = 0; i < tokens.length; i += 1000) {
    const chunk = tokens.slice(i, i + 1000);
    const created = await prisma.cohortMeter.createMany({
      data: chunk.map((meterToken) => ({ meterToken, source })),
      skipDuplicates: true,
    });
    const readmitted = await prisma.cohortMeter.updateMany({
      where: { meterToken: { in: chunk }, removedAt: { not: null } },
      data: { removedAt: null, source },
    });
    changed += created.count + readmitted.count;
  }
  return changed;
}

/**
 * Removes meters from the cohort (ring-fence released). Their open
 * obligations get a `ring_fence_changed` clock suspension (spec §5.3), since
 * recovery can no longer be enforced through the ring-fenced channel.
 */
export async function removeFromCohort(meterTokens: string[], at: Date = new Date()) {
  const { startSuspension } = await import('./suspensions');
  const tokens = [...new Set(meterTokens.map((t) => t.trim()).filter(Boolean))];
  return prisma.$transaction(async (tx) => {
    const removed = await tx.cohortMeter.updateMany({
      where: { meterToken: { in: tokens }, removedAt: null },
      data: { removedAt: at },
    });
    const suspendedObligationIds: number[] = [];
    for (const meterToken of tokens) {
      suspendedObligationIds.push(...(await startSuspension(tx, { meterToken }, 'ring_fence_changed', at)));
    }
    return { removed: removed.count, suspendedObligationIds };
  });
}

/** Extracts meter tokens from APLE's files: a JSON array of strings or of
 * objects with `meter_id` / `meterToken`, or one token per line (CSV ok). */
export function parseMeterTokens(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    const rows = JSON.parse(trimmed) as unknown[];
    return rows
      .map((r) => (typeof r === 'string' ? r : (r as any)?.meterToken ?? (r as any)?.meter_id ?? (r as any)?.meter_token))
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.split(',')[0].trim().replace(/^"|"$/g, ''))
    .filter((t) => t && !/^meter(_id|token|_token)?$/i.test(t));
}
