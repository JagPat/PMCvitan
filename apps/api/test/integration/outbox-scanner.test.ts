import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { registerConsumer, unregisterConsumer, syncConsumerCatalog, type OutboxConsumer } from '../../src/platform/outbox/registry';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 fix-forward PR B Task 3 — continuous gap expansion + ordered no-ops (live PG).
 *
 * Proves: an ordered no-op advances the cursor through its position WITHOUT invoking the handler
 * (never a stall, never a skip); the scanner repairs a consumer registered AFTER events exist;
 * concurrent scanners are idempotent (one delivery per event/consumer); and an exact-next dead
 * position visibly BLOCKS an ordered consumer rather than skipping it. Barriers (Promise.all), no
 * fixed sleeps.
 */

const FILTERED = 'test.filtered.ordered';
const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

// An ordered consumer that DISPATCHES only for entityIds starting 'GO-', else a recorded ordered
// no-op — so a project stream mixes dispatch + noop positions the cursor must still cover in order.
const filtered: OutboxConsumer = {
  name: FILTERED, kind: 'ordered', effect: 'db', catalogVersion: 1,
  deliveryFor: (meta) => (meta.entityId.startsWith('GO-') ? { action: 'dispatch' } : { action: 'noop' }),
  handle: async (ctx) => {
    if (!ctx.tx) throw new Error('ordered consumer needs a tx');
    await ctx.tx.auditLog.create({ data: { projectId: ctx.meta.projectId, actor: 'flt', actorId: 'flt', actorRole: 'system', action: 'test.filtered', entity: 'Ev', entityId: ctx.meta.eventId } });
  },
};

