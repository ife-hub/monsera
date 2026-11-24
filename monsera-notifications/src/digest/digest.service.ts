import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { MailService } from '../mail/mail.service';
import { ObligationStatusChanged, PAYMENT_EVENTS_QUEUE } from '../events/event-types';
import { BULLMQ_PREFIX, REDIS } from '../redis.connection';

export const DIGEST_FLUSH_JOB = 'digest.flush';
const DIGEST_KEY = `${BULLMQ_PREFIX}:notifications:digest`;

/**
 * Batches obligation status changes into one email per window.
 *
 * Pending changes are kept in Redis, not in memory, so a restart or a second
 * instance loses or duplicates nothing. The first change in a window queues
 * one delayed flush job (later adds in the same window are no-ops); the flush takes everything pending atomically and puts it back if
 * the email fails, so BullMQ's retry sends it later.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly mail: MailService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(PAYMENT_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  async add(change: ObligationStatusChanged): Promise<void> {
    await this.redis.rpush(DIGEST_KEY, JSON.stringify(change));
    const windowMs = Number(process.env.DIGEST_WINDOW_SECONDS ?? '60') * 1000;
    await this.queue.add(
      DIGEST_FLUSH_JOB,
      {},
      // One flush per window: adds in the same window share the id (no-ops);
      // a change arriving while an earlier window's flush runs gets the next
      // window's job, so it is never left behind.
      { jobId: `digest-flush-${Math.floor(Date.now() / windowMs)}`, delay: windowMs, attempts: 5, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    );
  }

  async flush(): Promise<number> {
    const [[, raw]] = (await this.redis.multi().lrange(DIGEST_KEY, 0, -1).del(DIGEST_KEY).exec()) as [[Error | null, string[]], unknown];
    const batch: ObligationStatusChanged[] = (raw ?? []).map((line) => JSON.parse(line));
    if (batch.length === 0) return 0;

    const defaults = batch.filter((change) => change.to === 'Default').length;
    const subject = `[Monsera] ${batch.length} obligation(s) moved to Delayed/Default${defaults ? ` (${defaults} Default)` : ''}`;
    const lines = batch
      .slice(0, 50)
      .map((c) => `- meter ${c.meterToken}: ${c.from} -> ${c.to}, ₦${(c.remainingKobo / 100).toLocaleString('en-NG')} outstanding (obligation ${c.obligationId})`);
    const more = batch.length > 50 ? `\n...and ${batch.length - 50} more.` : '';

    try {
      await this.mail.sendToAlertRecipients(subject, `${lines.join('\n')}${more}`);
    } catch (error: any) {
      // Put them back (in order, ahead of anything newer) and let BullMQ retry.
      await this.redis.lpush(DIGEST_KEY, ...raw.slice().reverse());
      this.logger.error(`Digest email failed, ${batch.length} change(s) kept for retry: ${error.message}`);
      throw error;
    }
    return batch.length;
  }
}
