import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { controllingIdentity } from '../reconciliation';
import { previousWatDate, watDayBounds } from '../wat';

/**
 * Closes YESTERDAY's window — the WAT day that just ended at midnight WAT.
 * Formerly a BullMQ worker processor — now called directly from the
 * settlement cron route.
 */
export async function runSettlement() {
  try {
    // Spec §8.3: WAT boundaries (the same cut on both sides).
    const reportingDate = previousWatDate();
    const { start: startOfDay, end: endOfDay } = watDayBounds(reportingDate);

    // Spec §8.2: if the controlling identity does not hold, the settlement
    // job must alert rather than complete.
    const identity = await controllingIdentity();
    if (!identity.holds) {
      const message = `SETTLEMENT HALTED for ${reportingDate}: controlling identity breached by ${identity.discrepancyKobo} kobo (left ${identity.leftSideKobo}, right ${identity.rightSideKobo}).`;
      Sentry.captureException(new Error(message), { tags: { job: 'settlement', type: 'controlling_identity_breach' }, extra: { ...identity } });
      await prisma.audit.create({ data: { employeeName: 'System', emailAddress: 'system@monsera.com', activity: message } });
      throw new Error(message);
    }

    const debitsYesterday = await prisma.transactions.findMany({
      where: {
        transactionType: { equals: 'debit', mode: 'insensitive' },
        transactionStatus: { equals: 'successful', mode: 'insensitive' },
        date: { gte: startOfDay, lt: endOfDay },
      },
      select: { obligationKobo: true, disbursedKobo: true, serviceKobo: true, amount: true },
    });

    const totalObligationKobo = debitsYesterday.reduce(
      (sum, t) => sum + (t.obligationKobo ?? Math.round(Number(t.amount) * 100)), 0
    );
    const totalDisbursedKobo = debitsYesterday.reduce(
      (sum, t) => sum + (t.disbursedKobo ?? Math.round(Number(t.amount) * 100)), 0
    );
    const totalServiceAccruedKobo = debitsYesterday.reduce(
      (sum, t) => sum + (t.serviceKobo ?? 0), 0
    );

    const repaymentsYesterday = await prisma.transactions.findMany({
      where: {
        transactionType: { equals: 'repayment', mode: 'insensitive' },
        transactionStatus: { equals: 'successful', mode: 'insensitive' },
        date: { gte: startOfDay, lt: endOfDay },
      },
      select: { obligationKobo: true, disbursedKobo: true, serviceKobo: true, amount: true },
    });

    const totalRecoveredKobo = repaymentsYesterday.reduce(
      (sum, t) => sum + (t.obligationKobo ?? Math.round(Number(t.amount) * 100)), 0
    );
    const totalPrincipalRecoveredKobo = repaymentsYesterday.reduce(
      (sum, t) => sum + (t.disbursedKobo ?? 0), 0
    );
    const totalServiceRecoveredKobo = repaymentsYesterday.reduce(
      (sum, t) => sum + (t.serviceKobo ?? 0), 0
    );

    const feesYesterday = await prisma.monseraEarnings.findMany({
      where: { createdAt: { gte: startOfDay, lt: endOfDay } },
      select: { amount: true },
    });
    const totalFeesKobo = feesYesterday.reduce(
      (sum, f) => sum + Math.round(Number(f.amount) * 100), 0
    );

    const customers = await prisma.customer.findMany({ select: { outstanding: true } });
    const totalOutstandingKobo = customers.reduce(
      (sum, c) => sum + Math.round(Number(c.outstanding) * 100), 0
    );

    const expectedServiceKobo = totalObligationKobo - totalDisbursedKobo;
    const serviceDiscrepancyKobo = Math.abs(totalServiceAccruedKobo - expectedServiceKobo);

    if (serviceDiscrepancyKobo > 1) {
      const alertMessage = `Settlement service charge discrepancy for ${reportingDate}. Expected: ${expectedServiceKobo} kobo, Actual: ${totalServiceAccruedKobo} kobo, Difference: ${serviceDiscrepancyKobo} kobo. Netting calculation may be incorrect.`;

      Sentry.captureException(new Error(alertMessage), {
        tags: { job: 'settlement', type: 'service_charge_discrepancy' },
      });

      await prisma.audit.create({
        data: {
          employeeName: 'System',
          emailAddress: 'system@monsera.com',
          activity: `ALERT: ${alertMessage}`,
        },
      });
    }

    await prisma.audit.create({
      data: {
        employeeName: 'System',
        emailAddress: 'system@monsera.com',
        activity: `Daily settlement for ${reportingDate}: Obligations=${totalObligationKobo}k, Disbursed=${totalDisbursedKobo}k, ServiceAccrued=${totalServiceAccruedKobo}k, Recovered=${totalRecoveredKobo}k, PrincipalRecovered=${totalPrincipalRecoveredKobo}k, ServiceRecovered=${totalServiceRecoveredKobo}k, FeesEarned=${totalFeesKobo}k, TotalOutstanding=${totalOutstandingKobo}k`,
      },
    });

    return {
      reportingDate,
      totalObligationKobo,
      totalDisbursedKobo,
      totalServiceAccruedKobo,
      totalRecoveredKobo,
      totalPrincipalRecoveredKobo,
      totalServiceRecoveredKobo,
      totalFeesKobo,
      totalOutstandingKobo,
      serviceDiscrepancyKobo,
    };
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'settlement' } });
    throw error;
  }
}