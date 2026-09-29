import { describe, it, expect, vi, type Mock } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DecisionsService, consultationRequesterStanding } from './decisions.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import type { OrgsParticipant } from '../orgs/orgs.participant';
import type { AuthUser } from '../common/auth';
import type { CreateDecisionInput } from '../contracts';
import { pendingDecisionNotice } from '../domain/notifications';

/**
 * PR C Task 2 — services no longer call `notifyChanged`; they hand their committed events to the
 * single {@link ExternalEffectDispatcher}. The push body + target roles now live in each event's
 * PERSISTED dispatch intent (built from the external-effect catalog by `emitEvent`), so these unit
 * tests assert on the dispatched event's intent. The exact per-branch send behaviour against live
 * PostgreSQL is pinned by test/integration/phase2-consequences.test.ts.
 */
type DispatcherMock = { dispatchCommitted: ReturnType<typeof vi.fn> };
type Intent = { effectKey: string; invalidate: boolean; push?: { body: string; roles: string[] } } | null;
const dispatchedIntents = (d: DispatcherMock): Intent[] =>
  ((d.dispatchCommitted.mock.calls.at(-1)?.[0] ?? []) as Array<{ dispatchIntent: Intent }>).map((e) => e.dispatchIntent);

interface DecisionRow { id: string; projectId: string; title: string; publishedAt: Date | null; authorId: string | null }

/** Real display names behind the test users — attribution must surface THESE, not role labels. */
const NAMES: Record<string, string> = { 'u-client': 'Asha Shah', 'u-arch': 'Ar. Meghna', 'u-eng': 'Ravi Iyer' };

/** Minimal in-memory Prisma stand-in for the decision tables. $transaction supports both the
 *  array form and the interactive callback form (the callback receives a distinct tx stub). */
function make() {
  const decisions: DecisionRow[] = [];
  const notifications: Array<{ projectId: string; text: string; color: string; time: string }> = [];
  const events: Array<{ type: string }> = [];
  const rootNotificationCreate = vi.fn(async (_args: { data: { projectId: string; text: string; color: string; time: string } }) => ({}));
  const txNotificationCreate = vi.fn(async (args: { data: { projectId: string; text: string; color: string; time: string } }) => {
    notifications.push(args.data);
    return args.data;
  });
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (NAMES[where.id] ? { name: NAMES[where.id] } : null)) },
    decision: {
      findMany: vi.fn(async () => decisions.map((d) => ({ id: d.id }))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => decisions.find((d) => d.id === where.id) ?? null),
      create: vi.fn((args: { data: DecisionRow }) => { decisions.push({ ...args.data }); return Promise.resolve(args.data); }),
      update: vi.fn((args: { where: { id: string }; data: Partial<DecisionRow> }) => {
        const d = decisions.find((x) => x.id === args.where.id)!;
        Object.assign(d, args.data);
        return Promise.resolve(d);
      }),
      // Phase 6 task 4a — publish/withdraw compare-and-set through updateMany; the stand-in
      // honours the CAS guards (id/projectId equality, publishedAt null / not-null, status).
      updateMany: vi.fn((args: { where: { id?: string; projectId?: string; status?: string; publishedAt?: { not: null } | null }; data: Partial<DecisionRow> & { status?: string } }) => {
        const matches = decisions.filter((d) =>
          (args.where.id === undefined || d.id === args.where.id) &&
          (args.where.projectId === undefined || d.projectId === args.where.projectId) &&
          (!('publishedAt' in args.where) || (args.where.publishedAt === null ? d.publishedAt === null : d.publishedAt !== null)) &&
          (args.where.status === undefined || (d as { status?: string }).status === args.where.status),
        );
        for (const d of matches) Object.assign(d, args.data);
        return Promise.resolve({ count: matches.length });
      }),
    },
    decisionOption: { createMany: vi.fn(async () => ({ count: 0 })), count: vi.fn(async () => 2) },
    decisionEvent: { create: vi.fn((args: { data: { type: string } }) => { events.push(args.data); return Promise.resolve(args.data); }) },
    notification: { create: rootNotificationCreate },
    auditLog: { create: vi.fn(async () => ({})) },
    // the platform event kernel (Phase 2 Task 4) writes through the tx — stub its three steps
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    // Phase 6 task 4b round 16 — publish() row-locks the draft head (FOR UPDATE) before reading
    // its snapshot; the stand-in answers from the in-memory register (values[0] = decisionId).
    $queryRaw: vi.fn(async (q: { values?: unknown[] }) => {
      const d = decisions.find((x) => x.id === q?.values?.[0]) ?? decisions[0];
      return d
        ? [{ id: d.id, title: (d as { title?: string }).title ?? '', deciderKind: (d as { deciderKind?: string }).deciderKind ?? 'client', deciderMembershipId: null, publishedAt: d.publishedAt }]
        : [];
    }),
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      const tx = { ...prisma, notification: { create: txNotificationCreate } } as unknown as PrismaService;
      return await arg(tx);
    }),
  } as unknown as PrismaService;
  return { prisma, decisions, notifications, events, txNotificationCreate };
}

