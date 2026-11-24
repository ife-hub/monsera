import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { WorkersService } from './workers.service';

/**
 * monsera-payments: disbursement (debit), recovery (credit), wallets,
 * transactions, credit/recovery-window configuration, cohort, clock
 * suspensions, and the scheduled money jobs. Its HTTP API is mounted from
 * src/routes.ts (see route-adapter.ts).
 */
@Module({
  controllers: [HealthController],
  providers: [WorkersService],
})
export class AppModule {}
