import { Worker, Job } from 'bullmq';
import * as Sentry from './monitoring';
import connection from './redis';
import prisma from './prisma';
import { computeVendMetrics, METRICS_WINDOW_DAYS } from './vend/metrics';
import { BULLMQ_PREFIX } from './queues';
import { runVendFailureReport } from './jobs/vend-failure-report';
import { Prisma } from '@prisma/client';

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

// ── Vend metrics worker ─────────────────────────────────────────────────
export const vendMetricsWorker = new Worker(
  'vend-metrics',
  async (job) => {
    try {
      const { meterToken } = job.data;
      const windowStart = new Date(Date.now() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const vends = await prisma.vendRecord.findMany({
        where: { meterToken, vendedAt: { gte: windowStart } },
        select: { id: true, amountKobo: true, vendedAt: true, vendStatus: true, processingStatus: true },
      });

      const metrics = computeVendMetrics(vends);

      // All-time successful vend count — separate from the 60-day window above.
      const totalVends = await prisma.vendRecord.count({
        where: { meterToken, vendStatus: 'SUCCESSFUL' },
      });

      // ASSUMPTION: meterStatus is sourced from Customer.status, joined by
      // meterToken. If meter status should instead come from Meter_State
      // (which already exists in the schema for this purpose), this needs
      // a different lookup and a decision on which row counts as current.
      const customer = await prisma.customer.findUnique({
        where: { meterToken },
        select: { status: true },
      });
      const meterStatus = customer?.status ?? 'Unknown';

      const featureAsOfDate = new Date();
      featureAsOfDate.setUTCHours(0, 0, 0, 0);

      const data = {
        meterStatus,
        totalVends,
        vendCountLast60Days: metrics.vendCountLast60Days,
        daysSinceLastVend: metrics.daysSinceLastVend,
        medianVendAmountNaira: new Prisma.Decimal(metrics.medianVendAmountKobo / 100),
        vendAmountVolatility: new Prisma.Decimal(metrics.vendAmountVolatility),
        interVendVarianceDays: new Prisma.Decimal(metrics.interVendVarianceDays),
        failedVendRatio: new Prisma.Decimal(metrics.failedVendRatio),
        featureAsOfDate,
        featureDefinitionVersion: 'aple_live_v2',
      };

      await prisma.customerVendMetrics.upsert({
        where: { meterToken },
        create: { meterToken, ...data },
        update: data,
      });

      const pendingIds = vends.filter((v) => v.processingStatus === 'Pending').map((v) => v.id);
      if (pendingIds.length > 0) {
        await prisma.vendRecord.updateMany({
          where: { id: { in: pendingIds } },
          data: { processingStatus: 'Processed' },
        });
      }

      return { meterToken, totalVends, ...metrics };
    } catch (error: any) {
      Sentry.captureException(error, { tags: { worker: 'vend-metrics', jobId: job.id } });
      throw error;
    }
  },
  { connection, prefix: BULLMQ_PREFIX }
);
attachWorkerErrorHandlers(vendMetricsWorker, 'vend-metrics');
// ── Daily vend failure report ─────────────────────────────────────────────
// The scheduler puts one job per day on the queue, so the report is sent
// once even with several vend-ingestion instances.
export const vendScheduledWorker = new Worker(
  'vend-scheduled',
  async (job) => {
    if (job.name === 'vend-failure-report') return runVendFailureReport();
    throw new Error(`Unknown scheduled job '${job.name}'`);
  },
  { connection, prefix: BULLMQ_PREFIX, concurrency: 1 }
);
attachWorkerErrorHandlers(vendScheduledWorker, 'vend-scheduled');
