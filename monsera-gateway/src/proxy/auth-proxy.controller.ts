import { All, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

const USERS_ADMIN_URL = process.env.USERS_ADMIN_URL!;

@Controller('auth')
export class AuthProxyController {
  constructor(private proxy: ProxyService) {}

  @Post('login')
  async login(@Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, USERS_ADMIN_URL);
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersProxyController {
  constructor(private proxy: ProxyService) {}

  @All(['/', '*'])
  async forward(@Req() req: Request, @Res() res: Response) {
    return this.proxy.forward(req, res, USERS_ADMIN_URL);
  }
}