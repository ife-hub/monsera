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
import { CreateRoleDto, PERMISSION_KEYS, PermissionKey } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

const ROLE_INCLUDE = {
  employees: { select: { id: true, userId: true } },
} satisfies Prisma.RoleInclude;

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private prisma: PrismaService) {}

  async list() {
    const roles = await this.prisma.role.findMany({
      include: ROLE_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return { success: true, data: roles };
  }

  async findOne(id: number) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
    if (!role) throw new NotFoundException({ success: false, message: 'Role not found' });
    return { success: true, data: role };
  }

  async create(dto: CreateRoleDto, actor: JwtPayload) {
    // every permission defaults to false unless explicitly granted
    const permissions = Object.fromEntries(
      PERMISSION_KEYS.map((key) => [key, dto[key] ?? false]),
    ) as Record<PermissionKey, boolean>;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({
          data: { name: dto.name, description: dto.description, ...permissions },
        });
        await this.audit(tx, actor, `Created role ${role.name}`);
        return role;
      });
      return { success: true, data: created };
    } catch (error) {
      this.rethrow(error, 'Failed to create role');
    }
  }

  async update(id: number, dto: UpdateRoleDto, actor: JwtPayload) {
    // only the permissions that were actually sent are changed
    const permissions = Object.fromEntries(
      PERMISSION_KEYS.filter((key) => dto[key] !== undefined).map((key) => [key, dto[key]]),
    ) as Partial<Record<PermissionKey, boolean>>;

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...permissions,
          },
        });
        await this.audit(tx, actor, `Updated role ${role.name}`);
        return role;
      });
      return { success: true, data: updated };
    } catch (error) {
      this.rethrow(error, 'Failed to update role');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.delete({ where: { id } });
        await this.audit(tx, actor, `Deleted role ID ${id}`);
      });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete role');
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
          throw new BadRequestException({ success: false, message: 'Role name already exists' });
        case 'P2003':
          throw new BadRequestException({
            success: false,
            message: 'Role is still assigned to employees. Reassign them first',
          });
        case 'P2025':
          throw new NotFoundException({ success: false, message: 'Role not found' });
      }
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}