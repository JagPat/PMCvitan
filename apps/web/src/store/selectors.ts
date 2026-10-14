/**
 * Derived selectors — pure functions of AppState.
 *
 * Nothing here is stored; everything is recomputed from the raw slices, exactly
 * as the prototype's renderVals() does on each render. This is what keeps the
 * interconnected flows consistent: approving a decision flips a schedule gate,
 * flagging a material blocks an activity, etc. These selectors are the unit-test
 * surface for the core loop.
 */

import { SNAPSHOT_SITE_PHOTO_LIMIT, deriveReadiness, drawingDisciplineFor, readinessReady, redactWithdrawnReadinessForViewer, viewerIsConsultee, viewerIsDecider, type Activity, type ActionItemFacts, type ActivityReadiness, type Checklist, type Decision, type DecisionStatus, type Drawing, type Gate, type Phase, type Review, type Role, type ScreenKey } from '@vitan/shared';
import type { AppState } from './store';
import { rolesFor } from '@/lib/screens';
import { decisionsSliceSettled, drawingsSliceSettled, inspectionsSliceSettled, projectSnapshotSettled } from '@/lib/notifications';
import { activitiesReadMode, dailyLogReadMode, inspectionsReadMode } from '@/data/apiGateway';
import { dailyLogCommandInFlight } from './dailyLogPending';

/** Day window for the schedule timeline (1 Jun .. 15 Aug). */
export const WIN = 75;
export const pctOf = (d: number): number => (d / WIN) * 100;

// ---- Phase 6 task 4d — the architect chain's rollout gate ----

/** Phase 6 task 4d-ii-b / B1 — is the architect chain OPEN for the active project? The ONE predicate every
 *  client gate on an architect shape reads (B2's Team and decider pickers and persona switchers, B5b's
 *  Forward affordance): `true` only when this project's shell reported `rollout.phase6_4d = 'open'`;
 *  `false` while reserved, before the shell lands, and after any scope change. */
export function selectPhase6_4dOpen(s: AppState): boolean {
  return s.phase6_4dRollout === 'open';
}

/** Phase 6 task 4d-ii-b / B2 — the personas the product offers RIGHT NOW: every switcher and picker
 *  (the rail's `RolePicker`, the phone's `TopBar` switcher, the Team screen's role pickers) reads this
 *  one selector, so a reserved role (`architect`) is offered nowhere while the shell reads `'reserved'`
 *  and everywhere at once when it reads `'open'`. Never a static list (#677 review, finding 4145060015). */
export function selectRoles(s: AppState): readonly Role[] {
  return rolesFor(s.phase6_4dRollout);
}

// ---- decisions ----

export function selectPending(s: AppState): Decision[] {
  // A draft is weightless: it isn't awaiting the client, so it never counts as pending.
  return s.decisions.filter((d) => d.status === 'pending' && !d.draft);
}

/** Decisions reopened by a change request — awaiting the decider's MANDATORY re-approval
 *  (Phase 1 Task 2). Work driven by them is gated until the decider re-approves. */
export function selectReapproval(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.status === 'change' && !d.draft);
}

/** Phase 6 task 4b (§A.3) — the open decisions THIS VIEWER decides (the approval surface's
 *  slice): `selectPending`/`selectReapproval` narrowed by the shared `viewerIsDecider`
 *  predicate, so a named member-decider sees exactly their obligations and a same-role
 *  non-decider sees none. */
export function selectDeciderPending(s: AppState): Decision[] {
  return selectPending(s).filter((d) => viewerIsDecider(d, s.role, s.sessionUserId));
}

export function selectDeciderReapproval(s: AppState): Decision[] {
  return selectReapproval(s).filter((d) => viewerIsDecider(d, s.role, s.sessionUserId));
}

/** Every open decision waiting on THIS VIEWER — re-approvals first, then new ones. The one count the
 *  client's Pulse, Project Health, the For You badge and the Decisions Waiting badge all show. */
export function selectDecisionsNeedingViewer(s: AppState): Decision[] {
  return [...selectDeciderReapproval(s), ...selectDeciderPending(s)];
}

// ---- Phase 6 task 4d-ii-b / B3 — the countersign readers ----

/** The published decisions AWAITING the architect's countersign: approved (provisionally) by their
 *  decider under an active chain, not yet final. A draft is never awaiting (approve acts on a published
 *  row), but the guard keeps the read matching every other status selector. */
