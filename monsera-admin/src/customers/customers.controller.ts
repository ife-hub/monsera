import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { CustomersService } from './customers.service';
import { ListCustomersDto } from './dto/list-customers.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Controller('admin/customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  // All authenticated users
  @Get()
  list(@Query() query: ListCustomersDto) {
    return this.customers.list(query);
  }

  // All authenticated users
  @Get(':id')
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.customers.findOne(id);
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN, UserType.AGGREGATOR)
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: JwtPayload) {
    return this.customers.create(dto, user);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN, UserType.AGGREGATOR, UserType.DISCO_ADMIN)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customers.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN, UserType.AGGREGATOR, UserType.DISCO_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.customers.remove(id, user);
  }
}