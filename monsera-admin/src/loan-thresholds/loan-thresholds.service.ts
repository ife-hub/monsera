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
import { CreateLoanThresholdDto } from './dto/create-loan-threshold.dto';
import { UpdateLoanThresholdDto } from './dto/update-loan-threshold.dto';

@Injectable()
export class LoanThresholdsService {
  private readonly logger = new Logger(LoanThresholdsService.name);

  constructor(private prisma: PrismaService) {}

  async list() {
    const data = await this.prisma.loan_Threshold.findMany({ orderBy: { id: 'asc' } });
    return { success: true, data };
  }

  async findOne(id: number) {
    const data = await this.prisma.loan_Threshold.findUnique({ where: { id } });
    if (!data) throw new NotFoundException({ success: false, message: 'Not found' });
    return { success: true, data };
  }

  async create(dto: CreateLoanThresholdDto, actor: JwtPayload) {
    this.assertRange(dto.minimum, dto.maximum);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.loan_Threshold.create({
          data: {
            minimum: new Prisma.Decimal(dto.minimum),
            maximum: new Prisma.Decimal(dto.maximum),
          },
        });
        await this.audit(tx, actor, `Created loan threshold ${row.id}`);
        return row;
      });
      return { success: true, data: created };
    } catch (error) {
      this.rethrow(error, 'Failed to create loan threshold');
    }
  }

  async update(id: number, dto: UpdateLoanThresholdDto, actor: JwtPayload) {
    const existing = await this.prisma.loan_Threshold.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ success: false, message: 'Not found' });

    // validate the resulting range, even when only one side is being changed
    this.assertRange(dto.minimum ?? Number(existing.minimum), dto.maximum ?? Number(existing.maximum));

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.loan_Threshold.update({
          where: { id },
          data: {
            ...(dto.minimum !== undefined && { minimum: new Prisma.Decimal(dto.minimum) }),
            ...(dto.maximum !== undefined && { maximum: new Prisma.Decimal(dto.maximum) }),
          },
        });
        await this.audit(tx, actor, `Updated loan threshold ${id}`);
        return row;
      });
      return { success: true, data: updated };
    } catch (error) {
      this.rethrow(error, 'Failed to update loan threshold');
    }
  }

  async remove(id: number, actor: JwtPayload) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.loan_Threshold.delete({ where: { id } });
        await this.audit(tx, actor, `Deleted loan threshold ${id}`);
      });
      return { success: true, message: 'Deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete loan threshold');
    }
  }

  // ---------- helpers ----------

  private assertRange(minimum: number, maximum: number) {
    if (minimum > maximum) {
      throw new BadRequestException({ success: false, message: 'Minimum cannot be greater than maximum' });
    }
  }

  private audit(tx: Prisma.TransactionClient, actor: JwtPayload, activity: string) {
    return tx.audit.create({
      data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundException({ success: false, message: 'Not found' });
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}