import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { OrgsParticipant } from './orgs.participant';
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
  partyId?: string | null;
}

/** orgRole: the caller's role in the owning org (null = not an org member). */
function make(orgRole: string | null = null) {
  const companies: C[] = [];
  let seq = 0;
  // Phase 6 unit 6.1a — `add`/`remove` now commit the company WITH its canonical party, its
  // association and the source row, so the mock carries those delegates and a `$transaction`
  // that runs the callback against itself. The participant passed below is the REAL one, not a
  // stub: the party logic under test is its own, and stubbing it would assert nothing.
  const parties: { id: string; orgId: string; name: string }[] = [];
  const associations: { projectId: string; partyId: string }[] = [];
  const companySources: { projectCompanyId: string; projectId: string; partyId: string }[] = [];
  const prisma: Record<string, unknown> = {
    project: {
      findUnique: vi.fn(async () => ({ id: 'p1', orgId: 'org1' })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'p1', orgId: 'org1' })),
    },
    externalParty: {
      create: vi.fn(async ({ data }: { data: { orgId: string; name: string } }) => {
        const row = { id: `pty${++seq}`, orgId: data.orgId, name: data.name };
        parties.push(row);
        return row;
      }),
      // A rename now follows the directory row into the party it is the sole evidence for.
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
        const row = parties.find((p) => p.id === where.id);
        if (row) row.name = data.name;
        return row;
      }),
    },
    projectParty: {
      upsert: vi.fn(async ({ create }: { create: { projectId: string; partyId: string } }) => {
        if (!associations.some((a) => a.projectId === create.projectId && a.partyId === create.partyId)) associations.push({ ...create });
        return create;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { projectId: string; partyId: string } }) => {
        const before = associations.length;
        for (let i = associations.length - 1; i >= 0; i--) {
          if (associations[i]!.projectId === where.projectId && associations[i]!.partyId === where.partyId) associations.splice(i, 1);
        }
        return { count: before - associations.length };
      }),
    },
    projectPartyCompanySource: {
      create: vi.fn(async ({ data }: { data: { projectCompanyId: string; projectId: string; partyId: string } }) => {
        companySources.push({ ...data });
        return data;
      }),
      count: vi.fn(async ({ where }: { where: { projectId: string; partyId: string } }) =>
        companySources.filter((x) => x.projectId === where.projectId && x.partyId === where.partyId).length),
    },
    projectPartyVendorSource: { count: vi.fn(async () => 0) },
    orgMembership: { findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)) },
    projectCompany: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => companies.filter((c) => c.projectId === where.projectId)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.find((c) => c.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Partial<C> }) => {
        const c: C = { id: `c${++seq}`, projectId: data.projectId!, name: data.name!, kind: data.kind!, contactName: data.contactName ?? null, contactEmail: data.contactEmail ?? null, contactPhone: data.contactPhone ?? null, notes: data.notes ?? null, partyId: (data as { partyId?: string }).partyId ?? null };
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
        // ON DELETE CASCADE removes the source row with the company; the mock mirrors it so the
        // release check sees the same world PostgreSQL would.
        for (let k = companySources.length - 1; k >= 0; k--) {
          if (companySources[k]!.projectCompanyId === where.id) companySources.splice(k, 1);
        }
        return companies.splice(i, 1)[0];
      }),
    },
  };
  (prisma as { $transaction?: unknown }).$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  // `releasePartyAssociationIfUnsourced` locks the association before counting what justifies it.
  // The lock is the point of that method, so the mock answers the row-existence question the
  // participant asks rather than stubbing the call away — a lock that returns nothing here would
  // make the release a no-op and the "removes a company" test would assert against a fiction.
  (prisma as { $queryRaw?: unknown }).$queryRaw = vi.fn(async (_strings: TemplateStringsArray, projectId: string, partyId: string) =>
    associations.filter((a) => a.projectId === projectId && a.partyId === partyId).map((a) => ({ id: `${a.projectId}:${a.partyId}` })));
  const svc = new CompaniesService(prisma as unknown as PrismaService, new OrgsParticipant());
  return { svc, companies, parties, associations, companySources };
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
