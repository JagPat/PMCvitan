import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import type { AuthUser } from '../common/auth';
import type { FlagMismatchInput, SubmitDailyLogInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class DailyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
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
    return this.snapshot.build(projectId, user.role);
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
    return this.snapshot.build(projectId, user.role);
  }
}
