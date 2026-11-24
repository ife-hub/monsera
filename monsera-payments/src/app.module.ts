import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { TransactionsModule } from './transactions/transactions.module';
import { RecoveryProcessor } from './queues/recovery.processor';
import { HealthController } from './health/health.controller';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL, // the DO Valkey URL, not Upstash
        maxRetriesPerRequest: null,
      },
    }),
    PrismaModule,
    TransactionsModule,
    EventsModule,
  ],
  providers: [RecoveryProcessor],
  controllers: [HealthController],
})
export class AppModule {}