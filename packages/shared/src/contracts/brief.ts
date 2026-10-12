/**
 * U3a — `GET /me/brief`, the PMC's daily brief across every project they run (design review,
 * PMC · Brief board). Identity-scoped like `/me/portfolio`: one row per non-archived project where
 * the caller holds the PMC role (an active `pmc` membership, or org owner/admin reach). Every count
 * is that project's own, on its own civil calendar (`Project.timeZone`): "today" is the site's
 * today and "since yesterday" starts at the site's midnight yesterday.
 *
 * Read-only and additive: no schedule verdict ("On track", "At risk") — there is no rule for one —
 * and no crew-versus-plan figure (labour readiness is pilot-gated).
 */
export interface PmcBriefProject {
  readonly projectId: string;
  readonly name: string;
  readonly short: string;
  readonly orgName: string | null;
  /** the site's civil today (ISO) the figures below are counted against */
  readonly today: string;
  /** today's daily log: sent, started and not sent, or not started */
  readonly logToday: 'sent' | 'open' | 'missing';
  /** Top 10 #3 gap 13 (#799) — the log `logToday` judged, or null when none was started. Optional: an older
   *  server omits it, and the brief then opens the screen rather than a record. */
  readonly logTodayId?: string | null;
  /** inspections submitted and waiting for the PMC's review */
  readonly reviewsWaiting: number;
  /** the inspection waiting when exactly one waits (`reviewsWaiting === 1`), else null. Optional, as above. */
  readonly waitingReviewId?: string | null;
  /** published decisions the client holds that wait on them (new, or reopened) */
  readonly waitingOnClient: number;
  /** when the longest-waiting of those was published (ISO instant), or null when none waits */
  readonly oldestWaitingSince: string | null;
  /** the decision waiting when exactly one waits on the client (`waitingOnClient === 1`), else null. Optional, as above. */
  readonly waitingDecisionId?: string | null;
  /** since the site's midnight yesterday */
  readonly sinceYesterday: {
    /** client approvals recorded (a PMC-recorded consent on the client's behalf included) */
    readonly approvals: number;
    /** progress photos added */
    readonly photos: number;
    /** inspections rejected */
    readonly rejectedInspections: number;
  };
}

export interface PmcBriefResult {
  readonly projects: readonly PmcBriefProject[];
}
