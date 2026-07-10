import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { resolveCorsOrigins } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Trust the single reverse proxy (Coolify/Traefik) so `req.ip` reflects the real client
  // from X-Forwarded-For — the per-IP auth rate limiter (common/throttle.ts) needs it.
  app.set('trust proxy', 1);
  // CORS is restricted to CORS_ORIGINS in production (no wildcard); any origin in
  // dev. resolveCorsOrigins() throws at startup if it's unset in production.
  app.enableCors({ origin: resolveCorsOrigins(), credentials: true });
  // Raise the body limit so base64 photo uploads (Phase 7c-media) fit; the
  // default 100kb is too small. Validation is done per-route with Zod
  // (see common/zod.pipe.ts); no global ValidationPipe.
  app.useBodyParser('json', { limit: '12mb' });
  app.useBodyParser('urlencoded', { limit: '12mb', extended: true });
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Vitan PMC API listening on :${port}`);
}

void bootstrap();
