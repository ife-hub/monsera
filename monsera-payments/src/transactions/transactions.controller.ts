import { Body, Controller, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { TransactionsService } from './transactions.service';
import { DebitDto } from './dto/debit.dto';
import { CreditDto } from './dto/credit.dto';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('debit')
  @Roles(UserType.AGGREGATOR, UserType.DISCO_ADMIN)
  async debit(
    @Body() dto: DebitDto,
    @CurrentUser() user: JwtPayload,
    @Headers('api-key') apiKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.transactionsService.debit(dto, user, apiKey, idempotencyKey);
  }

  @Post('credit')
  @Roles(UserType.AGGREGATOR, UserType.DISCO_ADMIN)
  async credit(
    @Body() dto: CreditDto,
    @CurrentUser() user: JwtPayload,
    @Headers('api-key') apiKey: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.transactionsService.credit(dto, user, apiKey, idempotencyKey);
  }
}