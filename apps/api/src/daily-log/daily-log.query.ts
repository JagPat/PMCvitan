import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { toIsoCivilDate } from '../common/civil-date';
import type { DailyLogDto, MaterialDto } from '../snapshot/types';

/**
 * Phase 2 Task 10 — the daily-log module's PUBLIC READ boundary (its query contract).
 *
 * The second fully-extracted backend module (after `decisions`): no other module reads
 * `dailyLog`/`crewRow`/`siteMaterial` persistence directly. Every cross-module read a consumer needs
 * is a narrow, same-transaction-safe query answered HERE — the snapshot's daily-log slice + project-
 * wide materials (moved VERBATIM so the snapshot stays byte-identical) and the tenant-ownership check
 * a media upload runs before storing a `dailyLogId`. The boundary CI check enforces the encapsulation.
 */

/** The daily-log-OWNED core of the DailyLog slice — the {@link DailyLogDto} WITHOUT its `photos`,
 *  which are progress MEDIA the snapshot composes (media is a separate module, not daily-log's to
 *  own). The snapshot re-attaches `photos: progressPhotos` onto this core, keeping the DTO identical. */
export type DailyLogCore = Omit<DailyLogDto, 'photos'>;

@Injectable()
export class DailyLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The daily-log slice of the project snapshot: the LATEST daily log (crew + its own materials) as
   * the photo-less {@link DailyLogCore}, PLUS the project-wide site materials for the Site Map's
   * "materials here". The two reads + their serialization moved here verbatim (byte-identical); the
   * snapshot adds the media-sourced progress photos to the core.
   */
  async snapshotSlice(projectId: string): Promise<{ dailyLog: DailyLogCore | null; materials: MaterialDto[] }> {
    const [dailyLog, allMaterials] = await Promise.all([
      this.prisma.dailyLog.findFirst({
        where: { projectId },
        include: { crew: { orderBy: { order: 'asc' } }, materials: { orderBy: { order: 'asc' } } },
        // real civil day first (Task 6); creation instant is only the tie-breaker
        orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      // All materials across the project's daily logs (for the Site Map), not just the current day.
      this.prisma.siteMaterial.findMany({ where: { dailyLog: { projectId } }, orderBy: { order: 'asc' } }),
    ]);
    return {
      dailyLog: dailyLog
        ? {
            date: dailyLog.date,
            logDate: toIsoCivilDate(dailyLog.logDate),
            checkedIn: dailyLog.checkedIn,
            checkinTime: dailyLog.checkinTime,
            submitted: dailyLog.submitted,
            progress: dailyLog.progress,
            crew: dailyLog.crew.map((c) => ({ trade: c.trade, count: c.count })),
            materials: dailyLog.materials.map((m) => ({
              name: m.name,
              decisionId: m.decisionId ?? '',
              qty: m.qty,
              zone: m.zone,
              matched: m.matched,
              swatch: m.swatch,
              photo: m.photo,
            })),
          }
        : null,
      materials: allMaterials.map((m) => ({
        id: m.id,
        name: m.name,
        qty: m.qty,
        zone: m.zone,
        matched: m.matched,
        swatch: m.swatch,
        decisionId: m.decisionId ?? undefined,
        nodeId: m.nodeId ?? undefined,
      })),
    };
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
