import { Worker, Job } from 'bullmq';
import * as Sentry from './monitoring';
import connection from './redis';
import prisma from './prisma';
import { BULLMQ_PREFIX } from './queues';
import { SCHEDULED_JOBS } from './scheduled-jobs';

/**
 * Attaches error and failed event listeners to a worker.
 * Catches Upstash quota errors specifically and alerts via Sentry and audit log.
 */
function attachWorkerErrorHandlers(worker: Worker, workerName: string) {
  worker.on('error', async (error: Error) => {
    const isQuotaError =
      error.message.includes('quota') ||
      error.message.includes('QUOTA') ||
      error.message.includes('max_daily_commands') ||
      error.message.includes('ERR max');

    if (isQuotaError) {
      Sentry.captureException(error, {
        tags: { worker: workerName, type: 'upstash_quota_exceeded' },
        extra: { message: 'Upstash request quota exceeded. Upgrade the Upstash plan or wait for quota reset.' },
      });

      try {
        await prisma.audit.create({
          data: {
            employeeName: 'System',
            emailAddress: 'system@monsera.com',
            activity: `CRITICAL ALERT: Upstash quota exceeded. Worker '${workerName}' has stopped. Immediate action required.`,
          },
        });
      } catch (auditError) {
        Sentry.captureException(auditError, { tags: { worker: workerName, type: 'audit_write_failed_on_quota_error' } });
      }
    } else {
      Sentry.captureException(error, { tags: { worker: workerName } });
    }
  });

  worker.on('failed', (job: Job | undefined, error: Error) => {
    Sentry.captureException(error, { tags: { worker: workerName, jobId: job?.id } });
  });
}

// ── Recovery Worker ───────────────────────────────────────────────────────
// Triggered from the credit handler after a repayment has been processed.
// This is the ONE case where BullMQ still earns its place here: it's fired
// by unpredictable, real-time user traffic (repayments), and the caller
// (the aggregator/disco admin) shouldn't wait on an audit-log write that
// happens after their repayment has already committed.
//
// The actual repayment logic — FIFO application, Wallet B crediting,
// obligation status update — runs entirely inside the credit handler's own
// database transaction. This worker only logs the recovery event afterward.
export const recoveryWorker = new Worker(
  'recovery',
  async (job) => {
    try {
      const { customerId, meterToken, amountPaidKobo, remainingOutstandingKobo } = job.data;

      await prisma.audit.create({
        data: {
          employeeName: 'System',
          emailAddress: 'system@monsera.com',
          activity: `Recovery event logged: Customer ${customerId} (meterToken: ${meterToken}) paid ${amountPaidKobo} kobo. Remaining outstanding: ${remainingOutstandingKobo} kobo.`,
          meterId: meterToken,
        },
      });

      return { customerId, amountPaidKobo, remainingOutstandingKobo };
    } catch (error: any) {
      Sentry.captureException(error, { tags: { worker: 'recovery', jobId: job.id } });
      throw error;
    }
  },
  { connection, prefix: BULLMQ_PREFIX }
);
attachWorkerErrorHandlers(recoveryWorker, 'recovery');


// ── Scheduled money jobs ──────────────────────────────────────────────────
// One worker for the payments-scheduled queue. BullMQ's job schedulers put
// exactly one job on the queue per tick, whichever instance registered them,
// so a job runs once per schedule even with several payments instances.
// Concurrency 1: the jobs touch the same wallets and must not overlap.
export const scheduledJobsWorker = new Worker(
  'payments-scheduled',
  async (job) => {
    const definition = SCHEDULED_JOBS.find((d) => d.name === job.name);
    if (!definition) throw new Error(`Unknown scheduled job '${job.name}'`);
    return definition.run();
  },
  { connection, prefix: BULLMQ_PREFIX, concurrency: 1 }
);
attachWorkerErrorHandlers(scheduledJobsWorker, 'payments-scheduled');
