/**
 * Derived selectors — pure functions of AppState.
 *
 * Nothing here is stored; everything is recomputed from the raw slices, exactly
 * as the prototype's renderVals() does on each render. This is what keeps the
 * interconnected flows consistent: approving a decision flips a schedule gate,
 * flagging a material blocks an activity, etc. These selectors are the unit-test
 * surface for the core loop.
 */

import { drawingDisciplineFor, type Activity, type Decision, type DecisionStatus, type Drawing, type Gate, type Phase, type Review, type ScreenKey } from '@vitan/shared';
import type { AppState } from './store';

/** Day window for the schedule timeline (1 Jun .. 15 Aug). */
export const WIN = 75;
export const pctOf = (d: number): number => (d / WIN) * 100;

// ---- decisions ----

export function selectPending(s: AppState): Decision[] {
  // A draft is weightless: it isn't awaiting the client, so it never counts as pending.
  return s.decisions.filter((d) => d.status === 'pending' && !d.draft);
}

/** Decision log is permission-filtered: contractor & engineer never see pending rows.
 *  Private drafts are excluded for everyone — they live only in the Drafts workspace. */
export function selectLogDecisions(s: AppState): Decision[] {
  if (s.role === 'contractor' || s.role === 'engineer') {
    return s.decisions.filter((d) => d.status !== 'pending' && !d.draft);
  }
  return s.decisions.filter((d) => !d.draft);
}

/** Private, unpublished draft decisions — the author's Drafts workspace. */
export function selectDraftDecisions(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.draft);
}

/** Private, unpublished draft drawings — the author's Drafts workspace. */
export function selectDraftDrawings(s: AppState): Drawing[] {
  return s.drawings.filter((d) => d.draft);
}

/** Approved (locked) decisions for the shared surfaces (client health, badge). Excludes
 *  drafts defensively: a draft is never approved today, but this guard keeps these
 *  client-facing reads matching the server's author-only rule regardless of future state. */
export function selectApprovedDecisions(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.status === 'approved' && !d.draft);
}

// ---- inspections ----

/** The review the PMC is acting on: the selected one, else the first pending, else the first. */
export function selectActiveReview(s: AppState): Review | null {
  if (!s.reviews.length) return null;
  const byId = s.activeReviewId ? s.reviews.find((r) => r.id === s.activeReviewId) : undefined;
  if (byId) return byId;
  return s.reviews.find((r) => !r.decided) ?? s.reviews[0];
}

/** How many inspections are still awaiting the PMC's decision (the queue depth). */
export function selectReviewPending(s: AppState): number {
  return s.reviews.filter((r) => !r.decided).length;
}

/** FAIL-or-rejected items across every queued review. */
export function selectFailedItems(s: AppState): number {
  return s.reviews.reduce((n, r) => n + r.items.filter((it) => it.result === 'FAIL' || it.rejected).length, 0);
}

/**
 * Dashboard "failed items awaiting re-inspection". Note the ternary can RISE
 * after the PMC rejects PASS items and sends re-inspection — mirror it exactly.
 */
