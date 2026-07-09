import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
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
