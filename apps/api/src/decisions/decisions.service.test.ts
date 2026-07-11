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
