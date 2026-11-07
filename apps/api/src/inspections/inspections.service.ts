import {
  Inject, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { resolveProjectNode } from '../nodes/node-scope';
import { rethrowActivityRefViolation } from '../common/project-ref';
import { resolveActor, type Actor } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { ddMmmYyyy } from '../domain/dates';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, fromIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateInspectionInput, DecideReviewInput, FinishInspectionInput, SetResponsibleMemberInput, SubmitInspectionInput } from '../contracts';
import { RESPONSIBLE_ROLES, standingMark, standsAsResponsible } from './responsible-member';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import { recordKeySighting } from '../platform/command-key-sighting';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { ActivityParticipant } from '../activities/activity.participant';
import {
  CORRECTIVE_ROLES, CORRECTIVE_ROLES_PHRASE, assignmentStillBinds, holdsCorrectiveRole,
} from './assignment-eligibility';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { MediaParticipant } from '../media/media.participant';
import { SiteVisitInspectionsParticipant } from '../site-visits/site-visit-inspections.participant';
import type { LibraryChecklist } from '../orgs/checklist-library';
import { checklistPath } from '../platform/record-paths';
import { isFailedItem } from './failed-item';
import { guidanceColumnsOf, itemRowFromSpec } from './guided-item';
import { evidenceShortfalls, type SubmittedItem } from './evidence-rule';
import { projectRoleChanged, projectUnavailable } from '../common/lost-project';

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

type InspectionWithItems = Prisma.InspectionGetPayload<{ include: { items: true } }>;

/** What the submit's checks before its transaction hand to its writes (guided step 3a). */
interface SubmitPrep {
  projectId: string;
  inspectionId: string;
  insp: InspectionWithItems;
  submitted: Map<string, SubmitInspectionInput['items'][number]>;
  refuseShortfalls: (db: Prisma.TransactionClient) => Promise<void>;
}

type SignOffTarget = { id: string; name: string; completionRequestedById: string | null } | null;

