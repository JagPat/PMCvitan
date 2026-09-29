import type { DailyLog, EngineerTodayAction, EngineerTodayStep } from '@vitan/shared';
import { todayCivil } from '@/lib/civilDate';

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
 */
export function todayPath(latest: DailyLog | null, totalWorkers: number, today?: string, timeZone?: string | null): TodayPath {
  // a sent log with no civil date (a legacy row) is history too: the server lets a new day start
  // over any submitted log, and the Site screen offers it
  const earlierDaySent = !!latest?.submitted && (!latest.logDate || (!!today && latest.logDate < today));
  const log = earlierDaySent ? null : latest;
  const done: Record<EngineerTodayStep, boolean> = {
    checkIn: !!log?.checkedIn,
    crew: !!log && totalWorkers > 0,
    photos: !!log && hasPhotoEvidence(log, timeZone),
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
 * Photos taken for THIS log. `progress` counts photos added on this device before the send (it is
 * only persisted with the send), so it alone forgets them on a reload. The persisted evidence is
 * the progress media itself: `photos` is the project's recent progress media, which can belong to
 * earlier days, so a photo counts only when its own capture time falls on the log's civil date in
 * the project's zone. A photo with no capture time can't be placed on a day and isn't counted.
 */
function hasPhotoEvidence(log: DailyLog, timeZone?: string | null): boolean {
  if (log.progress > 0) return true;
  if (!log.logDate) return false;
  return log.photos.some((p) => {
    if (!p.takenAt) return false;
    const at = new Date(p.takenAt);
    return !Number.isNaN(at.getTime()) && todayCivil(timeZone, at) === log.logDate;
  });
}