const snapshot = { build: vi.fn(async () => ({ ok: true })) } as unknown as SnapshotService;
// Phase 6 task 4b — the orgs-owned standing answers the decider model consults: these unit
// suites exercise the DECISIONS logic, so the stub reports healthy standing (an active client
// exists; a named membership resolves) — the standing refusals are integration-probed (P17/P39).
const orgsStub = {
  lockActiveMembership: vi.fn(async () => true),
  lockActiveMembershipById: vi.fn(async () => ({ userId: 'u-client', name: 'Mr. Shah', role: 'client' })),
  effectiveRoleStanding: vi.fn(async () => 1),
  // round-11 Codex F1 — approve re-validates the caller's LIVE role standing in-tx; healthy here
  // (the stale-standing refusals are integration-probed, R11-F1)
  hasProjectRoleStanding: vi.fn(async () => true),
} as unknown as OrgsParticipant;
const user: AuthUser = { sub: 'u-arch', role: 'pmc' } as AuthUser;
const baseInput = (publish: boolean): CreateDecisionInput => ({
  title: 'Kitchen counter top',
  room: 'Kitchen',
  options: [
    { label: 'A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ],
  publish,
} as CreateDecisionInput);

describe('DecisionsService — draft → publish lifecycle', () => {
  it('creates a private DRAFT by default: no publishedAt, no client notice, no realtime push', async () => {
    const { prisma, decisions, notifications, events } = make();
    const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
    const svc = new DecisionsService(prisma, snapshot, dispatcher, orgsStub);

    await svc.create('proj-1', baseInput(false), user);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].publishedAt).toBeNull(); // it's a draft
    expect(decisions[0].authorId).toBe('u-arch'); // owned by its creator
    expect(events.map((e) => e.type)).toContain('drafted');
    expect(notifications).toHaveLength(0); // the client is NOT told about a draft
    // the draft's dispatched event is WEIGHTLESS — it neither invalidates nor pushes, so the
    // single sender is a no-op for it (a draft reaches no one).
    expect(dispatchedIntents(dispatcher)).toEqual([{ effectKey: 'decision.drafted', invalidate: false, coverageVersion: expect.any(String) }]);
  });

  it('create with publish:true issues in one step — publishedAt set, client notified', async () => {
    const { prisma, decisions, notifications } = make();
    const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
    const svc = new DecisionsService(prisma, snapshot, dispatcher, orgsStub);

    await svc.create('proj-1', baseInput(true), user);

    expect(decisions[0].publishedAt).not.toBeNull();
    expect(notifications).toHaveLength(1);
    // the dispatched published event carries the client push (roles from the catalog, body from the command)
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'decision.published', invalidate: true, push: { body: expect.stringContaining('awaiting your approval'), roles: ['client'] } });
  });

  it('create with publish:true writes exactly one canonical notification inside the command transaction; drafts write none', async () => {
    const { prisma, notifications, txNotificationCreate } = make();
    const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
    const svc = new DecisionsService(prisma, snapshot, dispatcher, orgsStub);

    await svc.create('proj-1', baseInput(true), user);

    expect(txNotificationCreate).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(notifications).toEqual([{
      projectId: 'proj-1',
      text: pendingDecisionNotice('Kitchen counter top'),
      color: '#C08A2D',
      time: 'just now',
      // Phase 6 task 4a — decision-notice writers stamp the decision so a later withdrawal
      // retires the pending notice by identity, never by matching display text
      decisionId: expect.any(String),
      // 4d-ii-a / A7a — and bind the notice to the event that announced the act (kind = its type)
      kind: 'decision.published',
      eventId: expect.any(String),
    }]);

    const draft = make();
    const draftSvc = new DecisionsService(draft.prisma, snapshot, dispatcher, orgsStub);
    await draftSvc.create('proj-1', baseInput(false), user);
    expect(draft.prisma.notification.create).not.toHaveBeenCalled();
    expect(draft.txNotificationCreate).not.toHaveBeenCalled();
  });

  it('publish() flips a draft live and fires the client notice; re-publishing conflicts', async () => {
    const { prisma, decisions, notifications } = make();
    const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
    const svc = new DecisionsService(prisma, snapshot, dispatcher, orgsStub);

    await svc.create('proj-1', baseInput(false), user);
    const id = decisions[0].id;
    expect(notifications).toHaveLength(0);

    await svc.publish('proj-1', id, user);
    expect(decisions[0].publishedAt).not.toBeNull();
    expect(notifications).toHaveLength(1);
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'decision.published', invalidate: true, push: { body: expect.stringContaining('awaiting your approval'), roles: ['client'] } });

    // publishing again is a no-op conflict (already live)
    await expect(svc.publish('proj-1', id, user)).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * Phase 1 Task 2 — the change-control contract. Approval locks with the caller's
 * REAL identity (and an explicit on-behalf marker when it isn't the client), a
 * locked decision reopens through exactly ONE open ChangeRequest, re-approval
 * RESOLVES it, withdraw re-locks, and every transition is a CAS with one winner.
 * (Replaces the Task 1 characterization of the pre-change-control behavior.)
 */
interface LifecycleRow {
  id: string; projectId: string; title: string; status: string;
  // Phase 6 task 4b — the decider designation (every legacy row backfills 'client')
  deciderKind?: string; deciderMembershipId?: string | null;
  approver?: string; approvedById?: string | null; onBehalfOf?: string | null;
}
interface CrRow {
  id: string; decisionId: string; status: string; reason?: string;
  requestedById?: string | null; resolvedById?: string | null; resolvedAt?: Date | null; resolution?: string | null;
}

function makeLifecycle(status: string, opts: { architects?: number } = {}) {
  const row: LifecycleRow = { id: 'DL-1', projectId: 'proj-1', title: 'Kitchen counter top', status, deciderKind: 'client', deciderMembershipId: null };
  const options = [{ label: 'Option A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', order: 0 }];
  const changeRequests: CrRow[] = [];
  const events: Array<{ type: string; actor: string; actorId?: string; actorName?: string; actorRole?: string; payload?: Record<string, unknown> }> = [];
  // the IMMUTABLE approval register (round 2) — approve() appends one row per approval
  const revisions: Array<{ id: string; decisionId: string; version: number; optionKey: string; approvedById?: string | null; onBehalfOf?: string | null }> = [];
  const audits: Array<{ actor: string; actorId?: string; actorRole?: string; action: string }> = [];
  const notices: string[] = [];
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (NAMES[where.id] ? { name: NAMES[where.id] } : null)) },
    decision: {
      findUnique: vi.fn(async () => ({ ...row, options })),
      // CAS: honor the status precondition exactly like the SQL UPDATE ... WHERE does
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; projectId: string; status: string }; data: Partial<LifecycleRow> }) => {
        if (row.id !== where.id || row.projectId !== where.projectId || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    changeRequest: {
      create: vi.fn(async ({ data }: { data: CrRow }) => {
        // the ChangeRequest_one_open_per_decision partial unique index, in miniature
        if (data.status === 'open' && changeRequests.some((c) => c.decisionId === data.decisionId && c.status === 'open')) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        const rec = { id: `cr-${changeRequests.length + 1}`, ...data };
        changeRequests.push(rec);
        return rec;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; decisionId?: string; status: string } }) =>
        changeRequests.find((c) => (where.id ? c.id === where.id : c.decisionId === where.decisionId) && c.status === where.status) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; decisionId?: string; status: string }; data: Partial<CrRow> }) => {
        const hit = changeRequests.filter((c) => (where.id ? c.id === where.id : c.decisionId === where.decisionId) && c.status === where.status);
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
    },
    // 4d-ii-a / A7b — `withdrawChange` cancels the decision's queued consultation-request pushes
    // by subject (the platform's own table); the in-memory register holds none
    outboxDelivery: { updateMany: vi.fn(async () => ({ count: 0 })) },
    decisionEvent: {
      create: vi.fn((args: { data: (typeof events)[number] }) => { events.push(args.data); return Promise.resolve(args.data); }),
      count: vi.fn(async ({ where }: { where: { type: { in: string[] } } }) => events.filter((e) => where.type.in.includes(e.type)).length),
    },
    decisionApprovalRevision: {
      findFirst: vi.fn(async () => (revisions.length ? revisions[revisions.length - 1] : null)),
      create: vi.fn((args: { data: (typeof revisions)[number] }) => { revisions.push(args.data); return Promise.resolve(args.data); }),
    },
    // Phase 6 unit 4c-ii — `approve` now reserves a command receipt even when the caller sends no
    // key (`synthesizeKeyWhenAbsent`), because the approval revision it writes carries the
    // provenance 4c's cycle evidence rests on. The ledger is stubbed here rather than skipped: a
    // mock that lacked it would make these lifecycle tests fail on a missing delegate instead of
    // on the behaviour they assert.
    commandExecution: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ ...data, status: 'reserved' })),
      update: vi.fn(async ({ data }: { data: unknown }) => data),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    notification: { create: vi.fn((args: { data: { text: string } }) => { notices.push(args.data.text); return Promise.resolve(args.data); }) },
    auditLog: { create: vi.fn((args: { data: (typeof audits)[number] }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
    // the platform event kernel (Phase 2 Task 4) writes through the tx — stub its three steps
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    // 4d-ii-a — the actor envelope is resolved from the platform registers. This lifecycle's
    // actors HOLD the role their token names (the gate-finding-6 premise), so the stub answers
    // the resolver as the database would for a holder: the standing admits the role and the
    // identity row names the account. The lock reads return nothing, as a `SELECT 1` would.
    $queryRaw: vi.fn(async (q: { sql?: string; strings?: readonly string[] }) => {
      const text = q?.sql ?? q?.strings?.join('?') ?? '';
      if (text.includes('platform_user_holds_role_windowed')) return [{ holds: true }];
      if (text.includes('"UserIdentity"')) return [{ displayName: 'Registered Name' }];
      return [];
    }),
    // 4d-ii-a / A5e — the kernel register the `countersign-v1` in-command check reads: no architect
    // unless the arm seats one, so the chain is inactive and every lifecycle below runs as before
    // 4d-ii-a / A8a — and the ARCHITECTS the provisional approve freezes on its demand (`holderUserIds`)
    $queryRawUnsafe: vi.fn(async (sql: string) => sql.includes('platform_role_standing') ? [{ n: opts.architects ?? 0 }]
      : sql.includes('platform_role_holder_user_ids') ? Array.from({ length: opts.architects ?? 0 }, (_, i) => ({ userId: `arch-${i + 1}` })) : []),
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    // interactive form emulates the REAL transaction's rollback: on a thrown error the
    // decision row and the change requests are restored to their pre-tx state (events/
    // audits written before the throw are also discarded, matching PostgreSQL).
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      const rowBackup = { ...row };
      const crBackup = changeRequests.map((c) => ({ ...c }));
      const evLen = events.length;
      const auLen = audits.length;
      const noLen = notices.length;
      try {
        return await arg(prisma);
      } catch (e) {
        for (const k of Object.keys(row)) delete (row as Record<string, unknown>)[k];
        Object.assign(row, rowBackup);
        changeRequests.splice(0, changeRequests.length, ...crBackup);
        events.length = evLen;
        audits.length = auLen;
        notices.length = noLen;
        throw e;
      }
    }),
  } as unknown as PrismaService;
  const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
  const svc = new DecisionsService(prisma, snapshot, dispatcher, orgsStub);
  return { svc, prisma, row, changeRequests, events, audits, notices, dispatcher };
}

