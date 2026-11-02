import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { FlagsService } from './flags.service';
import { SetFlagDto } from './dto/set-flag.dto';

@Controller('admin/flags')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserType.MONSERA_ADMIN)
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get()
  async list() {
    return { success: true, data: await this.flags.getAll() };
  }

  @Post()
  @HttpCode(200)
  async set(@Body() dto: SetFlagDto, @CurrentUser() user: JwtPayload) {
    await this.flags.set(dto.key, dto.enabled, user);
    return { success: true, message: `Flag '${dto.key}' set to ${dto.enabled}` };
  }
}