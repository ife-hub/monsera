import { PartialType } from '@nestjs/mapped-types';
import { CreateLoanThresholdDto } from './create-loan-threshold.dto';

export class UpdateLoanThresholdDto extends PartialType(CreateLoanThresholdDto) {}