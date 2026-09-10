import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MembersService } from './members.service';
import type { DecisionsParticipant } from '../decisions/decisions.participant';
import type { OrgsParticipant } from './orgs.participant';
import type { InvitationsService } from './invitations.service';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';

interface U { id: string; name: string; email: string | null; phone: string | null; role: string; projectId: string; passwordHash: string | null; emailVerifiedAt: Date | null }
interface M { projectId: string; userId: string; role: string; status: string }

function make(orgRole: string | null = null) {
  const users: U[] = [];
  const memberships: M[] = [];
  let seq = 0;
  const prisma = {
    project: { findUnique: vi.fn(async () => ({ id: 'p1', orgId: 'org1', name: 'Ambli' })), findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1' })) },
    // the platform event kernel (Phase 2 Task 4) writes through the tx — stub its stream + event steps
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    orgMembership: { findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string; phone?: string } }) =>
        users.find((u) => (where.id && u.id === where.id) || (where.email && u.email === where.email) || (where.phone && u.phone === where.phone)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<U> }) => { const u = { id: `u${++seq}`, name: data.name!, email: data.email ?? null, phone: data.phone ?? null, role: data.role!, projectId: data.projectId!, passwordHash: data.passwordHash ?? null, emailVerifiedAt: null }; users.push(u); return u; }),
    },
    membership: {
      findMany: vi.fn(async () => memberships.filter((m) => m.status !== 'removed').map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }))),
      findUnique: vi.fn(async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) => {
        const m = memberships.find((x) => x.projectId === where.projectId_userId.projectId && x.userId === where.projectId_userId.userId);
        return m ? { ...m, user: users.find((u) => u.id === m.userId) } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { projectId_userId: { projectId: string; userId: string } }; create: M; update: Partial<M> }) => {
        const ex = memberships.find((x) => x.projectId === where.projectId_userId.projectId && x.userId === where.projectId_userId.userId);
        if (ex) { Object.assign(ex, update); return ex; }
        const m = { ...create }; memberships.push(m); return m;
      }),
      update: vi.fn(async ({ where, data }: { where: { projectId_userId: { projectId: string; userId: string } }; data: Partial<M> }) => {
        const m = memberships.find((x) => x.projectId === where.projectId_userId.projectId && x.userId === where.projectId_userId.userId)!;
        Object.assign(m, data); return m;
      }),
    },
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  };
  // Phase 6 task 4b (§A.1) — the holder-orphan guard's participant answers, stubbed healthy
  // (no open decisions held; standing present). The refusals are integration-probed (P39).
  // Phase 7c-auth — the post-commit invite notice, captured so a test can assert that adding
  // a member actually tells them (the defect: the account was provisioned in silence).
  const notify = vi.fn(async () => undefined);
  const svc = new MembersService(
    prisma as unknown as PrismaService,
    { holdsOpenDecisions: vi.fn(async () => ({ named: false, heldRoles: [] as string[] })) } as unknown as DecisionsParticipant,
    { effectiveRoleStanding: vi.fn(async () => 1) } as unknown as OrgsParticipant,
    { notify } as unknown as InvitationsService,
  );
  return { svc, users, memberships, notify };
}

const pmc: AuthUser = { sub: 'pmc1', role: 'pmc', projectId: 'p1' };

describe('MembersService.list', () => {
  it('shows credential status to a project team manager', async () => {
    const { svc, users } = make();
    await svc.add('p1', pmc, { name: 'Not enrolled', role: 'engineer', email: 'new@vitan.in' });
    await svc.add('p1', pmc, { name: 'Enrolled', role: 'contractor', email: 'active@vitan.in' });
    users[1].passwordHash = 'bcrypt-hash';

    await expect(svc.list('p1', pmc)).resolves.toEqual([
      expect.objectContaining({ email: 'new@vitan.in', credentialState: 'not_set' }),
      expect.objectContaining({ email: 'active@vitan.in', credentialState: 'active' }),
    ]);
  });

  it('does not disclose credential status to a project member who cannot manage the team', async () => {
    const { svc } = make(null);
    await svc.add('p1', pmc, { name: 'Enrolled', role: 'contractor', email: 'active@vitan.in' });
    const engineer: AuthUser = { sub: 'e1', role: 'engineer', projectId: 'p1' };

    const rows = await svc.list('p1', engineer);
    expect(rows[0]).not.toHaveProperty('credentialState');
  });
});

