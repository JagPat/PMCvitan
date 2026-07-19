import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DrawingsQueryService } from '../drawings/drawings.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { deriveReadiness, gateReady, readinessReady, type ActivityReadiness, type DecisionStatus, type GateState } from '../domain/transitions';
import { resolveProjectNode } from '../nodes/node-scope';
import { resolveProjectRef } from '../common/project-ref';
import { lockProjectReadiness } from '../common/readiness-lock';
import { resolveActor } from '../common/actor';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, diffCivilDays, fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateActivityInput, OverrideGateInput, UpdateActivityInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import { InspectionParticipant } from '../inspections/inspection.participant';
import { DrawingParticipant } from '../drawings/drawing.participant';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // Task 8 — a linked decision gate is validated through the decisions query.
    private readonly decisions: DecisionsQueryService,
    // Task 10 — the drawing gate's readiness input comes from the drawings query (read-encapsulation),
    // never a direct `db.drawing` read; runs inside the start command's transaction.
    private readonly drawingsQuery: DrawingsQueryService,
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
    @Inject(CLOCK) private readonly clock: Clock,
    // Task 7 — the inspections module's workflow participant: completion (edge 1)
    // creates the linked closing inspection THROUGH it, so the Inspection write stays
    // in the inspections module while this activity workflow orchestrates it atomically.
    private readonly inspections: InspectionParticipant,
    // Task 10 (Module 3) — the inspection-gate readiness input + the closing-inspection id come from the
    // inspections module's query, so activities reads NO inspection persistence directly.
    private readonly inspectionsQuery: InspectionsQueryService,
    // Task 10 (Module 4) correction — removing an activity unlinks governed drawings through the
    // drawings participant (in-tx), which appends `drawing.activity_unlinked` so the drawings.inbox
    // projection observes the unlink (never the silent SET NULL alone).
    private readonly drawingParticipant: DrawingParticipant,
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
      if (!(await this.decisions.existsInProject(projectId, decisionId))) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: resolveProjectNode throws for an unknown/cross-project node.
    await resolveProjectNode(this.prisma, projectId, nodeId);
  }

  /** PMC plans a new activity (name, zone, planned window, gates, phase/decision links).
   *  Task 10 (Module 4): idempotent under `Idempotency-Key` (Task 5 ledger) — a retried plan
   *  (network retry / offline replay / double-tap) applies exactly once; a keyed REPLAY
   *  short-circuits BEFORE any validation or id-mint. */
  async create(projectId: string, input: CreateActivityInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      name: input.name, zone: input.zone, plannedStart: input.plannedStart, plannedEnd: input.plannedEnd,
      plannedStartDate: input.plannedStartDate ?? null, plannedEndDate: input.plannedEndDate ?? null,
      phaseId: input.phaseId ?? null, decisionId: input.decisionId ?? null, nodeId: input.nodeId ?? null,
      gateMaterial: input.gateMaterial, gateTeam: input.gateTeam,
    });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.create', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
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
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.create', idempotencyKey, requestHash,
      run: async (tx) => {
        await tx.activity.create({
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
            // gateInspection left the write contracts (Task 6): the inspection gate
            // is DERIVED from linked inspections; the column stays at its default
            order,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'activity.create', entity: 'Activity', entityId: id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'activity.created', entityType: 'Activity', entityId: id, payload: { name: input.name }, effectKey: 'activity.created', dispatch: { push: { body: `Schedule updated: ${input.name} planned` } } });
        return { resultRef: id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC edits the plan — only provided fields change; explicit null clears a link.
   *  Task 10 (Module 4): idempotent under `Idempotency-Key` (a keyed replay returns the snapshot). */
  async update(projectId: string, activityId: string, input: UpdateActivityInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ activityId, patch: input });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.update', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
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
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.update', idempotencyKey, requestHash,
      run: async (tx) => {
        // stored material/team flags and the decision link move readiness (finding 1)
        await lockProjectReadiness(tx, projectId);
        await tx.activity.update({ where: { id: activityId }, data });
        // Task 10 (Module 3) correction — a rename re-stamps the INSPECTION-OWNED activity label on every
        // linked inspection through the participant, which appends `inspection.relabeled` so the projection's
        // `activityName` tracks the rename (it read `Activity.name` live before). No-op (null) when unchanged.
        const relabelEv = input.name !== undefined && input.name !== a.name
          ? await this.inspections.relabelForActivity(tx, { projectId, actor, activityId, name: input.name })
          : null;
        await recordAudit(tx, { projectId, actor, action: 'activity.update', entity: 'Activity', entityId: activityId });
        const updatedEv = await emitEvent(tx, { projectId, actor, eventType: 'activity.updated', entityType: 'Activity', entityId: activityId, effectKey: 'activity.updated', dispatch: {} });
        return { resultRef: activityId, events: relabelEv ? [relabelEv, updatedEv] : [updatedEv] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC removes a planned activity. Refused once field records reference it.
   *  Task 10 (Module 4): idempotent under `Idempotency-Key` (a keyed replay returns the snapshot). */
  async remove(projectId: string, activityId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ activityId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.remove', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.remove', idempotencyKey, requestHash,
      run: async (tx) => {
        // Task 7 (edge 5) + Module-4 correction: a drawing outlives its planned activity. The
        // governed-drawing unlink is now performed EXPLICITLY through the drawings workflow
        // participant BEFORE the delete — which also appends the drawing-owned
        // `drawing.activity_unlinked` signal, so the drawings.inbox projection observes the
        // unlink instead of the silent ON DELETE SET NULL (the FK stays as the DB backstop).
        // Inspections/overrides keep their NO ACTION FKs and still BLOCK the delete (surfaced
        // as the Conflict below), so a referenced activity is never lost.
        const unlinkedEv = await this.drawingParticipant.unlinkFromDeletedActivity(tx, { projectId, actor, activityId });
        await tx.activity.delete({ where: { id: activityId } }).catch(() => {
          throw new ConflictException('This activity has linked records (inspections/materials) — it can no longer be deleted');
        });
        await recordAudit(tx, { projectId, actor, action: 'activity.delete', entity: 'Activity', entityId: activityId });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'activity.deleted', entityType: 'Activity', entityId: activityId, effectKey: 'activity.deleted', dispatch: {} });
        return { resultRef: activityId, events: unlinkedEv ? [unlinkedEv, ev] : [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** The five-gate readiness derivation's inputs for ONE activity — the same
   *  explicit edges the snapshot serializes (Task 6): linked inspections, linked
   *  drawings with their frozen recipients and acks, active members, overrides.
   *  start() passes its transaction client so the evaluation happens INSIDE the
   *  readiness-lock protocol (gate finding 1) — the default reads live data. */
  async loadReadiness(
    projectId: string,
    activity: { id: string; gateMaterial: GateState; gateTeam: GateState; decision: { status: string } | null },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ActivityReadiness> {
    const [inspections, drawings, activeMembers, overrides] = await Promise.all([
      // Task 10 (Module 3) — the inspection-gate readiness input comes from the inspections module's query
      // (inside this transaction, scoped to the activity), never a direct `db.inspection` read.
      this.inspectionsQuery.readinessSlice(projectId, { activityId: activity.id, tx: db }),
      this.drawingsQuery.readinessSlice(projectId, { activityId: activity.id, tx: db }),
      db.membership.findMany({ where: { projectId, status: 'active' }, select: { userId: true } }),
      db.gateOverride.findMany({ where: { projectId, activityId: activity.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    return deriveReadiness(activity.id, {
      decisionStatus: activity.decision ? (activity.decision.status as DecisionStatus) : null,
      gateMaterial: activity.gateMaterial,
      gateTeam: activity.gateTeam,
      inspections,
      drawings,
      activeMemberIds: activeMembers.map((m) => m.userId),
      overrides: overrides.map((o) => ({ gate: o.gate as OverrideGateInput['gate'], state: o.state, reason: o.reason, expiresAt: o.expiresAt })),
      now: new Date(),
    });
  }

  /** Start an activity — the server derives all FIVE readiness gates from the
   *  explicit recorded relationships (overrides considered) and refuses unless
   *  every one aligns. Stored gateInspection is never consulted (Task 6).
   *
   *  Gate finding 1 (P1): the WHOLE command — state check, readiness
   *  evaluation, CAS transition and audit — runs inside one transaction under
   *  the per-project readiness lock, which every readiness-affecting write also
   *  takes (see common/readiness-lock.ts). A concurrent start loses the CAS
   *  (409, no duplicate audit); a concurrent gate flip lands strictly before
   *  (this start refuses it) or strictly after (it waits for this commit). */
  async start(projectId: string, activityId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ activityId });
    // A keyed replay returns the current snapshot without re-running the state-machine guards — a retry
    // of an already-committed start replays cleanly instead of hitting "not in a startable state".
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.start', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    // the actual start is TODAY in the project's time zone — a real civil date,
    // never the prototype's todayDay counter
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.start', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const a = await tx.activity.findUnique({ where: { id: activityId }, include: { decision: true } });
        if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
        if (a.status !== 'not_started') throw new ConflictException('Activity is not in a startable state');

        const readiness = await this.loadReadiness(projectId, a, tx);
        if (!readinessReady(readiness)) {
          const blocking = (Object.entries(readiness) as Array<[string, { v: GateState; reason: string }]>)
            .filter(([, g]) => !gateReady(g.v))
            .map(([gate, g]) => `${gate}: ${g.reason}`)
            .join('; ');
          throw new ConflictException(`Readiness gates are not aligned — cannot start this activity (${blocking})`);
        }

        // CAS belt on top of the lock: exactly one start can move the status
        const { count } = await tx.activity.updateMany({
          where: { id: activityId, projectId, status: 'not_started' },
          data: {
            status: 'in_progress',
            actualStartDate: fromIsoCivilDate(today),
            // legacy offset kept coherent for the compat timeline (derived from real dates)
            actualStart: anchor ? diffCivilDays(anchor, today) : null,
          },
        });
        if (count === 0) throw new ConflictException('Activity is not in a startable state');
        await recordAudit(tx, { projectId, actor, action: 'activity.start', entity: 'Activity', entityId: activityId });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'activity.started', entityType: 'Activity', entityId: activityId, effectKey: 'activity.started', dispatch: {} });
        return { resultRef: activityId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** CLAIM completion (Phase 1 Task 5). "Done" means accepted: this parks the
   *  activity in `awaiting_signoff`, records WHO claimed the work finished (an
   *  attributable, membership-validated fact) and creates the LINKED closing
   *  inspection — with a default sign-off item, so it CAN be rejected. Only the
   *  PMC's approval of that closing inspection (inspections.decide) writes `done`. */
  async complete(projectId: string, activityId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ activityId });
    // A keyed replay returns the current snapshot without re-running the state-machine guards — a retry
    // of an already-committed claim replays cleanly instead of hitting "only a running activity".
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.complete', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    if (a.status !== 'in_progress') throw new ConflictException('Only a running activity can be marked complete');

    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    // DATA-01: inspection ids are globally unique — the id-pattern linkage
    // (INSP-<activityId>-close) is RETIRED; `closing` + `activityId` are the facts. Task 10 (Module 3):
    // the id is allocated by the inspections module's query, not a direct `prisma.inspection` read.
    const closingId = await this.inspectionsQuery.nextInspectionId();
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.complete', idempotencyKey, requestHash,
      run: async (tx) => {
       try {
        // The claim must be attributable to a member who is ACTIVE AT COMMIT TIME
        // (Codex Task 5 gate P1): the membership row is read LOCKED inside THIS
        // transaction, so a concurrent removal has a defined order — it either
        // commits first (this claim refuses with no side effects) or waits behind
        // this commit. The composite FK proves existence, never validity.
        const [membership] = await tx.$queryRaw<Array<{ status: string }>>(
          Prisma.sql`SELECT "status" FROM "Membership" WHERE "projectId" = ${projectId} AND "userId" = ${user.sub} FOR UPDATE`,
        );
        if (membership?.status !== 'active') {
          throw new BadRequestException('Completion must be claimed by an ACTIVE member of this project — your account holds no active membership here.');
        }
        // CAS: exactly one completion claim wins (in_progress → awaiting_signoff)
        const { count } = await tx.activity.updateMany({
          where: { id: activityId, projectId, status: 'in_progress' },
          data: {
            status: 'awaiting_signoff',
            // the CLAIMED work-end day; the sign-off day (doneAt) is written only on approval
            actualEndDate: fromIsoCivilDate(today),
            actualEnd: anchor ? diffCivilDays(anchor, today) : null,
            completionRequestedById: actor.actorId,
            completionRequestedByName: actor.actorName,
            completionRequestedAt: new Date(),
          },
        });
        if (count === 0) throw new ConflictException('The activity changed while completing — reload and retry');
        // Correction round 2 (F2) — the pre-transaction read above is a FAST VALIDATION only; a rename
        // (or re-file) can commit between it and the CAS. The CAS row lock is now held, so re-read the
        // Activity THROUGH THIS TRANSACTION and stamp the transaction-current name/zone/nodeId onto the
        // closing inspection, the notification, and the push — never the stale pre-read values.
        const fresh = await tx.activity.findUniqueOrThrow({ where: { id: activityId }, select: { name: true, zone: true, nodeId: true } });
        // The closing inspection is an ATOMIC WORKFLOW participant (Task 7, edge 1):
        // the inspections module owns the Inspection write, invoked here on THIS
        // transaction so the claim + closing inspection commit or roll back together.
        // Task 10 (Module 3) correction — the participant creates the closing inspection AND appends the
        // inspection-owned `inspection.closing_created` event in THIS transaction, so the projection
        // observes the new review. Both this event and the completion event are dispatched after commit.
        const closingEv = await this.inspections.createClosingInspection(tx, {
          closingId,
          projectId,
          activity: { id: activityId, name: fresh.name, zone: fresh.zone, nodeId: fresh.nodeId },
          actor,
          inspectionDate: fromIsoCivilDate(today),
          dateLabel: ddMmmYyyy(fromIsoCivilDate(today)!),
        });
        await tx.notification.create({ data: { projectId, text: `Sign-off requested: ${fresh.name} — awaiting the PMC's closing inspection`, color: '#C08A2D', time: 'just now' } });
        await recordAudit(tx, { projectId, actor, action: 'activity.complete_requested', entity: 'Activity', entityId: activityId, payload: { closingInspectionId: closingId } });
        const completionEv = await emitEvent(tx, { projectId, actor, eventType: 'activity.completion_requested', entityType: 'Activity', entityId: activityId, payload: { closingInspectionId: closingId }, effectKey: 'activity.completion_requested', dispatch: { push: { body: `Sign-off requested: ${fresh.name}` } } });
        return { resultRef: activityId, events: [closingEv, completionEv] };
       } catch (e) {
        // a concurrent inspection create took the sequential id — a plain retry resolves it. Converted
        // to the domain 409 INSIDE `run`, so the ledger's own reservation-P2002 handling (a different
        // index) never mistakes this for a concurrent-key conflict.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('A concurrent update took this inspection id — retry the completion');
        }
        throw e;
       }
      },
    });
    // the sign-off is the PMC's decision to make
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC records a MANUAL readiness exception (Task 6): one gate, one reason,
   *  optional same-project photo evidence, and an expiry that is ALWAYS in the
   *  future — expiry (or early revocation) restores the derivation. Audited. */
  async override(projectId: string, activityId: string, input: OverrideGateInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      activityId, gate: input.gate, state: input.state, reason: input.reason,
      expiresAt: input.expiresAt, evidenceMediaId: input.evidenceMediaId ?? null,
    });
    // A keyed replay returns the current snapshot without minting a SECOND override row.
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.override', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('An override must expire in the future — it is a temporary exception, never a permanent flag');
    }
    // supporting evidence must be THIS project's photo (composite FK is the backstop)
    const evidenceMediaId = await resolveProjectRef(this.prisma, 'media', projectId, input.evidenceMediaId, 'evidenceMediaId');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.override', idempotencyKey, requestHash,
      run: async (tx) => {
        // an override moves a gate the moment it exists (finding 1)
        await lockProjectReadiness(tx, projectId);
        const created = await tx.gateOverride.create({
          data: { projectId, activityId, gate: input.gate, state: input.state, reason: input.reason, actorId: actor.actorId, actorName: actor.actorName, evidenceMediaId, expiresAt },
        });
        await recordAudit(tx, { projectId, actor, action: 'activity.override', entity: 'Activity', entityId: activityId, payload: { gate: input.gate, state: input.state, reason: input.reason, expiresAt: expiresAt.toISOString(), evidenceMediaId } });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'activity.override_granted', entityType: 'Activity', entityId: activityId, payload: { gate: input.gate, state: input.state }, effectKey: 'activity.override_granted', dispatch: { push: { body: `Gate override on ${a.name}: ${input.gate} → ${input.state} (expires ${ddMmmYyyy(expiresAt)})` } } });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC revokes an override EARLY — the derivation rules again immediately.
   *  The audit trail keeps the full record of both the override and its end. */
  async revokeOverride(projectId: string, activityId: string, overrideId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ activityId, overrideId });
    // A keyed replay returns the current snapshot instead of a 404 for the already-deleted row.
    if (await peekReplay(this.prisma, scope, actor.actorId, 'activities.revokeOverride', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const row = await this.prisma.gateOverride.findUnique({ where: { id: overrideId } });
    if (!row || row.projectId !== projectId || row.activityId !== activityId) {
      throw new NotFoundException(`Override ${overrideId} not found`);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'activities.revokeOverride', idempotencyKey, requestHash,
      run: async (tx) => {
        // revoking restores the derivation instantly — a readiness write (finding 1)
        await lockProjectReadiness(tx, projectId);
        await tx.gateOverride.delete({ where: { id: overrideId } });
        await recordAudit(tx, { projectId, actor, action: 'activity.override_revoke', entity: 'Activity', entityId: activityId, payload: { overrideId, gate: row.gate, state: row.state, reason: row.reason } });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'activity.override_revoked', entityType: 'Activity', entityId: activityId, effectKey: 'activity.override_revoked', dispatch: {} });
        return { resultRef: overrideId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
