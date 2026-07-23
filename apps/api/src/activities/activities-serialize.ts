import { Prisma } from '@prisma/client';
import { deriveReadiness, type DecisionStatus, type ReadinessDrawing, type ReadinessInspection, type ReadinessOverride } from '../domain/transitions';
import { toIsoCivilDate } from '../common/civil-date';
import { deriveMaterialReading } from './material-readiness';
import type { RequirementCoverage } from '../inventory/coverage';
import type { ActivityDto, PhaseDto } from '../snapshot/types';

/**
 * Phase 2 Task 10 (Module 4) — the ONE canonical activities read serializer, shared by the live snapshot
 * slice ({@link ActivitiesQueryService.snapshotSlice}) AND the rebuildable projection consumer, so the
 * projection-served slices are byte-identical to the live ones by construction.
 *
 * Two stages (mirroring inspections, with the Module-3 staleness lesson applied up front):
 *  1. {@link computeActivitiesBase} reads CANONICAL state into an ACTIVITY-OWNED base — every activity
 *     with its own columns, every gate override (ALL of them, expiry filtered at bake time so time-based
 *     expiry needs no event), and every phase. NOTHING foreign-owned enters the base: no decision status,
 *     no inspection/drawing gate inputs, no membership list — those all change under events the
 *     activities projection does not consume, so storing them would recreate the silently-stale
 *     projection the Module-3 correction removed.
 *  2. {@link bakeActivities} turns that base into the two snapshot keys (`activities` + `phases`),
 *     deriving each activity's five-gate `readiness` FRESH from the foreign inputs the caller fetched at
 *     read time through the decisions/inspections/drawings query contracts. Both the live read and the
 *     projection read bake through this one function, so the two are identical whenever the base is.
 */

/** One activity as the projection stores it: activity-owned facts only, JSON-serializable (civil dates as
 *  ISO strings, override expiry as ISO timestamps — revived at bake). */
export interface ActivityBaseEntry {
  id: string;
  name: string;
  zone: string;
  decisionId: string | null;
  phaseId: string | null;
  nodeId: string | null;
  ps: number;
  pe: number;
  as: number | null;
  ae: number | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  /** the RAW stored status (`not_started`/`in_progress`/`awaiting_signoff`/`done`/`blocked`) — remapped
   *  to the wire form at bake. */
  status: string;
  gateMaterial: string;
  gateTeam: string;
  gateInspection: string;
  block: string | null;
  /** ALL overrides (oldest-first — the latest unexpired wins its gate). Expiry is filtered at BAKE time
   *  against the read's `now`, so a purely time-based expiry needs no event to stay truthful. */
  overrides: {
    id: string;
    gate: string;
    state: string;
    reason: string;
    actorName: string;
    expiresAt: string; // ISO timestamp
    evidenceMediaId: string | null;
  }[];
}

export interface PhaseBaseEntry {
  id: string;
  name: string;
  order: number;
  plannedStart: number;
  plannedEnd: number;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
}

export interface ActivitiesBase {
  activities: ActivityBaseEntry[];
  phases: PhaseBaseEntry[];
}

/** The two snapshot keys the activity spine owns. */
export interface ActivitiesSlices {
  activities: ActivityDto[];
  phases: PhaseDto[];
}

/** The FOREIGN readiness inputs the bake derives each activity's five gates from — fetched FRESH at read
 *  time through the owning modules' query contracts (never stored in the base). */
export interface ActivitiesBakeInputs {
  decisionStatuses: ReadonlyMap<string, string>;
  inspections: ReadinessInspection[];
  drawings: ReadinessDrawing[];
  activeMemberIds: string[];
  now: Date;
  /** Phase 3 Task 6 — per-activity canonical material coverage (§A). Present ONLY on a pilot
   *  project; absent for non-pilot reads, whose material gate stays the stored flag byte-for-byte. */
  materialCoverage?: ReadonlyMap<string, RequirementCoverage[]>;
}

/** stored → wire status remap (moved verbatim from the snapshot service). */
const ACTIVITY_STATUS_OUT: Record<string, ActivityDto['status']> = {
  not_started: 'not-started',
  in_progress: 'in-progress',
  awaiting_signoff: 'awaiting-signoff',
  done: 'done',
  blocked: 'blocked',
};

/**
 * Read the activity-owned base from CANONICAL state through ANY Prisma client: the injected service for a
 * live read, or a projection apply/rebuild transaction. The three reads and their orderings are exactly
 * the ones the snapshot service performed before the extraction.
 */
