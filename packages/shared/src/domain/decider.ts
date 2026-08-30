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

/**
 * Phase 6 unit 4c-ii (§A) — the CONSULTATION audience slice a decision carries for every viewer
 * predicate. One standing consultation per entry; `consulteeUserId` is the DECISIONS-OWNED
 * canonical audience column, resolved server-side exactly like `deciderUserId`, so the server
 * visibility rule, the projection read-path filter and the web store mirrors all compare the same
 * value and cannot drift.
 */
export interface ConsultationAudienceEntry {
  readonly consulteeUserId: string;
  /** the cycle the question was asked in — frozen at request time */
  readonly openCycle: number;
}

/**
 * Is this viewer a STANDING consultee of the decision?
 *
 * "Standing" is a CYCLE test, not a status test (review round 28). Consult A in cycle 0, approve,
 * then `requestChange` returns the decision to the open `change` status while A's append-only
 * consultation row remains by design. An audience arm keyed on "open status AND a consultation
 * naming A" would then expose the REOPENED cycle to A — a question nobody consulted them on. The
 * confidentiality decision is the READ, so the read is what the cycle governs: a consultation
 * grants visibility only while its frozen `openCycle` still equals the decision's current cycle.
 */
export function viewerIsConsultee(
  consultations: readonly ConsultationAudienceEntry[] | undefined,
  currentCycle: number | undefined,
  userId?: string | null,
): boolean {
  if (!userId || !consultations?.length) return false;
  return consultations.some((c) => c.consulteeUserId === userId && c.openCycle === (currentCycle ?? 0));
}
