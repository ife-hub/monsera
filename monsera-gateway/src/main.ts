import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { createProxy } from './proxy/proxy';

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function rateLimitRedis(): Redis | null {
  if (!process.env.REDIS_URL) {
    console.warn('[gateway] REDIS_URL not set: per-caller rate limiting is off');
    return null;
  }
  // Fail fast: a Redis problem must not hold up requests (the limiter fails open).
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  redis.on('error', (error) => console.error(`[gateway] rate-limit Redis: ${error.message}`));
  return redis;
}

async function bootstrap() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set');
  // Bodies are streamed to the services untouched, so no body parsing here.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.enableCors({
    origin: (origin, callback) => callback(null, !origin || ALLOWED_ORIGINS.includes(origin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'API-Key', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Retry-After', 'X-Request-Id', 'Content-Disposition'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.use(createProxy(rateLimitRedis()));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
