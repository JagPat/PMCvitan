import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { NodesService } from '../../src/nodes/nodes.service';
import { treeLockKey } from '../../src/common/tree-lock';
import type { AuthUser } from '../../src/common/auth';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
/**
 * #699 (shadow review on `ffe055d`) — a location create is idempotent under its `Idempotency-Key`.
 * Before this a double submit, or a retry sent while the first request was still in flight,
 * created two same-named siblings. The create runs through the command ledger: the same key + body
 * creates the place once and replays; concurrent same-key creates resolve to one winner; a
 * different body under the key is a 409. #704 redesign: a name already held under the parent is
 * the place's natural key, so a create of it under any key (or none) names that place.
 */
describe('#699 — nodes.create is idempotent under its key (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: NodesService;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(NodesService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const p = f.projectA.id;
    await t.prisma.commandExecution.deleteMany({ where: { projectId: p } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await t.prisma.projectNode.deleteMany({ where: { projectId: p, name: { startsWith: 'Idem ' } } });
  });

  const p = () => f.projectA.id;
  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;
  const zones = (name: string) => t.prisma.projectNode.count({ where: { projectId: p(), name, kind: 'zone' } });

  it('the SAME key creates the place once and replays (no second node, no second event)', async () => {
    const input = { name: 'Idem Ground', kind: 'zone' as const, parentId: null, publish: true };
    const first = await svc.create(p(), input, pmc(), 'k-node');
    const replay = await svc.create(p(), input, pmc(), 'k-node'); // retry after a lost reply
    expect(await zones('Idem Ground')).toBe(1);
    const node = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p(), name: 'Idem Ground' } });
    // the reply names the place it made, and the replay names the same one (places that already
    // share a name may exist, so a client must never have to find it by name)
    expect(first.createdNodeId).toBe(node.id);
    expect(replay.createdNodeId).toBe(node.id);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'node.created', entityId: node.id } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'nodes.create', idempotencyKey: 'k-node' } })).toBe(1);
  });

  const ungrantedLocks = async (): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
    return rows[0]?.n ?? 0;
  };
  /** Condition-based wait (never a fixed sleep) until a NEW ungranted lock appears; a call that
   *  settles instead has escaped the race shape, which fails the probe. */
  const blocked = async (p: Promise<unknown>, baseline: number): Promise<void> => {
    const state = { settled: false };
    void p.then(() => { state.settled = true; }, () => { state.settled = true; });
    const deadline = Date.now() + 8000;
    for (;;) {
      if (state.settled) throw new Error('the create settled instead of blocking: the race shape was lost');
      if ((await ungrantedLocks()) > baseline) return;
      if (Date.now() > deadline) throw new Error('the create did not block within 8s');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('two CONCURRENT same-key creates collide on the reservation and resolve to one place (barrier)', async () => {
    // #700 Codex 4174927446 — a held session takes the project's tree lock, so the FIRST create
    // reserves its key and then waits on the tree lock with the reservation uncommitted. The SECOND
    // create then finds no committed receipt (no fast-path replay) and blocks on the reservation's
    // unique index. Releasing the holder lets the first commit; the second's insert fails on the
    // unique key and replays the winner. Both calls are observed blocked before the release.
    const input = { name: 'Idem Concurrent', kind: 'zone' as const, parentId: null, publish: true };
    const other = new PrismaClient();
    try {
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const heldArrived = new Promise<void>((r) => { held = r; });
      const holder = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', treeLockKey(p()));
        held();
        await released;
      }, { timeout: 30_000 });
      await heldArrived;

      const first = svc.create(p(), input, pmc(), 'k-cc');
      await blocked(first, await ungrantedLocks()); // reserved, waiting on the tree lock
      const second = svc.create(p(), input, pmc(), 'k-cc');
      await blocked(second, await ungrantedLocks()); // waiting on the first's reservation

      release();
      await holder;
      const [a, b] = await Promise.all([first, second]);
      expect(b.createdNodeId).toBe(a.createdNodeId); // the replayed loser names the winner's place
    } finally {
      await other.$disconnect();
    }
    expect(await zones('Idem Concurrent')).toBe(1);
    const node = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p(), name: 'Idem Concurrent' } });
    expect(await t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'node.created', entityId: node.id } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'nodes.create', idempotencyKey: 'k-cc' } })).toBe(1);
  });

  it('a DIFFERENT body under the same key is a 409 and adds nothing', async () => {
    await svc.create(p(), { name: 'Idem First', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-diff');
    await expect(svc.create(p(), { name: 'Idem Second', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-diff'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await zones('Idem Second')).toBe(0);
  });

  it('an unkeyed create still creates a new name', async () => {
    const a = await svc.create(p(), { name: 'Idem Unkeyed A', kind: 'zone', parentId: null, publish: true }, pmc());
    const b = await svc.create(p(), { name: 'Idem Unkeyed B', kind: 'zone', parentId: null, publish: true }, pmc());
    expect(await zones('Idem Unkeyed A')).toBe(1);
    expect(await zones('Idem Unkeyed B')).toBe(1);
    expect(a.createdNodeId).not.toBe(b.createdNodeId);
  });

  // #704 redesign — a name already held under the same parent is the place's natural key: a second
  // create of it, whatever its key (a fresh key from another tab or after a reload, or none), makes
  // nothing and names the place that holds it.
  it('a create of a name the parent already holds, under ANY key, names that place and adds nothing', async () => {
    const first = await svc.create(p(), { name: 'Idem Kitchen', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-tab-a');
    const node = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p(), name: 'Idem Kitchen' } });
    const events = () => t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'node.created' } });
    const before = await events();
    const otherKey = await svc.create(p(), { name: 'Idem Kitchen', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-tab-b');
    const unkeyed = await svc.create(p(), { name: 'Idem Kitchen', kind: 'zone', parentId: null, publish: true }, pmc());
    const spaced = await svc.create(p(), { name: '  idem   KITCHEN ', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-tab-c');
    expect(first.createdNodeId).toBe(node.id);
    expect([otherKey.createdNodeId, unkeyed.createdNodeId, spaced.createdNodeId]).toEqual([node.id, node.id, node.id]);
    expect(await t.prisma.projectNode.count({ where: { projectId: p(), name: { startsWith: 'Idem ' } } })).toBe(1);
    expect(await events()).toBe(before); // nothing was created, so nothing was announced
  });

  it('the same name under a DIFFERENT parent is a different place', async () => {
    const a = await svc.create(p(), { name: 'Idem Floor A', kind: 'zone', parentId: null, publish: true }, pmc());
    const b = await svc.create(p(), { name: 'Idem Floor B', kind: 'zone', parentId: null, publish: true }, pmc());
    const inA = await svc.create(p(), { name: 'Idem Pantry', kind: 'room', parentId: a.createdNodeId, publish: true }, pmc());
    const inB = await svc.create(p(), { name: 'Idem Pantry', kind: 'room', parentId: b.createdNodeId, publish: true }, pmc());
    expect(inA.createdNodeId).not.toBe(inB.createdNodeId);
    expect(await t.prisma.projectNode.count({ where: { projectId: p(), name: 'Idem Pantry' } })).toBe(2);
  });

  it('the name held by a place of another kind is a 409 and adds nothing', async () => {
    const zone = await svc.create(p(), { name: 'Idem Wing', kind: 'zone', parentId: null, publish: true }, pmc());
    await svc.create(p(), { name: 'Idem Door', kind: 'room', parentId: zone.createdNodeId, publish: true }, pmc());
    await expect(svc.create(p(), { name: 'idem door', kind: 'element', parentId: zone.createdNodeId, publish: true }, pmc(), 'k-kind'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.projectNode.count({ where: { projectId: p(), parentId: zone.createdNodeId } })).toBe(1);
  });

  const owner = (): AuthUser => ({ sub: f.ownerUser.id, role: 'owner', projectId: f.projectA.id }) as AuthUser;

  it('another author\'s PRIVATE draft never counts: it is not named in a 409 nor returned as the created place', async () => {
    const zone = await svc.create(p(), { name: 'Idem Shared Wing', kind: 'zone', parentId: null, publish: true }, pmc());
    const draft = await svc.create(p(), { name: 'Idem Secret', kind: 'room', parentId: zone.createdNodeId, publish: false }, pmc());
    const hidden = await svc.create(p(), { name: 'Idem Hidden', kind: 'room', parentId: zone.createdNodeId, publish: false }, pmc());
    // another kind under a draft's name: no 409 that would quote it — the owner's object is made
    const other = await svc.create(p(), { name: 'idem hidden', kind: 'element', parentId: zone.createdNodeId, publish: true }, owner());
    expect(other.createdNodeId).not.toBe(hidden.createdNodeId);
    // the same kind: the owner gets a place of their own, one their own tree holds
    const mine = await svc.create(p(), { name: 'Idem Secret', kind: 'room', parentId: zone.createdNodeId, publish: true }, owner());
    expect(mine.createdNodeId).not.toBe(draft.createdNodeId);
    expect(mine.nodes.some((n) => n.id === mine.createdNodeId)).toBe(true);
    expect(mine.nodes.some((n) => n.id === draft.createdNodeId)).toBe(false);
    // the draft's author still finds their own draft by its name
    const again = await svc.create(p(), { name: 'Idem Secret', kind: 'room', parentId: zone.createdNodeId, publish: false }, pmc());
    expect(again.createdNodeId).toBe(draft.createdNodeId);
  });

  it('where places made before the rule share a name across kinds, a create names the one of ITS kind', async () => {
    const zone = await svc.create(p(), { name: 'Idem Mixed Wing', kind: 'zone', parentId: null, publish: true }, pmc());
    // a room first in order, then an object of the same name (legacy rows, made before the rule)
    await t.prisma.projectNode.create({ data: { projectId: p(), parentId: zone.createdNodeId, name: 'Idem Store', kind: 'room', order: 0, authorId: f.memberUser.id, publishedAt: new Date() } });
    const object = await t.prisma.projectNode.create({ data: { projectId: p(), parentId: zone.createdNodeId, name: 'Idem Store', kind: 'element', order: 1, authorId: f.memberUser.id, publishedAt: new Date() } });
    const again = await svc.create(p(), { name: 'Idem Store', kind: 'element', parentId: zone.createdNodeId, publish: true }, pmc());
    expect(again.createdNodeId).toBe(object.id);
  });

  it('asked to PUBLISH, a name held by the caller\'s own draft is a 409, never a success that left it hidden', async () => {
    const zone = await svc.create(p(), { name: 'Idem Draft Wing', kind: 'zone', parentId: null, publish: true }, pmc());
    const draft = await svc.create(p(), { name: 'Idem Larder', kind: 'room', parentId: zone.createdNodeId, publish: false }, pmc());
    await expect(svc.create(p(), { name: 'Idem Larder', kind: 'room', parentId: zone.createdNodeId, publish: true }, pmc(), 'k-publish'))
      .rejects.toBeInstanceOf(ConflictException);
    expect((await t.prisma.projectNode.findUniqueOrThrow({ where: { id: draft.createdNodeId } })).publishedAt).toBeNull();
    // the same draft intent still names it (a retry of the draft create)
    const retry = await svc.create(p(), { name: 'Idem Larder', kind: 'room', parentId: zone.createdNodeId, publish: false }, pmc());
    expect(retry.createdNodeId).toBe(draft.createdNodeId);
    // under a DRAFT parent nothing can publish, so a publish:true retry there still names the draft
    const draftZone = await svc.create(p(), { name: 'Idem Draft Floor', kind: 'zone', parentId: null, publish: false }, pmc());
    const child = await svc.create(p(), { name: 'Idem Nook', kind: 'room', parentId: draftZone.createdNodeId, publish: true }, pmc());
    const childRetry = await svc.create(p(), { name: 'Idem Nook', kind: 'room', parentId: draftZone.createdNodeId, publish: true }, pmc());
    expect(childRetry.createdNodeId).toBe(child.createdNodeId);
  });

  it('a RENAME to a name another place under the parent holds is a 409; a respacing of its own name is not', async () => {
    const zone = await svc.create(p(), { name: 'Idem Rename Wing', kind: 'zone', parentId: null, publish: true }, pmc());
    const kitchen = await svc.create(p(), { name: 'Idem Kitchen', kind: 'room', parentId: zone.createdNodeId, publish: true }, pmc());
    const pantry = await svc.create(p(), { name: 'Idem Pantry', kind: 'room', parentId: zone.createdNodeId, publish: true }, pmc());
    await expect(svc.rename(p(), pantry.createdNodeId, { name: 'idem  KITCHEN' }, pmc())).rejects.toBeInstanceOf(ConflictException);
    expect((await t.prisma.projectNode.findUniqueOrThrow({ where: { id: pantry.createdNodeId } })).name).toBe('Idem Pantry');
    await svc.rename(p(), kitchen.createdNodeId, { name: 'Idem kitchen' }, pmc());
    expect((await t.prisma.projectNode.findUniqueOrThrow({ where: { id: kitchen.createdNodeId } })).name).toBe('Idem kitchen');
  });

  it('a MOVE into a parent that holds the name is a 409; a reorder among places that already share a name is not', async () => {
    const a = await svc.create(p(), { name: 'Idem Move A', kind: 'zone', parentId: null, publish: true }, pmc());
    const b = await svc.create(p(), { name: 'Idem Move B', kind: 'zone', parentId: null, publish: true }, pmc());
    const inA = await svc.create(p(), { name: 'Idem Store', kind: 'room', parentId: a.createdNodeId, publish: true }, pmc());
    await svc.create(p(), { name: 'Idem Store', kind: 'room', parentId: b.createdNodeId, publish: true }, pmc());
    await expect(svc.move(p(), inA.createdNodeId, { parentId: b.createdNodeId }, pmc())).rejects.toBeInstanceOf(ConflictException);
    expect((await t.prisma.projectNode.findUniqueOrThrow({ where: { id: inA.createdNodeId } })).parentId).toBe(a.createdNodeId);
    // two places made before the rule that share a name may still be reordered within their parent
    const legacy = await t.prisma.projectNode.create({ data: { projectId: p(), parentId: a.createdNodeId, name: 'Idem Store', kind: 'room', order: 9, authorId: f.memberUser.id, publishedAt: new Date() } });
    await svc.move(p(), legacy.id, { parentId: a.createdNodeId, order: 0 }, pmc());
    expect((await t.prisma.projectNode.findUniqueOrThrow({ where: { id: legacy.id } })).order).toBe(0);
  });

  it('a DELETE waits on the tree lock, so it serializes with a create that names its place (barrier)', async () => {
    // A create that names an existing place reads it under the tree lock; a delete that ignored the
    // lock could commit in between and leave the create naming a place that is gone. Holding the
    // lock, the delete must block; released, it commits, and a create of that name makes a new place.
    const zone = await svc.create(p(), { name: 'Idem Doomed', kind: 'zone', parentId: null, publish: true }, pmc());
    const other = new PrismaClient();
    try {
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const heldArrived = new Promise<void>((r) => { held = r; });
      const holder = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', treeLockKey(p()));
        held();
        await released;
      }, { timeout: 30_000 });
      await heldArrived;
      const removal = svc.remove(p(), zone.createdNodeId, pmc());
      await blocked(removal, await ungrantedLocks());
      release();
      await holder;
      await removal;
    } finally {
      await other.$disconnect();
    }
    const again = await svc.create(p(), { name: 'Idem Doomed', kind: 'zone', parentId: null, publish: true }, pmc(), 'k-after-delete');
    expect(again.createdNodeId).not.toBe(zone.createdNodeId);
    expect(again.nodes.some((n) => n.id === again.createdNodeId)).toBe(true);
  });

  it('two CONCURRENT creates of one name under DIFFERENT keys resolve to one place (barrier)', async () => {
    // The cross-tab case the client key could not cover: each tab minted its own key. Both creates
    // reserve distinct keys and wait on the held tree lock; released, the first creates and the
    // second finds the name held and names the same place.
    const input = { name: 'Idem Two Tabs', kind: 'zone' as const, parentId: null, publish: true };
    const other = new PrismaClient();
    try {
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const heldArrived = new Promise<void>((r) => { held = r; });
      const holder = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', treeLockKey(p()));
        held();
        await released;
      }, { timeout: 30_000 });
      await heldArrived;

      const first = svc.create(p(), input, pmc(), 'k-tab-1');
      await blocked(first, await ungrantedLocks());
      const second = svc.create(p(), input, pmc(), 'k-tab-2');
      await blocked(second, await ungrantedLocks());

      release();
      await holder;
      const [a, b] = await Promise.all([first, second]);
      expect(b.createdNodeId).toBe(a.createdNodeId);
    } finally {
      await other.$disconnect();
    }
    expect(await zones('Idem Two Tabs')).toBe(1);
  });
});
