import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import type { PrismaService } from '../prisma.service';

function make(orgRole: string | null) {
  const projects: unknown[] = [];
  const memberships: unknown[] = [];
  const orgMemberships: unknown[] = [];
  const prisma = {
    orgMembership: {
      findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)),
      create: vi.fn(async ({ data }: { data: unknown }) => { orgMemberships.push(data); return data; }),
      findMany: vi.fn(async () => []),
    },
    org: {
      create: vi.fn(async ({ data }: { data: { name: string; slug: string } }) => ({ id: 'org1', ...data })),
      findUnique: vi.fn(async () => ({ id: 'org1', projects })),
    },
    project: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { projects.push(data); return data; }),
      findUnique: vi.fn(async () => ({ orgId: 'org1' })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    membership: {
      create: vi.fn(async ({ data }: { data: unknown }) => { memberships.push(data); return data; }),
      findUnique: vi.fn(async () => null as { role: string; status: string } | null),
    },
  };
  const svc = new OrgsService(prisma as unknown as PrismaService);
  return { svc, prisma, projects, memberships, orgMemberships };
}

describe('OrgsService.createProject', () => {
  it('lets an org owner create a project and enrols them as PMC', async () => {
    const { svc, projects, memberships } = make('owner');
    const p = await svc.createProject('org1', 'u1', { name: 'Villa at Satellite', short: 'Satellite Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' });
    expect(p.short).toBe('Satellite Villa');
    expect(projects).toHaveLength(1);
    expect((memberships[0] as { role: string; userId: string }).role).toBe('pmc');
    expect((memberships[0] as { userId: string }).userId).toBe('u1');
  });

  it('forbids a non-admin (plain member) from creating a project', async () => {
    const { svc, projects } = make('member');
    await expect(
      svc.createProject('org1', 'u2', { name: 'X', short: 'X', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(projects).toHaveLength(0);
  });

  it('forbids a non-member entirely', async () => {
    const { svc } = make(null);
    await expect(
      svc.createProject('org1', 'stranger', { name: 'X', short: 'X', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OrgsService.updateProject', () => {
  it('lets an org owner edit a project (only provided fields)', async () => {
    const { svc, prisma } = make('owner');
    const res = await svc.updateProject('org1', 'u1', 'villa', { name: 'Villa Renamed', stage: 'Structure' });
    expect(res.name).toBe('Villa Renamed');
    const call = prisma.project.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ name: 'Villa Renamed', stage: 'Structure' });
  });

  it('lets the project PMC edit even if not an org admin', async () => {
    const { svc, prisma } = make(null); // not an org member
    prisma.membership.findUnique.mockResolvedValueOnce({ role: 'pmc', status: 'active' });
    const res = await svc.updateProject('org1', 'pmcUser', 'villa', { stage: 'Finishing' });
    expect(res).toBeDefined();
    expect(prisma.project.update).toHaveBeenCalled();
  });

  it('forbids a non-admin non-PMC from editing', async () => {
    const { svc, prisma } = make('member');
    prisma.membership.findUnique.mockResolvedValueOnce({ role: 'engineer', status: 'active' });
    await expect(svc.updateProject('org1', 'eng', 'villa', { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe('OrgsService.deleteProject (archive)', () => {
  it('archives a project when the caller is an org owner/admin', async () => {
    const { svc, prisma } = make('owner');
    const res = await svc.deleteProject('org1', 'u1', 'villa');
    expect(res).toEqual({ ok: true });
    const call = prisma.project.update.mock.calls[0][0] as { data: { archivedAt: Date } };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it('forbids a plain org member from deleting a project', async () => {
    const { svc, prisma } = make('member');
    await expect(svc.deleteProject('org1', 'u2', 'villa')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('refuses a project that is not in the org', async () => {
    const { svc, prisma } = make('owner');
    prisma.project.findUnique.mockResolvedValueOnce({ orgId: 'other-org' } as never);
    await expect(svc.deleteProject('org1', 'u1', 'villa')).rejects.toThrow();
  });
});

describe('OrgsService.createOrg', () => {
  it('creates an org and makes the caller its owner', async () => {
    const { svc, orgMemberships } = make(null);
    const org = await svc.createOrg('u1', { name: 'Studio Kaza' });
    expect(org.name).toBe('Studio Kaza');
    expect((orgMemberships[0] as { role: string; userId: string })).toMatchObject({ role: 'owner', userId: 'u1' });
  });
});

describe('OrgsService.addOrgMember', () => {
  function makeRoster(callerRole: string | null, existingUser: unknown = null, projects: unknown[] = [{ id: 'ambli' }]) {
    const created: unknown[] = [];
    const orgMemberships: unknown[] = [];
    const prisma = {
      orgMembership: {
        findUnique: vi.fn(async () => (callerRole ? { role: callerRole } : null)),
        upsert: vi.fn(async ({ create, update }: { create: { role: string }; update: { role: string } }) => {
          const row = existingUser ? { ...update, ...create } : create;
          orgMemberships.push(row);
          return row;
        }),
      },
      org: { findUnique: vi.fn(async () => ({ id: 'org1', projects })) },
      user: {
        findUnique: vi.fn(async () => existingUser),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const u = { id: 'newuser', ...data };
          created.push(u);
          return u;
        }),
      },
      membership: { create: vi.fn() }, // must NOT be called by addOrgMember (no phantom project grant)
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService), prisma, created, orgMemberships };
  }

  it('lets an org owner add a new roster member with NO phantom project grant', async () => {
    const { svc, prisma, created } = makeRoster('owner');
    const res = await svc.addOrgMember('org1', 'owner1', { name: 'JP', email: 'jp@vitan.in', phone: '8320303515', role: 'owner' });
    expect(res).toMatchObject({ userId: 'newuser', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', orgRole: 'owner' });
    // New account is homed on the org's first project only to satisfy the FK, with a
    // least-privilege dormant role and NO project membership — access comes from the
    // org role (super-admin reach), never a phantom PMC grant (ORG escalation fix).
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ projectId: 'ambli', role: 'contractor', phone: '8320303515' });
    expect(created[0].role).not.toBe('pmc');
    expect(prisma.membership.create).not.toHaveBeenCalled(); // no project membership minted
    expect(prisma.orgMembership.upsert).toHaveBeenCalled();
  });

  it('reuses an existing account (matched by email) instead of provisioning a new one', async () => {
    const existing = { id: 'u9', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', projectId: 'ambli', role: 'pmc' };
    const { svc, prisma, created } = makeRoster('owner', existing);
    const res = await svc.addOrgMember('org1', 'owner1', { name: 'JP', email: 'jp@vitan.in', role: 'owner' });
    expect(res.userId).toBe('u9');
    expect(created).toHaveLength(0); // no new user
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('forbids a plain member from managing the roster', async () => {
    const { svc, prisma } = makeRoster('member');
    await expect(svc.addOrgMember('org1', 'u2', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('forbids an admin from managing the roster (owner is the sole gatekeeper)', async () => {
    const { svc, prisma } = makeRoster('admin');
    await expect(svc.addOrgMember('org1', 'admin1', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses to add a member when the org has no active project to home them on', async () => {
    const { svc } = makeRoster('owner', null, []);
    await expect(svc.addOrgMember('org1', 'owner1', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OrgsService.updateOrgMemberRole / removeOrgMember', () => {
  // rows model the org's memberships; findUnique/count/update/delete key off userId.
  function makeManage(rows: Array<{ userId: string; role: string; name?: string }>) {
    const state = rows.map((r) => ({ ...r, name: r.name ?? r.userId }));
    const prisma = {
      orgMembership: {
        findUnique: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) => {
          const r = state.find((x) => x.userId === where.orgId_userId.userId);
          return r ? { role: r.role, user: { name: r.name, email: null, phone: null } } : null;
        }),
        count: vi.fn(async () => state.filter((r) => r.role === 'owner').length),
        update: vi.fn(async ({ where, data }: { where: { orgId_userId: { userId: string } }; data: { role: string } }) => {
          const r = state.find((x) => x.userId === where.orgId_userId.userId)!;
          r.role = data.role;
          return { role: r.role };
        }),
        delete: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) => {
          const i = state.findIndex((x) => x.userId === where.orgId_userId.userId);
          state.splice(i, 1);
          return {};
        }),
      },
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService), prisma, state };
  }

  it('an owner changes an admin down to member', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'u2', role: 'admin' }]);
    const res = await svc.updateOrgMemberRole('org1', 'owner1', 'u2', { role: 'member' });
    expect(res).toMatchObject({ userId: 'u2', orgRole: 'member' });
    expect(state.find((x) => x.userId === 'u2')!.role).toBe('member');
  });

  it('forbids a non-owner (admin) from changing roles', async () => {
    const { svc } = makeManage([{ userId: 'a1', role: 'admin' }, { userId: 'u2', role: 'member' }]);
    await expect(svc.updateOrgMemberRole('org1', 'a1', 'u2', { role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to demote the last owner', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }]);
    await expect(svc.updateOrgMemberRole('org1', 'owner1', 'owner1', { role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('demoting one of two owners is allowed', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'owner2', role: 'owner' }]);
    await svc.updateOrgMemberRole('org1', 'owner1', 'owner2', { role: 'admin' });
    expect(state.find((x) => x.userId === 'owner2')!.role).toBe('admin');
  });

  it('404s changing a role for a non-member', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }]);
    await expect(svc.updateOrgMemberRole('org1', 'owner1', 'ghost', { role: 'admin' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an owner removes a member', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'u2', role: 'member' }]);
    const res = await svc.removeOrgMember('org1', 'owner1', 'u2');
    expect(res).toEqual({ ok: true });
    expect(state.some((x) => x.userId === 'u2')).toBe(false);
  });

  it('refuses self-removal', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'owner2', role: 'owner' }]);
    await expect(svc.removeOrgMember('org1', 'owner1', 'owner1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids a non-owner from removing anyone', async () => {
    const { svc } = makeManage([{ userId: 'a1', role: 'admin' }, { userId: 'u2', role: 'member' }]);
    await expect(svc.removeOrgMember('org1', 'a1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OrgsService.portfolio', () => {
  function makePortfolio(role: string, activityStatuses: string[], adminOrgs: Array<{ orgId: string }> = [], orgProjects: unknown[] = []) {
    const project = { id: 'ambli', name: 'Residence at Ambli', short: 'Ambli', stage: 'Finishing', milestonePct: 72, orgId: 'org1', org: { name: 'Vitan' } };
    const prisma = {
      membership: { findMany: vi.fn(async () => (role ? [{ project, role }] : [])) },
      user: { findUnique: vi.fn(async () => null) },
      orgMembership: { findMany: vi.fn(async () => adminOrgs) },
      project: { findMany: vi.fn(async () => orgProjects) },
      activity: { findMany: vi.fn(async () => activityStatuses.map((status) => ({ status }))) },
      inspection: { count: vi.fn(async () => 1) },
      decision: { count: vi.fn(async () => 3) },
      phase: { count: vi.fn(async () => 3) },
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService), prisma };
  }

  it('rolls up a project the PMC can access, counting activities by status', async () => {
    const { svc } = makePortfolio('pmc', ['done', 'done', 'blocked', 'not_started', 'in_progress', 'not_started']);
    const rows = await svc.portfolio('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'ambli', role: 'pmc', orgName: 'Vitan',
      activityTotal: 6, done: 2, inProgress: 1, blocked: 1, notStarted: 2,
      donePct: 33, openReviews: 1, pendingDecisions: 3, phaseCount: 3,
    });
  });

  it('hides pending-decision counts from a contractor (RBAC)', async () => {
    const { svc, prisma } = makePortfolio('contractor', ['done']);
    const rows = await svc.portfolio('u2');
    expect(rows[0].pendingDecisions).toBe(0);
    expect(prisma.decision.count).not.toHaveBeenCalled();
  });

  it('an org owner sees org projects they are not a member of (super-admin reach, as PMC)', async () => {
    // no explicit membership; owner of org1 which owns a "villa" project
    const villa = { id: 'villa', name: 'Villa', short: 'Villa', stage: 'Planning', milestonePct: 0, orgId: 'org1', org: { name: 'Vitan' } };
    const { svc } = makePortfolio('', ['done', 'not_started'], [{ orgId: 'org1' }], [villa]);
    const rows = await svc.portfolio('admin1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: 'villa', role: 'pmc', activityTotal: 2, done: 1 });
  });
});
