import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TariffBand } from '@prisma/client';

export class ListMetersDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(TariffBand) tariffBand?: TariffBand;
  @IsOptional() @IsString() @MaxLength(50) meterStatus?: string;
  @IsOptional() @IsString() @MaxLength(100) district?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
}