describe('DecisionsService — change control & mandatory re-approval (Phase 1 Task 2)', () => {
  const client = { sub: 'u-client', role: 'client' } as AuthUser;
  const engineer = { sub: 'u-eng', role: 'engineer' } as AuthUser;
  const changeInput = { reason: 'Marble out of stock', costImpact: -5000, timeImpactDays: 3 };

  it('an approved decision is LOCKED against re-approval (409)', async () => {
    const { svc } = makeLifecycle('approved');
    await expect(svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approve records the caller REAL identity — name + id; a client approving carries no on-behalf marker', async () => {
    const { svc, row, events, audits } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    expect(row.approver).toBe('Asha Shah'); // the real display name, not a hardcoded demo literal
    expect(row.approvedById).toBe('u-client');
    expect(row.onBehalfOf).toBeNull();
    const ev = events.find((e) => e.type === 'approved');
    expect(ev?.actorId).toBe('u-client');
    expect(ev?.actorName).toBe('Asha Shah');
    expect(audits.find((a) => a.action === 'decision.approve')?.actorId).toBe('u-client');
  });

  it('a PMC approval is recorded ON BEHALF of the client — attributed, never disguised', async () => {
    const { svc, row, events } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, user);
    expect(row.approver).toBe('Ar. Meghna');
    expect(row.approvedById).toBe('u-arch');
    expect(row.onBehalfOf).toBe('client');
    expect(events.find((e) => e.type === 'approved')?.payload).toMatchObject({ onBehalfOf: 'client' });
  });

  it('an actor with no User row falls back to the role label for display, but the id is still recorded', async () => {
    const { svc, row } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, { sub: 'u-ghost', role: 'pmc' } as AuthUser);
    expect(row.approver).toBe('PMC');
    expect(row.approvedById).toBe('u-ghost');
  });

  it('a change request is refused unless the decision is locked (409)', async () => {
    const { svc } = makeLifecycle('pending');
    await expect(svc.requestChange('proj-1', 'DL-1', changeInput, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a change request reopens the decision and opens ONE attributable ChangeRequest', async () => {
    const { svc, row, changeRequests, events } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    expect(row.status).toBe('change');
    expect(changeRequests).toHaveLength(1);
    expect(changeRequests[0]).toMatchObject({ status: 'open', requestedById: 'u-eng', reason: 'Marble out of stock' });
    expect(events.find((e) => e.type === 'change_requested')?.actorId).toBe('u-eng');
  });

  it('a second change request while one is open is refused (409)', async () => {
    const { svc } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    await expect(svc.requestChange('proj-1', 'DL-1', changeInput, client)).rejects.toBeInstanceOf(ConflictException);
  });

  it('the DB one-open-per-decision backstop (P2002) surfaces as 409, not 500', async () => {
    const { svc, changeRequests } = makeLifecycle('approved');
    // the race the pre-read can't see: an open request already exists on disk
    changeRequests.push({ id: 'cr-race', decisionId: 'DL-1', status: 'open' });
    await expect(svc.requestChange('proj-1', 'DL-1', changeInput, engineer)).rejects.toThrow(/already open/);
  });

  it('re-approval RESOLVES the open change request and logs a distinct reapproved event', async () => {
    const { svc, row, changeRequests, events } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    expect(row.status).toBe('approved');
    expect(changeRequests[0]).toMatchObject({ status: 'resolved', resolution: 'reapproved', resolvedById: 'u-client' });
    expect(changeRequests[0].resolvedAt).toBeInstanceOf(Date);
    expect(events.map((e) => e.type)).toContain('reapproved');
    expect(events.filter((e) => e.type === 'approved')).toHaveLength(0); // reapproval is its own event
  });

  it('the requester can withdraw — the decision re-locks and the request closes as withdrawn', async () => {
    const { svc, row, changeRequests, events } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    await svc.withdrawChange('proj-1', 'DL-1', engineer);
    expect(row.status).toBe('approved');
    expect(changeRequests[0]).toMatchObject({ status: 'withdrawn', resolution: 'withdrawn', resolvedById: 'u-eng' });
    expect(events.find((e) => e.type === 'change_withdrawn')?.actorId).toBe('u-eng');
  });

  it('the PMC can withdraw anyone’s request; another non-requester cannot (403)', async () => {
    const { svc, row } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    await expect(svc.withdrawChange('proj-1', 'DL-1', client)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.withdrawChange('proj-1', 'DL-1', user); // pmc authority
    expect(row.status).toBe('approved');
  });

  it('withdraw with no open change request is a 409', async () => {
    const { svc } = makeLifecycle('approved');
    await expect(svc.withdrawChange('proj-1', 'DL-1', user)).rejects.toBeInstanceOf(ConflictException);
  });

  // 4d-ii-a / A7b (plan §A.2, P33) — the ordinary escape hatch is closed for a disagreement
  it('a countersign REJECTION request cannot be withdrawn — 409 naming re-approval; the decision stays in change', async () => {
    const { svc, row, changeRequests } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    (changeRequests[0] as { origin?: string }).origin = 'countersign_rejection';
    await expect(svc.withdrawChange('proj-1', 'DL-1', user)).rejects.toThrow(/countersign rejection.*re-approval/);
    expect(row.status).toBe('change');
    expect(changeRequests[0]).toMatchObject({ status: 'open' });
  });

  it('a CAS loser gets a deterministic 409 (the transition raced and lost)', async () => {
    const { svc, prisma } = makeLifecycle('pending');
    (prisma.decision.updateMany as Mock).mockResolvedValueOnce({ count: 0 }); // someone else transitioned first
    await expect(svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client)).rejects.toThrow(/changed while approving/);
  });

  it('GATE FINDING 1: re-approving with NO open request is refused and the whole transition rolls back', async () => {
    // a 'change' decision with ZERO open requests — the inconsistent legacy state
    const { svc, row, events } = makeLifecycle('change');
    await expect(svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client)).rejects.toThrow(/no open change request/i);
    expect(row.status).toBe('change'); // the CAS applied, then the tx rolled it back
    expect(events.filter((e) => e.type === 'reapproved')).toHaveLength(0); // 'reapproved' never lies
  });

  it('GATE FINDING 1 (withdraw twin): a request that vanishes mid-withdraw rolls the lock restore back', async () => {
    const { svc, prisma, row } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    (prisma.changeRequest.updateMany as Mock).mockResolvedValueOnce({ count: 0 }); // closed concurrently
    await expect(svc.withdrawChange('proj-1', 'DL-1', engineer)).rejects.toThrow(/changed while withdrawing/);
    expect(row.status).toBe('change'); // not falsely re-locked
  });

  it('GATE FINDING 6: every event and audit snapshots the actor role held at action time', async () => {
    const { svc, events, audits } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    await svc.requestChange('proj-1', 'DL-1', changeInput, engineer);
    expect(events.find((e) => e.type === 'approved')?.actorRole).toBe('client');
    expect(events.find((e) => e.type === 'change_requested')?.actorRole).toBe('engineer');
    expect(audits.find((a) => a.action === 'decision.approve')?.actorRole).toBe('client');
    expect(audits.find((a) => a.action === 'decision.change')?.actorRole).toBe('engineer');
  });

  it('GATE FINDING 7: announcements are truthful — on-behalf names the approver, direct stays the client\'s', async () => {
    const direct = makeLifecycle('pending');
    await direct.svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    expect(direct.notices.find((n) => n.includes('approved'))).toMatch(/^Client approved Kitchen counter top/);
    // the dispatched approved event carries the truthful push (body + catalog roles)
    expect(dispatchedIntents(direct.dispatcher)[0]).toMatchObject({ effectKey: 'decision.approved', invalidate: true, push: { body: expect.stringMatching(/^Client approved/), roles: ['pmc', 'contractor', 'engineer'] } });

    const behalf = makeLifecycle('pending');
    await behalf.svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, user); // the PMC, 'Ar. Meghna'
    const text = behalf.notices.find((n) => n.includes('approved'));
    // 4d-ii-a / A7a — the announcement names the approver as the event's FROZEN envelope does (one
    // reading for the event and the notice): the account's registered name, which this stub
    // deliberately distinguishes from the caller-side `Actor` name ('Ar. Meghna')
    expect(text).toMatch(/^Registered Name \(PMC\) approved Kitchen counter top on behalf of the client/);
    expect(dispatchedIntents(behalf.dispatcher)[0]).toMatchObject({ effectKey: 'decision.approved', invalidate: true, push: { body: expect.stringContaining('on behalf of the client'), roles: ['pmc', 'contractor', 'engineer'] } });
  });
});

