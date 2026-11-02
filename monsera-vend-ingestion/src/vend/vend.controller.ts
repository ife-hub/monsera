import { Body, Controller, Headers, Post, UseGuards, UnauthorizedException, ForbiddenException, HttpCode } from '@nestjs/common';
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/types/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { IngestService } from './ingest.service';
import { IncomingVendDto } from './dto/incoming-vend.dto';
import { BatchVendDto } from './dto/batch-vend.dto';

@Controller('partners/vends')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserType.DISCO_ADMIN)
export class VendController {
  constructor(
    private prisma: PrismaService,
    private ingestService: IngestService,
  ) {}

  private async resolveDisco(user: JwtPayload, apiKey: string | undefined) {
    if (!apiKey) throw new UnauthorizedException({ success: false, message: 'API key is required' });

    const discoAdmin = await this.prisma.discoAdmin.findUnique({ where: { userId: user.userId } });
    if (!discoAdmin || discoAdmin.apiKey !== apiKey) {
      throw new ForbiddenException({ success: false, message: 'Invalid API key' });
    }
    return discoAdmin;
  }

  @Post()
  @HttpCode(201)
  async single(@Body() dto: IncomingVendDto, @CurrentUser() user: JwtPayload, @Headers('api-key') apiKey: string | undefined) {
    const discoAdmin = await this.resolveDisco(user, apiKey);
    const { results } = await this.ingestService.ingestVends(discoAdmin.id, [dto]);
    const [result] = results;
    return { success: result.status === 'accepted', result };
  }

  @Post('batch')
  @HttpCode(201)
  async batch(@Body() dto: BatchVendDto, @CurrentUser() user: JwtPayload, @Headers('api-key') apiKey: string | undefined) {
    const discoAdmin = await this.resolveDisco(user, apiKey);
    const { results } = await this.ingestService.ingestVends(discoAdmin.id, dto.vends);
    const failed = results.filter((r) => r.status === 'rejected').length;
    return { success: true, processed: results.length - failed, failed, results };
  }
}