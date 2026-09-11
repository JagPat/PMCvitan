import {
  Inject, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { resolveProjectNode } from '../nodes/node-scope';
import { rethrowActivityRefViolation } from '../common/project-ref';
import { resolveActor } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, fromIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateInspectionInput, DecideReviewInput, SubmitInspectionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { ActivityParticipant } from '../activities/activity.participant';
import {
  CORRECTIVE_ROLES, CORRECTIVE_ROLES_PHRASE, assignmentStillBinds, holdsCorrectiveRole,
} from './assignment-eligibility';
import { OrgsParticipant } from '../orgs/orgs.participant';

/** The corrective-assignment rule lives in ONE module ({@link assignment-eligibility}) and every site
 *  that asks about a named assignee calls it. Re-exported here because `inspections.contract.test.ts`
 *  and the service's own refusal prose have always named it through this file, and the pin those tests
 *  make is on the VALUE, not on where it is imported from. */
export { CORRECTIVE_ROLES } from './assignment-eligibility';

/** ONE refusal sentence for the binding-assignment rule. Stated once because the rule is now checked
 *  twice on the submit path — an early read for a friendly 403, and the authoritative re-read inside
 *  the transaction — and two hand-written copies would eventually tell the caller two things. */
const ASSIGNED_TO_SOMEONE_ELSE = 'This inspection is assigned to someone else — only its assignee can submit it.';

/** Default correction window: decide-day + N civil days (PMC-overridable per decide). */
const DEFAULT_DUE_IN_DAYS = 3;

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
    @Inject(CLOCK) private readonly clock: Clock,
    // Task 7 — the activities module's workflow participant: a CLOSING inspection's
    // decision writes the linked activity's sign-off/revert THROUGH it (edges 2/3), so
    // the Activity write stays in the activities module while this decision orchestrates
    // it in ONE transaction with the inspection CAS.
    private readonly activities: ActivityParticipant,
    // #571 round 8, finding 3 — `Membership` is orgs-owned, so the question "does this assignment
    // still bind?" is asked of its OWNER through the cycle-exempt participant channel, never of the
    // table. The manifest declares the `orgs` workflow-participant edge for exactly this.
    private readonly orgs: OrgsParticipant,
  ) {}

  /** PMC issues a stage checklist — becomes the engineer's current field checklist.
   *  Task 4: may carry the explicit Activity REQUIREMENT EDGE it accepts.
   *  Idempotent under `idempotencyKey` (Task 5 ledger): a retried issue (network retry / offline
   *  replay / double-tap) reserves→creates→receipts in ONE transaction, so it applies exactly once,
   *  and a keyed REPLAY short-circuits BEFORE any validation or id-mint. */
  async create(projectId: string, input: CreateInspectionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      title: input.title, zone: input.zone, nodeId: input.nodeId ?? null, activityId: input.activityId ?? null, items: input.items,
    });
    // A keyed replay returns the current snapshot without re-validating or minting a second id.
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.create', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    // Location spine: validate the place this check happens belongs to this project.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    // The requirement edge must name THIS project's activity. Task 10 (Module 4): activity is
    // read-encapsulated and this module sits UPSTREAM of activities in dependsOn, so the composite
    // `(projectId, activityId)` tenant FK is the validation authority — its violation is translated
    // to the same readable 400 below (`rethrowActivityRefViolation`).
    const activityId = input.activityId ?? null;
    // DATA-01: ids are globally unique — scan every project, not just this one (see decisions.service).
    const existing = await this.prisma.inspection.findMany({ select: { id: true } });
    const id = nextSeqId('INSP-', existing.map((i) => i.id));
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const today = this.clock.today(project.timeZone); // real civil date in the project's zone
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.create', idempotencyKey, requestHash,
      run: async (tx) => {
        // a LINKED requirement appears the moment it exists — a readiness write (finding 1)
        await lockProjectReadiness(tx, projectId);
        // a foreign/unknown activityId trips the composite tenant FK — translated to the readable 400
        await tx.inspection.create({
          data: { id, projectId, kind: 'checklist', title: input.title, zone: input.zone, nodeId, activityId, date: ddMmmYyyy(fromIsoCivilDate(today)!), inspectionDate: fromIsoCivilDate(today), submitted: false, decided: false },
        }).catch((e) => rethrowActivityRefViolation(e));
        for (const [i, name] of input.items.entries()) {
          await tx.inspectionItem.create({ data: { inspectionId: id, name, order: i, photos: 0, note: '' } });
        }
        await tx.notification.create({ data: { projectId, text: `New checklist issued: ${input.title} — ${input.zone}`, color: '#C08A2D', time: 'just now' } });
        await recordAudit(tx, { projectId, actor, action: 'inspection.create', entity: 'Inspection', entityId: id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'inspection.created', entityType: 'Inspection', entityId: id, payload: { title: input.title, zone: input.zone }, effectKey: 'inspection.created', dispatch: { push: { body: `New checklist: ${input.title} — ${input.zone}` } } });
        return { resultRef: id, events: [ev] };
      },
    });
    // the engineer fills it in the field
    await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer submits the checklist. Task 4: every FAILED item must carry at least one
   *  LINKED Media evidence row — the photos counter is a display derivative, never proof.
   *  The submit itself is a CAS (one winner) and stamps the submitter's real identity. */
  async submit(projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ inspectionId, items: input.items });
    // A keyed replay returns the current snapshot without re-running the state-machine guards — so a
    // retry of an already-committed submit replays cleanly instead of hitting "already submitted".
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.submit', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);

    // P2-3: guard the state machine. A submitted inspection is in the PMC's review
    // queue (or already decided) — resubmitting would silently rewrite what's under
    // review, so refuse. And validate against the ISSUED checklist, not just whatever
    // items the request carries.
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');
    if (insp.submitted) throw new BadRequestException('This checklist has already been submitted and is awaiting review.');
    // ASSIGNED work is submitted by its assignee and nobody else. A re-inspection is named corrective
    // work — its assignee defaults to whoever submitted the rejected inspection — and the submitter is
    // recorded as the person who did it, so letting a second engineer submit it would put the wrong
    // name on somebody's remedial work. No PMC exemption: the reject path's own rule is that a PMC
    // takes the work by naming THEMSELVES the assignee (`pmcSelfExplicit`), which this then honours.
    //
    // Every role `decide` may assign can reach this route (CORRECTIVE_ROLES is a subset of the
    // `inspection.submit` ceiling, pinned in CI), so an assigned inspection always has exactly one
    // caller who can submit it and no assignment can dead-end. An UNASSIGNED checklist is unchanged —
    // the role gate on the route is the whole guard, as before.
    //
    // The assignment binds ONLY WHILE ITS ASSIGNEE CAN STILL DO THE WORK — `bindingAssigneeIds`, the
    // one statement of that rule, which the READ boundary calls with the same argument so a checklist
    // this will accept from engineer B is exactly the checklist B can open (#571 round 7, finding 1).
    //
    // THIS COPY IS THE EARLY, FRIENDLY ANSWER, NOT THE AUTHORITY. It reads outside the transaction so
    // a refusal is a 403 with a sentence in it rather than a conflict raised from inside a command,
    // and it can be stale by the time the write lands: `MembersService.add`/`updateRole` take the
    // project's readiness key and can reactivate the assignee between this read and the CAS, which
    // pins only the unchanged `assigneeId` (#571 round 7, finding 2). The BINDING check is re-taken
    // below, inside the transaction and after `lockProjectReadiness`, where no membership change can
    // interleave. Both call the same function, so the two can only disagree about TIME.
    if (insp.assigneeId && insp.assigneeId !== user.sub) {
      if (await assignmentStillBinds(this.orgs, this.prisma, projectId, insp.assigneeId)) {
        throw new ForbiddenException(ASSIGNED_TO_SOMEONE_ELSE);
      }
    }
    if (insp.items.length === 0) throw new BadRequestException('This inspection has no checklist items to submit.');

    // gate finding 3: the payload addresses ROWS by id — labels are not unique.
    // Containment first: an id that is not one of THIS inspection's items is a
    // refused claim, never silently ignored (it could be another inspection's row).
    const submitted = new Map(input.items.map((it) => [it.id, it]));
    const known = new Set(insp.items.map((dbIt) => dbIt.id));
    const foreign = input.items.filter((it) => !known.has(it.id));
    if (foreign.length > 0) throw new BadRequestException('Submitted item(s) do not belong to this inspection — reload and retry.');
    const unmarked = insp.items.filter((dbIt) => !submitted.get(dbIt.id)?.state);
    if (unmarked.length > 0) throw new BadRequestException(`Please mark all ${insp.items.length} items before submitting.`);

    // THE EVIDENCE RULE: a fail is a claim about the work — it needs a photo that is a
    // LINKED Media row on this exact item (containment-chained), not a counter.
    const failItemIds = insp.items.filter((dbIt) => submitted.get(dbIt.id)!.state === 'fail').map((dbIt) => dbIt.id);
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

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.submit', idempotencyKey, requestHash,
      run: async (tx) => {
        // submission moves the linked chain's tip state — a readiness write (finding 1)
        await lockProjectReadiness(tx, projectId);
        // The inspection row BEFORE the membership row, the one order every inspection path takes
        // (#571 round 12, finding 1). Round 12 settled this order at the evidence fence, in the
        // participant and in `decide`, and an audit of the remaining writers found SUBMIT still
        // taking them the other way round: the binding check below locks `Membership` first, and
        // the CAS at the end is what locks the inspection. That is the inversion the round-12 fix
        // exists to remove, one writer short of removing it. Locking here costs nothing — this
        // transaction updates the row regardless — and the CAS on `assigneeId` stays exactly as it
        // was, because it is what makes the observed-unassigned case precise for the READER.
        await tx.$executeRaw`SELECT 1 FROM "Inspection" WHERE "id" = ${inspectionId} AND "projectId" = ${projectId} FOR UPDATE`;
        // THE AUTHORITATIVE BINDING CHECK (#571 round 7, finding 2). The guard before the transaction
        // reads memberships unlocked, so its answer can be overtaken: `MembersService.add`/`updateRole`
        // take THIS key before they write, so an assignee observed ineligible there can be reactivated
        // as an engineer and committed while this command is still assembling — and the CAS below pins
        // only `assigneeId`, which such a reactivation never touches. The submitter would then be
        // recorded against work the rule had just made exclusive again.
        //
        // Re-taken HERE, under the key, that interleaving cannot happen: every membership change to
        // this project is serialized against this transaction, so whichever order they take, the two
        // agree about who held the work at commit. Same function as the early guard and the read
        // boundary — one rule, asked at the moment the answer is written down.
        if (insp.assigneeId && insp.assigneeId !== user.sub) {
          // `forUpdate` locks the standing rows the answer rests on, so a re-role or reactivation
          // of the existing membership waits for this transaction — the owner's own lock, on top of
          // the readiness key already held above.
          if (await assignmentStillBinds(this.orgs, tx, projectId, insp.assigneeId, { forUpdate: true })) {
            throw new ForbiddenException(ASSIGNED_TO_SOMEONE_ELSE);
          }
        }
        // write each ROW its own result — (id, inspectionId) keeps containment even
        // against a raced id (gate finding 3: never keyed by non-unique name)
        for (const dbIt of insp.items) {
          const s = submitted.get(dbIt.id)!;
          await tx.inspectionItem.updateMany({ where: { id: dbIt.id, inspectionId }, data: { state: s.state, photos: s.photos, note: s.note } });
        }
        // CAS: one submit wins; a concurrent submit/decide makes count 0 → 409.
        //
        // `assigneeId` is in the predicate because the guard above read it OUTSIDE this
        // transaction, and the value can legitimately change in between: the freeze trigger is a
        // one-way LATCH, so `null → someone` is permitted (it is assignment, not reassignment).
        // Without this arm an unassigned checklist that acquires an assignee after the guard runs
        // would keep that assignment and record a DIFFERENT person as its submitter — the exact
        // misattribution the guard exists to prevent, reached by racing it rather than by passing
        // it. Prisma renders `assigneeId: null` as `IS NULL`, so the observed-unassigned case is
        // pinned as precisely as the observed-assigned one, and a change either way makes count 0.
        const { count } = await tx.inspection.updateMany({
          where: { id: inspectionId, projectId, submitted: false, decided: false, assigneeId: insp.assigneeId },
          data: { submitted: true, by: actor.actorName, submittedById: actor.actorId, submittedByName: actor.actorName },
        });
        if (count === 0) throw new ConflictException('The inspection changed while submitting — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'inspection.submit', entity: 'Inspection', entityId: inspectionId });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'inspection.submitted', entityType: 'Inspection', entityId: inspectionId, effectKey: 'inspection.submitted', dispatch: {} });
        return { resultRef: inspectionId, events: [ev] };
      },
    });
    await this.dispatcher.dispatchCommitted(outcome.events);
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
  async decide(projectId: string, inspectionId: string, input: DecideReviewInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      inspectionId, approve: input.approve, rejectedItemIds: input.rejectedItemIds,
      assigneeId: input.assigneeId ?? null, dueInDays: input.dueInDays ?? null,
    });
    // A keyed replay returns the current snapshot without re-running the terminal guards — a retry of an
    // already-committed decide replays cleanly instead of hitting "already decided".
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.decide', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);
    // P2-3: a decision is terminal — don't let it be re-decided. Must be submitted first.
    if (!insp.submitted) throw new BadRequestException('This inspection has not been submitted yet.');
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');

    // The activity a CLOSING inspection signs off (null for ordinary inspections) — read through the
    // activities WORKFLOW PARTICIPANT (Task 10 Module 4: inspections never reads `prisma.activity`
    // directly; the participant is the cycle-exempt channel). The name here is fast pre-validation
    // display only — the in-transaction sign-off methods return the authoritative TX-CURRENT name.
    const activity = insp.closing && insp.activityId
      ? await this.activities.signOffTarget(this.prisma, { projectId, activityId: insp.activityId })
      : null;
    // The push body still drives the in-transaction Notification row + the emit dispatch body; the
    // TARGET ROLES come from the external-effect catalog (per effectKey), not a local variable. The
    // approve branch builds its body INSIDE the transaction (tx-current activity name).
    // Every emit this command commits, in causal order, handed to the single sender post-commit. A
    // multi-event decide (approve+signoff, reject+reinspection+signoff-reversal) invalidates the
    // socket ONCE (the dispatcher dedups per project) and pushes exactly the one body-bearing event.
    let events: EmittedEventMeta[];

    if (input.approve) {
      const project = activity ? await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } }) : null;
      const outcome = await executeCommand(this.prisma, {
        scope, actor, commandType: 'inspections.decide', idempotencyKey, requestHash,
        run: async (tx) => {
          // deciding closes the linked chain's tip — a readiness write (finding 1)
          await lockProjectReadiness(tx, projectId);
          const { count } = await tx.inspection.updateMany({
            where: { id: inspectionId, projectId, submitted: true, decided: false },
            data: { decided: true, decidedById: actor.actorId, decidedByName: actor.actorName },
          });
          if (count === 0) throw new ConflictException('The inspection changed while deciding — reload and retry');
          // the body the notification + push carry — for a closing sign-off it is rebuilt from the
          // TX-CURRENT activity name the participant returns (R2-F2 pattern: never a stale
          // pre-transaction read)
          let body = 'Inspection approved. Contractor and client notified.';
          if (activity) {
            // approving the closing inspection IS the completion (edge 2): awaiting_signoff
            // → done, stamping the sign-off civil day, via the activities participant so the
            // Activity write lives in its owning module. CAS — a concurrent reject cannot
            // half-win; a legacy already-`done` activity just gets its sign-off day recorded.
            const signedOff = await this.activities.applySignOff(tx, { projectId, activityId: activity.id, doneOn: fromIsoCivilDate(this.clock.today(project!.timeZone)) });
            body = `Signed off: ${signedOff.name} is complete.`;
            await recordAudit(tx, { projectId, actor, action: 'activity.signoff', entity: 'Activity', entityId: activity.id, payload: { closingInspectionId: inspectionId } });
          }
          await tx.notification.create({ data: { projectId, text: body, color: '#3F7A54', time: 'just now' } });
          await recordAudit(tx, { projectId, actor, action: 'inspection.approve', entity: 'Inspection', entityId: inspectionId });
          const approved = await emitEvent(tx, { projectId, actor, eventType: 'inspection.approved', entityType: 'Inspection', entityId: inspectionId, effectKey: activity ? 'inspection.approved.closing' : 'inspection.approved', dispatch: activity ? {} : { push: { body } } });   // #582 round 18, finding 3 — the CLOSING branch announces through activity.signed_off and has its own key
          const localEvents: EmittedEventMeta[] = [approved];
          // A CLOSING inspection's approval CAUSES the activity sign-off — one causal chain.
          if (activity) localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'activity.signed_off', entityType: 'Activity', entityId: activity.id, causedByEventId: approved.eventId, payload: { closingInspectionId: inspectionId }, effectKey: 'activity.signed_off', dispatch: { push: { body } } }));
          return { resultRef: inspectionId, events: localEvents };
        },
      });
      events = outcome.events;
    } else {
      // gate finding 3: rejection names exact ROWS. An id that matches none of this
      // inspection's items is a refused claim (it could be another inspection's row).
      const unknownRejected = input.rejectedItemIds.filter((id) => !insp.items.some((it) => it.id === id));
      if (unknownRejected.length > 0) throw new BadRequestException('Rejected item(s) do not belong to this inspection — reload and retry.');
      const rejectedItems = insp.items.filter((it) => input.rejectedItemIds.includes(it.id) || it.rejected || it.result === 'FAIL');
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
            ? `This closing inspection has no recorded completer to assign — name an eligible assignee (${CORRECTIVE_ROLES_PHRASE}).`
            : `No assignee could be derived — name an eligible assignee (${CORRECTIVE_ROLES_PHRASE}).`,
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

      const pushBody = `Re-inspection ${childId} created for ${childItems.length} item(s) — due ${ddMmmYyyy(dueDate)}.`;

      const outcome = await executeCommand(this.prisma, {
        scope, actor, commandType: 'inspections.decide', idempotencyKey, requestHash,
        run: async (tx) => {
         try {
          // rejection opens a linked correction chain — a readiness write (finding 1);
          // the readiness lock precedes the membership row lock (uniform order)
          await lockProjectReadiness(tx, projectId);
          // The inspection row BEFORE the membership row — the one order every path through
          // inspection evidence and assignment takes (#571 round 12, finding 1). This transaction
          // updates the row below anyway; taking its lock here rather than there is what keeps a
          // service decide from deadlocking against the evidence fence, which must lock the
          // inspection first because its early return on an absent assignment is what a concurrent
          // `null → A` races.
          await tx.$executeRaw`SELECT 1 FROM "Inspection" WHERE "id" = ${inspectionId} AND "projectId" = ${projectId} FOR UPDATE`;
          // The assignee must be eligible AT COMMIT TIME (Codex Task 5 gate P1):
          // the membership row is read LOCKED inside THIS transaction, so a
          // concurrent removal/role change has a defined order — it either commits
          // first (this rejection refuses with no side effects) or waits behind
          // this commit. Validated FIRST, before any write.
          const [membership] = await tx.$queryRaw<Array<{ status: string; role: string }>>(
            Prisma.sql`SELECT "status", "role" FROM "Membership" WHERE "projectId" = ${projectId} AND "userId" = ${assigneeId} FOR UPDATE`,
          );
          const pmcSelfExplicit = input.assigneeId === user.sub && user.role === 'pmc' && membership?.role === 'pmc';
          // `holdsCorrectiveRole` is the SAME predicate the submit guard and the read boundary apply,
          // so assignment-time and binding-time can never drift apart. The one difference is stated
          // rather than duplicated: a PMC naming THEMSELVES is admitted HERE, because that is a rule
          // about who may be written down, not about whether the written name excludes everyone else.
          // Their assignment binds nobody afterwards — they hold no checklist screen — which is why
          // the submit and read sites deliberately do not repeat this arm.
          const eligible = holdsCorrectiveRole(membership) || (membership?.status === 'active' && pmcSelfExplicit);
          if (!eligible) {
            throw new BadRequestException(
              input.assigneeId === undefined
                ? `The recorded completer no longer holds ${CORRECTIVE_ROLES_PHRASE} membership on this project — name an explicit eligible assignee.`
                : `The assignee must hold ${CORRECTIVE_ROLES_PHRASE} membership on this project (a PMC may assign themselves explicitly).`,
            );
          }
          // CAS: one decision wins; the loser gets a deterministic 409
          const { count } = await tx.inspection.updateMany({
            where: { id: inspectionId, projectId, submitted: true, decided: false },
            data: { decided: true, decidedById: actor.actorId, decidedByName: actor.actorName },
          });
          if (count === 0) throw new ConflictException('The inspection changed while deciding — reload and retry');
          for (const itemId of input.rejectedItemIds) {
            await tx.inspectionItem.updateMany({ where: { id: itemId, inspectionId }, data: { rejected: true } });
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
            // rejecting the sign-off returns the activity to EXECUTION (edge 3), via the
            // activities participant so the Activity write lives in its owning module.
            // `done` is included for legacy closings: reopening a pre-Task-5 done activity
            // here is the PMC's attributable decision, never a migration guess.
            await this.activities.revertSignOff(tx, { projectId, activityId: activity.id });
            await recordAudit(tx, { projectId, actor, action: 'activity.signoff_rejected', entity: 'Activity', entityId: activity.id, payload: { closingInspectionId: inspectionId, reinspectionId: childId, assigneeId } });
          }
          await tx.notification.create({ data: { projectId, text: pushBody, color: '#B23A34', time: 'just now' } });
          await recordAudit(tx, { projectId, actor, action: 'inspection.reject', entity: 'Inspection', entityId: inspectionId, payload: { reinspectionId: childId, assigneeId, dueDate: dueIso } });
          // The rejection CAUSES both the linked reinspection and (for a closing) the sign-off reversal.
          const rejected = await emitEvent(tx, { projectId, actor, eventType: 'inspection.rejected', entityType: 'Inspection', entityId: inspectionId, payload: { reinspectionId: childId, assigneeId }, effectKey: 'inspection.rejected', dispatch: {} });
          const localEvents: EmittedEventMeta[] = [rejected];
          localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'inspection.reinspection_created', entityType: 'Inspection', entityId: childId, causedByEventId: rejected.eventId, payload: { reinspectionOf: inspectionId, assigneeId }, effectKey: 'inspection.reinspection_created', dispatch: { push: { body: pushBody } } }));
          if (activity) localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'activity.signoff_rejected', entityType: 'Activity', entityId: activity.id, causedByEventId: rejected.eventId, payload: { closingInspectionId: inspectionId, reinspectionId: childId }, effectKey: 'activity.signoff_rejected', dispatch: {} }));
          return { resultRef: inspectionId, events: localEvents };
         } catch (e) {
          // the one-reinspection-child index fired — a concurrent reject already created it. Convert it
          // to the domain 409 INSIDE `run`, so the ledger's own reservation-P2002 handling (a different
          // index) never mistakes this for a concurrent-key conflict.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('This inspection was already decided — reload and retry');
          }
          throw e;
         }
        },
      });
      events = outcome.events;
    }
    await this.dispatcher.dispatchCommitted(events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
