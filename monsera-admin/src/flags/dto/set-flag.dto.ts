import { IsBoolean, IsIn } from 'class-validator';
import { FLAG_KEYS } from '../flags.service';
import type { FlagKey } from '../flags.service';

export class SetFlagDto {
  @IsIn(FLAG_KEYS) key: FlagKey;
  @IsBoolean() enabled: boolean;
}