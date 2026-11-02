import { Module } from '@nestjs/common';
import { AdminTypesController } from './admin-types.controller';

@Module({ controllers: [AdminTypesController] })
export class AdminTypesModule {}