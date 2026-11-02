import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IncomingVendDto } from './incoming-vend.dto';

export class BatchVendDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'vends must be a non-empty array' })
  @ArrayMaxSize(500, { message: 'Batch size exceeds maximum of 500 vends per request' })
  @ValidateNested({ each: true })
  @Type(() => IncomingVendDto)
  vends: IncomingVendDto[];
}