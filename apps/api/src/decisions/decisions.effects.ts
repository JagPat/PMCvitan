import { randomUUID } from 'node:crypto';
import type { OutboxConsumer } from '../platform/outbox/registry';
import { PUSH_CONSUMER } from '../platform/outbox/consumers';
import { cancelQueuedPushBySubject, markDeliveryNoop } from '../platform/outbox/cancellation';
import { emitEvent } from '../platform/events';
import { EXTERNAL_EFFECTS } from '../platform/external-effects';
import { RoleStandingQuery } from '../platform/role-standing.query';
import { EventStreamQuery } from '../platform/event-stream.query';
import { lockProjectReadiness } from '../common/readiness-lock';
import { systemActor } from '../common/actor';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7d — `decisions.effects`, the decisions-owned ORDERED consumer of
 * the orgs-owned architect-standing flip (plan §A.2, "The re-notification and the last-architect
 * cancellation are DERIVED from the event by a decisions-owned ORDERED consumer").
 *
 * REGISTERED INACTIVE by `20280104000000_phase6_t4d_ii_a7d_catalog_change` (its activation head from
 * A6a's catalog-INSERT trigger) and ACTIVATED by 4d-iii's appended `OutboxConsumerActivation` row once
 * the fleet is drained: a still-serving pre-4d-ii process writes no delivery row for a consumer it
 * does not know, and the delivery seal requires a row for every ACTIVE consumer. Until then every
 * event materializes no row for it, and at activation the relay's `expandMissingDeliveries` gives it
 * a `noop` row per historical event of every other type from the persisted rule (bounded, one-time).
 *
 * Its persisted rule is `types` over exactly `membership.standing_changed`, so every event of that
 * type is a `dispatch` row; the HANDLER judges the payload:
 *   - a CROSSING is the `architect` role with `activeCount = 0` and `to` not an active architect
 *     (the chain DEACTIVATED: the last architect left) or `activeCount = 1` with `to` an active
 *     architect (the chain ACTIVATED: the first arrived); any other event of the type is a recorded
 *     no-op (the relay completes the row);
 *   - under `lockProjectReadiness` (serializing with `approve`, the stranded resolution and every
 *     standing write), and PER DECISION from stream positions the kernel holds: for each of the
 *     project's `awaiting_countersign` decisions — its `countersign` delivery rows locked `FOR UPDATE`
 *     in ascending id, THEN the decision row (the ONE lock order: the relay's claim leases the delivery
 *     first and the family predicate takes the decision lock) — let `demand` be the latest position
 *     of a `decision.awaiting_countersign` about it (`EventStreamQuery.latestPosition`); if `demand`
 *     is LATER than this crossing the decision is SKIPPED (its demand was raised against a standing at
 *     or after this crossing); otherwise the handler cancels by subject every not-yet-sent
 *     `countersign` delivery of the decision and, for an ACTIVATION, re-emits the demand to the
 *     CURRENT architects (frozen as `targetUserIds`; `{ renotified: true, crossingEventId,
 *     transitionId }`), appending a `countersign_renotified` audit row attributed to the system actor
 *     `system:membership-standing` — the human act is recoverable from the immutable
 *     `MembershipTransition` the event names, never derived here; for a DEACTIVATION it re-emits
 *     nothing;
 *   - an ACTIVATION the standing has already reversed is a RECORDED NO-OP (`stale_activation`):
 *     before touching any decision the handler reads the register's CURRENT count under the lock it
 *     holds, and when it is zero (architect B activated at Q and was removed again at R before the
 *     consumer reached Q) it marks its own delivery row `noop` (the cancellation mark, `lastError`
 *     naming the reason), emits nothing and cancels nothing: the deactivation R, later in the same
 *     ordered stream, cancels every unsent pre-Q demand exactly as a deactivation does. So the
 *     correspondence seal's refusal of an EMPTY frozen audience is a seal no handler ever reaches,
 *     and an ordered consumer can never dead-letter on a crossing the standing has since reversed.
 *
 * Exactly once, whatever the interleaving: the handlers are ORDERED, so a deactivation at P is
 * handled before an activation at Q; an approve committing after Q targets the current architects
 * itself and its `demand` exceeds Q, so the Q handler skips it; for Q → R → S (B removed, C added, all
 * before Q is handled) the Q handler's re-emit freezes C at a position beyond S, so the S handler finds
 * `demand` later than S and skips — one fresh demand, to the architect who holds the role. The handler
 * is keyed per (decision, crossing) by 4d-i's `DecisionEvent_countersign_renotified_key`, so a
 * redelivery appends nothing.
 *
 * NOT a projection: `decisions.inbox` stays recompute-only, and a projection rebuild replays nothing
 * into this consumer, whose cursor is its own.
 */
export const DECISIONS_EFFECTS = 'decisions.effects';
export const DECISIONS_EFFECTS_CATALOG_VERSION = 1;
/** The system actor the re-notification is attributed to (§A.2); U1's kernel actor seal admits it
 *  for exactly this act, bound to the crossing the payload names. */
export const MEMBERSHIP_STANDING_ACTOR = 'system:membership-standing';

/** The payload the orgs member commands write on an architect-standing flip (plan §A.2). */
export interface StandingChangedPayload {
  role: string;
  membershipId: string;
  transitionId: string;
  from: { role: string | null; status: string | null };
  to: { role: string; status: string };
  activeCount: number;
}

export type StandingCrossing = 'activation' | 'deactivation' | null;

/** The crossing an event of the type records — exported for the unit suite. */
export function classifyCrossing(p: StandingChangedPayload | null | undefined): StandingCrossing {
  if (!p || p.role !== 'architect' || typeof p.activeCount !== 'number') return null;
  const toActive = p.to?.role === 'architect' && p.to?.status === 'active';
  if (toActive && p.activeCount === 1) return 'activation';
  if (!toActive && p.activeCount === 0) return 'deactivation';
  return null;
}

export interface DecisionsEffectsDeps {
  /** Diagnostics only: the recorded no-ops are on the delivery row; this names them in the log. */
  log?: (message: string) => void;
}

export function makeDecisionsEffectsConsumer(deps: DecisionsEffectsDeps = {}): OutboxConsumer {
  const log = deps.log ?? (() => {});
  return {
    name: DECISIONS_EFFECTS,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: DECISIONS_EFFECTS_CATALOG_VERSION,
    dispatchRule: { kind: 'types', eventTypes: ['membership.standing_changed'] },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('decisions.effects needs a transaction');
      const tx = ctx.tx;
      const projectId = ctx.meta.projectId;
      const payload = ctx.meta.payload as StandingChangedPayload | null;
      const crossing = classifyCrossing(payload);
      if (crossing === null) {
        log(`decisions.effects: ${ctx.meta.eventId} is not an architect-standing crossing — recorded no-op`);
        return;
      }
      await lockProjectReadiness(tx, projectId);
      if (crossing === 'activation') {
        const current = await RoleStandingQuery.activeCount(tx, projectId, 'architect');
        if (current === 0) {
          await markDeliveryNoop(tx, ctx.delivery.id, 'stale_activation');
          log(`decisions.effects: activation ${ctx.meta.eventId} already reversed (no active architect) — recorded no-op stale_activation`);
          return;
        }
      }
      const awaiting = await tx.decision.findMany({
        where: { projectId, status: 'awaiting_countersign' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const { id: decisionId } of awaiting) {
        // THE ONE LOCK ORDER: the subject's `countersign` delivery rows FOR UPDATE ascending, then the decision
        await tx.$queryRaw`
          SELECT d."id" FROM "OutboxDelivery" d
            JOIN "DomainEvent" e ON e."eventId" = d."eventId"
           WHERE d."consumer" = ${PUSH_CONSUMER} AND d."projectId" = ${projectId} AND d."subject" = ${decisionId}
             AND e."eventType" = 'decision.awaiting_countersign'
           ORDER BY d."id" FOR UPDATE OF d`;
        const rows = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS status FROM "Decision" WHERE "projectId" = ${projectId} AND "id" = ${decisionId} FOR UPDATE`;
        if (rows[0]?.status !== 'awaiting_countersign') continue;
        const demand = await EventStreamQuery.latestPosition(tx, projectId, 'decision.awaiting_countersign', 'Decision', decisionId);
        if (demand !== null && demand > ctx.meta.streamPosition) continue;   // raised at or after this crossing: skipped
        await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.awaiting_countersign' });
        if (crossing !== 'activation') continue;
        const architects = await RoleStandingQuery.holderUserIds(tx, projectId, 'architect');
        const eventId = randomUUID();
        await emitEvent(tx, {
          projectId,
          // 4d-iii / R0c — the event names its automation (the system pair `system`/`decisions-effects`);
          // `systemActor` stays the membership-standing constant the A7d claimant keys on.
          actor: { ...systemActor(MEMBERSHIP_STANDING_ACTOR, 'Membership standing'), automation: 'decisions-effects' },
          eventId,
          eventType: 'decision.awaiting_countersign',
          entityType: 'Decision',
          entityId: decisionId,
          causedByEventId: ctx.meta.eventId,
          payload: { renotified: true, crossingEventId: ctx.meta.eventId, transitionId: payload!.transitionId },
          effectKey: 'decision.awaiting_countersign',
          dispatch: { push: { body: EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody, targetUserIds: architects } },
        });
        // the audit row — the branch's CLAIMANT (4d-i's `DecisionEvent_t4d_renotified_claim`), written
        // AFTER the event it claims
        await tx.decisionEvent.create({
          data: {
            decisionId,
            type: 'countersign_renotified',
            actor: 'Membership standing',
            actorId: null,
            actorName: 'Membership standing',
            actorRole: 'system',
            payload: { eventId, crossingEventId: ctx.meta.eventId, transitionId: payload!.transitionId },
          },
        });
      }
    },
  };
}
