import { describe, it, expect } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { GoogleAuthService } from './google.service';
import { JwtGuard, type AuthUser } from '../common/auth';
import type { PrismaService } from '../prisma.service';

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '12h' } });

function fakePrisma(memberships: Array<{ projectId: string; userId: string; role: string; status: string }>, users: Array<{ id: string; projectId: string; role: string; name: string }>) {
  return {
    membership: {
      findUnique: async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        memberships.find((m) => m.projectId === where.projectId_userId.projectId && m.userId === where.projectId_userId.userId) ?? null,
      findMany: async ({ where }: { where: { userId: string } }) =>
        memberships
          .filter((m) => m.userId === where.userId && m.status === 'active')
          .map((m) => ({ ...m, project: { name: 'P', short: 'P', orgId: 'org1', org: { name: 'Vitan' } } })),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null,
    },
  };
}

function make(memberships: Parameters<typeof fakePrisma>[0], users: Parameters<typeof fakePrisma>[1]) {
  return new AuthService(jwt, fakePrisma(memberships, users) as unknown as PrismaService, new SmsService(), new EmailService(), new GoogleAuthService());
}

describe('AuthService.switchProject', () => {
  it('issues a token scoped to a project the user is a member of', async () => {
    const auth = make([{ projectId: 'p2', userId: 'u1', role: 'client', status: 'active' }], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    const res = await auth.switchProject('u1', 'p2');
    expect(res.projectId).toBe('p2');
    expect(res.role).toBe('client');
    expect(jwt.verify<AuthUser>(res.token)).toMatchObject({ sub: 'u1', role: 'client', projectId: 'p2' });
  });

  it('allows the user’s own home project even without a membership row', async () => {
    const auth = make([], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    const res = await auth.switchProject('u1', 'p1');
    expect(res).toMatchObject({ projectId: 'p1', role: 'pmc' });
  });

  it('forbids switching to a project the user has no access to', async () => {
    const auth = make([], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    await expect(auth.switchProject('u1', 'pX')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService.listMemberships', () => {
  it('lists the projects the user can access', async () => {
    const auth = make([{ projectId: 'p2', userId: 'u1', role: 'client', status: 'active' }], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'x' }]);
    const rows = await auth.listMemberships('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: 'p2', role: 'client', orgName: 'Vitan' });
  });
});

describe('JwtGuard tenancy', () => {
  const guard = new JwtGuard(jwt);
  const ctxFor = (token: string, params: Record<string, string>): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, params }) }) }) as unknown as ExecutionContext;

  it('rejects a token whose project does not match the route', () => {
    const token = jwt.sign({ sub: 'u1', role: 'pmc', projectId: 'ambli' });
    expect(() => guard.canActivate(ctxFor(token, { projectId: 'other' }))).toThrow(ForbiddenException);
  });

  it('accepts a token that matches the route project', () => {
    const token = jwt.sign({ sub: 'u1', role: 'pmc', projectId: 'ambli' });
    expect(guard.canActivate(ctxFor(token, { projectId: 'ambli' }))).toBe(true);
  });

  it('accepts routes with no project param', () => {
    const token = jwt.sign({ sub: 'u1', role: 'pmc', projectId: 'ambli' });
    expect(guard.canActivate(ctxFor(token, {}))).toBe(true);
  });

  it('rejects a missing/invalid token', () => {
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {}, params: {} }) }) } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
