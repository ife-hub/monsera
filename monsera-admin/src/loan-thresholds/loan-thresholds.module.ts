import { Module } from '@nestjs/common';
import { LoanThresholdsController } from './loan-thresholds.controller';
import { LoanThresholdsService } from './loan-thresholds.service';

@Module({
  controllers: [LoanThresholdsController],
  providers: [LoanThresholdsService],
})
export class LoanThresholdsModule {}