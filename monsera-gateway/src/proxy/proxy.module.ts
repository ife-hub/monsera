import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProxyService } from './proxy.service';
import { AuthProxyController, UsersProxyController } from './auth-proxy.controller';
import { TransactionsProxyController } from './transactions-proxy.controller';
import { VendProxyController } from './vend-proxy.controller';
import { AdminProxyController } from './admin-proxy.controller';

@Module({
  imports: [HttpModule],
  controllers: [AuthProxyController, UsersProxyController, TransactionsProxyController, VendProxyController, AdminProxyController],
  providers: [ProxyService],
})
export class ProxyModule {}