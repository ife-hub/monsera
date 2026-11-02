import { Module } from '@nestjs/common';
import { SystemAdminsController } from './system-admins.controller';
import { SystemAdminsService } from './system-admins.service';

@Module({
  controllers: [SystemAdminsController],
  providers: [SystemAdminsService],
})
export class SystemAdminsModule {}