import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminProxyController {
  constructor(private proxy: ProxyService) {}

  @All(['/', '*'])
  async forward(@Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, process.env.ADMIN_URL!);
  }
}