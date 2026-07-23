import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ActivitiesModuleResult, MaterialReadinessResult, RequirementReadinessRow, ActivityReadinessRow, ActivityShortageRow, ShortageImpact, ReservationPlan } from '@vitan/shared';
import { toIsoCivilDate } from '../common/civil-date';
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
   * Phase 3 Task 7 (`GET …/activities/material-readiness`) — the pilot MATERIAL-READINESS view (§A/§G/
   * §25). Capability-gated: a non-pilot project 404s exactly like every other Phase-3 read (no route, no
   * behavior). Reads per-requirement coverage from inventory's `coverageFor` (the SAME canonical authority
   * `activities.start` reads, in one read transaction — never the projection, so never a stale conclusion),
   * joins each requirement's display identity + its activity's planned start, and derives the SHORTAGE
   * forecast: a `blocked` requirement has no supply; an `at-risk` requirement is `delays-start` when its
   * earliest covering delivery lands AFTER the planned start, else `covered-in-time`.
   */
  async materialReadiness(projectId: string): Promise<MaterialReadinessResult> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    return this.prisma.$transaction(async (tx) => {
      const requirements = await loadCoverageRequirements(tx, projectId, this.substitutions);
      const coverage = await this.inventory.coverageFor(tx, projectId, requirements);
      if (coverage.length === 0) {
        return { requirements: [], activities: [], shortages: [], summary: { ready: 0, atRisk: 0, blocked: 0, total: 0 } };
      }
      const activityIds = [...new Set(coverage.map((c) => c.activityId))];
      const [acts, heads] = await Promise.all([
        tx.activity.findMany({ where: { projectId, id: { in: activityIds } }, select: { id: true, name: true, plannedStartDate: true } }),
        tx.activityRequirement.findMany({
          where: { projectId, OR: coverage.map((c) => ({ requirementId: c.requirementId, revision: c.revision })) },
          select: { requirementId: true, revision: true, requiredBy: true, materialSpec: { select: { materialCategory: true, make: true, grade: true } } },
        }),
      ]);
      const actById = new Map(acts.map((a) => [a.id, a]));
      const headByPin = new Map(heads.map((h) => [`${h.requirementId}#${h.revision}`, h]));
      const uomByPin = new Map(requirements.map((r) => [`${r.requirementId}#${r.revision}`, r.baseUom]));

      const rows: RequirementReadinessRow[] = coverage
        .map((c) => {
          const act = actById.get(c.activityId);
          const head = headByPin.get(`${c.requirementId}#${c.revision}`);
          const spec = head?.materialSpec;
          return {
            requirementId: c.requirementId,
            revision: c.revision,
            activityId: c.activityId,
            activityName: act?.name ?? c.activityId,
            material: spec ? [spec.materialCategory, spec.make, spec.grade].filter(Boolean).join(' · ') : 'Material',
            baseUom: uomByPin.get(`${c.requirementId}#${c.revision}`) ?? '',
            requiredQty: c.requiredQty,
            coveredQty: c.coveredQty,
            shortfall: c.shortfall,
            verdict: c.verdict,
            requiredBy: head?.requiredBy ? toIsoCivilDate(head.requiredBy) : null,
            plannedStartDate: act?.plannedStartDate ? toIsoCivilDate(act.plannedStartDate) : null,
            commitmentPromisedDate: c.commitmentPromisedDate,
            reason: c.reason,
          };
        })
        .sort((a, b) => (a.activityName !== b.activityName ? (a.activityName < b.activityName ? -1 : 1) : a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0));

      // ── ACTIVITY-level roll-up (finding 3). Stock is reserved to an ACTIVITY, and Task 6 gives every
      //    requirement of an activity ONE verdict (worst-wins, uniform). So readiness + shortage TOTALS
      //    are counted per activity; the per-requirement `rows` are supporting detail, never counted as
      //    independent shortages. The forecast (finding 4) measures the covering delivery against the
      //    EARLIEST applicable need date = min(plannedStartDate, earliest requiredBy). ──
      const earliestDate = (dates: (string | null)[]): string | null =>
        dates.filter((d): d is string => d !== null).sort()[0] ?? null;
      const activities: ActivityReadinessRow[] = activityIds
        .map((activityId) => {
          const reqRows = rows.filter((r) => r.activityId === activityId);
          const act = actById.get(activityId);
          const verdict = reqRows[0]!.verdict; // uniform across the activity (Task 6)
          const activityName = act?.name ?? activityId;
          const plannedStartDate = act?.plannedStartDate ? toIsoCivilDate(act.plannedStartDate) : null;
          const requiredBy = earliestDate(reqRows.map((r) => r.requiredBy));
          const needBy = earliestDate([plannedStartDate, requiredBy]);
          // the activity's combined covering date (uniform on at-risk rows); null when ready/blocked
          const commitmentPromisedDate = reqRows.find((r) => r.commitmentPromisedDate)?.commitmentPromisedDate ?? null;
          const shortRequirementCount = reqRows.filter((r) => Number(r.shortfall) > 0).length;
          const n = reqRows.length;
          const rl = (k: number) => (k === 1 ? '' : 's');
          let reason: string;
          if (verdict === 'ready') {
            reason = `All ${n} material requirement${rl(n)} covered (reserved + issued)`;
          } else if (verdict === 'at-risk') {
            reason = `${shortRequirementCount} of ${n} requirement${rl(n)} short; covering deliveries meet demand by ${commitmentPromisedDate}`;
          } else {
            reason = `${shortRequirementCount} of ${n} requirement${rl(n)} short — inbound commitments cannot cover demand`;
          }
          return { activityId, activityName, verdict, requirementCount: n, shortRequirementCount, plannedStartDate, requiredBy, needBy, commitmentPromisedDate, reason };
        })
        .sort((a, b) => (a.activityName !== b.activityName ? (a.activityName < b.activityName ? -1 : 1) : a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0));

      // ── shortages: ONE per affected ACTIVITY (finding 3), forecast against the EARLIEST need date (finding 4) ──
      const shortages: ActivityShortageRow[] = activities
        .filter((a) => a.verdict !== 'ready')
        .map((a) => {
          const verdict = a.verdict as 'at-risk' | 'blocked';
          const need = a.needBy;
          let impact: ShortageImpact;
          let impactReason: string;
          if (verdict === 'blocked') {
            impact = 'no-supply';
            impactReason = need
              ? `No covering delivery — ${a.activityName} needs material by ${need}`
              : `No covering delivery — ${a.activityName} cannot be supplied`;
          } else if (need && a.commitmentPromisedDate && a.commitmentPromisedDate > need) {
            // a covering delivery AFTER the earliest need date slips the activity — even if it precedes
            // the planned start (an earlier requiredBy still governs the need).
            impact = 'delays-start';
            impactReason = `Covering delivery by ${a.commitmentPromisedDate} lands AFTER the need date ${need} — ${a.activityName} will slip`;
          } else {
            impact = 'covered-in-time';
            impactReason = a.commitmentPromisedDate
              ? need
                ? `Covering delivery by ${a.commitmentPromisedDate}, before the need date ${need}`
                : `Covering delivery by ${a.commitmentPromisedDate}`
              : 'Covered by inbound delivery';
          }
          return { ...a, verdict, impact, impactReason };
        });
      // worst-first (blocked before at-risk), then soonest-needed, then activity id
      const sev = { blocked: 0, 'at-risk': 1 } as const;
      shortages.sort((a, b) => {
        if (sev[a.verdict] !== sev[b.verdict]) return sev[a.verdict] - sev[b.verdict];
        const ad = a.needBy ?? '9999-12-31';
        const bd = b.needBy ?? '9999-12-31';
        if (ad !== bd) return ad < bd ? -1 : 1;
        return a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0;
      });

      return {
        requirements: rows,
        activities,
        shortages,
        summary: {
          ready: activities.filter((a) => a.verdict === 'ready').length,
          atRisk: activities.filter((a) => a.verdict === 'at-risk').length,
          blocked: activities.filter((a) => a.verdict === 'blocked').length,
          total: activities.length,
        },
      };
    });
  }

  /**
   * Phase 3 Task 7 (correction 2) — the CANONICAL reservation plan for covering ONE activity's material
   * shortage (`GET …/activities/:activityId/reservation-plan`). Capability-gated (404 off-pilot). The
   * SERVER resolves coverage compatibility (current requirements + active substitutions + base UOM +
   * lot location + free qty) and returns EXACT single-command reservation candidates + the residual to
   * requisition — so the browser never recreates compatibility from fingerprints. Read in ONE
   * transaction from canonical facts (never a projection).
   */
  async reservationPlan(projectId: string, activityId: string): Promise<ReservationPlan> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    if (!(await this.existsInProject(projectId, activityId))) {
      throw new BadRequestException('activityId does not belong to this project');
    }
    return this.prisma.$transaction(async (tx) => {
      const requirements = await loadCoverageRequirements(tx, projectId, this.substitutions, [activityId]);
      if (requirements.length === 0) return { activityId, candidates: [], residuals: [] };
      const { candidates, residuals } = await this.inventory.reservationCandidatesFor(tx, projectId, requirements);
      const heads = await tx.activityRequirement.findMany({
        where: { projectId, OR: requirements.map((r) => ({ requirementId: r.requirementId, revision: r.revision })) },
        select: { requirementId: true, revision: true, materialSpec: { select: { materialCategory: true, make: true, grade: true } } },
      });
      const labelByPin = new Map(
        heads.map((h) => [
          `${h.requirementId}#${h.revision}`,
          h.materialSpec ? [h.materialSpec.materialCategory, h.materialSpec.make, h.materialSpec.grade].filter(Boolean).join(' · ') : 'Material',
        ]),
      );
      const label = (rid: string, rev: number): string => labelByPin.get(`${rid}#${rev}`) ?? 'Material';
      return {
        activityId,
        candidates: candidates.map((c) => ({
          requirementId: c.requirementId, revision: c.revision, lotId: c.lotId, storeLocation: c.storeLocation,
          qty: c.qty, baseUom: c.baseUom, material: label(c.requirementId, c.revision),
        })),
        residuals: residuals.map((r) => ({
          requirementId: r.requirementId, revision: r.revision, qty: r.qty, baseUom: r.baseUom, material: label(r.requirementId, r.revision),
        })),
      };
    });
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
