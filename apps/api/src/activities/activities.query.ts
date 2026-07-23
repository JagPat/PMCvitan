import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ActivitiesModuleResult } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DrawingsQueryService } from '../drawings/drawings.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { bakeActivities, computeActivitiesBase, type ActivitiesBakeInputs, type ActivitiesBase, type ActivitiesSlices } from './activities-serialize';
import { ACTIVITIES_PROJECTION } from './activities.projection';
import { readServableGeneration } from '../platform/projections/generation';
import { InventoryService } from '../inventory/inventory.service';
import { SubstitutionsService } from './substitutions.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { loadCoverageRequirements } from './coverage-requirements';
import type { RequirementCoverage } from '../inventory/coverage';

/** A phase's copyable STRUCTURE (never actuals) a project-copy/module-extract reads through this
 *  boundary. */
export interface PhaseStructure {
  id: string;
  name: string;
  order: number;
  plannedStart: number;
  plannedEnd: number;
}

/** An activity's copyable PLANNED shape (name/zone/planned window/place/phase/order + the stored gate
 *  flags the copier strips of outcomes) — never status, actuals or links. */
export interface ActivityStructure {
  name: string;
  zone: string;
  plannedStart: number;
  plannedEnd: number;
  nodeId: string | null;
  phaseId: string | null;
  order: number;
  gateMaterial: string;
  gateTeam: string;
  gateInspection: string;
}

/**
 * Phase 2 Task 10 (Module 4) — the ACTIVITIES module's PUBLIC READ boundary (its query contract).
 *
 * A fully-extracted backend module: no other module reads `activity`/`gateOverride`/`phase`/
 * `activitiesProjection` persistence directly. Every cross-module read a consumer needs is a narrow query
 * answered HERE — the snapshot's two activity-spine keys (`activities` + `phases`, from the ONE canonical
 * serializer so the snapshot stays byte-identical), the project-initialization structure/id reads, and the
 * portfolio's per-project status rollup. Derived READINESS is baked at read time from the decisions/
 * inspections/drawings query contracts (this module's declared dependsOn edges) — never stored — so the
 * projection can never serve a stale conclusion; the boundary CI check enforces the encapsulation.
 */
