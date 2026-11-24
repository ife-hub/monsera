import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { classifyObligation } from '../recovery-window';
import { publishObligationStatusChanged } from '../events';

const SYSTEM = { employeeName: 'System', emailAddress: 'system@monsera.com' };

/**
 * Spec §5.2 — daily status evaluation of every open obligation against the
 * windows registered at disbursement. Elapsed days exclude suspended time
 * reconstructed from the suspension records (§5.3), so a suspended clock
 * simply stops; a suspension recorded retroactively can move an obligation
 * back to an earlier status.
 *
 * Actions per the spec's status table:
 *   Watch   — flagged in the daily report (the audit summary below lists them)
 *   Delayed — flagged and operations alerted (Sentry + audit)
 *   Default — classified as default, alerted, absorbed per policy
 * Default is terminal for this sweep.
 */
export async function runObligationStatusSweep(now: Date = new Date()) {
  try {
    const activeObligations = await prisma.obligation.findMany({
      where: {
        status: { in: ['Current', 'Watch', 'Delayed'] },
        remainingKobo: { gt: 0 },
      },
      select: {
        id: true,
        status: true,
        disbursementDate: true,
        watchDate: true,
        delayedDate: true,
        defaultDate: true,
        meterToken: true,
        discoAdminId: true,
        remainingKobo: true,
        suspensions: { select: { reason: true, startedAt: true, endedAt: true } },
      },
    });

    let watched = 0;
    let delayed = 0;
    let defaulted = 0;
    const watchList: string[] = [];

    for (const obligation of activeObligations) {
      const { status: newStatus, elapsedDays } = classifyObligation(obligation, now);

      if (newStatus === 'Watch') watchList.push(`${obligation.id}(${obligation.meterToken}, day ${elapsedDays})`);
      if (newStatus === obligation.status) continue;

      // Count transitions, not obligations that merely sit in a status.
      if (newStatus === 'Default') defaulted++;
      else if (newStatus === 'Delayed') delayed++;
      else if (newStatus === 'Watch') watched++;

      await prisma.obligation.update({
        where: { id: obligation.id },
        data: { status: newStatus, updatedAt: now },
      });

      if (newStatus === 'Default' || newStatus === 'Delayed') {
        const alertMessage = `Obligation ${obligation.id} (meterToken: ${obligation.meterToken}) moved from ${obligation.status} to ${newStatus}. Remaining: ${obligation.remainingKobo} kobo. Effective elapsed: ${elapsedDays} days.`;
        // Operations alert: monsera-notifications batches these into one
        // digest email (one alert per obligation would flood the inbox).
        await publishObligationStatusChanged({
          obligationId: obligation.id,
          meterToken: obligation.meterToken,
          discoAdminId: obligation.discoAdminId,
          from: obligation.status,
          to: newStatus,
          remainingKobo: obligation.remainingKobo,
        });
        await prisma.audit.create({
          data: { ...SYSTEM, activity: `Obligation status alert: ${alertMessage}`, meterId: obligation.meterToken },
        });
      }
    }

    await prisma.audit.create({
      data: {
        ...SYSTEM,
        activity:
          `Obligation status sweep: ${watched} moved to Watch, ${delayed} moved to Delayed, ${defaulted} moved to Default. ` +
          `Total evaluated: ${activeObligations.length}. ` +
          `Daily report — on Watch (${watchList.length}): ${watchList.join(', ') || 'none'}.`,
      },
    });

    return { watched, delayed, defaulted, total: activeObligations.length, onWatch: watchList.length };
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'obligation-status' } });
    throw error;
  }
}
