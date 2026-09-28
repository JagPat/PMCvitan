import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  registerConsumer,
  unregisterConsumer,
  materializeDeliveries,
  deliveryRowsFor,
  pushPayloadFor,
  ruleOfRow,
  syncConsumerCatalog,
  type CatalogRuleRow,
  type EmittedEventMeta,
} from './registry';
import { makeSocketConsumer, makePushConsumer } from './consumers';

/**
 * Phase 2 fix-forward PR B — registry unit contract, re-stated for 4d-ii-a / A6d: the delivery rows
 * are a PURE FUNCTION of the event and the PERSISTED catalog (`deliveryRowsFor`), TOTAL over the
 * active ruled rows (never null), with the no-op status depending on the consumer kind; the push
 * consumer's payload is the platform's projection of the intent; `materializeDeliveries` reads the
 * catalog under the barrier and writes exactly those rows, consulting no registry; and catalog sync
 * creates missing contracts but refuses to silently reinterpret a drifted one.
 */

const meta = (over: Partial<EmittedEventMeta> = {}): EmittedEventMeta => ({
  eventId: 'e1', eventType: 'decision.approved', projectId: 'p1', organizationId: 'o1',
  streamPosition: 0n, entityType: 'Decision', entityId: 'D-1', payload: null,
  dispatchIntent: { effectKey: 'compat.task6', coverageVersion: 'compat-task6', invalidate: true },
  ...over,
});

const row = (over: Partial<CatalogRuleRow> & Pick<CatalogRuleRow, 'consumer'>): CatalogRuleRow => ({
  consumerKind: 'unordered', active: true, dispatchRule: 'all', subscribedEventTypes: [], ...over,
});

// A realtime/push stub — the consumers' rules are declarations (read nothing), so handle deps are unused.
const socket = makeSocketConsumer({} as never);
const push = makePushConsumer({} as never);

