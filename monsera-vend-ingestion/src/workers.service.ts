import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * Starts the vend-metrics worker and the daily failure-report schedule.
 * Set RUN_WORKERS=false on instances that should only serve HTTP.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkersService.name);
  private workers: { close(): Promise<void> }[] = [];

  async onApplicationBootstrap() {
    if (process.env.RUN_WORKERS === 'false') {
      this.logger.log('RUN_WORKERS=false: queue workers and schedules not started on this instance');
      return;
    }
    const { vendMetricsWorker, vendScheduledWorker } = await import('./lib/workers');
    this.workers = [vendMetricsWorker, vendScheduledWorker];
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
    await Promise.allSettled(this.workers.map((w) => w.close()));
    const { default: prisma } = await import('./lib/prisma');
    await prisma.$disconnect();
  }
}
