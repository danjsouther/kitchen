import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { parseMasterKey } from './common/secret-crypto.util';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Validate the secrets-encryption key at startup rather than the first time a
  // household saves an API key — a malformed key should stop a deploy, not
  // surface as a confusing error to a user hours later.
  parseMasterKey(process.env.AI_ENCRYPTION_KEY);

  app.use(cookieParser());

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:4200',
    // Required for the session cookie to be sent cross-origin in development,
    // where the Angular dev server and the API are on different ports.
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties instead of persisting whatever was posted.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`Listening on http://localhost:${port}/api`);
}

void bootstrap();