export async function computeActivitiesBase(
  client: Prisma.TransactionClient,
  projectId: string,
): Promise<ActivitiesBase> {
  const [activities, phases, overrides] = await Promise.all([
    client.activity.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
    client.phase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
    client.gateOverride.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const overridesByActivity = new Map<string, typeof overrides>();
  for (const o of overrides) {
    const list = overridesByActivity.get(o.activityId) ?? [];
    list.push(o);
    overridesByActivity.set(o.activityId, list);
  }
  return {
    activities: activities.map((a) => ({
      id: a.id,
      name: a.name,
      zone: a.zone,
      decisionId: a.decisionId,
      phaseId: a.phaseId,
      nodeId: a.nodeId,
      ps: a.plannedStart,
      pe: a.plannedEnd,
      as: a.actualStart,
      ae: a.actualEnd,
      plannedStartDate: toIsoCivilDate(a.plannedStartDate),
      plannedEndDate: toIsoCivilDate(a.plannedEndDate),
      actualStartDate: toIsoCivilDate(a.actualStartDate),
      actualEndDate: toIsoCivilDate(a.actualEndDate),
      status: a.status,
      gateMaterial: a.gateMaterial,
      gateTeam: a.gateTeam,
      gateInspection: a.gateInspection,
      block: a.block,
      overrides: (overridesByActivity.get(a.id) ?? []).map((o) => ({
        id: o.id,
        gate: o.gate,
        state: o.state,
        reason: o.reason,
        actorName: o.actorName,
        expiresAt: o.expiresAt.toISOString(),
        evidenceMediaId: o.evidenceMediaId,
      })),
    })),
    phases: phases.map((p) => ({
      id: p.id,
      name: p.name,
      order: p.order,
      plannedStart: p.plannedStart,
      plannedEnd: p.plannedEnd,
      plannedStartDate: toIsoCivilDate(p.plannedStartDate),
      plannedEndDate: toIsoCivilDate(p.plannedEndDate),
    })),
  };
}

/**
 * Bake the stored base into the two snapshot keys. A pure function of (base, foreign inputs), moved
 * verbatim from the snapshot service: the five-gate readiness derivation per activity, the ACTIVE
 * (unexpired at `now`) override list for the UI, the stored→wire status remap, and the phase rollup
 * computed from the baked activities. Projection-served and live-served slices are identical whenever
 * the base is, and readiness is always as fresh as the inputs the caller just fetched.
 */
export function bakeActivities(base: ActivitiesBase, inputs: ActivitiesBakeInputs): ActivitiesSlices {
  const { decisionStatuses, inspections, drawings, activeMemberIds, now } = inputs;

  const activityDtos: ActivityDto[] = base.activities.map((a) => {
    const readiness = deriveReadiness(a.id, {
      decisionStatus: a.decisionId ? ((decisionStatuses.get(a.decisionId) as DecisionStatus | undefined) ?? null) : null,
      gateMaterial: a.gateMaterial as ActivityDto['gm'],
      gateTeam: a.gateTeam as ActivityDto['gt'],
      inspections,
      drawings,
      activeMemberIds,
      overrides: a.overrides.map((o) => ({ gate: o.gate as ReadinessOverride['gate'], state: o.state as ReadinessOverride['state'], reason: o.reason, expiresAt: o.expiresAt, actorName: o.actorName })),
      now,
    });
    // Phase 3 Task 6 (§A/§D): on a PILOT project the material gate is CANONICAL coverage, baked
    // LIVE here exactly like the other four derived gates (never the stored flag, never behind a
    // projection). `materialCoverage` is present ONLY when the caller resolved coverage for a
    // pilot project; it is absent for non-pilot reads, so their material gate stays byte-for-byte
    // the stored flag. An unexpired material override still supersedes (Phase-1 rule unchanged).
    if (inputs.materialCoverage && readiness.material.source !== 'override') {
      readiness.material = deriveMaterialReading(inputs.materialCoverage.get(a.id) ?? [], a.gateMaterial === 'fail');
    }
    return {
      id: a.id,
      name: a.name,
      zone: a.zone,
      decisionId: a.decisionId,
      phaseId: a.phaseId,
      nodeId: a.nodeId ?? undefined, // location spine: where this work happens
      ps: a.ps,
      pe: a.pe,
      as: a.as,
      ae: a.ae,
      plannedStartDate: a.plannedStartDate,
      plannedEndDate: a.plannedEndDate,
      actualStartDate: a.actualStartDate,
      actualEndDate: a.actualEndDate,
      status: ACTIVITY_STATUS_OUT[a.status],
      // legacy stored flags (deprecated display fields; `readiness` is the truth). Under the pilot
      // the material display flag tracks the derived gate so the two never disagree.
      gm: (inputs.materialCoverage ? readiness.material.v : a.gateMaterial) as ActivityDto['gm'],
      gt: a.gateTeam as ActivityDto['gt'],
      gi: a.gateInspection as ActivityDto['gi'],
      block: a.block ?? undefined,
      readiness,
      // the ACTIVE manual exceptions, surfaced for the override UI (revoke + expiry)
      overrides: a.overrides
        .filter((o) => new Date(o.expiresAt).getTime() > now.getTime())
        .map((o) => ({ id: o.id, gate: o.gate as ReadinessOverride['gate'], state: o.state as ReadinessOverride['state'], reason: o.reason, actorName: o.actorName, expiresAt: o.expiresAt, evidenceMediaId: o.evidenceMediaId ?? undefined })),
    };
  });

  // Phase rollups: each phase's activities counted by status so the schedule
  // and portfolio can show phase-level progress (done/total → donePct).
  const phaseDtos: PhaseDto[] = base.phases.map((p) => {
    const acts = activityDtos.filter((a) => a.phaseId === p.id);
    const done = acts.filter((a) => a.status === 'done').length;
    const inProgress = acts.filter((a) => a.status === 'in-progress').length;
    const blocked = acts.filter((a) => a.status === 'blocked').length;
    const notStarted = acts.filter((a) => a.status === 'not-started').length;
    return {
      id: p.id,
      name: p.name,
      order: p.order,
      plannedStart: p.plannedStart,
      plannedEnd: p.plannedEnd,
      plannedStartDate: p.plannedStartDate,
      plannedEndDate: p.plannedEndDate,
      activityTotal: acts.length,
      done,
      inProgress,
      blocked,
      notStarted,
      donePct: acts.length ? Math.round((done / acts.length) * 100) : 0,
    };
  });

  return { activities: activityDtos, phases: phaseDtos };
}