/** What the decision's checks before its transaction hand to its writes (guided step 3a). */
type DecidePlan =
  | { approve: true; projectId: string; inspectionId: string; activity: SignOffTarget; project: { timeZone: string } | null }
  | {
    approve: false; projectId: string; inspectionId: string; insp: InspectionWithItems; activity: SignOffTarget;
    rejectedItems: InspectionWithItems['items']; assigneeId: string; dueIso: string; dueDate: Date; childId: string;
    childTitle: string; childItems: Array<Record<string, unknown> & { name: string }>; pushBody: string; today: string;
  };

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
    // Guided site inspections, step 2b — the evidence rule asks the media module each linked file's type (manifest edge)
    private readonly media: MediaParticipant,
    // Guided site inspections, step 3c — a walk done on a site visit is recorded on the visit by its owner (manifest edge)
    private readonly visits: SiteVisitInspectionsParticipant,
  ) {}

  /** Guided site inspections, step 2c — the Vitan checklist library this project's PMC picks from (its company's library
   *  checklists, asked of the orgs module). A pick is issued through {@link create} with the entry's title, work type and
   *  items, so the copy is the project's and the library entry stays as it is. */
  async library(projectId: string): Promise<LibraryChecklist[]> {
    return this.orgs.checklistLibrary(this.prisma as unknown as Prisma.TransactionClient, projectId);
  }

  /** PMC issues a stage checklist — becomes the engineer's current field checklist.
   *  Task 4: may carry the explicit Activity REQUIREMENT EDGE it accepts.
   *  Idempotent under `idempotencyKey` (Task 5 ledger): a retried issue (network retry / offline
   *  replay / double-tap) reserves→creates→receipts in ONE transaction, so it applies exactly once,
   *  and a keyed REPLAY short-circuits BEFORE any validation or id-mint. */
  async create(projectId: string, input: CreateInspectionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    // Guided site inspections (step 2a): `workType` joins the hash only when sent, so a retry of a plain checklist issued
    // by the previous release keeps the hash it was reserved under; a guided item is part of `items` either way
    const requestHash = hashRequest({
      title: input.title, zone: input.zone, nodeId: input.nodeId ?? null, activityId: input.activityId ?? null, items: input.items,
      ...(input.workType !== undefined ? { workType: input.workType } : {}),
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
          data: { id, projectId, kind: 'checklist', title: input.title, zone: input.zone, workType: input.workType ?? null, nodeId, activityId, date: ddMmmYyyy(fromIsoCivilDate(today)!), inspectionDate: fromIsoCivilDate(today), submitted: false, decided: false },
        }).catch((e) => rethrowActivityRefViolation(e));
        // each item's guidance goes in its INSERT: the database never lets it be set or changed afterwards (step 1)
        for (const [i, spec] of input.items.entries()) {
          await tx.inspectionItem.create({ data: { inspectionId: id, ...itemRowFromSpec(spec), order: i, photos: 0, note: '' } });
        }
        // live bug 1b-3 — the notice names the checklist it issued by a stamp, never by its text (the title
        // and zone are user text)
        await tx.notification.create({ data: { projectId, text: `New checklist issued: ${input.title} — ${input.zone}`, color: '#C08A2D', time: 'just now', inspectionId: id } });
        await recordAudit(tx, { projectId, actor, action: 'inspection.create', entity: 'Inspection', entityId: id });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'inspection.created', entityType: 'Inspection', entityId: id, payload: { title: input.title, zone: input.zone }, effectKey: 'inspection.created', dispatch: { push: { url: checklistPath(projectId, id), body: `New checklist: ${input.title} — ${input.zone}` } } });
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
  async submit(
    projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser, idempotencyKey?: string, visitId?: string,
  ): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    // the visit joins the hash only when named, so a request without one hashes as before (guided step 3c)
    const requestHash = hashRequest({ inspectionId, items: input.items, ...(visitId ? { visitId } : {}) });
    // A keyed replay returns the current snapshot without re-running the state-machine guards — so a
    // retry of an already-committed submit replays cleanly instead of hitting "already submitted".
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.submit', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const prep = await this.prepareSubmit(projectId, inspectionId, input, user);
    if (visitId) await this.visits.assertMayLink(projectId, visitId, user.sub);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.submit', idempotencyKey, requestHash,
      run: async (tx) => {
        if (visitId) await this.visits.lockForLink(tx, projectId, visitId, user.sub);
        return { resultRef: inspectionId, events: [await this.applySubmit(tx, prep, actor, user, visitId)] };
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
    // Idempotency-Key 2a — count a keyless or legacy-keyed request before anything can refuse it (RUNBOOK §IDK)
    await recordKeySighting(this.prisma, 'inspections.decide', idempotencyKey);
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
    // Items in checklist order (`order`, as every read that shows them): the re-inspection's items are numbered in this order.
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: { orderBy: { order: 'asc' } } } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);
    // P2-3: a decision is terminal — don't let it be re-decided. Must be submitted first.
    if (!insp.submitted) throw new BadRequestException('This inspection has not been submitted yet.');
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');

    const plan = await this.prepareDecide(projectId, insp, input);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.decide', idempotencyKey, requestHash,
      run: async (tx) => ({ resultRef: inspectionId, events: await this.applyDecide(tx, plan, actor, user, input) }),
    });
    await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Guided site inspections step 3a (decision 1) — a PMC checks and decides in ONE walk. The walk's results are submitted
   * and decided by one command in one transaction: the submit's rules (state machine, assignment, every item marked,
   * the evidence rule under the inspection's row lock) and then the decision's. No item failed: the inspection is
   * approved (a closing one signs its activity off). Any item failed: it is rejected with exactly the failed items, and
   * one re-inspection is created with their guidance, assigned to `assigneeId` or, by default, to the PMC who walked it
   * (a PMC taking the re-check names themselves, as decide's rule asks), due in `dueInDays` (default 3).
   *
   * Anyone else's walk is a `submit` and goes to the PMC's review queue, as before. The two halves are the same code
   * `submit` and `decide` run ({@link prepareSubmit}/{@link applySubmit}, {@link prepareDecide}/{@link applyDecide}),
   * so the rules cannot drift; the decision's first event is caused by the walk's `inspection.submitted`. Lock order is
   * the submit's then the decide's, which is the order each already takes: readiness key, inspection row, membership.
   */
  async finish(
    projectId: string, inspectionId: string, input: FinishInspectionInput, user: AuthUser, idempotencyKey?: string, visitId?: string,
  ): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      inspectionId, items: input.items, assigneeId: input.assigneeId ?? null, dueInDays: input.dueInDays ?? null,
      ...(visitId ? { visitId } : {}),
    });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.finish', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const prep = await this.prepareSubmit(projectId, inspectionId, { items: input.items }, user);
    // the decision judges the walk's own results, not the stored (still unmarked) ones
    const walked: InspectionWithItems = {
      ...prep.insp,
      items: prep.insp.items.map((it) => ({ ...it, state: prep.submitted.get(it.id)!.state })),
    };
    const failedIds = walked.items.filter((it) => isFailedItem(it)).map((it) => it.id);
    const decision: DecideReviewInput = {
      approve: failedIds.length === 0,
      rejectedItemIds: failedIds,
      assigneeId: input.assigneeId ?? user.sub,
      dueInDays: input.dueInDays,
    };
    const plan = await this.prepareDecide(projectId, walked, decision);
    if (visitId) await this.visits.assertMayLink(projectId, visitId, user.sub);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.finish', idempotencyKey, requestHash,
      run: async (tx) => {
        if (visitId) await this.visits.lockForLink(tx, projectId, visitId, user.sub);
        const submittedEv = await this.applySubmit(tx, prep, actor, user, visitId);
        const decided = await this.applyDecide(tx, plan, actor, user, decision, submittedEv.eventId);
        return { resultRef: inspectionId, events: [submittedEv, ...decided] };
      },
    });
    await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * #482 proof photos, "Who fixes this?" — the PMC or the engineer names the contractor or consultant member who fixes
   * this inspection's failed work, or nobody (`null`). Any inspection of the project, at any stage: an issue is named when
   * it is raised, a failed item when it fails, and either may be changed later.
   *
   * Lock order: the project's readiness key, then the inspection row FOR UPDATE, then the project row (`isProjectOperable`,
   * FOR NO KEY UPDATE: an archive committed first refuses this with 403), then the caller's and the member's standing rows
   * FOR UPDATE through the owner (`hasProjectRoleStanding`). A removal or re-role of the member either commits
   * first (this refuses, 400) or waits for this commit (and the read then serves no one). The composite foreign key keeps
   * the name inside this project for every writer.
   *
   * RM-e-c — the change emits `inspection.responsible_set` (signal-only: it invalidates, so other open tabs re-read; it
   * never pushes) and is dispatched after commit, as every inspection command is. The name is still not part of the
   * inspections projection's stored base: it is read live and judged for standing at read
   * (`InspectionsQueryService.responsibleMembers`), so the projection does not subscribe to the event
   * (`inspections.projection.ts`, `NOT_PROJECTED`) and its persisted rule is unchanged. The change is audited
   * (`inspection.responsible`).
   */
  async setResponsible(projectId: string, inspectionId: string, input: SetResponsibleMemberInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const memberId = input.memberId;
    const requestHash = hashRequest({ inspectionId, memberId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'inspections.setResponsible', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'inspections.setResponsible', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const [insp] = await tx.$queryRaw<Array<{ responsibleMemberId: string | null; reinspectionOfId: string | null }>>(
          Prisma.sql`SELECT "responsibleMemberId", "reinspectionOfId" FROM "Inspection" WHERE "id" = ${inspectionId} AND "projectId" = ${projectId} FOR UPDATE`,
        );
        if (!insp) throw new NotFoundException(`Inspection ${inspectionId} not found`);
        // Codex #1297 r4 — the PROJECT is re-read too, under its row lock (the owner's `FOR NO KEY UPDATE`): an archive
        // takes no readiness key, so one that commits after the guard's unlocked read would otherwise leave this naming
        // free to write on an archived project. The archive either commits first (refused here) or waits for this commit.
        if (!(await this.orgs.isProjectOperable(tx, projectId))) throw projectUnavailable();
        // Codex #1297 r2 — the CALLER's authority is re-read here, under the readiness key and with their standing rows
        // locked, as decide does: a PMC or engineer re-roled or removed after the guard read their token must not name
        // anyone. Locked after Inspection, so Membership still follows Inspection on every path.
        if (!(await this.orgs.hasProjectRoleStanding(tx, projectId, user.sub, [user.role], { forUpdate: true }))) {
          throw projectRoleChanged('naming');
        }
        // #482 "Who fixes this?" — ONE name per inspection lineage, held on its ROOT (`lineageRoots`, the root every
        // served checklist and review carries as `lineageRootId`). An inspection is its lineage's root exactly when it
        // re-checks nothing, and `reinspectionOfId` is set once, when the reject creates the re-inspection, and never
        // changes, so the row read above under its lock answers it. Checked after the caller's authority, so a caller
        // who may not name anyone learns nothing about the lineage.
        // Codex #1395 4498932663 — the one exception: CLEARING a name a re-inspection already holds. The previous release
        // accepted a naming on any inspection, so such a row can exist (written before this release, or by an old
        // replica during the rollout) and is still served; refusing its clear would leave it unclearable. A null on a
        // re-inspection that holds no name, and any naming of one, are still refused, so nothing new lands off the root.
        const clearsHeldChildName = memberId === null && insp.responsibleMemberId !== null;
        if (insp.reinspectionOfId !== null && !clearsHeldChildName) {
          throw new BadRequestException('Name who fixes this on the first inspection of this check.');
        }
        if (memberId !== null && !(await standsAsResponsible(this.orgs, tx, projectId, memberId, { forUpdate: true }))) {
          throw new BadRequestException(`Only an active ${RESPONSIBLE_ROLES.join(' or ')} on this project can be named to fix this.`);
        }
        // the mark is read under the readiness key held above, so it counts exactly the member's changes committed before
        const mark = memberId === null ? null : await standingMark(this.orgs, tx, projectId, memberId);
        await tx.inspection.update({ where: { id: inspectionId }, data: { responsibleMemberId: memberId, responsibleStandingMark: mark } });
        await recordAudit(tx, { projectId, actor, action: 'inspection.responsible', entity: 'Inspection', entityId: inspectionId, payload: { from: insp.responsibleMemberId, to: memberId } });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'inspection.responsible_set', entityType: 'Inspection', entityId: inspectionId, payload: { from: insp.responsibleMemberId, to: memberId }, effectKey: 'inspection.responsible_set', dispatch: {} });
        return { resultRef: inspectionId, events: [ev] };
      },
    });
    await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** The type of every file linked to each of this inspection's items as evidence. The links are this module's own
   *  (`InspectionEvidence`, the set whose removal locks this inspection's row first, `assertEvidenceDisposable`); each
   *  file's type is the media module's answer (`MediaParticipant.mimesOf`), on the same transaction. A proof photo is
   *  never linked as evidence. */
  private async evidenceMimes(db: Prisma.TransactionClient, projectId: string, inspectionId: string): Promise<Map<string, string[]>> {
    const links = await db.inspectionEvidence.findMany({ where: { projectId, inspectionId }, select: { inspectionItemId: true, mediaId: true } });
    const mimeOf = await this.media.mimesOf(db, { projectId, mediaIds: [...new Set(links.map((l) => l.mediaId))] });
    const byItem = new Map<string, string[]>();
    for (const l of links) {
      const mime = mimeOf.get(l.mediaId);
      if (mime === undefined) continue;
      const list = byItem.get(l.inspectionItemId);
      if (list) list.push(mime);
      else byItem.set(l.inspectionItemId, [mime]);
    }
    return byItem;
  }

  /** The submit's checks before its transaction (guided step 3a: shared with {@link finish}): the inspection, its state
   *  machine, the early assignment answer, containment, every item marked, and the evidence rule's early answer. */
  private async prepareSubmit(projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser): Promise<SubmitPrep> {
    // Items in checklist order (`order`, as every read that shows them): the missing-evidence sentence names them in this order.
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: { orderBy: { order: 'asc' } } } });
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

    // THE EVIDENCE RULE (`evidence-rule.ts`): a fail needs a linked recording, a guided item the recordings it asks for
    // (on a pass too when it says so), and a failed guided item a reason. Asked here for an early answer, and again
    // under the inspection's row lock below, which is the authority.
    const submittedItems = (): SubmittedItem[] => insp.items.map((dbIt) => {
      const s = submitted.get(dbIt.id)!;
      return { ...dbIt, state: s.state, note: s.note };
    });
    const refuseShortfalls = async (db: Prisma.TransactionClient): Promise<void> => {
      const shortfalls = evidenceShortfalls(submittedItems(), await this.evidenceMimes(db, projectId, inspectionId));
      if (shortfalls.length > 0) throw new BadRequestException(shortfalls.join(' '));
    };
    await refuseShortfalls(this.prisma as unknown as Prisma.TransactionClient);
    return { projectId, inspectionId, insp, submitted, refuseShortfalls };
  }

  /** The submit's writes, inside the command's transaction (guided step 3a: shared with {@link finish}). Takes the
   *  readiness key, then the inspection row, then re-asks the assignment and the evidence rule under them, writes each
   *  item, moves the inspection to submitted (CAS) and emits `inspection.submitted`. A walk done on a site visit (guided
   *  step 3c) is recorded on the visit after the CAS and before the event; the caller took the visit's locks first. */
  private async applySubmit(
    tx: Prisma.TransactionClient, prep: SubmitPrep, actor: Actor, user: AuthUser, visitId?: string,
  ): Promise<EmittedEventMeta> {
    const { projectId, inspectionId, insp, submitted, refuseShortfalls } = prep;
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
    // the evidence rule again, now that the inspection row is locked: adding or removing evidence locks this row
    // first, so what is read here is what the submit commits beside (guided step 2b)
    await refuseShortfalls(tx);
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
    if (visitId) await this.visits.link(tx, { projectId, visitId, inspectionId, userId: user.sub, actor });
    await recordAudit(tx, { projectId, actor, action: 'inspection.submit', entity: 'Inspection', entityId: inspectionId });
    const ev = await emitEvent(tx, { projectId, actor, eventType: 'inspection.submitted', entityType: 'Inspection', entityId: inspectionId, effectKey: 'inspection.submitted', dispatch: {} });
    return ev;
  }

  /** The decision's reads and checks before its transaction (guided step 3a: shared with {@link finish}). `insp.items`
   *  carry the states the decision judges: stored ones for a decide, the walk's own for a finish. */
  private async prepareDecide(projectId: string, insp: InspectionWithItems, input: DecideReviewInput): Promise<DecidePlan> {
    const inspectionId = insp.id;
    // The activity a CLOSING inspection signs off (null for ordinary inspections) — read through the
    // activities WORKFLOW PARTICIPANT (Task 10 Module 4: inspections never reads `prisma.activity`
    // directly; the participant is the cycle-exempt channel). The name here is fast pre-validation
    // display only — the in-transaction sign-off methods return the authoritative TX-CURRENT name.
    const activity = insp.closing && insp.activityId
      ? await this.activities.signOffTarget(this.prisma, { projectId, activityId: insp.activityId })
      : null;
    if (input.approve) {
      const project = activity ? await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } }) : null;
      return { approve: true, projectId, inspectionId, activity, project };
    }
    // gate finding 3: rejection names exact ROWS. An id that matches none of this
    // inspection's items is a refused claim (it could be another inspection's row).
    const unknownRejected = input.rejectedItemIds.filter((id) => !insp.items.some((it) => it.id === id));
    if (unknownRejected.length > 0) throw new BadRequestException('Rejected item(s) do not belong to this inspection — reload and retry.');
    const rejectedItems = insp.items.filter((it) => input.rejectedItemIds.includes(it.id) || isFailedItem(it));
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
    // #482 V-1018-5 — the re-inspection carries the work's own title: the first inspection of its lineage, which a
    // person typed (titles are never edited). A re-inspection stored before this change has "Re-inspection: " in its
    // title, so copying `insp.title` would hand that decoration on to the next re-check; reading the lineage does not.
    const childTitle = await this.lineageRootTitle(projectId, insp);
    const existingIds = await this.prisma.inspection.findMany({ select: { id: true } });
    const childId = nextSeqId('INSP-', existingIds.map((i) => i.id));
    // a zero-item legacy closing still yields WORKABLE corrective items — the child
    // gets the default sign-off item (an inspection without items cannot be submitted)
    // Guided site inspections (step 2a) — a re-checked item carries the guidance it was first issued with, so the
    // re-check asks for the same recordings and is judged by the same rule; it is written in the INSERT (step 1).
    const childItems = rejectedItems.length > 0
      ? rejectedItems.map((it) => ({ name: it.name, ...guidanceColumnsOf(it) }))
      : [itemRowFromSpec('Work complete and acceptable')];

    const pushBody = `Re-inspection ${childId} created for ${childItems.length} item(s) — due ${ddMmmYyyy(dueDate)}.`;

    return {
      approve: false, projectId, inspectionId, insp, activity, rejectedItems, assigneeId, dueIso, dueDate, childId,
      childTitle, childItems, pushBody, today,
    };
  }

  /** The decision's writes, inside the command's transaction (guided step 3a: shared with {@link finish}). `causedBy`
   *  chains the decision's first event to the walk's `inspection.submitted` when one command does both. */
  private async applyDecide(
    tx: Prisma.TransactionClient, plan: DecidePlan, actor: Actor, user: AuthUser, input: DecideReviewInput, causedBy?: string,
  ): Promise<EmittedEventMeta[]> {
    // The push body still drives the in-transaction Notification row + the emit dispatch body; the
    // TARGET ROLES come from the external-effect catalog (per effectKey), not a local variable. The
    // approve branch builds its body INSIDE the transaction (tx-current activity name).
    // Every emit this command commits, in causal order, handed to the single sender post-commit. A
    // multi-event decide (approve+signoff, reject+reinspection+signoff-reversal) invalidates the
    // socket ONCE (the dispatcher dedups per project) and pushes exactly the one body-bearing event.

    if (plan.approve) {
      const { projectId, inspectionId, activity, project } = plan;
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
      // Top 10 #4a (#778) — the notice names WHICH inspection was approved: two approvals were two
      // identical lines in the bell (live-bug 2). Named by id, never by its title (user text the bell's
      // keyword classifier would read).
      let body = `Inspection ${inspectionId} approved. Contractor and client notified.`;
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
      const approved = await emitEvent(tx, { projectId, actor, eventType: 'inspection.approved', entityType: 'Inspection', entityId: inspectionId, causedByEventId: causedBy, effectKey: activity ? 'inspection.approved.closing' : 'inspection.approved', dispatch: activity ? {} : { push: { body } } });   // #582 round 18, finding 3 — the CLOSING branch announces through activity.signed_off and has its own key
      const localEvents: EmittedEventMeta[] = [approved];
      // A CLOSING inspection's approval CAUSES the activity sign-off — one causal chain.
      if (activity) localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'activity.signed_off', entityType: 'Activity', entityId: activity.id, causedByEventId: approved.eventId, payload: { closingInspectionId: inspectionId }, effectKey: 'activity.signed_off', dispatch: { push: { body } } }));
      return localEvents;
    }
    const {
      projectId, inspectionId, insp, activity, rejectedItems, assigneeId, dueIso, dueDate, childId, childTitle, childItems,
      pushBody, today,
    } = plan;
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
        // Guided step 3a (gap-check): a PMC by org standing alone (an org owner or admin with no Membership row) cannot
        // be written down as the re-checker: the assignee's composite foreign key names a Membership. Finish defaults
        // the re-check to its walker, so say what to do instead of the general sentence.
        if (!membership && assigneeId === user.sub) {
          throw new BadRequestException('You are not a member of this project, so the re-check cannot be yours — name an engineer on this project to re-check the failed items.');
        }
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
      // #482 F-C4.1 — every item sent back is marked rejected, the explicitly named ones and the engineer's
      // fails alike, so the decided record says what returned (readiness reads `rejected`)
      for (const it of rejectedItems) {
        await tx.inspectionItem.updateMany({ where: { id: it.id, inspectionId }, data: { rejected: true } });
      }
      // the LINKED reinspection: only the rejected work returns, fresh and unfilled;
      // the requirement edge is INHERITED — it accepts the same work. NOT itself a
      // closing (closing=false): sign-off is re-claimed via complete() once corrected.
      await tx.inspection.create({
        data: {
          id: childId,
          projectId,
          kind: 'checklist',
          // #482 V-1018-5 — the inspection's own title: readers label a re-inspection from `reinspectionOfId`
          // in their language, so no fixed English words are written into the record
          title: childTitle,
          zone: insp.zone,
          nodeId: insp.nodeId,
          activityId: insp.activityId,
          reinspectionOfId: inspectionId,
          assigneeId,
          dueDate,
          // the work type travels with the work (step 2a)
          workType: insp.workType,
          date: ddMmmYyyy(fromIsoCivilDate(today)!),
          inspectionDate: fromIsoCivilDate(today),
          submitted: false,
          decided: false,
          items: { create: childItems.map((item, i) => ({ ...item, order: i, photos: 0, note: '' })) },
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
      await tx.notification.create({ data: { projectId, text: pushBody, color: '#B23A34', time: 'just now', inspectionId: childId } });
      await recordAudit(tx, { projectId, actor, action: 'inspection.reject', entity: 'Inspection', entityId: inspectionId, payload: { reinspectionId: childId, assigneeId, dueDate: dueIso } });
      // The rejection CAUSES both the linked reinspection and (for a closing) the sign-off reversal.
      const rejected = await emitEvent(tx, { projectId, actor, eventType: 'inspection.rejected', entityType: 'Inspection', entityId: inspectionId, causedByEventId: causedBy, payload: { reinspectionId: childId, assigneeId }, effectKey: 'inspection.rejected', dispatch: {} });
      const localEvents: EmittedEventMeta[] = [rejected];
      // Top 10 #3b (#776 Codex 4239336838) — no record url: this push is an engineer-role broadcast, but the
      // re-inspection is ASSIGNED work only its assignee's checklist screen resolves (bakeInspections' `mine`),
      // so a url would land every other engineer on "not found". It stays the app root until delivery is
      // assignee-targeted.
      localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'inspection.reinspection_created', entityType: 'Inspection', entityId: childId, causedByEventId: rejected.eventId, payload: { reinspectionOf: inspectionId, assigneeId }, effectKey: 'inspection.reinspection_created', dispatch: { push: { body: pushBody } } }));
      if (activity) localEvents.push(await emitEvent(tx, { projectId, actor, eventType: 'activity.signoff_rejected', entityType: 'Activity', entityId: activity.id, causedByEventId: rejected.eventId, payload: { closingInspectionId: inspectionId, reinspectionId: childId }, effectKey: 'activity.signoff_rejected', dispatch: {} }));
      return localEvents;
    } catch (e) {
      // the one-reinspection-child index fired — a concurrent reject already created it. Convert it
      // to the domain 409 INSIDE `run`, so the ledger's own reservation-P2002 handling (a different
      // index) never mistakes this for a concurrent-key conflict.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This inspection was already decided — reload and retry');
      }
      throw e;
    }
  }

  /** The title of the first inspection in this one's re-inspection lineage (itself when it re-checks nothing). */
  private async lineageRootTitle(projectId: string, insp: { title: string; reinspectionOfId: string | null }): Promise<string> {
    let current = insp;
    const seen = new Set<string>();
    while (current.reinspectionOfId && !seen.has(current.reinspectionOfId)) {
      seen.add(current.reinspectionOfId);
      const parent = await this.prisma.inspection.findFirst({ where: { projectId, id: current.reinspectionOfId }, select: { title: true, reinspectionOfId: true } });
      if (!parent) break;
      current = parent;
    }
    return current.title;
  }
}