export function selectAwaitingCountersign(s: AppState): Decision[] {
  return s.decisions.filter((d) => d.status === 'awaiting_countersign' && !d.draft);
}

/** Is this awaiting decision STRANDED — waiting for a countersign no active architect can give? The
 *  client reads chain activity THE WAY THE DTO EXPOSES IT and never invents an active chain: the server
 *  overlays `countersignRequired: true` on every decision it serves while the kernel register reads an
 *  active architect (4d-ii-a / A5c, both read paths, never stored), so an awaiting row WITHOUT the
 *  overlay was served with the chain inactive — exactly the rows the server's `countStranded` counts for
 *  the PMC (A5d). A row that is not awaiting is never stranded. */
export function isStrandedCountersign(d: Decision): boolean {
  return d.status === 'awaiting_countersign' && d.countersignRequired !== true;
}

/** The viewer's COUNTERSIGN-CHAIN obligations — the web arm of the server's `countPending` 4d arms
 *  (A5d): an ARCHITECT owes a countersign on every awaiting decision (the chain is active while an
 *  architect holds the role, so none of them is stranded); the PMC owes the resolution of every STRANDED
 *  one; nobody else owes anything here. Drives the Decision Log nav badge and the Inbox items; empty on
 *  live data while the doors stand (no row can be awaiting), so nothing new renders until 4d-iii. */
export function selectCountersignObligations(s: AppState): Decision[] {
  if (s.role === 'architect') return selectAwaitingCountersign(s);
  if (s.role === 'pmc') return selectAwaitingCountersign(s).filter(isStrandedCountersign);
  return [];
}

/** Top 10 #2 (#771) — the decisions AWAITING ACTION for this viewer: the web mirror of the server's
 *  `DecisionsQuery.countPending`, the count Portfolio cards and the shell serve. The PMC manages every
 *  published pending decision plus every STRANDED countersign (`isStrandedCountersign`: no active architect
 *  can give it); anyone else counts the pending decisions they decide, and the architect also every
 *  decision awaiting their countersign. A reopened (`change`) decision is not counted, as on the server. One
 *  definition for the Dashboard tile and the Portfolio card, so the two reconcile. */
export function selectDecisionsAwaitingAction(s: AppState): Decision[] {
  if (s.role === 'pmc') return [...selectPending(s), ...selectAwaitingCountersign(s).filter(isStrandedCountersign)];
  return [...selectDeciderPending(s), ...(s.role === 'architect' ? selectAwaitingCountersign(s) : [])];
}

/** Decision log is permission-filtered: a pending row is visible only to pmc and THE DECIDER
 *  (Phase 6 task 4b §A.3 — the shared `viewerIsDecider` predicate, so a named engineer-decider
 *  sees their obligation in the log while a same-role non-decider and the non-deciding client
 *  do not), and a row AWAITING its countersign keeps that audience plus the architect (4d-ii-b / B3,
 *  `openDemandVisible`). Private drafts are excluded for everyone — they live only in the Drafts workspace. */
