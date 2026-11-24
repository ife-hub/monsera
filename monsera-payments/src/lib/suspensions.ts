import { Prisma } from '@prisma/client';
import { MS_PER_DAY, SUSPENSION_REASONS, suspendedMs, type SuspensionReason } from './recovery-window';

type Tx = Prisma.TransactionClient;

const OPEN_STATUSES = ['Current', 'Watch', 'Delayed', 'Default'] as const;

export function isSuspensionReason(value: unknown): value is SuspensionReason {
  return typeof value === 'string' && value in SUSPENSION_REASONS;
}

export interface SuspensionScope {
  /** Suspend obligations for one meter… */
  meterToken?: string;
  /** …or every open obligation of a disco (e.g. its systems are down). */
  discoAdminId?: number;
}

function openObligationsWhere(scope: SuspensionScope): Prisma.ObligationWhereInput {
  return {
    status: { in: [...OPEN_STATUSES] },
    remainingKobo: { gt: 0 },
    ...(scope.meterToken ? { meterToken: scope.meterToken } : {}),
    ...(scope.discoAdminId ? { discoAdminId: scope.discoAdminId } : {}),
  };
}

/**
 * Spec §5.3: starts a clock suspension on every open obligation in scope.
 * Obligations already suspended for the same reason are left as they are, so
 * repeated notifications are harmless. Returns the obligation ids affected.
 */
export async function startSuspension(
  tx: Tx,
  scope: SuspensionScope,
  reason: SuspensionReason,
  startedAt: Date
): Promise<number[]> {
  const obligations = await tx.obligation.findMany({
    where: {
      ...openObligationsWhere(scope),
      suspensions: { none: { reason, endedAt: null } },
    },
    select: { id: true },
  });
  if (obligations.length === 0) return [];
  const ids = obligations.map((o) => o.id);
  await tx.obligationSuspension.createMany({
    data: ids.map((obligationId) => ({ obligationId, reason, startedAt })),
  });
  await tx.obligation.updateMany({ where: { id: { in: ids } }, data: { clockSuspended: true, updatedAt: new Date() } });
  return ids;
}

/**
 * Ends the open suspension(s) for `reason` on every obligation in scope and
 * refreshes the cached suspendedDays / clockSuspended fields. The elapsed-days
 * calculation itself always reads the suspension rows, so it stays
 * reconstructable (§5.3); the cached fields are for display only.
 */
export async function endSuspension(
  tx: Tx,
  scope: SuspensionScope,
  reason: SuspensionReason,
  endedAt: Date
): Promise<number[]> {
  const open = await tx.obligationSuspension.findMany({
    where: {
      reason,
      endedAt: null,
      startedAt: { lte: endedAt },
      obligation: {
        ...(scope.meterToken ? { meterToken: scope.meterToken } : {}),
        ...(scope.discoAdminId ? { discoAdminId: scope.discoAdminId } : {}),
      },
    },
    select: { id: true, obligationId: true },
  });
  if (open.length === 0) return [];

  await tx.obligationSuspension.updateMany({
    where: { id: { in: open.map((s) => s.id) } },
    data: { endedAt },
  });

  const obligationIds = [...new Set(open.map((s) => s.obligationId))];
  for (const obligationId of obligationIds) {
    const [obligation, suspensions] = await Promise.all([
      tx.obligation.findUniqueOrThrow({ where: { id: obligationId }, select: { disbursementDate: true } }),
      tx.obligationSuspension.findMany({ where: { obligationId }, select: { reason: true, startedAt: true, endedAt: true } }),
    ]);
    const closed = suspensions.filter((s) => s.endedAt !== null);
    const closedDays = Math.floor(suspendedMs(closed, obligation.disbursementDate, endedAt) / MS_PER_DAY);
    await tx.obligation.update({
      where: { id: obligationId },
      data: {
        suspendedDays: closedDays,
        clockSuspended: suspensions.some((s) => s.endedAt === null),
        updatedAt: new Date(),
      },
    });
  }
  return obligationIds;
}
