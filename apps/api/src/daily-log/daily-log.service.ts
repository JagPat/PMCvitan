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
import type { MismatchResolvedPayload } from '@vitan/shared';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import type { AddMaterialInput, FlagMismatchInput, ResolveMismatchInput, SubmitDailyLogInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { resolveActor } from '../common/actor';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
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
    // Phase 3 Task 5 — the mismatch-RESOLUTION surface is pilot-gated (§D — 404 off-pilot);
    // the pre-existing flag flow stays exactly as it was on non-pilot projects.
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** Flag a material as not matching its locked decision → block the linked activity.
   *
   *  Gate round-2 finding 1: this WRITES a readiness input (gateMaterial + status),
   *  so it takes the per-project readiness lock and re-reads the log, material and
   *  linked activities INSIDE the locked transaction — a concurrent start() sees the
   *  mismatch strictly before its readiness evaluation, or this flag waits for the
   *  start's commit and blocks the freshly started activity as a NEW fact.
   *
   *  Task 10 (correction, finding 3): idempotent via the CommandExecution ledger — the same
   *  `Idempotency-Key` + payload replays the committed result; a different payload is a 409. */
  async flagMismatch(projectId: string, input: FlagMismatchInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId: input.decisionId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'daily-log.flagMismatch', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'daily-log.flagMismatch', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const log = await tx.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { materials: true } });
        if (!log) throw new NotFoundException('No daily log for this project');
        const mat = log.materials.find((m) => m.decisionId === input.decisionId);
        if (!mat) throw new NotFoundException(`No material linked to ${input.decisionId}`);

        await tx.siteMaterial.update({ where: { id: mat.id }, data: { matched: false } });
        // Edge 4 (Task 7): the linked activities are blocked THROUGH the activities
        // participant, in this same locked transaction — the Activity write lives in its
        // owning module while this flag orchestrates the material→readiness workflow.
        // Task 10 (Module 4): the participant also appends `activity.material_blocked` (an
        // activity-owned signal) so the activities.schedule projection observes the block.
        const blocked = await this.activities.blockForMaterialMismatch(tx, { projectId, decisionId: input.decisionId, actor });
        await tx.notification.create({ data: { projectId, text: `Material mismatch: ${mat.name} ≠ approved ${input.decisionId}`, color: '#B23A34', time: 'just now' } });
        await recordAudit(tx, { projectId, actor, action: 'material.mismatch', entity: 'SiteMaterial', entityId: mat.id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'material.mismatch_flagged', entityType: 'SiteMaterial', entityId: mat.id, payload: { decisionId: input.decisionId }, effectKey: 'material.mismatch_flagged', dispatch: { push: { body: `Material mismatch: ${mat.name} ≠ approved ${input.decisionId}` } } });
        return { resultRef: mat.id, events: blocked ? [ev, blocked] : [ev] };
      },
    });
    // material mismatch blocks work — alert PMC (resolves it) and contractor (supplied it)
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 3 Task 5 (§E) — close ONE `matched: false` observation with an explicit, audited
   * disposition. The observation row is NEVER edited (`matched` stays false — the history
   * says what was observed); the resolution is a separate append-only record, UNIQUE per
   * observation. The activity block clears ONLY when no unresolved mismatch remains for the
   * decision — through the activities participant, under the same readiness lock, with the
   * material gate falling back to `wait` (clearing a dispute never fabricates readiness).
   * Pilot-gated (§D — 404 off-pilot); pmc authority (route policy `dailyLog.resolveMismatch`).
   */
  async resolveMismatch(projectId: string, input: ResolveMismatchInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest(input);
    if (await peekReplay(this.prisma, scope, actor.actorId, 'daily-log.resolveMismatch', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'daily-log.resolveMismatch', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const mat = await tx.siteMaterial.findFirst({ where: { projectId, id: input.siteMaterialId }, include: { resolution: true } });
        if (!mat) throw new NotFoundException('Site material not found in this project');
        if (mat.matched) throw new BadRequestException('This observation is not a mismatch — nothing to resolve');
        if (mat.resolution) throw new ConflictException('This observation is already resolved (§E — one resolution per observation)');
        const resolution = await tx.mismatchResolution.create({
          data: { projectId, siteMaterialId: mat.id, resolution: input.resolution, reason: input.reason, resolvedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'material.mismatch_resolved', entity: 'MismatchResolution', entityId: resolution.id });
        await tx.notification.create({ data: { projectId, text: `Mismatch resolved: ${mat.name} — ${input.resolution}`, color: '#3F7A54', time: 'just now' } });
        const events = [await emitEvent(tx, {
          projectId, actor, eventType: 'mismatch.resolved', entityType: 'SiteMaterial', entityId: mat.id,
          payload: { siteMaterialId: mat.id, resolution: input.resolution, authority: actor.actorId } satisfies MismatchResolvedPayload,
          effectKey: 'mismatch.resolved', dispatch: {},
        })];
        // §E: the block clears ONLY when NO unresolved mismatch observation remains for the
        // decision — another still-open observation keeps every linked activity blocked.
        if (mat.decisionId) {
          const remaining = await tx.siteMaterial.count({
            where: { projectId, decisionId: mat.decisionId, matched: false, id: { not: mat.id }, resolution: { is: null } },
          });
          if (remaining === 0) {
            const unblocked = await this.activities.clearMaterialMismatchBlock(tx, { projectId, decisionId: mat.decisionId, actor });
            if (unblocked) events.push(unblocked);
          }
        }
        return { resultRef: resolution.id, events };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer starts a fresh day's log once the previous one is submitted. Crew trades
   *  are carried over at count 0 so the steppers appear pre-populated.
   *
   *  Task 10 (correction, finding 3): idempotent + concurrency-safe — the open-log precondition is
   *  re-checked UNDER the per-project readiness lock inside the ledger transaction, so two concurrent
   *  starts (or a replayed one) can never create two logs; the same key replays the committed log. */
  async start(projectId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({}); // no request body — the server derives the civil day
    if (await peekReplay(this.prisma, scope, actor.actorId, 'daily-log.start', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone); // the civil day site work belongs to

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'daily-log.start', idempotencyKey, requestHash,
      run: async (tx) => {
        // Serialize concurrent starts: the second waits, then sees the first's open log and is refused.
        await lockProjectReadiness(tx, projectId);
        const latest = await tx.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { crew: { orderBy: { order: 'asc' } } } });
        if (latest && !latest.submitted) throw new ConflictException('The current daily log is still open — submit it before starting a new day');
        const log = await tx.dailyLog.create({
          data: { projectId, logDate: fromIsoCivilDate(today), date: ddMmmYyyy(fromIsoCivilDate(today)!) },
        });
        if (latest?.crew.length) {
          await tx.crewRow.createMany({ data: latest.crew.map((c) => ({ dailyLogId: log.id, trade: c.trade, count: 0, order: c.order })) });
        }
        await recordAudit(tx, { projectId, actor, action: 'dailylog.start', entity: 'DailyLog', entityId: log.id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'dailylog.started', entityType: 'DailyLog', entityId: log.id, effectKey: 'dailylog.started', dispatch: {} });
        return { resultRef: log.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer records a material delivery on the open log (optionally linked to the
   *  decision that approved it, which is what mismatch-flagging keys off).
   *
   *  Task 10 (correction, finding 3): idempotent — a retried/replayed add with the same key adds the
   *  material exactly once (no duplicate SiteMaterial row); a different payload under the key is a 409. */
  async addMaterial(projectId: string, input: AddMaterialInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ name: input.name, qty: input.qty, zone: input.zone, decisionId: input.decisionId ?? null, swatch: input.swatch, nodeId: input.nodeId ?? null });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'daily-log.addMaterial', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }], include: { materials: true } });
    if (!log) throw new NotFoundException('No daily log for this project — start one first');
    if (log.submitted) throw new ConflictException('This log is already submitted — start a new day first');
    if (input.decisionId) {
      if (!(await this.decisions.existsInProject(projectId, input.decisionId))) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: validate the place this material was delivered to.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    const order = log.materials.reduce((m, x) => Math.max(m, x.order), 0) + 1;

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'daily-log.addMaterial', idempotencyKey, requestHash,
      run: async (tx) => {
        const mat = await tx.siteMaterial.create({
          data: { projectId, dailyLogId: log.id, name: input.name, qty: input.qty, zone: input.zone, decisionId: input.decisionId ?? null, swatch: input.swatch, matched: true, nodeId, order },
        });
        await recordAudit(tx, { projectId, actor, action: 'material.add', entity: 'DailyLog', entityId: log.id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'material.added', entityType: 'DailyLog', entityId: log.id, effectKey: 'material.added', dispatch: {} });
        return { resultRef: mat.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Submit the daily log to PMC (must be checked in first).
   *
   *  Task 10 (correction, finding 3): idempotent — a retried/replayed submit with the same key applies
   *  once; a different payload under the same key is a 409. */
  async submit(projectId: string, input: SubmitDailyLogInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ checkedIn: input.checkedIn, checkinTime: input.checkinTime, progress: input.progress, crew: input.crew.map((c) => ({ trade: c.trade, count: c.count })) });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'daily-log.submit', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const log = await this.prisma.dailyLog.findFirst({ where: { projectId }, orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!log) throw new NotFoundException('No daily log for this project');
    if (!input.checkedIn) throw new BadRequestException('Please check in at site before submitting the daily log.');

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'daily-log.submit', idempotencyKey, requestHash,
      run: async (tx) => {
        await tx.dailyLog.update({ where: { id: log.id }, data: { checkedIn: input.checkedIn, checkinTime: input.checkinTime, progress: input.progress, submitted: true } });
        for (const c of input.crew) {
          await tx.crewRow.updateMany({ where: { dailyLogId: log.id, trade: c.trade }, data: { count: c.count } });
        }
        await recordAudit(tx, { projectId, actor, action: 'dailylog.submit', entity: 'DailyLog', entityId: log.id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'dailylog.submitted', entityType: 'DailyLog', entityId: log.id, effectKey: 'dailylog.submitted', dispatch: {} });
        return { resultRef: log.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
