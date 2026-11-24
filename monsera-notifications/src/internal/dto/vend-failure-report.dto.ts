import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class FailureItemDto {
  @IsOptional() @IsString() @MaxLength(200) submittedPartnerVendId?: string | null;
  @IsString() @MaxLength(500) reason: string;
  @IsDateString() createdAt: string;
}

export class VendFailureReportDto {
  @IsString() @IsNotEmpty() @MaxLength(100) discoName: string;
  @IsEmail() discoEmail: string;
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => FailureItemDto) failures: FailureItemDto[];
}