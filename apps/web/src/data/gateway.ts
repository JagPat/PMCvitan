/**
 * DataGateway — the seam between the UI and its data source.
 *
 * Today the Zustand store IS the local gateway: it holds the seeded sample
 * project and applies every mutation in-memory (offline-capable by default).
 * When the backend lands (Phase 7), an `apiGateway` implements this same
 * interface over the ts-rest API + TanStack Query, and the screens don't change.
 *
 * This file documents the contract so the swap stays mechanical. It is
 * intentionally not wired into the components yet — the store's actions are the
 * current implementation of these operations.
 */

import type {
  Activity,
  Checklist,
  DailyLog,
  Decision,
  AppNotification,
  Review,
} from '@vitan/shared';

export interface ProjectSnapshot {
  decisions: Decision[];
  activities: Activity[];
  checklist: Checklist;
  review: Review;
  dailyLog: DailyLog;
  notifications: AppNotification[];
}

export interface DataGateway {
  /** Load the full project snapshot for the active project. */
  loadProject(projectId: string): Promise<ProjectSnapshot>;

  /** Client approves and locks an option on a decision. */
  approveDecision(decisionId: string, optionIndex: number): Promise<Decision>;
  /** Raise a change request against a locked decision. */
  requestChange(decisionId: string, reason: string, costImpact: number, timeImpactDays: number): Promise<Decision>;

  /** Engineer submits a guarded inspection checklist. */
  submitInspection(checklist: Checklist): Promise<void>;
  /** PMC approves an inspection or sends rejections (creating re-inspection tasks). */
  decideReview(reviewId: string, rejectedItemNames: string[]): Promise<void>;

  /** Start / complete a site activity (complete auto-creates a closing inspection). */
  startActivity(activityId: string): Promise<Activity>;
  completeActivity(activityId: string): Promise<Activity>;

  /** Daily log mutations (offline-first: queued locally and flushed on reconnect). */
  submitDailyLog(log: DailyLog): Promise<void>;
  flagMaterialMismatch(materialIndex: number): Promise<void>;
}
