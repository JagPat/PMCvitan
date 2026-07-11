import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SignedUrlService } from '../media/signed-url.service';
import { isPendingDecisionNotice } from '../domain/notifications';
import { ddMmmYyyy } from '../domain/dates';
import type { Role } from '../common/auth';
import type { ActivityDto, DecisionDto, PhaseDto, SnapshotDto } from './types';

const ACTIVITY_STATUS_OUT: Record<string, ActivityDto['status']> = {
  not_started: 'not-started',
  in_progress: 'in-progress',
  done: 'done',
  blocked: 'blocked',
};

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Build the full project snapshot the frontend hydrates its store from.
   *  Permission-filtered: only PMC & client see pending decisions; every other
   *  role (contractor, engineer, worker) is restricted to decided ones. */
  async build(projectId: string, role: Role, userId?: string): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const [decisions, activities, inspections, dailyLog, notifications, siteMedia, drawings, phases, companies, nodes, allMaterials] = await Promise.all([
      this.prisma.decision.findMany({
        where: { projectId },
        include: { options: { orderBy: { order: 'asc' } } },
        orderBy: { id: 'desc' },
      }),
      this.prisma.activity.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      this.prisma.inspection.findMany({ where: { projectId }, include: { items: { orderBy: { order: 'asc' } } } }),
      this.prisma.dailyLog.findFirst({
        where: { projectId },
        include: { crew: { orderBy: { order: 'asc' } }, materials: { orderBy: { order: 'asc' } } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.notification.findMany({ where: { projectId }, orderBy: { at: 'desc' } }),
      // Site-reality photos for the daily-log gallery AND the Place view. One query,
      // capped, newest first; carries nodeId so a photo can be shown at its location.
      this.prisma.media.findMany({
        where: { projectId, kind: { in: ['progress', 'inspection', 'material'] } },
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, kind: true, url: true, takenAt: true, nodeId: true },
      }),
      this.prisma.drawing.findMany({
        where: { projectId },
        include: { revisions: { orderBy: { createdAt: 'desc' }, include: { acks: { orderBy: { at: 'asc' } } } } },
        orderBy: [{ discipline: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.projectNode.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
      // All materials across the project's daily logs (for the Site Map's "materials here"),
      // not just the current day. Same visibility as the daily-log materials.
      this.prisma.siteMaterial.findMany({ where: { dailyLog: { projectId } }, orderBy: { order: 'asc' } }),
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

    const hidePending = role !== 'pmc' && role !== 'client';
    const decisionDtos: DecisionDto[] = decisions
      .filter((d) => {
        // Draft → Publish: an unpublished decision is author-private — it is delivered ONLY
        // to its creator, never to the client or anyone else. Enforced here (server-side),
        // not merely hidden in the UI, so a draft's title can't leak through any surface.
        if (d.publishedAt === null) return !!userId && d.authorId === userId;
        // AUTH-02: only pmc/client see published-but-pending decisions.
        return !(hidePending && d.status === 'pending');
      })
      .map((d) => ({
        id: d.id,
        title: d.title,
        room: d.room,
        nodeId: d.nodeId ?? undefined,
        status: d.status,
        draft: d.publishedAt === null,
        ageDays: d.ageDays ?? undefined,
        photoSwatch: d.photoSwatch,
        approvedOption: d.approvedOption ?? undefined,
        material: d.material ?? undefined,
        approver: d.approver ?? undefined,
        date: d.date ?? undefined,
        cost: d.cost ?? undefined,
        options: d.options.map((o) => ({
          label: o.label,
          key: o.optionKey,
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
          photoUrl: o.photoUrl ?? undefined,
          recommended: o.recommended,
        })),
      }));

    const activityDtos: ActivityDto[] = activities.map((a) => ({
      id: a.id,
      name: a.name,
      zone: a.zone,
      decisionId: a.decisionId,
      phaseId: a.phaseId,
      nodeId: a.nodeId ?? undefined, // location spine: where this work happens

      ps: a.plannedStart,
      pe: a.plannedEnd,
      as: a.actualStart,
      ae: a.actualEnd,
      status: ACTIVITY_STATUS_OUT[a.status],
      gm: a.gateMaterial,
      gt: a.gateTeam,
      gi: a.gateInspection,
      block: a.block ?? undefined,
    }));

    // The engineer keeps seeing their checklist (as "submitted ✓") after they send
    // it; it ALSO enters the PMC review queue below — two role-views of one inspection.
    // The engineer's CURRENT checklist: prefer an open (unsubmitted) one — a freshly
    // issued checklist supersedes an already-submitted earlier one in the field view.
    const checklistRow = inspections.find((i) => i.kind === 'checklist' && !i.submitted) ?? inspections.find((i) => i.kind === 'checklist');
    // The review queue: any submitted-but-undecided inspection, whatever its kind
    // (a submitted checklist, the seeded review, an auto-created closing inspection).
    // A checklist item's pass/fail/na `state` maps to a review PASS/FAIL result.
    // AUTH-02: the queue is the PMC's internal sign-off surface — it is serialized
    // ONLY for the pmc role; clients/contractors/engineers get an empty list, so
    // hiding the screen in the UI is backed by the API response itself.
    const isPmc = role === 'pmc';
    const reviews = inspections
      .filter((i) => i.submitted && !i.decided)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({
        id: i.id,
        title: i.title,
        zone: i.zone,
        nodeId: i.nodeId ?? undefined, // location spine: where this check happens
        by: i.by ?? '',
        date: i.date,
        decided: i.decided,
        items: i.items.map((it) => ({
          name: it.name,
          result: (it.result ?? (it.state === 'fail' ? 'FAIL' : 'PASS')) as 'PASS' | 'FAIL',
          swatch: it.swatch ?? 'concrete',
          note: it.note,
          rejected: it.rejected,
        })),
      }));
    // any inspection already decided with a rejected/failed item ⇒ re-inspection exists
    const reinspectionCreated = inspections.some(
      (i) => i.decided && i.items.some((it) => it.rejected || it.result === 'FAIL'),
    );

    // Drawings register: each entry with its full revision history (newest first)
    // and the current (latest non-superseded) revision the field builds from.
    const drawingDtos = drawings.map((d) => {
      const revs = d.revisions.map((r) => ({
        id: r.id,
        rev: r.rev,
        status: r.status,
        mime: r.mime,
        // private delivery: short-lived signed serve path (never a public bucket URL)
        url: this.signed.drawingPath(r.id),
        sizeBytes: r.sizeBytes,
        note: r.note,
        issuedBy: r.issuedBy,
        issuedAt: r.issuedAt,
        acks: r.acks.map((a) => ({ userName: a.userName, role: a.role, at: ddMmmYyyy(a.at) })),
      }));
      const current = revs.find((r) => r.status !== 'superseded') ?? null;
      const currentAckRow = current ? d.revisions.find((r) => r.id === current.id)?.acks ?? [] : [];
      return {
        id: d.id,
        number: d.number,
        title: d.title,
        discipline: d.discipline,
        zone: d.zone,
        activityId: d.activityId,
        decisionId: d.decisionId,
        nodeId: d.nodeId ?? undefined, // location spine: the place this drawing governs
        current,
        ackedByMe: Boolean(userId) && currentAckRow.some((a) => a.userId === userId),
        revisions: revs,
      };
    });

    // Phase rollups: each phase's activities counted by status so the schedule
    // and portfolio can show phase-level progress (done/total → donePct).
    const phaseDtos: PhaseDto[] = phases.map((p) => {
      const acts = activityDtos.filter((a) => a.phaseId === p.id);
      const done = acts.filter((a) => a.status === 'done').length;
      const inProgress = acts.filter((a) => a.status === 'in-progress').length;
      const blocked = acts.filter((a) => a.status === 'blocked').length;
      const notStarted = acts.filter((a) => a.status === 'not-started').length;
      return {
        id: p.id,
        name: p.name,
        order: p.order,
        plannedStart: p.plannedStart,
        plannedEnd: p.plannedEnd,
        activityTotal: acts.length,
        done,
        inProgress,
        blocked,
        notStarted,
        donePct: acts.length ? Math.round((done / acts.length) * 100) : 0,
      };
    });

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
        elapsedPct: project.elapsedPct,
        todayDay: project.todayDay,
        milestonePct: project.milestonePct,
      },
      decisions: decisionDtos,
      activities: activityDtos,
      reviews: isPmc ? reviews : [],
      review: isPmc ? (reviews[0] ?? null) : null, // deprecated single (first pending) — back-compat
      reinspectionCreated: isPmc ? reinspectionCreated : false,
      checklist: checklistRow
        ? {
            id: checklistRow.id,
            title: checklistRow.title,
            zone: checklistRow.zone,
            nodeId: checklistRow.nodeId ?? undefined, // location spine
            date: checklistRow.date,
            submitted: checklistRow.submitted,
            items: checklistRow.items.map((it) => ({ name: it.name, state: it.state, photos: it.photos, note: it.note })),
          }
        : null,
      drawings: drawingDtos,
      phases: phaseDtos,
      dailyLog: dailyLog
        ? {
            date: dailyLog.date,
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
            photos: progressPhotos,
          }
        : null,
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
      nodes: nodes.map((n) => ({ id: n.id, parentId: n.parentId ?? null, name: n.name, kind: n.kind as 'zone' | 'room' | 'element', order: n.order })),
      // The location spine's reality layer: placed (and unplaced) site photos for the Place view.
      photos: photoDtos,
      // All materials delivered across the project, with their place — the Site Map's "materials here".
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
}
