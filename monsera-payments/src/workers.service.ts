import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * Starts the payments queue workers and registers the money-job schedules.
 * Set RUN_WORKERS=false on instances that should only serve HTTP.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkersService.name);
  private workers: { close(): Promise<void> }[] = [];
  private foldTimer: NodeJS.Timeout | null = null;
  private folding: Promise<unknown> | null = null;

  async onApplicationBootstrap() {
    // Wallet A's sub-wallets (lib/wallet-a.ts): create any missing, spread the money.
    try {
      const { ensureWalletASubWallets, rebalanceWalletA } = await import('./lib/wallet-a');
      const ids = await ensureWalletASubWallets();
      await rebalanceWalletA();
      if (ids.length) this.logger.log(`Wallet A rows: ${ids.join(', ')}`);
    } catch (error: any) {
      this.logger.error(`Could not prepare Wallet A sub-wallets: ${error.message}`);
    }

    if (process.env.RUN_WORKERS === 'false') {
      this.logger.log('RUN_WORKERS=false: queue workers, schedules and partner-total folding not started on this instance');
      return;
    }

    // Disco/aggregator running totals: add pending changes into the partner
    // rows every PARTNER_TOTALS_FOLD_MS (default 2s; lib/partner-totals.ts).
    // Runs on every worker instance; each fold claims its own rows.
    const { foldAllPartnerChanges } = await import('./lib/partner-totals');
    const everyMs = Math.max(250, Number(process.env.PARTNER_TOTALS_FOLD_MS ?? 2000));
    this.foldTimer = setInterval(() => {
      if (this.folding) return; // the previous fold is still running
      this.folding = foldAllPartnerChanges().finally(() => (this.folding = null));
    }, everyMs);

    const { recoveryWorker, scheduledJobsWorker } = await import('./lib/workers');
    this.workers = [recoveryWorker, scheduledJobsWorker];
    const { registerSchedules } = await import('./lib/scheduled-jobs');
    try {
      const schedules = await registerSchedules();
      this.logger.log(`Workers started; schedules: ${schedules.join(', ')}`);
    } catch (error: any) {
      // Redis down at start-up: the HTTP API still works; schedules register on the next start.
      this.logger.error(`Could not register job schedules: ${error.message}`);
    }
  }

  async onApplicationShutdown() {
    if (this.foldTimer) clearInterval(this.foldTimer);
    await this.folding;
    if (this.foldTimer) {
      // Leave nothing pending on a deploy.
      const { foldAllPartnerChanges } = await import('./lib/partner-totals');
      await foldAllPartnerChanges();
    }
    await Promise.allSettled(this.workers.map((w) => w.close()));
    const { default: prisma } = await import('./lib/prisma');
    await prisma.$disconnect();
  }
}
