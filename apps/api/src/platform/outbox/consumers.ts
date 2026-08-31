import type { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { PushService } from '../../push/push.service';
import type { OutboxConsumer } from './registry';
import { EXTERNAL_EFFECTS, type ExternalEffectDef, type ExternalEffectKey } from '../external-effects';

/**
 * Phase 6 task 4b (§A.3) — the per-EVENT-FAMILY claim-time dependencies the push consumer
 * re-judges a targeted delivery against, bound at bootstrap (the owning module answers; platform
 * code never reads a foreign table). `decider` is the first family: "the target is still the
 * holder AND the status still demands their decision" — including the target's current standing.
 * `markCancelled` records a claim-time drop on the delivery's own row (the 4a cancellation mark),
 * so a dropped demand is evidence, never a silent skip.
 */
export type PushClaimVerdict = { actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string };

export interface PushClaimDeps {
  deciderTarget(projectId: string, decisionId: string): Promise<PushClaimVerdict>;
  /** Phase 6 unit 4c-ii (§B P38c/P40c) — the two consultation families. Both are TARGETED, so the
   *  bound predicate is asked about the delivery's own target user: "is decision content about
   *  this decision still warranted for THIS person?" Each re-checks project operability first,
   *  then locks the decision before judging its status and cycle. */
  consultationRequestedTarget(projectId: string, decisionId: string, targetUserId: string | null): Promise<PushClaimVerdict>;
  consultationRespondedTarget(projectId: string, decisionId: string, targetUserId: string | null): Promise<PushClaimVerdict>;
  markCancelled(deliveryId: string): Promise<void>;
  /** round-1 Codex F5 — WHO currently holds a role's effective standing (orgs-owned answer):
   *  a role claim delivers to these users' valid links, never to a subscription's stored role. */
  roleHolderUserIds(projectId: string, role: string): Promise<string[]>;
}

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
export function makePushConsumer(push: PushService, claims?: PushClaimDeps): OutboxConsumer {
  return {
    name: PUSH_CONSUMER,
    kind: 'unordered',
    effect: 'external',
    // Phase 6 unit 4c-ii (§D) — BUMPED for the two consultation push families. `syncConsumerCatalog`
    // asserts the compiled contract against the persisted row at every startup and THROWS on any
    // difference, so from the moment this unit's catalog-data migration lands, a PREVIOUS-release
    // process cannot take up service at all — it never reaches the claim path, where it would
    // recognize neither family and fall through to the unguarded targeted send. That is what makes
    // the drain DURABLE: a rolled-back or newly-scheduled old worker is fenced out on EVERY start,
    // not merely at the one moment an operator looked.
    //
    // The SOCKET consumer is deliberately NOT bumped: it carries no consultation contract — it
    // tells a room to refetch and has nothing new to understand.
    catalogVersion: 2,
    // Dispatch only when the PERSISTED intent carries a push body; otherwise a recorded no-op. A
    // null-intent legacy event has no push, so it is always a no-op — the outbox never invents a
    // historical push from an old payload.
    deliveryFor: (meta) => {
      const push = meta.dispatchIntent?.push;
      // `subject` = the emitting module's entityId (Phase 6 task 4a): the domain that later
      // learns this announcement went stale cancels by this key — never by reading the queue.
      return push?.body
        ? { action: 'dispatch', payload: { body: push.body, roles: push.roles ?? null, targetUserId: push.targetUserId ?? null }, subject: meta.entityId }
        : { action: 'noop' };
    },
    handle: async (ctx) => {
      const p = (ctx.delivery.payload ?? null) as { body?: string; roles?: string[] | null; targetUserId?: string | null } | null;
      if (!p?.body) return;
      const payload = { title: 'Vitan PMC', body: p.body };
      // Phase 6 task 4b (§A.3) — a catalog entry carrying a pushFamily is re-judged AT CLAIM
      // through the owning module's bound predicate: the delivery goes to the CURRENT target
      // (a holder change between enqueue and claim re-targets), or is dropped with the
      // cancellation mark when the demand is no longer actionable. Only the decider family
      // exists in 4b, and its subject is the decision id the 4a `subject` key already carries.
      const effectKey = ctx.meta.dispatchIntent?.effectKey as ExternalEffectKey | undefined;
      const family = effectKey ? (EXTERNAL_EFFECTS[effectKey] as ExternalEffectDef | undefined)?.pushFamily : undefined;
      if (family && claims) {
        const target =
          family === 'decider'
            ? await claims.deciderTarget(ctx.meta.projectId, ctx.meta.entityId)
            : family === 'consultation_requested'
              ? await claims.consultationRequestedTarget(ctx.meta.projectId, ctx.meta.entityId, p.targetUserId ?? null)
              : await claims.consultationRespondedTarget(ctx.meta.projectId, ctx.meta.entityId, p.targetUserId ?? null);
        if (!target.actionable) {
          await claims.markCancelled(ctx.delivery.id);
          return;
        }
        if (target.targetUserId) {
          await push.notifyTargetedUser(ctx.meta.projectId, payload, target.targetUserId);
          return;
        }
        // round-1 Codex F5 — a ROLE-held claim resolves the role's CURRENT effective holders
        // (the orgs-owned answer) and delivers only to their currently-valid links: a stored
        // subscription role is attribution at subscribe time, not standing at claim time, so a
        // removed member's device receives nothing.
        const holders = new Set<string>();
        for (const role of target.roles ?? []) {
          for (const userId of await claims.roleHolderUserIds(ctx.meta.projectId, role)) holders.add(userId);
        }
        for (const userId of holders) {
          await push.notifyTargetedUser(ctx.meta.projectId, payload, userId);
        }
        return;
      }
      // A TARGETED intent outside any family still delivers only to the target's valid links
      // (round 10 — never a role-ceiling fallback for targeted content).
      if (p.targetUserId) {
        await push.notifyTargetedUser(ctx.meta.projectId, payload, p.targetUserId);
        return;
      }
      await push.notifyProject(ctx.meta.projectId, payload, p.roles ?? undefined);
    },
  };
}
