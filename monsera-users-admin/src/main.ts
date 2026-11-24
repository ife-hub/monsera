import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { mountRoutes } from './route-adapter';
import { ROUTES } from './routes';

async function bootstrap() {
  // The route handlers read the raw request body themselves (request.json()),
  // so Nest's body parser stays off.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.set('trust proxy', 1);
  app.enableShutdownHooks();
  mountRoutes(app.getHttpAdapter().getInstance(), ROUTES);
  await app.listen(Number(process.env.PORT ?? 3002));
}
bootstrap();
