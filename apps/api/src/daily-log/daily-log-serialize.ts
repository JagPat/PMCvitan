import { Prisma } from '@prisma/client';
import { toIsoCivilDate } from '../common/civil-date';
import type { DailyLogDto, MaterialDto } from '../snapshot/types';

/**
 * Phase 2 Task 10 — the ONE canonical daily-log read serializer, shared by the live snapshot slice
 * ({@link DailyLogQueryService.snapshotSlice}) AND the rebuildable projection consumer, so the
 * projection-served slice is byte-identical to the live slice by construction.
 */

/** The daily-log-OWNED core of the DailyLog slice — the {@link DailyLogDto} WITHOUT its `photos`,
 *  which are progress MEDIA the snapshot composes (media is a separate module, not daily-log's to
 *  own). The snapshot re-attaches `photos: progressPhotos` onto this core, keeping the DTO identical. */
export type DailyLogCore = Omit<DailyLogDto, 'photos'>;

/** The full daily-log read slice: the LATEST log's photo-less core + every project material. Unlike
 *  the decisions slice, this carries NO per-viewer visibility — every viewer of the project sees the
 *  same daily-log slice — so there is nothing to filter at query time. */
export interface DailyLogSlice {
  dailyLog: DailyLogCore | null;
  materials: MaterialDto[];
}

/**
 * Read + serialize the daily-log slice from CANONICAL state through ANY Prisma client: the injected
 * service for a live read, or a projection apply/rebuild transaction. The LATEST daily log (crew +
 * its own materials) as the photo-less {@link DailyLogCore}, PLUS the project-wide site materials for
 * the Site Map's "materials here". Moved verbatim from the pre-projection snapshot read, so the slice
 * is unchanged; the snapshot adds the media-sourced progress photos onto the core.
 */
export async function computeDailyLogSlice(
  client: Prisma.TransactionClient,
  projectId: string,
): Promise<DailyLogSlice> {
  const [dailyLog, allMaterials] = await Promise.all([
    client.dailyLog.findFirst({
      where: { projectId },
      include: { crew: { orderBy: { order: 'asc' } }, materials: { orderBy: { order: 'asc' } } },
      // real civil day first (Task 6); creation instant is only the tie-breaker
      orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    }),
    // All materials across the project's daily logs (for the Site Map), not just the current day.
    client.siteMaterial.findMany({ where: { dailyLog: { projectId } }, orderBy: { order: 'asc' } }),
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
