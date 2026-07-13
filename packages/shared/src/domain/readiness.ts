/**
 * Derived readiness (Phase 1 Task 6) — a gate dot is a CONCLUSION drawn from
 * explicit recorded relationships, never a stored flag (material/team excepted —
 * stored until Phases 3/4, and labeled so). Both truth tables are evaluated
 * TOP-DOWN, FIRST MATCH WINS: states are mutually exclusive by construction.
 *
 * PINNED COPY NOTE: apps/api/src/domain/transitions.ts carries the SAME
 * derivation server-side (the API cannot import this source-only ESM package —
 * same pattern as the civil-date lib). Both sides run the same row-by-row table
 * tests (apps/api/src/domain/readiness.test.ts · apps/web/tests/readiness.test.ts)
 * — change them TOGETHER.
 */

import type { DecisionStatus, Gate } from './types';

export type GateSource = 'derived' | 'stored' | 'override';

export interface GateReading {
  v: Gate;
  source: GateSource;
  reason: string;
}

export interface ActivityReadiness {
  decision: GateReading;
  material: GateReading;
  team: GateReading;
  inspection: GateReading;
  drawing: GateReading;
}

export type OverridableGate = 'decision' | 'material' | 'team' | 'inspection' | 'drawing';

export interface ReadinessInspection {
  id: string;
  activityId: string | null;
  /** a closing sign-off (Task 5) — NEVER a member of the gate's input set R */
  closing?: boolean;
  submitted: boolean;
  decided: boolean;
  reinspectionOfId?: string | null;
  items: { rejected: boolean; result: string | null }[];
}

export interface ReadinessDrawing {
  number?: string;
  activityId: string | null;
  /** an unpublished draft is author-private — invisible to readiness */
  draft?: boolean;
  revisions: {
    status: string; // for_review | for_construction | superseded
    /** null = LEGACY revision predating recipient snapshots (row 2); a set value
     *  means the snapshot RAN — possibly freezing an empty set (row 3) */
    recipientsFrozenAt: Date | string | null;
    recipientIds: string[];
    ackedIds: string[];
  }[];
}

export interface ReadinessOverride {
  gate: OverridableGate;
  state: Gate;
  reason: string;
  expiresAt: Date | string;
  actorName?: string;
}

export interface ReadinessInput {
  decisionStatus: DecisionStatus | null;
  gateMaterial: Gate;
  gateTeam: Gate;
  inspections: ReadinessInspection[];
  drawings: ReadinessDrawing[];
  activeMemberIds: string[];
  /** rows for THIS activity, oldest first (the latest unexpired one wins its gate) */
  overrides: ReadinessOverride[];
  now: Date;
}

export function gateReady(g: Gate): boolean {
  return g === 'ok' || g === 'na';
}

/** a decided inspection whose outcome REJECTED work — the root/link of a correction chain */
const wasRejected = (i: ReadinessInspection): boolean =>
  i.decided && i.items.some((it) => it.rejected || it.result === 'FAIL');

/**
 * Inspection-gate truth table. Input set R = NON-closing inspections whose
 * requirement edge names THIS activity — co-located inspections with a
 * different or null activityId are INVISIBLE. First match wins:
 *   1. R empty → na · 2. any chain OPEN → fail · 3. open requirement → wait · 4. ok
 * Row 2 precedes row 3, so an open reinspection child reads FAIL.
 */
export function deriveInspectionGate(activityId: string, inspections: ReadinessInspection[]): GateReading {
  const R = inspections.filter((i) => i.activityId === activityId && !i.closing);
  if (R.length === 0) return { v: 'na', source: 'derived', reason: 'No linked inspection' }; // row 1

  const childOf = new Map<string, ReadinessInspection>();
  for (const i of R) if (i.reinspectionOfId) childOf.set(i.reinspectionOfId, i);

  for (const root of R.filter(wasRejected)) {
    let tip = root;
    while (childOf.has(tip.id)) tip = childOf.get(tip.id)!;
    const open = !tip.submitted || !tip.decided || wasRejected(tip);
    if (open) return { v: 'fail', source: 'derived', reason: `Correction chain open — the rejection of ${root.id} is not yet made good` }; // row 2
  }

  const waiting = R.find((i) => !i.submitted || !i.decided);
  if (waiting) return { v: 'wait', source: 'derived', reason: `Awaiting inspection ${waiting.id}` }; // row 3

  return { v: 'ok', source: 'derived', reason: 'All linked inspections accepted' }; // row 4
}

