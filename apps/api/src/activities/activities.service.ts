import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { deriveDecisionGate, isActivityReady } from '../domain/transitions';
import { ddMmmYyyy } from '../domain/dates';
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
  ) {}

  /** Referenced phase/decision must exist on THIS project (cross-tenant links refused). */
  private async assertRefs(projectId: string, phaseId?: string | null, decisionId?: string | null): Promise<void> {
    if (phaseId) {
      const p = await this.prisma.phase.findUnique({ where: { id: phaseId } });
      if (!p || p.projectId !== projectId) throw new BadRequestException('Unknown phase for this project');
    }
    if (decisionId) {
      const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
      if (!d || d.projectId !== projectId) throw new BadRequestException('Unknown decision for this project');
    }
  }

  /** PMC plans a new activity (name, zone, planned window, gates, phase/decision links). */
  async create(projectId: string, input: CreateActivityInput, user: AuthUser): Promise<SnapshotDto> {
    await this.assertRefs(projectId, input.phaseId, input.decisionId);
    const existing = await this.prisma.activity.findMany({ where: { projectId }, select: { id: true, order: true } });
    const id = nextSeqId('ACT-', existing.map((a) => a.id));
    const order = existing.reduce((m, a) => Math.max(m, a.order), 0) + 1;
    await this.prisma.$transaction([
      this.prisma.activity.create({
        data: {
          id,
          projectId,
          name: input.name,
          zone: input.zone,
          plannedStart: input.plannedStart,
          plannedEnd: input.plannedEnd,
          phaseId: input.phaseId ?? null,
          decisionId: input.decisionId ?? null,
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
    await this.assertRefs(projectId, input.phaseId, input.decisionId);
    await this.prisma.$transaction([
      this.prisma.activity.update({ where: { id: activityId }, data: input }),
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
      await this.prisma.activity.delete({ where: { id: activityId } });
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
    await this.prisma.$transaction([
      this.prisma.activity.update({ where: { id: activityId }, data: { status: 'in_progress', actualStart: project.todayDay } }),
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
    await this.prisma.$transaction([
      this.prisma.activity.update({ where: { id: activityId }, data: { status: 'done', actualEnd: project.todayDay } }),
      this.prisma.inspection.create({
        data: { id: `INSP-${activityId}-close`, projectId, kind: 'review', title: `Closing inspection: ${a.name}`, zone: a.zone, date: ddMmmYyyy(new Date()), submitted: true, decided: false },
      }),
      this.prisma.notification.create({ data: { projectId, text: `Closing inspection auto-created: ${a.name}`, color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.complete', entity: 'Activity', entityId: activityId } }),
    ]);
    // a closing inspection needs the PMC to review and sign off
    this.realtime.notifyChanged(projectId, `Closing inspection auto-created: ${a.name}`, ['pmc']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
