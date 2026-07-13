import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { deriveDecisionGate, isActivityReady } from '../domain/transitions';
import { resolveProjectNode } from '../nodes/node-scope';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, diffCivilDays, fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateActivityInput, UpdateActivityInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Planned civil dates for a write: prefer explicit ISO input; else derive from the
   *  project's schedule anchor + the legacy day-offset (offset 0 IS the anchor day). */
  private plannedDates(anchor: string | null, iso: { start?: string; end?: string }, legacy: { start?: number; end?: number }) {
    const startIso = iso.start ?? (anchor && legacy.start !== undefined ? addCivilDays(anchor, legacy.start) : null);
    const endIso = iso.end ?? (anchor && legacy.end !== undefined ? addCivilDays(anchor, legacy.end) : null);
    return {
      plannedStartDate: fromIsoCivilDate(startIso),
      plannedEndDate: fromIsoCivilDate(endIso),
      // keep the legacy ints coherent when ISO input drove the write
      ...(iso.start && anchor ? { plannedStart: diffCivilDays(anchor, iso.start) } : {}),
      ...(iso.end && anchor ? { plannedEnd: diffCivilDays(anchor, iso.end) } : {}),
    };
  }

  /** The FINAL resolved window must be ordered (Codex round 2): the schema refines
   *  compare ISO-vs-ISO and offset-vs-offset, but a MIXED payload (ISO start +
   *  offset-derived end) or a partial update can still merge to a reversed window. */
  private assertOrderedWindow(startDate: Date | null | undefined, endDate: Date | null | undefined): void {
    if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
      throw new BadRequestException('The planned window is reversed: the resolved end date is before the start date');
    }
  }

  /** Referenced phase/decision/location-node must exist on THIS project (cross-tenant links refused). */
  private async assertRefs(projectId: string, phaseId?: string | null, decisionId?: string | null, nodeId?: string | null): Promise<void> {
    if (phaseId) {
      const p = await this.prisma.phase.findUnique({ where: { id: phaseId } });
      if (!p || p.projectId !== projectId) throw new BadRequestException('Unknown phase for this project');
    }
    if (decisionId) {
      const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
      if (!d || d.projectId !== projectId) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: resolveProjectNode throws for an unknown/cross-project node.
    await resolveProjectNode(this.prisma, projectId, nodeId);
  }

  /** PMC plans a new activity (name, zone, planned window, gates, phase/decision links). */
  async create(projectId: string, input: CreateActivityInput, user: AuthUser): Promise<SnapshotDto> {
    await this.assertRefs(projectId, input.phaseId, input.decisionId, input.nodeId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    // DATA-01: ids are globally unique — scan every project for the sequence (see
    // decisions.service); `order` stays per-project (it drives this schedule's sort).
    const [allIds, existing] = await Promise.all([
      this.prisma.activity.findMany({ select: { id: true } }),
      this.prisma.activity.findMany({ where: { projectId }, select: { order: true } }),
    ]);
    const id = nextSeqId('ACT-', allIds.map((a) => a.id));
    const order = existing.reduce((m, a) => Math.max(m, a.order), 0) + 1;
    const dates = this.plannedDates(anchor, { start: input.plannedStartDate, end: input.plannedEndDate }, { start: input.plannedStart, end: input.plannedEnd });
    this.assertOrderedWindow(dates.plannedStartDate, dates.plannedEndDate);
    await this.prisma.$transaction([
      this.prisma.activity.create({
        data: {
          id,
          projectId,
          name: input.name,
          zone: input.zone,
          plannedStart: input.plannedStart,
          plannedEnd: input.plannedEnd,
          ...dates,
          phaseId: input.phaseId ?? null,
          decisionId: input.decisionId ?? null,
          nodeId: input.nodeId ?? null,
          gateMaterial: input.gateMaterial,
          gateTeam: input.gateTeam,
          gateInspection: input.gateInspection,
          order,
        },
      }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.create', entity: 'Activity', entityId: id } }),
    ]);
    this.realtime.notifyChanged(projectId, `Schedule updated: ${input.name} planned`, ['engineer', 'contractor']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC edits the plan — only provided fields change; explicit null clears a link. */
  async update(projectId: string, activityId: string, input: UpdateActivityInput, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    const ps = input.plannedStart ?? a.plannedStart;
    const pe = input.plannedEnd ?? a.plannedEnd;
    if (pe < ps) throw new BadRequestException('plannedEnd must be on or after plannedStart');
    await this.assertRefs(projectId, input.phaseId, input.decisionId, input.nodeId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    const { plannedStartDate: inputStartDate, plannedEndDate: inputEndDate, ...rest } = input;
    const data = {
      ...rest,
      // whichever representation the caller sent, both stay coherent — and each
      // spread picks ONLY its own edge (plannedDates returns null for the edge it
      // wasn't given; leaking that null would clear the other edge on a partial
      // update and dodge the merged-window check below)
      ...(inputStartDate || input.plannedStart !== undefined
        ? (({ plannedStartDate, plannedStart }) => ({ plannedStartDate, ...(plannedStart !== undefined ? { plannedStart } : {}) }))(
            this.plannedDates(anchor, { start: inputStartDate }, { start: input.plannedStart }),
          )
        : {}),
      ...(inputEndDate || input.plannedEnd !== undefined
        ? (({ plannedEndDate, plannedEnd }) => ({ plannedEndDate, ...(plannedEnd !== undefined ? { plannedEnd } : {}) }))(
            this.plannedDates(anchor, { end: inputEndDate }, { end: input.plannedEnd }),
          )
        : {}),
    };
    // The MERGED result (changed fields over the existing row) must stay an ordered
    // window — a partial update that only moves one edge can otherwise persist a
    // reversed plan with 200 (Codex round 2).
    this.assertOrderedWindow(
      'plannedStartDate' in data ? (data.plannedStartDate as Date | null) : a.plannedStartDate,
      'plannedEndDate' in data ? (data.plannedEndDate as Date | null) : a.plannedEndDate,
    );
    await this.prisma.$transaction([
      this.prisma.activity.update({ where: { id: activityId }, data }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.update', entity: 'Activity', entityId: activityId } }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC removes a planned activity. Refused once field records reference it. */
  async remove(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    try {
      // drawings reference activities through a NO ACTION composite FK — unlink
      // first (a drawing outlives its planned activity), then delete atomically
      await this.prisma.$transaction([
        this.prisma.drawing.updateMany({ where: { projectId, activityId }, data: { activityId: null } }),
        this.prisma.activity.delete({ where: { id: activityId } }),
      ]);
    } catch {
      throw new ConflictException('This activity has linked records (inspections/materials) — it can no longer be deleted');
    }
    await this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.delete', entity: 'Activity', entityId: activityId } });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Start an activity — server enforces that all four readiness gates align. */
  async start(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId }, include: { decision: true } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    if (a.status !== 'not_started') throw new ConflictException('Activity is not in a startable state');

    const gd = deriveDecisionGate(a.decision ? a.decision.status : null);
    if (!isActivityReady({ d: gd, m: a.gateMaterial, t: a.gateTeam, i: a.gateInspection })) {
      throw new ConflictException('Readiness gates are not aligned — cannot start this activity');
    }

    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    // the actual start is TODAY in the project's time zone — a real civil date,
    // never the prototype's todayDay counter
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    await this.prisma.$transaction([
      this.prisma.activity.update({
        where: { id: activityId },
        data: {
          status: 'in_progress',
          actualStartDate: fromIsoCivilDate(today),
          // legacy offset kept coherent for the compat timeline (derived from real dates)
          actualStart: anchor ? diffCivilDays(anchor, today) : null,
        },
      }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.start', entity: 'Activity', entityId: activityId } }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Mark complete — records the actual end and auto-creates a closing inspection. */
  async complete(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    if (a.status !== 'in_progress') throw new ConflictException('Only a running activity can be marked complete');

    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    await this.prisma.$transaction([
      this.prisma.activity.update({
        where: { id: activityId },
        data: {
          status: 'done',
          actualEndDate: fromIsoCivilDate(today),
          actualEnd: anchor ? diffCivilDays(anchor, today) : null,
        },
      }),
      this.prisma.inspection.create({
        // the closing inspection happens at the same place as the work it closes
        data: { id: `INSP-${activityId}-close`, projectId, kind: 'review', title: `Closing inspection: ${a.name}`, zone: a.zone, nodeId: a.nodeId, date: ddMmmYyyy(fromIsoCivilDate(today)!), inspectionDate: fromIsoCivilDate(today), submitted: true, decided: false },
      }),
      this.prisma.notification.create({ data: { projectId, text: `Closing inspection auto-created: ${a.name}`, color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.complete', entity: 'Activity', entityId: activityId } }),
    ]);
    // a closing inspection needs the PMC to review and sign off
    this.realtime.notifyChanged(projectId, `Closing inspection auto-created: ${a.name}`, ['pmc']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
