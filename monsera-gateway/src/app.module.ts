import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

/** The proxy itself is Express middleware (src/proxy/proxy.ts), mounted in main.ts. */
@Module({ controllers: [HealthController] })
export class AppModule {}
