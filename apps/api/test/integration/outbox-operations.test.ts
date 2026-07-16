import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxOperationsService } from '../../src/platform/outbox/outbox-operations.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { registerConsumer, unregisterConsumer, syncConsumerCatalog, type OutboxConsumer } from '../../src/platform/outbox/registry';
import { effectCoverageVersion } from '../../src/platform/external-effects';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 fix-forward PR B Task 4 — audited dead-letter operations (live PG). status aggregates +
 * truncates errors (no payloads); retry accepts only a dead delivery, requires operator+reason,
 * resets it + writes ONE audit row, and un-blocks an ordered cursor ONLY at the exact-next position
 * without advancing appliedPosition.
 */
const ORD = 'test.ops.ordered';
const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };
const ordered: OutboxConsumer = {
  name: ORD, kind: 'ordered', effect: 'db', catalogVersion: 1,
  deliveryFor: () => ({ action: 'dispatch' }),
  handle: async (ctx) => { if (!ctx.tx) throw new Error('tx'); await ctx.tx.auditLog.create({ data: { projectId: ctx.meta.projectId, actor: 'o', actorId: 'o', actorRole: 'system', action: 'test.ops', entity: 'Ev', entityId: ctx.meta.eventId } }); },
};

describe('PR B Task 4 — outbox operations (live PG)', () => {
  let t: TestApp; let f: TwoProjectFixture; let ops: OutboxOperationsService; let relay: OutboxRelay; let seq = 0;
  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    ops = t.app.get(OutboxOperationsService);
    relay = t.app.get(OutboxRelay);
    human.actorId = f.memberUser.id;
    registerConsumer(ordered);
    await syncConsumerCatalog(t.prisma);
  });
  afterAll(async () => {
    unregisterConsumer(ORD);
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "OutboxOperatorAction"');
    await t?.prisma.outboxConsumerCatalog.deleteMany({ where: { consumer: ORD } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "OutboxOperatorAction"');
    await t.prisma.auditLog.deleteMany({ where: { action: 'test.ops' } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-ops-' } } });
  });
  const freshProject = async () => { const id = `it-ops-${Date.now() % 1e6}-${seq++}`; await t.prisma.project.create({ data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 } }); return id; };
  const emit = (p: string, e: string) => t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: e, effectKey: 'decision.approved', dispatch: {} }));
  const deliveryFor = (eventId: string) => t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer: ORD, eventId } });

  it('status aggregates counts and truncates the error — no payloads or secrets', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-1');
    const d = await deliveryFor(eventId);
    await t.prisma.outboxDelivery.update({ where: { id: d.id }, data: { status: 'dead', lastError: 'x'.repeat(500) } });
    const s = await ops.status();
    expect(s.dead).toBe(1);
    expect(s.deadRows).toHaveLength(1);
    expect(s.deadRows[0].lastError!.length).toBeLessThanOrEqual(201);
    expect(s.deadRows[0]).not.toHaveProperty('payload');
  });

  it('retry requires a nonblank operator identity and reason', async () => {
    await expect(ops.retry({ deliveryId: 'x', operatorIdentity: '   ', reason: 'r' })).rejects.toThrow(/operator/i);
    await expect(ops.retry({ deliveryId: 'x', operatorIdentity: 'op', reason: '  ' })).rejects.toThrow(/reason/i);
  });

  it('retry rejects a non-dead delivery and a missing delivery', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-2');
    const d = await deliveryFor(eventId); // 'pending'
    await expect(ops.retry({ deliveryId: d.id, operatorIdentity: 'op', reason: 'r' })).rejects.toThrow(/only a 'dead'/);
    await expect(ops.retry({ deliveryId: '00000000-0000-0000-0000-000000000000', operatorIdentity: 'op', reason: 'r' })).rejects.toThrow(/not found/);
  });

  it('retry resets a dead delivery to pending, clears the error, and writes exactly one audit row', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-3'); // pos 0 → exact-next for a null cursor
    const d = await deliveryFor(eventId);
    await t.prisma.outboxDelivery.update({ where: { id: d.id }, data: { status: 'dead', attempts: 5, lastError: 'boom' } });
    const { auditId } = await ops.retry({ deliveryId: d.id, operatorIdentity: 'ops@vitan', reason: 'transient db blip' });
    const after = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(after.lastError).toBeNull();
    const audit = await t.prisma.outboxOperatorAction.findUniqueOrThrow({ where: { id: auditId } });
    expect(audit).toMatchObject({ action: 'retry', deliveryId: d.id, consumer: ORD, operatorIdentity: 'ops@vitan', reason: 'transient db blip', priorError: 'boom' });
    expect(await t.prisma.outboxOperatorAction.count()).toBe(1);
  });

  it('ordered retry un-blocks the cursor ONLY at the exact-next position and never advances appliedPosition', async () => {
    const p = await freshProject();
    const { eventId: e0 } = await emit(p, 'D-a'); // pos 0
    const { eventId: e1 } = await emit(p, 'D-b'); // pos 1
    const d0 = await deliveryFor(e0);
    const d1 = await deliveryFor(e1);
    // block: pos 0 dead, dispatching pos 1 blocks the cursor
    await t.prisma.outboxDelivery.update({ where: { id: d0.id }, data: { status: 'dead' } });
    expect(await relay.dispatchOne(d1.id)).toBe('blocked');
    // retrying pos 1 (NOT exact-next) is rejected
    await t.prisma.outboxDelivery.update({ where: { id: d1.id }, data: { status: 'dead' } });
    await expect(ops.retry({ deliveryId: d1.id, operatorIdentity: 'op', reason: 'r' })).rejects.toThrow(/next expected/);
    // retrying pos 0 (exact-next) un-blocks + resets; appliedPosition stays null (never advanced)
    await ops.retry({ deliveryId: d0.id, operatorIdentity: 'op', reason: 'r' });
    const cur = await t.prisma.projectionCursor.findUniqueOrThrow({ where: { consumer_projectId: { consumer: ORD, projectId: p } } });
    expect(cur.status).toBe('live');
    expect(cur.appliedPosition ?? null).toBeNull();
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d0.id } })).status).toBe('pending');
  });

  // PR B correction round 1 (Codex finding 3): prove the inactive-contract retry rejection the packet
  // claimed but did not test — retry refuses a dead delivery whose catalog contract is inactive and
  // mutates NOTHING (the row stays dead, no audit row is written). The guard runs inside the retry
  // transaction, so a throw rolls back before any write.
  it('retry rejects a delivery whose catalog contract is inactive — no reset, no audit row', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-off');
    const d = await deliveryFor(eventId);
    await t.prisma.outboxDelivery.update({ where: { id: d.id }, data: { status: 'dead', lastError: 'boom' } });
    await t.prisma.outboxConsumerCatalog.update({ where: { consumer: ORD }, data: { active: false } });
    try {
      await expect(ops.retry({ deliveryId: d.id, operatorIdentity: 'op', reason: 'r' })).rejects.toThrow(/active catalog contract/i);
      expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('dead'); // unchanged
      expect(await t.prisma.outboxOperatorAction.count()).toBe(0); // no audit mutation
    } finally {
      await t.prisma.outboxConsumerCatalog.update({ where: { consumer: ORD }, data: { active: true } }); // restore for later tests
    }
  });

  // PR C Task 3 — the seal is an AUDITED operator action, keyed on the compiled coverage version.
  it('sealExternal pins the compiled coverage + writes a seal-external operator audit; input is required', async () => {
    await expect(ops.sealExternal({ operatorIdentity: '', reason: 'x' })).rejects.toThrow(/operator identity/);
    await expect(ops.sealExternal({ operatorIdentity: 'op', reason: '' })).rejects.toThrow(/reason/);
    try {
      const res = await ops.sealExternal({ operatorIdentity: 'ops@vitan.in', reason: 'phase-2 cutover' });
      expect(res.coverageVersion).toBe(effectCoverageVersion());
      const audit = await t.prisma.outboxOperatorAction.findUniqueOrThrow({ where: { id: res.auditId } });
      expect(audit.action).toBe('seal-external');
      expect(audit.operatorIdentity).toBe('ops@vitan.in');
      expect((await t.prisma.outboxCutoverState.findUniqueOrThrow({ where: { key: 'singleton' } })).coverageVersion).toBe(effectCoverageVersion());
    } finally {
      await t.prisma.$executeRawUnsafe('DELETE FROM "OutboxCutoverState"'); // clear the singleton so later files' raw legacy inserts aren't rejected
    }
  });
});
