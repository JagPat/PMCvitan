import { describe, it, expect, afterEach } from 'vitest';
import { resolveJwtSecret, resolveCorsOrigins } from './config';

// Snapshot the env we mutate so one test can't leak NODE_ENV into another file.
const ORIG = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
};

function restore(key: keyof typeof ORIG): void {
  if (ORIG[key] === undefined) delete process.env[key];
  else process.env[key] = ORIG[key];
}

describe('config — production safety', () => {
  afterEach(() => {
    restore('NODE_ENV');
    restore('JWT_SECRET');
    restore('CORS_ORIGINS');
  });

  describe('resolveJwtSecret', () => {
    it('throws at startup in production when JWT_SECRET is unset (no insecure default)', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET is required/);
    });

    it('returns the configured secret in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-long-random-production-secret';
      expect(resolveJwtSecret()).toBe('a-long-random-production-secret');
    });

    it('falls back to a labelled dev default outside production', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.JWT_SECRET;
      expect(resolveJwtSecret()).toMatch(/dev-secret/);
    });
  });

  describe('resolveCorsOrigins', () => {
    it('throws at startup in production when CORS_ORIGINS is unset (no wildcard)', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGINS;
      expect(() => resolveCorsOrigins()).toThrow(/CORS_ORIGINS is required/);
    });

    it('parses a comma-separated allowlist in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://pms.vitan.in, https://admin.vitan.in';
      expect(resolveCorsOrigins()).toEqual(['https://pms.vitan.in', 'https://admin.vitan.in']);
    });

    it('reflects any origin outside production when unset', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.CORS_ORIGINS;
      expect(resolveCorsOrigins()).toBe(true);
    });
  });
});
