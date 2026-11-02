import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { DiscosService } from './discos.service';
import { CreateDiscoDto } from './dto/create-disco.dto';

@Controller('admin/discos')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DiscosController {
  constructor(private readonly discos: DiscosService) {}

  // All authenticated users
  @Get()
  list() {
    return this.discos.list();
  }

  @Post()
  @Roles(UserType.MONSERA_ADMIN)
  create(@Body() dto: CreateDiscoDto, @CurrentUser() user: JwtPayload) {
    return this.discos.create(dto, user);
  }

  // Disco admins fetch / rotate their OWN key (looked up via the JWT, no id in the URL)
  @Get('api-key')
  @Roles(UserType.DISCO_ADMIN)
  getApiKey(@CurrentUser() user: JwtPayload) {
    return this.discos.getMyApiKey(user);
  }

  @Post('regenerate-api-key')
  @Roles(UserType.DISCO_ADMIN)
  regenerateApiKey(@CurrentUser() user: JwtPayload) {
    return this.discos.regenerateMyApiKey(user);
  }
}