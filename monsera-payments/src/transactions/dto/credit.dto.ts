import { IsNotEmpty, IsNumber, IsPositive, IsOptional, IsString, IsInt, ValidateIf } from 'class-validator';

export class CreditDto {
  @IsString() @IsNotEmpty() meterToken: string;
  @IsInt() @IsPositive() amountKobo: number;
  @ValidateIf((o) => o.disco !== undefined)
@IsString()
@IsNotEmpty()
disco?: string;
}