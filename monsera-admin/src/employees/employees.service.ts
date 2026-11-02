import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

const EMPLOYEE_INCLUDE = {
  role: true,
  user: { select: { id: true, email: true, name: true, userType: true, isActive: true } },
} satisfies Prisma.EmployeeInclude;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(private prisma: PrismaService) {}

  async list() {
    const employees = await this.prisma.employee.findMany({
      include: EMPLOYEE_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return { success: true, data: employees };
  }

  async findOne(id: number) {
    const employee = await this.prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
    if (!employee) throw new NotFoundException({ success: false, message: 'Employee not found' });
    return { success: true, data: employee };
  }

  async create(dto: CreateEmployeeDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);

    try {
      const employee = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: dto.name,
            email: dto.emailAddress,
            passwordHash,
            userType: UserType.EMPLOYEE,
          },
        });

        return tx.employee.create({
          data: {
            userId: user.id,
            name: dto.name,
            emailAddress: dto.emailAddress,
            phoneNumber: dto.phoneNumber,
            gender: dto.gender,
            status: dto.status || 'active',
            roleId: dto.roleId,
          },
          include: EMPLOYEE_INCLUDE,
        });
      });

      return { success: true, data: employee };
    } catch (error) {
      this.rethrow(error, 'Failed to create employee');
    }
  }

  async update(id: number, dto: UpdateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ success: false, message: 'Employee not found' });

    const { password, ...fields } = dto;

    try {
      const employee = await this.prisma.$transaction(async (tx) => {
        await tx.employee.update({ where: { id }, data: fields });

        // Keep the linked user in sync
        if (existing.userId && (password || dto.emailAddress || dto.name)) {
          await tx.user.update({
            where: { id: existing.userId },
            data: {
              ...(dto.emailAddress && { email: dto.emailAddress }),
              ...(dto.name && { name: dto.name }),
              ...(password && { passwordHash: await bcrypt.hash(password, 10) }),
            },
          });
        }

        // Re-read so the response reflects the updated user too
        return tx.employee.findUniqueOrThrow({ where: { id }, include: EMPLOYEE_INCLUDE });
      });

      return { success: true, data: employee };
    } catch (error) {
      this.rethrow(error, 'Failed to update employee');
    }
  }

  async remove(id: number) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const employee = await tx.employee.delete({ where: { id } });
        if (employee.userId) {
          await tx.user.delete({ where: { id: employee.userId } });
        }
      });

      return { success: true, message: 'Employee deleted successfully' };
    } catch (error) {
      this.rethrow(error, 'Failed to delete employee');
    }
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new BadRequestException({ success: false, message: 'Email or phone number already exists' });
      }
      if (error.code === 'P2025') {
        throw new NotFoundException({ success: false, message: 'Employee not found' });
      }
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}