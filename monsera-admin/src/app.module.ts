import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { MetersModule } from './meters/meters.module';
import { FlagsModule } from './flags/flags.module';
import { AggregatorsModule } from './aggregators/aggregators.module';
import { AuditsModule } from './audits/audits.module';
import { AdminTypesModule } from './admin-types/admin-types.module';
import { CustomersModule } from './customers/customers.module';
import { DiscosModule } from './discos/discos.module';
import { EmployeesModule } from './employees/employees.module';
import { FinanceHousesModule } from './finance-houses/finance-houses.module';
import { FloatLedgerModule } from './float-ledger/float-ledger.module';
import { LoanThresholdsModule } from './loan-thresholds/loan-thresholds.module';
import { RolesModule } from './roles/roles.module';
import { SystemAdminsModule } from './system-admins/system-admins.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MetersModule,
    FlagsModule,
    AggregatorsModule,
    AuditsModule,
    AdminTypesModule,
    CustomersModule,
    DiscosModule,
    EmployeesModule,
    FinanceHousesModule,
    FloatLedgerModule,
    LoanThresholdsModule,
    RolesModule,
    SystemAdminsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}