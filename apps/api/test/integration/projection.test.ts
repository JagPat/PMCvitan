import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { registerConsumer, unregisterConsumer, syncConsumerCatalog, type OutboxConsumer, type ProjectionTarget } from '../../src/platform/outbox/registry';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 9 Step 1 — the projection base: generation-swap rebuild + the FINAL ACTIVATION
 * BARRIER, proven against live PostgreSQL.
 *
 * The live relay applies each ordered `db` projection delivery into the ACTIVE generation, advancing
 * its checkpoint contiguously; a rebuild builds a fresh generation from a canonical seed + event
 * replay and swaps it in behind a barrier that reads the final position H under the ProjectEventStream
 * lock, applies through H, then atomically activates the new generation (checkpoint == H) and retires
 * the old one before releasing the lock. The critical invariants: a write held exactly at the handoff
 * lands in the NEW generation (> H), a concurrent relay-vs-rebuild leaves every event in the activated
 * generation EXACTLY ONCE, and the DB permits at most one active generation per (consumer, projectId).
 */

const PROJ = 'test.projgen'; // generic replay-only projection
const SEEDED = 'test.projgen.seeded'; // a projection with a canonical seed hook
const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A projection whose per-event effect is ONE AuditLog row tagged with the generation id (in
 *  `entityId`) and the stream position (in `entity`), so "gen G reflects position P exactly once" is a
 *  row count and the generation-scoping is directly observable. */
const projConsumer: OutboxConsumer = {
  name: PROJ, kind: 'ordered', effect: 'db', catalogVersion: 1,
  deliveryFor: () => ({ action: 'dispatch' }),
  projection: {
    dropGeneration: async (tx, target: ProjectionTarget) => {
      await tx.auditLog.deleteMany({ where: { action: PROJ, entityId: target.generationId } });
    },
  },
  handle: async (ctx) => {
    if (!ctx.tx) throw new Error('projection needs a tx');
    if (!ctx.projection) throw new Error('projection needs a target generation');
    await ctx.tx.auditLog.create({
      data: { projectId: ctx.meta.projectId, actor: 'projgen', actorId: 'projgen', actorRole: 'system', action: PROJ, entity: String(ctx.meta.streamPosition), entityId: ctx.projection.generationId },
    });
  },
};

/** A projection that SEEDS its generation from a canonical snapshot: it writes a row for every
 *  position ≤ a fixed `seedThrough` (simulating "the canonical state reflects through here") and
 *  returns that position, so the rebuild replays only the tail (> seedThrough). */
let seedThrough = -1n; // set per-test; -1 ⇒ nothing seeded (replay from 0)
const seededConsumer: OutboxConsumer = {
  name: SEEDED, kind: 'ordered', effect: 'db', catalogVersion: 1,
  deliveryFor: () => ({ action: 'dispatch' }),
  projection: {
    rebuildSeed: async (tx, target: ProjectionTarget) => {
      if (seedThrough < 0n) return null;
      for (let p = 0n; p <= seedThrough; p++) {
        await tx.auditLog.create({ data: { projectId: target.projectId, actor: 'seed', actorId: 'seed', actorRole: 'system', action: SEEDED, entity: String(p), entityId: target.generationId } });
      }
      return seedThrough;
    },
    dropGeneration: async (tx, target) => { await tx.auditLog.deleteMany({ where: { action: SEEDED, entityId: target.generationId } }); },
  },
  handle: async (ctx) => {
    if (!ctx.tx || !ctx.projection) throw new Error('projection needs tx + target');
    await ctx.tx.auditLog.create({ data: { projectId: ctx.meta.projectId, actor: 'seeded', actorId: 'seeded', actorRole: 'system', action: SEEDED, entity: String(ctx.meta.streamPosition), entityId: ctx.projection.generationId } });
  },
};

