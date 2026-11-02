import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';
import { CreateDiscoDto } from './dto/create-disco.dto';

const SAFE_USER = { select: { id: true, email: true, name: true, userType: true, isActive: true } };

function generateApiKey(): string {
  const random = crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .substring(0, 48);
  return `api_${random}`;
}

@Injectable()
export class DiscosService {
  private readonly logger = new Logger(DiscosService.name);

  constructor(private prisma: PrismaService) {}

  async list() {
    const discos = await this.prisma.discoAdmin.findMany({ include: { user: SAFE_USER } });
    // never expose API keys in the shared list
    const data = discos.map(({ apiKey, ...rest }) => rest);
    return { success: true, data };
  }

  async create(dto: CreateDiscoDto, actor: JwtPayload) {
    const passwordHash = await bcrypt.hash(dto.password, 10);

    try {
      const disco = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: dto.name,
            email: dto.email,
            passwordHash,
            userType: UserType.DISCO_ADMIN,
            isActive: true,
          },
        });

        return tx.discoAdmin.create({
          data: {
            userId: user.id,
            name: dto.name,
            mail: dto.email,
            lastInteraction: new Date(),
            status: 'active',
            logoUrl: dto.logoUrl,
          },
        });
      });

      await this.audit(actor, `Created disco admin ${dto.name}`);

      const { apiKey, ...data } = disco;
      return { success: true, data };
    } catch (error) {
      this.rethrow(error, 'Failed to create disco admin');
    }
  }

  async getMyApiKey(actor: JwtPayload) {
    const disco = await this.prisma.discoAdmin.findUnique({
      where: { userId: actor.userId },
      select: { id: true, name: true, apiKey: true },
    });
    if (!disco) throw new NotFoundException({ success: false, message: 'Disco admin not found' });

    await this.audit(actor, `Fetched API key for disco admin: ${disco.name}`);

    return {
      success: true,
      message: 'API key fetched successfully',
      data: { apiKey: disco.apiKey, discoAdminName: disco.name },
    };
  }

  async regenerateMyApiKey(actor: JwtPayload) {
    const disco = await this.prisma.discoAdmin.findUnique({ where: { userId: actor.userId } });
    if (!disco) throw new NotFoundException({ success: false, message: 'Disco admin not found' });

    const newApiKey = generateApiKey();
    await this.prisma.discoAdmin.update({ where: { id: disco.id }, data: { apiKey: newApiKey } });

    await this.audit(actor, `Regenerated API key for disco admin: ${disco.name}`);

    return {
      success: true,
      message: 'API key regenerated successfully',
      data: { apiKey: newApiKey },
    };
  }

  // ---------- helpers ----------

  private audit(actor: JwtPayload, activity: string) {
    return this.prisma.audit.create({
      data: { userId: actor.userId, employeeName: actor.email, emailAddress: actor.email, activity },
    });
  }

  private rethrow(error: unknown, fallbackMessage: string): never {
    if (error instanceof HttpException) throw error;

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new BadRequestException({ success: false, message: 'Email already exists' });
    }

    this.logger.error(fallbackMessage, error instanceof Error ? error.stack : String(error));
    throw new InternalServerErrorException({ success: false, message: fallbackMessage });
  }
}