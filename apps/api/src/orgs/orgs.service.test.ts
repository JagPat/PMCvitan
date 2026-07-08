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
    },
    membership: {
      create: vi.fn(async ({ data }: { data: unknown }) => { memberships.push(data); return data; }),
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

describe('OrgsService.createOrg', () => {
  it('creates an org and makes the caller its owner', async () => {
    const { svc, orgMemberships } = make(null);
    const org = await svc.createOrg('u1', { name: 'Studio Kaza' });
    expect(org.name).toBe('Studio Kaza');
    expect((orgMemberships[0] as { role: string; userId: string })).toMatchObject({ role: 'owner', userId: 'u1' });
  });
});