describe('PR B / A6d — total delivery rows from the persisted catalog', () => {
  it('the socket row dispatches only when the persisted intent invalidates; otherwise a recorded no-op', () => {
    const cat = [row({ consumer: socket.name, dispatchRule: 'invalidate' })];
    expect(deliveryRowsFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true } }), cat)[0]).toMatchObject({ deliveryAction: 'dispatch', status: 'pending' });
    expect(deliveryRowsFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: false } }), cat)[0]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    // a pre-intent legacy event (null intent) is an external no-op, never a dispatch
    expect(deliveryRowsFor(meta({ dispatchIntent: null }), cat)[0]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    // the socket row carries neither payload nor subject
    expect(deliveryRowsFor(meta(), cat)[0]).not.toHaveProperty('payload');
    expect(deliveryRowsFor(meta(), cat)[0]).not.toHaveProperty('subject');
  });

  it('the push row dispatches only for a persisted push body, carrying the PROJECTION of the intent and its subject; a null-intent event never invents a push', () => {
    const cat = [row({ consumer: push.name, dispatchRule: 'push' })];
    // Phase 6 task 4a — a push delivery also carries its SUBJECT (the emitting module's
    // entityId), the key cancel-by-subject targets when a queued announcement goes stale.
    // Phase 6 task 4b — the payload also records the TARGETED user (null for a role push), so a
    // scanner can reproduce the plan and the claim path can tell targeted content apart.
    expect(deliveryRowsFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: 'hi', roles: ['client'] } } }), cat)[0])
      .toMatchObject({ deliveryAction: 'dispatch', status: 'pending', payload: { body: 'hi', roles: ['client'], targetUserId: null }, subject: 'D-1' });
    expect(deliveryRowsFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true } }), cat)[0]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    expect(deliveryRowsFor(meta({ dispatchIntent: null }), cat)[0]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    // an EMPTY body is a no-op (#661 round 1, finding 2)
    expect(deliveryRowsFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: '' } } }), cat)[0]).toMatchObject({ deliveryAction: 'noop' });
  });

  it('the payload projection: `{body, roles, targetUserId}` null-coalesced, and `targetUserIds` as the sorted distinct set only where the intent carries one', () => {
    expect(pushPayloadFor({ effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: 'b' } })).toEqual({ body: 'b', roles: null, targetUserId: null });
    expect(pushPayloadFor({ effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: 'b', roles: ['pmc'], targetUserId: 'u1' } })).toEqual({ body: 'b', roles: ['pmc'], targetUserId: 'u1' });
    expect(pushPayloadFor({ effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: 'b', targetUserIds: ['u2', 'u1', 'u2'] } })).toEqual({ body: 'b', roles: null, targetUserId: null, targetUserIds: ['u1', 'u2'] });
    expect(pushPayloadFor({ effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: '' } })).toBeNull();
    expect(pushPayloadFor(null)).toBeNull();
  });

  it('one row per ACTIVE, RULED catalog row: unordered no-op -> succeeded, ordered no-op -> pending, dispatch -> pending; an inactive or rule-less row gets nothing', () => {
    const cat = [
      row({ consumer: 't.dispatch', dispatchRule: 'all' }),
      row({ consumer: 't.noop.unordered', dispatchRule: 'types', subscribedEventTypes: [] }),
      row({ consumer: 't.noop.ordered', consumerKind: 'ordered', dispatchRule: 'types', subscribedEventTypes: [] }),
      row({ consumer: 't.types.hit', consumerKind: 'ordered', dispatchRule: 'types', subscribedEventTypes: ['decision.approved'] }),
      row({ consumer: 't.inactive', active: false }),
      row({ consumer: 't.ruleless', dispatchRule: null }),
    ];
    const rows = deliveryRowsFor(meta(), cat);
    const byName = Object.fromEntries(rows.map((r) => [r.consumer, r]));
    expect(Object.keys(byName).sort()).toEqual(['t.dispatch', 't.noop.ordered', 't.noop.unordered', 't.types.hit']);
    expect(byName['t.dispatch']).toMatchObject({ deliveryAction: 'dispatch', status: 'pending', consumerKind: 'unordered', eventId: 'e1', projectId: 'p1', streamPosition: 0n });
    expect(byName['t.noop.unordered']).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    expect(byName['t.noop.ordered']).toMatchObject({ deliveryAction: 'noop', status: 'pending', consumerKind: 'ordered' });
    expect(byName['t.types.hit']).toMatchObject({ deliveryAction: 'dispatch', status: 'pending' });
    // only a push-rule dispatch carries a payload
    for (const r of rows) expect(r, r.consumer).not.toHaveProperty('payload');
  });

  it('`ruleOfRow` reads the four persisted spellings and nothing else', () => {
    expect(ruleOfRow({ dispatchRule: 'all', subscribedEventTypes: [] })).toEqual({ kind: 'all' });
    expect(ruleOfRow({ dispatchRule: 'types', subscribedEventTypes: ['a.b'] })).toEqual({ kind: 'types', eventTypes: ['a.b'] });
    expect(ruleOfRow({ dispatchRule: null, subscribedEventTypes: [] })).toBeNull();
    expect(ruleOfRow({ dispatchRule: 'sometimes', subscribedEventTypes: [] })).toBeNull();
  });

  describe('materializeDeliveries', () => {
    const registered: string[] = [];
    afterEach(() => { registered.splice(0).forEach(unregisterConsumer); vi.restoreAllMocks(); });

    // The catalog is read inside the emit transaction, under the SHARE half of the registration
    // barrier and with every row locked FOR SHARE; the stand-in answers that read with the rows given.
    const txWith = (createMany: ReturnType<typeof vi.fn>, catalog: CatalogRuleRow[]) => {
      const executeRaw = vi.fn(async () => 0);
      const queryRaw = vi.fn(async () => catalog);
      return { tx: { $executeRaw: executeRaw, $queryRaw: queryRaw, outboxDelivery: { createMany } } as never, executeRaw, queryRaw };
    };

    it('writes exactly `deliveryRowsFor`\'s rows, after taking the registration key SHARED and reading the catalog FOR SHARE', async () => {
      const createMany = vi.fn();
      const catalog = [row({ consumer: 't.a', dispatchRule: 'all' }), row({ consumer: 't.b', active: false })];
      const { tx, executeRaw, queryRaw } = txWith(createMany, catalog);
      await materializeDeliveries(tx, meta());
      expect(executeRaw.mock.calls[0]?.[0]?.join?.('') ?? String(executeRaw.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock_shared(hashtext('OutboxConsumerCatalog:registration'))");
      const read = (queryRaw.mock.calls[0]?.[0] as readonly string[]).join('');
      expect(read).toContain('"OutboxConsumerCatalog"');
      expect(read).toContain('FOR SHARE');
      expect(read).not.toContain('WHERE'); // every row, active or not — the active filter is deliveryRowsFor's
      expect(createMany.mock.calls[0][0].data).toEqual(deliveryRowsFor(meta(), catalog));
      expect(createMany.mock.calls[0][0].data.map((r: { consumer: string }) => r.consumer)).toEqual(['t.a']);
    });

    it('consults NO registry: a registered consumer with no catalog row gets nothing, and an unregistered one with a row gets its row', async () => {
      registerConsumer({ name: 't.registered', kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule: { kind: 'all' }, handle: async () => {} });
      registered.push('t.registered');
      const createMany = vi.fn();
      const { tx } = txWith(createMany, [row({ consumer: 't.unregistered', dispatchRule: 'all' })]);
      await materializeDeliveries(tx, meta());
      expect(createMany.mock.calls[0][0].data.map((r: { consumer: string }) => r.consumer)).toEqual(['t.unregistered']);
    });

    it('writes nothing when the catalog is empty (a database no bootstrap has synced)', async () => {
      const createMany = vi.fn();
      const { tx } = txWith(createMany, []);
      await materializeDeliveries(tx, meta());
      expect(createMany).not.toHaveBeenCalled();
    });
  });
});

