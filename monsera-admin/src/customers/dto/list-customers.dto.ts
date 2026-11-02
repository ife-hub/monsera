import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

export class ListCustomersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  aggregatorId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  discoAdminId?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  riskLevel?: string;
}