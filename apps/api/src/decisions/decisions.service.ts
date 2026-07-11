import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import { nextSeqId } from '../domain/ids';
import { pendingDecisionNotice } from '../domain/notifications';
import type { ApproveInput, ChangeInput, CreateDecisionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** PMC issues a new decision (title/room + 2–4 options) → shows as pending on the
   *  client's Decisions Waiting screen. Labels/keys derive from order when omitted. */
  async create(projectId: string, input: CreateDecisionInput, user: AuthUser): Promise<SnapshotDto> {
    // DATA-01: `Decision.id` is the table's GLOBAL primary key, so the sequence must
    // scan every project — a per-project scan would mint e.g. DL-003 twice (the demo
    // project already owns it) and crash the second project's create with P2002.
    // Durable fix (internal PK + per-project code) is tracked in docs/ROADMAP.md.
    const existing = await this.prisma.decision.findMany({ select: { id: true } });
    const id = nextSeqId('DL-', existing.map((d) => d.id));
    const lead = input.options.find((o) => o.recommended) ?? input.options[0];

    // Location: when a tree node is given, validate it belongs to this project and derive
    // the display `room` from the node's name (the full breadcrumb is built client-side
    // from the node tree). Otherwise fall back to the free-text `room`.
    let nodeId: string | null = null;
    let room = input.room;
    if (input.nodeId) {
      const node = await this.prisma.projectNode.findUnique({ where: { id: input.nodeId } });
      if (!node || node.projectId !== projectId) throw new BadRequestException('Unknown location for this project');
      nodeId = node.id;
      room = node.name;
    }
    if (!room) throw new BadRequestException('A decision needs a location (pick one, or type a room).');

    // Draft by default: `publishedAt` stays null (author-private, weightless) until the PMC
    // publishes. `publish: true` is the one-step "issue now" — created already live.
    const publishedAt = input.publish ? new Date() : null;

    await this.prisma.$transaction([
      this.prisma.decision.create({
        data: { id, projectId, title: input.title, room, nodeId, status: 'pending', ageDays: 0, photoSwatch: lead.swatch, authorId: user.sub, publishedAt },
      }),
      this.prisma.decisionOption.createMany({
        data: input.options.map((o, i) => ({
          decisionId: id,
          label: o.label ?? `Option ${String.fromCharCode(65 + i)}`,
          optionKey: String.fromCharCode(97 + i),
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
          photoUrl: o.photoUrl || null,
          recommended: o.recommended,
          order: i,
        })),
      }),
      this.prisma.decisionEvent.create({ data: { decisionId: id, type: input.publish ? 'issued' : 'drafted', actor: user.role, payload: { title: input.title } } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id } }),
    ]);
    // Only a PUBLISHED decision reaches the client (a draft is private to its author, and
    // must not notify anyone). When published in one step, fire the same side-effects publish() does.
    if (input.publish) {
      await this.prisma.notification.create({ data: { projectId, text: pendingDecisionNotice(input.title), color: '#C08A2D', time: 'just now' } });
      this.realtime.notifyChanged(projectId, `New decision awaiting your approval: ${input.title}`, ['client']);
    }
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Publish a private draft decision → it enters the shared snapshot, the client is asked
   *  to choose, and it starts driving the app (pending count, linked gate). Idempotent-ish:
   *  publishing an already-published decision is a no-op conflict. Author/PMC authority. */
  async publish(projectId: string, decisionId: string, user: AuthUser): Promise<SnapshotDto> {
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.publishedAt) throw new ConflictException('Decision is already published');

    await this.prisma.$transaction([
      this.prisma.decision.update({ where: { id: decisionId }, data: { publishedAt: new Date() } }),
      this.prisma.decisionEvent.create({ data: { decisionId, type: 'issued', actor: user.role, payload: { title: d.title } } }),
      this.prisma.notification.create({ data: { projectId, text: pendingDecisionNotice(d.title), color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'decision.publish', entity: 'Decision', entityId: decisionId } }),
    ]);
    // now it's live — surface it on the client's side, exactly like a one-step issue
    this.realtime.notifyChanged(projectId, `New decision awaiting your approval: ${d.title}`, ['client']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

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
