import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

const VEND_INGESTION_URL = process.env.VEND_INGESTION_URL!;

@Controller('partners/vends')
@UseGuards(JwtAuthGuard)
export class VendProxyController {
  constructor(private proxy: ProxyService) {}

  @All(['/', '*'])
  async forward(@Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, VEND_INGESTION_URL);
  }
}