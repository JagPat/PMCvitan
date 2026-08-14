/**
 * Derived selectors — pure functions of AppState.
 *
 * Nothing here is stored; everything is recomputed from the raw slices, exactly
 * as the prototype's renderVals() does on each render. This is what keeps the
 * interconnected flows consistent: approving a decision flips a schedule gate,
 * flagging a material blocks an activity, etc. These selectors are the unit-test
 * surface for the core loop.
 */

import { deriveReadiness, drawingDisciplineFor, readinessReady, redactWithdrawnReadinessForViewer, type Activity, type ActivityReadiness, type Decision, type DecisionStatus, type Drawing, type Gate, type Phase, type Review, type ScreenKey } from '@vitan/shared';
import type { AppState } from './store';

/** Day window for the schedule timeline (1 Jun .. 15 Aug). */
export const WIN = 75;
export const pctOf = (d: number): number => (d / WIN) * 100;

// ---- decisions ----

export function selectPending(s: AppState): Decision[] {
  // A draft is weightless: it isn't awaiting the client, so it never counts as pending.
  return s.decisions.filter((d) => d.status === 'pending' && !d.draft);
}

/** Decisions reopened by a change request — awaiting the client's MANDATORY re-approval
 *  (Phase 1 Task 2). Work driven by them is gated until the client re-approves. */
export function selectReapproval(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.status === 'change' && !d.draft);
}

/** Decision log is permission-filtered: contractor & engineer never see pending rows.
 *  Private drafts are excluded for everyone — they live only in the Drafts workspace. */