describe('MembersService.add', () => {
  it('a PMC adds a member by email — provisions the account + membership', async () => {
    const { svc, users, memberships } = make();
    const m = await svc.add('p1', pmc, { name: 'Nilesh (Plumber)', role: 'contractor', email: 'nilesh@vitan.in' });
    expect(m).toMatchObject({ name: 'Nilesh (Plumber)', role: 'contractor', status: 'active' });
    expect(users).toHaveLength(1);
    expect(memberships).toHaveLength(1);
  });

  it('a non-PMC without an org-admin role is forbidden', async () => {
    const { svc, memberships } = make(null);
    const engineer: AuthUser = { sub: 'e1', role: 'engineer', projectId: 'p1' };
    await expect(svc.add('p1', engineer, { name: 'X', role: 'client', email: 'x@vitan.in' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(memberships).toHaveLength(0);
  });

  it('an org owner (not project PMC) may still manage the team', async () => {
    const { svc, memberships } = make('owner');
    const client: AuthUser = { sub: 'c1', role: 'client', projectId: 'p1' };
    await svc.add('p1', client, { name: 'Y', role: 'engineer', phone: '9998887777' });
    expect(memberships).toHaveLength(1);
  });

  it('adds a consultant with a discipline (a lighting consultant, no new role needed)', async () => {
    const { svc, memberships } = make();
    const m = await svc.add('p1', pmc, { name: 'Lumen Studio', role: 'consultant', discipline: 'lighting', email: 'lumen@studio.in' });
    expect(m).toMatchObject({ role: 'consultant', discipline: 'lighting' });
    expect(memberships[0].role).toBe('consultant');
  });

  it('ignores a discipline for a non-consultant role', async () => {
    const { svc } = make();
    const m = await svc.add('p1', pmc, { name: 'Ravi', role: 'engineer', discipline: 'lighting', email: 'ravi@vitan.in' });
    expect(m.discipline).toBeUndefined();
  });
});

describe('MembersService.updateRole / remove', () => {
  it('changes a role and soft-removes a member; refuses self-removal', async () => {
    const { svc, memberships } = make();
    await svc.add('p1', pmc, { name: 'Z', role: 'engineer', email: 'z@vitan.in' });
    const uid = memberships[0].userId;

    await svc.updateRole('p1', pmc, uid, { role: 'contractor' });
    expect(memberships[0].role).toBe('contractor');

    // promoting to consultant sets the discipline; changing away clears it
    await svc.updateRole('p1', pmc, uid, { role: 'consultant', discipline: 'plumbing' });
    expect(memberships[0]).toMatchObject({ role: 'consultant', discipline: 'plumbing' });
    await svc.updateRole('p1', pmc, uid, { role: 'contractor' });
    expect(memberships[0].discipline).toBeNull();

    await expect(svc.remove('p1', { ...pmc, sub: uid }, uid)).rejects.toBeInstanceOf(BadRequestException); // self
    await svc.remove('p1', pmc, uid);
    expect(memberships[0].status).toBe('removed');
  });
});

// Phase 7c-auth — the reported defect: adding someone to a project team provisioned their
// identity and sent nothing, so with invite-only auth the invitee had no way to learn that an
// account existed for them. `add` now hands the committed membership to the invite notice.
describe('MembersService.add — invite notice', () => {
  it('tells a newly provisioned member how to sign in, naming the project and their role', async () => {
    const { svc, notify } = make();
    await svc.add('p1', pmc, { name: 'Vitan Growth OS', role: 'pmc', email: 'growthos@vitan.in' });

    expect(notify).toHaveBeenCalledOnce();
    const [user, context] = notify.mock.calls[0] as unknown as [{ email: string }, { context: string; role: string; actorUserId: string | null }];
    expect(user.email).toBe('growthos@vitan.in');
    expect(context).toMatchObject({ context: 'the Ambli project', role: 'pmc' });
  });

  it('notifies only after the membership is committed, never inside the transaction', async () => {
    const { svc, notify, memberships } = make();
    // The stub $transaction resolves before `add` returns; if the notice were emitted from
    // inside the callback it would run while the readiness lock is still held.
    notify.mockImplementation(async () => {
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe('active');
      return undefined;
    });
    await svc.add('p1', pmc, { name: 'Late', role: 'engineer', email: 'late@vitan.in' });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('still returns the member when the notice is skipped (no email address)', async () => {
    const { svc, notify } = make();
    await expect(svc.add('p1', pmc, { name: 'Phone only', role: 'engineer', phone: '9876543210' }))
      .resolves.toMatchObject({ role: 'engineer', status: 'active' });
    // `notify` is called unconditionally; it is the service that decides to stay silent.
    expect(notify).toHaveBeenCalledOnce();
  });
});
