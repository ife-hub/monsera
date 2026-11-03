import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { VendModule } from './vend/vend.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({ connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } }),
    PrismaModule,
    VendModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}