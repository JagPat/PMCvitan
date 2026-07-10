import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  /** Build the full project snapshot the frontend hydrates its store from.
   *  Permission-filtered: only PMC & client see pending decisions; every other
   *  role (contractor, engineer, worker) is restricted to decided ones. */
  async build(projectId: string, role: Role, userId?: string): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const [decisions, activities, inspections, dailyLog, notifications, progressMedia, drawings, phases, companies] = await Promise.all([
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
      this.prisma.media.findMany({
        where: { projectId, kind: 'progress' },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, url: true, takenAt: true },
      }),
      this.prisma.drawing.findMany({
        where: { projectId },
        include: { revisions: { orderBy: { createdAt: 'desc' }, include: { acks: { orderBy: { at: 'asc' } } } } },
        orderBy: [{ discipline: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    ]);

    const progressPhotos = progressMedia.map((m) => ({
      id: m.id,
      // S3/R2 rows carry an absolute url; dev-stub rows are served from /media/:id
      url: m.url ?? `/media/${m.id}`,
      takenAt: m.takenAt ?? undefined,
    }));

    const hidePending = role !== 'pmc' && role !== 'client';
    const decisionDtos: DecisionDto[] = decisions
      .filter((d) => !(hidePending && d.status === 'pending'))
      .map((d) => ({
        id: d.id,
        title: d.title,
        room: d.room,
        status: d.status,
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
    const checklistRow = inspections.find((i) => i.kind === 'checklist');
    // The review queue: any submitted-but-undecided inspection, whatever its kind
    // (a submitted checklist, the seeded review, an auto-created closing inspection).
    // A checklist item's pass/fail/na `state` maps to a review PASS/FAIL result.
    const reviews = inspections
      .filter((i) => i.submitted && !i.decided)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({
        id: i.id,
        title: i.title,
        zone: i.zone,
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
        url: r.url ?? `/drawings/rev/${r.id}`,
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
      checklist: checklistRow
        ? {
            id: checklistRow.id,
            title: checklistRow.title,
            zone: checklistRow.zone,
            date: checklistRow.date,
            submitted: checklistRow.submitted,
            items: checklistRow.items.map((it) => ({ name: it.name, state: it.state, photos: it.photos, note: it.note })),
          }
        : null,
      reviews,
      review: reviews[0] ?? null, // deprecated single (first pending) — back-compat
      reinspectionCreated,
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
      notifications: notifications.map((n) => ({ text: n.text, time: n.time, color: n.color })),
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        contactName: c.contactName ?? '',
        contactEmail: c.contactEmail ?? '',
        contactPhone: c.contactPhone ?? '',
        notes: c.notes ?? '',
      })),
    };
  }
}
