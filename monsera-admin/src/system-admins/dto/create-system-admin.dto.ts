import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsObject, IsOptional } from 'class-validator';
import { AdminType } from '@prisma/client';

export class CreateSystemAdminDto {
  @Type(() => Number)
  @IsInt()
  userId: number;

  @IsEnum(AdminType)
  adminType: AdminType;

  // free-form JSON, e.g. { canManageDiscos: true }
  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;
}