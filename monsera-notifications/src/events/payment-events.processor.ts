import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { DigestService } from '../digest/digest.service';
import { OpsAlert, PAYMENT_EVENTS_QUEUE, QueuedEvent } from './event-types';

@Processor(PAYMENT_EVENTS_QUEUE)
export class PaymentEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentEventsProcessor.name);
  private readonly lastAlertAt = new Map<string, number>();

  constructor(
    private mail: MailService,
    private sms: SmsService,
    private digest: DigestService,
  ) {
    super();
  }

  // Throwing makes BullMQ retry the job (5 attempts, exponential backoff).
  async process(job: Job<QueuedEvent>): Promise<void> {
    const event = job.data;

    switch (event.type) {
      case 'obligation.status_changed':
        if (event.data.to === 'Delayed' || event.data.to === 'Default') this.digest.add(event.data);
        return;
      case 'ops.alert':
        await this.alert(event.data, event.occurredAt);
        return;
      default:
        return; // events nothing here acts on yet
    }
  }

  private async alert(alert: OpsAlert, occurredAt: string): Promise<void> {
    // A condition that stays true (such as low balance) would otherwise email on every request.
    const cooldownMs = Number(process.env.ALERT_COOLDOWN_MINUTES ?? '360') * 60_000;
    const last = this.lastAlertAt.get(alert.title) ?? 0;
    if (Date.now() - last < cooldownMs) return;

    await this.mail.sendToAlertRecipients(
      `[Monsera][${alert.severity}] ${alert.title}`,
      `${alert.message}\n\nTime: ${occurredAt}`,
    );
    this.lastAlertAt.set(alert.title, Date.now()); // only after the email succeeded

    if (alert.severity === 'critical') {
      const phones = (process.env.ALERT_PHONE_NUMBERS ?? '')
        .split(',')
        .map((phone) => phone.trim())
        .filter(Boolean);
      for (const phone of phones) await this.sms.send(phone, `[Monsera] ${alert.title}`);
    }
  }
}