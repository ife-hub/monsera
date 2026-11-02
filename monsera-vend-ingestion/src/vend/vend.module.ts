import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VendController } from './vend.controller';
import { IngestService } from './ingest.service';
import { VendMetricsProcessor } from './vend-metrics.processor';
import { VendFailureReportService } from './vend-failure-report.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'vend-metrics' })],
  controllers: [VendController],
  providers: [IngestService, VendMetricsProcessor, VendFailureReportService],
})
export class VendModule {}