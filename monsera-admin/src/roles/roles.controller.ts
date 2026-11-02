import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Controller('admin/roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  // All authenticated users
  @Get()
  list() {
    return this.roles.list();
  }

  // All authenticated users
  @Get(':id')
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.roles.findOne(id);
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: JwtPayload) {
    return this.roles.create(dto, user);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.roles.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.roles.remove(id, user);
  }
}