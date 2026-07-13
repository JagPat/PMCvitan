import {
  Inject, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { resolveProjectNode } from '../nodes/node-scope';
import { resolveProjectRef } from '../common/project-ref';
import { resolveActor } from '../common/actor';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, fromIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateInspectionInput, DecideReviewInput, SubmitInspectionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

/** Corrective work is executed by these roles — a reinspection assignee must hold one
 *  as an ACTIVE membership (a PMC may assign themselves EXPLICITLY; see decide()). */
const CORRECTIVE_ROLES = ['engineer', 'contractor'];

/** Default correction window: decide-day + N civil days (PMC-overridable per decide). */
const DEFAULT_DUE_IN_DAYS = 3;

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** PMC issues a stage checklist — becomes the engineer's current field checklist.
   *  Task 4: may carry the explicit Activity REQUIREMENT EDGE it accepts. */
  async create(projectId: string, input: CreateInspectionInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    // Location spine: validate the place this check happens belongs to this project.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    // The requirement edge must name THIS project's activity (composite FK is the backstop).
    const activityId = await resolveProjectRef(this.prisma, 'activity', projectId, input.activityId, 'activityId');
    // DATA-01: ids are globally unique — scan every project, not just this one (see decisions.service).
    const existing = await this.prisma.inspection.findMany({ select: { id: true } });
    const id = nextSeqId('INSP-', existing.map((i) => i.id));
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone); // real civil date in the project's zone
    await this.prisma.$transaction([
      this.prisma.inspection.create({
        data: { id, projectId, kind: 'checklist', title: input.title, zone: input.zone, nodeId, activityId, date: ddMmmYyyy(fromIsoCivilDate(today)!), inspectionDate: fromIsoCivilDate(today), submitted: false, decided: false },
      }),
      ...input.items.map((name, i) =>
        this.prisma.inspectionItem.create({ data: { inspectionId: id, name, order: i, photos: 0, note: '' } }),
      ),
      this.prisma.notification.create({ data: { projectId, text: `New checklist issued: ${input.title} — ${input.zone}`, color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'inspection.create', entity: 'Inspection', entityId: id } }),
    ]);
    // the engineer fills it in the field
    this.realtime.notifyChanged(projectId, `New checklist: ${input.title} — ${input.zone}`, ['engineer']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer submits the checklist. Task 4: every FAILED item must carry at least one
   *  LINKED Media evidence row — the photos counter is a display derivative, never proof.
   *  The submit itself is a CAS (one winner) and stamps the submitter's real identity. */
  async submit(projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser): Promise<SnapshotDto> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);

    // P2-3: guard the state machine. A submitted inspection is in the PMC's review
    // queue (or already decided) — resubmitting would silently rewrite what's under
    // review, so refuse. And validate against the ISSUED checklist, not just whatever
    // items the request carries.
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');
    if (insp.submitted) throw new BadRequestException('This checklist has already been submitted and is awaiting review.');
    if (insp.items.length === 0) throw new BadRequestException('This inspection has no checklist items to submit.');

    const actor = await resolveActor(this.prisma, user);
    const submitted = new Map(input.items.map((it) => [it.name, it]));
    const unmarked = insp.items.filter((dbIt) => !submitted.get(dbIt.name)?.state);
    if (unmarked.length > 0) throw new BadRequestException(`Please mark all ${insp.items.length} items before submitting.`);

    // THE EVIDENCE RULE: a fail is a claim about the work — it needs a photo that is a
    // LINKED Media row on this exact item (containment-chained), not a counter.
    const failItemIds = insp.items.filter((dbIt) => submitted.get(dbIt.name)!.state === 'fail').map((dbIt) => dbIt.id);
    if (failItemIds.length > 0) {
      const evidenced = await this.prisma.media.groupBy({
        by: ['inspectionItemId'],
        where: { projectId, inspectionId, inspectionItemId: { in: failItemIds } },
      });
      const covered = new Set(evidenced.map((e) => e.inspectionItemId));
      const missing = insp.items.filter((dbIt) => failItemIds.includes(dbIt.id) && !covered.has(dbIt.id));
      if (missing.length > 0) {
        throw new BadRequestException(`A failed item needs linked photo evidence before you can submit: ${missing.map((m) => m.name).join(', ')}`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // only write items that belong to this inspection (updateMany by inspectionId+name)
      for (const dbIt of insp.items) {
        const s = submitted.get(dbIt.name)!;
        await tx.inspectionItem.updateMany({ where: { inspectionId, name: dbIt.name }, data: { state: s.state, photos: s.photos, note: s.note } });
      }
      // CAS: one submit wins; a concurrent submit/decide makes count 0 → 409
      const { count } = await tx.inspection.updateMany({
        where: { id: inspectionId, projectId, submitted: false, decided: false },
        data: { submitted: true, by: actor.actorName, submittedById: actor.actorId, submittedByName: actor.actorName },
      });
      if (count === 0) throw new ConflictException('The inspection changed while submitting — reload and retry');
      await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'inspection.submit', entity: 'Inspection', entityId: inspectionId } });
    });
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC approves the inspection, or REJECTS it — creating exactly ONE linked
   *  reinspection (fresh items, inherited activityId, eligible assignee, real due
   *  date) in the same transaction. Both paths are CAS transitions with attribution.
   *
   *  Phase 1 Task 5 — a CLOSING inspection (closing=true) additionally owns its
   *  activity's completion: approval writes `done` + `doneAt` (the PMC's
   *  attributable technical acceptance, same transaction); rejection returns the
   *  activity to execution and assigns the corrective work to the RECORDED
   *  completer — only while that identity is still active and role-eligible. */
  async decide(projectId: string, inspectionId: string, input: DecideReviewInput, user: AuthUser): Promise<SnapshotDto> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);
    // P2-3: a decision is terminal — don't let it be re-decided. Must be submitted first.
    if (!insp.submitted) throw new BadRequestException('This inspection has not been submitted yet.');
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');

    const actor = await resolveActor(this.prisma, user);
    // the activity a CLOSING inspection signs off (null for ordinary inspections)
    const activity = insp.closing && insp.activityId
      ? await this.prisma.activity.findUnique({ where: { id: insp.activityId } })
      : null;
    let pushBody: string;
    let pushRoles: string[];

    if (input.approve) {
      pushBody = activity
        ? `Signed off: ${activity.name} is complete.`
        : 'Inspection approved. Contractor and client notified.';
      pushRoles = ['contractor', 'client'];
      const project = activity ? await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } }) : null;
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.inspection.updateMany({
          where: { id: inspectionId, projectId, submitted: true, decided: false },
          data: { decided: true, decidedById: actor.actorId, decidedByName: actor.actorName },
        });
        if (count === 0) throw new ConflictException('The inspection changed while deciding — reload and retry');
        if (activity) {
          // approving the closing inspection IS the completion: awaiting_signoff → done,
          // stamping the sign-off civil day. CAS — a concurrent reject cannot half-win.
          const today = this.clock.today(project!.timeZone);
          const done = await tx.activity.updateMany({
            where: { id: activity.id, projectId, status: 'awaiting_signoff' },
            data: { status: 'done', doneAt: fromIsoCivilDate(today) },
          });
          if (done.count === 0) {
            // the one legitimate non-awaiting state: a LEGACY activity that was already
            // done before sign-off control existed — record the sign-off day, never re-transition
            const row = await tx.activity.findUnique({ where: { id: activity.id }, select: { status: true, doneAt: true } });
            if (row?.status !== 'done') throw new ConflictException('The activity changed while signing off — reload and retry');
            if (!row.doneAt) await tx.activity.update({ where: { id: activity.id }, data: { doneAt: fromIsoCivilDate(today) } });
          }
          await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'activity.signoff', entity: 'Activity', entityId: activity.id, payload: { closingInspectionId: inspectionId } } });
        }
        await tx.notification.create({ data: { projectId, text: pushBody, color: '#3F7A54', time: 'just now' } });
        await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'inspection.approve', entity: 'Inspection', entityId: inspectionId } });
      });
    } else {
      const rejectedItems = insp.items.filter((it) => input.rejectedItemNames.includes(it.name) || it.rejected || it.result === 'FAIL');
      // a LEGACY zero-item closing may still be rejected (special-cased on the closing
      // flag) — every ordinary rejection must name real items
      if (rejectedItems.length === 0 && !insp.closing) throw new BadRequestException('No items rejected. Use approve instead.');

      // WHO corrects the work: the explicit assignee, else the RECORDED completion
      // claimant (closing) / the recorded submitter (ordinary). Either way they must
      // hold an ACTIVE corrective-role membership — removal or a role change since
      // the claim voids the default, and a PMC may only take the work by naming
      // themselves EXPLICITLY. The eligibility CHECK itself runs INSIDE the
      // transaction below (Codex Task 5 gate P1) — only the candidate's identity
      // is derived here.
      const defaultAssignee = insp.closing ? activity?.completionRequestedById : insp.submittedById;
      const assigneeId = input.assigneeId ?? defaultAssignee;
      if (!assigneeId) {
        throw new BadRequestException(
          insp.closing
            ? 'This closing inspection has no recorded completer to assign — name an eligible assignee (an active engineer or contractor).'
            : 'No assignee could be derived — name an eligible assignee (an active engineer or contractor).',
        );
      }

      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const today = this.clock.today(project.timeZone);
      const dueIso = addCivilDays(today, input.dueInDays ?? DEFAULT_DUE_IN_DAYS);
      const dueDate = fromIsoCivilDate(dueIso)!;
      const existingIds = await this.prisma.inspection.findMany({ select: { id: true } });
      const childId = nextSeqId('INSP-', existingIds.map((i) => i.id));
      // a zero-item legacy closing still yields WORKABLE corrective items — the child
      // gets the default sign-off item (an inspection without items cannot be submitted)
      const childItems = rejectedItems.length > 0 ? rejectedItems.map((it) => it.name) : ['Work complete and acceptable'];

      pushBody = `Re-inspection ${childId} created for ${childItems.length} item(s) — due ${ddMmmYyyy(dueDate)}.`;
      pushRoles = ['engineer']; // the assignee performs the re-inspection

      try {
        await this.prisma.$transaction(async (tx) => {
          // The assignee must be eligible AT COMMIT TIME (Codex Task 5 gate P1):
          // the membership row is read LOCKED inside THIS transaction, so a
          // concurrent removal/role change has a defined order — it either commits
          // first (this rejection refuses with no side effects) or waits behind
          // this commit. Validated FIRST, before any write.
          const [membership] = await tx.$queryRaw<Array<{ status: string; role: string }>>(
            Prisma.sql`SELECT "status", "role" FROM "Membership" WHERE "projectId" = ${projectId} AND "userId" = ${assigneeId} FOR UPDATE`,
          );
          const pmcSelfExplicit = input.assigneeId === user.sub && user.role === 'pmc' && membership?.role === 'pmc';
          const eligible = membership?.status === 'active' && (CORRECTIVE_ROLES.includes(membership.role) || pmcSelfExplicit);
          if (!eligible) {
            throw new BadRequestException(
              input.assigneeId === undefined
                ? 'The recorded completer no longer holds an ACTIVE engineer or contractor membership on this project — name an explicit eligible assignee.'
                : 'The assignee must hold an ACTIVE engineer or contractor membership on this project (a PMC may assign themselves explicitly).',
            );
          }
          // CAS: one decision wins; the loser gets a deterministic 409
          const { count } = await tx.inspection.updateMany({
            where: { id: inspectionId, projectId, submitted: true, decided: false },
            data: { decided: true, decidedById: actor.actorId, decidedByName: actor.actorName },
          });
          if (count === 0) throw new ConflictException('The inspection changed while deciding — reload and retry');
          for (const name of input.rejectedItemNames) {
            await tx.inspectionItem.updateMany({ where: { inspectionId, name }, data: { rejected: true } });
          }
          // the LINKED reinspection: only the rejected work returns, fresh and unfilled;
          // the requirement edge is INHERITED — it accepts the same work. NOT itself a
          // closing (closing=false): sign-off is re-claimed via complete() once corrected.
          await tx.inspection.create({
            data: {
              id: childId,
              projectId,
              kind: 'checklist',
              title: `Re-inspection: ${insp.title}`,
              zone: insp.zone,
              nodeId: insp.nodeId,
              activityId: insp.activityId,
              reinspectionOfId: inspectionId,
              assigneeId,
              dueDate,
              date: ddMmmYyyy(fromIsoCivilDate(today)!),
              inspectionDate: fromIsoCivilDate(today),
              submitted: false,
              decided: false,
              items: { create: childItems.map((name, i) => ({ name, order: i, photos: 0, note: '' })) },
            },
          });
          if (activity) {
            // rejecting the sign-off returns the activity to EXECUTION. `done` is included
            // for legacy closings: reopening a pre-Task-5 done activity here is the PMC's
            // attributable decision, never a migration guess.
            const revert = await tx.activity.updateMany({
              where: { id: activity.id, projectId, status: { in: ['awaiting_signoff', 'done'] } },
              data: { status: 'in_progress', doneAt: null },
            });
            if (revert.count === 0) throw new ConflictException('The activity changed while rejecting the sign-off — reload and retry');
            await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'activity.signoff_rejected', entity: 'Activity', entityId: activity.id, payload: { closingInspectionId: inspectionId, reinspectionId: childId, assigneeId } } });
          }
          await tx.notification.create({ data: { projectId, text: pushBody, color: '#B23A34', time: 'just now' } });
          await tx.auditLog.create({ data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'inspection.reject', entity: 'Inspection', entityId: inspectionId, payload: { reinspectionId: childId, assigneeId, dueDate: dueIso } } });
        });
      } catch (e) {
        // the one-reinspection-child index fired — a concurrent reject already created it
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('This inspection was already decided — reload and retry');
        }
        throw e;
      }
    }
    this.realtime.notifyChanged(projectId, pushBody, pushRoles);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