// 4d-ii-a / A4d — the withdraw's refusal answers `awaiting_countersign` (#652's review, finding
// 4117700813's sweep): an approval the architect has yet to countersign is still an approval act,
// which the register must keep (the plan's "withdraw refuses it"; the delivered
// `phase6_t4a_no_approval_after_withdraw` seal refuses the same at the database).
describe('DecisionsService — withdraw refuses an approval awaiting countersign (4d-ii-a / A4d)', () => {
  it('409, before any write, exactly as for an approved or reopened decision', async () => {
    const pmc = { sub: 'u-pmc', role: 'pmc' } as AuthUser;
    for (const status of ['approved', 'change', 'awaiting_countersign']) {
      const { svc, prisma } = makeLifecycle(status);
      await expect(svc.withdraw('proj-1', 'DL-1', { reason: 'Scope changed' }, pmc), status)
        .rejects.toThrow(/carries an approval/);
      expect((prisma as unknown as { $transaction: { mock: { calls: unknown[] } } }).$transaction.mock.calls, status).toHaveLength(0);
    }
  });
});

// 4d-ii-a / A5c — the consultation REQUESTER set: the delivered `pmc` standing, or the architect role
// through the kernel read (`platform_user_holds_role`), never an orgs table.
describe('consultationRequesterStanding — pmc by orgs truth, architect by the kernel register (4d-ii-a / A5c)', () => {
  const tx = (holds: boolean) => {
    const calls: unknown[][] = [];
    return { calls, client: { $queryRawUnsafe: vi.fn(async (...args: unknown[]) => { calls.push(args); return [{ holds }]; }) } as unknown as Prisma.TransactionClient };
  };
  it('a pmc asks on the delivered check, without consulting the register', async () => {
    const { calls, client } = tx(false);
    const orgs = { hasProjectRoleStanding: vi.fn(async () => true) };
    expect(await consultationRequesterStanding(orgs, client, 'proj-1', 'u-pmc')).toBe(true);
    expect(orgs.hasProjectRoleStanding).toHaveBeenCalledWith(client, 'proj-1', 'u-pmc', ['pmc'], { forUpdate: true });
    expect(calls).toHaveLength(0);
  });
  it('an architect asks through platform_user_holds_role', async () => {
    const { calls, client } = tx(true);
    expect(await consultationRequesterStanding({ hasProjectRoleStanding: vi.fn(async () => false) }, client, 'proj-1', 'u-arch')).toBe(true);
    expect(calls).toEqual([[expect.stringContaining('platform_user_holds_role'), 'proj-1', 'u-arch', 'architect']]);
  });
  it('anyone else is refused', async () => {
    const { client } = tx(false);
    expect(await consultationRequesterStanding({ hasProjectRoleStanding: vi.fn(async () => false) }, client, 'proj-1', 'u-eng')).toBe(false);
  });
});

