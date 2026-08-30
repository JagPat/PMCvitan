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
export interface PushClaimDeps {
  deciderTarget(projectId: string, decisionId: string): Promise<{ actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string }>;
  /** Phase 6 unit 4c-ii (§B.3/P38c/P40c) — the two consultation families' claim-time predicate,
   *  the SAME class as `decider` and answered by the same owning module. `kind` selects which
   *  side of the thread is being delivered to: the `consultee` invitation (still unanswered, the
   *  decision still open at the frozen cycle, the consultee still active) or the `requester`
   *  answer (they still hold the authority that let them ask). Project operability is judged
   *  FIRST in both, under the project row's lock — an archived project receives no decision
   *  content at all. */
  consultationTarget(
    projectId: string,
    consultationId: string,
    kind: 'consultee' | 'requester',
  ): Promise<{ actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string }>;
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
    // Phase 6 unit 4c-ii (§D) — BUMPED for the consultation fold. `syncConsumerCatalog` asserts
    // the compiled contract against the persisted row at every startup and THROWS on any
    // difference, so from the moment this unit's catalog-data migration lands, a PREVIOUS-release
    // process cannot take up service at all: it never reaches the claim path. That is what makes
    // the drain durable — a rolled-back or newly-scheduled old worker is fenced out on EVERY
    // start, not merely at the one moment an operator looked.
    catalogVersion: 2,
    // Dispatch only when the PERSISTED intent carries a push body; otherwise a recorded no-op. A
    // null-intent legacy event has no push, so it is always a no-op — the outbox never invents a
    // historical push from an old payload.
    deliveryFor: (meta) => {
      const push = meta.dispatchIntent?.push;
      // `subject` = the emitting module's entityId (Phase 6 task 4a): the domain that later
      // learns this announcement went stale cancels by this key — never by reading the queue.
      // Phase 6 unit 4c-ii — a family whose claim predicate judges the CONSULTATION needs its id
      // at claim time, and the delivery payload is the only durable place it can travel: the
      // relay claims from the stored row, long after the emitting transaction is gone. It is read
      // from the event's own payload, so no command can hand the consumer a subject its event
      // does not actually carry.
      const consultationId = (meta.payload as { consultationId?: unknown } | null)?.consultationId;
      return push?.body
        ? {
            action: 'dispatch',
            payload: {
              body: push.body,
              roles: push.roles ?? null,
              targetUserId: push.targetUserId ?? null,
              ...(typeof consultationId === 'string' ? { consultationId } : {}),
            },
            subject: meta.entityId,
          }
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
      // Phase 6 unit 4c-ii — the two consultation families are re-judged the same way, but their
      // subject is the CONSULTATION, not the decision: the decision id alone cannot say whether
      // THIS invitation has since been answered or overtaken by an approval. The id rides the
      // delivery payload, put there by the emitting command.
      if ((family === 'consultee' || family === 'requester') && claims) {
        const consultationId = (ctx.delivery.payload as { consultationId?: unknown } | null)?.consultationId;
        // a delivery with no subject cannot be re-judged, and an unjudged targeted send is
        // exactly what the family exists to prevent — drop it with the mark, never send blind
        if (typeof consultationId !== 'string') {
          await claims.markCancelled(ctx.delivery.id);
          return;
        }
        const target = await claims.consultationTarget(ctx.meta.projectId, consultationId, family);
        if (!target.actionable) {
          await claims.markCancelled(ctx.delivery.id);
          return;
        }
        if (target.targetUserId) {
          await push.notifyTargetedUser(ctx.meta.projectId, payload, target.targetUserId);
        }
        return;
      }
      if (family === 'decider' && claims) {
        const target = await claims.deciderTarget(ctx.meta.projectId, ctx.meta.entityId);
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
