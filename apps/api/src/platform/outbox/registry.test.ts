import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  registerConsumer,
  unregisterConsumer,
  materializeDeliveries,
  syncConsumerCatalog,
  type EmittedEventMeta,
  type OutboxConsumer,
} from './registry';
import { makeSocketConsumer, makePushConsumer } from './consumers';

/**
 * Phase 2 fix-forward PR B — registry unit contract. Proves delivery planning is TOTAL (never
 * null), that no-op status depends on the consumer kind, and that catalog sync creates missing
 * contracts but refuses to silently reinterpret a drifted one.
 */

const meta = (over: Partial<EmittedEventMeta> = {}): EmittedEventMeta => ({
  eventId: 'e1', eventType: 'decision.approved', projectId: 'p1', organizationId: 'o1',
  streamPosition: 0n, entityType: 'Decision', entityId: 'D-1', payload: null,
  dispatchIntent: { effectKey: 'compat.task6', coverageVersion: 'compat-task6', invalidate: true },
  ...over,
});

// A realtime/push stub — the consumers' deliveryFor is pure (reads meta), so handle deps are unused.
const socket = makeSocketConsumer({} as never);
const push = makePushConsumer({} as never);

describe('PR B — total delivery planning', () => {
  const registered: string[] = [];
  const register = (c: OutboxConsumer) => { registerConsumer(c); registered.push(c.name); };
  afterEach(() => { registered.splice(0).forEach(unregisterConsumer); vi.restoreAllMocks(); });

  it('socket dispatches only when the persisted intent invalidates; otherwise a recorded no-op', () => {
    expect(socket.deliveryFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true } }))).toEqual({ action: 'dispatch' });
    expect(socket.deliveryFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: false } }))).toEqual({ action: 'noop' });
    // a pre-intent legacy event (null intent) is an external no-op, never a dispatch
    expect(socket.deliveryFor(meta({ dispatchIntent: null }))).toEqual({ action: 'noop' });
  });

  it('push dispatches only for a persisted push body; a null-intent event never invents a push', () => {
    expect(push.deliveryFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true, push: { body: 'hi', roles: ['client'] } } })))
      .toEqual({ action: 'dispatch', payload: { body: 'hi', roles: ['client'] } });
    expect(push.deliveryFor(meta({ dispatchIntent: { effectKey: 'x', coverageVersion: 'x', invalidate: true } }))).toEqual({ action: 'noop' });
    expect(push.deliveryFor(meta({ dispatchIntent: null }))).toEqual({ action: 'noop' });
  });

  // The active set is read inside the emit transaction; a helper builds a tx mock returning the given
  // active consumer names from `outboxConsumerCatalog.findMany`.
  const txWith = (createMany: ReturnType<typeof vi.fn>, activeNames: string[]) =>
    ({ outboxDelivery: { createMany }, outboxConsumerCatalog: { findMany: vi.fn().mockResolvedValue(activeNames.map((consumer) => ({ consumer }))) } }) as never;

  it('materializes one row per ACTIVE consumer: unordered no-op -> succeeded, ordered no-op -> pending, dispatch -> pending', async () => {
    register({ name: 't.dispatch', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'dispatch', payload: { x: 1 } }), handle: async () => {} });
    register({ name: 't.noop.unordered', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} });
    register({ name: 't.noop.ordered', kind: 'ordered', effect: 'db', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} });
    const createMany = vi.fn();
    await materializeDeliveries(txWith(createMany, ['t.dispatch', 't.noop.unordered', 't.noop.ordered']), meta());
    const rows = createMany.mock.calls[0][0].data as Array<{ consumer: string; deliveryAction: string; status: string; payload?: unknown }>;
    const byName = Object.fromEntries(rows.map((r) => [r.consumer, r]));
    expect(byName['t.dispatch']).toMatchObject({ deliveryAction: 'dispatch', status: 'pending', payload: { x: 1 } });
    expect(byName['t.noop.unordered']).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    expect(byName['t.noop.ordered']).toMatchObject({ deliveryAction: 'noop', status: 'pending' });
    expect(byName['t.noop.unordered'].payload).toBeUndefined();
  });

  it('materializes NO row for a registered-but-inactive consumer (catalog.active authoritative)', async () => {
    register({ name: 't.active', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'dispatch' }), handle: async () => {} });
    register({ name: 't.inactive', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'dispatch' }), handle: async () => {} });
    const createMany = vi.fn();
    await materializeDeliveries(txWith(createMany, ['t.active']), meta()); // only t.active is active
    const rows = createMany.mock.calls[0][0].data as Array<{ consumer: string }>;
    expect(rows.map((r) => r.consumer)).toEqual(['t.active']); // the inactive contract accrues no row
  });
});

describe('PR B — syncConsumerCatalog', () => {
  const registered: string[] = [];
  afterEach(() => { registered.splice(0).forEach(unregisterConsumer); vi.restoreAllMocks(); });

  it('creates a missing contract row', async () => {
    registerConsumer({ name: 't.sync.new', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} });
    registered.push('t.sync.new');
    const create = vi.fn();
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue(null), create } } as unknown as PrismaClient;
    await syncConsumerCatalog(prisma);
    expect(create).toHaveBeenCalledWith({ data: { consumer: 't.sync.new', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 } });
  });

  it('leaves a matching row untouched (no overwrite)', async () => {
    registerConsumer({ name: 't.sync.same', kind: 'unordered', effect: 'external', catalogVersion: 1, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} });
    registered.push('t.sync.same');
    const create = vi.fn();
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue({ consumer: 't.sync.same', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 }), create } } as unknown as PrismaClient;
    await syncConsumerCatalog(prisma);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a drifted contract (version/kind/effect) rather than silently reinterpreting it', async () => {
    registerConsumer({ name: 't.sync.drift', kind: 'unordered', effect: 'external', catalogVersion: 2, deliveryFor: () => ({ action: 'noop' }), handle: async () => {} });
    registered.push('t.sync.drift');
    const prisma = { outboxConsumerCatalog: { findUnique: vi.fn().mockResolvedValue({ consumer: 't.sync.drift', consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 }), create: vi.fn() } } as unknown as PrismaClient;
    await expect(syncConsumerCatalog(prisma)).rejects.toThrow(/drift/i);
  });
});
