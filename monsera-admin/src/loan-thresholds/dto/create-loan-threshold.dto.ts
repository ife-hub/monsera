import { Type } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';

export class CreateLoanThresholdDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimum: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maximum: number;
}