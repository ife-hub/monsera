import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { LoanThresholdsService } from './loan-thresholds.service';
import { CreateLoanThresholdDto } from './dto/create-loan-threshold.dto';
import { UpdateLoanThresholdDto } from './dto/update-loan-threshold.dto';

@Controller('admin/loan-thresholds')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LoanThresholdsController {
  constructor(private readonly thresholds: LoanThresholdsService) {}

  // All authenticated users
  @Get()
  list() {
    return this.thresholds.list();
  }

  // All authenticated users
  @Get(':id')
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.thresholds.findOne(id);
  }

  @Post()
  @Roles(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateLoanThresholdDto, @CurrentUser() user: JwtPayload) {
    return this.thresholds.create(dto, user);
  }

  @Put(':id')
  @Roles(UserType.EMPLOYEE, UserType.MONSERA_ADMIN)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateLoanThresholdDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.thresholds.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.thresholds.remove(id, user);
  }
}