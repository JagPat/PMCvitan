import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { OrgsParticipant } from '../orgs/orgs.participant';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import type { InspectionParticipant } from '../inspections/inspection.participant';
import type { ActivityParticipant } from '../activities/activity.participant';
import type { DrawingParticipant } from '../drawings/drawing.participant';
import type { DailyLogParticipant } from '../daily-log/daily-log.participant';

interface Node { id: string; projectId: string; parentId: string | null; name: string; kind: string; order: number; publishedAt?: Date | null; authorId?: string | null }

function make(seed: Node[] = [], decisionsByNode: Record<string, number> = {}) {
  const nodes = [...seed];
  let seq = 0;
  const prisma = {
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where?: { projectId?: string; parentId?: string | null } }) =>
        nodes.filter((n) => (where?.projectId ? n.projectId === where.projectId : true) && (where && 'parentId' in where ? n.parentId === where.parentId : true)),
      ),
      create: vi.fn(async ({ data }: { data: Omit<Node, 'id'> }) => {
        const n = { id: `n${++seq}`, ...data };
        nodes.push(n);
        return n;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Node> }) => {
        const n = nodes.find((x) => x.id === where.id)!;
        Object.assign(n, data);
        return n;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] }; projectId?: string; publishedAt?: null }; data: Partial<Node> }) => {
        let count = 0;
        for (const n of nodes) {
          const draftOnly = where.publishedAt === null ? n.publishedAt == null : true;
          if (where.id.in.includes(n.id) && (where.projectId ? n.projectId === where.projectId : true) && draftOnly) {
            Object.assign(n, data);
            count++;
          }
        }
        return { count };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = nodes.findIndex((x) => x.id === where.id);
        const [removed] = nodes.splice(i, 1);
        return removed;
      }),
    },
    decision: { count: vi.fn(async ({ where }: { where: { nodeId: { in: string[] } } }) => where.nodeId.in.reduce((s, id) => s + (decisionsByNode[id] ?? 0), 0)) },
    // remove() unlinks every referrer in the doomed subtree in-transaction (finding 4)
    activity: { updateMany: vi.fn(async () => ({ count: 0 })) },
    inspection: { updateMany: vi.fn(async () => ({ count: 0 })) },
    media: { updateMany: vi.fn(async () => ({ count: 0 })) },
    drawing: { updateMany: vi.fn(async () => ({ count: 0 })) },
    siteMaterial: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // resolveActor (Task 3) + the platform event kernel (Task 4) now run inside these mutations
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    // phase-6-task-2 — create/move/publish take the per-project tree advisory lock as
    // their first in-transaction statement; the stub only needs to accept the call.
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])),
  } as unknown as PrismaService;
  const snapshot = { build: vi.fn(async () => ({})) } as unknown as SnapshotService;
  const dispatcher = { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher;
  // Task 10 (Module 3) correction — remove() routes node-deletion unfiling through the inspections
  // participant; the unit under test doesn't exercise the DB, so a null-returning stub suffices.
  const inspectionParticipant = { unfileForDeletedNodes: vi.fn(async () => null) } as unknown as InspectionParticipant;
  // Task 10 (Module 4) — node deletion also unfiles filed activities through the activities participant
  const activityParticipant = { unfileForDeletedNodes: vi.fn(async () => null) } as unknown as ActivityParticipant;
  // Module 4 correction — node deletion also unfiles drawings and site materials through their
  // owning modules' participants (owner-aligned SET NULL signals); null stubs (no filed rows).
  const drawingParticipant = { unfileForDeletedNodes: vi.fn(async () => null) } as unknown as DrawingParticipant;
  const dailyLogParticipant = { unfileMaterialsForDeletedNodes: vi.fn(async () => null) } as unknown as DailyLogParticipant;
  const svc = new NodesService(prisma, snapshot, dispatcher, new DecisionsQueryService(prisma as unknown as PrismaService, new OrgsParticipant()), inspectionParticipant, activityParticipant, drawingParticipant, dailyLogParticipant);
  const user = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;
  return { svc, prisma, nodes, user };
}

