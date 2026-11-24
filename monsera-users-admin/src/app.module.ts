import { Module, OnApplicationShutdown } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import prisma from './lib/prisma';

/**
 * monsera-users-admin: sign-in (with Redis-backed throttling), the current
 * user, password changes (which revoke older tokens), user accounts and user
 * types. HTTP API mounted from src/routes.ts.
 */
@Module({
  controllers: [HealthController],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await prisma.$disconnect();
  }
}
