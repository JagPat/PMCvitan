import type { DailyLog, EngineerTodayAction, EngineerTodayStep } from '@vitan/shared';

export const TODAY_STEPS: readonly EngineerTodayStep[] = ['checkIn', 'crew', 'photos', 'send'];

export type TodayPath = {
  /** each step's done state, read from the log itself — never assumed */
  done: Record<EngineerTodayStep, boolean>;
  /** the one thing to do now */
  action: EngineerTodayAction;
  doneCount: number;
};

/**
 * The engineer's day as four steps, derived from the daily log the Site screen already records.
 * A pure read: nothing here is stored, so the path can only ever say what the log says.
 *
 * The server serves the project's LATEST log, not today's. A log already sent on an earlier civil
 * day (`today` is the project's civil date), or with no civil date at all, is finished business: today has not started, so the
 * action is to start it — the Site screen's "Start new day". An earlier log never sent stays the
 * one to finish, as it does on the Site screen.
 */
export function todayPath(latest: DailyLog | null, totalWorkers: number, today?: string): TodayPath {
  // a sent log with no civil date (a legacy row) is history too: the server lets a new day start
  // over any submitted log, and the Site screen offers it
  const earlierDaySent = !!latest?.submitted && (!latest.logDate || (!!today && latest.logDate < today));
  const log = earlierDaySent ? null : latest;
  const done: Record<EngineerTodayStep, boolean> = {
    checkIn: !!log?.checkedIn,
    crew: !!log && totalWorkers > 0,
    // `progress` counts this log's photos; `photos` is the project's recent progress media, which
    // can belong to earlier days, so it is never evidence for today
    photos: !!log && log.progress > 0,
    send: !!log?.submitted,
  };
  const doneCount = TODAY_STEPS.filter((k) => done[k]).length;
  let action: EngineerTodayAction;
  if (!log) action = 'start';
  else if (log.submitted) action = 'done';
  else action = TODAY_STEPS.find((k) => !done[k]) ?? 'send';
  return { done, action, doneCount };
}
