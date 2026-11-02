import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  emailAddress: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  gender: string;

  @Type(() => Number)
  @IsInt()
  roleId: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsString()
  @MinLength(8)
  password: string;
}