describe('Phase 2 Task 9 — projection generations + activation barrier (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let projSeq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    human.actorId = f.memberUser.id;
    registerConsumer(projConsumer);
    registerConsumer(seededConsumer);
    await syncConsumerCatalog(t.prisma); // the ad-hoc projection consumers need their catalog contract rows
  });
  afterAll(async () => {
    unregisterConsumer(PROJ);
    unregisterConsumer(SEEDED);
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    rebuilder.barrierHook = null;
    seedThrough = -1n;
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration"');
    await t.prisma.auditLog.deleteMany({ where: { action: { in: [PROJ, SEEDED] } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-pg-' } } });
  });

  /** A fresh project in orgA whose event stream starts at position 0 (the AFTER-INSERT trigger
   *  creates its ProjectEventStream row). */
  const freshProject = async (): Promise<string> => {
    const id = `it-pg-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  const emit = (projectId: string, entityId: string) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId, effectKey: 'decision.approved', dispatch: {} }));

  /** Dispatch every pending delivery of `consumer` for a project, in stream order, until no progress
   *  (so contiguous ordered applies all land). */
  const dispatchAll = async (consumer: string, projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const outcome = await relay.dispatchOne(d.id);
        if (outcome === 'succeeded' || outcome === 'duplicate' || outcome === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  const effectsInGen = (consumer: string, generationId: string) =>
    t.prisma.auditLog.count({ where: { action: consumer, entityId: generationId } });
  const activeGen = (consumer: string, projectId: string) =>
    t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer, projectId, status: 'active' } });

  it('the live relay applies deliveries into a lazily-bootstrapped active generation, contiguously and exactly-once', async () => {
    const p = await freshProject();
    await emit(p, 'D0');
    await emit(p, 'D1');
    await emit(p, 'D2');
    await dispatchAll(PROJ, p);

    const gen = await activeGen(PROJ, p);
    expect(gen.generation).toBe(1); // bootstrapped generation 1
    expect(gen.appliedPosition).toBe(2n); // advanced contiguously through the last position
    expect(gen.cursorStatus).toBe('live');
    expect(await effectsInGen(PROJ, gen.id)).toBe(3); // one effect per event, no duplicate
    expect(await t.prisma.projectionGeneration.count({ where: { consumer: PROJ, projectId: p, status: 'active' } })).toBe(1);

    // re-dispatching an already-succeeded delivery (a crash-reclaim) is effectively-once: no re-effect
    const d0 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, projectId: p, streamPosition: 0n } });
    await t.prisma.outboxDelivery.update({ where: { id: d0.id }, data: { status: 'pending' } });
    expect(await relay.dispatchOne(d0.id)).toBe('duplicate');
    expect(await effectsInGen(PROJ, gen.id)).toBe(3);
  });

  it('an ordered projection cannot apply position N+1 before N (waits), and a dead earlier position blocks its cursor', async () => {
    const p = await freshProject();
    const e0 = await emit(p, 'W0');
    const e1 = await emit(p, 'W1');
    const d0 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, eventId: e0.eventId } });
    const d1 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, eventId: e1.eventId } });

    // dispatch N+1 first — it must WAIT, not skip past the ungapped position
    expect(await relay.dispatchOne(d1.id)).toBe('wait');
    expect(await t.prisma.projectionGeneration.count({ where: { consumer: PROJ, projectId: p } })).toBe(1); // bootstrapped, nothing applied
    const g = await activeGen(PROJ, p);
    expect(g.appliedPosition).toBeNull();

    // now dead-letter position 0 → position 1 blocks the cursor (visible degradation, never a skip)
    await t.prisma.outboxDelivery.update({ where: { id: d0.id }, data: { status: 'dead', attempts: 5, lastError: 'poison' } });
    expect(await relay.dispatchOne(d1.id)).toBe('blocked');
    const blocked = await activeGen(PROJ, p);
    expect(blocked.cursorStatus).toBe('blocked');
    expect(await effectsInGen(PROJ, blocked.id)).toBe(0);
  });

  it('a rebuild replays every event into a NEW generation, activates it at checkpoint H, and retires the old one', async () => {
    const p = await freshProject();
    for (let i = 0; i < 5; i++) await emit(p, `R${i}`); // positions 0..4
    await dispatchAll(PROJ, p); // build generation 1 live
    const gen1 = await activeGen(PROJ, p);
    expect(gen1.appliedPosition).toBe(4n);

    const res = await rebuilder.rebuild(PROJ, p);
    expect(res.generation).toBe(2);
    expect(res.checkpoint).toBe(4n); // H = the last position

    const active = await activeGen(PROJ, p);
    expect(active.id).toBe(res.generationId);
    expect(active.id).not.toBe(gen1.id);
    expect(active.appliedPosition).toBe(4n);
    // the activated generation reflects every event exactly once
    expect(await effectsInGen(PROJ, res.generationId)).toBe(5);
    // exactly one active generation (the DB partial unique guarantees it); the old one is retired
    expect(await t.prisma.projectionGeneration.count({ where: { consumer: PROJ, projectId: p, status: 'active' } })).toBe(1);
    expect((await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: gen1.id } })).status).toBe('retired');

    // the decoupled cleanup drops the retired generation + its rows, leaving only the active one
    expect(await rebuilder.dropRetiredGenerations(PROJ, p)).toBe(1);
    expect(await t.prisma.projectionGeneration.count({ where: { consumer: PROJ, projectId: p } })).toBe(1);
    expect(await effectsInGen(PROJ, gen1.id)).toBe(0);
  });

  it('a rebuild from an EMPTY event stream activates a generation with a null checkpoint', async () => {
    const p = await freshProject();
    const res = await rebuilder.rebuild(PROJ, p);
    expect(res.checkpoint).toBeNull();
    const active = await activeGen(PROJ, p);
    expect(active.appliedPosition).toBeNull();
    expect(await effectsInGen(PROJ, res.generationId)).toBe(0);
  });

  it('a seeded rebuild loads the canonical snapshot then replays only the tail (each position exactly once)', async () => {
    const p = await freshProject();
    for (let i = 0; i < 6; i++) await emit(p, `S${i}`); // positions 0..5
    seedThrough = 3n; // the canonical seed reflects through position 3; replay covers 4..5

    const res = await rebuilder.rebuild(SEEDED, p);
    expect(res.checkpoint).toBe(5n);
    const active = await activeGen(SEEDED, p);
    expect(active.appliedPosition).toBe(5n);
    // 0..3 from the seed + 4..5 from replay = 6 rows, no gap, no duplicate
    expect(await effectsInGen(SEEDED, res.generationId)).toBe(6);
    for (let pos = 0; pos <= 5; pos++) {
      expect(await t.prisma.auditLog.count({ where: { action: SEEDED, entityId: res.generationId, entity: String(pos) } })).toBe(1);
    }
  });

  it('a write held exactly at the final activation handoff lands in the NEW generation (> H), never the retired one', async () => {
    const p = await freshProject();
    await emit(p, 'H0'); // position 0
    await emit(p, 'H1'); // position 1
    await dispatchAll(PROJ, p); // generation 1 applied through position 1
    const gen1 = await activeGen(PROJ, p);
    expect(gen1.appliedPosition).toBe(1n);

    let heldEmit: Promise<{ eventId: string; streamPosition: bigint }> | null = null;
    let heldResolved = false;
    let observedH: bigint | null = null;
    rebuilder.barrierHook = async (h) => {
      observedH = h;
      // a write attempted WHILE the barrier holds the ProjectEventStream lock blocks on that lock
      heldEmit = emit(p, 'HELD').then((r) => { heldResolved = true; return r; });
      await sleep(400);
      expect(heldResolved, 'the held write cannot commit while the barrier holds the stream lock').toBe(false);
    };

    const res = await rebuilder.rebuild(PROJ, p);
    expect(observedH).toBe(1n); // H = last committed position at barrier time
    expect(res.checkpoint).toBe(1n); // the new generation activates at checkpoint H

    // the barrier released — the held write now commits, and its position is H+1 = 2
    const held = await heldEmit!;
    expect(held.streamPosition).toBe(2n);

    // the new generation is active; delivering the held write applies it INTO the new generation at 2
    const active = await activeGen(PROJ, p);
    expect(active.id).toBe(res.generationId);
    await dispatchAll(PROJ, p);
    const activeAfter = await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: res.generationId } });
    expect(activeAfter.appliedPosition).toBe(2n);
    // the new generation holds every event exactly once (positions 0,1 from the barrier replay + 2 live)
    expect(await effectsInGen(PROJ, res.generationId)).toBe(3);
    // the retired generation never received the held position 2 — it landed only in the new generation
    expect(await t.prisma.auditLog.count({ where: { action: PROJ, entityId: gen1.id, entity: '2' } })).toBe(0);
  });

  it('a relay delivery concurrent with a rebuild leaves the activated generation with every event exactly once', async () => {
    const p = await freshProject();
    for (let i = 0; i < 4; i++) await emit(p, `C${i}`); // positions 0..3
    // the relay has already applied positions 0..1 into the live generation 1
    const d0 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, projectId: p, streamPosition: 0n } });
    const d1 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, projectId: p, streamPosition: 1n } });
    await relay.dispatchOne(d0.id);
    await relay.dispatchOne(d1.id);
    const gen1 = await activeGen(PROJ, p);
    expect(gen1.appliedPosition).toBe(1n);

    // rebuild: generation 2 replays 0..3 (H = 3) and activates at checkpoint 3
    const res = await rebuilder.rebuild(PROJ, p);
    expect(res.checkpoint).toBe(3n);
    expect(await effectsInGen(PROJ, res.generationId)).toBe(4); // 0..3, each once

    // the relay's still-pending deliveries (2,3) now target the NEW active generation. Positions
    // 0..3 are already reflected there (via replay), so redelivering ANY of them is a duplicate — no
    // double effect — and the checkpoint stays at 3.
    for (const pos of [2n, 3n, 0n, 1n]) {
      const d = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PROJ, projectId: p, streamPosition: pos } });
      await t.prisma.outboxDelivery.update({ where: { id: d.id }, data: { status: 'pending', leaseOwner: null, leaseExpiresAt: null } });
      expect(await relay.dispatchOne(d.id)).toBe('duplicate');
    }
    const active = await activeGen(PROJ, p);
    expect(active.appliedPosition).toBe(3n);
    expect(await effectsInGen(PROJ, res.generationId)).toBe(4); // STILL exactly once — no duplicates
  });

  it('a rebuild is per-project: it never touches another project of the same consumer', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await emit(p1, 'A0');
    await emit(p2, 'B0');
    await dispatchAll(PROJ, p1);
    await dispatchAll(PROJ, p2);
    const p2gen1 = await activeGen(PROJ, p2);

    await rebuilder.rebuild(PROJ, p1); // rebuild ONLY p1
    // p2's generation is untouched — same generation, still active, same checkpoint
    const p2after = await activeGen(PROJ, p2);
    expect(p2after.id).toBe(p2gen1.id);
    expect(p2after.generation).toBe(1);
    expect(p2after.appliedPosition).toBe(0n);
  });
});
