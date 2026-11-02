import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { MetersService } from './meters.service';
import { ListMetersDto } from './dto/list-meters.dto';

@Controller('admin/meters')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserType.MONSERA_ADMIN, UserType.EMPLOYEE)
export class MetersController {
  constructor(private readonly metersService: MetersService) {}

  @Get()
  list(@Query() query: ListMetersDto) {
    return this.metersService.list(query);
  }

  @Get(':meterToken')
  findOne(@Param('meterToken') meterToken: string) {
    return this.metersService.findOne(meterToken);
  }
}