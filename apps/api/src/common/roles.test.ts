import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY } from './roles';
import type { AuthUser, Role } from './auth';

/** A Reflector stub that returns fixed `@Roles` metadata regardless of handler/class. */
function reflectorReturning(roles: Role[] | undefined): Reflector {
  return { getAllAndOverride: () => roles } as unknown as Reflector;
}

/** An ExecutionContext whose request carries the given (already-verified) user. */
function ctxWithUser(user: AuthUser | undefined): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const engineer: AuthUser = { sub: 'u1', role: 'engineer', projectId: 'ambli' };
const worker: AuthUser = { sub: 'w1', role: 'worker', projectId: 'ambli' };
const pmc: AuthUser = { sub: 'p1', role: 'pmc', projectId: 'ambli' };

describe('RolesGuard', () => {
  it('allows any authenticated user when a handler has no @Roles metadata', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));
    expect(guard.canActivate(ctxWithUser(worker))).toBe(true);
  });

  it('DENIES everyone when @Roles metadata is present but empty (fail closed, not open)', () => {
    // A stray/placeholder @Roles([]) must never silently grant access. (The decorator
    // itself now requires >=1 role at compile time; this guards the runtime path too.)
    const guard = new RolesGuard(reflectorReturning([]));
    expect(() => guard.canActivate(ctxWithUser(worker))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxWithUser(pmc))).toThrow(ForbiddenException);
  });

  it('permits a role that is in the allowlist', () => {
    const guard = new RolesGuard(reflectorReturning(['engineer', 'pmc']));
    expect(guard.canActivate(ctxWithUser(engineer))).toBe(true);
  });

  it('forbids a role that is not in the allowlist', () => {
    const guard = new RolesGuard(reflectorReturning(['pmc']));
    expect(() => guard.canActivate(ctxWithUser(engineer))).toThrow(ForbiddenException);
  });

  it('forbids a worker token from any role-gated mutating endpoint (neutralizes the worker-token hole)', () => {
    const guard = new RolesGuard(reflectorReturning(['engineer', 'pmc']));
    expect(() => guard.canActivate(ctxWithUser(worker))).toThrow(ForbiddenException);
  });

  it('forbids when no user is attached (defence-in-depth if JwtGuard is somehow bypassed)', () => {
    const guard = new RolesGuard(reflectorReturning(['pmc']));
    expect(() => guard.canActivate(ctxWithUser(undefined))).toThrow(ForbiddenException);
  });

  it('treats the allowlist as exact — a "higher" role not listed is still rejected', () => {
    // A route gated to client-only (e.g. a client-only action) rejects even the PMC unless PMC is listed.
    const guard = new RolesGuard(reflectorReturning(['client']));
    expect(() => guard.canActivate(ctxWithUser(pmc))).toThrow(ForbiddenException);
  });

  it('reads @Roles from both handler and class (getAllAndOverride key)', () => {
    // Sanity: the guard keys off ROLES_KEY. A real reflector wiring is exercised via e2e;
    // here we assert the constant the decorator and guard share stays in sync.
    expect(ROLES_KEY).toBe('roles');
  });
});
