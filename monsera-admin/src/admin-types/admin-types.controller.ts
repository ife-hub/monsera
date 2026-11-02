import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminTypesController {
  // Your folder is named admin-type but its comment says admin-types; both work.
  @Get(['admin-types', 'admin-type'])
  list() {
    return { success: true, data: Object.values(AdminType) };
  }
}