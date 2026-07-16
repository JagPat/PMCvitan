import type { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { PushService } from '../../push/push.service';
import type { OutboxConsumer } from './registry';

/**
 * Phase 2 Task 6 / PR C Task 2 — the two external outbox consumers. Both are `unordered` +
 * `external` (at-least-once; no ProcessedEvent). PR C makes them the SOLE senders: a consumer SENDS
 * whenever its `handle` is invoked. WHO invokes it — the immediate {@link ExternalEffectDispatcher}
 * (legacy/shadow, post-commit) or the background relay (outbox) — and the lease/mode selection happen
 * BEFORE invocation, so there are never two active senders and the old in-request `notifyChanged` is
 * gone. `senderMode` is no longer read here.
 */

export const SOCKET_CONSUMER = 'socket.invalidation';
export const PUSH_CONSUMER = 'webpush.notify';

/** Socket invalidation: every invalidating project event tells the room to refetch (role-agnostic —
 *  each client refetches its own RBAC snapshot). Duplicate invalidations are harmless (idempotent). */
export function makeSocketConsumer(realtime: RealtimeGateway): OutboxConsumer {
  return {
    name: SOCKET_CONSUMER,
    kind: 'unordered',
    effect: 'external',
    catalogVersion: 1,
    // Dispatch only when the PERSISTED intent asks to invalidate; otherwise a recorded no-op. PR C
    // narrows this per command (a private draft never invalidates). A null-intent legacy event is
    // never invalidated here.
    deliveryFor: (meta) => (meta.dispatchIntent?.invalidate ? { action: 'dispatch' } : { action: 'noop' }),
    handle: async (ctx) => {
      realtime.emitChanged(ctx.meta.projectId);
    },
  };
}

/** Web Push: only events carrying a push intent (the body + persisted roles) get a delivery. */
export function makePushConsumer(push: PushService): OutboxConsumer {
  return {
    name: PUSH_CONSUMER,
    kind: 'unordered',
    effect: 'external',
    catalogVersion: 1,
    // Dispatch only when the PERSISTED intent carries a push body; otherwise a recorded no-op. A
    // null-intent legacy event has no push, so it is always a no-op — the outbox never invents a
    // historical push from an old payload.
    deliveryFor: (meta) => {
      const push = meta.dispatchIntent?.push;
      return push?.body ? { action: 'dispatch', payload: { body: push.body, roles: push.roles ?? null } } : { action: 'noop' };
    },
    handle: async (ctx) => {
      const p = (ctx.delivery.payload ?? null) as { body?: string; roles?: string[] | null } | null;
      if (!p?.body) return;
      await push.notifyProject(ctx.meta.projectId, { title: 'Vitan PMC', body: p.body }, p.roles ?? undefined);
    },
  };
}
