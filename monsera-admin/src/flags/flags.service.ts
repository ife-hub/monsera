import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/types/jwt-payload';

export const FLAG_KEYS = [
  'disbursements_enabled',
  'scoring_engine_enabled',
  'recovery_enabled',
  'maintenance_mode',
  'credit_enabled',
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

@Injectable()
export class FlagsService {
  constructor(private prisma: PrismaService) {}

  getAll() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async set(key: FlagKey, enabled: boolean, user: JwtPayload) {
    await this.prisma.$transaction([
      this.prisma.featureFlag.upsert({
        where: { key },
        update: { enabled, updatedBy: user.email },
        create: { key, enabled, updatedBy: user.email, description: `Auto-created flag for ${key}` },
      }),
      // Every flag change is audited: these are operational controls on a live financial system.
      this.prisma.audit.create({
        data: {
          userId: user.userId,
          employeeName: user.email,
          emailAddress: user.email,
          activity: `Feature flag '${key}' set to ${enabled} by ${user.email}`,
        },
      }),
    ]);
  }
}