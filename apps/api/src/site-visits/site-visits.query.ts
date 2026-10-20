import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SignedUrlService } from '../media/signed-url.service';
import { MediaQueryService } from '../media/media.query';

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
  /** The files added on the visit (#792 SV2), by when the server took each (by file id within a millisecond). */
  files: SiteVisitFileDto[];
}

export interface SiteVisitFileDto {
  /** The stored file's id, and a short-lived signed path to it, resolved against the API base. */
  mediaId: string;
  url: string;
  mime: string;
  /** The uploading device's key for the file, if it sent one: the phone that queued it knows its copy by it. */
  clientKey: string | null;
  /** When the device took it, if it said. */
  takenAt: string | null;
  note: string | null;
  rating: 'fine' | 'concern' | 'action_needed' | null;
  /** The place the file showed when it was added, with the name it had then; `nodeId` is null once that place was
   *  removed, and both are empty when it showed no place. */
  place: { nodeId: string | null; name: string } | null;
  /** Who added it, with the name and role they had then. */
  addedById: string;
  addedByName: string;
  addedByRole: string;
  addedAt: string;
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
  media: { orderBy: [{ addedAt: 'asc' }, { mediaId: 'asc' }] },
} satisfies Prisma.SiteVisitInclude;

type Row = Prisma.SiteVisitGetPayload<{ include: typeof withChildren }>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What the media module says about a visit's file (`MediaQueryService.fileFacts`). */
type FileFacts = Map<string, { mime: string; takenAt: string | null; clientKey: string | null }>;

export function toSiteVisitDto(v: Row, fileUrl: (mediaId: string) => string, facts: FileFacts): SiteVisitDto {
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
    // a linked file always exists (the link is frozen and the file's delete is refused); the fallback is only types
    files: v.media.map((f) => ({
      mediaId: f.mediaId, url: fileUrl(f.mediaId), mime: facts.get(f.mediaId)?.mime ?? '', clientKey: facts.get(f.mediaId)?.clientKey ?? null,
      takenAt: facts.get(f.mediaId)?.takenAt ?? null,
      note: f.note, rating: f.rating, place: f.placeName !== '' ? { nodeId: f.nodeId, name: f.placeName } : null,
      addedById: f.addedById, addedByName: f.addedByName, addedByRole: f.addedByRole, addedAt: f.addedAt.toISOString(),
    })),
  };
}

/** The module-owned read of a project's visits. Every member of the project reads them (D1). */
@Injectable()
export class SiteVisitsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    // #792 SV2 — a visit's files are served through the media module's signed paths, as an inspection's evidence is
    private readonly signed: SignedUrlService,
    // ... and each file's type and taken time come from the media module's query contract, not its table
    private readonly media: MediaQueryService,
  ) {}

  private async toDtos(projectId: string, rows: Row[]): Promise<SiteVisitDto[]> {
    const facts = await this.media.fileFacts(projectId, rows.flatMap((r) => r.media.map((f) => f.mediaId)));
    return rows.map((row) => toSiteVisitDto(row, (id) => this.signed.mediaPath(id), facts));
  }

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
    return this.toDtos(projectId, rows);
  }

  async get(projectId: string, visitId: string): Promise<SiteVisitDto> {
    const row = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId }, include: withChildren });
    if (!row) throw new NotFoundException('Site visit not found');
    const [dto] = await this.toDtos(projectId, [row]);
    return dto!;
  }
}
