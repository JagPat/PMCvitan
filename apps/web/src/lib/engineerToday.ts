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
 */
export function todayPath(log: DailyLog | null, totalWorkers: number): TodayPath {
  const done: Record<EngineerTodayStep, boolean> = {
    checkIn: !!log?.checkedIn,
    crew: !!log && totalWorkers > 0,
    photos: !!log && (log.progress > 0 || log.photos.length > 0),
    send: !!log?.submitted,
  };
  const doneCount = TODAY_STEPS.filter((k) => done[k]).length;
  let action: EngineerTodayAction;
  if (!log) action = 'start';
  else if (log.submitted) action = 'done';
  else action = TODAY_STEPS.find((k) => !done[k]) ?? 'send';
  return { done, action, doneCount };
}
