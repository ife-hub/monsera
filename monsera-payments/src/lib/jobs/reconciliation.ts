import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { classifyObligation, type OpenStatus } from '../recovery-window';
import { controllingIdentity, dailyVerification } from '../reconciliation';
import { previousWatDate, watDayBounds } from '../wat';

const SYSTEM = { employeeName: 'System', emailAddress: 'system@monsera.com' };

/**
 * Spec §8.1 daily reconciliation for one WAT day (default: the day that just
 * ended):
 *  - the controlling identity (live), alerting on any breach;
 *  - every obligation created that day has a matching disbursement, and
 *    every recovery settled that day has a matching obligation;
 *  - the day's advances, recoveries and sweep totals (transaction-file content);
 *  - stored obligation status vs the §5 classification (drift).
 * Discrepancies are written to the audit table and alerted; the outcome is
 * stored as a ReconciliationRun.
 */
export async function runReconciliation(day: string = previousWatDate()) {
  try {
    const { start, end } = watDayBounds(day);
    const [identity, verification] = await Promise.all([controllingIdentity(), dailyVerification(start, end)]);

    // ── Status drift (classification from registered windows + suspensions) ──
    const openObligations = await prisma.obligation.findMany({
      where: { status: { in: ['Current', 'Watch', 'Delayed', 'Default'] }, remainingKobo: { gt: 0 } },
      select: {
        id: true, meterToken: true, status: true, disbursementDate: true,
        watchDate: true, delayedDate: true, defaultDate: true,
        suspensions: { select: { reason: true, startedAt: true, endedAt: true } },
      },
    });
    const now = new Date();
    const countsByStatus: Record<OpenStatus, number> = { Current: 0, Watch: 0, Delayed: 0, Default: 0 };
    const statusMismatches: { id: number; meterToken: string; stored: string; computed: OpenStatus; elapsedDays: number }[] = [];
    for (const o of openObligations) {
      const { status, elapsedDays } = classifyObligation(o, now);
      countsByStatus[status]++;
      // Default is terminal for the sweep, so a stored Default is not drift.
      if (status !== o.status && o.status !== 'Default') {
        statusMismatches.push({ id: o.id, meterToken: o.meterToken, stored: o.status, computed: status, elapsedDays });
      }
    }
    const overdueCount = countsByStatus.Watch + countsByStatus.Delayed + countsByStatus.Default;

    if (statusMismatches.length > 0) {
      Sentry.captureMessage(`Obligation status drift: ${statusMismatches.length} obligation(s) differ from the §5 classification`, {
        level: 'warning',
        tags: { job: 'reconciliation', type: 'status_drift' },
        extra: { sample: statusMismatches.slice(0, 50) },
      });
    }

    const passed = identity.holds && verification.passed;
    const details = { day, identity, verification, countsByStatus, overdueCount, statusMismatches: statusMismatches.length };

    if (!identity.holds) {
      const alertMessage = `RECONCILIATION DISCREPANCY DETECTED. Left side (WalletA + WalletB + Outstanding): ${identity.leftSideKobo} kobo. Right side (Float deployed + Commission not yet paid out): ${identity.rightSideKobo} kobo. Difference: ${identity.discrepancyKobo} kobo. This means money has leaked or is unaccounted for. Immediate investigation required.`;
      Sentry.captureException(new Error(alertMessage), {
        tags: { job: 'reconciliation', type: 'controlling_identity_breach' },
        extra: { ...identity, countsByStatus },
      });
      await prisma.audit.create({ data: { ...SYSTEM, activity: alertMessage } });
    }
    if (!verification.passed) {
      const alertMessage = `RECONCILIATION DISCREPANCY (${day} WAT): obligations without a disbursement [${verification.obligationsWithoutDisbursement.join(', ')}]; recoveries without an obligation [${verification.recoveriesWithoutObligation.join(', ')}]; Wallet B recoveries not matching their recovery rows [${verification.walletBRecoveriesWithoutRecoveryRows.join(', ')}].`;
      Sentry.captureException(new Error(alertMessage), { tags: { job: 'reconciliation', type: 'daily_verification_failed' }, extra: { ...verification } });
      await prisma.audit.create({ data: { ...SYSTEM, activity: alertMessage } });
    }
    if (passed) {
      await prisma.audit.create({
        data: {
          ...SYSTEM,
          activity:
            `Reconciliation passed (${day} WAT). WalletA=${identity.walletAKobo}k, WalletB=${identity.walletBKobo}k, Outstanding=${identity.outstandingObligationsKobo}k, Left=${identity.leftSideKobo}k, ` +
            `FloatDeployed=${identity.floatDeployedKobo}k, CommissionNotYetPaidOut=${identity.commissionNotYetPaidOutKobo}k, Right=${identity.rightSideKobo}k. ` +
            `Day: ${verification.advancesIssued.count} advances (${verification.advancesIssued.disbursedKobo}k disbursed), ${verification.recoveriesEffected.count} recoveries (${verification.recoveriesEffected.amountKobo}k), ${verification.sweepMovements.count} sweeps (${verification.sweepMovements.principalKobo}k). ` +
            `Status: Current=${countsByStatus.Current}, Watch=${countsByStatus.Watch}, Delayed=${countsByStatus.Delayed}, Default=${countsByStatus.Default}. Overdue: ${overdueCount}. Status mismatches: ${statusMismatches.length}.`,
        },
      });
    }

    await prisma.reconciliationRun.create({ data: { kind: 'daily', period: day, passed, details: details as any } });

    return {
      ...identity,
      hasDiscrepancy: !identity.holds,
      day,
      verification,
      passed,
      countsByStatus,
      overdueCount,
      statusMismatches: statusMismatches.length,
    };
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'reconciliation' } });
    throw error;
  }
}