@Injectable()
export class ActivitiesQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decisionsQuery: DecisionsQueryService,
    private readonly drawingsQuery: DrawingsQueryService,
    private readonly inspectionsQuery: InspectionsQueryService,
    // Phase 3 Task 6 — the §A material gate is baked LIVE from canonical coverage on a pilot
    // project (the same authority `activities.start` reads), so the read path is never stale.
    private readonly inventory: InventoryService,
    private readonly substitutions: SubstitutionsService,
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** Per-activity canonical material coverage for a PILOT project (§A/§D) — undefined on a
   *  non-pilot project, so the bake keeps the stored material gate byte-for-byte. Read LIVE
   *  (like every other readiness input); the start command reads the same authority in-tx. */
  private async materialCoverage(projectId: string): Promise<ReadonlyMap<string, RequirementCoverage[]> | undefined> {
    if (!(await this.capabilities.isEnabled(projectId, MATERIALS_CAPABILITY))) return undefined;
    const requirements = await loadCoverageRequirements(this.prisma, projectId, this.substitutions);
    const coverage = await this.inventory.coverageFor(this.prisma, projectId, requirements);
    const map = new Map<string, RequirementCoverage[]>();
    for (const c of coverage) {
      const list = map.get(c.activityId) ?? [];
      list.push(c);
      map.set(c.activityId, list);
    }
    return map;
  }

  /** Fetch the FOREIGN readiness inputs fresh — through the owning modules' query contracts. The
   *  snapshot passes its already-fetched decision status map to avoid a duplicate read; the module GET
   *  fetches its own. */
  private async bakeInputs(projectId: string, decisionStatuses?: ReadonlyMap<string, string>): Promise<ActivitiesBakeInputs> {
    const [statuses, inspections, drawings, activeMembers, materialCoverage] = await Promise.all([
      decisionStatuses ?? this.decisionsQuery.statusMap(projectId),
      this.inspectionsQuery.readinessSlice(projectId),
      this.drawingsQuery.readinessSlice(projectId),
      this.prisma.membership.findMany({ where: { projectId, status: 'active' }, select: { userId: true } }),
      this.materialCoverage(projectId),
    ]);
    return {
      decisionStatuses: statuses,
      inspections,
      drawings,
      activeMemberIds: activeMembers.map((m) => m.userId),
      now: new Date(),
      materialCoverage,
    };
  }

  /**
   * The activity-spine slice of the project snapshot (`activities` + `phases`), served from LIVE canonical
   * state, with each activity's five-gate readiness derived fresh. `decisionStatuses` lets the snapshot
   * reuse the id→status map it already fetched from the decisions query (identical data — the bake result
   * cannot differ).
   */
  async snapshotSlice(projectId: string, opts: { decisionStatuses?: ReadonlyMap<string, string> } = {}): Promise<ActivitiesSlices> {
    const [base, inputs] = await Promise.all([
      computeActivitiesBase(this.prisma, projectId),
      this.bakeInputs(projectId, opts.decisionStatuses),
    ]);
    return bakeActivities(base, inputs);
  }

  /**
   * The activity-spine slice served from the REBUILDABLE PROJECTION (`activities.schedule`) instead of the
   * live base read. The projection stores the ACTIVITY-OWNED base only; this reads the project's ACTIVE,
   * servable generation row and bakes it with FRESH foreign readiness inputs — so a projection read is
   * never a stale conclusion (readiness is as current as the live read's) and never bypasses the
   * derivation rules.
   *
   * `generation` is non-null ONLY when the projection is SAFE TO SERVE (finding 1): its active generation
   * is healthy (`cursorStatus='live'`) AND caught up to the committed stream head AND its row exists. A
   * no-op-bootstrapped (no row), lagging or blocked generation returns `generation: null` and the caller
   * falls back to the canonical live slice.
   */
  async projectionSlice(projectId: string): Promise<{ slices: ActivitiesSlices; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, ACTIVITIES_PROJECTION, projectId);
    const empty: ActivitiesSlices = { activities: [], phases: [] };
    if (!gen) return { slices: empty, generation: null };

    const row = await this.prisma.activitiesProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      select: { dto: true },
    });
    // A caught-up generation with NO row yet is not authoritative-empty data — fall back to canonical.
    if (!row) return { slices: empty, generation: null };
    const base = row.dto as unknown as ActivitiesBase;
    return { slices: bakeActivities(base, await this.bakeInputs(projectId)), generation: gen.generation };
  }

  /**
   * Phase 2 Task 10 — the MODULE-OWNED activities read the frontend calls (`GET …/activities`). Serves
   * from the rebuildable projection when it has a safe active generation; otherwise falls back to the live
   * slices (a project whose activity events the relay has not applied yet, or a legacy project never
   * rebuilt) — additive and correct, never empty during warm-up. `source` tells the client which path
   * served the base (the slices are byte-identical either way; readiness is fresh on both paths).
   */
  async moduleActivities(projectId: string): Promise<ActivitiesModuleResult> {
    const proj = await this.projectionSlice(projectId);
    if (proj.generation !== null) {
      return { ...proj.slices, source: 'projection', generation: proj.generation };
    }
    const live = await this.snapshotSlice(projectId);
    return { ...live, source: 'live', generation: null };
  }

  /**
   * Every existing activity id across ALL projects (DATA-01: `ACT-N` ids are globally unique, so the scan
   * is global). Project initialization reads this ONCE to seed its id-minting cursor — through THIS
   * boundary instead of `prisma.activity` directly.
   */
  async allIds(tx?: Prisma.TransactionClient): Promise<string[]> {
    const db = tx ?? this.prisma;
    const existing = await db.activity.findMany({ select: { id: true } });
    return existing.map((a) => a.id);
  }

  /**
   * The SCHEDULE structure a project-copy/module-extract reads from a SOURCE project: phases (name/order/
   * planned window) + activities as their PLANNED shape (name/zone/planned window/place/phase/order + the
   * stored gate flags the copier strips of outcomes). Status, actuals, decision links and blocks are
   * results, not structure, so they never travel. The project-initialization copy and the module-payload
   * extractor both read source schedule through THIS boundary instead of `prisma.phase`/`prisma.activity`
   * directly.
   */
  async scheduleStructures(
    projectId: string,
    opts: { tx?: Prisma.TransactionClient } = {},
  ): Promise<{ phases: PhaseStructure[]; activities: ActivityStructure[] }> {
    const db = opts.tx ?? this.prisma;
    const [phases, activities] = await Promise.all([
      db.phase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      db.activity.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
    ]);
    return {
      phases: phases.map((p) => ({ id: p.id, name: p.name, order: p.order, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd })),
      activities: activities.map((a) => ({
        name: a.name,
        zone: a.zone,
        plannedStart: a.plannedStart,
        plannedEnd: a.plannedEnd,
        nodeId: a.nodeId,
        phaseId: a.phaseId,
        order: a.order,
        gateMaterial: a.gateMaterial,
        gateTeam: a.gateTeam,
        gateInspection: a.gateInspection,
      })),
    };
  }

  /**
   * The portfolio's per-project activity STATUS rollup + phase count — the org portfolio board reads these
   * through the boundary instead of `prisma.activity.findMany`/`prisma.phase.count` directly.
   */
  async statusCounts(projectId: string): Promise<{ total: number; done: number; inProgress: number; blocked: number; notStarted: number; phaseCount: number }> {
    const [activities, phaseCount] = await Promise.all([
      this.prisma.activity.findMany({ where: { projectId }, select: { status: true } }),
      this.prisma.phase.count({ where: { projectId } }),
    ]);
    return {
      // `total` counts EVERY activity (an `awaiting_signoff` claim is in the total but no bucket)
      total: activities.length,
      done: activities.filter((a) => a.status === 'done').length,
      inProgress: activities.filter((a) => a.status === 'in_progress').length,
      blocked: activities.filter((a) => a.status === 'blocked').length,
      notStarted: activities.filter((a) => a.status === 'not_started').length,
      phaseCount,
    };
  }

  /** Does activity `activityId` exist in project `projectId`? (Modules UPSTREAM of activities in the
   *  dependsOn graph cannot take this query without a cycle — their stored references are validated by the
   *  composite tenant FKs instead; see the shared contract note.) */
  async existsInProject(projectId: string, activityId: string): Promise<boolean> {
    const row = await this.prisma.activity.findFirst({ where: { id: activityId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Resolve an OPTIONAL activity reference: null/undefined pass through; a present id must belong to
   *  THIS project. */
  async resolveRefInProject(
    projectId: string,
    id: string | null | undefined,
    field = 'activityId',
  ): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }
}
