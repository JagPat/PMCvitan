import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';

/**
 * Phase 2 fix-forward PR B Task 1 — the durable-outbox constraint probes (live PG). Each proves a
 * constraint the pre-PR-B database LACKED: a delivery can no longer claim coordinates its event
 * does not have; a delivery action is a closed set; a consumer contract admits only the two
 * supported kind/effect pairs and a singleton cutover key; and a delivery cannot name a
 * (consumer, consumerKind) contract that is not declared in the catalog.
 */
describe('PR B Task 1 — durable outbox constraints (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const human = { actorId: '', actorName: 'Prober', actorRole: 'pmc', actorKind: 'human' as const };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t?.prisma.outboxConsumerCatalog.deleteMany({ where: { consumer: { startsWith: 'probe.' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.outboxConsumerCatalog.deleteMany({ where: { consumer: { startsWith: 'probe.' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-rel-' } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-rel-${Date.now() % 1e6}-${Math.floor(performance.now())}`;
    await t.prisma.project.create({ data: { id, orgId: f.orgA.id, name: id, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 } });
    return id;
  };
  const emit = (projectId: string) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: 'D-1', effectKey: 'decision.approved', dispatch: {} }));
  const insDelivery = (o: { eventId: string; consumer: string; kind: string; projectId: string; pos: number; action?: string }) =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxDelivery"(id,"eventId","projectId",consumer,"consumerKind","deliveryAction","streamPosition","updatedAt")
       VALUES (gen_random_uuid()::text, '${o.eventId}', '${o.projectId}', '${o.consumer}', '${o.kind}', '${o.action ?? 'dispatch'}', ${o.pos}, now())`,
    );
  const probeConsumer = () =>
    t.prisma.outboxConsumerCatalog.create({ data: { consumer: 'probe.unordered', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 } });

  it('rejects a delivery whose (projectId, streamPosition) disagrees with its event (composite FK)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p);
    await probeConsumer();
    // correct coordinates for an unmaterialized consumer commit (positive control)
    await expect(insDelivery({ eventId, consumer: 'probe.unordered', kind: 'unordered', projectId: p, pos: 0 })).resolves.toBeDefined();
    // a forged projectId — the (eventId, wrong-project, 0) triple does not exist
    await expect(insDelivery({ eventId, consumer: 'probe.unordered', kind: 'unordered', projectId: `wrong-${p}`, pos: 0 })).rejects.toThrow();
    // a forged streamPosition — the (eventId, p, 999) triple does not exist
    await expect(insDelivery({ eventId, consumer: 'probe.unordered', kind: 'unordered', projectId: p, pos: 999 })).rejects.toThrow();
  });

  it('rejects an out-of-set delivery action', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p);
    await probeConsumer();
    await expect(insDelivery({ eventId, consumer: 'probe.unordered', kind: 'unordered', projectId: p, pos: 0, action: 'sideways' })).rejects.toThrow();
  });

  it('rejects a delivery naming a (consumer, consumerKind) contract the catalog does not declare', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p);
    await probeConsumer(); // declares (probe.unordered, unordered) only
    await expect(insDelivery({ eventId, consumer: 'probe.unordered', kind: 'ordered', projectId: p, pos: 0 })).rejects.toThrow();
  });

  it('rejects an unsupported catalog kind/effect pair and an invalid kind', async () => {
    await expect(t.prisma.outboxConsumerCatalog.create({ data: { consumer: 'probe.badpair', consumerKind: 'ordered', consumerEffect: 'external', catalogVersion: 1 } })).rejects.toThrow();
    await expect(t.prisma.outboxConsumerCatalog.create({ data: { consumer: 'probe.badkind', consumerKind: 'sideways', consumerEffect: 'db', catalogVersion: 1 } })).rejects.toThrow();
    // the two supported pairs are accepted (positive control)
    await expect(t.prisma.outboxConsumerCatalog.create({ data: { consumer: 'probe.ordered', consumerKind: 'ordered', consumerEffect: 'db', catalogVersion: 1 } })).resolves.toBeDefined();
  });

  it('enforces the cutover-state singleton key', async () => {
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxCutoverState"(key,"coverageVersion","sealedBy",reason,"updatedAt") VALUES ('not-singleton','v1','op','r',now())`,
    )).rejects.toThrow();
    await t.prisma.$executeRawUnsafe(`INSERT INTO "OutboxCutoverState"(key,"coverageVersion","sealedBy",reason,"updatedAt") VALUES ('singleton','v1','op','r',now())`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "OutboxCutoverState"`);
  });
});
