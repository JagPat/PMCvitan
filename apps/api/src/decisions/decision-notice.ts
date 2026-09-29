import { viewerIsDecider } from '@vitan/shared';
import {
  APPROVED_DECISION_NOTICE_COLOR,
  PENDING_DECISION_NOTICE_COLOR,
  RECORDED_DECISION_NOTICE_COLOR,
  WITHDRAWN_DECISION_NOTICE_COLOR,
  approvedDecisionNotice,
  pendingDecisionNotice,
  recordedDecisionNotice,
  withdrawnDecisionNotice,
} from '../domain/notifications';
import type { DecisionDto } from '../snapshot/types';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — how the feed reads a KINDED decision notice (§A.3 obligation 7,
 * "the readers").
 *
 * A kinded notice is bound to the event that announced its act (`Notification.eventId`, `kind` = the
 * event's type, both frozen by 4d-i's seals). Its stored `text`/`color` are a display cache a
 * previous-release replica still serves; every reader of THIS release renders the notice from the
 * kind and the event instead, so a row whose cache was forged, or whose decision's title later
 * changed, is still announced as the act happened. From A7a every decisions notice writer (the
 * one-step issue, publish, approve and withdraw) is kinded; the previous release's rows through the
 * drain, and legacy rows, are the kind-less ones the cache path still serves.
 *
 * Two rules, both decisions-owned because they are decision semantics:
 * - {@link renderKindedDecisionNotice}: kind + event → text and colour. An arm exists only where the
 *   event carries everything the notice says; any other kind renders NOTHING (the row is omitted),
 *   never its stored text. Arms join as their writers do: the green approved notice (A7a) renders
 *   the approver from the event's frozen actor envelope and the option and on-behalf fact from the
 *   REVISION its event names (`payload.revisionId`, the exact revision the act wrote, never the head);
 *   the forwarding and countersign notices join with their commands.
 * - {@link kindedDecisionNoticeServed}: whether the viewer may see it. The decision must be in the
 *   viewer's visible slice (`decisionVisibleToViewer`, read in the SAME snapshot as the notice);
 *   an ACTIONABLE kind of a withdrawn decision is suppressed, since it asks for an act the withdrawal
 *   cancelled; and a pending approval demand keeps the kind-less notice's audience, pmc and the
 *   decider, so a consultee who may see the decision still receives no demand.
 *
 * WHICH AUDIENCE IS THE DECISION'S TO SAY, NOT THE EVENT'S (#651's review, finding 4117114385). A
 * `decision.published` event is emitted under one of two catalog keys, the approval demand or the
 * record, and the envelope seal admits either for the type: nothing binds the key a direct writer
 * chose to the decision it names. So the decision's own state decides (a record is `deciderKind`
 * `none`, fixed at publication), and a notice whose event key disagrees with it is not served at all:
 * trusting the key would let a pending decision's notice pass as a team-visible record, and read as
 * one.
 */

/** The kinds that ask a viewer to act. Suppressed once their decision is withdrawn; the rows and
 *  their events stay as evidence (the binding seal refuses their deletion). */
export const ACTIONABLE_DECISION_NOTICE_KINDS: ReadonlySet<string> = new Set([
  'decision.published',
  'decision.forwarded',
  'decision.awaiting_countersign',
  'decision.change_requested',
]);

/** The bound event, as the platform's feed query returns it. */
export interface KindedNoticeEvent {
  eventType: string;
  payload: unknown;
  /** `dispatchIntent.effectKey`: the catalog key the event was emitted under. */
  effectKey: string | null;
  /** The frozen actor envelope (4d-i; 4d-ii-a / A1): who acted, in which role. NULL through the
   *  drain for a previous-release event. */
  actorRole: string | null;
  actorName: string | null;
}

/** 4d-ii-a / A7a — what the green notice reads from the revision its event names. */
export interface ApprovalRevisionFacts {
  /** The decision the revision belongs to: a notice renders only its OWN decision's revision. */
  decisionId: string;
  /** The approved option's material. */
  material: string;
  /** The holder kind a PMC recorded consent on behalf of; `null` when the decider acted. */
  onBehalfOf: string | null;
}

/** The kinds whose notice renders from a revision the event names (`payload.revisionId`). */
const REVISION_NOTICE_KINDS: ReadonlySet<string> = new Set(['decision.approved', 'decision.reapproved']);

/**
 * 4d-ii-a / A7a — the revision a kinded notice's event NAMES, or `null` when the kind renders from
 * the event alone or the event names none. The feed reader collects these before rendering, so the
 * revisions are read in the SAME snapshot as the notices and their decisions.
 */
