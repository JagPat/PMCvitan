import type { DailyLog, EngineerTodayAction, EngineerTodayStep } from '@vitan/shared';

export const TODAY_STEPS: readonly EngineerTodayStep[] = ['checkIn', 'crew', 'photos', 'send'];

export type TodayPath = {
  /** each step's done state, read from the log itself — never assumed */
  done: Record<EngineerTodayStep, boolean>;
  /** the one thing to do now */
  action: EngineerTodayAction;
  doneCount: number;
  /** the log can be sent now — the server's own rule: it exists, is checked in, and isn't sent.
   *  Crew and photos are suggestions on the path, never gates (a rain-day log has neither). */
  canSend: boolean;
  /** the civil date of an EARLIER day's log that was never sent and is still the one on screen —
   *  so the card names that date instead of calling it today's */
  overdue: string | null;
};

/**
 * The engineer's day as four steps, derived from the daily log the Site screen already records.
 * A pure read: nothing here is stored, so the path can only ever say what the log says.
 *
 * The server serves the project's LATEST log, not today's. A log already sent on an earlier civil
 * day (`today` is the project's civil date), or with no civil date at all, is finished business:
 * today has not started, so the action is to start it — the Site screen's "Start new day". An
 * earlier log never sent stays the one to finish, as it does on the Site screen, and is flagged
 * `overdue` with its own date.
 *
 * `crewConfirmed` is the engineer's own answer to every crew question for this unsent log (U1): a
 * no-crew day is then an answered step, not a gap. It comes from the pending draft, so it holds only
 * for the log it was given for and is gone once the log is sent; a sent log's path is the record.
 */
export function todayPath(latest: DailyLog | null, totalWorkers: number, today?: string, crewConfirmed = false): TodayPath {
  // a sent log with no civil date (a legacy row) is history too: the server lets a new day start
  // over any submitted log, and the Site screen offers it
  const earlierDaySent = !!latest?.submitted && (!latest.logDate || (!!today && latest.logDate < today));
  const log = earlierDaySent ? null : latest;
  const done: Record<EngineerTodayStep, boolean> = {
    checkIn: !!log?.checkedIn,
    crew: !!log && (totalWorkers > 0 || (crewConfirmed && !log.submitted)),
    photos: !!log && hasPhotoEvidence(log),
    send: !!log?.submitted,
  };
  const doneCount = TODAY_STEPS.filter((k) => done[k]).length;
  let action: EngineerTodayAction;
  if (!log) action = 'start';
  else if (log.submitted) action = 'done';
  else action = TODAY_STEPS.find((k) => !done[k]) ?? 'send';
  const canSend = !!log && log.checkedIn && !log.submitted;
  const overdue = log && !log.submitted && log.logDate && today && log.logDate < today ? log.logDate : null;
  return { done, action, doneCount, canSend, overdue };
}

/**
 * Photos taken for THIS log: the log's own `progress` count, and nothing else. The log's `photos`
 * list is the project's recent progress media — not linked to any log, and a second log can start
 * on the same civil day — so no date rule can say which log a photo belongs to, and it is never
 * counted. The server persists `progress` only with the send; until then the store's pending draft
 * (store/dailyLogDraft.ts, #669) carries the photos taken on this device for this log across every
 * reconcile and a reload, so the step reads as done where they were taken. Photos taken on ANOTHER
 * device for the same unsent log are not known here; that never withholds anything, because crew
 * and photos are suggestions and the card always offers Send for a checked-in log. Exact per-log
 * evidence needs the upload to carry its `dailyLogId` (an API change for a later unit).
 */
function hasPhotoEvidence(log: DailyLog): boolean {
  return log.progress > 0;
}
