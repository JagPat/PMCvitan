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

/** The push families the catalog declares (`ExternalEffectDef.pushFamily`). */
export type PushFamily = NonNullable<ExternalEffectDef['pushFamily']>;

/**
 * Phase 6 task 4d-ii-a / A7b (plan §A.4 (ii)) — what the FINAL re-judge before ONE recipient's provider
 * call decided:
 *   - `send`: the mark is clear, the subject and the project are still in the actionable set, and the
 *     recipient still holds the standing the family's own rule names;
 *   - `skip`: the RECIPIENT is stale (their standing ended, or the demand re-targeted to someone
 *     else) — skipped without touching the mark, the delivery completes with the recipients sent;
 *   - `drop`: the SUBJECT or the PROJECT left the actionable set — the whole delivery drops with the
 *     recorded cancellation mark when nothing has been sent yet, and every remaining recipient is
 *     skipped (no mark) when a send already happened;
 *   - `cancelled`: a canceller already marked this delivery's row (the mark is never rewritten) —
 *     nothing further is sent.
 */
export type PreSendVerdict = 'send' | 'skip' | 'drop' | 'cancelled';

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
  /** 4d-ii-a / A7b — the delivery row's own cancellation mark, re-read immediately before EACH
   *  recipient's provider call (a platform-internal read of the platform's own table): a canceller
   *  that committed between the claim and this recipient's send stops the remaining sends. */
  cancelled(deliveryId: string): Promise<boolean>;
  /** 4d-ii-a / A7b — does `userId` hold `role`'s effective standing on the project NOW (the
   *  orgs-owned answer, the same rule `roleHolderUserIds` resolves the fan-out by)? A role fan-out
   *  recipient resolved at claim is re-judged by it before their own send. */
  userHoldsRole(projectId: string, userId: string, role: string): Promise<boolean>;
}

/** The family's own claim predicate, target-aware wherever the claim is. */
function familyTarget(claims: PushClaimDeps, family: PushFamily, projectId: string, decisionId: string, targetUserId: string | null): Promise<PushClaimVerdict> {
  return family === 'decider'
    ? claims.deciderTarget(projectId, decisionId)
    : family === 'consultation_requested'
      ? claims.consultationRequestedTarget(projectId, decisionId, targetUserId)
      : claims.consultationRespondedTarget(projectId, decisionId, targetUserId);
}

/**
 * Phase 6 task 4d-ii-a / A7b (plan §A.4 (ii)) — the ONE pre-send hook for EVERY recipient of EVERY
 * family, run immediately before that recipient's provider call:
 *   1. the delivery row's cancellation mark (family-agnostic by construction);
 *   2. the SUBJECT and the PROJECT — the family's OWN claim predicate re-run, target-aware wherever
 *      the claim is (each predicate re-checks project operability FIRST, then the decision under
 *      its row lock, then the person's standing for the user-targeted families);
 *   3. the PERSON — a user-targeted family's predicate already judged them; a role fan-out
 *      recipient must still hold the role the CURRENT verdict names, by the orgs-owned answer.
 * Exported for the unit suite; the consumer below is its only production caller.
 */
export async function preSendVerdict(
  claims: PushClaimDeps,
  input: { deliveryId: string; projectId: string; decisionId: string; family: PushFamily; recipient: string; role: string | null },
): Promise<PreSendVerdict> {
  if (await claims.cancelled(input.deliveryId)) return 'cancelled';
  const again = await familyTarget(claims, input.family, input.projectId, input.decisionId, input.role === null ? input.recipient : null);
  if (!again.actionable) return 'drop';
  if (again.targetUserId !== undefined) return again.targetUserId === input.recipient ? 'send' : 'skip';
  // a role fan-out: the recipient must hold one of the roles the CURRENT verdict names — the role
  // they were resolved by at claim, and that role must still be the demand's audience
  if (input.role === null || !(again.roles ?? []).includes(input.role)) return 'skip';
  return (await claims.userHoldsRole(input.projectId, input.recipient, input.role)) ? 'send' : 'skip';
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
    // 4d-ii-a / A6c — the persisted rule the catalog row carries: dispatch iff the intent invalidates
    // (PR C narrows this per command — a private draft never invalidates; a null-intent legacy event
    // is never invalidated). From A6d the persisted rule is what derives the row (`deliveryRowsFor`).
    dispatchRule: { kind: 'invalidate' },
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
    // 4d-ii-a / A6c — the persisted rule the catalog row carries: dispatch iff the intent carries a
    // push WITH a body (a null-intent legacy event has no push, so it is always a no-op — the outbox
    // never invents a historical push from an old payload). From A6d the persisted rule derives the
    // row and the platform's `pushPayloadFor` projects the intent into its payload — `{body, roles,
    // targetUserId}` (+ `targetUserIds`) — with `subject` = the emitting module's entityId (Phase 6
    // task 4a): the domain that later learns this announcement went stale cancels by this key.
    dispatchRule: { kind: 'push' },
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
        const target = await familyTarget(claims, family, ctx.meta.projectId, ctx.meta.entityId, p.targetUserId ?? null);
        if (!target.actionable) {
          await claims.markCancelled(ctx.delivery.id);
          return;
        }
        // the recipients this claim resolved: the ONE target of a user-targeted family, or —
        // round-1 Codex F5 — a ROLE-held claim's CURRENT effective holders (the orgs-owned
        // answer), delivered only to their currently-valid links: a stored subscription role is
        // attribution at subscribe time, not standing at claim time, so a removed member's device
        // receives nothing. Each holder remembers the role they were resolved by.
        const recipients: Array<{ userId: string; role: string | null }> = [];
        if (target.targetUserId) {
          recipients.push({ userId: target.targetUserId, role: null });
        } else {
          const seen = new Set<string>();
          for (const role of target.roles ?? []) {
            for (const userId of await claims.roleHolderUserIds(ctx.meta.projectId, role)) {
              if (!seen.has(userId)) { seen.add(userId); recipients.push({ userId, role }); }
            }
          }
        }
        // 4d-ii-a / A7b (plan §A.4 (ii)) — the FINAL re-judge before EACH recipient's provider call
        // (`preSendVerdict`). One rule for the outcome: a subject or project that left the
        // actionable set BEFORE any send drops the WHOLE delivery with the recorded mark (the row
        // carries one delivery-wide mark, so it is the right instrument only then); a stale
        // RECIPIENT is skipped without touching the mark and the delivery completes with the
        // recipients actually sent, the mark set only when EVERY resolved recipient failed (a
        // user-targeted delivery has one recipient, so its failure IS the whole delivery); a
        // subject or project that leaves BETWEEN sends skips every remaining recipient, no mark.
        // The residual — a command committing after this re-read and before the provider accepts
        // the send — is a stale push to a displaced recipient, stated as a disclosure bound.
        let sent = 0;
        let stopped = false;
        for (const r of recipients) {
          const verdict = await preSendVerdict(claims, {
            deliveryId: ctx.delivery.id, projectId: ctx.meta.projectId, decisionId: ctx.meta.entityId, family, recipient: r.userId, role: r.role,
          });
          if (verdict === 'cancelled') { stopped = true; break; }
          if (verdict === 'drop') {
            if (sent === 0) await claims.markCancelled(ctx.delivery.id);
            stopped = true;
            break;
          }
          if (verdict === 'skip') continue;
          await push.notifyTargetedUser(ctx.meta.projectId, payload, r.userId);
          sent += 1;
        }
        if (!stopped && recipients.length > 0 && sent === 0) await claims.markCancelled(ctx.delivery.id);
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
