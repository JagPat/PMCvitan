import { describe, it, expect, vi, type Mock } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DecisionsService } from './decisions.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';
import type { CreateDecisionInput } from '../contracts';

interface DecisionRow { id: string; projectId: string; title: string; publishedAt: Date | null; authorId: string | null }

/** Real display names behind the test users — attribution must surface THESE, not role labels. */
const NAMES: Record<string, string> = { 'u-client': 'Asha Shah', 'u-arch': 'Ar. Meghna', 'u-eng': 'Ravi Iyer' };

/** Minimal in-memory Prisma stand-in for the decision tables. $transaction supports both the
 *  array form and the interactive callback form (the callback receives this same stub). */
function make() {
  const decisions: DecisionRow[] = [];
  const notifications: Array<{ text: string }> = [];
  const events: Array<{ type: string }> = [];
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
    },
    decisionOption: { createMany: vi.fn(async () => ({ count: 0 })) },
    decisionEvent: { create: vi.fn((args: { data: { type: string } }) => { events.push(args.data); return Promise.resolve(args.data); }) },
    notification: { create: vi.fn((args: { data: { text: string } }) => { notifications.push(args.data); return Promise.resolve(args.data); }) },
    auditLog: { create: vi.fn(async () => ({})) },
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  } as unknown as PrismaService;
  return { prisma, decisions, notifications, events };
}

const snapshot = { build: vi.fn(async () => ({ ok: true })) } as unknown as SnapshotService;
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
    const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
    const svc = new DecisionsService(prisma, snapshot, realtime);

    await svc.create('proj-1', baseInput(false), user);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].publishedAt).toBeNull(); // it's a draft
    expect(decisions[0].authorId).toBe('u-arch'); // owned by its creator
    expect(events.map((e) => e.type)).toContain('drafted');
    expect(notifications).toHaveLength(0); // the client is NOT told about a draft
    expect(realtime.notifyChanged).not.toHaveBeenCalled();
  });

  it('create with publish:true issues in one step — publishedAt set, client notified', async () => {
    const { prisma, decisions, notifications } = make();
    const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
    const svc = new DecisionsService(prisma, snapshot, realtime);

    await svc.create('proj-1', baseInput(true), user);

    expect(decisions[0].publishedAt).not.toBeNull();
    expect(notifications).toHaveLength(1);
    expect(realtime.notifyChanged).toHaveBeenCalledWith('proj-1', expect.stringContaining('awaiting your approval'), ['client']);
  });

  it('publish() flips a draft live and fires the client notice; re-publishing conflicts', async () => {
    const { prisma, decisions, notifications } = make();
    const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
    const svc = new DecisionsService(prisma, snapshot, realtime);

    await svc.create('proj-1', baseInput(false), user);
    const id = decisions[0].id;
    expect(notifications).toHaveLength(0);

    await svc.publish('proj-1', id, user);
    expect(decisions[0].publishedAt).not.toBeNull();
    expect(notifications).toHaveLength(1);
    expect(realtime.notifyChanged).toHaveBeenCalledWith('proj-1', expect.stringContaining('awaiting your approval'), ['client']);

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
  approver?: string; approvedById?: string | null; onBehalfOf?: string | null;
}
interface CrRow {
  id: string; decisionId: string; status: string; reason?: string;
  requestedById?: string | null; resolvedById?: string | null; resolvedAt?: Date | null; resolution?: string | null;
}

function makeLifecycle(status: string) {
  const row: LifecycleRow = { id: 'DL-1', projectId: 'proj-1', title: 'Kitchen counter top', status };
  const options = [{ label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', order: 0 }];
  const changeRequests: CrRow[] = [];
  const events: Array<{ type: string; actor: string; actorId?: string; actorName?: string; actorRole?: string; payload?: Record<string, unknown> }> = [];
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
      findFirst: vi.fn(async ({ where }: { where: { decisionId: string; status: string } }) =>
        changeRequests.find((c) => c.decisionId === where.decisionId && c.status === where.status) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id?: string; decisionId?: string; status: string }; data: Partial<CrRow> }) => {
        const hit = changeRequests.filter((c) => (where.id ? c.id === where.id : c.decisionId === where.decisionId) && c.status === where.status);
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
    },
    decisionEvent: { create: vi.fn((args: { data: (typeof events)[number] }) => { events.push(args.data); return Promise.resolve(args.data); }) },
    notification: { create: vi.fn((args: { data: { text: string } }) => { notices.push(args.data.text); return Promise.resolve(args.data); }) },
    auditLog: { create: vi.fn((args: { data: (typeof audits)[number] }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
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
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new DecisionsService(prisma, snapshot, realtime);
  return { svc, prisma, row, changeRequests, events, audits, notices, realtime };
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
    expect(direct.realtime.notifyChanged).toHaveBeenCalledWith('proj-1', expect.stringMatching(/^Client approved/), ['pmc', 'contractor', 'engineer']);

    const behalf = makeLifecycle('pending');
    await behalf.svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, user); // the PMC, 'Ar. Meghna'
    const text = behalf.notices.find((n) => n.includes('approved'));
    expect(text).toMatch(/^Ar\. Meghna \(PMC\) approved Kitchen counter top on behalf of the client/);
    expect(behalf.realtime.notifyChanged).toHaveBeenCalledWith('proj-1', expect.stringContaining('on behalf of the client'), ['pmc', 'contractor', 'engineer']);
  });
});
