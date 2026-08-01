import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';

import { AppModule } from './app.module';
import { parseMasterKey } from './common/secret-crypto.util';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  // bodyParser: false, then mounted by hand below with a raised size limit —
  // Express's default (~100kb) is fine for every other endpoint but far too
  // small for a whole-household data import.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Validate the secrets-encryption key at startup rather than the first time a
  // household saves an API key — a malformed key should stop a deploy, not
  // surface as a confusing error to a user hours later.
  parseMasterKey(process.env.AI_ENCRYPTION_KEY);

  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));
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
