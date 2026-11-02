import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { CalculationService } from '../calculation/calculation.service';
import { ObligationStatusService } from '../obligation-status/obligation-status.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'recovery' })],
  controllers: [TransactionsController],
  providers: [TransactionsService, CalculationService, ObligationStatusService, IdempotencyService],
})
export class TransactionsModule {}