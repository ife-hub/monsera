import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { controllingIdentity, monthlyChecks } from '../reconciliation';
import { previousWatMonth, watMonthBounds } from '../wat';

const SYSTEM = { employeeName: 'System', emailAddress: 'system@monsera.com' };

/**
 * Spec §8.2 monthly reconciliation for a WAT month (default: the month that
 * just ended; the cut is 23:59 WAT on its last day, §8.3). Runs the four
 * checks plus the controlling identity at the cut, records the outcome as a
 * ReconciliationRun and alerts on any failure. Commission settlement for
 * the month is only permitted after this has passed (see lib/settlement-gate).
 */
export async function runMonthlyReconciliation(period: string = previousWatMonth()) {
  try {
    const { start, end } = watMonthBounds(period);
    if (end.getTime() > Date.now()) {
      throw new Error(`Month ${period} has not closed yet (cut ${end.toISOString()})`);
    }

    const [checks, identityAtCut] = await Promise.all([monthlyChecks(start, end), controllingIdentity(end)]);
    const passed = checks.every((c) => c.passed) && identityAtCut.holds;
    const details = { period, cut: end.toISOString(), checks, identityAtCut };

    await prisma.reconciliationRun.create({ data: { kind: 'monthly', period, passed, details: details as any } });

    const summary = checks
      .map((c) => `${c.check}: ${c.passed ? 'pass' : `FAIL (expected ${c.expectedKobo}k, actual ${c.actualKobo}k, difference ${c.differenceKobo}k)`}`)
      .join('; ');
    const identityText = `identity at cut: ${identityAtCut.holds ? 'holds' : `BREACHED by ${identityAtCut.discrepancyKobo}k`}`;

    if (passed) {
      await prisma.audit.create({ data: { ...SYSTEM, activity: `Monthly reconciliation ${period} passed. ${summary}; ${identityText}.` } });
    } else {
      const message = `MONTHLY RECONCILIATION ${period} FAILED. ${summary}; ${identityText}. Commission settlement for ${period} is blocked.`;
      Sentry.captureException(new Error(message), { tags: { job: 'monthly-reconciliation', type: 'monthly_check_failed' }, extra: details });
      await prisma.audit.create({ data: { ...SYSTEM, activity: message } });
    }

    return { period, passed, checks, identityAtCut };
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'monthly-reconciliation' } });
    throw error;
  }
}
