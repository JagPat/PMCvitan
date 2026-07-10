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

function fakePrisma(
  memberships: Array<{ projectId: string; userId: string; role: string; status: string }>,
  users: Array<{ id: string; projectId: string; role: string; name: string }>,
  orgMemberships: Array<{ orgId: string; userId: string; role: string }> = [],
  projects: Array<{ id: string; name: string; short: string; orgId: string; archivedAt?: Date }> = [],
) {
  return {
    membership: {
      findUnique: async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        memberships.find((m) => m.projectId === where.projectId_userId.projectId && m.userId === where.projectId_userId.userId) ?? null,
      findFirst: async ({ where }: { where: { userId: string; status?: string } }) =>
        memberships.find((m) => m.userId === where.userId && (where.status ? m.status === where.status : true)) ?? null,
      findMany: async ({ where }: { where: { userId: string } }) =>
        memberships
          .filter((m) => m.userId === where.userId && m.status === 'active')
          .map((m) => ({ ...m, project: { name: 'P', short: 'P', orgId: 'org1', org: { name: 'Vitan' } } })),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.find((x) => x.id === where.id) ?? null;
        // the legacy fallback `include`s the home project — attach a stub
        return u ? { ...u, project: { name: 'Home', short: 'Home', orgId: null, org: null } } : null;
      },
    },
    orgMembership: {
      findUnique: async ({ where }: { where: { orgId_userId: { orgId: string; userId: string } } }) =>
        orgMemberships.find((o) => o.orgId === where.orgId_userId.orgId && o.userId === where.orgId_userId.userId) ?? null,
      findMany: async ({ where }: { where: { userId: string; role: { in: string[] } } }) =>
        orgMemberships.filter((o) => o.userId === where.userId && where.role.in.includes(o.role)).map((o) => ({ orgId: o.orgId })),
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: { where: { orgId: { in: string[] } } }) =>
        projects.filter((p) => where.orgId.in.includes(p.orgId)).map((p) => ({ ...p, org: { name: 'Vitan' } })),
    },
  };
}

function make(
  memberships: Parameters<typeof fakePrisma>[0],
  users: Parameters<typeof fakePrisma>[1],
  orgMemberships: Parameters<typeof fakePrisma>[2] = [],
  projects: Parameters<typeof fakePrisma>[3] = [],
) {
  return new AuthService(jwt, fakePrisma(memberships, users, orgMemberships, projects) as unknown as PrismaService, new SmsService(), new EmailService(), new GoogleAuthService());
}