export function selectFailedCount(s: AppState): number {
  return s.reinspectionCreated
    ? selectFailedItems(s)
    : s.reviews.reduce((n, r) => n + r.items.filter((it) => it.result === 'FAIL').length, 0);
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

// ---- phases (Orgs Slice 3) ----

export interface PhaseRollup {
  activityTotal: number;
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  donePct: number;
}

/**
 * A phase's activity rollup, recomputed LIVE from the activities (so starting or
 * completing an activity moves the phase's progress immediately — the stored
 * snapshot counts are only the initial server value). Same discipline as the
 * schedule gates: derive, never trust a stale stored count.
 */
export function phaseRollup(activities: Activity[], phaseId: string): PhaseRollup {
  const acts = activities.filter((a) => a.phaseId === phaseId);
  const done = acts.filter((a) => a.status === 'done').length;
  const inProgress = acts.filter((a) => a.status === 'in-progress').length;
  const blocked = acts.filter((a) => a.status === 'blocked').length;
  const notStarted = acts.filter((a) => a.status === 'not-started').length;
  return { activityTotal: acts.length, done, inProgress, blocked, notStarted, donePct: acts.length ? Math.round((done / acts.length) * 100) : 0 };
}

/** Activities for a phase, or the "unphased" remainder when `phaseId` is null. */
export function activitiesInPhase(activities: Activity[], phases: Phase[], phaseId: string | null): Activity[] {
  if (phaseId === null) {
    const known = new Set(phases.map((p) => p.id));
    return activities.filter((a) => !a.phaseId || !known.has(a.phaseId));
  }
  return activities.filter((a) => a.phaseId === phaseId);
}

// ---- daily log ----

export function selectTotalWorkers(s: AppState): number {
  return s.dailyLog?.crew.reduce((a, c) => a + c.count, 0) ?? 0;
}

// ---- "Needs you" action queue ----

/** One thing awaiting the current user, with where to go and do it. */
export interface ActionItem {
  key: string;
  title: string;
  detail?: string;
  screen: ScreenKey;
  cta: string;
  tone: 'amber' | 'red' | 'green' | 'ink';
}

const plural = (n: number, s = 's') => (n === 1 ? '' : s);

/**
 * The cross-cutting to-do list for whoever is signed in — aggregated across decisions,
 * drawings, inspections, the daily log and the schedule so each role sees exactly what
 * needs them, with a one-tap jump to act. Pure function of state (recomputed live), so
 * approving/acknowledging/submitting removes the item immediately. The Inbox is the home.
 */
export function selectActionItems(s: AppState): ActionItem[] {
  const items: ActionItem[] = [];
  // Drafts are private + weightless — they never appear as pending/change work for anyone.
  const pending = s.decisions.filter((d) => d.status === 'pending' && !d.draft);
  const changes = s.decisions.filter((d) => d.status === 'change' && !d.draft);
  // private work-in-progress across entity types (decisions + drawings) — the Drafts workspace
  const drafts = [...s.decisions.filter((d) => d.draft), ...s.drawings.filter((d) => d.draft)];
  const unacked = s.drawings.filter((d) => !d.draft && d.current && d.current.status === 'for_construction' && !d.ackedByMe);
  const blocked = s.activities.filter((a) => a.status === 'blocked');
  const names = (xs: { title?: string; name?: string; number?: string }[], n = 3) =>
    xs.slice(0, n).map((x) => x.title ?? x.name ?? x.number ?? '').filter(Boolean).join(', ');

  if (s.role === 'client' && pending.length) {
    items.push({ key: 'client-pending', title: `${pending.length} decision${plural(pending.length)} awaiting your approval`, detail: names(pending), screen: 'client-decisions', cta: 'Review & approve', tone: 'amber' });
  }

  if (s.role === 'engineer') {
    if (s.checklist && !s.checklist.submitted) items.push({ key: 'eng-checklist', title: `Checklist to complete: ${s.checklist.title}`, detail: `${s.checklist.items.length} items · ${s.checklist.zone}`, screen: 'engineer-check', cta: 'Fill & submit', tone: 'amber' });
    if (s.dailyLog && !s.dailyLog.submitted) items.push({ key: 'eng-log', title: `Today's site log isn't submitted`, detail: s.dailyLog.checkedIn ? 'Checked in — submit when the day is logged' : 'Check in at site, then submit', screen: 'daily-log', cta: 'Open daily log', tone: 'ink' });
    if (unacked.length) items.push({ key: 'eng-ack', title: `${unacked.length} drawing${plural(unacked.length)} to acknowledge`, detail: names(unacked), screen: 'drawings', cta: 'Acknowledge current set', tone: 'amber' });
  }

  if (s.role === 'contractor') {
    if (unacked.length) items.push({ key: 'con-ack', title: `${unacked.length} drawing${plural(unacked.length)} to acknowledge`, detail: names(unacked), screen: 'drawings', cta: 'Acknowledge current set', tone: 'amber' });
    if (changes.length) items.push({ key: 'con-change', title: `${changes.length} change request${plural(changes.length)} open`, detail: 'Awaiting the PMC', screen: 'decision-log', cta: 'View', tone: 'ink' });
  }

  if (s.role === 'pmc') {
    if (drafts.length) items.push({ key: 'pmc-drafts', title: `${drafts.length} draft${plural(drafts.length)} in progress`, detail: names(drafts), screen: 'drafts', cta: 'Review & publish', tone: 'ink' });
    if (s.reviews.length) items.push({ key: 'pmc-reviews', title: `${s.reviews.length} inspection${plural(s.reviews.length)} awaiting your review`, detail: names(s.reviews), screen: 'inspect-review', cta: 'Review', tone: 'amber' });
    if (changes.length) items.push({ key: 'pmc-change', title: `${changes.length} change request${plural(changes.length)} to resolve`, detail: names(changes), screen: 'decision-log', cta: 'Open', tone: 'red' });
    if (blocked.length) items.push({ key: 'pmc-blocked', title: `${blocked.length} activit${blocked.length === 1 ? 'y' : 'ies'} blocked`, detail: names(blocked), screen: 'site-schedule', cta: 'Open schedule', tone: 'red' });
    if (pending.length) items.push({ key: 'pmc-pending', title: `${pending.length} decision${plural(pending.length)} awaiting the client`, detail: 'Issued — waiting on client approval', screen: 'decision-log', cta: 'View', tone: 'ink' });
  }

  if (s.role === 'consultant') {
    const disc = s.memberships.find((m) => m.projectId === s.activeProjectId)?.discipline ?? (s.memberships.length === 0 ? 'structural' : undefined);
    if (disc) {
      const bucket = drawingDisciplineFor(disc);
      const mine = s.drawings.filter((d) => !d.draft && d.discipline === bucket && d.current && d.current.status === 'for_construction');
      if (mine.length) items.push({ key: 'cons-review', title: `${mine.length} ${bucket} drawing${plural(mine.length)} in the current set`, detail: 'Review the issued set in your discipline', screen: 'drawings', cta: 'Review drawings', tone: 'ink' });
    }
  }

  return items;
}
