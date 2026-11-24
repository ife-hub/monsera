import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { SERVICE_URL_ENV, ServiceName } from '../proxy/routes';

@Controller()
export class HealthController {
  /** Liveness of the gateway itself. */
  @Get('health')
  live() {
    return { status: 'ok', service: 'gateway' };
  }

  /** The whole platform: every service's /health (which includes its database). */
  @Get('api/health')
  async platform() {
    const services = await Promise.all(
      (Object.keys(SERVICE_URL_ENV) as ServiceName[]).map(async (name) => {
        const base = process.env[SERVICE_URL_ENV[name]];
        if (!base) return [name, 'not configured'] as const;
        try {
          const res = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
          return [name, res.ok ? 'ok' : `HTTP ${res.status}`] as const;
        } catch (error: any) {
          return [name, error?.cause?.code ?? error?.name ?? 'unreachable'] as const;
        }
      }),
    );
    const body = { status: services.every(([, s]) => s === 'ok') ? 'ok' : 'degraded', services: Object.fromEntries(services) };
    if (body.status !== 'ok') throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