describe('AuthService.switchProject', () => {
  it('issues a token scoped to a project the user is a member of', async () => {
    const auth = make([{ projectId: 'p2', userId: 'u1', role: 'client', status: 'active' }], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    const res = await auth.switchProject('u1', 'p2');
    expect(res.projectId).toBe('p2');
    expect(res.role).toBe('client');
    expect(jwt.verify<AuthUser>(res.token)).toMatchObject({ sub: 'u1', role: 'client', projectId: 'p2' });
  });

  it('forbids the user’s own home project when there is no membership row (legacy fallback retired)', async () => {
    // Before the org-escalation fix this returned a PMC token from User.projectId/User.role.
    // Access now requires an explicit membership or org-admin reach; the backfill migration
    // gives genuine legacy accounts a membership so they are unaffected in practice.
    const auth = make([], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    await expect(auth.switchProject('u1', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids switching to a project the user has no access to', async () => {
    const auth = make([], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }]);
    await expect(auth.switchProject('u1', 'pX')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an org owner operate ANY project in their org as PMC (super-admin), even without a membership', async () => {
    const auth = make(
      [], // no explicit project memberships
      [{ id: 'admin1', projectId: 'p1', role: 'pmc', name: 'Ar. Vitan' }],
      [{ orgId: 'org1', userId: 'admin1', role: 'owner' }],
      [{ id: 'villa', name: 'Villa', short: 'Villa', orgId: 'org1' }],
    );
    const res = await auth.switchProject('admin1', 'villa');
    expect(res).toMatchObject({ projectId: 'villa', role: 'pmc' });
    expect(jwt.verify<AuthUser>(res.token)).toMatchObject({ sub: 'admin1', role: 'pmc', projectId: 'villa' });
  });

  it('still forbids a plain org member (not owner/admin) from a non-member project', async () => {
    const auth = make(
      [],
      [{ id: 'u2', projectId: 'p1', role: 'engineer', name: 'x' }],
      [{ orgId: 'org1', userId: 'u2', role: 'member' }],
      [{ id: 'villa', name: 'Villa', short: 'Villa', orgId: 'org1' }],
    );
    await expect(auth.switchProject('u2', 'villa')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses switching into an archived project (even for a member)', async () => {
    const auth = make(
      [{ projectId: 'arch', userId: 'u1', role: 'pmc', status: 'active' }],
      [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'x' }],
      [],
      [{ id: 'arch', name: 'Archived', short: 'Archived', orgId: 'org1', archivedAt: new Date() }],
    );
    await expect(auth.switchProject('u1', 'arch')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('SEC-01: a removed membership denies the switch to the user’s home project', async () => {
    const auth = make(
      [{ projectId: 'p1', userId: 'u1', role: 'contractor', status: 'removed' }],
      [{ id: 'u1', projectId: 'p1', role: 'contractor', name: 'Ex Contractor' }],
    );
    await expect(auth.switchProject('u1', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('SEC-01: a removed membership on a non-home project denies the switch', async () => {
    const auth = make(
      [{ projectId: 'p2', userId: 'u1', role: 'client', status: 'removed' }],
      [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'x' }],
    );
    await expect(auth.switchProject('u1', 'p2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService.listMemberships', () => {
  it('lists the projects the user can access', async () => {
    const auth = make([{ projectId: 'p2', userId: 'u1', role: 'client', status: 'active' }], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'x' }]);
    const rows = await auth.listMemberships('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: 'p2', role: 'client', orgName: 'Vitan' });
  });

  it('an org owner sees every project in their org (as PMC), merged with explicit memberships', async () => {
    const auth = make(
      [{ projectId: 'p2', userId: 'admin1', role: 'client', status: 'active' }], // explicit client on p2
      [{ id: 'admin1', projectId: 'p1', role: 'pmc', name: 'x' }],
      [{ orgId: 'org1', userId: 'admin1', role: 'owner' }],
      [
        { id: 'p2', name: 'P2', short: 'P2', orgId: 'org1' }, // already a member here
        { id: 'villa', name: 'Villa', short: 'Villa', orgId: 'org1' }, // admin reach
      ],
    );
    const rows = await auth.listMemberships('admin1');
    const byId = Object.fromEntries(rows.map((r) => [r.projectId, r.role]));
    expect(byId.p2).toBe('client'); // explicit membership role preserved (not overwritten by admin reach)
    expect(byId.villa).toBe('pmc'); // admin reach as PMC
    expect(rows).toHaveLength(2);
  });

  it('a legacy account with no membership rows lists NO projects (fallback retired; backfill grants the real membership)', async () => {
    const auth = make([], [{ id: 'u1', projectId: 'p1', role: 'pmc', name: 'x' }]);
    const rows = await auth.listMemberships('u1');
    expect(rows).toEqual([]);
  });

  it('SEC-01: a fully-removed user gets NO projects — the legacy fallback never resurrects access', async () => {
    const auth = make(
      [{ projectId: 'p1', userId: 'u1', role: 'contractor', status: 'removed' }],
      [{ id: 'u1', projectId: 'p1', role: 'contractor', name: 'Ex Contractor' }],
    );
    const rows = await auth.listMemberships('u1');
    expect(rows).toEqual([]);
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

  it('ignores a :pid param — org-scoped admin routes (delete/restore project) are authorized by org role, not the project token', () => {
    const token = jwt.sign({ sub: 'u1', role: 'pmc', projectId: 'ambli' });
    // an org admin scoped to 'ambli' deleting a different project 'villa' must not be tenancy-blocked
    expect(guard.canActivate(ctxFor(token, { orgId: 'org1', pid: 'villa' }))).toBe(true);
  });

  it('rejects a missing/invalid token', () => {
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {}, params: {} }) }) } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
