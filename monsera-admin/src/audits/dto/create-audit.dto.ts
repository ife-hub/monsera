import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAuditDto {
  @IsString() @IsNotEmpty() @MaxLength(100) meterId: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsIn(['blacklist', 'activate'])
  action: 'blacklist' | 'activate';

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}