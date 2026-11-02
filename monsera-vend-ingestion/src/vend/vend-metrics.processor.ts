import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { computeVendMetrics, METRICS_WINDOW_DAYS } from './metrics';

@Processor('vend-metrics')
export class VendMetricsProcessor extends WorkerHost {
  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { meterToken } = job.data;
    const windowStart = new Date(Date.now() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const vends = await this.prisma.vendRecord.findMany({
      where: { meterToken, vendedAt: { gte: windowStart } },
      select: { id: true, amountKobo: true, vendedAt: true, vendStatus: true, processingStatus: true },
    });
    const metrics = computeVendMetrics(vends as any);

    const totalVends = await this.prisma.vendRecord.count({ where: { meterToken, vendStatus: 'SUCCESSFUL' } });
    const customer = await this.prisma.customer.findUnique({ where: { meterToken }, select: { status: true } });

    const featureAsOfDate = new Date();
    featureAsOfDate.setUTCHours(0, 0, 0, 0);

    const { Prisma } = await import('@prisma/client');
    const data = {
      meterStatus: customer?.status ?? 'Unknown',
      totalVends,
      vendCountLast60Days: metrics.vendCountLast60Days,
      daysSinceLastVend: metrics.daysSinceLastVend,
      medianVendAmountNaira: new Prisma.Decimal(metrics.medianVendAmountKobo / 100),
      vendAmountVolatility: new Prisma.Decimal(metrics.vendAmountVolatility),
      interVendVarianceDays: new Prisma.Decimal(metrics.interVendVarianceDays),
      failedVendRatio: new Prisma.Decimal(metrics.failedVendRatio),
      featureAsOfDate,
      featureDefinitionVersion: 'aple_live_v2',
    };

    await this.prisma.customerVendMetrics.upsert({ where: { meterToken }, create: { meterToken, ...data }, update: data });

    const pendingIds = vends.filter((v) => v.processingStatus === 'Pending').map((v) => v.id);
    if (pendingIds.length > 0) {
      await this.prisma.vendRecord.updateMany({ where: { id: { in: pendingIds } }, data: { processingStatus: 'Processed' } });
    }

    return { meterToken, totalVends, ...metrics };
  }
}