import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { MembersService } from './members.service';
import type { DecisionsParticipant } from '../decisions/decisions.participant';
import type { OrgsParticipant } from './orgs.participant';
import type { InvitationsService } from './invitations.service';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';

interface U { id: string; name: string; email: string | null; phone: string | null; role: string; projectId: string; passwordHash: string | null; emailVerifiedAt: Date | null }
interface M { id: string; projectId: string; userId: string; role: string; status: string; discipline?: string | null }
interface T { id: string; membershipId: string; userId: string; fromRole: string | null; fromStatus: string | null; toRole: string; toStatus: string; actorId: string; actorRole: string; actorName: string; sourceCommandId: string }

/** The raw reads `resolveActorEnvelope` makes: the actor holds their token role and has a name. */
function envelopeReads(opts: { holds: boolean }) {
  return vi.fn(async (q: { sql?: string; strings?: string[] }) => {
    const text = q?.sql ?? q?.strings?.join('?') ?? '';
    if (text.includes('platform_user_holds_role_windowed')) return [{ holds: opts.holds }];
    if (text.includes('"displayName"')) return [{ displayName: 'Priya PMC' }];
    return [];
  });
}

function make(orgRole: string | null = null, opts: { holds?: boolean } = {}) {
  const users: U[] = [];
  const memberships: M[] = [];
  const transitions: T[] = [];
  const receipts: Array<{ id: string; commandType: string; status: string; resultRef?: string }> = [];
  let seq = 0;
  const withUser = (m: M, include?: { user?: boolean }) => (include?.user ? { ...m, user: users.find((u) => u.id === m.userId) } : m);
  const byWhere = (where: { id?: string; projectId_userId?: { projectId: string; userId: string } }) =>
    memberships.find((x) => (where.id ? x.id === where.id : x.projectId === where.projectId_userId!.projectId && x.userId === where.projectId_userId!.userId));
  const prisma = {
    project: { findUnique: vi.fn(async () => ({ id: 'p1', orgId: 'org1', name: 'Ambli' })), findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1' })) },
    // the platform event kernel (Phase 2 Task 4) writes through the tx — stub its stream + event steps
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    // 4d-ii-a / A1 + A3b — the envelope reads: by default the actor holds their token role, so a
    // member command can freeze the pair on its transition fact (and emitEvent on its event).
    $queryRaw: envelopeReads({ holds: opts.holds ?? true }),
    // 4d-ii-a / A3b — the command ledger the three member commands reserve a receipt in.
    commandExecution: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { commandType: string } }) => { const r = { id: `cmd${receipts.length + 1}`, commandType: data.commandType, status: 'reserved' }; receipts.push(r); return { id: r.id }; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string; resultRef: string } }) => { const r = receipts.find((x) => x.id === where.id)!; Object.assign(r, data); return r; }),
    },
    membershipTransition: {
      create: vi.fn(async ({ data }: { data: T }) => { transitions.push({ ...data }); return { id: data.id }; }),
    },
    orgMembership: { findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string; phone?: string } }) =>
        users.find((u) => (where.id && u.id === where.id) || (where.email && u.email === where.email) || (where.phone && u.phone === where.phone)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<U> }) => { const u = { id: `u${++seq}`, name: data.name!, email: data.email ?? null, phone: data.phone ?? null, role: data.role!, projectId: data.projectId!, passwordHash: data.passwordHash ?? null, emailVerifiedAt: null }; users.push(u); return u; }),
    },
    membership: {
      findMany: vi.fn(async () => memberships.filter((m) => m.status !== 'removed').map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }))),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; projectId_userId?: { projectId: string; userId: string } } }) => {
        const m = byWhere(where);
        return m ? { ...m, user: users.find((u) => u.id === m.userId) } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...byWhere(where)!, user: users.find((u) => u.id === byWhere(where)!.userId) })),
      create: vi.fn(async ({ data, include }: { data: M; include?: { user?: boolean } }) => { const m = { ...data }; memberships.push(m); return withUser(m, include); }),
      update: vi.fn(async ({ where, data, include }: { where: { id?: string; projectId_userId?: { projectId: string; userId: string } }; data: Partial<M>; include?: { user?: boolean } }) => {
        const m = byWhere(where)!;
        Object.assign(m, data); return withUser(m, include);
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
  return { svc, users, memberships, transitions, receipts, notify, prisma };
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
    const [userId, context] = notify.mock.calls[0] as unknown as [string, { context: string; role: string; actorUserId: string | null }];
    expect(userId).toBe('u1');
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

  // round-1 Codex F1 — nothing fallible may run between the commit and the return. The
  // project-name read is hoisted above the transaction, so the only post-commit call is
  // `notify`, which cannot throw.
  it('reads the project name before the transaction, so no fallible call follows the commit', async () => {
    const { svc, prisma, memberships } = make();
    await svc.add('p1', pmc, { name: 'Ordered', role: 'engineer', email: 'ordered@vitan.in' });
    const nameReads = prisma.project.findUnique.mock.calls.filter(
      ([args]: [{ select?: Record<string, unknown> }]) => args?.select?.name,
    );
    expect(nameReads).toHaveLength(1);
    expect(memberships).toHaveLength(1);
  });
});

