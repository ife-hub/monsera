import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const PERMISSION_KEYS = [
  'canViewTransactions',
  'canManageTransactions',
  'canViewUsers',
  'canManageUsers',
  'canBlacklistUsers',
  'canActivateUsers',
  'canViewScoringEngine',
  'canEditThreshold',
  'canValidateLoans',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export class CreateRoleDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsOptional() @IsBoolean() canViewTransactions?: boolean;
  @IsOptional() @IsBoolean() canManageTransactions?: boolean;
  @IsOptional() @IsBoolean() canViewUsers?: boolean;
  @IsOptional() @IsBoolean() canManageUsers?: boolean;
  @IsOptional() @IsBoolean() canBlacklistUsers?: boolean;
  @IsOptional() @IsBoolean() canActivateUsers?: boolean;
  @IsOptional() @IsBoolean() canViewScoringEngine?: boolean;
  @IsOptional() @IsBoolean() canEditThreshold?: boolean;
  @IsOptional() @IsBoolean() canValidateLoans?: boolean;
}