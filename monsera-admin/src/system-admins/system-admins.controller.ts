import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { parseIdPipe } from '../common/pipes/parse-id.pipe';
import { SystemAdminsService } from './system-admins.service';
import { CreateSystemAdminDto } from './dto/create-system-admin.dto';
import { UpdateSystemAdminDto } from './dto/update-system-admin.dto';

@Controller('admin/system-admins')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemAdminsController {
  constructor(private readonly admins: SystemAdminsService) {}

  @Get()
  @Roles(UserType.MONSERA_ADMIN)
  list() {
    return this.admins.list();
  }

  @Get(':id')
  @Roles(UserType.MONSERA_ADMIN)
  findOne(@Param('id', parseIdPipe) id: number) {
    return this.admins.findOne(id);
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateSystemAdminDto, @CurrentUser() user: JwtPayload) {
    return this.admins.create(dto, user);
  }

  @Put(':id')
  @Roles(UserType.MONSERA_ADMIN)
  update(
    @Param('id', parseIdPipe) id: number,
    @Body() dto: UpdateSystemAdminDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.admins.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserType.MONSERA_ADMIN)
  remove(@Param('id', parseIdPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.admins.remove(id, user);
  }
}