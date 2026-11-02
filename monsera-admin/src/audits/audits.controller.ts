import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { AuditsService } from './audits.service';
import { ListAuditsDto } from './dto/list-audits.dto';
import { CreateAuditDto } from './dto/create-audit.dto';

@Controller('admin/audits')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  @Get()
  list(@Query() query: ListAuditsDto) {
    return this.audits.list(query);
  }

  @Post()
  @Roles(UserType.EMPLOYEE, UserType.MONSERA_ADMIN, UserType.AGGREGATOR, UserType.DISCO_ADMIN, UserType.FINANCE_HOUSE)
  create(@Body() dto: CreateAuditDto, @CurrentUser() user: JwtPayload) {
    return this.audits.create(dto, user);
  }

  @Get(':id')
  @Roles(UserType.MONSERA_ADMIN)
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.audits.findOne(id);
  }
}