// Phase 6 task 4d unit 4d-ii-a / A3b — the three member mutations are ledger commands, each writing
// its `MembershipTransition` FIRST. The seals themselves (order, shape, authority, binding) are
// proven against live PostgreSQL in `test/integration/phase6-t4d-ii-a3b-member-commands.test.ts`.
describe('MembersService — 4d-ii-a / A3b member commands', () => {
  const order = (prisma: ReturnType<typeof make>['prisma'], fn: 'create' | 'update') => ({
    fact: prisma.membershipTransition.create.mock.invocationCallOrder[0]!,
    write: prisma.membership[fn].mock.invocationCallOrder.at(-1)!,
  });

  it('an ADD reserves a members.add receipt and writes its fact, naming the pre-minted membership, BEFORE the membership', async () => {
    const { svc, prisma, transitions, receipts, memberships } = make();
    await svc.add('p1', pmc, { name: 'Asha', role: 'engineer', email: 'asha@vitan.in' });
    expect(receipts).toMatchObject([{ commandType: 'members.add', status: 'succeeded', resultRef: memberships[0].id }]);
    expect(transitions).toEqual([expect.objectContaining({
      membershipId: memberships[0].id, userId: memberships[0].userId, fromRole: null, fromStatus: null,
      toRole: 'engineer', toStatus: 'active', actorId: 'pmc1', actorRole: 'pmc', actorName: 'Priya PMC', sourceCommandId: 'cmd1',
    })]);
    const o = order(prisma, 'create');
    expect(o.fact).toBeLessThan(o.write);
  });

  it('the identity lookup and provisioning run INSIDE the command, after its receipt', async () => {
    const { svc, prisma } = make();
    await svc.add('p1', pmc, { name: 'Inside', role: 'engineer', email: 'inside@vitan.in' });
    expect(prisma.commandExecution.create.mock.invocationCallOrder[0]!).toBeLessThan(prisma.user.create.mock.invocationCallOrder[0]!);
  });

  it('re-adding a REMOVED member re-activates them from `removed` under members.add', async () => {
    const { svc, memberships, transitions } = make();
    await svc.add('p1', pmc, { name: 'Back', role: 'engineer', email: 'back@vitan.in' });
    const uid = memberships[0].userId;
    await svc.remove('p1', pmc, uid);
    await svc.add('p1', pmc, { name: 'Back', role: 'contractor', email: 'back@vitan.in' });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role: 'contractor', status: 'active' });
    expect(transitions.at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'removed', toRole: 'contractor', toStatus: 'active' });
  });

  it('adding someone already ACTIVE is refused (their role changes from the team list), unless it asks for what they already are', async () => {
    const { svc, memberships, transitions } = make();
    await svc.add('p1', pmc, { name: 'Here', role: 'engineer', email: 'here@vitan.in' });
    await expect(svc.add('p1', pmc, { name: 'Here', role: 'contractor', email: 'here@vitan.in' })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.add('p1', pmc, { name: 'Here', role: 'engineer', email: 'here@vitan.in' })).resolves.toMatchObject({ role: 'engineer' });
    expect(memberships[0].role).toBe('engineer');
    expect(transitions).toHaveLength(1);
  });

  it('a RE-ROLE writes (old role, active) → (new role, active) before the update; a removed member is refused', async () => {
    const { svc, prisma, memberships, transitions, receipts } = make();
    await svc.add('p1', pmc, { name: 'Role', role: 'engineer', email: 'role@vitan.in' });
    const uid = memberships[0].userId;
    await svc.updateRole('p1', pmc, uid, { role: 'contractor' });
    expect(transitions.at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'active', toRole: 'contractor', toStatus: 'active' });
    expect(receipts.at(-1)).toMatchObject({ commandType: 'members.updateRole', resultRef: memberships[0].id });
    const facts = prisma.membershipTransition.create.mock.invocationCallOrder;
    expect(facts.at(-1)!).toBeLessThan(prisma.membership.update.mock.invocationCallOrder.at(-1)!);

    await svc.remove('p1', pmc, uid);
    await expect(svc.updateRole('p1', pmc, uid, { role: 'engineer' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('a DISCIPLINE-only change writes no fact and reserves no member receipt; asking for the current state writes nothing', async () => {
    const { svc, memberships, transitions, receipts } = make();
    await svc.add('p1', pmc, { name: 'Lumen', role: 'consultant', discipline: 'lighting', email: 'lumen@vitan.in' });
    const uid = memberships[0].userId;
    const before = { facts: transitions.length, receipts: receipts.length };
    await expect(svc.updateRole('p1', pmc, uid, { role: 'consultant', discipline: 'acoustics' })).resolves.toMatchObject({ discipline: 'acoustics' });
    expect(memberships[0].discipline).toBe('acoustics');
    await svc.updateRole('p1', pmc, uid, { role: 'consultant', discipline: 'acoustics' });
    expect({ facts: transitions.length, receipts: receipts.length }).toEqual(before);
  });

  it('a REMOVAL writes (role, active) → (role, removed); removing someone already removed records nothing', async () => {
    const { svc, memberships, transitions } = make();
    await svc.add('p1', pmc, { name: 'Gone', role: 'engineer', email: 'gone@vitan.in' });
    const uid = memberships[0].userId;
    await svc.remove('p1', pmc, uid);
    expect(transitions.at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'active', toRole: 'engineer', toStatus: 'removed' });
    const facts = transitions.length;
    await expect(svc.remove('p1', pmc, uid)).resolves.toEqual({ ok: true });
    expect(transitions).toHaveLength(facts);
  });

  it('an actor whose token role no longer stands has no pair to freeze — the command is refused and nothing is written', async () => {
    const { svc, memberships, transitions } = make(null, { holds: false });
    await expect(svc.add('p1', pmc, { name: 'Stale', role: 'engineer', email: 'stale@vitan.in' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(transitions).toHaveLength(0);
    expect(memberships).toHaveLength(0);
  });
});
