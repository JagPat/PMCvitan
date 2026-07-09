import { describe, it, expect, afterEach } from 'vitest';
import { resolveJwtSecret, resolveCorsOrigins } from './config';

// Snapshot the env we mutate so one test can't leak NODE_ENV into another file.
const ORIG = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  DATABASE_URL: process.env.DATABASE_URL,
};

function restore(key: keyof typeof ORIG): void {
  if (ORIG[key] === undefined) delete process.env[key];
  else process.env[key] = ORIG[key];
}

describe('config — production safety (fail-soft)', () => {
  afterEach(() => {
    restore('NODE_ENV');
    restore('JWT_SECRET');
    restore('CORS_ORIGINS');
    restore('DATABASE_URL');
  });

  describe('resolveJwtSecret', () => {
    it('returns the configured secret when set (any env)', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-long-random-production-secret';
      expect(resolveJwtSecret()).toBe('a-long-random-production-secret');
    });

    it('does NOT brick prod when unset — derives a stable, non-public secret from DATABASE_URL', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      process.env.DATABASE_URL = 'postgresql://vitan:pw@db:5432/vitan';
      const s1 = resolveJwtSecret();
      const s2 = resolveJwtSecret();
      expect(s1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
      expect(s1).toBe(s2); // stable across restarts (same DB url)
      expect(s1).not.toBe('dev-secret-change-in-prod'); // never the public default
    });

    it('falls back to a labelled dev default outside production', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.JWT_SECRET;
      expect(resolveJwtSecret()).toBe('dev-secret-change-in-prod');
    });
  });

  describe('resolveCorsOrigins', () => {
    it('parses a comma-separated allowlist', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://pms.vitan.in, https://admin.vitan.in';
      expect(resolveCorsOrigins()).toEqual(['https://pms.vitan.in', 'https://admin.vitan.in']);
    });

    it('does NOT brick prod when unset — reflects the request origin', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGINS;
      expect(resolveCorsOrigins()).toBe(true);
    });

    it('reflects any origin outside production when unset', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.CORS_ORIGINS;
      expect(resolveCorsOrigins()).toBe(true);
    });
  });
});
