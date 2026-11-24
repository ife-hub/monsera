import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventsService } from './events.service';
import { PAYMENT_EVENTS_QUEUE } from './event-types';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: PAYMENT_EVENTS_QUEUE })],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}