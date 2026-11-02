import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { sendFailureReport } from './delivery';

@Injectable()
export class VendFailureReportService {
  constructor(private prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run() {
    const discoAdmins = await this.prisma.discoAdmin.findMany({ select: { id: true, name: true, mail: true } });

    for (const disco of discoAdmins) {
      const unreported = await this.prisma.vendIngestionFailure.findMany({
        where: { discoAdminId: disco.id, reportedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (unreported.length === 0) continue;

      await sendFailureReport(
        disco,
        unreported.map((f) => ({
          id: f.id,
          partnerVendId: f.submittedPartnerVendId,
          reason: f.reason,
          createdAt: f.createdAt,
        })),
      );
      await this.prisma.vendIngestionFailure.updateMany({ where: { id: { in: unreported.map((f) => f.id) } }, data: { reportedAt: new Date() } });

      await this.prisma.audit.create({
        data: { employeeName: 'System', emailAddress: 'system@monsera.com', activity: `Vend failure report sent to ${disco.name}: ${unreported.length} failed vend(s) reported.` },
      });
    }
  }
}