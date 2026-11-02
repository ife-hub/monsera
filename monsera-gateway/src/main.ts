import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

const ALLOWED_ORIGINS = ['https://monsera-frontend-pwjpq.ondigitalocean.app', 'https://app.plugmonsera.com'];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: string | boolean) => void,
  ) =>
    callback(
      null,
      ALLOWED_ORIGINS.includes(origin ?? '') ? origin : ALLOWED_ORIGINS[0],
    ),
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();