import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InspectionsModuleResult, ReadinessInspection, Role } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { SignedUrlService } from '../media/signed-url.service';
import { bakeInspections, computeInspectionsBase, type InspectionsBase, type InspectionsSlices } from './inspections-serialize';
import { INSPECTIONS_PROJECTION } from './inspections.projection';
import { readServableGeneration } from '../platform/projections/generation';

/**
 * Phase 2 Task 10 (Module 3) — the INSPECTIONS module's PUBLIC READ boundary (its query contract).
 *
 * A fully-extracted backend module: no other module reads `inspection`/`inspectionItem`/
 * `inspectionsProjection` persistence directly. Every cross-module read a consumer needs is a narrow
 * query answered HERE — the snapshot's five role-gated inspection slices (from the ONE canonical
 * serializer so the snapshot stays byte-identical), the inspection-gate READINESS input the activity-start
 * command evaluates under its project lock, and the tenant-ownership check a media evidence upload runs
 * before storing an `inspectionId`. Per-viewer/role visibility and each item's fresh signed evidence paths
 * are baked at read time ({@link bakeInspections}); the boundary CI check enforces the encapsulation.
 */
@Injectable()
export class InspectionsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Bake an evidence media row's short-lived signed serve path (minted per read — never stored). */
  private evidencePath = (mediaId: string): string => this.signed.mediaPath(mediaId);

  /**
   * The inspection slices of the project snapshot (checklist / reviews / review / reinspectionCreated /
   * placedInspections), baked for `role` (PMC-only review queue, pmc/engineer placement) with each item's
   * evidence as fresh signed serve paths. Served from LIVE canonical state.
   */
  async snapshotSlice(projectId: string, role: Role): Promise<InspectionsSlices> {
    const base = await computeInspectionsBase(this.prisma, projectId);
    return bakeInspections(base, { role, evidencePath: this.evidencePath });
  }

  /**
   * The inspection slices served from the REBUILDABLE PROJECTION (`inspections.inbox`) instead of the live
   * read. Like daily-log/drawings (one per-project composite row), the projection stores the viewer-
   * INDEPENDENT base; this reads the project's ACTIVE, servable generation row and bakes it for `role` — so
   * a projection is never an RBAC bypass (the same role gate runs at read) and never serves a stale signed
   * path (each read mints fresh tokens).
   *
   * `generation` is non-null ONLY when the projection is SAFE TO SERVE (finding 1): its active generation
   * is healthy (`cursorStatus='live'`) AND caught up to the committed stream head AND its row exists. A
   * no-op-bootstrapped (no row), lagging or blocked generation returns `generation: null` and the caller
   * falls back to the canonical live slice.
   */
  async projectionSlice(projectId: string, role: Role): Promise<{ slices: InspectionsSlices; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, INSPECTIONS_PROJECTION, projectId);
    const empty: InspectionsSlices = { checklist: null, reviews: [], review: null, reinspectionCreated: false, placedInspections: [] };
    if (!gen) return { slices: empty, generation: null };

    const row = await this.prisma.inspectionsProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      select: { dto: true },
    });
    // A caught-up generation with NO row yet is not authoritative-empty data — fall back to canonical.
    if (!row) return { slices: empty, generation: null };
    const base = row.dto as unknown as InspectionsBase;
    return { slices: bakeInspections(base, { role, evidencePath: this.evidencePath }), generation: gen.generation };
  }

  /**
   * Phase 2 Task 10 — the MODULE-OWNED inspections read the frontend calls (`GET …/inspections`). Serves
   * from the rebuildable projection when it has a safe active generation; otherwise falls back to the live
   * slices (a project whose inspection events the relay has not applied yet, or a legacy project never
   * rebuilt) — additive and correct, never empty during warm-up. `source` tells the client which path
   * served it (the slices are byte-identical either way).
   */
  async moduleInspections(projectId: string, role: Role): Promise<InspectionsModuleResult> {
    const proj = await this.projectionSlice(projectId, role);
    if (proj.generation !== null) {
      return { ...proj.slices, source: 'projection', generation: proj.generation };
    }
    const live = await this.snapshotSlice(projectId, role);
    return { ...live, source: 'live', generation: null };
  }

  /**
   * The inspection-gate READINESS input for the shared truth table ({@link deriveInspectionGate}): each
   * inspection's activity link + closing flag + submit/decide state + per-item rejected/result. The ONLY
   * read of inspection persistence a consumer needs for readiness — so the snapshot and the activity-start
   * command evaluate the inspection gate through this boundary instead of reading `prisma.inspection`
   * directly (read-encapsulation). `activityId` scopes it to one activity's inspections (the start
   * command); `tx` runs it inside the caller's transaction (the atomic readiness evaluation under the
   * project lock).
   */
  async readinessSlice(
    projectId: string,
    opts: { activityId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<ReadinessInspection[]> {
    const db = opts.tx ?? this.prisma;
    const inspections = await db.inspection.findMany({
      where: { projectId, ...(opts.activityId ? { activityId: opts.activityId } : {}) },
      include: { items: { select: { rejected: true, result: true } } },
    });
    return inspections.map((i) => ({
      id: i.id,
      activityId: i.activityId,
      closing: i.closing,
      submitted: i.submitted,
      decided: i.decided,
      reinspectionOfId: i.reinspectionOfId,
      items: i.items.map((it) => ({ rejected: it.rejected, result: it.result })),
    }));
  }

  /** Does inspection `inspectionId` exist in project `projectId`? The tenant-ownership check a consumer
   *  (a media evidence upload linking an `inspectionId`) runs before storing a reference to it. */
  async existsInProject(projectId: string, inspectionId: string): Promise<boolean> {
    const row = await this.prisma.inspection.findFirst({ where: { id: inspectionId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Resolve an OPTIONAL inspection reference: null/undefined pass through; a present id must belong to
   *  THIS project. */
  async resolveRefInProject(
    projectId: string,
    id: string | null | undefined,
    field = 'inspectionId',
  ): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }
}