export function selectLogDecisions(s: AppState): Decision[] {
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only (the server's decisionVisibleToViewer
  // is the authority; this selector mirrors it): withdrawal never widens an audience, and the
  // old `status !== 'pending'` negative filter would otherwise LEAK a withdrawn decision to
  // roles that never saw it while it was pending.
  if (s.role !== 'pmc') {
    if (s.role === 'contractor' || s.role === 'engineer') {
      return s.decisions.filter((d) => d.status !== 'pending' && d.status !== 'withdrawn' && !d.draft);
    }
    return s.decisions.filter((d) => d.status !== 'withdrawn' && !d.draft);
  }
  return s.decisions.filter((d) => !d.draft);
}

/** Phase 6 task 4a round 6 (Codex) — the ONE audience rule for decision ROWS on every surface
 *  outside the log: a WITHDRAWN decision is pmc-only (server parity: `decisionVisibleToViewer`),
 *  and drafts live only in the Drafts workspace. The Site Map, Schedule, Daily Log and Portfolio
 *  read THROUGH this instead of filtering `s.decisions` ad hoc, so a persona switch over a
 *  still-loaded store (or demo mode, which never refetches) can never render a withdrawn
 *  decision's title/location to a role the server would filter it from. The log keeps its own
 *  stricter selector (`selectLogDecisions` also hides pending rows from contractor/engineer);
 *  by-id STATUS reads for gate derivation stay raw deliberately — the gate needs the status and
 *  the REASON is what the viewer rule redacts (`readinessFor`). */
export function selectVisibleDecisions(s: AppState): Decision[] {
  if (s.role !== 'pmc') {
    // The COMPLETE server audience rule (decisionVisibleToViewer), not just the withdrawn
    // arm: drafts are author-private (only the pmc authors decisions here), PENDING is
    // pmc/client-only (AUTH-02), WITHDRAWN is pmc-only. A persona switch over a still-loaded
    // store — or demo mode, which never refetches — must not render rows the server filters
    // (round 6 + round 10).
    return s.decisions.filter(
      (d) => !d.draft && d.status !== 'withdrawn' && (s.role === 'client' || d.status !== 'pending'),
    );
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

/**
 * The activity's FIVE-gate readiness (Task 6). API mode serializes it on the
 * activity (derived server-side, overrides included). Demo mode derives an
 * equivalent from the local state through the SAME shared truth tables — the
 * decision gate live, the drawing gate from the register's linked drawings
 * (legacy ack rule — the demo has no frozen recipient rows), material/team/
 * inspection from the stored prototype flags, honestly labeled 'stored'.
 */
export function readinessFor(s: AppState, a: Activity): ActivityReadiness {
  // Round 11 (Codex): a server-baked DTO carries the withdrawn-gate text of the viewer it was
  // baked FOR; after a persona switch (or during a pending refetch) the cached pmc text must be
  // re-redacted for viewers the server hides withdrawn decisions from.
  if (a.readiness) return redactWithdrawnReadinessForViewer(a.readiness, s.role === 'pmc');
  const r = deriveReadiness(a.id, {
    decisionStatus: a.decisionId ? decStatusOf(s, a.decisionId) : null,
    // Phase 6 task 4a round 1 (Codex F5): the withdrawn-decision gate reason is pmc-only —
    // the demo derivation mirrors the server's viewer rule.
    withdrawnReasonVisible: s.role === 'pmc',
    gateMaterial: a.gm,
    gateTeam: a.gt,
    inspections: [], // demo checklists carry no requirement edges — the stored flag stands in below
    drawings: s.drawings.map((d) => ({
      number: d.number,
      activityId: d.activityId ?? null,
      draft: d.draft,
      revisions: d.revisions.map((rev) => ({ status: rev.status, recipientsFrozenAt: null, recipientIds: [], ackedIds: rev.acks.map((_, i) => `ack-${i}`) })),
    })),
    activeMemberIds: [],
    overrides: [],
    now: new Date(),
  });
  r.inspection = { v: a.gi, source: 'stored', reason: 'Stored site flag (demo)' };
  return r;
}

export interface GateVM {
  k: 'D' | 'M' | 'T' | 'I' | 'DRW';
  label: string;
  v: Gate;
  /** where this value came from: derived | stored | override (Task 6) */
  source: 'derived' | 'stored' | 'override';
  /** the human-readable conclusion behind the dot */
  reason: string;
}

export function gatesFor(s: AppState, a: Activity): GateVM[] {
  const r = readinessFor(s, a);
  return [
    { k: 'D', label: 'Decision locked', v: r.decision.v, source: r.decision.source, reason: r.decision.reason },
    { k: 'M', label: 'Material on site', v: r.material.v, source: r.material.source, reason: r.material.reason },
    { k: 'T', label: 'Team present', v: r.team.v, source: r.team.source, reason: r.team.reason },
    { k: 'I', label: 'Inspection passed', v: r.inspection.v, source: r.inspection.source, reason: r.inspection.reason },
    { k: 'DRW', label: 'Drawings acknowledged', v: r.drawing.v, source: r.drawing.source, reason: r.drawing.reason },
  ];
}

/** An activity can Start only when all FIVE gates align (ok or n/a), overrides considered. */
export function activityReady(s: AppState, a: Activity): boolean {
  return readinessReady(readinessFor(s, a));
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
  /** completion claims still awaiting the PMC's closing sign-off (Task 5) — NOT done */
  awaitingSignoff: number;
  blocked: number;
  notStarted: number;
  donePct: number;
}

/**
 * A phase's activity rollup, recomputed LIVE from the activities (so starting or
 * completing an activity moves the phase's progress immediately — the stored
 * snapshot counts are only the initial server value). Same discipline as the
 * schedule gates: derive, never trust a stale stored count. An activity awaiting
 * sign-off counts as NOT done — only the PMC's acceptance moves donePct.
 */
export function phaseRollup(activities: Activity[], phaseId: string): PhaseRollup {
  const acts = activities.filter((a) => a.phaseId === phaseId);
  const done = acts.filter((a) => a.status === 'done').length;
  const inProgress = acts.filter((a) => a.status === 'in-progress').length;
  const awaitingSignoff = acts.filter((a) => a.status === 'awaiting-signoff').length;
  const blocked = acts.filter((a) => a.status === 'blocked').length;
  const notStarted = acts.filter((a) => a.status === 'not-started').length;
  return { activityTotal: acts.length, done, inProgress, awaitingSignoff, blocked, notStarted, donePct: acts.length ? Math.round((done / acts.length) * 100) : 0 };
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

// ---- site photos ----

export interface PhotoStats {
  count: number;
  zones: number; // distinct location nodes the photos are placed on
}

/** Photo totals COMPUTED from the snapshot's placed photos — never a fixed claim.
 *  (Phase 0 Task 7: API mode shows only recorded facts.) */
export function selectPhotoStats(s: AppState): PhotoStats {
  const zones = new Set(s.photos.map((p) => p.nodeId).filter(Boolean));
  return { count: s.photos.length, zones: zones.size };
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
  // The unacked nudge is RECIPIENT-aware (Phase 1 Task 3): only someone on the
  // governing revision's frozen distribution is asked to acknowledge. Absent
  // recipientOfCurrent (legacy/demo data) keeps the old everyone-builds behavior.
  const unacked = s.drawings.filter((d) => !d.draft && d.current && d.current.status === 'for_construction' && !d.ackedByMe && (d.recipientOfCurrent ?? true));
  const blocked = s.activities.filter((a) => a.status === 'blocked');
  const names = (xs: { title?: string; name?: string; number?: string }[], n = 3) =>
    xs.slice(0, n).map((x) => x.title ?? x.name ?? x.number ?? '').filter(Boolean).join(', ');

  if (s.role === 'client' && pending.length) {
    items.push({ key: 'client-pending', title: `${pending.length} decision${plural(pending.length)} awaiting your approval`, detail: names(pending), screen: 'client-decisions', cta: 'Review & approve', tone: 'amber' });
  }
  if (s.role === 'client' && changes.length) {
    // a reopened decision BLOCKS the work driven by it until the client re-approves
    items.push({ key: 'client-reapprove', title: `${changes.length} change request${plural(changes.length)} need${changes.length === 1 ? 's' : ''} your re-approval`, detail: names(changes), screen: 'client-decisions', cta: 'Re-approve', tone: 'red' });
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
    // Task 6: unstarted work whose DRAWING gate blocks it — the derived conclusion, surfaced
    const drawingBlocked = s.activities.filter((a) => {
      if (a.status !== 'not-started') return false;
      const dr = readinessFor(s, a).drawing;
      return dr.v === 'wait' || dr.v === 'fail';
    });
    if (drawingBlocked.length) items.push({ key: 'pmc-drawing-gate', title: `Blocked: drawing unacknowledged on ${drawingBlocked.length} activit${drawingBlocked.length === 1 ? 'y' : 'ies'}`, detail: names(drawingBlocked), screen: 'site-schedule', cta: 'Open schedule', tone: 'amber' });
    // Task 6: overrides lapsing within a week — the exception is about to end
    const soon = Date.now() + 7 * 24 * 3600 * 1000;
    const expiring = s.activities.flatMap((a) => (a.overrides ?? []).filter((o) => new Date(o.expiresAt).getTime() <= soon).map((o) => ({ a, o })));
    if (expiring.length) {
      const first = expiring[0];
      items.push({ key: 'pmc-override-expiry', title: `Override expiring ${new Date(first.o.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} — ${first.a.name}`, detail: expiring.length > 1 ? `${expiring.length} overrides lapse within a week` : first.o.reason, screen: 'site-schedule', cta: 'Review overrides', tone: 'amber' });
    }
  }

  // Phase 3 Task 7 (§25) — material SHORTAGES produce an Inbox action carrying FORECAST IMPACT. A pilot
  // pmc/engineer sees one actionable item when any open requirement is at-risk/blocked, with the worst
  // forecast in the detail (the shortages are backend-sorted worst-first: blocked before at-risk, then
  // soonest-needed). Jumps to the Materials hub to resolve. Absent on a non-pilot project (no bundle).
  if ((s.role === 'pmc' || s.role === 'engineer') && s.materialsView) {
    const shortages = s.materialsView.readiness.shortages;
    if (shortages.length) {
      const blockedN = shortages.filter((x) => x.verdict === 'blocked').length;
      const atRiskN = shortages.length - blockedN;
      const parts: string[] = [];
      if (blockedN) parts.push(`${blockedN} blocked`);
      if (atRiskN) parts.push(`${atRiskN} at-risk`);
      const hardImpact = shortages.some((x) => x.verdict === 'blocked' || x.impact === 'delays-start');
      items.push({
        key: 'material-shortage',
        title: `${shortages.length} material shortage${plural(shortages.length)} (${parts.join(', ')})`,
        detail: shortages[0].impactReason,
        screen: 'materials',
        cta: 'Open materials',
        tone: hardImpact ? 'red' : 'amber',
      });
    }
  }

  // Phase 5 Task 7B-i (§B/§25, Codex round 2) — an OVER-BUDGET cost head produces an Inbox action.
  //
  // `CommercialBudgetDto.openExceptions` is documented in the contract as "the Inbox action count
  // (§B)", and until this the Commercial hub was the only place it appeared: a PMC with no other
  // work landed on For You reading "all caught up" while a live breach stood in the register. §B's
  // whole design is that the exception is a durable OBSERVATION raised in the writer's transaction
  // precisely so it cannot be missed — leaving it off the home queue defeats the mechanism.
  //
  // RED, not amber: unlike a material or labour shortfall, there is no inbound commitment that
  // resolves this on its own. Money already committed exceeds money already authorised, and it stays
  // that way until a person revises the budget or re-attributes the obligation.
  if ((s.role === 'pmc' || s.role === 'engineer') && s.commercialView) {
    const breaches = s.commercialView.budget.openExceptions;
    if (breaches > 0) {
      // name the WORST head, so the item says which money rather than only how many
      const worst = s.commercialView.budget.positions
        .filter((p) => p.headroom !== null && p.headroom.trimStart().startsWith('-'))
        .sort((a, b) => Number(a.headroom) - Number(b.headroom))[0];
      items.push({
        key: 'commercial-over-budget',
        title: `${breaches} cost head${plural(breaches)} over budget`,
        detail: worst
          ? `${worst.costHeadName} is over by ${worst.headroom!.replace('-', '')} — committed money exceeds the authorised budget.`
          : 'Committed money exceeds the authorised budget.',
        screen: 'commercial',
        cta: 'Open commercial',
        tone: 'red',
      });
    }
  }

  // Phase 4 Task 6 (§J) — labour SHORTFALLS produce the twin Inbox action: one item when any
  // activity's labour FORECAST is at-risk/blocked (the server's `labour.readiness` verdicts —
  // never derived in the browser), red when anything is blocked outright, amber when every
  // shortfall has committed supplier capacity inbound. Jumps to the Labour hub to resolve.
  // Absent on a non-labour-pilot project (no bundle).
  if ((s.role === 'pmc' || s.role === 'engineer') && s.labourView) {
    const shortfalls = Object.values(s.labourView.readiness.forecast).filter((f) => f.verdict !== 'ready');
    if (shortfalls.length) {
      const blockedN = shortfalls.filter((f) => f.verdict === 'blocked').length;
      const atRiskN = shortfalls.length - blockedN;
      const parts: string[] = [];
      if (blockedN) parts.push(`${blockedN} blocked`);
      if (atRiskN) parts.push(`${atRiskN} at-risk`);
      const worst = shortfalls.find((f) => f.verdict === 'blocked') ?? shortfalls[0];
      items.push({
        key: 'labour-shortage',
        title: `${shortfalls.length} labour shortfall${plural(shortfalls.length)} (${parts.join(', ')})`,
        detail: worst.reason,
        screen: 'labour',
        cta: 'Open labour',
        tone: blockedN > 0 ? 'red' : 'amber',
      });
    }
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
