import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import type { Redis } from 'ioredis';
import { DigestService, DIGEST_FLUSH_JOB } from '../digest/digest.service';
import { BULLMQ_PREFIX, REDIS } from '../redis.connection';
import { OpsAlert, PAYMENT_EVENTS_QUEUE, QueuedEvent } from './event-types';

@Processor(PAYMENT_EVENTS_QUEUE)
export class PaymentEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentEventsProcessor.name);

  constructor(
    private mail: MailService,
    private sms: SmsService,
    private digest: DigestService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  // Throwing makes BullMQ retry the job (5 attempts, exponential backoff).
  async process(job: Job<QueuedEvent>): Promise<void> {
    if (job.name === DIGEST_FLUSH_JOB) {
      await this.digest.flush();
      return;
    }
    const event = job.data;

    switch (event.type) {
      case 'obligation.status_changed':
        if (event.data.to === 'Delayed' || event.data.to === 'Default') await this.digest.add(event.data);
        return;
      case 'ops.alert':
        await this.alert(event.data, event.occurredAt);
        return;
      default:
        return; // events nothing here acts on yet
    }
  }

  private async alert(alert: OpsAlert, occurredAt: string): Promise<void> {
    // A condition that stays true (such as low balance) would otherwise email
    // on every request. The cooldown lives in Redis so it holds across
    // restarts and instances; it is claimed before sending and released if
    // the email fails, so the retry can send it.
    const cooldownMs = Number(process.env.ALERT_COOLDOWN_MINUTES ?? '360') * 60_000;
    const key = `${BULLMQ_PREFIX}:notifications:alert-cooldown:${alert.title}`;
    const claimed = await this.redis.set(key, occurredAt, 'PX', cooldownMs, 'NX');
    if (claimed !== 'OK') return;

    try {
      await this.mail.sendToAlertRecipients(`[Monsera][${alert.severity}] ${alert.title}`, `${alert.message}\n\nTime: ${occurredAt}`);
    } catch (error) {
      await this.redis.del(key);
      throw error;
    }

    if (alert.severity === 'critical') {
      const phones = (process.env.ALERT_PHONE_NUMBERS ?? '')
        .split(',')
        .map((phone) => phone.trim())
        .filter(Boolean);
      for (const phone of phones) {
        try {
          await this.sms.send(phone, `[Monsera] ${alert.title}`);
        } catch (error: any) {
          // The email went out; a failed SMS must not resend it on retry.
          this.logger.error(`SMS to ${phone} failed: ${error.message}`);
        }
      }
    }
  }
}
