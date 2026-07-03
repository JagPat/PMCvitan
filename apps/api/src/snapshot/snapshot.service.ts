import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Role } from '../common/auth';
import type { ActivityDto, DecisionDto, SnapshotDto } from './types';

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
  async build(projectId: string, role: Role): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const [decisions, activities, inspections, dailyLog, notifications] = await Promise.all([
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
    ]);

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
          recommended: o.recommended,
        })),
      }));

    const activityDtos: ActivityDto[] = activities.map((a) => ({
      id: a.id,
      name: a.name,
      zone: a.zone,
      decisionId: a.decisionId,
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

    const checklistRow = inspections.find((i) => i.kind === 'checklist');
    const reviewRow = inspections.find((i) => i.kind === 'review' && !i.title.startsWith('Closing inspection'));
    const reinspectionCreated = reviewRow
      ? reviewRow.decided && reviewRow.items.some((it) => it.rejected || it.result === 'FAIL')
      : false;

    return {
      project: {
        id: project.id,
        name: project.name,
        short: project.short,
        descriptor: project.descriptor,
        stage: project.stage,
        siteCode: project.siteCode,
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
      review: reviewRow
        ? {
            id: reviewRow.id,
            title: reviewRow.title,
            zone: reviewRow.zone,
            by: reviewRow.by ?? '',
            date: reviewRow.date,
            decided: reviewRow.decided,
            items: reviewRow.items.map((it) => ({
              name: it.name,
              result: (it.result ?? 'PASS') as 'PASS' | 'FAIL',
              swatch: it.swatch ?? 'concrete',
              note: it.note,
              rejected: it.rejected,
            })),
          }
        : null,
      reinspectionCreated,
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
          }
        : null,
      notifications: notifications.map((n) => ({ text: n.text, time: n.time, color: n.color })),
    };
  }
}