export function selectLogDecisions(s: AppState): Decision[] {
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only (the server's decisionVisibleToViewer
  // is the authority; this selector mirrors it): withdrawal never widens an audience, and the
  // old `status !== 'pending'` negative filter would otherwise LEAK a withdrawn decision to
  // roles that never saw it while it was pending.
  if (s.role !== 'pmc') {
    return s.decisions.filter((d) => !d.draft && d.status !== 'withdrawn' && openDemandVisible(d, s));
  }
  return s.decisions.filter((d) => !d.draft);
}

/** Phase 6 task 4d-ii-b / B3 — the audience of a decision carrying an OPEN DEMAND, mirroring the server's
 *  `decisionVisibleToViewer` (4d-ii-a / A8a) exactly: a PENDING decision and one AWAITING its countersign
 *  share one audience — the decider whose (provisional) approval it carries, a standing consultee, and the
 *  architect, who sees every open demand of the project (an architect token exists only while the chain
 *  is active) and whose action item the awaiting row is. Every other status is read by everyone here
 *  (`withdrawn` is filtered pmc-only by the callers, above this rule). The pmc arm is the callers'. */
function openDemandVisible(d: Decision, s: AppState): boolean {
  if (d.status !== 'pending' && d.status !== 'awaiting_countersign') return true;
  return s.role === 'architect' || viewerIsDecider(d, s.role, s.sessionUserId) || viewerIsConsultee(d.consultations, d.approvalCycle, s.sessionUserId);
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
    // arm: drafts are author-private (only the pmc authors decisions here), PENDING follows
    // the DECIDER (Phase 6 task 4b §A.3 — the shared `viewerIsDecider` predicate), WITHDRAWN
    // is pmc-only. A persona switch over a still-loaded store — or demo mode, which never
    // refetches — must not render rows the server filters (round 6 + round 10 + 4b round 12).
    // 4d-ii-b / B3 — and AWAITING follows the same open-demand audience (the architect included).
    return s.decisions.filter((d) => !d.draft && d.status !== 'withdrawn' && openDemandVisible(d, s));
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
 * Top 10 #2b (#771) — the RE-INSPECTIONS not yet decided, and the failed items they carry. Rejecting an
 * inspection decides it (so it leaves the review queue) and creates a linked re-inspection holding only
 * the rejected items: open while the engineer works it, then in the review queue until the PMC decides it.
 * Each item here is a failed item still awaiting re-inspection, read from the records the PMC can open.
 */
export function selectOpenReinspections(s: AppState): { count: number; items: number; known: boolean } {
  const open = selectReinspectionsAwaitingSubmission(s);
  const inReview = s.reviews.filter((r) => r.reinspectionOfId && !r.decided);
  return {
    count: open.length + inReview.length,
    items: open.reduce((n, c) => n + c.items.length, 0) + inReview.reduce((n, r) => n + r.items.length, 0),
    // #771 (#482 6114668018) — an open checklist served with NO lineage key comes from a server older than the
    // field, which cannot say whether it is a re-inspection: the count is then not known, and is never shown as
    // a number. A current server marks an ordinary checklist `null`. Review rows have always carried lineage.
    known: s.openChecklists.every((c) => c.submitted || c.reinspectionOfId !== undefined),
  };
}

/** #771 PMC For You — the re-inspections still with the engineer (open, not yet submitted): the open half of
 *  `selectOpenReinspections`. The other half, those awaiting review, is already in the review queue. */
export function selectReinspectionsAwaitingSubmission(s: AppState): Checklist[] {
  return s.openChecklists.filter((c) => c.reinspectionOfId && !c.submitted);
}

/**
 * Dashboard "failed items awaiting re-inspection" — the API-LESS DEMO's count (its seed creates no linked
 * re-inspection; a live project reads `selectOpenReinspections`). Note the ternary can RISE
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

/** The Schedule's RUNNING / DONE / BLOCKED counts over exactly the activities given — the whole project, or
 *  the rows a place filter shows (B8, Codex 4180886620), so the cards always describe what is listed. */
export function scheduleStatusCounts(activities: readonly Activity[]): { inProgress: number; doneWeek: number; blocked: number } {
  return {
    inProgress: activities.filter((a) => a.status === 'in-progress').length,
    doneWeek: activities.filter((a) => a.status === 'done').length,
    blocked: activities.filter((a) => a.status === 'blocked').length,
  };
}

export function selectSchToday(s: AppState): { inProgress: number; doneWeek: number; blocked: number } {
  return scheduleStatusCounts(s.activities);
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

// ---- project progress ----

export interface ProjectProgress {
  /** `null` while the activities are not known (still loading, or their read failed) — never a guess */
  pct: number | null;
  done: number;
  total: number;
  /** `derived`: computed from the activities. `recorded`: the activities are known and there are none, so
   *  the project's recorded figure. `loading` / `unavailable`: the module-owned activity read has not
   *  answered yet, or failed — an empty list then says nothing about the plan (Codex 4180841684). */
  basis: 'derived' | 'recorded' | 'loading' | 'unavailable';
}

/**
 * B7 (F-12) — overall progress DERIVED from the activities, by the same rule as `phaseRollup`: only
 * an accepted (`done`) activity counts, so an activity awaiting sign-off does not. The stored
 * `milestonePct` is not maintained by the server (a new project records 0 and nothing moves it), so
 * it is used only while a project has no activities planned — and the screen says so.
 */
export function selectProjectProgress(s: AppState): ProjectProgress {
  const total = s.activities.length;
  if (total === 0) {
    // Module-owned activities (`moduleQuery`) are known only once their read answers; until then, or when
    // it fails, the empty list is not "no plan" — the same boundary the Schedule screen draws. In snapshot
    // mode the snapshot owns them and `activitiesLoad` stays idle, so an empty list is the plan.
    if (activitiesReadMode() === 'moduleQuery' && s.activitiesLoad !== 'ready') {
      return { pct: null, done: 0, total: 0, basis: s.activitiesLoad === 'error' ? 'unavailable' : 'loading' };
    }
    return { pct: Math.max(0, Math.min(100, Math.round(s.milestonePct))), done: 0, total: 0, basis: 'recorded' };
  }
  const done = s.activities.filter((a) => a.status === 'done').length;
  return { pct: Math.round((done / total) * 100), done, total, basis: 'derived' };
}

// ---- daily log ----

export function selectTotalWorkers(s: AppState): number {
  return s.dailyLog?.crew.reduce((a, c) => a + c.count, 0) ?? 0;
}

// ---- site photos ----

export interface PhotoStats {
  count: number;
  zones: number; // distinct location nodes the photos are placed on
  /** true when the snapshot's window is full: `count` is then a floor (older photos exist unloaded) and
   *  `zones` counts only the places among the loaded ones (Codex 4194155412) */
  capped: boolean;
}

/** Photo totals COMPUTED from the snapshot's placed photos — never a fixed claim.
 *  (Phase 0 Task 7: API mode shows only recorded facts.) The snapshot carries at most
 *  `SNAPSHOT_SITE_PHOTO_LIMIT`, newest first, so a full window is reported as capped, never as the total. */
export function selectPhotoStats(s: AppState): PhotoStats {
  const zones = new Set(s.photos.map((p) => p.nodeId).filter(Boolean));
  return { count: s.photos.length, zones: zones.size, capped: s.photos.length >= SNAPSHOT_SITE_PHOTO_LIMIT };
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
  /** how many things the item stands for, when it groups several the viewer acts on one by one */
  count?: number;
  /** #827 — what the card says beyond its key, so Hindi and Gujarati are built from facts (`actionItemText`) */
  facts?: ActionItemFacts;
  /** Top 10 #3 (#774) — the ONE record the item is about, opened on `screen` (`openItem`) instead of the list.
   *  Set only when the item names exactly one record that `screen` resolves. */
  item?: string;
}

/** Top 10 #3 (#774) — the record a list of exactly one names, else nothing (the item opens its list). */
const only = (xs: readonly { id: string }[]): string | undefined => (xs.length === 1 ? xs[0].id : undefined);

/** Top 10 #3 (#774) — where ONE decision opens for this viewer, the bell's rule (`notificationLink`): the
 *  approval screen when a SETTLED slice shows it awaiting them as its decider, else the Decision Log, which
 *  every role holds and which is right in every state. A row retained after a failed read, or while a
 *  command's reconcile is owed, never opens live approval controls (#775 Codex 4239168284). */
export function decisionRecordLink(s: AppState, d: Decision): { screen: ScreenKey; item: string } {
  const awaits = decisionsSliceSettled(s)
    && (d.status === 'pending' || d.status === 'change') && !d.draft && viewerIsDecider(d, s.role, s.sessionUserId);
  return { screen: awaits ? 'client-decisions' : 'decision-log', item: d.id };
}

/** #775 Codex 4239201827 — the inspection slice may name a record only once it has landed: the shared settled
 *  predicate, plus (under module read-ownership) a read that has not yet run or is still in flight. The same
 *  judgement the bell makes before it routes an inspection notice. */
export function inspectionsSettledForLinks(s: AppState): boolean {
  return inspectionsSliceSettled(s)
    && !(inspectionsReadMode() === 'moduleQuery' && (s.inspectionsLoad === 'idle' || s.inspectionsLoad === 'loading'));
}

/** Top 10 #3c (#774) — the activity spine may name a record only once it has landed (the #775 root cause, for
 *  activities): no command reconcile owed, the project loaded, and under module read-ownership a read that has
 *  succeeded. A retained row never becomes a link into the schedule's live controls. */
export function activitiesSettledForLinks(s: AppState): boolean {
  return !s.commandReconcileOwed.activities
    && projectSnapshotSettled(s.projectLoadState)
    && (activitiesReadMode() === 'snapshot' || s.activitiesLoad === 'ready');
}

/** Top 10 #3 gap 12 (#798) — a pilot hub may name one of its records only once its bundle has landed: `ready` is
 *  set only by a successful read (a refresh keeps it while it revalidates), and a failed read leaves `error` over
 *  the last-good bundle, which no link or "not found" may be judged against. */
export function materialsSettledForLinks(s: AppState): boolean {
  return s.materialsLoad === 'ready' && s.materialsView !== null;
}
export function labourSettledForLinks(s: AppState): boolean {
  return s.labourLoad === 'ready' && s.labourView !== null;
}

/** Top 10 #3 gap 12c (#798) — the site log may be named only once its slice has landed: the project loaded, no
 *  command reconcile owed, under module read-ownership a read that succeeded, and no start or send still on its way
 *  (the log on screen predates it). */
export function dailyLogSettledForLinks(s: AppState): boolean {
  return !s.commandReconcileOwed.dailyLog
    && projectSnapshotSettled(s.projectLoadState)
    && (dailyLogReadMode() === 'snapshot' || s.dailyLogLoad === 'ready')
    && !dailyLogCommandInFlight(s);
}

/** Top 10 #3 (#774) — where ONE inspection opens for this viewer, or null when no inspection screen the role
 *  holds resolves it (the bell's rule: the review screen opens a queued review or an outstanding checklist;
 *  the checklist screen opens an outstanding checklist, or the one in the slot while it is unsubmitted). */
export function inspectionRecordLink(s: AppState, id: string): { screen: ScreenKey; item: string } | null {
  // #775 Codex 4239201827 — only from a SETTLED slice (the bell's judgement): rows retained by a refresh that
  // is loading or failed, or whose command reconcile is owed, never become links into live inspection controls
  if (!inspectionsSettledForLinks(s)) return null;
  if (s.role === 'pmc' && [...s.reviews, ...s.openChecklists].some((i) => i.id === id)) return { screen: 'inspect-review', item: id };
  if (s.role === 'engineer' && [...s.openChecklists, ...(s.checklist && !s.checklist.submitted ? [s.checklist] : [])].some((i) => i.id === id)) {
    return { screen: 'engineer-check', item: id };
  }
  return null;
}

const plural = (n: number, s = 's') => (n === 1 ? '' : s);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A civil `YYYY-MM-DD` as "14 Oct", read from its parts so no time zone moves the day. */
function civilDayLabel(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return m >= 1 && m <= 12 && d ? `${d} ${MONTHS[m - 1]}` : day;
}

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
  // #775 root-cause audit — a drawing card names its drawing only from a settled register (the bell's rule), so
  // a retained row never opens acknowledgement controls on a stale revision
  const unackedItem = (xs: readonly { id: string }[]): string | undefined => (drawingsSliceSettled(s) ? only(xs) : undefined);
  const unacked = s.drawings.filter((d) => !d.draft && d.current && d.current.status === 'for_construction' && !d.ackedByMe && (d.recipientOfCurrent ?? true));
  const blocked = s.activities.filter((a) => a.status === 'blocked');
  const names = (xs: { title?: string; name?: string; number?: string }[], n = 3) =>
    xs.slice(0, n).map((x) => x.title ?? x.name ?? x.number ?? '').filter(Boolean).join(', ');

  // Phase 6 task 4b (§A.3, round-3 Codex F1) — the approval to-do follows THE DECIDER (the shared
  // `viewerIsDecider` predicate) for EVERY role: a named engineer-decider gets the item, a
  // same-role non-decider does not, the client no longer sees a demand for a decision they do not
  // decide — and a PMC-HELD decision is the signed-in PMC's OWN approval task, never someone
  // else's responsibility. The client keys are kept for the (unchanged) client-held case; any
  // other decider gets the decider-keyed item pointing at the same approval surface (reachable
  // via the decider route arm).
  const myPending = pending.filter((d) => viewerIsDecider(d, s.role, s.sessionUserId));
  // #775 Codex 4239168284 — an approval card opens ONE decision's live controls only from a settled slice
  const settledDecisions = decisionsSliceSettled(s);
  const myChanges = changes.filter((d) => viewerIsDecider(d, s.role, s.sessionUserId));
  if (myPending.length) {
    items.push({ key: s.role === 'client' ? 'client-pending' : 'decider-pending', title: `${myPending.length} decision${plural(myPending.length)} awaiting your approval`, detail: names(myPending), facts: { n: myPending.length }, screen: 'client-decisions', cta: 'Review & approve', tone: 'amber', count: myPending.length, item: settledDecisions ? only(myPending) : undefined });
  }
  if (myChanges.length) {
    // a reopened decision BLOCKS the work driven by it until the decider re-approves
    items.push({ key: s.role === 'client' ? 'client-reapprove' : 'decider-reapprove', title: `${myChanges.length} change request${plural(myChanges.length)} need${myChanges.length === 1 ? 's' : ''} your re-approval`, detail: names(myChanges), facts: { n: myChanges.length }, screen: 'client-decisions', cta: 'Re-approve', tone: 'red', count: myChanges.length, item: settledDecisions ? only(myChanges) : undefined });
  }

  // Phase 6 task 4d-ii-b / B3 (the plan's §A.2 Inbox arm) — the AWAITING branch. The architect's item is
  // their countersign work; the PMC gets the management summary of the rows the architect holds, and the
  // RED stranded item for the rows no active architect can countersign (`isStrandedCountersign`: the
  // chain's activity as the DTO exposes it, never invented). All three land on the Decision Log, where
  // the awaiting rows are read and (B5b) acted on — never on the approval route, which stays limited to
  // actionable pending/change states (#677 review, finding 4145060024). Empty while the doors stand.
  const awaiting = selectAwaitingCountersign(s);
  if (s.role === 'architect' && awaiting.length) {
    items.push({ key: 'arch-countersign', title: `${awaiting.length} decision${plural(awaiting.length)} awaiting your countersign`, detail: names(awaiting), facts: { n: awaiting.length }, screen: 'decision-log', cta: 'Review & countersign', tone: 'amber', count: awaiting.length, item: only(awaiting) });
  }
  if (s.role === 'pmc' && awaiting.length) {
    const stranded = awaiting.filter(isStrandedCountersign);
    const held = awaiting.filter((d) => !isStrandedCountersign(d));
    if (stranded.length) items.push({ key: 'pmc-stranded', title: `${stranded.length} decision${plural(stranded.length)} stranded — no architect to countersign`, detail: names(stranded), facts: { n: stranded.length }, screen: 'decision-log', cta: 'Resolve', tone: 'red', count: stranded.length, item: only(stranded) });
    if (held.length) items.push({ key: 'pmc-countersign', title: `${held.length} decision${plural(held.length)} awaiting the architect’s countersign`, detail: names(held), facts: { n: held.length }, screen: 'decision-log', cta: 'View', tone: 'ink', item: only(held) });
  }

  if (s.role === 'engineer') {
    if (s.checklist && !s.checklist.submitted) items.push({ key: 'eng-checklist', title: `Checklist to complete: ${s.checklist.title}`, detail: `${s.checklist.items.length} items · ${s.checklist.zone}`, facts: { title: s.checklist.title, items: s.checklist.items.length, zone: s.checklist.zone }, screen: 'engineer-check', cta: 'Fill & submit', tone: 'amber', item: inspectionsSettledForLinks(s) ? s.checklist.id : undefined });
    if (s.dailyLog && !s.dailyLog.submitted) items.push({ key: 'eng-log', title: `Today's site log isn't submitted`, detail: s.dailyLog.checkedIn ? 'Checked in — submit when the day is logged' : 'Check in at site, then submit', facts: { checkedIn: s.dailyLog.checkedIn }, screen: 'daily-log', cta: 'Open daily log', tone: 'ink', item: dailyLogSettledForLinks(s) ? s.dailyLog.id : undefined });
    if (unacked.length) items.push({ key: 'eng-ack', title: `${unacked.length} drawing${plural(unacked.length)} to acknowledge`, detail: names(unacked), facts: { n: unacked.length }, screen: 'drawings', cta: 'Acknowledge current set', tone: 'amber', item: unackedItem(unacked) });
  }

  if (s.role === 'contractor') {
    if (unacked.length) items.push({ key: 'con-ack', title: `${unacked.length} drawing${plural(unacked.length)} to acknowledge`, detail: names(unacked), facts: { n: unacked.length }, screen: 'drawings', cta: 'Acknowledge current set', tone: 'amber', item: unackedItem(unacked) });
    if (changes.length) items.push({ key: 'con-change', title: `${changes.length} change request${plural(changes.length)} open`, detail: 'Awaiting the PMC', facts: { n: changes.length }, screen: 'decision-log', cta: 'View', tone: 'ink', item: only(changes) });
  }

  if (s.role === 'pmc') {
    if (drafts.length) items.push({ key: 'pmc-drafts', title: `${drafts.length} draft${plural(drafts.length)} in progress`, detail: names(drafts), facts: { n: drafts.length }, screen: 'drafts', cta: 'Review & publish', tone: 'ink' });
    // only the UNDECIDED reviews: an approved or rejected one stays in `s.reviews` with `decided` set
    const toReview = s.reviews.filter((r) => !r.decided);
    // Top 10 #2 (#771) — each review is the PMC's own decision, so the item counts every one of them: the
    // For You badge then agrees with the Inspection Review badge and the Dashboard tile
    if (toReview.length) items.push({ key: 'pmc-reviews', title: `${toReview.length} inspection${plural(toReview.length)} awaiting your review`, detail: names(toReview), facts: { n: toReview.length }, screen: 'inspect-review', cta: 'Review', tone: 'amber', count: toReview.length, item: inspectionsSettledForLinks(s) ? only(toReview) : undefined });
    // round-3 Codex F1 — the PMC MANAGEMENT summaries cover only decisions held by OTHER
    // deciders: a PMC-held row is the PMC's own approval task (the decider items above), not
    // something to describe as awaiting someone else. When every other-held decision is
    // client-held (the pre-4b world), the texts are byte-identical to what they always said.
    const otherChanges = changes.filter((d) => !viewerIsDecider(d, s.role, s.sessionUserId));
    // #771 PMC For You — the PMC's decision cards partition `selectDecisionsAwaitingAction` (the Dashboard tile and
    // the server's `countPending`, the Portfolio card): its own approvals (`decider-pending`), the stranded
    // countersigns (`pmc-stranded`) and every other published pending decision here (`pending` is that
    // selector's pending arm for the PMC, `selectPending`), each counted per record
    const otherPending = pending.filter((d) => !viewerIsDecider(d, s.role, s.sessionUserId));
    if (otherChanges.length) items.push({ key: 'pmc-change', title: `${otherChanges.length} change request${plural(otherChanges.length)} to resolve`, detail: names(otherChanges), facts: { n: otherChanges.length }, screen: 'decision-log', cta: 'Open', tone: 'red', count: otherChanges.length, item: only(otherChanges) });
    if (blocked.length) items.push({ key: 'pmc-blocked', title: `${blocked.length} activit${blocked.length === 1 ? 'y' : 'ies'} blocked`, detail: names(blocked), facts: { n: blocked.length }, screen: 'site-schedule', cta: 'Open schedule', tone: 'red', item: activitiesSettledForLinks(s) ? only(blocked) : undefined });
    if (otherPending.length) {
      const allClientHeld = otherPending.every((d) => (d.deciderKind ?? 'client') === 'client');
      const who = allClientHeld ? 'the client' : otherPending.length === 1 ? 'its decider' : 'their deciders';
      items.push({ key: 'pmc-pending', title: `${otherPending.length} decision${plural(otherPending.length)} awaiting ${who}`, detail: allClientHeld ? 'Issued — waiting on client approval' : 'Issued — waiting on each decider’s approval', facts: { n: otherPending.length, who: allClientHeld ? 'client' : 'decider' }, screen: 'decision-log', cta: 'View', tone: 'ink', count: otherPending.length, item: only(otherPending) });
    }
    // #771 PMC For You — the re-inspections a rejection sent back, still with the engineer (from the served lineage,
    // assignee and due date). With the re-inspections awaiting review, already counted in `pmc-reviews`, they make
    // up the Dashboard's open re-inspections (`selectOpenReinspections`), each counted once.
    // A partial count is not the count: while any open checklist's lineage is unreported, the Dashboard reads the
    // total as unknown, so no card claims a number either
    const reinspecting = selectOpenReinspections(s).known ? selectReinspectionsAwaitingSubmission(s) : [];
    if (reinspecting.length) {
      const due = reinspecting.map((c) => c.dueDate).filter((d): d is string => typeof d === 'string').sort()[0];
      items.push({ key: 'pmc-reinspections', title: `${reinspecting.length} re-inspection${plural(reinspecting.length)} with the engineer`, detail: [names(reinspecting), due ? `next due ${civilDayLabel(due)}` : ''].filter(Boolean).join(' · '), facts: { n: reinspecting.length, names: names(reinspecting), ...(due ? { due } : {}) }, screen: 'inspect-review', cta: 'Follow up', tone: 'amber', count: reinspecting.length, item: inspectionsSettledForLinks(s) ? only(reinspecting) : undefined });
    }
    // Task 6: unstarted work whose DRAWING gate blocks it — the derived conclusion, surfaced
    const drawingBlocked = s.activities.filter((a) => {
      if (a.status !== 'not-started') return false;
      const dr = readinessFor(s, a).drawing;
      return dr.v === 'wait' || dr.v === 'fail';
    });
    if (drawingBlocked.length) items.push({ key: 'pmc-drawing-gate', title: `Blocked: drawing unacknowledged on ${drawingBlocked.length} activit${drawingBlocked.length === 1 ? 'y' : 'ies'}`, detail: names(drawingBlocked), facts: { n: drawingBlocked.length }, screen: 'site-schedule', cta: 'Open schedule', tone: 'amber', item: activitiesSettledForLinks(s) ? only(drawingBlocked) : undefined });
    // Task 6: overrides lapsing within a week — the exception is about to end
    const soon = Date.now() + 7 * 24 * 3600 * 1000;
    // #777 Codex 4239561636 — the card is about ONE activity when every expiring override is that activity's,
    // however many of its overrides (or gates) lapse
    const expiring = s.activities.flatMap((a) => (a.overrides ?? []).filter((o) => new Date(o.expiresAt).getTime() <= soon).map((o) => ({ a, o })));
    if (expiring.length) {
      const first = expiring[0];
      items.push({ key: 'pmc-override-expiry', title: `Override expiring ${new Date(first.o.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} — ${first.a.name}`, detail: expiring.length > 1 ? `${expiring.length} overrides lapse within a week` : first.o.reason, facts: { expiresAt: first.o.expiresAt, activity: first.a.name, expiring: expiring.length }, screen: 'site-schedule', cta: 'Review overrides', tone: 'amber', item: new Set(expiring.map((x) => x.a.id)).size === 1 && activitiesSettledForLinks(s) ? first.a.id : undefined });
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
        facts: { n: shortages.length, blocked: blockedN, atRisk: atRiskN },
        screen: 'materials',
        cta: 'Open materials',
        tone: hardImpact ? 'red' : 'amber',
        // gap 12 (#798) — one short activity opens its record (shortages are one per activity)
        item: materialsSettledForLinks(s) && shortages.length === 1 ? shortages[0].activityId : undefined,
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
        facts: { n: breaches, ...(worst ? { head: worst.costHeadName, over: worst.headroom!.replace('-', '') } : {}) },
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
    const shortfallEntries = Object.entries(s.labourView.readiness.forecast).filter(([, f]) => f.verdict !== 'ready');
    const shortfalls = shortfallEntries.map(([, f]) => f);
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
        facts: { n: shortfalls.length, blocked: blockedN, atRisk: atRiskN },
        screen: 'labour',
        cta: 'Open labour',
        tone: blockedN > 0 ? 'red' : 'amber',
        // gap 12 (#798) — one short activity opens its record (the forecast is keyed by activity)
        item: labourSettledForLinks(s) && shortfallEntries.length === 1 ? shortfallEntries[0][0] : undefined,
      });
    }
  }

  if (s.role === 'consultant') {
    const disc = s.memberships.find((m) => m.projectId === s.activeProjectId)?.discipline ?? (s.memberships.length === 0 ? 'structural' : undefined);
    if (disc) {
      const bucket = drawingDisciplineFor(disc);
      const mine = s.drawings.filter((d) => !d.draft && d.discipline === bucket && d.current && d.current.status === 'for_construction');
      if (mine.length) items.push({ key: 'cons-review', title: `${mine.length} ${bucket} drawing${plural(mine.length)} in the current set`, detail: 'Review the issued set in your discipline', facts: { n: mine.length, bucket }, screen: 'drawings', cta: 'Review drawings', tone: 'ink' });
    }
  }

  return items;
}

/** How many things need the viewer: an item that groups several decisions counts each of them, so the
 *  For You badge and heading agree with the Pulse and the Decisions Waiting badge. */
export function countActionItems(items: readonly ActionItem[]): number {
  return items.reduce((n, it) => n + (it.count ?? 1), 0);
}