describe('PR B — syncConsumerCatalog', () => {
  const registered: string[] = [];
  afterEach(() => { registered.splice(0).forEach(unregisterConsumer); vi.restoreAllMocks(); });

  it('creates a missing contract row', async () => {
    registerConsumer({ name: 't.sync.new', kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule: { kind: 'types', eventTypes: [] }, handle: async () => {} });
    registered.push('t.sync.new');
    const create = vi.fn();
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue(null), create } } as unknown as PrismaClient;
    await syncConsumerCatalog(prisma);
    expect(create).toHaveBeenCalledWith({ data: { consumer: 't.sync.new', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1, dispatchRule: 'types', subscribedEventTypes: [] } });
  });

  it('leaves a matching row untouched (no overwrite)', async () => {
    registerConsumer({ name: 't.sync.same', kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule: { kind: 'types', eventTypes: [] }, handle: async () => {} });
    registered.push('t.sync.same');
    const create = vi.fn();
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue({ consumer: 't.sync.same', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1, dispatchRule: 'types', subscribedEventTypes: [] }), create } } as unknown as PrismaClient;
    await syncConsumerCatalog(prisma);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a drifted contract (version/kind/effect) rather than silently reinterpreting it', async () => {
    registerConsumer({ name: 't.sync.drift', kind: 'unordered', effect: 'external', catalogVersion: 2, dispatchRule: { kind: 'types', eventTypes: [] }, handle: async () => {} });
    registered.push('t.sync.drift');
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue({ consumer: 't.sync.drift', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1, dispatchRule: 'types', subscribedEventTypes: [] }), create: vi.fn() } } as unknown as PrismaClient;
    await expect(syncConsumerCatalog(prisma)).rejects.toThrow(/drift/i);
  });
});