describe('NodesService.create — hierarchy rules', () => {
  it('creates a top-level zone (no parent)', async () => {
    const { svc, nodes, user } = make();
    await svc.create('ambli', { name: 'Ground Floor', kind: 'zone', parentId: null }, user);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'Ground Floor', kind: 'zone', parentId: null });
  });

  it('rejects a zone with a parent', async () => {
    const { svc, user } = make([{ id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 }]);
    await expect(svc.create('ambli', { name: 'x', kind: 'zone', parentId: 'z1' }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a room to sit under a zone (not null, not a room)', async () => {
    const { svc, user } = make([{ id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 }]);
    await expect(svc.create('ambli', { name: 'Bed', kind: 'room', parentId: null }, user)).rejects.toBeInstanceOf(BadRequestException);
    await svc.create('ambli', { name: 'Bed', kind: 'room', parentId: 'z1' }, user); // ok under a zone
  });

  // Nested locations (phase-6-task-2): an element sits under a room OR directly under a
  // zone (both accepted), and stays a LEAF — nothing may sit under an element.
  it('accepts an element under a room AND directly under a zone; an element stays a leaf', async () => {
    const { svc, user } = make([
      { id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 },
      { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Bed', kind: 'room', order: 0 },
      { id: 'e0', projectId: 'ambli', parentId: 'r1', name: 'Door', kind: 'element', order: 0 },
    ]);
    await svc.create('ambli', { name: 'Gate', kind: 'element', parentId: 'z1' }, user); // ok directly under a zone
    await svc.create('ambli', { name: 'Lock', kind: 'element', parentId: 'r1' }, user); // ok under a room
    await expect(svc.create('ambli', { name: 'Sub', kind: 'element', parentId: 'e0' }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create('ambli', { name: 'SubRoom', kind: 'room', parentId: 'e0' }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a room under another room, and refuses a sixth level with the depth stated', async () => {
    const { svc, user } = make([
      { id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 },
      { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Wing', kind: 'room', order: 0 },
      { id: 'r2', projectId: 'ambli', parentId: 'r1', name: 'Pour', kind: 'room', order: 0 },
      { id: 'r3', projectId: 'ambli', parentId: 'r2', name: 'Seg', kind: 'room', order: 0 },
    ]);
    await svc.create('ambli', { name: 'Deep', kind: 'room', parentId: 'r3' }, user); // level 5 — ok
    const deep = 'n1'; // the row the stub just minted
    await expect(svc.create('ambli', { name: 'TooDeep', kind: 'room', parentId: deep }, user))
      .rejects.toThrow(/level|5 levels/i);
  });

  it('rejects a parent from another project', async () => {
    const { svc, user } = make([{ id: 'z1', projectId: 'other', parentId: null, name: 'GF', kind: 'zone', order: 0 }]);
    await expect(svc.create('ambli', { name: 'Bed', kind: 'room', parentId: 'z1' }, user)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NodesService.remove — delete guard', () => {
  const tree: Node[] = [
    { id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 },
    { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Bed', kind: 'room', order: 0 },
    { id: 'e1', projectId: 'ambli', parentId: 'r1', name: 'Door', kind: 'element', order: 0 },
  ];

  it('refuses to delete a node whose subtree has decisions attached', async () => {
    const { svc, user } = make(structuredClone(tree), { e1: 2 }); // 2 decisions under the door (a descendant of the zone)
    await expect(svc.remove('ambli', 'z1', user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes an empty subtree', async () => {
    const { svc, nodes, user } = make(structuredClone(tree), {});
    await svc.remove('ambli', 'z1', user);
    expect(nodes.find((n) => n.id === 'z1')).toBeUndefined();
  });
});

describe('NodesService.move — cycle safety', () => {
  it('refuses to move a node under its own descendant', async () => {
    // Nested rooms make the cycle DIRECTLY reachable (the old kind rule masked it):
    // r2 sits under r1, and moving r1 under r2 would loop the tree.
    const { svc, user } = make([
      { id: 'z1', projectId: 'ambli', parentId: null, name: 'A', kind: 'zone', order: 0 },
      { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'R', kind: 'room', order: 0 },
      { id: 'r2', projectId: 'ambli', parentId: 'r1', name: 'R2', kind: 'room', order: 0 },
    ]);
    await expect(svc.move('ambli', 'r1', { parentId: 'r2' }, user)).rejects.toThrow(/own descendants/i);
    await expect(svc.move('ambli', 'r2', { parentId: 'z1' }, user)).resolves.toBeDefined(); // valid reparent
  });

  it('rejects reparenting to a wrong-kind parent', async () => {
    const { svc, user } = make([
      { id: 'z1', projectId: 'ambli', parentId: null, name: 'A', kind: 'zone', order: 0 },
      { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'R', kind: 'room', order: 0 },
      { id: 'e1', projectId: 'ambli', parentId: 'r1', name: 'E', kind: 'element', order: 0 },
      { id: 'e2', projectId: 'ambli', parentId: 'r1', name: 'E2', kind: 'element', order: 1 },
    ]);
    // an element is a LEAF — moving anything under an element is rejected
    await expect(svc.move('ambli', 'e1', { parentId: 'e2' }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.move('ambli', 'r1', { parentId: 'e1' }, user)).rejects.toBeInstanceOf(BadRequestException);
    // …while the newly legal element-under-zone reparent is accepted
    await expect(svc.move('ambli', 'e1', { parentId: 'z1' }, user)).resolves.toBeDefined();
  });
});

describe('NodesService — draft → publish lifecycle', () => {
  it('publishes by default; publish:false makes a private draft; a child under a draft is forced draft', async () => {
    const { svc, nodes, user } = make();
    await svc.create('ambli', { name: 'GF', kind: 'zone', parentId: null, publish: true } as never, user);
    const gf = nodes.find((n) => n.name === 'GF')!;
    expect(gf.publishedAt).not.toBeNull();
    expect(gf.authorId).toBe('u1');

    await svc.create('ambli', { name: 'Basement', kind: 'zone', parentId: null, publish: false } as never, user);
    const bs = nodes.find((n) => n.name === 'Basement')!;
    expect(bs.publishedAt).toBeNull(); // a private draft

    // a room under the DRAFT basement is forced to a draft even with publish:true
    await svc.create('ambli', { name: 'Store', kind: 'room', parentId: bs.id, publish: true } as never, user);
    expect(nodes.find((n) => n.name === 'Store')!.publishedAt).toBeNull();
  });

  it('publish() flips the whole branch live — the node, its subtree, and draft ancestors', async () => {
    const { svc, nodes, user } = make();
    await svc.create('ambli', { name: 'Basement', kind: 'zone', parentId: null, publish: false } as never, user);
    const bs = nodes.find((n) => n.name === 'Basement')!;
    await svc.create('ambli', { name: 'Store', kind: 'room', parentId: bs.id, publish: false } as never, user);
    const store = nodes.find((n) => n.name === 'Store')!;
    expect(bs.publishedAt).toBeNull();
    expect(store.publishedAt).toBeNull();

    // publishing the child publishes its draft ancestor (Basement) too, so the path is whole
    await svc.publish('ambli', store.id, user);
    expect(nodes.find((n) => n.id === bs.id)!.publishedAt).not.toBeNull();
    expect(nodes.find((n) => n.id === store.id)!.publishedAt).not.toBeNull();
  });
});
