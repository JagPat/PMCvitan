import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottleGuard, type ThrottleOpts } from './throttle';

/** A Reflector stub returning fixed @Throttle metadata. */
function reflectorReturning(opts: ThrottleOpts | undefined): Reflector {
  return { getAllAndOverride: () => opts } as unknown as Reflector;
}

/** A context for a fixed handler/class identity and client IP. */
function ctxFor(ip: string, handler = 'login', cls = 'AuthController'): ExecutionContext {
  return {
    getHandler: () => ({ name: handler }),
    getClass: () => ({ name: cls }),
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as unknown as ExecutionContext;
}

afterEach(() => vi.useRealTimers());

describe('ThrottleGuard', () => {
  it('passes through when a handler has no @Throttle metadata', () => {
    const guard = new ThrottleGuard(reflectorReturning(undefined));
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctxFor('1.1.1.1'))).toBe(true);
  });

  it('allows up to the limit then 429s within the window', () => {
    const guard = new ThrottleGuard(reflectorReturning({ limit: 3, windowMs: 60_000 }));
    const ctx = ctxFor('2.2.2.2');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  it('keys the counter per client IP (one abuser does not throttle others)', () => {
    const guard = new ThrottleGuard(reflectorReturning({ limit: 1, windowMs: 60_000 }));
    expect(guard.canActivate(ctxFor('3.3.3.3'))).toBe(true);
    expect(() => guard.canActivate(ctxFor('3.3.3.3'))).toThrow(HttpException); // same IP blocked
    expect(guard.canActivate(ctxFor('4.4.4.4'))).toBe(true); // different IP unaffected
  });

  it('resets after the window elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const guard = new ThrottleGuard(reflectorReturning({ limit: 1, windowMs: 1000 }));
    const ctx = ctxFor('5.5.5.5');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    vi.advanceTimersByTime(1001); // window passes
    expect(guard.canActivate(ctx)).toBe(true); // allowed again
  });

  it('keys per handler so a burst on one endpoint does not spend another endpoint budget', () => {
    const guard = new ThrottleGuard(reflectorReturning({ limit: 1, windowMs: 60_000 }));
    expect(guard.canActivate(ctxFor('6.6.6.6', 'otpRequest'))).toBe(true);
    expect(guard.canActivate(ctxFor('6.6.6.6', 'login'))).toBe(true); // different handler, own budget
    expect(() => guard.canActivate(ctxFor('6.6.6.6', 'login'))).toThrow(HttpException);
  });

  describe('THROTTLE_DISABLED (acceptance-harness escape hatch)', () => {
    afterEach(() => {
      delete process.env.THROTTLE_DISABLED;
      delete process.env.NODE_ENV;
    });

    it('disables limiting outside production', () => {
      process.env.THROTTLE_DISABLED = 'true';
      const guard = new ThrottleGuard(reflectorReturning({ limit: 1, windowMs: 60_000 }));
      const ctx = ctxFor('7.7.7.7');
      expect(guard.canActivate(ctx)).toBe(true);
      expect(guard.canActivate(ctx)).toBe(true); // over the limit, still allowed
    });

    it('is IGNORED in production — a prod deploy rate-limits regardless of env', () => {
      process.env.THROTTLE_DISABLED = 'true';
      process.env.NODE_ENV = 'production';
      const guard = new ThrottleGuard(reflectorReturning({ limit: 1, windowMs: 60_000 }));
      const ctx = ctxFor('8.8.8.8');
      expect(guard.canActivate(ctx)).toBe(true);
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    });
  });
});
