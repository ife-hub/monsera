import { Module } from '@nestjs/common';
import { FinanceHousesController } from './finance-houses.controller';
import { FinanceHousesService } from './finance-houses.service';

@Module({
  controllers: [FinanceHousesController],
  providers: [FinanceHousesService],
})
export class FinanceHousesModule {}