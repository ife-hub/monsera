import { IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateAggregatorDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(500) logoUrl?: string;
  @IsOptional() @IsString() @MaxLength(50) status?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) outstanding?: number;
}