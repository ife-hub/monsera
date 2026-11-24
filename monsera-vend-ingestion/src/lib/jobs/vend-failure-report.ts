import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { sendFailureReport, MAX_FAILURES_PER_REPORT } from '../vend/delivery';

const SYSTEM = { employeeName: 'System', emailAddress: 'system@monsera.com' };

/**
 * Daily: tell each disco which of the vends it pushed were rejected.
 * Failures are marked reported only after notifications accepted the report,
 * so a failed delivery is retried with the next run instead of being lost.
 * One disco's delivery failing does not stop the others.
 */
export async function runVendFailureReport() {
  const discoAdmins = await prisma.discoAdmin.findMany({ select: { id: true, name: true, mail: true } });
  const summaries: Array<{ discoAdminId: number; discoName: string; failureCount: number }> = [];
  const errors: string[] = [];

  for (const disco of discoAdmins) {
    const unreported = await prisma.vendIngestionFailure.findMany({
      where: { discoAdminId: disco.id, reportedAt: null },
      orderBy: { createdAt: 'asc' },
      take: MAX_FAILURES_PER_REPORT,
      select: { id: true, submittedPartnerVendId: true, reason: true, createdAt: true },
    });
    if (unreported.length === 0) continue;

    if (!disco.mail) {
      errors.push(`${disco.name}: no email address on file`);
      continue;
    }

    try {
      await sendFailureReport(disco, unreported);
    } catch (error: any) {
      Sentry.captureException(error, { tags: { job: 'vend-failure-report', discoAdminId: disco.id } });
      errors.push(`${disco.name}: ${error.message}`);
      continue;
    }

    await prisma.vendIngestionFailure.updateMany({
      where: { id: { in: unreported.map((f) => f.id) } },
      data: { reportedAt: new Date() },
    });
    await prisma.audit.create({
      data: { ...SYSTEM, activity: `Vend failure report sent to ${disco.name}: ${unreported.length} failed vend(s) reported.` },
    });
    summaries.push({ discoAdminId: disco.id, discoName: disco.name, failureCount: unreported.length });
  }

  return { discosReported: summaries.length, summaries, errors };
}
