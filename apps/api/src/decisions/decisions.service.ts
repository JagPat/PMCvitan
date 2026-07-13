import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import { resolveActor, ROLE_LABEL } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
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
    const actor = await resolveActor(this.prisma, user);
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
      this.prisma.decisionEvent.create({ data: { decisionId: id, type: input.publish ? 'issued' : 'drafted', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: input.title } } }),
      this.prisma.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id } }),
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
    const actor = await resolveActor(this.prisma, user);
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.publishedAt) throw new ConflictException('Decision is already published');

    await this.prisma.$transaction([
      this.prisma.decision.update({ where: { id: decisionId }, data: { publishedAt: new Date() } }),
      this.prisma.decisionEvent.create({ data: { decisionId, type: 'issued', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: d.title } } }),
      this.prisma.notification.create({ data: { projectId, text: pendingDecisionNotice(d.title), color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'decision.publish', entity: 'Decision', entityId: decisionId } }),
    ]);
    // now it's live — surface it on the client's side, exactly like a one-step issue
    this.realtime.notifyChanged(projectId, `New decision awaiting your approval: ${d.title}`, ['client']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Client approves an option → the decision is locked (server-authoritative) with the
   *  caller's REAL identity; when the decision was reopened, approval also RESOLVES the
   *  open change request ('reapproved'). The transition is a compare-and-set committed
   *  with its events, so a concurrent approve/change/withdraw has exactly one winner. */
  async approve(projectId: string, decisionId: string, input: ApproveInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const d = await this.prisma.decision.findUnique({
      where: { id: decisionId },
      include: { options: { orderBy: { order: 'asc' } } },
    });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status === 'approved') throw new ConflictException('Decision is already approved and locked');
    const o = d.options[input.optionIndex];
    if (!o) throw new BadRequestException('Invalid option index');

    const prior = d.status; // 'pending' (first approval) or 'change' (re-approval)
    const today = ddMmmYyyy(new Date());
    // a PMC approving records the client's consent ON BEHALF — the fact is never disguised
    const onBehalfOf = user.role === 'client' ? null : 'client';
    // ...and the ANNOUNCEMENT says so too (gate finding 7): who exercised the authority
    const announce = onBehalfOf
      ? `${actor.actorName} (${ROLE_LABEL[actor.actorRole] ?? actor.actorRole}) approved ${d.title} on behalf of the client — ${o.material}`
      : `Client approved ${d.title} — ${o.material}`;

    await this.prisma.$transaction(async (tx) => {
      // a lock-state transition moves the decision gate (gate finding 1)
      await lockProjectReadiness(tx, projectId);
      // CAS: commit only if the decision is STILL in the state we read — a concurrent
      // transition makes count 0 and this caller loses with a deterministic 409
      const { count } = await tx.decision.updateMany({
        where: { id: decisionId, projectId, status: prior },
        data: {
          status: 'approved',
          approvedOption: o.label,
          material: o.material,
          cost: o.delta,
          approver: actor.actorName,
          approvedById: actor.actorId,
          onBehalfOf,
          date: today,
          photoSwatch: o.swatch,
        },
      });
      if (count === 0) throw new ConflictException('The decision changed while approving — reload and retry');
      if (prior === 'change') {
        // mandatory re-approval CLOSES the reopening — EXACTLY ONE open request must
        // resolve, or 'reapproved' would lie about what happened (gate finding 1):
        // zero means inconsistent legacy state, more than one is impossible under the
        // partial unique index. Anything but 1 rolls the whole transition back.
        const resolved = await tx.changeRequest.updateMany({
          where: { decisionId, status: 'open' },
          data: { status: 'resolved', resolution: 'reapproved', resolvedById: actor.actorId, resolvedAt: new Date() },
        });
        if (resolved.count !== 1) {
          throw new ConflictException('This decision has no open change request to resolve — its state is inconsistent; ask the PMC to re-raise or withdraw the change');
        }
      }
      await tx.decisionEvent.create({
        data: {
          decisionId,
          type: prior === 'change' ? 'reapproved' : 'approved',
          actor: actor.actorName,
          actorId: actor.actorId,
          actorName: actor.actorName,
          actorRole: actor.actorRole,
          payload: { option: o.label, material: o.material, ...(onBehalfOf ? { onBehalfOf } : {}) },
        },
      });
      await tx.notification.create({ data: { projectId, text: announce, color: '#3F7A54', time: 'just now' } });
      await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'decision.approve', entity: 'Decision', entityId: decisionId } });
    });

    // the decision is locked; PMC/contractor/engineer act on it — told truthfully by whom
    this.realtime.notifyChanged(projectId, announce, ['pmc', 'contractor', 'engineer']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Raise a Change Request against a locked decision — the ONE formal reopening.
   *  Exactly one open request per decision: the CAS refuses a decision that moved,
   *  and the partial unique index is the database backstop (P2002 → 409). */
  async requestChange(projectId: string, decisionId: string, input: ChangeInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'approved') throw new ConflictException('Only a locked decision can have a change request');

    try {
      await this.prisma.$transaction(async (tx) => {
        // reopening reverts readiness — a readiness write (gate finding 1)
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, status: 'approved' },
          data: { status: 'change' },
        });
        if (count === 0) throw new ConflictException('The decision changed while requesting — reload and retry');
        await tx.changeRequest.create({
          data: { decisionId, reason: input.reason, costImpact: input.costImpact, timeImpactDays: input.timeImpactDays, status: 'open', requestedById: actor.actorId },
        });
        await tx.decisionEvent.create({ data: { decisionId, type: 'change_requested', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: input } });
        await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'decision.change', entity: 'Decision', entityId: decisionId } });
      });
    } catch (e) {
      // the one-open-per-decision partial unique index fired — a concurrent request won
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A change request is already open for this decision');
      }
      throw e;
    }

    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Withdraw the open change request — only its requester or the PMC. The decision
   *  returns to approved/locked and the request records how and by whom it closed. */
  async withdrawChange(projectId: string, decisionId: string, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'change') throw new ConflictException('No open change request to withdraw');
    const open = await this.prisma.changeRequest.findFirst({ where: { decisionId, status: 'open' } });
    if (!open) throw new ConflictException('No open change request to withdraw');
    if (user.role !== 'pmc' && open.requestedById !== user.sub) {
      throw new ForbiddenException('Only the requester or the PMC can withdraw a change request');
    }

    await this.prisma.$transaction(async (tx) => {
      // restoring the lock flips the decision gate back (gate finding 1)
      await lockProjectReadiness(tx, projectId);
      const { count } = await tx.decision.updateMany({
        where: { id: decisionId, projectId, status: 'change' },
        data: { status: 'approved' },
      });
      if (count === 0) throw new ConflictException('The decision changed while withdrawing — reload and retry');
      // EXACTLY ONE request must close (gate finding 1's twin): the pre-read saw an
      // open request, but if it vanished concurrently the withdrawal would record
      // nothing — roll the whole transition back instead of restoring a false lock.
      const closed = await tx.changeRequest.updateMany({
        where: { id: open.id, status: 'open' },
        data: { status: 'withdrawn', resolution: 'withdrawn', resolvedById: actor.actorId, resolvedAt: new Date() },
      });
      if (closed.count !== 1) throw new ConflictException('The change request changed while withdrawing — reload and retry');
      await tx.decisionEvent.create({ data: { decisionId, type: 'change_withdrawn', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole } });
      await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'decision.change_withdraw', entity: 'Decision', entityId: decisionId } });
    });

    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
