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
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.auditLog.deleteMany({ where: { action: 'test.filtered' } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-scn-' } } });
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
});
