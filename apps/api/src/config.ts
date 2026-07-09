/**
 * Production-safety configuration helpers.
 *
 * The theme: **fail fast in production** rather than fall back to an insecure
 * default. A misconfigured prod deploy should refuse to start, not silently sign
 * tokens with a public secret or reflect every CORS origin.
 */

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The JWT signing secret. **Required in production** — there is no insecure
 * fallback, so a prod deploy without `JWT_SECRET` throws at startup instead of
 * signing every token with a value that's public in the source tree. Dev/test
 * fall back to a clearly-labelled placeholder so local work needs no setup.
 */
export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('JWT_SECRET is required in production — refusing to start with an insecure default. Set JWT_SECRET.');
  }
  return 'dev-secret-change-in-prod';
}

/**
 * Allowed CORS origins. In production, cross-origin access is restricted to the
 * exact domains in `CORS_ORIGINS` (comma-separated) — never a wildcard. If it's
 * unset in production we throw at startup rather than reflect any origin. In
 * dev/test, any origin is allowed for convenience.
 *
 * Returns the shape `enableCors({ origin })` expects: a string[] allowlist, or
 * `true` (reflect the request origin) outside production.
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
    throw new Error('CORS_ORIGINS is required in production — set a comma-separated allowlist (e.g. https://pms.vitan.in).');
  }
  return true; // dev/test: reflect any origin
}
