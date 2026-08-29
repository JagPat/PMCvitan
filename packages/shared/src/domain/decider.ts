/**
 * Phase 6 task 4b (§A.3) — the ONE viewer/decider audience predicate, shared by the server
 * visibility rule (`decisionVisibleToViewer` in the API's decision-serialize), the projection
 * read-path filter, and the web store's client-side visibility mirrors
 * (`selectLogDecisions`/`selectVisibleDecisions`) — so the surfaces cannot drift.
 */
import type { DeciderKind, TokenRole } from './types';

/** The decider-designation slice of a decision every audience predicate consumes. */
export interface DeciderSlice {
  deciderKind: DeciderKind | string;
  /** the NAMED member's resolved user — the value the targeted dispatch and every filter compare */
  deciderUserId?: string | null;
}

/**
 * Is this viewer THE DECIDER of the decision? `client`/`pmc` designate the ROLE (any member of
 * it decides); `member` designates ONE user, so a same-role non-decider is NOT the decider;
 * `none` is a record — nobody decides it.
 */
export function viewerIsDecider(d: DeciderSlice, role: TokenRole | string, userId?: string | null): boolean {
  if (d.deciderKind === 'client') return role === 'client';
  if (d.deciderKind === 'pmc') return role === 'pmc';
  if (d.deciderKind === 'member') return !!userId && d.deciderUserId === userId;
  return false;
}
