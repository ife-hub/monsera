// Shared event contract. Keep this file identical in monsera-payments and monsera-notifications.

export const PAYMENT_EVENTS_QUEUE = 'payment-events';

export interface ObligationStatusChanged {
  obligationId: number;
  meterToken: string;
  discoAdminId: number;
  from: string;
  to: string;
  remainingKobo: number;
}

export interface OpsAlert {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
}

export type PaymentEvent =
  | { type: 'obligation.status_changed'; data: ObligationStatusChanged }
  | { type: 'ops.alert'; data: OpsAlert };

// What the worker receives: the event plus a timestamp added when it is queued.
export type QueuedEvent = PaymentEvent & { occurredAt: string };