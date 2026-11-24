import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MailService } from './mail/mail.service';
import { SmsService } from './sms/sms.service';
import { DigestService } from './digest/digest.service';
import { PaymentEventsProcessor } from './events/payment-events.processor';
import { PAYMENT_EVENTS_QUEUE } from './events/event-types';
import { InternalController } from './internal/internal.controller';
import { HealthController } from './health.controller';
import { BULLMQ_PREFIX, REDIS, createRedisConnection } from './redis.connection';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({ useFactory: () => ({ connection: createRedisConnection(), prefix: BULLMQ_PREFIX }) }),
    BullModule.registerQueue({ name: PAYMENT_EVENTS_QUEUE }),
  ],
  controllers: [InternalController, HealthController],
  providers: [MailService, SmsService, DigestService, PaymentEventsProcessor, { provide: REDIS, useFactory: createRedisConnection }],
})
export class AppModule {}
