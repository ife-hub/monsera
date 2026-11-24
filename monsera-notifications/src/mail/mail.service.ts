import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;

  constructor() {
    const port = Number(process.env.SMTP_PORT ?? 587);
    this.transporter = process.env.SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port,
          secure: port === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : null;
  }

  async send(to: string | string[], subject: string, text: string): Promise<void> {
    const recipients = Array.isArray(to) ? to : [to];
    if (!this.transporter) {
      // No SMTP configured (local development): log instead of sending.
      this.logger.warn(`SMTP not configured. Would email ${recipients.join(', ')}: ${subject}`);
      return;
    }
    await this.transporter.sendMail({ from: process.env.MAIL_FROM, to: recipients, subject, text });
  }

  async sendToAlertRecipients(subject: string, text: string): Promise<void> {
    const recipients = (process.env.ALERT_RECIPIENTS ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      this.logger.warn(`ALERT_RECIPIENTS is empty. Alert not sent: ${subject}`);
      return;
    }
    await this.send(recipients, subject, text);
  }
}