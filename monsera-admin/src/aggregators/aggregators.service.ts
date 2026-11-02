import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { CreateAggregatorDto } from './dto/create-aggregator.dto';
import { UpdateAggregatorDto } from './dto/update-aggregator.dto';

// apiKey and the linked user's passwordHash are deliberately never selected here.
const AGGREGATOR_SELECT = {
  id: true,
  userId: true,
  name: true,
  mail: true,
  logoUrl: true,
  status: true,
  outstanding: true,
  balance: true,
  lastInteraction: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, email: true, name: true, userType: true, isActive: true } },
} satisfies Prisma.AggregatorSelect;

function generateApiKey(): string {
  const random = randomBytes(32).toString('base64').replace(/[+/=]/g, '').substring(0, 48);
  return `api_${random}`;
}

@Injectable()
export class AggregatorsService {
  constructor(private prisma: PrismaService) {}

  async list() {
    const data = await this.prisma.aggregator.findMany({ select: AGGREGATOR_SELECT, orderBy: { id: 'asc' } });
    return { success: true, data };
  }

  async findOne(id: number) {
    const data = await this.prisma.aggregator.findUnique({ where: { id }, select: AGGREGATOR_SELECT });
    if (!data) throw new NotFoundException({ success: false, message: 'Aggregator not found' });
    return { success: true, data };
  }

  async create(dto: CreateAggregatorDto, actor: JwtPayload) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    try {
      const data = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: dto.name, email: dto.email, passwordHash, userType: UserType.AGGREGATOR, isActive: true },
        });
        const aggregator = await tx.aggregator.create({
          data: {
            userId: user.id,
            name: dto.name,
            mail: dto.email,
            lastInteraction: new Date(),
            status: 'active',
            outstanding: 0,
            logoUrl: dto.logoUrl,
          },
          select: AGGREGATOR_SELECT,
        });
        await tx.audit.create({
          data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity: `Created aggregator ${dto.name}` },
        });
        return aggregator;
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequestException({ success: false, message: 'Email or name already exists' });
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateAggregatorDto, actor: JwtPayload) {
    try {
      const data = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.aggregator.update({
          where: { id },
          data: {
            ...(dto.name ? { name: dto.name } : {}),
            ...(dto.email ? { mail: dto.email } : {}),
            ...(dto.logoUrl ? { logoUrl: dto.logoUrl } : {}),
            ...(dto.status ? { status: dto.status } : {}),
            ...(dto.outstanding !== undefined ? { outstanding: dto.outstanding } : {}),
          },
          select: AGGREGATOR_SELECT,
        });

        if (updated.userId && (dto.name || dto.email)) {
          await tx.user.update({
            where: { id: updated.userId },
            data: { ...(dto.name ? { name: dto.name } : {}), ...(dto.email ? { email: dto.email } : {}) },
          });
        }

        await tx.audit.create({
          data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity: `Updated aggregator ID ${id}` },
        });
        return updated;
      });
      return { success: true, data };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025') throw new NotFoundException({ success: false, message: 'Aggregator not found' });
        if (error.code === 'P2002') throw new BadRequestException({ success: false, message: 'Email or name already exists' });
      }
      throw error;
    }
  }

  async remove(id: number, actor: JwtPayload) {
    const aggregator = await this.prisma.aggregator.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!aggregator) throw new NotFoundException({ success: false, message: 'Aggregator not found' });

    // Deleting would blank aggregatorId on past transactions and earnings, losing who they belong to.
    const [transactions, earnings] = await Promise.all([
      this.prisma.transactions.count({ where: { aggregatorId: id } }),
      this.prisma.monseraEarnings.count({ where: { aggregatorId: id } }),
    ]);
    if (transactions > 0 || earnings > 0) {
      throw new ConflictException({
        success: false,
        message: 'This aggregator has transaction history and cannot be deleted. Set its status to inactive instead.',
      });
    }

    await this.prisma.$transaction([
      this.prisma.aggregator.delete({ where: { id } }),
      this.prisma.audit.create({
        data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity: `Deleted aggregator ID ${id}` },
      }),
    ]);
    return { success: true, message: 'Deleted successfully', data: aggregator };
  }

  private async ownAggregator(user: JwtPayload) {
    const aggregator = await this.prisma.aggregator.findUnique({
      where: { userId: user.userId },
      select: { id: true, name: true, apiKey: true },
    });
    if (!aggregator) throw new NotFoundException({ success: false, message: 'Aggregator not found' });
    return aggregator;
  }

  async getApiKey(user: JwtPayload) {
    const aggregator = await this.ownAggregator(user);
    await this.prisma.audit.create({
      data: {
        userId: user.userId,
        employeeName: user.email,
        emailAddress: user.email,
        activity: `Fetched API key for aggregator: ${aggregator.name}`,
      },
    });
    return {
      success: true,
      message: 'API key fetched successfully',
      data: { apiKey: aggregator.apiKey, aggregatorName: aggregator.name },
    };
  }

  async regenerateApiKey(user: JwtPayload) {
    const aggregator = await this.ownAggregator(user);
    const newApiKey = generateApiKey();

    await this.prisma.$transaction([
      this.prisma.aggregator.update({ where: { id: aggregator.id }, data: { apiKey: newApiKey } }),
      this.prisma.audit.create({
        data: {
          userId: user.userId,
          employeeName: user.email,
          emailAddress: user.email,
          activity: `Regenerated API key for aggregator: ${aggregator.name}`,
        },
      }),
    ]);
    return { success: true, message: 'API key regenerated successfully', data: { apiKey: newApiKey } };
  }
}