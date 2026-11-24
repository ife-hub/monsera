import { Queue } from 'bullmq';
import connection from './redis';

/**
 * Queues owned by monsera-payments.
 *
 * BULLMQ_PREFIX keeps environments that share one Redis (e.g. staging on the
 * production Redis) from picking up each other's jobs. Default: 'bull'.
 */
export const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/** Post-repayment audit logging (see lib/workers.ts). */
export const recoveryQueue = new Queue('recovery', { connection, prefix: BULLMQ_PREFIX, defaultJobOptions });

/** Scheduled money jobs (sweep, settlement, reconciliation, ...); see lib/scheduled-jobs.ts. */
export const scheduledJobsQueue = new Queue('payments-scheduled', { connection, prefix: BULLMQ_PREFIX, defaultJobOptions });

/**
 * Adds a job without letting a Redis outage hang the caller. The shared
 * connection uses maxRetriesPerRequest: null (required by BullMQ workers), so
 * a plain add waits forever while Redis is down — after a repayment has
 * already committed, that would hang the partner's response.
 */
export async function addWithTimeout(queue: Queue, name: string, data: unknown, timeoutMs = Number(process.env.QUEUE_ADD_TIMEOUT_MS ?? 2000)) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      queue.add(name, data),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Queue '${queue.name}' did not accept the job within ${timeoutMs}ms (Redis unavailable?)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
