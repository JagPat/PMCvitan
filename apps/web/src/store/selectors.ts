/**
 * Derived selectors — pure functions of AppState.
 *
 * Nothing here is stored; everything is recomputed from the raw slices, exactly
 * as the prototype's renderVals() does on each render. This is what keeps the
 * interconnected flows consistent: approving a decision flips a schedule gate,
 * flagging a material blocks an activity, etc. These selectors are the unit-test
 * surface for the core loop.
 */

import type { Activity, Decision, DecisionStatus, Gate } from '@vitan/shared';
import type { AppState } from './store';

/** Day window for the schedule timeline (1 Jun .. 15 Aug). */
export const WIN = 75;
export const pctOf = (d: number): number => (d / WIN) * 100;

// ---- decisions ----

export function selectPending(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.status === 'pending');
}

/** Decision log is permission-filtered: contractor & engineer never see pending rows. */
export function selectLogDecisions(s: AppState): Decision[] {
  if (s.role === 'contractor' || s.role === 'engineer') {
    return s.decisions.filter((d) => d.status !== 'pending');
  }
  return s.decisions;
}

// ---- inspections ----

export function selectReviewPending(s: AppState): number {
  return s.review.decided ? 0 : 1;
}

export function selectFailedItems(s: AppState): number {
  return s.review.items.filter((it) => it.result === 'FAIL' || it.rejected).length;
}

/**
 * Dashboard "failed items awaiting re-inspection". Note the ternary can RISE
 * after the PMC rejects PASS items and sends re-inspection — mirror it exactly.
 */
export function selectFailedCount(s: AppState): number {
  return s.reinspectionCreated
    ? selectFailedItems(s)
    : s.review.items.filter((it) => it.result === 'FAIL').length;
}

// ---- schedule ----

export function decStatusOf(s: AppState, id: string | null): DecisionStatus | null {
  if (!id) return null;
  const d = s.decisions.find((x) => x.id === id);
  return d ? d.status : null;
}

/**
 * The Decision gate is computed LIVE from the linked decision's status — this is
 * the cross-link that flips ACT-31's D gate to green the moment the client
 * approves DL-014. Never store it.
 */
export function gateDStateFor(s: AppState, a: Activity): Gate {
  if (!a.decisionId) return 'na';
  const st = decStatusOf(s, a.decisionId);
  return st === 'approved' ? 'ok' : 'wait';
}

export interface GateVM {
  k: 'D' | 'M' | 'T' | 'I';
  label: string;
  v: Gate;
}

export function gatesFor(s: AppState, a: Activity): GateVM[] {
  return [
    { k: 'D', label: 'Decision locked', v: gateDStateFor(s, a) },
    { k: 'M', label: 'Material on site', v: a.gm },
    { k: 'T', label: 'Team present', v: a.gt },
    { k: 'I', label: 'Inspection passed', v: a.gi },
  ];
}

const gateReady = (g: Gate) => g === 'ok' || g === 'na';

/** An activity can Start only when all four gates align (ok or n/a). */
export function activityReady(s: AppState, a: Activity): boolean {
  return gatesFor(s, a).every((g) => gateReady(g.v));
}

export function selectSchToday(s: AppState): { inProgress: number; doneWeek: number; blocked: number } {
  return {
    inProgress: s.activities.filter((a) => a.status === 'in-progress').length,
    doneWeek: s.activities.filter((a) => a.status === 'done').length,
    blocked: s.activities.filter((a) => a.status === 'blocked').length,
  };
}

export function selectTodayMarkerPct(s: AppState): number {
  return pctOf(s.todayDay);
}

// ---- daily log ----

export function selectTotalWorkers(s: AppState): number {
  return s.dailyLog.crew.reduce((a, c) => a + c.count, 0);
}
