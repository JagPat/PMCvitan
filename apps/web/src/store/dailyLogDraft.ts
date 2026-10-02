import type { DailyLog } from '@vitan/shared';

/**
 * The engineer's UNSENT work on the day's log — check-in, crew counts and the progress photos taken —
 * as a project- and log-scoped pending draft.
 *
 * Why this exists (the #669 Today regression, Field Lab QA 2026-09-30): the server persists check-in,
 * crew and `progress` only when the log is SENT (`submitDailyLog` carries them); until then they live
 * in the client's `dailyLog` alone. Every other write on the way to Send — a material recorded, a
 * progress photo uploaded — reconciles the store from the server (the command's own snapshot, or the
 * module read under module ownership), and that reconcile REPLACED the client log with the server's
 * unsent values: the engineer who had checked in and counted a crew was back at "Check in", and Today
 * could never reach Send through the four steps. The draft is the canonical owner of that unsent work:
 * the writers record into it, every reconcile overlays it onto the server's log, and it is durable
 * across a reload (persisted beside the outbox, under the same user + project key).
 *
 * The draft never invents a completed step: it holds only what the engineer did on THIS device for
 * THIS log, and it is DROPPED — never carried — when the server's log is no longer the one it was
 * written against: the log was sent (the send landed; the server now holds the values), a new day's
 * log replaced it, or the project has no log. Two logs can start on the same civil day, so the key is
 * the civil date of the UNSENT log the draft was written against; a sent log drops the draft first.
 * A reconcile can also jump straight from one unsent log to ANOTHER of the same civil day (another
 * device sent the first and started a second), with no sent state in between, so the draft also
 * records the server's id for its log and applies to no log with a different id (U1, #690).
 */
export type DailyLogDraft = {
  /** the project the draft belongs to — applied to no other project's log */
  projectId: string;
  /** the log the draft was written against: its civil date (`logDate`), or the legacy display date */
  logKey: string;
  /** that log's server id, when the server sent one — a draft never applies to a log with another id */
  logId?: string;
  /** the engineer's check-in (or check-out) on this device, when recorded */
  checkIn?: { checkedIn: boolean; checkinTime: string | null };
  /** LEGACY (drafts written before U1 round 4): crew counts keyed by trade text. Still read, for the
   *  first row of each trade only; never written. */
  crew?: Record<string, number>;
  /** the crew counts the engineer set, by ROW POSITION (absolute — the latest count, not a delta),
   *  each with the trade it was set on: a free-text trade can never collide with another row's key,
   *  and a count is applied only where that position still holds that trade */
  crewRows?: Record<string, { trade: string; count: number }>;
  /** progress photos taken for this log on this device, beyond what the server holds */
  photosAdded?: number;
  /** the engineer answered every crew question for this log (a no-crew day is an answer, not a gap) */
  crewConfirmed?: boolean;
};

/** the identity a draft is written against: the civil date of the log, or its legacy display date */
export function dailyLogKey(log: Pick<DailyLog, 'date' | 'logDate'>): string {
  return log.logDate ? `civil:${log.logDate}` : `date:${log.date}`;
}

/** THIS log's identity: its server id when it has one (two logs can share a civil day), else the
 *  civil-date key. */
export function dailyLogIdentity(log: Pick<DailyLog, 'id' | 'date' | 'logDate'>): string {
  return log.id ? `id:${log.id}` : dailyLogKey(log);
}

/** A draft that still applies to the server's log: same project, same log, and the log is unsent.
 *  When both carry a server id the ids must match. A draft written before the id existed is matched
 *  on the civil-date key once, and is then bound to that log's id by `overlayDailyLogDraft` (dropping
 *  it instead would lose every in-flight draft at upgrade, the #675 regression); the server serves no
 *  log without an id from this release on (`DailyLogQueryService.projectionSlice`). */
export function draftAppliesTo(draft: DailyLogDraft | null, serverLog: DailyLog | null, projectId: string): boolean {
  if (!draft || draft.projectId !== projectId) return false;
  if (!serverLog || serverLog.submitted) return false;
  if (draft.logId && serverLog.id) return draft.logId === serverLog.id;
  return dailyLogKey(serverLog) === draft.logKey;
}

