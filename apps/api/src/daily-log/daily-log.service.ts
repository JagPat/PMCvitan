import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { resolveProjectNode } from '../nodes/node-scope';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import type { AddMaterialInput, FlagMismatchInput, SubmitDailyLogInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class DailyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Flag a material as not matching its locked decision → block the linked activity. */
  async flagMismatch(projectId: string, input: FlagMismatchInput, user: AuthUser): Promise<SnapshotDto> {
    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: { date: 'desc' }, include: { materials: true } });
    if (!log) throw new NotFoundException('No daily log for this project');
    const mat = log.materials.find((m) => m.decisionId === input.decisionId);
    if (!mat) throw new NotFoundException(`No material linked to ${input.decisionId}`);

    const activities = await this.prisma.activity.findMany({ where: { projectId, decisionId: input.decisionId } });
    await this.prisma.$transaction([
      this.prisma.siteMaterial.update({ where: { id: mat.id }, data: { matched: false } }),
      ...activities.map((a) =>
        this.prisma.activity.update({ where: { id: a.id }, data: { gateMaterial: 'fail', status: a.status === 'done' ? a.status : 'blocked', block: 'Material ≠ approved' } }),
      ),
      this.prisma.notification.create({ data: { projectId, text: `Material mismatch: ${mat.name} ≠ approved ${input.decisionId}`, color: '#B23A34', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'material.mismatch', entity: 'SiteMaterial', entityId: mat.id } }),
    ]);
    // material mismatch blocks work — alert PMC (resolves it) and contractor (supplied it)
    this.realtime.notifyChanged(projectId, `Material mismatch: ${mat.name} ≠ approved ${input.decisionId}`, ['pmc', 'contractor']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer starts a fresh day's log once the previous one is submitted. Crew trades
   *  are carried over at count 0 so the steppers appear pre-populated. */
  async start(projectId: string, user: AuthUser): Promise<SnapshotDto> {
    const latest = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: { date: 'desc' }, include: { crew: { orderBy: { order: 'asc' } } } });
    if (latest && !latest.submitted) throw new ConflictException('The current daily log is still open — submit it before starting a new day');
    const log = await this.prisma.dailyLog.create({ data: { projectId, date: ddMmmYyyy(new Date()) } });
    if (latest?.crew.length) {
      await this.prisma.crewRow.createMany({ data: latest.crew.map((c) => ({ dailyLogId: log.id, trade: c.trade, count: 0, order: c.order })) });
    }
    await this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'dailylog.start', entity: 'DailyLog', entityId: log.id } });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer records a material delivery on the open log (optionally linked to the
   *  decision that approved it, which is what mismatch-flagging keys off). */
  async addMaterial(projectId: string, input: AddMaterialInput, user: AuthUser): Promise<SnapshotDto> {
    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: { date: 'desc' }, include: { materials: true } });
    if (!log) throw new NotFoundException('No daily log for this project — start one first');
    if (log.submitted) throw new ConflictException('This log is already submitted — start a new day first');
    if (input.decisionId) {
      const d = await this.prisma.decision.findUnique({ where: { id: input.decisionId } });
      if (!d || d.projectId !== projectId) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: validate the place this material was delivered to.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    const order = log.materials.reduce((m, x) => Math.max(m, x.order), 0) + 1;
    await this.prisma.$transaction([
      this.prisma.siteMaterial.create({
        data: { dailyLogId: log.id, name: input.name, qty: input.qty, zone: input.zone, decisionId: input.decisionId ?? null, swatch: input.swatch, matched: true, nodeId, order },
      }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'material.add', entity: 'DailyLog', entityId: log.id } }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Submit the daily log to PMC (must be checked in first). */
  async submit(projectId: string, input: SubmitDailyLogInput, user: AuthUser): Promise<SnapshotDto> {
    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: { date: 'desc' } });
    if (!log) throw new NotFoundException('No daily log for this project');
    if (!input.checkedIn) throw new BadRequestException('Please check in at site before submitting the daily log.');

    await this.prisma.$transaction([
      this.prisma.dailyLog.update({ where: { id: log.id }, data: { checkedIn: input.checkedIn, checkinTime: input.checkinTime, progress: input.progress, submitted: true } }),
      ...input.crew.map((c) => this.prisma.crewRow.updateMany({ where: { dailyLogId: log.id, trade: c.trade }, data: { count: c.count } })),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'dailylog.submit', entity: 'DailyLog', entityId: log.id } }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
