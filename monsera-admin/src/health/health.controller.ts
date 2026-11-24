import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import prisma from '../lib/prisma';

/** Liveness + database reachability, for the platform's health checks. */
@Controller('health')
export class HealthController {
  @Get()
  async check() {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', service: process.env.SERVICE_NAME, database: 'ok' };
    } catch {
      throw new HttpException({ status: 'error', service: process.env.SERVICE_NAME, database: 'unreachable' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
