// import { NestFactory } from '@nestjs/core';
// import { ValidationPipe } from '@nestjs/common';
// import { AppModule } from './app.module';
// import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);

//   app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
//   app.useGlobalFilters(new AllExceptionsFilter());

//   await app.listen(process.env.PORT ?? 3004);
// }
// bootstrap();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // DO's load balancer terminates TLS; this makes req.ip / req.protocol correct
  app.set('trust proxy', 1);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // lets Nest run OnModuleDestroy hooks (Prisma disconnect, BullMQ close)
  // when DO sends SIGTERM on each redeploy
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3004);
}
bootstrap();