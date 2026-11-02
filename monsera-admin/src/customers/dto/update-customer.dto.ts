import { PartialType } from '@nestjs/mapped-types';
import { ArrayUnique, IsArray, IsInt, IsOptional } from 'class-validator';
import { CreateCustomerDto } from './create-customer.dto';

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  // `aggregatorIds` (inherited) replaces ALL associations.
  // add/remove are used only when `aggregatorIds` is not sent.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  addAggregatorIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  removeAggregatorIds?: number[];
}