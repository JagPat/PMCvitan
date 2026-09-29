/**
 * Notification text helpers — a single source of truth so the snapshot's role-based
 * filter can't drift from how the text is produced.
 *
 * A "pending decision" notice announces that a decision is awaiting the client's
 * approval. Pending decisions are visible only to pmc/client (see AUTH-02 / the
 * snapshot's `hidePending`), so this notice must be filtered out of the notification
 * feed for every other role — otherwise the decision's title leaks through the bell
 * even though the decision itself is hidden.
 */
import { ROLE_LABEL } from '../common/actor';

const PENDING_DECISION_PREFIX = 'Decision awaiting approval';

/**
 * Phase 6 task 4d-ii-a / A4c — the colour each decision notice is written with, beside its text,
 * so the writers and the kinded renderer (`decisions/decision-notice.ts`) read one definition and a
 * tripwire can pin them together.
 */
export const PENDING_DECISION_NOTICE_COLOR = '#C08A2D';
export const RECORDED_DECISION_NOTICE_COLOR = '#6B665C';
export const WITHDRAWN_DECISION_NOTICE_COLOR = '#6B665C';
/** Phase 6 task 4d-ii-a / A7a — the green approved notice's colour, named beside its text so the
 *  approve writer and the kinded renderer read one definition. */
export const APPROVED_DECISION_NOTICE_COLOR = '#3F7A54';
/** Phase 6 task 4d-ii-a / A8a — the forwarded notice is an ACTION ITEM for the new holder, written in
 *  the pending demand's colour; the provisional approval's notice is the awaiting colour the shared
 *  status chip uses (`packages/shared/src/tokens/colors.ts`), never green. */
export const FORWARDED_DECISION_NOTICE_COLOR = '#C08A2D';
export const AWAITING_COUNTERSIGN_NOTICE_COLOR = '#31567F';

/** The notification text shown when a PMC issues a decision (awaiting client approval). */
export function pendingDecisionNotice(title: string): string {
  return `${PENDING_DECISION_PREFIX}: ${title}`;
}

/** True when a notification announces a pending decision (pmc/client-only information). */
export function isPendingDecisionNotice(text: string): boolean {
  return text.startsWith(PENDING_DECISION_PREFIX);
}

/**
 * A "withdrawn decision" notice explains, to the authority that manages decisions, that a
 * published question was taken back and why. §A.3 (Phase 6 task 4a) makes a withdrawn
 * decision PMC-ONLY — it was pmc/client-visible while pending, and withdrawal must not widen
 * an audience — so this notice (title + reason) is stripped from every non-pmc feed,
 * including the client's, by the same mechanism that strips pending notices.
 */
const WITHDRAWN_DECISION_PREFIX = 'Decision withdrawn';

/** The notification text appended when a PMC withdraws a published, never-approved decision. */
export function withdrawnDecisionNotice(title: string, reason: string): string {
  return `${WITHDRAWN_DECISION_PREFIX}: ${title} — ${reason}`;
}

/** True when a notification announces a withdrawal (pmc-only information). */
export function isWithdrawnDecisionNotice(text: string): boolean {
  return text.startsWith(WITHDRAWN_DECISION_PREFIX);
}

/**
 * Phase 6 task 4b (§A.2) — the record-only issue's announcement. ORDINARY published-decision
 * audience (a team record, not a pending approval), and DELIBERATELY not matching any pending
 * stripping shape: `isPendingDecisionNotice` must never hide it and no surface may read it as
 * an approval demand.
 */
const RECORDED_DECISION_PREFIX = 'Issue recorded';

export function recordedDecisionNotice(title: string): string {
  return `${RECORDED_DECISION_PREFIX}: ${title}`;
}

export function isRecordedDecisionNotice(text: string): boolean {
  return text.startsWith(RECORDED_DECISION_PREFIX);
}

/**
 * Phase 6 task 4d-ii-a / A7a — the green APPROVED notice ("X approved T — M"), which the delivered
 * `approve` composed inline (Phase 3 gate finding 7: the announcement says who exercised the
 * authority, and an on-behalf approval is never disguised as the decider's own). One function now,
 * because the notice is KINDED from A7a: the approve writer caches this text on the row, and the
 * kinded renderer (`decisions/decision-notice.ts`) rebuilds it from the event's frozen actor
 * envelope and the revision the event names, so the two readings must be one definition.
 */
export interface ApprovedDecisionNoticeFacts {
  /** The act-time actor pair: who exercised the authority, and in which role. */
  actorName: string;
  actorRole: string;
  title: string;
  /** The approved option's material, from the revision the act wrote. */
  material: string;
  /** The holder kind the act was judged against (`Decision.deciderKind` at the act). */
  deciderKind: string;
  /** The holder kind a PMC recorded consent on behalf of; `null` when the decider acted. */
  onBehalfOf: string | null;
}

export function approvedDecisionNotice(f: ApprovedDecisionNoticeFacts): string {
  if (f.onBehalfOf) {
    return `${f.actorName} (${ROLE_LABEL[f.actorRole] ?? f.actorRole}) approved ${f.title} on behalf of the ${f.onBehalfOf === 'member' ? 'named decider' : f.onBehalfOf} — ${f.material}`;
  }
  return f.deciderKind === 'client'
    ? `Client approved ${f.title} — ${f.material}`
    : `${f.actorName} approved ${f.title} — ${f.material}`;
}

/**
 * Phase 6 task 4d-ii-a / A8a (§A.2, the forwarding notice) — "Decision forwarded: T → <new holder>".
 * `toLabel` is the new holder's display identity FROZEN at the act (a named member's name, or the
 * role's label), carried on the `decision.forwarded` event the kinded renderer reads.
 */
const FORWARDED_DECISION_PREFIX = 'Decision forwarded';

export function forwardedDecisionNotice(title: string, toLabel: string): string {
  return `${FORWARDED_DECISION_PREFIX}: ${title} → ${toLabel}`;
}

/** The display label of a forward target designation (a role), as the notice names it. */
export const DESIGNATION_ROLE_LABEL: Record<'client' | 'pmc' | 'architect', string> = {
  client: 'the client',
  pmc: 'the PMC',
  architect: 'the architect',
};

/**
 * Phase 6 task 4d-ii-a / A8a (§A.2, "the durable Notification tells the truth about finality") —
 * under an ACTIVE chain the provisional approve writes THIS notice instead of the green one: the same
 * announcement of who exercised the authority, with the finality it lacks stated — the countersign is
 * still to come. The finalizer (A8b) writes the green notice from the revision's frozen approver facts.
 */
const PROVISIONAL_APPROVAL_SUFFIX = " — awaiting the architect's countersign";

export function provisionalApprovalNotice(f: ApprovedDecisionNoticeFacts): string {
  return `${approvedDecisionNotice(f)}${PROVISIONAL_APPROVAL_SUFFIX}`;
}
