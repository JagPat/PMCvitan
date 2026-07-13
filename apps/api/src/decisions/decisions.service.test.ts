import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';
import type { CreateDecisionInput } from '../contracts';

interface DecisionRow { id: string; projectId: string; title: string; publishedAt: Date | null; authorId: string | null }

/** Minimal in-memory Prisma stand-in for the decision tables. $transaction just awaits the
 *  array (the service builds no cross-op ordering that a synchronous stub would break). */
function make() {
  const decisions: DecisionRow[] = [];
  const notifications: Array<{ text: string }> = [];
  const events: Array<{ type: string }> = [];
  const prisma = {
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
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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
 * Phase 1 Task 1 — CHARACTERIZATION of the approve-lock and change flow as it
 * exists today. Task 2 deliberately replaces several of these behaviors (real
 * attribution, resolvable ChangeRequests, CAS transitions, withdraw) and MUST
 * update these tests in the same PR. Until then, this is the contract.
 */
interface LifecycleRow { id: string; projectId: string; title: string; status: string; approver?: string }

function makeLifecycle(status: string) {
  const row: LifecycleRow = { id: 'DL-1', projectId: 'proj-1', title: 'Kitchen counter top', status };
  const options = [{ label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', order: 0 }];
  const changeRequests: Array<Record<string, unknown>> = [];
  const events: Array<{ type: string; actor: string }> = [];
  const audits: Array<{ actor: string; action: string }> = [];
  const prisma = {
    decision: {
      findUnique: vi.fn(async () => ({ ...row, options })),
      update: vi.fn((args: { data: Partial<LifecycleRow> }) => { Object.assign(row, args.data); return Promise.resolve(row); }),
    },
    changeRequest: { create: vi.fn((args: { data: Record<string, unknown> }) => { changeRequests.push(args.data); return Promise.resolve(args.data); }) },
    decisionEvent: { create: vi.fn((args: { data: { type: string; actor: string } }) => { events.push(args.data); return Promise.resolve(args.data); }) },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn((args: { data: { actor: string; action: string } }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new DecisionsService(prisma, snapshot, realtime);
  return { svc, row, changeRequests, events, audits };
}

describe('DecisionsService — approve lock + change flow (Phase 1 Task 1 characterization)', () => {
  const client = { sub: 'u-client', role: 'client' } as AuthUser;

  it('an approved decision is LOCKED against re-approval (409)', async () => {
    const { svc } = makeLifecycle('approved');
    await expect(svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approve stamps the HARDCODED demo approver, not the real user identity (replaced by Task 2)', async () => {
    const { svc, row, events, audits } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    // 'Mr. Shah' is a literal in the service — the caller's sub/name is recorded nowhere
    expect(row.approver).toBe('Mr. Shah');
    expect(events.find((e) => e.type === 'approved')?.actor).toBe('Mr. Shah');
    expect(audits.find((a) => a.action === 'decision.approve')?.actor).toBe('Mr. Shah');
  });

  it('approve as pmc stamps the literal role label PMC', async () => {
    const { svc, row } = makeLifecycle('pending');
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, user);
    expect(row.approver).toBe('PMC');
  });

  it('a change request is refused unless the decision is locked (409)', async () => {
    const { svc } = makeLifecycle('pending');
    await expect(svc.requestChange('proj-1', 'DL-1', { reason: 'r', costImpact: 0, timeImpactDays: 0 }, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a change request reopens the decision and writes a ChangeRequest row the service NEVER reads back', async () => {
    const { svc, row, changeRequests, events } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', { reason: 'Marble out of stock', costImpact: -5000, timeImpactDays: 3 }, user);
    expect(row.status).toBe('change');
    expect(changeRequests).toHaveLength(1);
    // the service supplies NO status/resolution fields — the row is born on the DB
    // default ('pending') and nothing in the codebase transitions or reads it
    expect('status' in changeRequests[0]).toBe(false);
    expect(events.map((e) => e.type)).toContain('change_requested');
  });

  it('a change-requested decision IS re-approvable — the lock is reopenable (mandatory re-approval is not enforced)', async () => {
    const { svc, row, changeRequests } = makeLifecycle('approved');
    await svc.requestChange('proj-1', 'DL-1', { reason: 'r', costImpact: 0, timeImpactDays: 0 }, user);
    await svc.approve('proj-1', 'DL-1', { optionIndex: 0 }, client);
    expect(row.status).toBe('approved');
    // the ChangeRequest row is untouched by the re-approval: written once, never resolved
    expect(changeRequests).toHaveLength(1);
    expect('resolvedAt' in changeRequests[0]).toBe(false);
  });
});
