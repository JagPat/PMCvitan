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
  /** Whether the late end was recorded at its receipt instead of its claimed time; null when there is no late end. */
  lateEndTimeAdjusted: boolean | null;
  /** The places walked, by when the server took each add (to the millisecond; adds in one millisecond by id); a retired
   *  row stays, marked with when it was retired. */
  places: SiteVisitPlaceDto[];
  /** The people with the visitor, by when the server took each add (to the millisecond; adds in one millisecond by
   *  id); a retired row stays, marked with when it was retired. */
  attendees: SiteVisitAttendeeDto[];
}

export interface SiteVisitPlaceDto {
  id: string;
  /** null once the place was removed from the project; the name stays as it was when added. */
  nodeId: string | null;
  name: string;
  addedAt: string;
  addedTimeAdjusted: boolean;
  /** Added after the visitor ended the visit, so recorded at its receipt. */
  addedAfterEnd: boolean;
  retiredAt: string | null;
}

export interface SiteVisitAttendeeDto {
  id: string;
  /** A project member (with the role they attended in) or a guest named by the visitor. */
  kind: 'member' | 'guest';
  userId: string | null;
  role: string | null;
  /** The member's account name when added, or the guest's name. */
  name: string;
  addedAt: string;
  retiredAt: string | null;
}

const withChildren = {
  places: { orderBy: [{ addedReceivedAt: 'asc' }, { id: 'asc' }] },
  attendees: { orderBy: [{ addedAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.SiteVisitInclude;

type Row = Prisma.SiteVisitGetPayload<{ include: typeof withChildren }>;

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
    lateEndTimeAdjusted: v.lateEndTimeAdjusted,
    places: v.places.map((p) => ({
      id: p.id, nodeId: p.nodeId, name: p.placeName, addedAt: p.addedAt.toISOString(), addedTimeAdjusted: p.addedTimeAdjusted,
      addedAfterEnd: p.addedAfterEnd, retiredAt: iso(p.retiredAt),
    })),
    attendees: v.attendees.map((a) => ({
      id: a.id, kind: a.userId !== null ? 'member' : 'guest', userId: a.userId, role: a.role, name: a.displayName,
      addedAt: a.addedAt.toISOString(), retiredAt: iso(a.retiredAt),
    })),
  };
}

/** The module-owned read of a project's visits. Every member of the project reads them (D1). */
@Injectable()
export class SiteVisitsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A page of the project's visits, newest start first. `before` names the last visit of the previous page, so
   * every visit stays reachable however many the project has. `status: 'open'` keeps only the visits still open.
   */
  async list(projectId: string, page: { before?: string; limit?: number; status?: 'open' } = {}): Promise<SiteVisitDto[]> {
    // The page boundary is the anchor's place in the order (start, then id), not the anchor row itself: under
    // `status: 'open'` the anchor may have ended since the previous page, and a cursor on a row the filter now
    // drops would return an empty page, hiding the older open visits.
    let boundary: { startedAt: Date; id: string } | undefined;
    if (page.before !== undefined) {
      const anchor = await this.prisma.siteVisit.findFirst({
        where: { projectId, id: page.before },
        select: { id: true, startedAt: true },
      });
      if (!anchor) throw new NotFoundException('Site visit not found');
      boundary = anchor;
    }
    const rows = await this.prisma.siteVisit.findMany({
      where: {
        projectId,
        ...(page.status ? { status: page.status } : {}),
        ...(boundary
          ? {
              OR: [
                { startedAt: { lt: boundary.startedAt } },
                { startedAt: boundary.startedAt, id: { lt: boundary.id } },
              ],
            }
          : {}),
      },
      include: withChildren,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: page.limit ?? 50,
    });
    return rows.map(toSiteVisitDto);
  }

  async get(projectId: string, visitId: string): Promise<SiteVisitDto> {
    const row = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId }, include: withChildren });
    if (!row) throw new NotFoundException('Site visit not found');
    return toSiteVisitDto(row);
  }
}
