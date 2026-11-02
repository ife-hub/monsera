import { IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateFinanceHouseDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  // MONSERA_ADMIN only (enforced in the service)
  @IsOptional()
  @IsString()
  status?: string;

  // MONSERA_ADMIN only (enforced in the service)
  @IsOptional()
  @IsNumber()
  outstanding?: number;
}