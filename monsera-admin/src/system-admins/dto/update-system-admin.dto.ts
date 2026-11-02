import { IsEnum, IsObject, IsOptional } from 'class-validator';
import { AdminType } from '@prisma/client';

export class UpdateSystemAdminDto {
  @IsOptional()
  @IsEnum(AdminType)
  adminType?: AdminType;

  // replaces the whole permissions object (same as the old code)
  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;
}