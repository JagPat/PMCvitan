import type { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { PushService } from '../../push/push.service';
import type { OutboxConsumer } from './registry';

/**
 * Phase 2 Task 6 — the two external outbox consumers the notification split introduces. Both are
 * `unordered` + `external` (at-least-once; no ProcessedEvent). They SEND only when the sender mode
 * is `outbox` — in `legacy`/`shadow` the OLD in-request `notifyChanged` is the sole sender, so the
 * relay still exercises the pipeline (claim → succeed) without a second sender. `shadow` records
 * the intent it WOULD have sent.
 */

export const SOCKET_CONSUMER = 'socket.invalidation';
export const PUSH_CONSUMER = 'webpush.notify';

/** Socket invalidation: every project event tells the room to refetch (role-agnostic — each
 *  client refetches its own RBAC snapshot). Duplicate invalidations are harmless (idempotent). */
export function makeSocketConsumer(realtime: RealtimeGateway): OutboxConsumer {
  return {
    name: SOCKET_CONSUMER,
    kind: 'unordered',
    effect: 'external',
    catalogVersion: 1,
    // Dispatch only when the PERSISTED intent asks to invalidate; otherwise a recorded no-op. Today
    // the compat intent always invalidates (unchanged behavior); PR C narrows it per command so a
    // private draft no longer invalidates. A null-intent legacy event is never invalidated here.
    deliveryFor: (meta) => (meta.dispatchIntent?.invalidate ? { action: 'dispatch' } : { action: 'noop' }),
    handle: async (ctx) => {
      if (ctx.senderMode === 'outbox') realtime.emitChanged(ctx.meta.projectId);
      else if (ctx.senderMode === 'shadow') realtime.recordShadowIntent('socket', ctx.meta.projectId);
      // legacy: the old in-request notifyChanged emitted it; do not double-emit
    },
  };
}

/** Web Push: only events carrying a notification intent (the push body + roles) get a delivery. */
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
      if (ctx.senderMode === 'outbox') {
        await push.notifyProject(ctx.meta.projectId, { title: 'Vitan PMC', body: p.body }, p.roles ?? undefined);
      }
      // legacy/shadow: the old in-request push sent it (shadow just records — no double-send)
    },
  };
}
