import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { AggregatorsService } from './aggregators.service';
import { CreateAggregatorDto } from './dto/create-aggregator.dto';
import { UpdateAggregatorDto } from './dto/update-aggregator.dto';

@Controller('admin/aggregators')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AggregatorsController {
  constructor(private readonly aggregators: AggregatorsService) {}

  // The fixed-path routes must come before ':id' so ':id' never captures them.
  // Your old GET lived at .../regenerate-api-key; its comment said .../api-key. Both work.
  @Get(['api-key', 'regenerate-api-key'])
  @Roles(UserType.AGGREGATOR)
  getApiKey(@CurrentUser() user: JwtPayload) {
    return this.aggregators.getApiKey(user);
  }

  @Post('regenerate-api-key')
  @HttpCode(200)
  @Roles(UserType.AGGREGATOR)
  regenerateApiKey(@CurrentUser() user: JwtPayload) {
    return this.aggregators.regenerateApiKey(user);
  }

  @Get()
  list() {
    return this.aggregators.list();
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateAggregatorDto, @CurrentUser() user: JwtPayload) {
    return this.aggregators.create(dto, user);
  }

  @Get(':id')
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.aggregators.findOne(id);
  }

  @Put(':id')
  @HttpCode(200)
  @Roles(UserType.MONSERA_ADMIN)
  update(@Param('id', parseIdPipe) id: number, @Body() dto: UpdateAggregatorDto, @CurrentUser() user: JwtPayload) {
    return this.aggregators.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.aggregators.remove(id, user);
  }
}