/** worst-wins precedence for the multi-drawing aggregate */
const GATE_SEVERITY: Record<Gate, number> = { fail: 3, wait: 2, ok: 1, na: 0 };

/**
 * Drawing-gate truth table, computed PER LINKED, PUBLISHED drawing then
 * aggregated worst-wins (fail > wait > ok); no linked drawings → na.
 *   1. no governing for_construction revision → fail
 *   2. legacy (recipientsFrozenAt null) → ok with ≥1 ack, else wait
 *   3. snapshot ran and active(P) empty → wait
 *   4. some member of active(P) unacked → wait · 5. all acked → ok
 */
export function deriveDrawingGate(activityId: string, drawings: ReadinessDrawing[], activeMemberIds: string[]): GateReading {
  const linked = drawings.filter((d) => d.activityId === activityId && !d.draft);
  if (linked.length === 0) return { v: 'na', source: 'derived', reason: 'No linked drawing' };

  const active = new Set(activeMemberIds);
  const per = (d: ReadinessDrawing): { v: Gate; why: string } => {
    const label = d.number ?? 'drawing';
    const G = d.revisions.find((r) => r.status === 'for_construction');
    if (!G) return { v: 'fail', why: `${label}: no construction revision governs (review-only or superseded out)` }; // row 1
    if (G.recipientsFrozenAt == null) {
      return G.ackedIds.length > 0
        ? { v: 'ok', why: `${label}: legacy revision acknowledged` } // row 2
        : { v: 'wait', why: `${label}: legacy revision awaiting a first acknowledgement` };
    }
    const activeP = G.recipientIds.filter((u) => active.has(u));
    if (activeP.length === 0) return { v: 'wait', why: `${label}: nobody currently on the project confirmed the governing set — re-issue or override` }; // row 3
    const acked = new Set(G.ackedIds);
    const pending = activeP.filter((u) => !acked.has(u));
    if (pending.length > 0) return { v: 'wait', why: `${label}: awaiting acknowledgement (${activeP.length - pending.length}/${activeP.length})` }; // row 4
    return { v: 'ok', why: `${label}: current set acknowledged by every active recipient` }; // row 5
  };

  const readings = linked.map(per);
  const worst = readings.reduce((a, b) => (GATE_SEVERITY[b.v] > GATE_SEVERITY[a.v] ? b : a));
  return { v: worst.v, source: 'derived', reason: worst.why };
}

/** The Decision gate — derived live from the linked decision's lock state. */
export function deriveDecisionReading(decisionStatus: DecisionStatus | null): GateReading {
  const v: Gate = decisionStatus == null ? 'na' : decisionStatus === 'approved' ? 'ok' : 'wait';
  const reason =
    decisionStatus == null
      ? 'No linked decision'
      : decisionStatus === 'approved'
        ? 'Decision approved and locked'
        : decisionStatus === 'change'
          ? 'Change requested — awaiting the client’s re-approval'
          : 'Awaiting the client’s approval';
  return { v, source: 'derived', reason };
}

/** The five-gate readiness derivation — an unexpired override supersedes ITS gate. */
export function deriveReadiness(activityId: string, input: ReadinessInput): ActivityReadiness {
  const derived: ActivityReadiness = {
    decision: deriveDecisionReading(input.decisionStatus),
    material: { v: input.gateMaterial, source: 'stored', reason: 'Stored site flag — material on site' },
    team: { v: input.gateTeam, source: 'stored', reason: 'Stored site flag — team present' },
    inspection: deriveInspectionGate(activityId, input.inspections),
    drawing: deriveDrawingGate(activityId, input.drawings, input.activeMemberIds),
  };

  for (const o of input.overrides) {
    if (new Date(o.expiresAt).getTime() <= input.now.getTime()) continue; // expiry restores the derivation
    derived[o.gate] = { v: o.state, source: 'override', reason: o.reason }; // latest row wins its gate
  }
  return derived;
}

/** The START guard (Task 6): all FIVE readiness values must align, overrides considered. */
export function readinessReady(r: ActivityReadiness): boolean {
  return ([r.decision, r.material, r.team, r.inspection, r.drawing] as GateReading[]).every((g) => gateReady(g.v));
}
