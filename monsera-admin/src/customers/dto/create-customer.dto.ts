import { TariffBand } from '@prisma/client/wasm';
import { ArrayUnique, IsArray, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  meterToken: string;

  @IsString()
  @IsNotEmpty()
  riskLevel: string;

  @IsNumber()
  outstanding: number;

  @IsString()
  @IsNotEmpty()
  status: string;

  @IsString()
  @IsNotEmpty()
  state: string;

  @IsOptional()
  @IsDateString()
  lastInteraction?: string;

  @IsOptional()
  @IsDateString()
  dateAdded?: string;

  @IsOptional()
  @IsEnum(TariffBand)
  band?: TariffBand; 

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  aggregatorIds?: number[];
}