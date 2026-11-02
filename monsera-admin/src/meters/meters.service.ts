import { Injectable, NotFoundException } from '@nestjs/common';
import { ObligationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListMetersDto } from './dto/list-meters.dto';

const OPEN_STATUSES: ObligationStatus[] = ['Current', 'Watch', 'Delayed', 'Default'];

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

@Injectable()
export class MetersService {
  constructor(private prisma: PrismaService) {}

  async list(query: ListMetersDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;

    const where: Prisma.CustomerVendMetricsWhereInput = {
      ...(query.q ? { meterToken: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.tariffBand ? { tariffBand: query.tariffBand } : {}),
      ...(query.meterStatus ? { meterStatus: { equals: query.meterStatus, mode: 'insensitive' } } : {}),
      ...(query.district ? { district: { equals: query.district, mode: 'insensitive' } } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customerVendMetrics.count({ where }),
      this.prisma.customerVendMetrics.findMany({
        where,
        orderBy: { meterToken: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          meterToken: true,
          meterStatus: true,
          tariffBand: true,
          tariffClass: true,
          customerType: true,
          district: true,
          totalVends: true,
          vendCountLast60Days: true,
          daysSinceLastVend: true,
          failedVendRatio: true,
          featureAsOfDate: true,
        },
      }),
    ]);

    return {
      success: true,
      data: {
        items: rows.map((r) => ({ ...r, failedVendRatio: toNumber(r.failedVendRatio) })),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(meterToken: string) {
    const [customer, metrics, latestState, openObligations] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { meterToken },
        include: {
          customerDiscoAdmins: { where: { isActive: true }, include: { discoAdmin: { select: { id: true, name: true } } } },
          customerAggregators: { where: { isActive: true }, include: { aggregator: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.customerVendMetrics.findUnique({ where: { meterToken } }),
      this.prisma.meter_State.findFirst({ where: { meterToken }, orderBy: { date: 'desc' } }),
      this.prisma.obligation.findMany({
        where: { meterToken, status: { in: OPEN_STATUSES }, remainingKobo: { gt: 0 } },
        orderBy: { disbursementDate: 'asc' },
        select: {
          id: true,
          status: true,
          band: true,
          obligationKobo: true,
          disbursedKobo: true,
          serviceKobo: true,
          remainingKobo: true,
          disbursementDate: true,
          expectedRecoveryDate: true,
          watchDate: true,
          delayedDate: true,
          defaultDate: true,
          clockSuspended: true,
          suspendedDays: true,
        },
      }),
    ]);

    if (!customer && !metrics) {
      throw new NotFoundException({ success: false, message: 'Meter not found', meterToken });
    }

    return {
      success: true,
      data: {
        meterToken,
        customer: customer
          ? {
              id: customer.id,
              band: customer.band,
              riskLevel: customer.riskLevel,
              status: customer.status,
              state: customer.state,
              outstanding: toNumber(customer.outstanding),
              dateAdded: customer.dateAdded,
              lastInteraction: customer.lastInteraction,
            }
          : null,
        vendMetrics: metrics
          ? {
              meterStatus: metrics.meterStatus,
              tariffBand: metrics.tariffBand,
              tariffClass: metrics.tariffClass,
              customerType: metrics.customerType,
              district: metrics.district,
              hasTransactions: metrics.hasTransactions,
              totalVends: metrics.totalVends,
              vendCountLast60Days: metrics.vendCountLast60Days,
              vendCountLast365Days: metrics.vendCountLast365Days,
              daysSinceLastVend: metrics.daysSinceLastVend,
              medianVendAmountNaira: toNumber(metrics.medianVendAmountNaira),
              vendAmountVolatility: toNumber(metrics.vendAmountVolatility),
              interVendVarianceDays: toNumber(metrics.interVendVarianceDays),
              failedVendRatio: toNumber(metrics.failedVendRatio),
              featureAsOfDate: metrics.featureAsOfDate,
              featureDefinitionVersion: metrics.featureDefinitionVersion,
            }
          : null,
        meterState: latestState ? { state: latestState.state, date: latestState.date } : null,
        openObligations,
        discos: customer?.customerDiscoAdmins.map((l) => ({ id: l.discoAdmin.id, name: l.discoAdmin.name })) ?? [],
        aggregators: customer?.customerAggregators.map((l) => ({ id: l.aggregator.id, name: l.aggregator.name })) ?? [],
      },
    };
  }
}