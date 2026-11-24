import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async send(to: string, text: string): Promise<void> {
    // No SMS provider is wired up yet. Replace this body with a call to your provider's send API.
    this.logger.warn(`SMS provider not configured. Would send to ${to}: ${text}`);
  }
}