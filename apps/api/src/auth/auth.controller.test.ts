import { describe, it, expect, afterEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';

/** Records session() calls so we can assert the gate lets the request through. */
const fakeAuth = () => {
  const calls: unknown[] = [];
  const svc = {
    session: (body: unknown) => {
      calls.push(body);
      return { token: 'JWT', role: 'pmc', projectId: 'ambli' };
    },
  } as unknown as AuthService;
  return { svc, calls };
};

const body = { role: 'pmc', projectId: 'ambli' } as never;

describe('AuthController /auth/session dev-auth gate (secure by default)', () => {
  const prev = process.env.ALLOW_DEV_AUTH;
  afterEach(() => {
    if (prev === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = prev;
  });

  it('403s when ALLOW_DEV_AUTH is unset', () => {
    delete process.env.ALLOW_DEV_AUTH;
    const { svc, calls } = fakeAuth();
    expect(() => new AuthController(svc).session(body)).toThrow(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('403s for any value other than exactly "true"', () => {
    for (const v of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.ALLOW_DEV_AUTH = v;
      const { svc } = fakeAuth();
      expect(() => new AuthController(svc).session(body)).toThrow(ForbiddenException);
    }
  });

  it('allows dev auth only when ALLOW_DEV_AUTH === "true"', () => {
    process.env.ALLOW_DEV_AUTH = 'true';
    const { svc, calls } = fakeAuth();
    const res = new AuthController(svc).session(body);
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ role: 'pmc' });
  });
});
