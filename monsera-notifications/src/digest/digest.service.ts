import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { ObligationStatusChanged } from '../events/event-types';

@Injectable()
export class DigestService implements OnModuleDestroy {
  private readonly logger = new Logger(DigestService.name);
  private buffer: ObligationStatusChanged[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private mail: MailService) {}

  add(change: ObligationStatusChanged): void {
    this.buffer.push(change);
    if (!this.timer) {
      const windowMs = Number(process.env.DIGEST_WINDOW_SECONDS ?? '60') * 1000;
      this.timer = setTimeout(() => void this.flush(), windowMs);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return;

    const defaults = batch.filter((change) => change.to === 'Default').length;
    const subject = `[Monsera] ${batch.length} obligation(s) moved to Delayed/Default${defaults ? ` (${defaults} Default)` : ''}`;
    const lines = batch
      .slice(0, 50)
      .map(
        (c) =>
          `- meter ${c.meterToken}: ${c.from} -> ${c.to}, ₦${(c.remainingKobo / 100).toLocaleString('en-NG')} outstanding (obligation ${c.obligationId})`,
      );
    const more = batch.length > 50 ? `\n...and ${batch.length - 50} more.` : '';

    try {
      await this.mail.sendToAlertRecipients(subject, `${lines.join('\n')}${more}`);
    } catch (error: any) {
      this.logger.error(`Digest email failed: ${error.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }
}