import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { ListAuditsDto } from './dto/list-audits.dto';
import { CreateAuditDto } from './dto/create-audit.dto';

const SAFE_USER = { select: { id: true, email: true, name: true } };

@Injectable()
export class AuditsService {
  constructor(private prisma: PrismaService) {}

  async list(query: ListAuditsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const where: Prisma.AuditWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.employeeName ? { employeeName: { contains: query.employeeName, mode: 'insensitive' } } : {}),
      ...(query.state ? { state: query.state } : {}),
    };

    const [total, audits] = await this.prisma.$transaction([
      this.prisma.audit.count({ where }),
      this.prisma.audit.findMany({
        where,
        include: { user: SAFE_USER },
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { success: true, data: audits, meta: { page, limit, total } };
  }

  async create(dto: CreateAuditDto, actor: JwtPayload) {
    const isBlacklist = dto.action === 'blacklist';
    const audit = await this.prisma.audit.create({
      data: {
        userId: actor.userId,
        employeeName: actor.email,
        emailAddress: actor.email,
        activity: isBlacklist
          ? `Blacklisted meter no. ${dto.meterId}${dto.reason ? ` for ${dto.reason}` : ''}`
          : `Activated meter no ${dto.meterId}`,
        meterId: dto.meterId,
        state: isBlacklist ? 'inactive' : 'active',
        reason: isBlacklist ? dto.reason || 'Manual Action' : 'N/A',
        date: new Date(),
      },
    });
    return { success: true, data: audit };
  }

  async findOne(id: number) {
    const audit = await this.prisma.audit.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, name: true, userType: true, isActive: true } } },
    });
    if (!audit) throw new NotFoundException({ success: false, message: 'Audit record not found' });
    return { success: true, data: audit };
  }
}