import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { UpdateFinanceHouseDto } from './dto/update-finance-house.dto';

const SAFE_USER = { select: { id: true, email: true, name: true, userType: true, isActive: true } };

@Injectable()
export class FinanceHousesService {
  private readonly logger = new Logger(FinanceHousesService.name);

  constructor(private prisma: PrismaService) {}

  async findOne(id: number) {
    const financeHouse = await this.prisma.financeHouse.findUnique({
      where: { id },
      include: { user: SAFE_USER },
    });
    if (!financeHouse) throw new NotFoundException({ success: false, message: 'Finance house not found' });
    return { success: true, data: financeHouse };
  }

  async update(id: number, dto: UpdateFinanceHouseDto, actor: JwtPayload) {
    const existing = await this.prisma.financeHouse.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ success: false, message: 'Finance house not found' });

    // A finance house user may only edit their own record, and not its status/outstanding
    if (actor.userType === UserType.FINANCE_HOUSE) {
      if (existing.userId !== actor.userId) {
        throw new ForbiddenException({ success: false, message: 'You can only update your own finance house' });
      }
      if (dto.status !== undefined || dto.outstanding !== undefined) {
        throw new ForbiddenException({ success: false, message: 'Not allowed to change status or outstanding' });
      }
    }

    try {
      const financeHouse = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.financeHouse.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.email !== undefined && { mail: dto.email }),
            ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
            ...(dto.status !== undefined && { status: dto.status }),
            ...(dto.outstanding !== undefined && { outstanding: new Prisma.Decimal(dto.outstanding) }),
          },
        });

        if (updated.userId && (dto.name !== undefined || dto.email !== undefined)) {
          await tx.user.update({
            where: { id: updated.userId },
            data: {
              ...(dto.name !== undefined && { name: dto.name }),
              ...(dto.email !== undefined && { email: dto.email }),
            },
          });
        }

        return updated;
      });

      await this.audit(actor, `Updated finance house ID ${id}`);
      return { success: true, data: financeHouse };
    } catch (error) {
      this.rethrow(error, 'Failed to update finance house');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      const financeHouse = await this.prisma.financeHouse.delete({ where: { id } });
      await this.audit(actor, `Deleted finance house ID ${id}`);
      return { success: true, message: 'Deleted successfully', data: financeHouse };
    } catch (error) {
      this.rethrow(error, 'Failed to delete finance house');
    }
  }

  private audit(actor: JwtPayload, activity: string) {
    return this.prisma.audit.create({
      data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new BadRequestException({ success: false, message: 'Email already exists' });
      if (error.code === 'P2025') throw new NotFoundException({ success: false, message: 'Finance house not found' });
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}