import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Controller('admin/employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @Roles(UserType.MONSERA_ADMIN)
  list() {
    return this.employees.list();
  }

  @Get(':id')
  @Roles(UserType.MONSERA_ADMIN)
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.employees.findOne(id);
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateEmployeeDto) {
    return this.employees.create(dto);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN)
  update(@Param('id', parseIdPipe) id: number, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number) {
    return this.employees.remove(id);
  }
}