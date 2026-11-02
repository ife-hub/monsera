import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { FinanceHousesService } from './finance-houses.service';
import { UpdateFinanceHouseDto } from './dto/update-finance-house.dto';

@Controller('admin/finance-houses')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceHousesController {
  constructor(private readonly financeHouses: FinanceHousesService) {}

  // All authenticated users
  @Get(':id')
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.financeHouses.findOne(id);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN, UserType.FINANCE_HOUSE)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateFinanceHouseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.financeHouses.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.financeHouses.remove(id, user);
  }
}