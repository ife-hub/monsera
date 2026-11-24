import { Module, OnApplicationShutdown } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import prisma from './lib/prisma';

/**
 * monsera-admin: partners (aggregators, discos, finance houses), customers,
 * employees, roles, system admins, audits, feature flags, loan thresholds,
 * meter state and the float ledger. HTTP API mounted from src/routes.ts.
 */
@Module({
  controllers: [HealthController],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await prisma.$disconnect();
  }
}
