import { describe, it, expect, afterEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { PasswordCredentialsService } from './password-credentials.service';

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

function fakeCredentials() {
  return {
    request: async () => ({ accepted: true as const, requestId: 'req-id' }),
    verify: async (_body: unknown, sharedPassword: boolean) => ({ setupToken: 'setup-token', expiresInSeconds: 600 as const, sharedPassword }),
    complete: async () => ({ id: 'u1', projectId: 'ambli', role: 'pmc', name: 'User', credentialVersion: 1 }),
  } as unknown as PasswordCredentialsService;
}

describe('AuthController /auth/session dev-auth gate (secure by default)', () => {
  const prev = process.env.ALLOW_DEV_AUTH;
  afterEach(() => {
    if (prev === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = prev;
  });

  it('403s when ALLOW_DEV_AUTH is unset', () => {
    delete process.env.ALLOW_DEV_AUTH;
    const { svc, calls } = fakeAuth();
    expect(() => new AuthController(svc, fakeCredentials(), {} as never).session(body)).toThrow(ForbiddenException);
    expect(calls).toHaveLength(0);
  });

  it('403s for any value other than exactly "true"', () => {
    for (const v of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.ALLOW_DEV_AUTH = v;
      const { svc } = fakeAuth();
      expect(() => new AuthController(svc, fakeCredentials(), {} as never).session(body)).toThrow(ForbiddenException);
    }
  });

  it('allows dev auth only when ALLOW_DEV_AUTH === "true"', () => {
    process.env.ALLOW_DEV_AUTH = 'true';
    const { svc, calls } = fakeAuth();
    const res = new AuthController(svc, fakeCredentials(), {} as never).session(body);
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ role: 'pmc' });
  });

  it('P1-4: 403s in production even when ALLOW_DEV_AUTH === "true"', () => {
    process.env.ALLOW_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    try {
      const { svc, calls } = fakeAuth();
      expect(() => new AuthController(svc, fakeCredentials(), {} as never).session(body)).toThrow(ForbiddenException);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});

describe('AuthController password credential flow', () => {
  it('returns a setup token but no application session after OTP verification', async () => {
    const { svc } = fakeAuth();
    const result = await new AuthController(svc, fakeCredentials(), {} as never).passwordVerify({ requestId: 'req-id', code: '123456' } as never);
    // the switch is off here (IDENTITY_OIDC unset): the password chosen next is PMC's own
    expect(result).toEqual({ setupToken: 'setup-token', expiresInSeconds: 600, sharedPassword: false });
    expect(result).not.toHaveProperty('token');
  });

  it('tells the screen the password chosen next is the one Redbracket ID password only when the switch is exactly "1"', async () => {
    const { svc } = fakeAuth();
    const saved = process.env.IDENTITY_OIDC;
    try {
      for (const [value, shared] of [['1', true], ['true', false], ['0', false]] as const) {
        process.env.IDENTITY_OIDC = value;
        const result = await new AuthController(svc, fakeCredentials(), {} as never).passwordVerify({ requestId: 'req-id', code: '123456' } as never);
        expect({ value, shared: result.sharedPassword }).toEqual({ value, shared });
      }
    } finally {
      if (saved === undefined) delete process.env.IDENTITY_OIDC;
      else process.env.IDENTITY_OIDC = saved;
    }
  });

  it('issues the normal session only after password completion', async () => {
    const auth = {
      signInUser: async (user: unknown) => ({ token: 'JWT', role: 'pmc', projectId: 'ambli', name: (user as { name: string }).name }),
    } as unknown as AuthService;
    const controller = new AuthController(auth, fakeCredentials(), {} as never);
    await expect(controller.passwordComplete({ setupToken: 'x'.repeat(32), password: 'a long internal passphrase' } as never)).resolves.toEqual({
      token: 'JWT', role: 'pmc', projectId: 'ambli', name: 'User',
    });
  });
});
