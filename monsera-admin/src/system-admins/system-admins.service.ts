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
import { CreateSystemAdminDto } from './dto/create-system-admin.dto';
import { UpdateSystemAdminDto } from './dto/update-system-admin.dto';

const ADMIN_INCLUDE = {
  user: { select: { id: true, email: true, name: true, userType: true, isActive: true } },
} satisfies Prisma.SystemAdminInclude;

@Injectable()
export class SystemAdminsService {
  private readonly logger = new Logger(SystemAdminsService.name);

  constructor(private prisma: PrismaService) {}

  async list() {
    const admins = await this.prisma.systemAdmin.findMany({
      include: ADMIN_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: admins };
  }

  async findOne(id: number) {
    const admin = await this.prisma.systemAdmin.findUnique({ where: { id }, include: ADMIN_INCLUDE });
    if (!admin) throw new NotFoundException({ success: false, message: 'SystemAdmin not found' });
    return { success: true, data: admin };
  }

  async create(dto: CreateSystemAdminDto, actor: JwtPayload) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException({ success: false, message: 'User not found' });

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const admin = await tx.systemAdmin.create({
          data: {
            userId: dto.userId,
            adminType: dto.adminType,
            permissions: (dto.permissions ?? {}) as Prisma.InputJsonObject,
          },
          include: ADMIN_INCLUDE,
        });
        await this.audit(tx, actor, `Created system admin for user ${user.email}`);
        return admin;
      });
      return { success: true, data: created };
    } catch (error) {
      this.rethrow(error, 'Failed to create system admin');
    }
  }

  async update(id: number, dto: UpdateSystemAdminDto, actor: JwtPayload) {
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const admin = await tx.systemAdmin.update({
          where: { id },
          data: {
            ...(dto.adminType !== undefined && { adminType: dto.adminType }),
            ...(dto.permissions !== undefined && { permissions: dto.permissions as Prisma.InputJsonObject }),
          },
          include: ADMIN_INCLUDE,
        });
        await this.audit(tx, actor, `Updated system admin ID ${id}`);
        return admin;
      });
      return { success: true, data: updated };
    } catch (error) {
      this.rethrow(error, 'Failed to update system admin');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.systemAdmin.delete({ where: { id } });
        await this.audit(tx, actor, `Deleted system admin ID ${id}`);
      });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete system admin');
    }
  }

  // ---------- helpers ----------

  private audit(tx: Prisma.TransactionClient, actor: JwtPayload, activity: string) {
    return tx.audit.create({
      data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      switch (error.code) {
        case 'P2002':
          throw new BadRequestException({ success: false, message: 'SystemAdmin already exists for this user' });
        case 'P2003':
          throw new BadRequestException({ success: false, message: 'User not found' });
        case 'P2025':
          throw new NotFoundException({ success: false, message: 'SystemAdmin not found' });
      }
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}