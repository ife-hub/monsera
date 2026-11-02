import { IsNotEmpty, IsNumber, IsPositive, IsOptional, IsString } from 'class-validator';

export class DebitDto {
  @IsString() @IsNotEmpty() meterToken: string;
  @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsString() disco?: string;
}