import { scheduledJobsQueue } from './queues';
import { runDailySweep } from './jobs/daily-sweep';
import { runSettlement } from './jobs/settlement';
import { runReconciliation } from './jobs/reconciliation';
import { runMonthlyReconciliation } from './jobs/monthly-reconciliation';
import { runObligationStatusSweep } from './jobs/obligation-status-sweep';
import { runIdempotencyCleanup } from './jobs/idempotency-cleanup';
import { rebalanceWalletA } from './wallet-a';

/**
 * The money jobs and when they run, in West Africa Time. Each can be moved
 * with an environment variable holding a cron pattern (e.g.
 * CRON_DAILY_SWEEP="15 0 * * *"), or turned off with "off".
 *
 * Order after midnight WAT matters: status first, then the sweep (moves the
 * day's recovered principal B → A), then settlement and reconciliation of
 * the day that just closed.
 *
 * The same jobs can still be run by hand through /api/cron/* (CRON_SECRET).
 */
export interface ScheduledJob {
  name: string;
  envVar: string;
  defaultPattern: string;
  run: () => Promise<unknown>;
}

export const SCHEDULE_TIMEZONE = 'Africa/Lagos';

export const SCHEDULED_JOBS: ScheduledJob[] = [
  { name: 'obligation-status', envVar: 'CRON_OBLIGATION_STATUS', defaultPattern: '5 0 * * *', run: () => runObligationStatusSweep() },
  { name: 'daily-sweep', envVar: 'CRON_DAILY_SWEEP', defaultPattern: '15 0 * * *', run: () => runDailySweep() },
  { name: 'settlement', envVar: 'CRON_SETTLEMENT', defaultPattern: '30 0 * * *', run: () => runSettlement() },
  { name: 'reconciliation', envVar: 'CRON_RECONCILIATION', defaultPattern: '45 0 * * *', run: () => runReconciliation() },
  { name: 'monthly-reconciliation', envVar: 'CRON_MONTHLY_RECONCILIATION', defaultPattern: '0 2 1 * *', run: () => runMonthlyReconciliation() },
  { name: 'idempotency-cleanup', envVar: 'CRON_IDEMPOTENCY_CLEANUP', defaultPattern: '30 3 * * *', run: () => runIdempotencyCleanup() },
  // Keeps Wallet A's money spread over its sub-wallets as advances drain them unevenly.
  { name: 'wallet-a-rebalance', envVar: 'CRON_WALLET_A_REBALANCE', defaultPattern: '*/10 * * * *', run: () => rebalanceWalletA() },
];

/**
 * Registers (or updates) every schedule. Idempotent: every instance calls it
 * on start-up and BullMQ keeps one scheduler per job name.
 */
export async function registerSchedules(): Promise<string[]> {
  const registered: string[] = [];
  for (const job of SCHEDULED_JOBS) {
    const pattern = process.env[job.envVar] ?? job.defaultPattern;
    if (pattern === 'off') {
      await scheduledJobsQueue.removeJobScheduler(job.name);
      continue;
    }
    await scheduledJobsQueue.upsertJobScheduler(job.name, { pattern, tz: SCHEDULE_TIMEZONE }, { name: job.name, data: {} });
    registered.push(`${job.name} (${pattern} ${SCHEDULE_TIMEZONE})`);
  }
  return registered;
}
