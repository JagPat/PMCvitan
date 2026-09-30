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
 */
export type DailyLogDraft = {
  /** the project the draft belongs to — applied to no other project's log */
  projectId: string;
  /** the log the draft was written against: its civil date (`logDate`), or the legacy display date */
  logKey: string;
  /** the engineer's check-in (or check-out) on this device, when recorded */
  checkIn?: { checkedIn: boolean; checkinTime: string | null };
  /** the crew counts the engineer set, by trade (absolute — the latest count, not a delta) */
  crew?: Record<string, number>;
  /** progress photos taken for this log on this device, beyond what the server holds */
  photosAdded?: number;
};

/** the identity a draft is written against: the civil date of the log, or its legacy display date */
export function dailyLogKey(log: Pick<DailyLog, 'date' | 'logDate'>): string {
  return log.logDate ? `civil:${log.logDate}` : `date:${log.date}`;
}

/** A draft that still applies to the server's log: same project, same log, and the log is unsent. */
export function draftAppliesTo(draft: DailyLogDraft | null, serverLog: DailyLog | null, projectId: string): boolean {
  if (!draft || draft.projectId !== projectId) return false;
  if (!serverLog || serverLog.submitted) return false;
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
  const log: DailyLog = {
    ...serverLog,
    checkedIn: serverLog.checkedIn || (draft.checkIn?.checkedIn ?? false),
    checkinTime: serverLog.checkinTime ?? (draft.checkIn?.checkedIn ? draft.checkIn.checkinTime : null),
    crew: serverLog.crew.map((c) => (draft.crew && c.trade in draft.crew ? { ...c, count: draft.crew[c.trade]! } : c)),
    progress: serverLog.progress + (draft.photosAdded ?? 0),
  };
  // a check-OUT recorded here after the server never saw the check-in: the engineer's latest word stands
  if (draft.checkIn && !draft.checkIn.checkedIn && !serverLog.checkedIn) {
    log.checkedIn = false;
    log.checkinTime = null;
  }
  return { log, draft };
}

/** Parse a persisted draft, admitting only the shape this module writes (anything else is dropped). */
export function parseDailyLogDraft(raw: unknown): DailyLogDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.projectId !== 'string' || typeof d.logKey !== 'string') return null;
  const draft: DailyLogDraft = { projectId: d.projectId, logKey: d.logKey };
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
  return draft;
}
