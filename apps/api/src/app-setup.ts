import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolveCorsOrigins } from './config';
import { RecordedCompatInterceptor } from './common/recorded-compat.interceptor';

/**
 * The app configuration shared by the production bootstrap (src/main.ts) and the
 * integration-test harness (test/integration/test-app.ts) — one source, so the
 * tests exercise the SAME proxy/CORS/body-limit behavior that ships.
 */
export function configureApp(app: NestExpressApplication): void {
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
  // Phase 6 unit 4b (Codex R2-F1) — the previous-release version boundary for the new
  // `recorded` status: a client that has not declared the decisions contract has recorded rows
  // stripped at the transport layer (see the interceptor's rationale).
  app.useGlobalInterceptors(new RecordedCompatInterceptor());
}