export function kindedNoticeRevisionId(kind: string, event: KindedNoticeEvent): string | null {
  if (!REVISION_NOTICE_KINDS.has(kind) || event.eventType !== kind) return null;
  return field(event.payload, 'revisionId');
}

/** The record-only issue's catalog key: a `decision.published` event that demands nothing. */
const RECORD_EFFECT_KEY = 'decision.published.record';

function field(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Render a kinded decision notice from its kind and its bound event, or `null` when this release has
 * no arm for the kind (or the event does not carry what the notice says). The strings and colours
 * are the writers' own functions and constants, so the kinded rendering and the kind-less cache
 * cannot disagree (pinned by `decision-notice.test.ts`).
 */
export function renderKindedDecisionNotice(
  kind: string,
  event: KindedNoticeEvent,
  /** 4d-ii-a / A7a — the revisions the feed's events name, by id, read in the same snapshot. A green
   *  notice whose revision is not here renders nothing. */
  revisions?: ReadonlyMap<string, ApprovalRevisionFacts>,
  /** The decision the notice is stamped with (its `decisionId`, bound to the event's entity by the
   *  seal): the revision the event names must be THIS decision's, or the notice renders nothing
   *  (#665's review round 1 — a payload naming another decision's revision, which the database
   *  seal now refuses at commit for every new bundle, is refused here too for any row already
   *  committed). */
  decisionId?: string,
): { text: string; color: string } | null {
  if (event.eventType !== kind) return null; // the seal binds them; a reader never trusts one for the other
  switch (kind) {
    case 'decision.published': {
      const title = field(event.payload, 'title');
      if (!title) return null;
      return event.effectKey === RECORD_EFFECT_KEY
        ? { text: recordedDecisionNotice(title), color: RECORDED_DECISION_NOTICE_COLOR }
        : { text: pendingDecisionNotice(title), color: PENDING_DECISION_NOTICE_COLOR };
    }
    case 'decision.withdrawn': {
      const title = field(event.payload, 'title');
      const reason = field(event.payload, 'reason');
      if (!title || !reason) return null;
      return { text: withdrawnDecisionNotice(title, reason), color: WITHDRAWN_DECISION_NOTICE_COLOR };
    }
    case 'decision.approved':
    case 'decision.reapproved': {
      // A7a — the approver is the event's frozen envelope (the pair the seal judged at the act);
      // the option and the on-behalf fact are the REVISION's, the one the event names, never the
      // head's. A previous-release event (no envelope, no `revisionId`) has no kinded notice to
      // render — its notice is a kind-less row the cache path serves.
      const title = field(event.payload, 'title');
      const deciderKind = field(event.payload, 'deciderKind');
      const revisionId = kindedNoticeRevisionId(kind, event);
      const revision = revisionId ? revisions?.get(revisionId) : undefined;
      if (!title || !deciderKind || !revision || !event.actorName || !event.actorRole) return null;
      if (!decisionId || revision.decisionId !== decisionId) return null;
      return {
        text: approvedDecisionNotice({ actorName: event.actorName, actorRole: event.actorRole, title, material: revision.material, deciderKind, onBehalfOf: revision.onBehalfOf }),
        color: APPROVED_DECISION_NOTICE_COLOR,
      };
    }
    default:
      return null;
  }
}

/**
 * Whether a kinded notice about `decision` is served to this viewer. `decision` is the viewer's own
 * visible DTO for the notice's decision, from the slice read in the same snapshot as the notice, or
 * `undefined` when the viewer may not see it (which hides the notice).
 */
export function kindedDecisionNoticeServed(
  kind: string,
  event: KindedNoticeEvent,
  decision: Pick<DecisionDto, 'status' | 'deciderKind' | 'deciderUserId'> | undefined,
  role: string,
  userId: string | undefined,
): boolean {
  if (!decision) return false;
  if (decision.status === 'withdrawn' && ACTIONABLE_DECISION_NOTICE_KINDS.has(kind)) return false;
  if (kind === 'decision.published') {
    const recordDecision = decision.deciderKind === 'none';
    // the event's catalog key must say what the decision is; one that disagrees is not served
    if ((event.effectKey === RECORD_EFFECT_KEY) !== recordDecision) return false;
    // the pending approval demand's audience, exactly the kind-less notice's (snapshot's
    // `stripPendingNotice`): pmc and the decider. A record demands nothing and is team-visible.
    if (!recordDecision && role !== 'pmc') {
      return viewerIsDecider({ deciderKind: decision.deciderKind, deciderUserId: decision.deciderUserId ?? null }, role, userId);
    }
  }
  return true;
}
