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
const PENDING_DECISION_PREFIX = 'Decision awaiting approval';

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
 * Phase 6 unit 4c-ii (§A) — the two consultation push bodies.
 *
 * Both are TARGETED at one user (the consultee, then the requester), never a role fan-out: a
 * consultation widens the audience of a decision by exactly one person, so a role-addressed
 * announcement would hand a pending decision to every same-role member who cannot see it.
 *
 * Neither body carries the QUESTION or the ANSWER. A push is delivered to a device lock screen
 * outside the app's authorization, and the substance of a consultation belongs to the decision's
 * audience — the notice says that something awaits, and the app is where it is read.
 */
const CONSULTATION_REQUESTED_PREFIX = 'Your input requested';

export function consultationRequestedNotice(decisionTitle: string, requestedBy: string): string {
  return `${CONSULTATION_REQUESTED_PREFIX}: ${requestedBy} asked for your view on “${decisionTitle}”`;
}

export function isConsultationRequestedNotice(text: string): boolean {
  return text.startsWith(CONSULTATION_REQUESTED_PREFIX);
}

const CONSULTATION_ANSWERED_PREFIX = 'Consultation answered';

export function consultationAnsweredNotice(decisionTitle: string, respondedBy: string): string {
  return `${CONSULTATION_ANSWERED_PREFIX}: ${respondedBy} replied on “${decisionTitle}”`;
}

export function isConsultationAnsweredNotice(text: string): boolean {
  return text.startsWith(CONSULTATION_ANSWERED_PREFIX);
}