/**
 * The server's log with the engineer's unsent work laid over it. Pure: returns the merged log and the
 * draft that survives — `null` when the draft no longer applies (sent, superseded by a new day, or no
 * log) — and never touches the inputs. The server's own truth wins where it is stronger: a log the
 * server already holds as checked in stays checked in, and a trade the draft never touched keeps the
 * server's count. `progress` is the server's count plus the photos taken here since.
 */
export function overlayDailyLogDraft(
  serverLog: DailyLog | null,
  draft: DailyLogDraft | null,
  projectId: string,
): { log: DailyLog | null; draft: DailyLogDraft | null } {
  // a draft written for another project is not this project's business — leave it as it is
  if (draft && draft.projectId !== projectId) return { log: serverLog, draft };
  if (!draft || !serverLog || !draftAppliesTo(draft, serverLog, projectId)) return { log: serverLog, draft: null };
  // a draft written before the log carried an id is bound to the first log it is laid over, so from
  // then on it never applies to another log of the same day
  const kept: DailyLogDraft = !draft.logId && serverLog.id ? { ...draft, logId: serverLog.id } : draft;
  const log: DailyLog = {
    ...serverLog,
    checkedIn: serverLog.checkedIn || (kept.checkIn?.checkedIn ?? false),
    checkinTime: serverLog.checkinTime ?? (kept.checkIn?.checkedIn ? kept.checkIn.checkinTime : null),
    crew: serverLog.crew.map((c, i) => {
      const row = kept.crewRows?.[String(i)];
      if (row && row.trade === c.trade) return { ...c, count: row.count };
      // a legacy trade-keyed count applies to the first row of that trade only
      const first = serverLog.crew.findIndex((x) => x.trade === c.trade) === i;
      return first && kept.crew && Object.hasOwn(kept.crew, c.trade) ? { ...c, count: kept.crew[c.trade]! } : c;
    }),
    progress: serverLog.progress + (kept.photosAdded ?? 0),
  };
  // a check-OUT recorded here after the server never saw the check-in: the engineer's latest word stands
  if (kept.checkIn && !kept.checkIn.checkedIn && !serverLog.checkedIn) {
    log.checkedIn = false;
    log.checkinTime = null;
  }
  return { log, draft: kept };
}

/** Parse a persisted draft, admitting only the shape this module writes (anything else is dropped). */
export function parseDailyLogDraft(raw: unknown): DailyLogDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.projectId !== 'string' || typeof d.logKey !== 'string') return null;
  const draft: DailyLogDraft = { projectId: d.projectId, logKey: d.logKey };
  if (typeof d.logId === 'string' && d.logId) draft.logId = d.logId;
  if (d.checkIn && typeof d.checkIn === 'object') {
    const c = d.checkIn as Record<string, unknown>;
    if (typeof c.checkedIn === 'boolean' && (c.checkinTime === null || typeof c.checkinTime === 'string')) {
      draft.checkIn = { checkedIn: c.checkedIn, checkinTime: c.checkinTime };
    }
  }
  if (d.crew && typeof d.crew === 'object') {
    const crew: Record<string, number> = {};
    for (const [trade, count] of Object.entries(d.crew as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) crew[trade] = count;
    }
    draft.crew = crew;
  }
  if (typeof d.photosAdded === 'number' && Number.isInteger(d.photosAdded) && d.photosAdded >= 0) draft.photosAdded = d.photosAdded;
  if (d.crewRows && typeof d.crewRows === 'object') {
    const rows: Record<string, { trade: string; count: number }> = {};
    for (const [at, v] of Object.entries(d.crewRows as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (/^\d+$/u.test(at) && r && typeof r.trade === 'string' && typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0) {
        rows[at] = { trade: r.trade, count: r.count };
      }
    }
    draft.crewRows = rows;
  }
  if (d.crewConfirmed === true) draft.crewConfirmed = true;
  return draft;
}
