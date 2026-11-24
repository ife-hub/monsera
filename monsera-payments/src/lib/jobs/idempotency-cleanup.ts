import * as Sentry from '../monitoring';
import prisma from '../prisma';

/**
 * Deletes expired IdempotencyRecord rows to prevent the table growing
 * indefinitely. Formerly a BullMQ worker processor — now called directly
 * from the idempotency-cleanup cron route.
 */
export async function runIdempotencyCleanup() {
  try {
    const deleted = await prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    await prisma.audit.create({
      data: {
        employeeName: 'System',
        emailAddress: 'system@monsera.com',
        activity: `Idempotency cleanup: ${deleted.count} expired records deleted.`,
      },
    });

    return { deleted: deleted.count };
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'idempotency-cleanup' } });
    throw error;
  }
}