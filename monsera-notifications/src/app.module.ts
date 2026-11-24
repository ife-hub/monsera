import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MailService } from './mail/mail.service';
import { SmsService } from './sms/sms.service';
import { DigestService } from './digest/digest.service';
import { PaymentEventsProcessor } from './events/payment-events.processor';
import { PAYMENT_EVENTS_QUEUE } from './events/event-types';
import { InternalController } from './internal/internal.controller';
import { createRedisConnection } from './redis.connection';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({ useFactory: () => ({ connection: createRedisConnection() }) }),
    BullModule.registerQueue({ name: PAYMENT_EVENTS_QUEUE }),
  ],
  controllers: [InternalController],
  providers: [MailService, SmsService, DigestService, PaymentEventsProcessor],
})
export class AppModule {}