import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { resolveProjectNode } from '../nodes/node-scope';
import { lockProjectReadiness } from '../common/readiness-lock';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { fromIsoCivilDate } from '../common/civil-date';
import type { AuthUser } from '../common/auth';
import type { AddMaterialInput, FlagMismatchInput, SubmitDailyLogInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { resolveActor } from '../common/actor';
import { ActivityParticipant } from '../activities/activity.participant';

@Injectable()
export class DailyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // Task 8 — a linked material's decision is validated through the decisions query.
    private readonly decisions: DecisionsQueryService,
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
    @Inject(CLOCK) private readonly clock: Clock,
    // Task 7 — the activities module's workflow participant: a material mismatch blocks
    // the linked activities THROUGH it (edge 4), so the Activity write stays in the
    // activities module while this flag orchestrates it under the readiness lock.
    private readonly activities: ActivityParticipant,
  ) {}

  /** Flag a material as not matching its locked decision → block the linked activity.
   *
   *  Gate round-2 finding 1: this WRITES a readiness input (gateMaterial + status),
   *  so it takes the per-project readiness lock and re-reads the log, material and
   *  linked activities INSIDE the locked transaction — a concurrent start() sees the
   *  mismatch strictly before its readiness evaluation, or this flag waits for the
   *  start's commit and blocks the freshly started activity as a NEW fact. */
  async flagMismatch(projectId: string, input: FlagMismatchInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    let matName = '';
    const ev = await this.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, projectId);
      const log = await tx.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { materials: true } });
      if (!log) throw new NotFoundException('No daily log for this project');
      const mat = log.materials.find((m) => m.decisionId === input.decisionId);
      if (!mat) throw new NotFoundException(`No material linked to ${input.decisionId}`);
      matName = mat.name;

      await tx.siteMaterial.update({ where: { id: mat.id }, data: { matched: false } });
      // Edge 4 (Task 7): the linked activities are blocked THROUGH the activities
      // participant, in this same locked transaction — the Activity write lives in its
      // owning module while this flag orchestrates the material→readiness workflow.
      await this.activities.blockForMaterialMismatch(tx, { projectId, decisionId: input.decisionId });
      await tx.notification.create({ data: { projectId, text: `Material mismatch: ${mat.name} ≠ approved ${input.decisionId}`, color: '#B23A34', time: 'just now' } });
      await recordAudit(tx, { projectId, actor, action: 'material.mismatch', entity: 'SiteMaterial', entityId: mat.id });
      return emitEvent(tx, { projectId, actor, eventType: 'material.mismatch_flagged', entityType: 'SiteMaterial', entityId: mat.id, payload: { decisionId: input.decisionId }, effectKey: 'material.mismatch_flagged', dispatch: { push: { body: `Material mismatch: ${matName} ≠ approved ${input.decisionId}` } } });
    });
    // material mismatch blocks work — alert PMC (resolves it) and contractor (supplied it)
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer starts a fresh day's log once the previous one is submitted. Crew trades
   *  are carried over at count 0 so the steppers appear pre-populated. */
  async start(projectId: string, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const latest = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { crew: { orderBy: { order: 'asc' } } } });
    if (latest && !latest.submitted) throw new ConflictException('The current daily log is still open — submit it before starting a new day');
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone); // the civil day site work belongs to
    const ev = await this.prisma.$transaction(async (tx) => {
      const log = await tx.dailyLog.create({
        data: { projectId, logDate: fromIsoCivilDate(today), date: ddMmmYyyy(fromIsoCivilDate(today)!) },
      });
      if (latest?.crew.length) {
        await tx.crewRow.createMany({ data: latest.crew.map((c) => ({ dailyLogId: log.id, trade: c.trade, count: 0, order: c.order })) });
      }
      await recordAudit(tx, { projectId, actor, action: 'dailylog.start', entity: 'DailyLog', entityId: log.id });
      return emitEvent(tx, { projectId, actor, eventType: 'dailylog.started', entityType: 'DailyLog', entityId: log.id, effectKey: 'dailylog.started', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer records a material delivery on the open log (optionally linked to the
   *  decision that approved it, which is what mismatch-flagging keys off). */
  async addMaterial(projectId: string, input: AddMaterialInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { materials: true } });
    if (!log) throw new NotFoundException('No daily log for this project — start one first');
    if (log.submitted) throw new ConflictException('This log is already submitted — start a new day first');
    if (input.decisionId) {
      if (!(await this.decisions.existsInProject(projectId, input.decisionId))) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: validate the place this material was delivered to.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    const order = log.materials.reduce((m, x) => Math.max(m, x.order), 0) + 1;
    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.siteMaterial.create({
        data: { projectId, dailyLogId: log.id, name: input.name, qty: input.qty, zone: input.zone, decisionId: input.decisionId ?? null, swatch: input.swatch, matched: true, nodeId, order },
      });
      await recordAudit(tx, { projectId, actor, action: 'material.add', entity: 'DailyLog', entityId: log.id });
      return emitEvent(tx, { projectId, actor, eventType: 'material.added', entityType: 'DailyLog', entityId: log.id, effectKey: 'material.added', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Submit the daily log to PMC (must be checked in first). */
  async submit(projectId: string, input: SubmitDailyLogInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!log) throw new NotFoundException('No daily log for this project');
    if (!input.checkedIn) throw new BadRequestException('Please check in at site before submitting the daily log.');

    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.dailyLog.update({ where: { id: log.id }, data: { checkedIn: input.checkedIn, checkinTime: input.checkinTime, progress: input.progress, submitted: true } });
      for (const c of input.crew) {
        await tx.crewRow.updateMany({ where: { dailyLogId: log.id, trade: c.trade }, data: { count: c.count } });
      }
      await recordAudit(tx, { projectId, actor, action: 'dailylog.submit', entity: 'DailyLog', entityId: log.id });
      return emitEvent(tx, { projectId, actor, eventType: 'dailylog.submitted', entityType: 'DailyLog', entityId: log.id, effectKey: 'dailylog.submitted', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
