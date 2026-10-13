import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/** Q6: a device fix whose accuracy is worse than this is labelled "approximate" when read. */
export const APPROXIMATE_ACCURACY_M = 100;

/** A site visit as the project's members read it (SV1-b). Every time is the ACCEPTED time; `adjusted` says the
 *  device's claim was replaced by the server's receipt (SV1-a, V3). */
export interface SiteVisitDto {
  id: string;
  visitorId: string;
  visitorName: string;
  visitorRole: string;
  status: 'open' | 'ended' | 'closed';
  startedAt: string;
  startTimeAdjusted: boolean;
  /** The place the visit started at, with the name it had then; `nodeId` is null once that place was removed. */
  startPlace: { nodeId: string | null; name: string } | null;
  location:
    | { kind: 'none' }
    | { kind: 'device'; lat: number; lng: number; accuracyM: number; at: string; approximate: boolean };
  endedAt: string | null;
  endTimeAdjusted: boolean | null;
  closedAt: string | null;
  closedById: string | null;
  closeReason: string | null;
  /** The visitor's end, recorded after a PMC closed the visit. */
  lateEndedAt: string | null;
}

type Row = Prisma.SiteVisitGetPayload<Record<string, never>>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toSiteVisitDto(v: Row): SiteVisitDto {
  const device = v.locationKind === 'device' && v.locLat !== null && v.locLng !== null && v.locAccuracyM !== null && v.locAt !== null;
  return {
    id: v.id,
    visitorId: v.visitorId,
    visitorName: v.visitorName,
    visitorRole: v.visitorRole,
    status: v.status as SiteVisitDto['status'],
    startedAt: v.startedAt.toISOString(),
    startTimeAdjusted: v.startTimeAdjusted,
    startPlace: v.startPlaceName !== null ? { nodeId: v.startNodeId, name: v.startPlaceName } : null,
    location: device
      ? { kind: 'device', lat: v.locLat!, lng: v.locLng!, accuracyM: v.locAccuracyM!, at: v.locAt!.toISOString(), approximate: v.locAccuracyM! > APPROXIMATE_ACCURACY_M }
      : { kind: 'none' },
    endedAt: iso(v.endedAt),
    endTimeAdjusted: v.endTimeAdjusted,
    closedAt: iso(v.closedAt),
    closedById: v.closedById,
    closeReason: v.closeReason,
    lateEndedAt: iso(v.lateEndedAt),
  };
}

/** The module-owned read of a project's visits. Every member of the project reads them (D1). */
@Injectable()
export class SiteVisitsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The project's latest visits, newest start first. */
  async list(projectId: string, limit = 50): Promise<SiteVisitDto[]> {
    const rows = await this.prisma.siteVisit.findMany({
      where: { projectId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toSiteVisitDto);
  }

  async get(projectId: string, visitId: string): Promise<SiteVisitDto> {
    const row = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId } });
    if (!row) throw new NotFoundException('Site visit not found');
    return toSiteVisitDto(row);
  }
}
