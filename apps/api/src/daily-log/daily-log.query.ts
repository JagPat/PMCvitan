import { BadRequestException, Injectable } from '@nestjs/common';
import type { DailyLogModuleResult } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { MaterialDto } from '../snapshot/types';
import { computeDailyLogSlice, type DailyLogCore, type DailyLogSlice } from './daily-log-serialize';
import { DAILY_LOG_PROJECTION } from './daily-log.projection';
import { readServableGeneration } from '../platform/projections/generation';

// Re-export the module's read-model core type so consumers keep importing it from the query boundary.
export type { DailyLogCore } from './daily-log-serialize';

/**
 * Phase 2 Task 10 — the daily-log module's PUBLIC READ boundary (its query contract).
 *
 * The second fully-extracted backend module (after `decisions`): no other module reads
 * `dailyLog`/`crewRow`/`siteMaterial` persistence directly. Every cross-module read a consumer needs
 * is a narrow, same-transaction-safe query answered HERE — the snapshot's daily-log slice + project-
 * wide materials (from the ONE canonical serializer so the snapshot stays byte-identical) and the
 * tenant-ownership check a media upload runs before storing a `dailyLogId`. The boundary CI check
 * enforces the encapsulation.
 */
@Injectable()
export class DailyLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The daily-log slice of the project snapshot: the LATEST daily log (crew + its own materials) as
   * the photo-less {@link DailyLogCore}, PLUS the project-wide site materials for the Site Map's
   * "materials here". Served from the LIVE canonical state; the snapshot adds the media progress
   * photos onto the core. Role-invariant — every viewer of the project sees the same slice.
   */
  async snapshotSlice(projectId: string): Promise<{ dailyLog: DailyLogCore | null; materials: MaterialDto[] }> {
    const slice = await computeDailyLogSlice(this.prisma, projectId);
    return { dailyLog: slice.dailyLog, materials: slice.materials };
  }

  /**
   * Phase 2 Task 10 — the daily-log slice served from the REBUILDABLE PROJECTION (`daily-log.inbox`)
   * instead of the live read. Unlike decisions (one row per decision), the daily-log slice is a
   * per-PROJECT composite, so its active generation holds ONE row storing the whole serialized slice.
   * Reads the project's ACTIVE generation's `DailyLogProjection` row (the pre-serialized slice the
   * projection consumer refreshed from canonical) — byte-identical to {@link snapshotSlice}, and with
   * no per-viewer authz there is nothing to re-filter (a projection is never an RBAC bypass; here it
   * has no visibility rule to bypass).
   *
   * `generation` is the served generation number, non-null ONLY when the projection is SAFE TO SERVE:
   * its active generation is healthy (`cursorStatus='live'`) AND caught up to the project's committed
   * stream head (finding 1), AND its row actually exists. A generation that a no-op merely bootstrapped
   * (no row yet), one whose checkpoint lags a just-committed write, or a blocked one returns
   * `generation: null` — the caller then falls back to the canonical live slice, which is always
   * current. This closes the bug where an unrelated no-op created an active generation with no row and
   * the read served an empty slice as authoritative projection data, hiding real canonical data.
   */
  async projectionSlice(
    projectId: string,
  ): Promise<{ dailyLog: DailyLogCore | null; materials: MaterialDto[]; generation: number | null }> {
    // Serve only from a HEALTHY, CAUGHT-UP active generation (else signal fallback to canonical).
    const gen = await readServableGeneration(this.prisma, DAILY_LOG_PROJECTION, projectId);
    if (!gen) return { dailyLog: null, materials: [], generation: null };

    const row = await this.prisma.dailyLogProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      select: { dto: true },
    });
    // A caught-up generation with NO row yet is not authoritative empty data — fall back to canonical.
    if (!row) return { dailyLog: null, materials: [], generation: null };
    const slice = row.dto as unknown as DailyLogSlice;
    return { dailyLog: slice.dailyLog, materials: slice.materials, generation: gen.generation };
  }

  /**
   * Phase 2 Task 10 — the MODULE-OWNED daily-log read the frontend calls (the `GET …/daily-log`
   * endpoint). Serves from the rebuildable projection when it has an active generation; otherwise
   * falls back to the live slice (a project whose daily-log events the relay has not applied yet, or a
   * legacy project never rebuilt) — additive and correct, never empty during warm-up. `source` tells
   * the client which path served it (observability; the slice is byte-identical either way).
   */
  async moduleDailyLog(projectId: string): Promise<DailyLogModuleResult> {
    const proj = await this.projectionSlice(projectId);
    if (proj.generation !== null) {
      return { dailyLog: proj.dailyLog, materials: proj.materials, source: 'projection', generation: proj.generation };
    }
    const live = await this.snapshotSlice(projectId);
    return { dailyLog: live.dailyLog, materials: live.materials, source: 'live', generation: null };
  }

  /** Does daily log `dailyLogId` exist in project `projectId`? The tenant-ownership check a consumer
   *  (media upload with a `dailyLogId` link) runs before storing a reference to it. */
  async existsInProject(projectId: string, dailyLogId: string): Promise<boolean> {
    const row = await this.prisma.dailyLog.findFirst({ where: { id: dailyLogId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Resolve an OPTIONAL daily-log reference the way `resolveProjectRef('dailyLog', …)` did before
   *  extraction: null/undefined pass through; a present id must belong to THIS project. */
  async resolveRefInProject(projectId: string, id: string | null | undefined, field = 'dailyLogId'): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }
}
