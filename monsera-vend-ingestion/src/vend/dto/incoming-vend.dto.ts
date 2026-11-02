import { IsIn, IsInt, IsISO8601, IsPositive, IsString, Matches, MaxLength } from 'class-validator';
import { VendType, VendStatus } from '@prisma/client';

export class IncomingVendDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,100}$/) partnerVendId: string;
  @IsString() @MaxLength(100) meterToken: string;
  @IsInt() @IsPositive() amountKobo: number;
  @IsIn(Object.values(VendType)) vendType: VendType;
  @IsIn(Object.values(VendStatus)) vendStatus: VendStatus;
  @IsISO8601() vendedAt: string;
}