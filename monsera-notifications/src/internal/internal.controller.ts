import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { InternalKeyGuard } from './internal-key.guard';
import { VendFailureReportDto } from './dto/vend-failure-report.dto';

@Controller('notifications')
@UseGuards(InternalKeyGuard)
export class InternalController {
  constructor(private readonly mail: MailService) {}

  @Post('vend-failure-report')
  @HttpCode(200)
  async vendFailureReport(@Body() dto: VendFailureReportDto) {
    const shown = dto.failures.slice(0, 200);
    const lines = shown.map((f) => `- ${f.submittedPartnerVendId ?? '(no partnerVendId)'}: ${f.reason}`);
    const more = dto.failures.length > shown.length ? `\n...and ${dto.failures.length - shown.length} more.` : '';

    const text = [
      `Hello ${dto.discoName},`,
      '',
      `${dto.failures.length} vend record(s) you pushed to Monsera were rejected and not processed:`,
      '',
      ...lines,
      more,
      '',
      'Please correct and resend these. Records that were accepted are unaffected.',
    ].join('\n');

    await this.mail.send(dto.discoEmail, `[Monsera] ${dto.failures.length} rejected vend record(s)`, text);
    return { success: true, reported: dto.failures.length };
  }
}