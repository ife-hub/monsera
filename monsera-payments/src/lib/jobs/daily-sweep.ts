import * as Sentry from '../monitoring';
import prisma from '../prisma';
import { adjustWallet, WALLET_A_ID, WALLET_B_ID } from '../wallets';
import { rebalanceWalletAQuietly } from '../wallet-a';
import { watDate } from '../wat';

const SYSTEM = { employeeName: 'System', emailAddress: 'system@monsera.com' };

/**
 * Spec Section 7.1 — moves principal only from Wallet B to Wallet A.
 * Must alert on failure — without the sweep, Wallet A drains and advances stop.
 *
 * Sweeps every recovery whose principal has not been swept yet (sweptAt is
 * null) and stamps them in the same transaction. That makes the job:
 *  - idempotent: running it twice never moves the same principal twice;
 *  - independent of when it runs: recoveries made after a mid-day run are
 *    picked up next time instead of being skipped forever, and server time
 *    zone no longer matters.
 */
export async function runDailySweep() {
  try {
    const walletAId = WALLET_A_ID();
    const walletBId = WALLET_B_ID();
    const runDate = watDate(new Date());

    const result = await prisma.$transaction(
      async (tx) => {
        // Lock Wallet B first so concurrent sweeps (and recoveries) serialise,
        // then read the unswept set under that lock.
        await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${walletBId} FOR UPDATE`;

        const pending = await tx.obligationRecovery.findMany({
          where: { sweptAt: null },
          select: { id: true, principalKobo: true, obligationId: true },
        });

        if (pending.length === 0) {
          return { sweptKobo: 0, obligationCount: 0, obligationIds: [] as number[] };
        }

        const totalPrincipalToSweepKobo = pending.reduce((sum, r) => sum + r.principalKobo, 0);
        const ids = pending.map((r) => r.id);

        const stamped = await tx.obligationRecovery.updateMany({
          where: { id: { in: ids }, sweptAt: null },
          data: { sweptAt: new Date() },
        });
        if (stamped.count !== ids.length) {
          throw new Error(`Sweep race: expected to stamp ${ids.length} recoveries, stamped ${stamped.count}`);
        }

        if (totalPrincipalToSweepKobo > 0) {
          const reference = `sweep-${runDate}-${ids[0]}-${ids[ids.length - 1]}`;
          await adjustWallet(
            tx,
            walletBId,
            -totalPrincipalToSweepKobo,
            'sweep',
            `Daily sweep out: ${totalPrincipalToSweepKobo} kobo principal to Wallet A (${ids.length} recoveries). Run: ${runDate}`,
            reference
          );
          await adjustWallet(
            tx,
            walletAId,
            totalPrincipalToSweepKobo,
            'sweep',
            `Daily sweep in: ${totalPrincipalToSweepKobo} kobo principal from Wallet B (${ids.length} recoveries). Run: ${runDate}`,
            reference
          );
        }

        // §7.1: log the obligations the movement relates to.
        const obligationIds = [...new Set(pending.map((r) => r.obligationId))].sort((a, b) => a - b);
        return { sweptKobo: totalPrincipalToSweepKobo, obligationCount: pending.length, obligationIds };
      },
      { timeout: 30000, maxWait: 10000 }
    );

    await prisma.audit.create({
      data: {
        ...SYSTEM,
        activity:
          result.obligationCount === 0
            ? `Daily sweep: no unswept recoveries (${runDate})`
            : `Daily sweep completed: ${result.sweptKobo} kobo principal moved from Wallet B to Wallet A. Recoveries covered: ${result.obligationCount}. Obligations: [${result.obligationIds.join(', ')}]. Run: ${runDate} WAT`,
      },
    });

    // The swept principal landed on Wallet A itself: spread it over the sub-wallets.
    if (result.sweptKobo > 0) await rebalanceWalletAQuietly();

    return result;
  } catch (error: any) {
    Sentry.captureException(error, { tags: { job: 'daily-sweep' } });

    await prisma.audit.create({
      data: {
        ...SYSTEM,
        activity: `CRITICAL ALERT: Daily sweep FAILED. Error: ${error.message}. Wallet A is not being replenished. Manual intervention required immediately.`,
      },
    });

    throw error;
  }
}