describe('PR B Task 3 — expansion scanner + ordered no-ops (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    human.actorId = f.memberUser.id;
    registerConsumer(filtered);
    await syncConsumerCatalog(t.prisma);
  });
  afterAll(async () => {
    unregisterConsumer(FILTERED);
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t?.prisma.outboxConsumerCatalog.deleteMany({ where: { consumer: FILTERED } });
    await f?.cleanup();
    await t?.close();
  });
  // Ad-hoc consumers registered by individual tests. Cleaned in afterEach (runs even on failure) so
  // no test leaks a registry entry or a (deactivated) catalog row into the shared test DB — otherwise
  // a failed run would leave a consumer inactive and syncConsumerCatalog does not (by design)
  // reactivate it, poisoning later runs.
  const AD_HOC = ['test.late.unordered', 'test.bounded.unordered', 'test.inactive.unordered', 'test.pause.ordered', 'test.latefiltered.ordered', 'test.absentcode.unordered'];
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.auditLog.deleteMany({ where: { action: { in: ['test.filtered', 'test.pause'] } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-scn-' } } });
    for (const c of AD_HOC) unregisterConsumer(c);
    await t.prisma.outboxConsumerCatalog.deleteMany({ where: { consumer: { in: AD_HOC } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-scn-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({ data: { id, orgId: f.orgA.id, name: id, short: 'S', descriptor: '', stage: 'x', siteCode: 'S', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 } });
    return id;
  };
  const emit = (projectId: string, entityId: string) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId }));
  const cursor = (consumer: string, projectId: string) =>
    t.prisma.projectionCursor.findUnique({ where: { consumer_projectId: { consumer, projectId } } });
  const effects = (projectId: string) => t.prisma.auditLog.count({ where: { action: 'test.filtered', projectId } });

  it('an ordered no-op advances the cursor through its position without invoking the handler; a later dispatch still applies', async () => {
    const p = await freshProject();
    const { eventId: e0 } = await emit(p, 'NP-0'); // pos 0 → ordered no-op
    await emit(p, 'GO-1'); // pos 1 → dispatch
    await relay.runOnce();
    const cur = await cursor(FILTERED, p);
    expect(cur?.appliedPosition).toBe(1n); // advanced contiguously through the no-op
    expect(cur?.status).toBe('live');
    expect(await effects(p)).toBe(1); // handler ran ONLY for the dispatch position
    const d0 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: FILTERED, eventId: e0 } });
    expect(d0.deliveryAction).toBe('noop');
    expect(d0.status).toBe('succeeded');
  });

  it('the scanner repairs a consumer registered AFTER events exist (historical dispatch + no-op rows)', async () => {
    const p = await freshProject();
    await emit(p, 'GO-a');
    await emit(p, 'NP-b');
    // a brand-new unordered consumer, registered only now — it has NO deliveries for the prior events
    const LATE = 'test.late.unordered';
    const late: OutboxConsumer = { name: LATE, kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} };
    registerConsumer(late);
    await syncConsumerCatalog(t.prisma);
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: LATE } })).toBe(0);
    const created = await relay.expandMissingDeliveries();
    expect(created).toBeGreaterThanOrEqual(2);
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: LATE, projectId: p } })).toBe(2);
    unregisterConsumer(LATE);
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: LATE } });
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: LATE } });
  });

  it('two concurrent scanners create exactly one delivery per event/consumer (idempotent)', async () => {
    const p = await freshProject();
    await emit(p, 'GO-x');
    await emit(p, 'NP-y');
    await emit(p, 'GO-z');
    // clear the auto-materialized rows so both scanners must (re)create them, racing on the unique
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: FILTERED, projectId: p } });
    await Promise.all([relay.expandMissingDeliveries(), relay.expandMissingDeliveries()]);
    const rows = await t.prisma.outboxDelivery.findMany({ where: { consumer: FILTERED, projectId: p } });
    expect(rows).toHaveLength(3); // exactly one per event — no duplicates
  });

  it('an exact-next dead position visibly BLOCKS the ordered consumer — the cursor never skips it', async () => {
    const p = await freshProject();
    const { eventId: e0 } = await emit(p, 'GO-0'); // pos 0
    const { eventId: e1 } = await emit(p, 'GO-1'); // pos 1
    const d0 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: FILTERED, eventId: e0 } });
    const d1 = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: FILTERED, eventId: e1 } });
    await t.prisma.outboxDelivery.update({ where: { id: d0.id }, data: { status: 'dead' } });
    expect(await relay.dispatchOne(d1.id)).toBe('blocked');
    const cur = await cursor(FILTERED, p);
    expect(cur?.status).toBe('blocked');
    expect(cur?.appliedPosition ?? null).toBeNull(); // nothing applied — pos 1 was NOT skipped over pos 0
    expect(await effects(p)).toBe(0);
  });

  // ── PR B correction round 1 (Codex BLOCKED) ────────────────────────────────────────────────────

  // Finding 2 (P2): expansion must be BOUNDED per invocation — one call creates at most `batchSize`
  // rows for a consumer, and successive relay ticks drain the rest. RED at main: the inner drain loop
  // creates all five in the first call.
  it('expansion is bounded per invocation: five owed obligations with batchSize=2 create at most two per call, draining over passes', async () => {
    const p = await freshProject();
    for (const e of ['GO-1', 'GO-2', 'GO-3', 'GO-4', 'GO-5']) await emit(p, e); // five events before the consumer exists
    const LATE = 'test.bounded.unordered';
    const late: OutboxConsumer = { name: LATE, kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} };
    registerConsumer(late);
    await syncConsumerCatalog(t.prisma);
    const owed = () => t.prisma.outboxDelivery.count({ where: { consumer: LATE, projectId: p } });
    expect(await owed()).toBe(0);
    await relay.expandMissingDeliveries(2);
    expect(await owed()).toBe(2); // one bounded batch — NOT the whole backlog
    await relay.expandMissingDeliveries(2);
    expect(await owed()).toBe(4);
    await relay.expandMissingDeliveries(2);
    expect(await owed()).toBe(5); // drained over successive passes
    unregisterConsumer(LATE);
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: LATE } });
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: LATE } });
  });

  // Finding 1 (P1): OutboxConsumerCatalog.active is authoritative at MATERIALIZE — a deactivated
  // contract accrues NO new delivery on a fresh event. RED at main: materializeDeliveries ignores
  // active and writes a row.
  it('a deactivated catalog consumer accrues NO delivery on a new event (active authoritative at materialize)', async () => {
    const p = await freshProject();
    const OFF = 'test.inactive.unordered';
    const off: OutboxConsumer = { name: OFF, kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'dispatch' }), handle: async () => {} };
    registerConsumer(off);
    await syncConsumerCatalog(t.prisma);
    await t.prisma.outboxConsumerCatalog.update({ where: { consumer: OFF }, data: { active: false } });
    await emit(p, 'GO-off');
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: OFF } })).toBe(0);
    unregisterConsumer(OFF);
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: OFF } });
  });

  // Finding 1 (P1): active is authoritative at CLAIM/DISPATCH too, and guards the claim→handle race —
  // deactivating after a delivery exists stops the handler, leaves the row PENDING (recoverable), and
  // reactivation resumes it. RED at main: dispatchOne runs the handler and succeeds the row.
  it('deactivating after a delivery exists stops dispatch (no handler, row stays pending); reactivation resumes it', async () => {
    const p = await freshProject();
    const PAUSE = 'test.pause.ordered';
    const ran = () => t.prisma.auditLog.count({ where: { action: 'test.pause', projectId: p } });
    const pause: OutboxConsumer = {
      name: PAUSE, kind: 'ordered', effect: 'db', catalogVersion: 1,
      deliveryFor: () => ({ action: 'dispatch' }),
      handle: async (ctx) => { if (!ctx.tx) throw new Error('tx'); await ctx.tx.auditLog.create({ data: { projectId: ctx.meta.projectId, actor: 'pz', actorId: 'pz', actorRole: 'system', action: 'test.pause', entity: 'Ev', entityId: ctx.meta.eventId } }); },
    };
    registerConsumer(pause);
    await syncConsumerCatalog(t.prisma);
    const { eventId } = await emit(p, 'GO-pause'); // pos 0 → pending dispatch row
    const d = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: PAUSE, eventId } });
    await t.prisma.outboxConsumerCatalog.update({ where: { consumer: PAUSE }, data: { active: false } });
    expect(await relay.dispatchOne(d.id)).toBe('skip');
    expect(await ran()).toBe(0); // handler never invoked for a deactivated contract
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('pending'); // recoverable, not dead-lettered
    await t.prisma.outboxConsumerCatalog.update({ where: { consumer: PAUSE }, data: { active: true } });
    expect(await relay.dispatchOne(d.id)).toBe('succeeded'); // reactivation resumes the pending work
    expect(await ran()).toBe(1);
    unregisterConsumer(PAUSE);
    await t.prisma.auditLog.deleteMany({ where: { action: 'test.pause' } });
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: PAUSE } });
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: PAUSE } });
  });

  // Finding 3 (P2): prove the claim the packet made but the old noop-only test did NOT — a filtered
  // consumer registered late gets BOTH a dispatch row and a no-op row, each derived from the persisted
  // event envelope. (Correct at main and head; this closes an evidence-accuracy gap.)
  it('the scanner derives each plan from the persisted envelope — a late filtered consumer gets BOTH a dispatch and a no-op row', async () => {
    const p = await freshProject();
    const { eventId: eGo } = await emit(p, 'GO-mix');
    const { eventId: eNp } = await emit(p, 'NP-mix');
    const LATEF = 'test.latefiltered.ordered';
    const latef: OutboxConsumer = {
      name: LATEF, kind: 'ordered', effect: 'db', catalogVersion: 1,
      deliveryFor: (m) => (m.entityId.startsWith('GO-') ? { action: 'dispatch' } : { action: 'noop' }),
      handle: async () => {},
    };
    registerConsumer(latef);
    await syncConsumerCatalog(t.prisma);
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: LATEF } })).toBe(0);
    await relay.expandMissingDeliveries();
    const rows = await t.prisma.outboxDelivery.findMany({ where: { consumer: LATEF, projectId: p } });
    const byEvent = Object.fromEntries(rows.map((r) => [r.eventId, r.deliveryAction]));
    expect(byEvent[eGo]).toBe('dispatch'); // persisted GO- envelope → dispatch
    expect(byEvent[eNp]).toBe('noop'); // persisted NP- envelope → recorded no-op
    unregisterConsumer(LATEF);
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: LATEF } });
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: LATEF } });
  });

  // Finding 3 (P2): explicitly prove the crash / old-instance case — a catalog contract persisted while
  // this instance's consumer CODE is absent creates nothing (never guesses a plan), and is repaired by
  // the scanner once the code registers. (Correct at main and head; closes an evidence-accuracy gap.)
  it('a catalog contract persisted while its consumer code is absent is repaired by the scanner once the code registers', async () => {
    const p = await freshProject();
    const ABSENT = 'test.absentcode.unordered';
    await t.prisma.outboxConsumerCatalog.create({ data: { consumer: ABSENT, consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 } });
    await emit(p, 'GO-x');
    await emit(p, 'GO-y');
    await relay.expandMissingDeliveries(); // code absent → nothing derived (never guessed)
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: ABSENT } })).toBe(0);
    const absent: OutboxConsumer = { name: ABSENT, kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} };
    registerConsumer(absent);
    await relay.expandMissingDeliveries(); // code now present → gap repaired
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: ABSENT, projectId: p } })).toBe(2);
    unregisterConsumer(ABSENT);
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: ABSENT } });
    await t.prisma.outboxConsumerCatalog.delete({ where: { consumer: ABSENT } });
  });
});
