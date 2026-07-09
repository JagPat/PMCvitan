/**
 * Production-safety configuration helpers.
 *
 * Theme: **prefer explicit config, degrade safely** — never fall back to an
 * insecure *public* default, but never brick a deploy either. In production a
 * missing secret logs a loud warning and uses a secure derived/reflected value
 * instead of throwing at startup, so an unset env var can't take the API down.
 */
import { createHash, randomBytes } from 'node:crypto';

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The JWT signing secret. Prefer an explicit `JWT_SECRET` (long random value).
 * In production, if it's unset we do NOT brick the deploy and do NOT fall back to
 * the public source-tree default — instead we derive a **stable, unguessable**
 * secret from `DATABASE_URL` (always present, contains the DB password) and warn.
 * Setting `JWT_SECRET` explicitly is recommended (lets you rotate it; a change to
 * the derived source or an unset DB would otherwise invalidate sessions).
 */
export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) {
    const dbUrl = process.env.DATABASE_URL?.trim();
    if (dbUrl) {
      // eslint-disable-next-line no-console
      console.warn('[config] JWT_SECRET not set — deriving a stable secret from DATABASE_URL. Set JWT_SECRET explicitly for a rotatable secret.');
      return createHash('sha256').update('vitan-pmc:jwt:' + dbUrl).digest('hex');
    }
    // eslint-disable-next-line no-console
    console.warn('[config] JWT_SECRET and DATABASE_URL both unset — using an ephemeral secret (sessions reset on every restart). Set JWT_SECRET.');
    return randomBytes(32).toString('hex');
  }
  return 'dev-secret-change-in-prod';
}

/**
 * Allowed CORS origins. Prefer an explicit `CORS_ORIGINS` allowlist
 * (comma-separated). In production, if it's unset we warn and reflect the request
 * origin rather than bricking the deploy — the API is bearer-token based (no
 * cookies), so reflecting is functional and low-risk. Set `CORS_ORIGINS` to lock
 * cross-origin access down to your domains.
 *
 * Returns the shape `enableCors({ origin })` expects: a string[] allowlist, or
 * `true` (reflect the request origin).
 */
export function resolveCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  if (isProduction()) {
    // eslint-disable-next-line no-console
    console.warn('[config] CORS_ORIGINS not set — reflecting the request origin. Set CORS_ORIGINS to restrict to your domains.');
  }
  return true; // reflect any origin
}
