import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { toIsoCivilDate } from '../common/civil-date';
import { ActivitiesQueryService } from '../activities/activities.query';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DailyLogQueryService } from '../daily-log/daily-log.query';
import { DrawingsQueryService } from '../drawings/drawings.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { SignedUrlService } from '../media/signed-url.service';
import { isPendingDecisionNotice } from '../domain/notifications';
import { ddMmmYyyy } from '../domain/dates';
import type { Role } from '../common/auth';
import type { ProjectShellCounts, SnapshotDto } from './types';

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
  ) {}

  /**
   * Phase 2 Task 9 — the PROJECT-SHELL summary: project identity + module-driven projection counts,
   * the light payload the app loads FIRST (before the full data) so the shell + nav render immediately.
   * `enabledModules` is supplied by the caller (the module registry — the single enablement source).
   * The `pendingDecisions` count is served from the decisions projection with the SAME role authz as
   * the snapshot (non-pmc/client see 0), so the nav badge is projection-driven, never an RBAC bypass.
   */
  async shellSummary(projectId: string, role: Role, userId?: string): Promise<ProjectShellCounts> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, descriptor: true, stage: true, siteCode: true, org: { select: { id: true, name: true } } },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    const decisions = await this.decisionsQuery.projectionSlice(projectId, role, userId);
    const pendingDecisions = decisions.decisions.filter((d) => d.status === 'pending' && !d.draft).length;
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

  /** Build the full project snapshot the frontend hydrates its store from.
   *  Permission-filtered: only PMC & client see pending decisions; every other
   *  role (contractor, engineer, worker) is restricted to decided ones. */
  async build(projectId: string, role: Role, userId?: string): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Task 8 — the decisions slice comes from the module's query (role-filtered DTOs + an
    // id→status map for readiness), not a direct `prisma.decision` read.
    const decisionSlicePromise = this.decisionsQuery.snapshotSlice(projectId, role, userId);
    const [decisionSlice, activitySlices, inspectionSlices, dailyLogSlice, notifications, siteMedia, drawingDtos, companies, nodes] = await Promise.all([
      decisionSlicePromise,
      // Task 10 (Module 4) — the activity spine (`activities` + `phases`) comes from the activities
      // module's query, never a direct `prisma.activity`/`gateOverride`/`prisma.phase` read. It bakes
      // each activity's five-gate readiness FRESH through the decisions/inspections/drawings query
      // contracts; the snapshot chains its already-fetched id→status decision map in so the decision
      // read never happens twice (identical data — the bake result cannot differ).
      decisionSlicePromise.then((s) => this.activitiesQuery.snapshotSlice(projectId, { decisionStatuses: s.statuses })),
      // Task 10 (Module 3) — the five role-gated inspection slices come from the module's query (the same
      // per-viewer/role serialization moved there verbatim, so byte-identical), never a direct read.
      this.inspectionsQuery.snapshotSlice(projectId, role),
      // Task 10 — the daily-log slice (latest log core + project-wide materials) comes from the
      // module's query, never a direct `prisma.dailyLog`/`prisma.siteMaterial` read. The progress
      // PHOTOS remain the snapshot's to compose from media (below), so the DTO stays byte-identical.
      this.dailyLogQuery.snapshotSlice(projectId),
      this.prisma.notification.findMany({ where: { projectId }, orderBy: { at: 'desc' } }),
      // Site-reality photos for the daily-log gallery AND the Place view. One query,
      // capped, newest first; carries nodeId so a photo can be shown at its location.
      this.prisma.media.findMany({
        where: { projectId, kind: { in: ['progress', 'inspection', 'material'] } },
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, kind: true, url: true, takenAt: true, nodeId: true },
      }),
      // Task 10 — the drawings register comes from the module's query (the baked per-viewer register:
      // draft-author visibility + the viewer's ack/recipient state + fresh signed urls), never a direct
      // `prisma.drawing` read. Byte-identical to the pre-extraction inline shaping.
      this.drawingsQuery.snapshotSlice(projectId, userId),
      this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.projectNode.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
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
    const photoDtos = siteMedia.map((m) => ({
      id: m.id,
      url: this.signed.mediaPath(m.id),
      takenAt: m.takenAt ?? undefined,
      nodeId: m.nodeId ?? undefined,
      kind: m.kind,
    }));

    // Task 8 — the role-filtered decision DTOs come from the decisions query (the serialization moved
    // there verbatim, so this slice is byte-identical).
    const decisionDtos = decisionSlice.decisions;
    // pmc/client see pending decisions; every other role has them hidden — the same predicate also
    // drops the pending-decision notice from the bell for those roles (AUTH-02, below).
    const hidePending = role !== 'pmc' && role !== 'client';

    // Task 10 (Module 4) — the activity spine (`activities` + `phases`, `activitySlices` above) is served
    // by the activities module's query, which bakes the SAME serialization the inline shaping used to:
    // per-activity five-gate readiness derived fresh (decision status map + inspection/drawing readiness
    // inputs + active members + unexpired overrides at `now`), the stored→wire status remap, the ACTIVE
    // override list for the UI, and the phase rollups computed from the baked activities — byte-identical.

    // Task 10 (Module 3) — the five role-gated inspection slices (`checklist`, `reviews`, `review`,
    // `reinspectionCreated`, `placedInspections`) come from `inspectionSlices` (the inspections module's
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
      drawings: drawingDtos,
      phases: activitySlices.phases,
      // Task 10 — the daily-log core comes from the module query (byte-identical); the snapshot
      // composes the media-sourced progress photos onto it (media is not daily-log's to own).
      dailyLog: dailyLogSlice.dailyLog ? { ...dailyLogSlice.dailyLog, photos: progressPhotos } : null,
      // AUTH-02: a pending-decision notice ("Decision awaiting approval: …") is
      // pmc/client-only — drop it from the feed for roles that have pending decisions
      // hidden, so a decision's title can't leak through the bell.
      notifications: notifications
        .filter((n) => !(hidePending && isPendingDecisionNotice(n.text)))
        .map((n) => ({ text: n.text, time: n.time, color: n.color })),
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
