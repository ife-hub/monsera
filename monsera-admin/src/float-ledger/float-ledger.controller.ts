import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { FloatLedgerService } from './float-ledger.service';
import { ListFloatLedgerDto } from './dto/list-float-ledger.dto';
import { CreateFloatLedgerDto } from './dto/create-float-ledger.dto';
import { UpdateFloatLedgerDto } from './dto/update-float-ledger.dto';

@Controller('admin/float-ledger')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FloatLedgerController {
  constructor(private readonly ledger: FloatLedgerService) {}

  // Each role sees only its own entries (Monsera admin sees all), enforced in the service
  @Get()
  @Roles(UserType.FINANCE_HOUSE, UserType.DISCO_ADMIN, UserType.MONSERA_ADMIN)
  list(@Query() query: ListFloatLedgerDto, @CurrentUser() user: JwtPayload) {
    return this.ledger.list(query, user);
  }

  @Get(':id')
  @Roles(UserType.FINANCE_HOUSE, UserType.DISCO_ADMIN, UserType.MONSERA_ADMIN)
  findOne(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.ledger.findOne(id, user);
  }

  // Finance house: top-up. Monsera admin: allocation to a disco (when discoAdminId is sent).
  @Post()
  @Roles(UserType.FINANCE_HOUSE, UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateFloatLedgerDto, @CurrentUser() user: JwtPayload) {
    return this.ledger.create(dto, user);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateFloatLedgerDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.ledger.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.ledger.remove(id, user);
  }
}