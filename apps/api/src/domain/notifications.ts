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
