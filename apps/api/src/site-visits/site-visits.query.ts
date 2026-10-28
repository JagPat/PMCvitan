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
  /** #1179 — the files taken off the visit, by when each was removed (by file id within a millisecond). A line never
   *  changes and stays as long as the visit. */
  removals: SiteVisitRemovalDto[];
}

/** #1179 — a file taken off a visit: what it was, who added it, who removed it, when and why. */
export interface SiteVisitRemovalDto {
  mediaId: string;
  kind: 'photo' | 'voice' | 'video' | 'file';
  addedByName: string;
  addedByRole: string;
  addedAt: string;
  removedById: string;
  removedByName: string;
  removedByRole: string;
  /** null when the person who added it removed it within the hour */
  reason: string | null;
  removedAt: string;
}

export interface SiteVisitFileDto {
  /** The stored file's id, and a short-lived signed path to it, resolved against the API base. */
  mediaId: string;
  url: string;
  mime: string;
  /** The uploading device's key for the file, sent only to the member who uploaded it (as the snapshot's photos): the
   *  phone that queued it knows its copy by it. Null for anyone else's file. */
  clientKey: string | null;
  /** When the device took it, if it said. */
  takenAt: string | null;
  /** A voice note's or a video clip's length in whole seconds; null for a photo (#482, #995). */
  durationSec: number | null;
  /** A marked-up copy's original, a file on the same visit (M3); null for a photo as taken. */
  sourceMediaId: string | null;
  /** A video clip's still frame, a short-lived signed path like `url`, once the recording phone has sent one; null
   *  otherwise (#995 V1b). */
  posterUrl: string | null;
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
  /** #1179 — whether the viewer may remove this file now, as the server's rule reads at this read: the PMC always (a
   *  reason needed unless it is their own within the hour), the person who added it until `until` while the visit is
   *  open (not ended or closed). Null when the viewer may not. The removal asks again and is the authority. */
  removable: { reasonRequired: boolean; until: string | null } | null;
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
  removals: { orderBy: [{ removedAt: 'asc' }, { mediaId: 'asc' }] },
} satisfies Prisma.SiteVisitInclude;

type Row = Prisma.SiteVisitGetPayload<{ include: typeof withChildren }>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What the media module says about a visit's file (`MediaQueryService.fileFacts`). */
type FileFacts = Map<string, { mime: string; takenAt: string | null; clientKey: string | null; durationSec: number | null; sourceMediaId: string | null; poster: boolean; cited: boolean }>;

/** #1179 — how long the person who added a file may remove it themselves (the database's CHECK on a line with no reason). */
export const SITE_VISIT_OWN_REMOVAL_MS = 60 * 60 * 1000;

/** Who reads a visit, for the per-file removal offer: their id and the role they act in on the project. */
export interface SiteVisitViewer {
  id: string;
  role: string;
}

function removableBy(
  viewer: SiteVisitViewer | undefined, status: string, addedById: string, addedAt: Date, now: number, cited: boolean,
): SiteVisitFileDto['removable'] {
  // a file another record cites as evidence is refused by the removal (409) for everyone (Codex 4397416732)
  if (!viewer || cited) return null;
  const until = addedAt.getTime() + SITE_VISIT_OWN_REMOVAL_MS;
  // inclusive at the hour, as the server judges it (`addedAt + 1 hour >= now` on the database's clock)
  const ownInHour = addedById === viewer.id && now <= until;
  // the PMC's own file within the hour: no reason until `until`, then a reason
  if (viewer.role === 'pmc') return { reasonRequired: !ownInHour, until: ownInHour ? new Date(until).toISOString() : null };
  if (ownInHour && status === 'open') return { reasonRequired: false, until: new Date(until).toISOString() };
  return null;
}

export function toSiteVisitDto(
  v: Row, fileUrl: (mediaId: string) => string, facts: FileFacts, posterUrl: (mediaId: string) => string,
  viewer?: SiteVisitViewer, now: number = Date.now(),
): SiteVisitDto {
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
    // a file the media module no longer has was removed after this visit was read (its line comes with the next read):
    // it is left out, never served as an empty file with a dead link and a removal offer (Codex 4398005586)
    files: v.media.filter((f) => facts.has(f.mediaId)).map((f) => ({
      mediaId: f.mediaId, url: fileUrl(f.mediaId), mime: facts.get(f.mediaId)?.mime ?? '', clientKey: facts.get(f.mediaId)?.clientKey ?? null,
      takenAt: facts.get(f.mediaId)?.takenAt ?? null, durationSec: facts.get(f.mediaId)?.durationSec ?? null,
      sourceMediaId: facts.get(f.mediaId)?.sourceMediaId ?? null, posterUrl: facts.get(f.mediaId)?.poster ? posterUrl(f.mediaId) : null,
      note: f.note, rating: f.rating, place: f.placeName !== '' ? { nodeId: f.nodeId, name: f.placeName } : null,
      addedById: f.addedById, addedByName: f.addedByName, addedByRole: f.addedByRole, addedAt: f.addedAt.toISOString(),
      removable: removableBy(viewer, v.status, f.addedById, f.addedAt, now, facts.get(f.mediaId)?.cited ?? false),
    })),
    removals: v.removals.map((r) => ({
      mediaId: r.mediaId, kind: r.fileKind as SiteVisitRemovalDto['kind'], addedByName: r.addedByName, addedByRole: r.addedByRole,
      addedAt: r.addedAt.toISOString(), removedById: r.removedById, removedByName: r.removedByName, removedByRole: r.removedByRole,
      reason: r.reason, removedAt: r.removedAt.toISOString(),
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

  /** `viewerId` is who reads: each file's upload key goes only to its own uploader (Codex 4324453890); with the role
   *  they act in, each file says whether they may remove it (#1179). */
  private async toDtos(projectId: string, rows: Row[], viewerId: string, viewerRole?: string): Promise<SiteVisitDto[]> {
    const facts = await this.media.fileFacts(projectId, rows.flatMap((r) => r.media.map((f) => f.mediaId)), viewerId);
    const viewer = viewerRole !== undefined ? { id: viewerId, role: viewerRole } : undefined;
    // the hour is judged on the database's clock, as the removal judges it (Codex 4397416735)
    const now = viewer && facts.size > 0
      ? (await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT site_visits_now() AS "now"`)[0]!.now.getTime()
      : Date.now();
    return rows.map((row) => toSiteVisitDto(row, (id) => this.signed.mediaPath(id), facts, (id) => this.signed.posterPath(id), viewer, now));
  }

  /**
   * A page of the project's visits, newest start first. `before` names the last visit of the previous page, so
   * every visit stays reachable however many the project has. `status: 'open'` keeps only the visits still open.
   */
  async list(projectId: string, page: { before?: string; limit?: number; status?: 'open' }, viewerId: string, viewerRole?: string): Promise<SiteVisitDto[]> {
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
    return this.toDtos(projectId, rows, viewerId, viewerRole);
  }

  async get(projectId: string, visitId: string, viewerId: string, viewerRole?: string): Promise<SiteVisitDto> {
    const row = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId }, include: withChildren });
    if (!row) throw new NotFoundException('Site visit not found');
    const [dto] = await this.toDtos(projectId, [row], viewerId, viewerRole);
    return dto!;
  }
}
