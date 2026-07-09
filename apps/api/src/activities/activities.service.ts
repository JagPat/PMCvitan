import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { deriveDecisionGate, isActivityReady } from '../domain/transitions';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

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
