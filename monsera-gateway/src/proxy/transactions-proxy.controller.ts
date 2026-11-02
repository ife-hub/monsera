import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

const PAYMENTS_URL = process.env.PAYMENTS_URL!;

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsProxyController {
  constructor(private proxy: ProxyService) {}

  @All(['/', '*'])
  async forward(@Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, PAYMENTS_URL);
  }
}