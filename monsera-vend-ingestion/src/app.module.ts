import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { WorkersService } from './workers.service';

/**
 * monsera-vend-ingestion: vend records pushed by discos (single and batch),
 * the vend-metrics worker that turns them into scoring features, and the
 * daily vend failure report. HTTP API mounted from src/routes.ts.
 */
@Module({
  controllers: [HealthController],
  providers: [WorkersService],
})
export class AppModule {}
