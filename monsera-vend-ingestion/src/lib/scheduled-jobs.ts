import { vendScheduledQueue } from './queues';

export const SCHEDULE_TIMEZONE = 'Africa/Lagos';

/**
 * Registers the daily vend failure report (03:00 WAT by default; set
 * CRON_VEND_FAILURE_REPORT to another cron pattern, or "off").
 */
export async function registerSchedules(): Promise<string[]> {
  const pattern = process.env.CRON_VEND_FAILURE_REPORT ?? '0 3 * * *';
  if (pattern === 'off') {
    await vendScheduledQueue.removeJobScheduler('vend-failure-report');
    return [];
  }
  await vendScheduledQueue.upsertJobScheduler('vend-failure-report', { pattern, tz: SCHEDULE_TIMEZONE }, { name: 'vend-failure-report', data: {} });
  return [`vend-failure-report (${pattern} ${SCHEDULE_TIMEZONE})`];
}
