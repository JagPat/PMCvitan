import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import type { ApproveInput, ChangeInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Client approves an option → the decision is locked (server-authoritative),
   *  audited, a notification is raised, and any linked activity's Decision gate
   *  recomputes to green on the next snapshot read. */
  async approve(projectId: string, decisionId: string, input: ApproveInput, user: AuthUser): Promise<SnapshotDto> {
    const d = await this.prisma.decision.findUnique({
      where: { id: decisionId },
      include: { options: { orderBy: { order: 'asc' } } },
    });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status === 'approved') throw new ConflictException('Decision is already approved and locked');
    const o = d.options[input.optionIndex];
    if (!o) throw new BadRequestException('Invalid option index');

    const approver = user.role === 'client' ? 'Mr. Shah' : 'PMC';
    const today = ddMmmYyyy(new Date());

    await this.prisma.$transaction([
      this.prisma.decision.update({
        where: { id: decisionId },
        data: { status: 'approved', approvedOption: o.label, material: o.material, cost: o.delta, approver, date: today, photoSwatch: o.swatch },
      }),
      this.prisma.decisionEvent.create({ data: { decisionId, type: 'approved', actor: approver, payload: { option: o.label, material: o.material } } }),
      this.prisma.notification.create({ data: { projectId, text: `Client approved ${d.title} — ${o.material}`, color: '#3F7A54', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: approver, action: 'decision.approve', entity: 'Decision', entityId: decisionId } }),
    ]);

    // the client approved; PMC/contractor/engineer act on the now-locked decision
    this.realtime.notifyChanged(projectId, `Client approved ${d.title} — ${o.material}`, ['pmc', 'contractor', 'engineer']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Raise a Change Request against a locked decision (re-approval required). */
  async requestChange(projectId: string, decisionId: string, input: ChangeInput, user: AuthUser): Promise<SnapshotDto> {
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'approved') throw new ConflictException('Only a locked decision can have a change request');

    await this.prisma.$transaction([
      this.prisma.changeRequest.create({ data: { decisionId, reason: input.reason, costImpact: input.costImpact, timeImpactDays: input.timeImpactDays } }),
      this.prisma.decision.update({ where: { id: decisionId }, data: { status: 'change' } }),
      this.prisma.decisionEvent.create({ data: { decisionId, type: 'change_requested', actor: user.role, payload: input } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'decision.change', entity: 'Decision', entityId: decisionId } }),
    ]);

    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
