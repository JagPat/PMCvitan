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
 * A place has no natural key (two rooms may share a name), so before this a double submit, or a
 * retry sent while the first request was still in flight, created two same-named siblings. The
 * create now runs through the command ledger: the same key + body creates the place once and
 * replays; concurrent same-key creates resolve to one winner; a different body under the key is a
 * 409; an unkeyed create keeps today's behavior.
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
    await svc.create(p(), input, pmc(), 'k-node');
    await svc.create(p(), input, pmc(), 'k-node'); // retry after a lost reply
    expect(await zones('Idem Ground')).toBe(1);
    const node = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: p(), name: 'Idem Ground' } });
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
      await Promise.all([first, second]);
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

  it('unkeyed creates keep today\'s behavior (each one creates)', async () => {
    const input = { name: 'Idem Unkeyed', kind: 'zone' as const, parentId: null, publish: true };
    await svc.create(p(), input, pmc());
    await svc.create(p(), input, pmc());
    expect(await zones('Idem Unkeyed')).toBe(2);
  });
});
