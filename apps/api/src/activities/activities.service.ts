import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
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

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
    @Inject(CLOCK) private readonly clock: Clock,
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
      const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
      if (!d || d.projectId !== projectId) throw new BadRequestException('Unknown decision for this project');
    }
    // Location spine: resolveProjectNode throws for an unknown/cross-project node.
    await resolveProjectNode(this.prisma, projectId, nodeId);
  }

  /** PMC plans a new activity (name, zone, planned window, gates, phase/decision links). */
  async create(projectId: string, input: CreateActivityInput, user: AuthUser): Promise<SnapshotDto> {
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
    await this.prisma.$transaction([
      this.prisma.activity.create({
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
    await this.prisma.$transaction(async (tx) => {
      // stored material/team flags and the decision link move readiness (finding 1)
      await lockProjectReadiness(tx, projectId);
      await tx.activity.update({ where: { id: activityId }, data });
      await tx.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.update', entity: 'Activity', entityId: activityId } });
    });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC removes a planned activity. Refused once field records reference it. */
  async remove(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    try {
      // drawings reference activities through a NO ACTION composite FK — unlink
      // first (a drawing outlives its planned activity), then delete atomically
      await this.prisma.$transaction([
        this.prisma.drawing.updateMany({ where: { projectId, activityId }, data: { activityId: null } }),
        this.prisma.activity.delete({ where: { id: activityId } }),
      ]);
    } catch {
      throw new ConflictException('This activity has linked records (inspections/materials) — it can no longer be deleted');
    }
    await this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.delete', entity: 'Activity', entityId: activityId } });
    this.realtime.notifyChanged(projectId);
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
      db.inspection.findMany({
        where: { projectId, activityId: activity.id },
        include: { items: { select: { rejected: true, result: true } } },
      }),
      db.drawing.findMany({
        where: { projectId, activityId: activity.id },
        include: { revisions: { include: { recipients: { select: { userId: true } }, acks: { select: { userId: true } } } } },
      }),
      db.membership.findMany({ where: { projectId, status: 'active' }, select: { userId: true } }),
      db.gateOverride.findMany({ where: { projectId, activityId: activity.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    return deriveReadiness(activity.id, {
      decisionStatus: activity.decision ? (activity.decision.status as DecisionStatus) : null,
      gateMaterial: activity.gateMaterial,
      gateTeam: activity.gateTeam,
      inspections: inspections.map((i) => ({ id: i.id, activityId: i.activityId, closing: i.closing, submitted: i.submitted, decided: i.decided, reinspectionOfId: i.reinspectionOfId, items: i.items })),
      drawings: drawings.map((d) => ({
        number: d.number,
        activityId: d.activityId,
        draft: d.publishedAt === null,
        revisions: d.revisions.map((r) => ({ status: r.status, recipientsFrozenAt: r.recipientsFrozenAt, recipientIds: r.recipients.map((x) => x.userId), ackedIds: r.acks.map((x) => x.userId) })),
      })),
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
  async start(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    // the actual start is TODAY in the project's time zone — a real civil date,
    // never the prototype's todayDay counter
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    await this.prisma.$transaction(async (tx) => {
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
      await tx.auditLog.create({ data: { projectId, actor: user.role, action: 'activity.start', entity: 'Activity', entityId: activityId } });
    });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** CLAIM completion (Phase 1 Task 5). "Done" means accepted: this parks the
   *  activity in `awaiting_signoff`, records WHO claimed the work finished (an
   *  attributable, membership-validated fact) and creates the LINKED closing
   *  inspection — with a default sign-off item, so it CAN be rejected. Only the
   *  PMC's approval of that closing inspection (inspections.decide) writes `done`. */
  async complete(projectId: string, activityId: string, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    if (a.status !== 'in_progress') throw new ConflictException('Only a running activity can be marked complete');

    const actor = await resolveActor(this.prisma, user);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone);
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    // DATA-01: inspection ids are globally unique — the id-pattern linkage
    // (INSP-<activityId>-close) is RETIRED; `closing` + `activityId` are the facts
    const existingIds = await this.prisma.inspection.findMany({ select: { id: true } });
    const closingId = nextSeqId('INSP-', existingIds.map((i) => i.id));
    try {
      await this.prisma.$transaction(async (tx) => {
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
        await tx.inspection.create({
          // the closing inspection happens at the same place as the work it closes;
          // ONE default item makes rejection possible (a zero-item review could only ever be approved)
          data: {
            id: closingId,
            projectId,
            kind: 'review',
            closing: true,
            activityId,
            title: `Closing inspection: ${a.name}`,
            zone: a.zone,
            nodeId: a.nodeId,
            date: ddMmmYyyy(fromIsoCivilDate(today)!),
            inspectionDate: fromIsoCivilDate(today),
            submitted: true,
            decided: false,
            by: actor.actorName,
            submittedById: actor.actorId,
            submittedByName: actor.actorName,
            items: { create: [{ name: 'Work complete and acceptable', order: 0, photos: 0, note: '' }] },
          },
        });
        await tx.notification.create({ data: { projectId, text: `Sign-off requested: ${a.name} — awaiting the PMC's closing inspection`, color: '#C08A2D', time: 'just now' } });
        await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'activity.complete_requested', entity: 'Activity', entityId: activityId, payload: { closingInspectionId: closingId } } });
      });
    } catch (e) {
      // a concurrent inspection create took the sequential id — a plain retry resolves it
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A concurrent update took this inspection id — retry the completion');
      }
      throw e;
    }
    // the sign-off is the PMC's decision to make
    this.realtime.notifyChanged(projectId, `Sign-off requested: ${a.name}`, ['pmc']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC records a MANUAL readiness exception (Task 6): one gate, one reason,
   *  optional same-project photo evidence, and an expiry that is ALWAYS in the
   *  future — expiry (or early revocation) restores the derivation. Audited. */
  async override(projectId: string, activityId: string, input: OverrideGateInput, user: AuthUser): Promise<SnapshotDto> {
    const a = await this.prisma.activity.findUnique({ where: { id: activityId } });
    if (!a || a.projectId !== projectId) throw new NotFoundException(`Activity ${activityId} not found`);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('An override must expire in the future — it is a temporary exception, never a permanent flag');
    }
    // supporting evidence must be THIS project's photo (composite FK is the backstop)
    const evidenceMediaId = await resolveProjectRef(this.prisma, 'media', projectId, input.evidenceMediaId, 'evidenceMediaId');
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      // an override moves a gate the moment it exists (finding 1)
      await lockProjectReadiness(tx, projectId);
      await tx.gateOverride.create({
        data: { projectId, activityId, gate: input.gate, state: input.state, reason: input.reason, actorId: actor.actorId, actorName: actor.actorName, evidenceMediaId, expiresAt },
      });
      await tx.auditLog.create({
        data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'activity.override', entity: 'Activity', entityId: activityId, payload: { gate: input.gate, state: input.state, reason: input.reason, expiresAt: expiresAt.toISOString(), evidenceMediaId } },
      });
    });
    this.realtime.notifyChanged(projectId, `Gate override on ${a.name}: ${input.gate} → ${input.state} (expires ${ddMmmYyyy(expiresAt)})`, ['engineer', 'contractor']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC revokes an override EARLY — the derivation rules again immediately.
   *  The audit trail keeps the full record of both the override and its end. */
  async revokeOverride(projectId: string, activityId: string, overrideId: string, user: AuthUser): Promise<SnapshotDto> {
    const row = await this.prisma.gateOverride.findUnique({ where: { id: overrideId } });
    if (!row || row.projectId !== projectId || row.activityId !== activityId) {
      throw new NotFoundException(`Override ${overrideId} not found`);
    }
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction(async (tx) => {
      // revoking restores the derivation instantly — a readiness write (finding 1)
      await lockProjectReadiness(tx, projectId);
      await tx.gateOverride.delete({ where: { id: overrideId } });
      await tx.auditLog.create({
        data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'activity.override_revoke', entity: 'Activity', entityId: activityId, payload: { overrideId, gate: row.gate, state: row.state, reason: row.reason } },
      });
    });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
