import { Module } from '@nestjs/common';
import { FloatLedgerController } from './float-ledger.controller';
import { FloatLedgerService } from './float-ledger.service';

@Module({
  controllers: [FloatLedgerController],
  providers: [FloatLedgerService],
})
export class FloatLedgerModule {}