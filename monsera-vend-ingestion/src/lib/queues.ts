import { Queue } from 'bullmq';
import connection from './redis';

/**
 * Queues owned by monsera-vend-ingestion. BULLMQ_PREFIX keeps environments
 * that share one Redis apart (default 'bull').
 */
export const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

/** One job per meter per ingestion request; the worker recomputes from the DB. */
export const vendMetricsQueue = new Queue('vend-metrics', {
  connection,
  prefix: BULLMQ_PREFIX,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { count: 500 } },
});

/** The daily vend failure report (see lib/jobs/vend-failure-report.ts). */
export const vendScheduledQueue = new Queue('vend-scheduled', {
  connection,
  prefix: BULLMQ_PREFIX,
  defaultJobOptions: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
});
