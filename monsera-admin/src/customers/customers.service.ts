import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { ListCustomersDto } from './dto/list-customers.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

const PARTY_SELECT = { select: { id: true, name: true, mail: true, logoUrl: true } };

const LIST_INCLUDE = {
  customerAggregators: { where: { isActive: true }, include: { aggregator: PARTY_SELECT } },
  customerDiscoAdmins: { where: { isActive: true }, include: { discoAdmin: PARTY_SELECT } },
  transactions: {
    take: 5,
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      date: true,
      transactionId: true,
      amount: true,
      transactionType: true,
      transactionStatus: true,
      paymentStatus: true,
    },
  },
} satisfies Prisma.CustomerInclude;

const DETAIL_INCLUDE = {
  customerAggregators: { where: { isActive: true }, include: { aggregator: PARTY_SELECT } },
} satisfies Prisma.CustomerInclude;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(private prisma: PrismaService) {}

  async list(query: ListCustomersDto) {
    const where: Prisma.CustomerWhereInput = {
      ...(query.aggregatorId
        ? { customerAggregators: { some: { aggregatorId: query.aggregatorId, isActive: true } } }
        : {}),
      ...(query.discoAdminId
        ? { customerDiscoAdmins: { some: { discoAdminId: query.discoAdminId, isActive: true } } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
    };

    const customers = await this.prisma.customer.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: { dateAdded: 'desc' },
    });

    return { success: true, data: customers };
  }

  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException({ success: false, message: 'Customer not found' });
    return { success: true, data: customer };
  }

  async create(dto: CreateCustomerDto, actor: JwtPayload) {
    const aggregatorIds = dto.aggregatorIds ?? [];
    await this.assertAggregatorsExist(aggregatorIds);

    try {
      const created = await this.prisma.customer.create({
        data: {
          // create(): data
          meterToken: dto.meterToken,
          riskLevel: dto.riskLevel,
          outstanding: new Prisma.Decimal(dto.outstanding),
          status: dto.status,
          state: dto.state,
          lastInteraction: dto.lastInteraction ? new Date(dto.lastInteraction) : new Date(),
          dateAdded: dto.dateAdded ? new Date(dto.dateAdded) : new Date(),
          ...(aggregatorIds.length
            ? { customerAggregators: { create: aggregatorIds.map((aggregatorId) => ({ aggregatorId, isActive: true })) } }
            : {}),
            ...(dto.band && { band: dto.band }),
        },
        include: DETAIL_INCLUDE,
      });

      await this.audit(actor, {
        activity: `Created customer ${dto.meterToken}`,
        meterId: dto.meterToken,
        state: 'active',
        reason: 'Customer creation',
      });

      return { success: true, data: created };
    } catch (error) {
      this.rethrow(error, 'Failed to create customer');
    }
  }

  async update(id: number, dto: UpdateCustomerDto, actor: JwtPayload) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ success: false, message: 'Customer not found' });

    const aggregatorOps = this.buildAggregatorOps(dto);
    if (dto.aggregatorIds) await this.assertAggregatorsExist(dto.aggregatorIds);
    if (dto.addAggregatorIds?.length) await this.assertAggregatorsExist(dto.addAggregatorIds);

    try {
      const updated = await this.prisma.customer.update({
        where: { id },
        data: {
          lastInteraction: dto.lastInteraction ? new Date(dto.lastInteraction) : new Date(),
          ...(dto.meterToken !== undefined && { meterToken: dto.meterToken }),
          ...(dto.band !== undefined && { band: dto.band }),
          ...(dto.riskLevel !== undefined && { riskLevel: dto.riskLevel }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.state !== undefined && { state: dto.state }),
          ...(dto.outstanding !== undefined && { outstanding: new Prisma.Decimal(dto.outstanding) }),
          ...(dto.dateAdded !== undefined && { dateAdded: new Date(dto.dateAdded) }),
          ...(aggregatorOps && { customerAggregators: aggregatorOps }),
        },
        include: DETAIL_INCLUDE,
      });

      await this.audit(actor, {
        activity: `Updated customer ${existing.meterToken}`,
        meterId: existing.meterToken,
        state: updated.state,
        reason: 'Customer update',
      });

      return { success: true, data: updated };
    } catch (error) {
      this.rethrow(error, 'Failed to update customer');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      await this.prisma.customer.delete({ where: { id } });
      await this.audit(actor, { activity: `Deleted customer ID ${id}` });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete customer');
    }
  }

  // ---------- helpers ----------

  private buildAggregatorOps(dto: UpdateCustomerDto): Prisma.CustomerUpdateInput['customerAggregators'] | undefined {
    if (dto.aggregatorIds) {
      // Replace all associations
      return {
        deleteMany: {},
        create: dto.aggregatorIds.map((aggregatorId) => ({ aggregatorId, isActive: true })),
      };
    }

    const ops: NonNullable<Prisma.CustomerUpdateInput['customerAggregators']> = {};
    if (dto.removeAggregatorIds?.length) {
      ops.deleteMany = { aggregatorId: { in: dto.removeAggregatorIds } };
    }
    if (dto.addAggregatorIds?.length) {
      ops.create = dto.addAggregatorIds.map((aggregatorId) => ({ aggregatorId, isActive: true }));
    }
    return Object.keys(ops).length ? ops : undefined;
  }

  private async assertAggregatorsExist(ids: number[]) {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const found = await this.prisma.aggregator.count({ where: { id: { in: unique } } });
    if (found !== unique.length) {
      throw new BadRequestException({ success: false, message: 'One or more invalid aggregator IDs' });
    }
  }

  private audit(
    actor: JwtPayload,
    data: { activity: string; meterId?: string; state?: string; reason?: string },
  ) {
    return this.prisma.audit.create({
      data: {
        userId: actor.userId,
        employeeName: actor.email,
        emailAddress: actor.email,
        ...data,
      },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new BadRequestException({ success: false, message: 'Meter token already exists' });
      }
      if (error.code === 'P2025') {
        throw new NotFoundException({ success: false, message: 'Customer not found' });
      }
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}