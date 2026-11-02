import { Transform, Type } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateFloatLedgerDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  referenceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  currentFloatBalance?: number;
}