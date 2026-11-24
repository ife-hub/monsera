import { Queue } from 'bullmq';
import connection from './redis';
import { BULLMQ_PREFIX, addWithTimeout } from './queues';

/**
 * Events consumed by monsera-notifications. The contract (queue name and
 * payload shapes) must match monsera-notifications/src/events/event-types.ts.
 */
export const PAYMENT_EVENTS_QUEUE = 'payment-events';

export interface ObligationStatusChanged {
  obligationId: number;
  meterToken: string;
  discoAdminId: number;
  from: string;
  to: string;
  remainingKobo: number;
}

const eventsQueue = new Queue(PAYMENT_EVENTS_QUEUE, {
  connection,
  prefix: BULLMQ_PREFIX,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

/** Never throws: a notification problem must not fail the job that changed the status. */
export async function publishObligationStatusChanged(data: ObligationStatusChanged): Promise<void> {
  try {
    await addWithTimeout(eventsQueue, 'obligation.status_changed', {
      type: 'obligation.status_changed',
      data,
      occurredAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`Could not publish obligation.status_changed for obligation ${data.obligationId}: ${error.message}`);
  }
}
