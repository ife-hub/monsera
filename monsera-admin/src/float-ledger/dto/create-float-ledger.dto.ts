import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateFloatLedgerDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  referenceId: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  // When present, this is an allocation to a disco (MONSERA_ADMIN only).
  // NOTE: this is the disco's USER id, not the DiscoAdmin row id (matches the old behavior).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  discoAdminId?: number;
}