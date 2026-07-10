import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';

interface C {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
}

/** orgRole: the caller's role in the owning org (null = not an org member). */
function make(orgRole: string | null = null) {
  const companies: C[] = [];
  let seq = 0;
  const prisma = {
    project: { findUnique: vi.fn(async () => ({ id: 'p1', orgId: 'org1' })) },
    orgMembership: { findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)) },
    projectCompany: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => companies.filter((c) => c.projectId === where.projectId)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.find((c) => c.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Partial<C> }) => {
        const c: C = { id: `c${++seq}`, projectId: data.projectId!, name: data.name!, kind: data.kind!, contactName: data.contactName ?? null, contactEmail: data.contactEmail ?? null, contactPhone: data.contactPhone ?? null, notes: data.notes ?? null };
        companies.push(c);
        return c;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<C> }) => {
        const c = companies.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = companies.findIndex((x) => x.id === where.id);
        return companies.splice(i, 1)[0];
      }),
    },
  };
  const svc = new CompaniesService(prisma as unknown as PrismaService);
  return { svc, companies };
}

const pmc: AuthUser = { sub: 'u-pmc', role: 'pmc', projectId: 'p1' };
const engineer: AuthUser = { sub: 'u-eng', role: 'engineer', projectId: 'p1' };

describe('CompaniesService', () => {
  it('lets the project PMC add a company and lists it back', async () => {
    const { svc } = make();
    const created = await svc.add('p1', pmc, { name: 'BuildRight Constructions', kind: 'contractor', contactName: 'R. Shah', contactPhone: '9825031639' });
    expect(created).toMatchObject({ name: 'BuildRight Constructions', kind: 'contractor', contactName: 'R. Shah' });
    const list = await svc.list('p1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it('forbids a non-PMC project member with no org-admin role', async () => {
    const { svc } = make(null); // engineer, not an org owner/admin
    await expect(svc.add('p1', engineer, { name: 'X', kind: 'consultant' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an org owner/admin even when the token role is not pmc', async () => {
    const { svc } = make('admin'); // engineer token, but org admin
    const created = await svc.add('p1', engineer, { name: 'MEP Consult LLP', kind: 'mep' });
    expect(created.kind).toBe('mep');
  });

  it('updates only provided fields and clears a contact with an empty string', async () => {
    const { svc } = make();
    const c = await svc.add('p1', pmc, { name: 'Struct Co', kind: 'structural', contactEmail: 'a@struct.co' });
    const updated = await svc.update('p1', pmc, c.id, { name: 'Struct Co Pvt', contactEmail: '' });
    expect(updated.name).toBe('Struct Co Pvt');
    expect(updated.kind).toBe('structural'); // untouched
    expect(updated.contactEmail).toBeNull(); // cleared
  });

  it('404s on updating/removing a company that is not on this project', async () => {
    const { svc } = make();
    await expect(svc.update('p1', pmc, 'nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('p1', pmc, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a company', async () => {
    const { svc } = make();
    const c = await svc.add('p1', pmc, { name: 'Temp', kind: 'other' });
    await svc.remove('p1', pmc, c.id);
    expect(await svc.list('p1')).toHaveLength(0);
  });
});