/**
 * Phase 6 task 4d-ii-a / A5e (§A.2) — the IN-COMMAND half of the `countersign-v1` boundary on the
 * approve. Under an ACTIVE chain (the kernel register counts an architect) an approval lands
 * `awaiting_countersign`, which a client below `countersign-v1` would report as "Approved & locked": it
 * is refused with a reload 409 inside the command, before any write. The live arm needs an architect to
 * exist, which 4d-i's doors refuse until 4d-iii (P29c's stale-client arms travel there).
 */
describe('DecisionsService — the countersign-v1 client contract on approve (4d-ii-a / A5e)', () => {
  const as = (decisionsContract?: AuthUser['decisionsContract']) =>
    ({ sub: 'u-client', role: 'client', decisionsContract } as AuthUser);

  it('an ACTIVE chain refuses a client below countersign-v1, naming the contract, and writes nothing', async () => {
    for (const contract of [undefined, 'none', 'recorded-v1'] as const) {
      const { svc, row, events, notices } = makeLifecycle('pending', { architects: 1 });
      const refused = svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, as(contract));
      await expect(refused).rejects.toBeInstanceOf(ConflictException);
      await expect(refused).rejects.toThrow(/countersign-v1/);
      expect(row.status, String(contract)).toBe('pending');
      expect(events).toHaveLength(0);
      expect(notices).toHaveLength(0);
    }
  });

  it('a countersign-v1 client is not refused under an active chain — and (4d-ii-a / A8a) the approval lands PROVISIONAL', async () => {
    const { svc, row, events, notices } = makeLifecycle('pending', { architects: 1 });
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, as('countersign-v1'));
    expect(row.status).toBe('awaiting_countersign');
    // the audit register keeps the act; the notice tells the truth about its finality
    expect(events.map((e) => e.type)).toEqual(['approved']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/awaiting the architect's countersign$/);
  });

  it('with NO chain every client approves exactly as before', async () => {
    for (const contract of [undefined, 'none', 'recorded-v1', 'countersign-v1'] as const) {
      const { svc, row } = makeLifecycle('pending');
      await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, as(contract));
      expect(row.status, String(contract)).toBe('approved');
    }
  });
});
