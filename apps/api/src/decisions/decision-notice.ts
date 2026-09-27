import { viewerIsDecider } from '@vitan/shared';
import {
  PENDING_DECISION_NOTICE_COLOR,
  RECORDED_DECISION_NOTICE_COLOR,
  WITHDRAWN_DECISION_NOTICE_COLOR,
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
 * changed, is still announced as the act happened. Nothing writes a kinded notice before A7, which
 * stamps the decision writers; until then these rules govern only planted rows.
 *
 * Two rules, both decisions-owned because they are decision semantics:
 * - {@link renderKindedDecisionNotice}: kind + event → text and colour. An arm exists only where the
 *   event carries everything the notice says; any other kind renders NOTHING (the row is omitted),
 *   never its stored text. Arms join as their writers do: the green approved notice renders from the
 *   revision its event names (A7, with A8a's `revisionId`), the forwarding and countersign notices
 *   with their commands.
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
export function renderKindedDecisionNotice(kind: string, event: KindedNoticeEvent): { text: string; color: string } | null {
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
