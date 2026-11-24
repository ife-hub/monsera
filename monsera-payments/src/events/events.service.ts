import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PAYMENT_EVENTS_QUEUE, PaymentEvent, QueuedEvent } from './event-types';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(@InjectQueue(PAYMENT_EVENTS_QUEUE) private readonly queue: Queue) {}

  /**
   * Fire and forget. It never throws and never delays the caller, so a Valkey
   * problem cannot affect a debit or a repayment. The second argument is kept
   * only so the call sites you already edited do not change.
   */
  publish(event: PaymentEvent, _key?: string): void {
    const payload: QueuedEvent = { ...event, occurredAt: new Date().toISOString() };

    // One alert per transition: a repeated add with the same id is ignored while the job exists.
    const jobId =
      event.type === 'obligation.status_changed'
        ? `obligation-${event.data.obligationId}-${event.data.to}`
        : undefined;

    void this.queue
      .add(event.type, payload, {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      })
      .catch((error) => this.logger.error(`Failed to queue ${event.type}: ${error.message}`));
  }
}