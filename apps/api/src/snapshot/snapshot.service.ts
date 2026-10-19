import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { toIsoCivilDate } from '../common/civil-date';
import { ActivitiesQueryService } from '../activities/activities.query';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DailyLogQueryService } from '../daily-log/daily-log.query';
import { DrawingsQueryService } from '../drawings/drawings.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { SignedUrlService } from '../media/signed-url.service';
import { SNAPSHOT_SITE_PHOTO_LIMIT } from '@vitan/shared';
import { ddMmmYyyy } from '../domain/dates';
import type { Role } from '../common/auth';
import type { DecisionsContract } from '../common/decisions-contract';
import type { ProjectShellCounts, SnapshotDto } from './types';
import { readViewerFeed, servedNotifications } from './served-notifications';
import { hiddenDraftNodeIds } from '../nodes/node-scope';
import { hiddenMediaIds, mediaOnNodes } from './hidden-media';
import { OrgsParticipant } from '../orgs/orgs.participant';

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
    // Task 8 — decisions are read through their module's query, never `prisma.decision` here.
    private readonly decisionsQuery: DecisionsQueryService,
    // Task 10 — the daily-log slice + project materials come from the daily-log module's query.
    private readonly dailyLogQuery: DailyLogQueryService,
    // Task 10 — the drawings register + the drawing-gate readiness input come from the drawings query.
    private readonly drawingsQuery: DrawingsQueryService,
    // Task 10 (Module 3) — the five inspection slices + the inspection-gate readiness input come from the
    // inspections module's query, never a direct `prisma.inspection` read.
    private readonly inspectionsQuery: InspectionsQueryService,
    // Task 10 (Module 4) — the activity spine (`activities` + `phases`, with readiness baked fresh)
    // comes from the activities module's query, never a direct `prisma.activity`/`gateOverride`/
    // `prisma.phase` read.
    private readonly activitiesQuery: ActivitiesQueryService,
    // #482 site photos — who added a photo, and their role here, is an orgs answer (platform → orgs participant).
    private readonly orgs: OrgsParticipant,
  ) {}

  /**
   * Phase 2 Task 9 — the PROJECT-SHELL summary: project identity + module-driven projection counts,
   * the light payload the app loads FIRST (before the full data) so the shell + nav render immediately.
   * `enabledModules` is supplied by the caller (the module registry — the single enablement source).
   * The `pendingDecisions` count is served from the decisions projection with the SAME role authz as
   * the snapshot (non-pmc/client see 0), so the nav badge is projection-driven, never an RBAC bypass.
   */
  async shellSummary(projectId: string, role: Role, userId?: string, contract?: DecisionsContract): Promise<ProjectShellCounts> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, descriptor: true, stage: true, siteCode: true, org: { select: { id: true, name: true } } },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    // Task 10 finalization — the shell count uses the projection-OR-LIVE module read: with the
    // decisions projection now servability-gated (readServableGeneration), a lagging/blocked
    // generation must fall back to the always-current live slice rather than serving zero counts.
    const decisions = await this.decisionsQuery.moduleDecisions(projectId, role, userId);
    // Phase 6 task 4d (§A.1) — the badge is the decisions module's `countPending`, the SAME count the
    // Portfolio tile shows: the published decisions awaiting THIS viewer, countersign obligations
    // included (#561's review round 1, finding 6: the shell used to count visible pending rows itself)
    const pendingDecisions = await this.decisionsQuery.countPending(projectId, { role, userId, contract });
    return {
      id: project.id,
      name: project.name,
      descriptor: project.descriptor,
      stage: project.stage,
      siteCode: project.siteCode,
      org: project.org ? { id: project.org.id, name: project.org.name } : null,
      counts: { pendingDecisions, decisionsGeneration: decisions.generation },
    };
  }

  /** #884 — the photos hidden from `viewerId` (on someone else's private draft place), for a module read the
   *  read side serves outside the snapshot (`GET …/inspections`): handed in, never read by that module. */
  hiddenMediaFor(projectId: string, viewerId: string): Promise<ReadonlySet<string>> {
    return hiddenMediaIds(this.prisma, projectId, viewerId);
  }

  /** Build the full project snapshot the frontend hydrates its store from.
   *  Permission-filtered: only PMC & client see pending decisions; every other
   *  role (contractor, engineer, worker) is restricted to decided ones. */
  async build(projectId: string, role: Role, userId?: string): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Task 8 — the decisions slice comes from the module's query (role-filtered DTOs + an
    // id→status map for readiness), not a direct `prisma.decision` read.
    //
    // Phase 6 task 4d-ii-a / A4c — the slice and the notification feed are read in ONE REPEATABLE
    // READ transaction (Top 10 #4b unit B: through the shared `readViewerFeed`), so a kinded notice is
    // judged against the decision slice of the same snapshot.
    const feedSnapshot = readViewerFeed(this.prisma, this.decisionsQuery, projectId, role, userId);
    const decisionSlicePromise = feedSnapshot.then((f) => f.slice);
    // #884 — the viewer's hidden drafts (someone else's private places), read once: their photos leave the
    // photo layer, and inspection evidence on them gets no signed path.
    const hiddenNodes = hiddenDraftNodeIds(this.prisma, projectId, userId);
    // #482 site photos unit 3 — the day's photo count (`photoCount`) is the larger of the count the sender saw
    // (`progress`, written at the send by every app and API release) and the progress photos filed on the log
    // (Media.dailyLogId: every member's, including ones added after the send). The server never files a photo
    // itself, and never by a time window. `myPhotoKeys` are the upload keys of the viewer's own photos filed on it,
    // so a client can tell which of its queued or in-flight uploads the count already holds.
    const dailyLogSlicePromise = this.dailyLogQuery.snapshotSlice(projectId);
    const photoCountOfLog = dailyLogSlicePromise.then(async (slice) => {
      const log = slice.dailyLog;
      if (!log?.id) return null;
      const id = log.id;
      // One statement, so the count and the viewer's keys come from the same database snapshot: an upload that
      // commits meanwhile is either in both or in neither, never counted without its key.
      const filed = await this.prisma.media.findMany({
        where: { projectId, dailyLogId: id, kind: 'progress' },
        select: { uploadedBy: true, clientKey: true },
      });
      const myPhotoKeys = filed.flatMap((m) => (m.uploadedBy === userId && m.clientKey ? [m.clientKey] : []));
      return { photoCount: Math.max(log.progress, filed.length), myPhotoKeys };
    });
    const [decisionSlice, activitySlices, inspectionSlices, dailyLogSlice, viewerFeed, siteMedia, drawingDtos, companies, nodes, logPhotos] = await Promise.all([
      decisionSlicePromise,
      // Task 10 (Module 4) — the activity spine (`activities` + `phases`) comes from the activities
      // module's query, never a direct `prisma.activity`/`gateOverride`/`prisma.phase` read. It bakes
      // each activity's five-gate readiness FRESH through the decisions/inspections/drawings query
      // contracts; the snapshot chains its already-fetched id→status decision map in so the decision
      // read never happens twice (identical data — the bake result cannot differ).
      decisionSlicePromise.then((s) => this.activitiesQuery.snapshotSlice(projectId, { decisionStatuses: s.statuses, decisionDrafts: s.drafts, decisionDeciders: s.deciders, withdrawnReasonVisible: role === 'pmc' })),
      // Task 10 (Module 3) — the role-gated inspection slices come from the module's query (the same
      // per-viewer/role serialization moved there verbatim, so byte-identical), never a direct read.
      hiddenNodes.then((ids) => mediaOnNodes(this.prisma, projectId, ids)).then((hidden) => this.inspectionsQuery.snapshotSlice(projectId, role, userId, hidden)),
      // Task 10 — the daily-log slice (latest log core + project-wide materials) comes from the
      // module's query, never a direct `prisma.dailyLog`/`prisma.siteMaterial` read. The progress
      // PHOTOS remain the snapshot's to compose from media (below), so the DTO stays byte-identical.
      dailyLogSlicePromise,
      feedSnapshot,
      // Site-reality photos for the daily-log gallery AND the Place view. One query,
      // capped, newest first; carries nodeId so a photo can be shown at its location. A photo filed
      // on someone else's private draft (before #881) is as private as the place: the nodes module
      // names the viewer's hidden drafts, and their photos are left out (unfiled photos stay).
      hiddenNodes.then((hidden) =>
        this.prisma.media.findMany({
          where: { projectId, kind: { in: ['progress', 'inspection', 'material'] }, ...(hidden.length > 0 ? { OR: [{ nodeId: null }, { nodeId: { notIn: hidden } }] } : {}) },
          orderBy: { createdAt: 'desc' },
          take: SNAPSHOT_SITE_PHOTO_LIMIT,
          select: { id: true, kind: true, url: true, takenAt: true, nodeId: true, uploadedBy: true, clientKey: true, createdAt: true },
        }),
      ),
      // Task 10 — the drawings register comes from the module's query (the baked per-viewer register:
      // draft-author visibility + the viewer's ack/recipient state + fresh signed urls), never a direct
      // `prisma.drawing` read. Byte-identical to the pre-extraction inline shaping.
      this.drawingsQuery.snapshotSlice(projectId, userId),
      this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.projectNode.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
      photoCountOfLog,
    ]);

    // Private delivery: a short-lived signed serve path (never a public bucket URL). Only
    // a caller authorized to see this snapshot gets a token, and it expires quickly.
    // The daily-log gallery keeps the newest 12 progress photos, unchanged.
    const progressPhotos = siteMedia
      .filter((m) => m.kind === 'progress')
      .slice(0, 12)
      .map((m) => ({ id: m.id, url: this.signed.mediaPath(m.id), takenAt: m.takenAt ?? undefined }));
    // The location spine's "reality" layer: every site photo with its place tag, so the
    // Place view can show a location's photos beside its drawings and decisions.
    // #482 site photos — each photo says who added it, their role on this project and when. The name and role
    // are read now, for the photo window's uploaders only; a removed member keeps the role they had.
    // Orgs owns who is tied to this project, so it answers: anyone else's id names no one.
    const uploader = await this.orgs.projectUploaders(this.prisma, projectId, [...new Set(siteMedia.map((m) => m.uploadedBy))]);
    const photoDtos = siteMedia.map((m) => ({
      id: m.id,
      url: this.signed.mediaPath(m.id),
      takenAt: m.takenAt ?? undefined,
      nodeId: m.nodeId ?? undefined,
      kind: m.kind,
      by: uploader.get(m.uploadedBy)?.name,
      byRole: uploader.get(m.uploadedBy)?.role,
      at: m.createdAt.toISOString(),
      // #482 site photos — the viewer's own upload key, so a device that still holds this photo in its offline queue
      // (its reply was lost) shows it once; nobody else's key is sent
      ...(userId && m.uploadedBy === userId && m.clientKey ? { clientKey: m.clientKey } : {}),
    }));

    // Task 8 — the role-filtered decision DTOs come from the decisions query (the serialization moved
    // there verbatim, so this slice is byte-identical).
    const decisionDtos = decisionSlice.decisions;
    // Task 10 (Module 4) — the activity spine (`activities` + `phases`, `activitySlices` above) is served
    // by the activities module's query, which bakes the SAME serialization the inline shaping used to:
    // per-activity five-gate readiness derived fresh (decision status map + inspection/drawing readiness
    // inputs + active members + unexpired overrides at `now`), the stored→wire status remap, the ACTIVE
    // override list for the UI, and the phase rollups computed from the baked activities — byte-identical.

    // Task 10 (Module 3) — the role-gated inspection slices (`checklist`, `openChecklists`, `reviews`,
    // `review`, `reinspectionCreated`, `placedInspections`) come from `inspectionSlices` (the inspections module's
    // query, destructured above), which bakes the SAME per-viewer/role serialization the inline shaping
    // used to: the engineer's current checklist (all roles), the PMC review queue (pmc only), and the
    // Site-Map placement (pmc/engineer), each item's evidence as fresh signed serve paths — byte-identical.

    // Task 10 — the drawings register (`drawingDtos`) is served from the drawings module's query
    // (`this.drawingsQuery.snapshotSlice`, destructured above), which bakes the same per-viewer register
    // the inline shaping used to: draft-author visibility, the governing revision, the viewer's
    // ackedByMe/recipientOfCurrent, and each revision's fresh short-lived signed url — byte-identical.

    return {
      project: {
        id: project.id,
        name: project.name,
        short: project.short,
        descriptor: project.descriptor,
        stage: project.stage,
        siteCode: project.siteCode,
        location: project.location,
        projStart: project.projStart,
        projEnd: project.projEnd,
        scheduleStartDate: toIsoCivilDate(project.scheduleStartDate),
        scheduleEndDate: toIsoCivilDate(project.scheduleEndDate),
        timeZone: project.timeZone,
        elapsedPct: project.elapsedPct,
        todayDay: project.todayDay,
        milestonePct: project.milestonePct,
      },
      decisions: decisionDtos,
      activities: activitySlices.activities,
      placedInspections: inspectionSlices.placedInspections,
      reviews: inspectionSlices.reviews,
      review: inspectionSlices.review, // deprecated single (first pending) — back-compat
      reinspectionCreated: inspectionSlices.reinspectionCreated,
      checklist: inspectionSlices.checklist,
      openChecklists: inspectionSlices.openChecklists,
      drawings: drawingDtos,
      phases: activitySlices.phases,
      // Task 10 — the daily-log core comes from the module query (byte-identical); the snapshot
      // composes the media-sourced progress photos onto it (media is not daily-log's to own).
      dailyLog: dailyLogSlice.dailyLog
        ? { ...dailyLogSlice.dailyLog, photos: progressPhotos, photoCount: logPhotos?.photoCount ?? dailyLogSlice.dailyLog.progress, myPhotoKeys: logPhotos?.myPhotoKeys ?? [] }
        : null,
      // Top 10 #4b unit B — the notices this viewer is served, by the one shared definition
      // (`served-notifications.ts`: AUTH-02's pending strip, the decider audience, the pmc-only
      // withdrawal, kinded rendering against the slice read in the same snapshot, and the subject keys)
      notifications: servedNotifications(viewerFeed, role, userId, this.decisionsQuery),
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        contactName: c.contactName ?? '',
        contactEmail: c.contactEmail ?? '',
        contactPhone: c.contactPhone ?? '',
        notes: c.notes ?? '',
      })),
      // The project location tree (zones → rooms → elements) the register groups by.
      // Draft → Publish: an unpublished location is author-private — delivered only to its
      // creator, hidden from the team's Site Map and the filing pickers until published.
      nodes: nodes
        .filter((n) => n.publishedAt !== null || (Boolean(userId) && n.authorId === userId))
        .map((n) => ({ id: n.id, parentId: n.parentId ?? null, name: n.name, kind: n.kind as 'zone' | 'room' | 'element', order: n.order, draft: n.publishedAt === null })),
      // The location spine's reality layer: placed (and unplaced) site photos for the Place view.
      photos: photoDtos,
      // All materials delivered across the project, with their place — the Site Map's "materials
      // here" (Task 10 — served by the daily-log module query, not a direct `siteMaterial` read).
      materials: dailyLogSlice.materials,
    };
  }
}
