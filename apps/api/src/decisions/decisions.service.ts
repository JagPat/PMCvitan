import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type $Enums } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import { resolveActor } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { nextSeqId } from '../domain/ids';
import { APPROVED_DECISION_NOTICE_COLOR, AWAITING_COUNTERSIGN_NOTICE_COLOR, DESIGNATION_ROLE_LABEL, FORWARDED_DECISION_NOTICE_COLOR, PENDING_DECISION_NOTICE_COLOR, RECORDED_DECISION_NOTICE_COLOR, WITHDRAWN_DECISION_NOTICE_COLOR, approvedDecisionNotice, finalizedApprovalNotice, forwardedDecisionNotice, pendingDecisionNotice, provisionalApprovalNotice, recordedDecisionNotice, withdrawnDecisionNotice, changeRequestedNotice, CHANGE_REQUESTED_NOTICE_COLOR, type ApprovalFinalization } from '../domain/notifications';
import { cancelQueuedPushBySubject, lockQueuedPushDeliveries } from '../platform/outbox/cancellation';
import { EXTERNAL_EFFECTS, type PushRole } from '../platform/external-effects';
import type { ApproveInput, ChangeInput, CreateDecisionInput, DisagreeDecisionInput, ForwardDecisionInput, RequestConsultationInput, ResolveStrandedCountersignInput, RespondToConsultationInput, UpdateDecisionDraftInput, WithdrawDecisionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { requireActorEnvelope, resolveActorEnvelope, STALE_ROLE_MESSAGE } from '../platform/actor-envelope';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { consultationOpen } from './consultation-open';
import { assertPhase6_4dOpen } from '../platform/phase6-4d-rollout';
import { assertCountersignClient } from '../platform/countersign-contract';
import { RoleStandingQuery } from '../platform/role-standing.query';

/** The consultation commands REQUIRE a client key (review round 19) — see `requestConsultation`. */
function requireIdempotencyKey(key: string | undefined, commandType: string): string {
  const trimmed = (key ?? '').trim();
  if (!trimmed) {
    throw new BadRequestException(
      `${commandType} requires an Idempotency-Key header — this command records a permanent, append-only fact and must run exactly once`,
    );
  }
  return trimmed;
}

/** Lock the decision row and read the fields consultation eligibility is judged from. `FOR SHARE`
 *  conflicts with the `FOR UPDATE` that withdraw/approve/requestChange take, so a transition
 *  committing concurrently either waits or is seen — and it does not block a second consultation
 *  on the same decision, which needs no serializing against. */
async function lockDecisionForConsultation(
  tx: Prisma.TransactionClient,
  projectId: string,
  decisionId: string,
): Promise<{ status: string; publishedAt: Date | null; title: string } | null> {
  const rows = await tx.$queryRaw<Array<{ status: string; publishedAt: Date | null; title: string }>>`
    SELECT "status"::text AS status, "publishedAt", "title" FROM "Decision"
     WHERE "projectId" = ${projectId} AND "id" = ${decisionId}
     FOR SHARE`;
  return rows[0] ?? null;
}

/**
 * Whether `userId` may ASK for advice on the project: the delivered `pmc` standing (orgs truth, locked,
 * unchanged), or — Phase 6 task 4d (§A.2) — the ARCHITECT role through the KERNEL read
 * (`platform_user_holds_role`), never an orgs table. No request in the 4d-i → 4d-iii window can take the
 * architect arm, since the reservation keeps every architect unrepresentable, so service and seal agree
 * in the window (the delivered predicate) and after it (the register).
 */
export async function consultationRequesterStanding(
  orgs: Pick<OrgsParticipant, 'hasProjectRoleStanding'>,
  tx: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<boolean> {
  if (await orgs.hasProjectRoleStanding(tx, projectId, userId, ['pmc'], { forUpdate: true })) return true;
  return RoleStandingQuery.holdsRole(tx, projectId, userId, 'architect');
}

/**
 * The ELIGIBILITY carve-out, applied identically at the request and at the response.
 *
 * A consultation belongs only to a decision whose question is still OPEN
 * (`CONSULTATION_OPEN_STATUSES`) AND PUBLISHED. Status alone would admit an author-private
 * DRAFT whose status is `pending`. Never `withdrawn`, whose title and reason are pmc-only: a
 * consultation there would leak exactly what 4a hides. Never `approved` or `recorded`: there is
 * nothing left to inform.
 */
function assertConsultationEligible(d: { status: string; publishedAt: Date | null }, decisionId: string): void {
  if (d.publishedAt === null) {
    throw new ConflictException(`Decision ${decisionId} is an unpublished draft — there is nobody to consult about it yet`);
  }
  if (!consultationOpen(d.status)) {
    throw new ConflictException(
      `Decision ${decisionId} is ${d.status} — advice can only be asked for, or given, while the question is still open`,
    );
  }
}

@Injectable()
export class DecisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // PR C Task 2 — the SINGLE external-effect sender. A command hands its committed events to
    // `dispatchCommitted` post-commit; the dispatcher (legacy/shadow) or the relay (outbox) is the
    // sole sender for the active mode, so no service ever sends a socket/push directly.
    private readonly dispatcher: ExternalEffectDispatcher,
    // Phase 6 task 4a round 3 — `Membership` is orgs-owned: the withdraw ATTRIBUTION question
    // (an active membership, locked — the FK's target) is answered by its owner through the
    // declared decisions → orgs workflow-participant edge, never by a raw read here.
    private readonly orgsParticipant: OrgsParticipant,
    // Phase 6 unit 4c-iv — the per-project `consultation` capability is NO LONGER READ here.
    // 4c-ii gated both write commands (and, through them, the emitter) and the client on it;
    // 4c-iii made the row a fact of every project's existence (creation trigger + backfill,
    // sealed for presence); 4c-iv retires every read of it — the two commands below, the shell
    // contract, and the client — in one unit, so no two servers can ever disagree about a
    // project. The row itself, and the seal keeping it present, stay until 4c-v retires them.
  ) {}

  /** Phase 6 task 4b (§A.3) — the decider-routed push: the catalog names the CEILING and this
   *  site narrows to the ACTUAL decider. A role-held decision pushes at that role's audience; a
   *  NAMED member resolves to a USER target (delivered only to their currently-valid links —
   *  never a role fan-out that would reach every same-role device). */
  private deciderPush(
    body: string,
    kind: 'client' | 'pmc' | 'member' | 'none' | 'architect',
    member: { userId: string; role: string } | null,
  ): { body: string; roles?: readonly PushRole[]; targetUserId?: string } {
    // Phase 6 task 4d (4d-ii-a / A7d) — an architect-designated decision pushes at the ARCHITECT
    // role, within the ceiling the catalog generation widened; the claim re-judges the role's
    // current holders through the kernel register (`deciderPushTarget`'s architect arm). The create
    // and draft edits still refuse the designation 409 while 4d-i's reservation stands.
    if (kind === 'architect') return { body, roles: ['architect'] };
    if (kind === 'member' && member) {
      return { body, roles: [member.role as 'contractor'], targetUserId: member.userId };
    }
    return { body, roles: [kind === 'pmc' ? 'pmc' : 'client'] };
  }

  /** PMC issues a new decision (title/room + 2–4 options) → shows as pending on the
   *  client's Decisions Waiting screen. Labels/keys derive from order when omitted.
   *
   *  Idempotent under `idempotencyKey` (Phase 2 Task 5): a retried "issue" reserves→creates→
   *  receipts in one transaction, so a network retry / offline replay creates the decision once.
   *  Validation stays OUTSIDE the transaction (as before), so a keyed REPLAY short-circuits it. */
  async create(projectId: string, input: CreateDecisionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    // Phase 6 task 4b (round 13) — the preimage covers the decider TUPLE: reusing a key after
    // changing the intended holder must CONFLICT, never silently replay the wrong authority.
    const requestHash = hashRequest({
      title: input.title,
      nodeId: input.nodeId ?? null,
      room: input.room ?? null,
      options: input.options.map((o) => ({ label: o.label ?? null, material: o.material, delta: o.delta, swatch: o.swatch, photoUrl: o.photoUrl ?? null, recommended: o.recommended })),
      publish: !!input.publish,
      deciderKind: input.deciderKind,
      deciderMembershipId: input.deciderMembershipId ?? null,
    });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.create', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    // DATA-01: `Decision.id` is the table's GLOBAL primary key, so the sequence must
    // scan every project — a per-project scan would mint e.g. DL-003 twice (the demo
    // project already owns it) and crash the second project's create with P2002.
    // Durable fix (internal PK + per-project code) is tracked in docs/ROADMAP.md.
    const existing = await this.prisma.decision.findMany({ select: { id: true } });
    const id = nextSeqId('DL-', existing.map((d) => d.id));
    // 4b (§A.2): a RECORD has no options, so no option-sourced presentation — photoSwatch stays
    // NULL (the DB CHECK keeps it required for every choice kind).
    const record = input.deciderKind === 'none';
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

    const notice = record ? recordedDecisionNotice(input.title) : pendingDecisionNotice(input.title);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.create',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // publication is a readiness-input write (the gate reads the published decision), and
        // the DB seals' try-acquire expects the service path to HOLD the key (§B.1). Round-3
        // Codex F4: the seal's recorded-birth arm fires on EVERY record INSERT — published or
        // not — so a record create acquires the key too; otherwise a concurrent holder (an
        // activity start, a membership command) would make the trigger's try-acquire fail an
        // otherwise valid create instead of serializing behind it.
        if (input.publish || record) await lockProjectReadiness(tx, projectId);
        // Phase 6 task 4d (§A.1) — the architect DESIGNATION is reserved until 4d-iii: refused 409
        // with the drain directive before the draft is born (4d-i's door would refuse the INSERT
        // below mid-transaction), judged under the readiness key like every designation write
        if (input.deciderKind === 'architect') {
          if (!(input.publish || record)) await lockProjectReadiness(tx, projectId);
          await assertPhase6_4dOpen(tx, 'A decision designated to the architect role');
          // 4d-ii-a / A5e — …and once open, a client below `countersign-v1` is refused under an
          // ACTIVE chain: it cannot represent the designation it is writing
          await assertCountersignClient(tx, projectId, user.decisionsContract, 'A decision designated to the architect role');
        }
        // 4b (§A.1): a NAMED decider must be an ACTIVE membership of THIS project, answered and
        // LOCKED by the owner through the declared participant edge — the FK alone proves too
        // little (existence is not standing).
        let member: { userId: string; name: string; role: string } | null = null;
        if (input.deciderKind === 'member') {
          member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, input.deciderMembershipId!);
          if (!member) throw new BadRequestException('The named decider must be an ACTIVE member of this project');
        }
        // 4b round 10: publishing a ROLE-held decision into a project with no active holder
        // would birth the zero-holder state the removal guard exists to prevent.
        if (input.publish && (input.deciderKind === 'client' || input.deciderKind === 'pmc')) {
          const standing = await this.orgsParticipant.effectiveRoleStanding(tx, projectId, input.deciderKind);
          if (standing === 0) {
            throw new ConflictException(`This project has no active ${input.deciderKind} to hold the decision — name a member decider, or add the ${input.deciderKind} first`);
          }
        }
        // 4b round 18 — the RE-ORDERED create: the head births UNPUBLISHED, its options land,
        // and the guarded publication UPDATE closes the same transaction (atomic to every
        // reader; the DB publication seals judge the update exactly like a later publish).
        await tx.decision.create({
          data: {
            id, projectId, title: input.title, room, nodeId,
            status: record ? 'recorded' : 'pending',
            ageDays: 0,
            photoSwatch: record ? null : lead!.swatch,
            authorId: user.sub,
            publishedAt: null,
            deciderKind: input.deciderKind,
            deciderMembershipId: input.deciderKind === 'member' ? input.deciderMembershipId! : null,
          },
        });
        await tx.decisionOption.createMany({
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
        });
        if (input.publish) {
          await tx.decision.update({ where: { id }, data: { publishedAt: new Date() } });
        }
        await tx.decisionEvent.create({ data: { decisionId: id, type: input.publish ? 'issued' : 'drafted', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: input.title } } });
        await recordAudit(tx, { projectId, actor, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id });
        // 4d-ii-a / A7a — the event id is MINTED HERE, before the event exists, because the notice
        // below names it: the event is written first (the notice's binding key is a NOT DEFERRABLE
        // foreign key onto it) and the notice second, in this one transaction, as the binding seal
        // demands (`Notification_t4d_binding_bound`: the event must be this transaction's).
        const eventId = randomUUID();
        const ev = await emitEvent(tx, {
          projectId, actor, eventId, eventType: input.publish ? 'decision.published' : 'decision.drafted', entityType: 'Decision', entityId: id, payload: { title: input.title },
          // #582 round 18, finding 1 — the RECORD arm has its own key. The obligation is a
          // property of the branch, and the branch is already decided here.
          effectKey: input.publish ? (record ? 'decision.published.record' : 'decision.published') : 'decision.drafted',
          // A one-step ISSUE carries the approval-demand push AT THE DECIDER (§A.3): the catalog
          // names the role CEILING; the persisted intent narrows to the actual decider — the
          // named member's USER for `member`, the role audience for `client`/`pmc`, and NOBODY
          // for a record (a false approval demand for a decision nobody can approve).
          dispatch: input.publish && !record
            ? { push: this.deciderPush(`New decision awaiting your approval: ${input.title}`, input.deciderKind, member) }
            : {},
        });
        if (input.publish) {
          // Phase 6 task 4a — decision-notice writers stamp `decisionId`, so a later withdrawal
          // retires the pending notice by IDENTITY, never by matching display text.
          // 4d-ii-a / A7a — and the notice is KINDED: bound to the event that announced the act
          // (`eventId`, `kind` = its type), so every reader renders it from the event (A4c) and
          // the row is evidence the binding seal keeps. `text`/`color` stay as the cache a
          // previous-release replica still serves through the drain. A draft writes no notice.
          await tx.notification.create({ data: { projectId, text: notice, color: record ? RECORDED_DECISION_NOTICE_COLOR : PENDING_DECISION_NOTICE_COLOR, time: 'just now', decisionId: id, kind: 'decision.published', eventId } });
        }
        return { resultRef: id, events: [ev] };
      },
    });

    // Hand the committed events to the single sender (fresh execution only — a replay re-sends
    // nothing, and its `events` is empty). A draft's intent is weightless, so a draft still
    // notifies no one; a one-step publish sends exactly what publish() does.
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Publish a private draft decision → it enters the shared snapshot, the client is asked
   *  to choose, and it starts driving the app (pending count, linked gate). Idempotent-ish:
   *  publishing an already-published decision is a no-op conflict. Author/PMC authority. */
  async publish(projectId: string, decisionId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.publish', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const pre = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!pre || pre.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (pre.publishedAt) throw new ConflictException('Decision is already published');

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.publish',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // 4b: publication drives the decision gate and the DB seals expect the service to hold
        // the readiness key (§B.1)
        await lockProjectReadiness(tx, projectId);
        // 4b round 16 — publish takes the decision ROW LOCK before reading its snapshot: the
        // draft-edit door means an edit could commit between a plain read and the publication
        // UPDATE, letting the published head carry ANOTHER revision's notice/evidence. Every
        // derived value below comes from this LOCKED head.
        const locked = await tx.$queryRaw<Array<{ id: string; title: string; deciderKind: string; deciderMembershipId: string | null; publishedAt: Date | null; authorId: string | null }>>(
          Prisma.sql`SELECT "id", "title", "deciderKind"::text AS "deciderKind", "deciderMembershipId", "publishedAt", "authorId"
                       FROM "Decision" WHERE "id" = ${decisionId} AND "projectId" = ${projectId} FOR UPDATE`,
        );
        const d = locked[0];
        if (!d) throw new NotFoundException(`Decision ${decisionId} not found`);
        if (d.publishedAt) throw new ConflictException('Decision is already published');
        const record = d.deciderKind === 'none';
        // round-7 Codex F2 — publishing a RECORD files the frozen author's name in the
        // permanent register at THIS moment (the plan's publish-time authority recheck): the
        // birth/conversion doors judged the author when the draft was made, but a draft can
        // outlive its author's standing — another PMC must re-issue the record themselves
        // instead of publishing a revoked author's draft (the DB seal re-judges the same).
        if (record) {
          const authorHoldsAuthority = d.authorId
            ? await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, d.authorId, ['pmc'], { forUpdate: true })
            : false;
          if (!authorHoldsAuthority) {
            throw new ConflictException(
              'This record\'s author no longer holds decision authority on the project — a record files under its author\'s name, so re-issue the record yourself instead of publishing their draft',
            );
          }
        }
        // 4b (§A.1): the publish transition atomically RE-VALIDATES the holder — the named
        // membership's ACTIVE standing through the owner, a role-held decider through
        // effective-role-standing. A stranded draft refuses with the fix by name (the
        // draft-edit door, decisions.updateDraft).
        let member: { userId: string; name: string; role: string } | null = null;
        if (d.deciderKind === 'member') {
          member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, d.deciderMembershipId!);
          if (!member) {
            throw new ConflictException('The named decider is no longer an active member — edit the draft\'s holder (updateDraft) before publishing');
          }
        }
        if (d.deciderKind === 'client' || d.deciderKind === 'pmc') {
          const standing = await this.orgsParticipant.effectiveRoleStanding(tx, projectId, d.deciderKind);
          if (standing === 0) {
            throw new ConflictException(`This project has no active ${d.deciderKind} to hold the decision — edit the draft's holder (updateDraft) before publishing`);
          }
        }
        // 4b rounds 13/17 — the option floor re-judged at the publish door under the row lock
        // (the DB's deferred publication seal re-counts the same aggregate at commit)
        const optionCount = await tx.decisionOption.count({ where: { decisionId } });
        if (!record && (optionCount < 2 || optionCount > 4)) {
          throw new ConflictException('A choice needs 2-4 approvable options before it can publish — finish the draft first');
        }
        if (record && optionCount !== 0) {
          throw new ConflictException('A record takes no options — remove them before publishing');
        }
        // Phase 6 task 4a — publish joins the CAS lifecycle it was the one exception to: this
        // guard (`publishedAt: null`) is the transition, so two concurrent publishes admit
        // exactly one instead of both re-stamping `publishedAt`.
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, publishedAt: null },
          data: { publishedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Decision is already published');
        const notice = record ? recordedDecisionNotice(d.title) : pendingDecisionNotice(d.title);
        await tx.decisionEvent.create({ data: { decisionId, type: 'issued', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: d.title } } });
        await recordAudit(tx, { projectId, actor, action: 'decision.publish', entity: 'Decision', entityId: decisionId });
        // 4d-ii-a / A7a — event first, then the kinded notice bound to it (see create()).
        const eventId = randomUUID();
        const ev = await emitEvent(tx, {
          projectId, actor, eventId, eventType: 'decision.published', entityType: 'Decision', entityId: decisionId, payload: { title: d.title },
          effectKey: record ? 'decision.published.record' : 'decision.published',   // #582 round 18, finding 1
          // §A.3: the approval demand pushes AT THE DECIDER; a record pushes at NOBODY (there
          // is nothing to approve — the bell notice above is the announcement).
          dispatch: record
            ? {}
            : { push: this.deciderPush(`New decision awaiting your approval: ${d.title}`, d.deciderKind as 'client', member) },
        });
        await tx.notification.create({ data: { projectId, text: notice, color: record ? RECORDED_DECISION_NOTICE_COLOR : PENDING_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.published', eventId } });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    // now it's live — surface it on the client's side, exactly like a one-step issue (fresh only)
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Client approves an option → the decision is locked (server-authoritative) with the
   *  caller's REAL identity; when the decision was reopened, approval also RESOLVES the
   *  open change request ('reapproved'). The transition is a compare-and-set committed
   *  with its events, so a concurrent approve/change/withdraw has exactly one winner.
   *
   *  Idempotent under `idempotencyKey`: a retry with the same key replays the SAME lock and
   *  result; a double-approve with a fresh key is still the truthful 409 the CAS raises. */
  async approve(projectId: string, decisionId: string, input: ApproveInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, optionIndex: input.optionIndex });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.approve', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({
      where: { id: decisionId },
      include: { options: { orderBy: { order: 'asc' } }, deciderMembership: { select: { userId: true, id: true } } },
    });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status === 'approved') throw new ConflictException('Decision is already approved and locked');
    // 4b (§A.2): a RECORD is approvable by nobody — a deliberate 409, never the terminal trigger.
    if (d.status === 'recorded') {
      throw new ConflictException(`Decision ${decisionId} is a record-only issue — nothing about it is approvable`);
    }
    // Phase 6 task 4a — approve validates its SOURCE STATE before the CAS: the CAS below takes
    // the row's CURRENT status as its guard, so without this a stale client replaying an
    // approval against a now-withdrawn decision would drive `withdrawn → approved` into the
    // terminal trigger — a raw database error mid-write instead of a refusal. A deliberate 409
    // here has NO side effects (no revision, no register event, no notice).
    // 4d-ii-a / A8a — an approval AWAITING its countersign is the ARCHITECT's action item: it is
    // countersigned, rejected back or resolved when stranded (A8b), never approved again.
    if (d.status === 'awaiting_countersign') {
      throw new ConflictException(`Decision ${decisionId} is awaiting the architect's countersign — it is the architect's to countersign or reject, never approved again`);
    }
    if (d.status !== 'pending' && d.status !== 'change') {
      throw new ConflictException(`Decision ${decisionId} was withdrawn — it can no longer be approved`);
    }
    const o = d.options[input.optionIndex];
    if (!o) throw new BadRequestException('Invalid option index');

    const prior = d.status; // 'pending' (first approval) or 'change' (re-approval)
    const today = ddMmmYyyy(new Date());
    // 4b (§A.1) — the AUTHORITY narrows to the DECIDER (the route policy is only the ceiling):
    // the actor IS the decider (by role, or the named membership's user), or the PMC approves
    // on the decider's behalf — recorded honestly, generalized from the hard-coded 'client'.
    const isNamedDecider = d.deciderKind === 'member' && d.deciderMembership?.userId === user.sub;
    // 4d-ii-a / A8a — the ARCHITECT arm: a decision designated to the architect role is decided by an
    // architect (the role a token carries only once 4d-iii lets the chain activate).
    const isRoleDecider =
      (d.deciderKind === 'client' && user.role === 'client') || (d.deciderKind === 'pmc' && user.role === 'pmc')
      || (d.deciderKind === 'architect' && user.role === 'architect');
    if (!isNamedDecider && !isRoleDecider && user.role !== 'pmc') {
      throw new ForbiddenException('Only this decision\'s decider (or the PMC on their behalf) can approve it');
    }
    const onBehalfOf = isNamedDecider || isRoleDecider ? null : d.deciderKind;
    // the display identity of the HOLDER the act freezes (round 3 — the act keeps its own
    // history even after a later forward re-homes the decision)
    const holderLabel =
      d.deciderKind === 'member' ? `Member ${d.deciderMembershipId}` : d.deciderKind === 'pmc' ? 'PMC' : d.deciderKind === 'architect' ? 'Architect' : 'Client';
    // ...and the ANNOUNCEMENT says who exercised the authority (gate finding 7). Composed inside
    // the transaction from A7a: see `announce` there.

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.approve',
      idempotencyKey,
      requestHash,
      // Phase 6 unit 4c-ii — an approval now carries COMMAND PROVENANCE, because 4c makes the
      // revision COUNT trusted cycle evidence: a revision that is not the product of an approval
      // TRANSITION could advance a decision's cycle past every open consultation, making those
      // answers 409 permanently and cancelling their deliveries — a DENIAL of a fact the workflow
      // promises to keep answerable, reached without touching a consultation table.
      //
      // The synthesis preserves legacy unkeyed behaviour EXACTLY (the synthesized key is unique
      // per call, so it is never a replay and two unkeyed retries each execute once, today's
      // semantics); it only guarantees the receipt exists. A CLIENT-supplied key keeps its
      // exactly-once replay unchanged, and enforcement still takes precedence over synthesis.
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        // a lock-state transition moves the decision gate (gate finding 1)
        await lockProjectReadiness(tx, projectId);
        // Phase 6 task 4d-ii-a / A5e (§A.2) — under an ACTIVE chain this approval lands
        // `awaiting_countersign`, which a client below `countersign-v1` would report as "Approved &
        // locked": refused 409 with a reload, judged here under the readiness key (never at the
        // transport) and before any write. With no chain the approve is untouched.
        await assertCountersignClient(tx, projectId, user.decisionsContract, 'Approving a decision');
        // 4d-ii-a / A8a (§A.2, "the chain switch") — the switch is read HERE, under the readiness key the
        // architect standing writers take, through the kernel register the birth and entry seals judge
        // by: an active architect makes this approval PROVISIONAL (`awaiting_countersign`, the revision
        // born `finalized = false`), and the demand goes to the architects frozen at this instant. With
        // no chain the approve lands `approved` exactly as it did.
        const chainActive = (await RoleStandingQuery.activeCount(tx, projectId, 'architect')) > 0;
        const landing: 'approved' | 'awaiting_countersign' = chainActive ? 'awaiting_countersign' : 'approved';
        // round-11 Codex F1 — the ROLE that granted authority is re-validated LIVE inside the
        // transaction, under the membership-row lock: `user.role` was established by JwtGuard
        // BEFORE this transaction, and with two active holders a concurrent removal/re-role of
        // THIS caller is permitted (another holder remains) — the stale token role must not
        // record an immutable approval. Applies to the role-decider arms (client-held +
        // client, pmc-held + pmc) AND the PMC on-behalf arm alike; the named-decider arm is
        // covered by the member re-lock below. `hasProjectRoleStanding` with `forUpdate`
        // serializes against the concurrent standing write (the same primitive the record
        // publication's author recheck uses).
        if (!isNamedDecider) {
          const live = await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, user.sub, [user.role], { forUpdate: true });
          if (!live) {
            throw new ForbiddenException(
              'Your project standing changed while approving — the role that authorized this approval is no longer yours',
            );
          }
        }
        // CAS: commit only if the decision is STILL in the state we read — a concurrent
        // transition makes count 0 and this caller loses with a deterministic 409
        // 4b: a NAMED decider's membership is re-locked and its display identity resolved by
        // the owner INSIDE the transaction, so the frozen tuple names the person as they were
        // at the act (and an approval racing the member's removal serializes on the row).
        let holderDisplay = holderLabel;
        if (d.deciderKind === 'member') {
          const member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, d.deciderMembershipId!);
          if (!member) throw new ConflictException('The named decider is no longer an active member of this project');
          if (isNamedDecider && member.userId !== user.sub) {
            throw new ForbiddenException('Only this decision\'s decider (or the PMC on their behalf) can approve it');
          }
          holderDisplay = member.name;
        }
        // the actor's FROZEN pair (A2's seam), resolved BEFORE the delivery rows and the decision row are
        // locked (its reads lock standing rows, which come before both in the one order): the revision's
        // `approvedByRole`/`approvedByName`, the event's envelope and the notice's text are one reading.
        // A provisional approval REQUIRES the pair (the birth seal's arm). 4d-iii / R0a — so does a no-chain
        // approval (the Board's Decision 2): a stale role is refused with a re-sign-in, never recorded
        // with NULLs, and the re-approval closure below writes the same pair as its resolver.
        const envelope = await resolveActorEnvelope(tx, projectId, actor);
        if (!envelope) {
          if (chainActive) {
            throw new ConflictException('Your project standing could not be frozen for a provisional approval — reload and retry');
          }
          throw new ForbiddenException(STALE_ROLE_MESSAGE);
        }
        // THE ONE LOCK ORDER (§A.4 (i)): the subject's queued push deliveries FOR UPDATE ascending, THEN the
        // decision row — the decider and forward demands this act outdates and, when the approval leaves
        // the consultation-open set (no chain), the open invitations too
        await lockQueuedPushDeliveries(tx, { projectId, subject: decisionId, eventTypes: ['decision.published', 'decision.forwarded', ...(chainActive ? [] : ['decision.consultation_requested'])] });
        // #672 round 1 (Codex): the CAS names the HOLDER the authority above was judged against, beside
        // the status — the pre-read is taken before the readiness key, and a forward committing in
        // between leaves the status where it was (`pending` stays `pending`, `change` stays `change`)
        // while moving the holder, so a status-only CAS would let a DISPLACED holder's approval land
        // with its stale authorization and freeze a tuple naming a holder the decision no longer
        // carries (a first tuple is refused by nothing; a frozen one is not compared again). Count 0
        // is the same deterministic 409, no side effects.
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, status: prior, deciderKind: d.deciderKind, deciderMembershipId: d.deciderMembershipId ?? null },
          data: {
            status: landing,
            approvedOption: o.label,
            material: o.material,
            cost: o.delta,
            approver: actor.actorName,
            approvedById: actor.actorId,
            onBehalfOf,
            date: today,
            photoSwatch: o.swatch,
            // the approval act FREEZES the holder tuple it captured consent for (round 3);
            // the holder columns stay current STATE, the act keeps its own history — so a
            // RE-approval never rewrites the FIRST act's tuple (the DB seal refuses it too).
            // 4d-ii-a / A8a — the PROVISIONAL act writes it too, "exactly as the finalizing act
            // would" (§A.2; 4d-i's widened seal arm admits `→ awaiting_countersign`, and A8a's
            // migration widens 4b's `Decision_t4b_approved_tuple_check` beside it).
            ...(d.approvedDeciderKind === null
              ? {
                  approvedDeciderKind: d.deciderKind,
                  approvedDeciderMembershipId: d.deciderKind === 'member' ? d.deciderMembershipId : null,
                  approvedDeciderLabel: holderDisplay,
                }
              : {}),
          },
        });
        if (count === 0) throw new ConflictException('The decision changed while approving (its status or its holder moved) — reload and retry');
        if (prior === 'change') {
          // mandatory re-approval CLOSES the reopening — EXACTLY ONE open request must
          // resolve, or 'reapproved' would lie about what happened (gate finding 1):
          // zero means inconsistent legacy state, more than one is impossible under the
          // partial unique index. Anything but 1 rolls the whole transition back.
          // 4d-iii / R0a — the COMPLETE closure set: this approval's receipt and the approver's frozen
          // pair beside the resolver and the time (R1's CLOSURE arm requires all six).
          const resolved = await tx.changeRequest.updateMany({
            where: { decisionId, status: 'open' },
            data: {
              status: 'resolved', resolution: 'reapproved', resolvedById: actor.actorId, resolvedAt: new Date(),
              resolvedByCommandId: ctx.commandId!, resolvedByRole: envelope.actorRole, resolvedByName: envelope.actorName,
            },
          });
          if (resolved.count !== 1) {
            throw new ConflictException('This decision has no open change request to resolve — its state is inconsistent; ask the PMC to re-raise or withdraw the change');
          }
        }
        // The IMMUTABLE approval revision (Phase 3 Task 1 correction round 2, finding 1) —
        // created in the SAME transaction as the approval it records, with the option pinned
        // by its real key. Version allocation is monotonic across UNPROVABLE legacy history
        // too: the floor is both the register head AND the count of recorded approval events
        // (counted BEFORE this approval's own event lands below), so a legacy approval whose
        // register row could not be backfilled still reapproves as version 2, never as a
        // colliding version 1. Identity SERVED to consumers comes solely from these rows —
        // `decisions.approvedRef` reads the head revision, never event counts or labels.
        // 4d-ii-a / A4a — DELIBERATELY every revision and every approval event, finalized or not:
        // a provisional revision occupies its version as much as a final one does, so the
        // consultation cycle's finalized-only count must never reach this allocation.
        const registerHead = await tx.decisionApprovalRevision.findFirst({
          where: { decisionId }, orderBy: { version: 'desc' }, select: { version: true },
        });
        const priorApprovals = await tx.decisionEvent.count({
          where: { decisionId, type: { in: ['approved', 'reapproved'] } },
        });
        const version = Math.max(registerHead?.version ?? 0, priorApprovals) + 1;
        const revisionId = `dar-${decisionId}-v${version}`;
        await tx.decisionApprovalRevision.create({
          data: {
            id: revisionId,
            projectId, decisionId, version,
            optionKey: o.optionKey,
            approvedAt: new Date(),
            approvedById: actor.actorId,
            onBehalfOf,
            // 4d-ii-a / A8a (§A.2) — the FINALITY key and the act the finalizer emits from: born `true`
            // with no chain (today's row, but for the recorded act), born `false` under one — the birth
            // seal judges the value against the register, never the writer; `approvedFrom` is the
            // status the act left (`approved` vs `reapproved` at finalization), and the approver's pair
            // is the frozen envelope (judged against the registers by the same seal).
            finalized: !chainActive,
            approvedFrom: prior,
            approvedByName: envelope.actorName,
            approvedByRole: envelope.actorRole,
            // 4c-ii — the receipt of the approval command this revision IS the product of. The
            // deferred trigger installed in this unit's migration requires it to have SUCCEEDED
            // at commit with its `resultRef` naming THIS decision, which is precisely when
            // `executeCommand` writes it. A reserved-only test would not be enough: the receipt
            // seal permits a `reserved` INSERT and validates completion only if an UPDATE occurs,
            // so an alternate writer could insert a reserved receipt and a revision citing it in
            // ONE transaction and commit — never approving, never completing — and the count
            // would still advance.
            sourceCommandId: ctx.commandId,
          },
        });
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
        await recordAudit(tx, { projectId, actor, action: 'decision.approve', entity: 'Decision', entityId: decisionId });
        // 4d-ii-a / A7a — the green notice is KINDED, and a kinded notice is RENDERED by every reader
        // from its event: the approver from the event's frozen actor envelope, the option and the
        // on-behalf fact from the revision the event NAMES (`revisionId`, the exact revision this
        // act wrote — never the head, so an older notice of a twice-approved decision keeps its own
        // approver and option). So the envelope is resolved HERE (A2's seam: one reading for the
        // event and the notice), the payload carries what the text needs beside the revision id,
        // and the cached text is built from the same facts the renderer reads.
        const announce = approvedDecisionNotice({
          actorName: envelope.actorName,
          actorRole: envelope.actorRole,
          title: d.title, material: o.material, deciderKind: d.deciderKind, onBehalfOf,
        });
        // 4d-ii-a / A8a (§A.4 (i)) — the demands this act outdates, cancelled by subject under the locks
        // taken above: the decider's "awaiting your approval" and any "forwarded to you" still queued
        // (the holder acted); and with no chain the open consultation invitations (the approval leaves the
        // open set, so `consultation.respond` refuses from here). Under a chain the consultations stay
        // open while the decision awaits, and nothing of that family is cancelled.
        await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.published' });
        await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.forwarded' });
        if (!chainActive) await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.consultation_requested' });
        const eventId = randomUUID();
        const facts = { option: o.label, material: o.material, ...(onBehalfOf ? { onBehalfOf } : {}), revisionId, title: d.title, deciderKind: d.deciderKind };
        if (chainActive) {
          // THE COUNTERSIGN DEMAND (§A.2, obligation 7): exactly ONE `decision.awaiting_countersign` —
          // its payload the provisional act (the status it left, the approver's frozen pair, the
          // revision it wrote) and its recipients the architects FROZEN now — and NEVER an approval
          // event, which announces a finality the finalizer alone may announce (A8b). The durable
          // notice tells the same truth: the approval, and the countersign it still awaits — the
          // awaiting colour, never green.
          const architects = await RoleStandingQuery.holderUserIds(tx, projectId, 'architect');
          const provisional = provisionalApprovalNotice({ actorName: envelope!.actorName, actorRole: envelope!.actorRole, title: d.title, material: o.material, deciderKind: d.deciderKind, onBehalfOf });
          const ev = await emitEvent(tx, {
            projectId, actor, eventId, actorEnvelope: envelope,
            eventType: 'decision.awaiting_countersign', entityType: 'Decision', entityId: decisionId,
            payload: { ...facts, approvedFrom: prior, approverName: envelope!.actorName, approverRole: envelope!.actorRole },
            effectKey: 'decision.awaiting_countersign',
            dispatch: { push: { body: EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody, targetUserIds: architects } },
          });
          await tx.notification.create({ data: { projectId, text: provisional, color: AWAITING_COUNTERSIGN_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.awaiting_countersign', eventId } });
          return { resultRef: decisionId, events: [ev] };
        }
        const ev = await emitEvent(tx, {
          projectId, actor, eventId, actorEnvelope: envelope,
          eventType: prior === 'change' ? 'decision.reapproved' : 'decision.approved', entityType: 'Decision', entityId: decisionId,
          payload: facts,
          effectKey: prior === 'change' ? 'decision.reapproved' : 'decision.approved',
          dispatch: { push: { body: announce } },
        });
        await tx.notification.create({ data: { projectId, text: announce, color: APPROVED_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: prior === 'change' ? 'decision.reapproved' : 'decision.approved', eventId } });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    // the decision is locked; PMC/contractor/engineer act on it — told truthfully by whom (fresh only)
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 task 4d (4d-ii-a / A8a, §A.2 "Forwarding") — `decisions.forward`: the current holder, the PMC
   * or an architect hands an OPEN, PUBLISHED decision to another designation. The HOLDER is the decision's
   * current decider designation; forwarding re-points it, and the append-only `DecisionForward` chain
   * records each hop — the DISPLACED designation, the new one, the ACTOR (a PMC forwarding a client-held
   * decision is recorded as the PMC displacing the client) with the actor's frozen pair, the reason and the
   * receipt. The fact is written FIRST (4d-i's seal compares it to the holder the decision carries at that
   * instant), the holder columns move with it through the ONE door in 4b's holder freeze, and the hop is
   * announced by exactly one `decision.forwarded` — a FROZEN-audience push at the new holder's users as
   * they are now — with its audit row and its kinded notice, in the transition's own transaction.
   *
   * Refused 409 while 4d-i's reservation stands (the door judged under the readiness key, before any
   * write); 409 to a client below `countersign-v1` under an active chain; 409 on a draft, on a record, on
   * a decision that is not `pending`/`change` (an `awaiting_countersign` decision is the ARCHITECT's
   * action item — it moves through the countersign, the rejection or the stranded resolution, never a
   * generic forward), on a same-target forward and on a target that cannot act (a removed member, a role
   * nobody holds); 403 to a caller who is neither the holder, a PMC nor an architect. The DB doors judge
   * every one of these again at INSERT and at COMMIT (`phase6_t4d_forward_seal`, `_paired`,
   * `_provenance_bound`, `_claim*`).
   */
  async forward(projectId: string, decisionId: string, input: ForwardDecisionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const reason = input.reason; // zod `.trim().min(1)` — already trimmed, provably non-blank
    const toKind = input.toDesignationKind;
    const toMembershipId = toKind === 'member' ? input.toDesignationMembershipId! : null;
    const requestHash = hashRequest({ decisionId, toKind, toMembershipId, reason });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.forward', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({
      where: { id: decisionId },
      include: { deciderMembership: { select: { userId: true, id: true } } },
    });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    // every refusal here is an ANSWER given before any write, and every one is re-judged under the lock
    if (d.publishedAt === null) throw new ConflictException('A draft cannot be forwarded — it is its author\'s private workspace; publish it first');
    if (d.deciderKind === 'none') throw new ConflictException(`Decision ${decisionId} is a record-only issue — it has no holder to forward`);
    if (d.status === 'awaiting_countersign') {
      throw new ConflictException(`Decision ${decisionId} is awaiting the architect's countersign — that is the architect's action item; it moves through the countersign, a rejection or the stranded resolution, never a forward`);
    }
    if (d.status !== 'pending' && d.status !== 'change') {
      throw new ConflictException(`Decision ${decisionId} is ${d.status} — forwarding is legal only while the decision is open for its holder to act on`);
    }
    if (d.deciderKind === toKind && (d.deciderMembershipId ?? null) === toMembershipId) {
      throw new ConflictException('That designation is already the holder of this decision');
    }
    const fromKind = d.deciderKind;
    const fromMembershipId = fromKind === 'member' ? d.deciderMembershipId : null;

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.forward',
      idempotencyKey,
      requestHash,
      // the fact's `sourceCommandId` is REQUIRED (§A.3 obligation 6): an unkeyed call takes a per-call
      // server key so the receipt exists; a client key keeps its exactly-once replay
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        // the reservation door, judged under the readiness key: 409 until 4d-iii retires it
        await assertPhase6_4dOpen(tx, 'Forwarding a decision');
        await assertCountersignClient(tx, projectId, user.decisionsContract, 'Forwarding a decision');
        // AUTHORITY (the owner's amendment: the current HOLDER + the PMC + the architect), every arm judged
        // LIVE under the standing rows' locks — Membership before the decision row (the one order): the
        // route's role re-validated, then the holder arm (a named holder's own membership, locked; a role
        // holder through the delivered standing read, the architect through the kernel register), then
        // pmc, then the architect.
        const liveRole = await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, user.sub, [user.role], { forUpdate: true });
        if (!liveRole) throw new ForbiddenException('Your project standing changed while forwarding — the role that authorized this forward is no longer yours');
        let isHolder = false;
        if (fromKind === 'member') {
          const from = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, fromMembershipId!);
          if (!from) throw new ConflictException('The current holder is no longer an active member of this project — the decision must be re-homed by the PMC');
          isHolder = from.userId === user.sub;
        } else if (fromKind === 'architect') {
          isHolder = await RoleStandingQuery.holdsRole(tx, projectId, user.sub, 'architect');
        } else {
          isHolder = await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, user.sub, [fromKind], { forUpdate: true });
        }
        const isPmc = user.role === 'pmc';
        const isArchitect = user.role === 'architect' && (await RoleStandingQuery.holdsRole(tx, projectId, user.sub, 'architect'));
        if (!isHolder && !isPmc && !isArchitect) {
          throw new ForbiddenException('Only this decision\'s current holder, the PMC or an architect can forward it');
        }
        // THE TARGET must be able to act, judged under its own standing lock: a NAMED member's active
        // membership (locked), or a role at least one active member holds — and its users are the
        // recipients FROZEN on the push (`targetUserIds`), resolved at this instant under the same locks.
        let targetUserIds: string[];
        let toLabel: string;
        if (toKind === 'member') {
          const to = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, toMembershipId!);
          if (!to) throw new ConflictException('The forward target holds no active membership on this project — the new holder must be able to act');
          targetUserIds = [to.userId];
          toLabel = to.name;
        } else {
          targetUserIds = await this.orgsParticipant.effectiveRoleHolderUserIds(tx, projectId, toKind);
          if (targetUserIds.length === 0) throw new ConflictException(`Nobody holds the ${toKind} role on this project — the decision would land with nobody able to act on it`);
          toLabel = DESIGNATION_ROLE_LABEL[toKind];
        }
        // the actor's FROZEN pair (A2's seam) — the fact's `forwardedByRole`/`forwardedByName`, the event's
        // envelope and the audit row are one reading; the seal refuses a pair the actor does not hold
        const envelope = await resolveActorEnvelope(tx, projectId, actor);
        if (!envelope) throw new ConflictException('Your project standing could not be frozen for this forward — reload and retry');
        // THE ONE LOCK ORDER (§A.4 (i)): the subject's queued decider and forward deliveries FOR UPDATE
        // ascending, THEN the decision row
        await lockQueuedPushDeliveries(tx, { projectId, subject: decisionId, eventTypes: ['decision.published', 'decision.forwarded'] });
        const rows = await tx.$queryRaw<Array<{ status: string; publishedAt: Date | null; deciderKind: string; deciderMembershipId: string | null; title: string }>>`
          SELECT "status"::text AS status, "publishedAt", "deciderKind"::text AS "deciderKind", "deciderMembershipId", "title"
            FROM "Decision" WHERE "projectId" = ${projectId} AND "id" = ${decisionId} FOR UPDATE`;
        const cur = rows[0];
        if (!cur || cur.publishedAt === null || (cur.status !== 'pending' && cur.status !== 'change')
          || cur.deciderKind !== fromKind || (cur.deciderMembershipId ?? null) !== fromMembershipId) {
          throw new ConflictException('The decision changed while forwarding — reload and retry');
        }
        // THE FACT FIRST (4d-i's seal compares it to the holder the decision carries at this instant), THEN
        // the holder moves through the one door — the same transaction, field for field
        const forwardId = `dfw-${randomUUID()}`;
        await tx.decisionForward.create({
          data: {
            id: forwardId, projectId, decisionId,
            fromDesignationKind: fromKind, fromDesignationMembershipId: fromMembershipId,
            toDesignationKind: toKind, toDesignationMembershipId: toMembershipId,
            forwardedById: actor.actorId, forwardedByRole: envelope.actorRole, forwardedByName: envelope.actorName,
            reason, sourceCommandId: ctx.commandId!,
          },
        });
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, deciderKind: fromKind, deciderMembershipId: fromMembershipId },
          data: { deciderKind: toKind, deciderMembershipId: toMembershipId },
        });
        if (count === 0) throw new ConflictException('The decision changed while forwarding — reload and retry');
        // §A.4 (i): a forward outdates the displaced holder's "awaiting your approval" and any earlier
        // "forwarded to you" still queued — cancelled by subject under the locks taken above
        const cancelledDecider = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.published' });
        const cancelledForwards = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.forwarded' });
        const pushIntentsCancelled = [cancelledDecider, cancelledForwards].reduce((n, c) => n + c.neutralized + c.marked + c.entombed, 0);
        const from = { kind: fromKind, membershipId: fromMembershipId };
        const to = { kind: toKind, membershipId: toMembershipId };
        // the audit register keeps the act (the correspondence seal binds it to the event and the fact)
        await tx.decisionEvent.create({
          data: {
            decisionId, type: 'forwarded',
            actor: actor.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole,
            payload: { forwardId, from, to, toLabel, reason },
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'decision.forward', entity: 'Decision', entityId: decisionId });
        const eventId = randomUUID();
        const ev = await emitEvent(tx, {
          projectId, actor, eventId, actorEnvelope: envelope,
          eventType: 'decision.forwarded', entityType: 'Decision', entityId: decisionId,
          payload: { forwardId, title: cur.title, from, to, toLabel, reason, pushIntentsCancelled },
          effectKey: 'decision.forwarded',
          // the frozen-audience family: the new holder's users as they are NOW, and the catalog's body
          dispatch: { push: { body: EXTERNAL_EFFECTS['decision.forwarded'].pushBody, targetUserIds } },
        });
        await tx.notification.create({ data: { projectId, text: forwardedDecisionNotice(cur.title, toLabel), color: FORWARDED_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.forwarded', eventId } });
        // the receipt names the FACT (the provenance seal's `resultRef` arm)
        return { resultRef: forwardId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 unit 4c-ii (§A) — ASK a named member for advice on an open decision.
   *
   * Consultation INFORMS; it never gates. This command moves no status, touches no gate verdict,
   * and grants the consultee no authority — it widens their sight of ONE decision, for the cycle
   * it was asked in, and queues a "you were asked" push.
   *
   * THE CANONICAL 4c LOCK ORDER (§A round 13), which every 4c path takes without exception:
   *
   *     readiness key → `Project` → `Membership` → `Decision`
   *
   * It is APPROVAL's order, not a tidier one. `decisions.approve` takes the readiness key, then
   * the named decider's membership through `lockActiveMembershipById`, and only then updates the
   * `Decision` row. When the consultee IS the named decider — an ordinary case, since the person
   * best placed to advise is often the one deciding — a decision-before-membership order here
   * would have approval holding `Membership` waiting for `Decision` while this path holds
   * `Decision` waiting for `Membership`, and PostgreSQL would abort one of them. Status and cycle
   * are still judged AFTER the decision lock is held; only the order of the earlier locks changes.
   */
  async requestConsultation(
    projectId: string,
    decisionId: string,
    input: RequestConsultationInput,
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<SnapshotDto> {
    // Review round 19 — the key is REQUIRED, and refused at the contract with a deliberate 400.
    // Both consultation facts carry a NOT NULL `sourceCommandId` naming the receipt of the
    // command currently executing; when `COMMAND_KEY_ENFORCED` is unset and a caller omits the
    // header, the delivered kernel takes its LEGACY unkeyed branch, which reserves NO ledger row
    // and runs with `{ commandId: null }`. Without this refusal the write reaches PostgreSQL and
    // surfaces as an internal constraint failure — a 500 where the honest answer is that this
    // command needs a key.
    const key = requireIdempotencyKey(idempotencyKey, 'consultations.request');
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, consulteeMembershipId: input.consulteeMembershipId, question: input.question });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'consultations.request', key, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'consultations.request',
      idempotencyKey: key,
      requestHash,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        // (2) `Project`. Passing `ProjectAccessService` at the door was a read of a THEN-live
        // project: an archive can commit between the guard and the write, and every eligibility
        // predicate below would still pass, appending immutable advice plus its push into an
        // archived project. This lock-and-check is inside the transaction for that reason, and
        // the DB INSERT seal mirrors the same predicate.
        if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) {
          throw new ConflictException('This project is archived — no consultation can be recorded against it');
        }
        // (3) `Membership` — the consultee, locked and resolved by its OWNER in one call. The
        // membership id denotes one person for its lifetime (identity is DB-frozen), so what this
        // serializes against is the ACTIVE→removed transition, which is a live state change.
        const consultee = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, input.consulteeMembershipId);
        if (!consultee) throw new ConflictException('That member is not an active member of this project');
        // the 4b round-11 LIVE-STANDING rule: `user.role` was established by JwtGuard BEFORE this
        // transaction, so the authority to ASK is re-validated inside it, under the row lock.
        const standing = await consultationRequesterStanding(this.orgsParticipant, tx, projectId, user.sub);
        if (!standing) {
          throw new ForbiddenException('Your project standing changed — asking for advice on this decision is a PMC or architect authority');
        }
        // (4) `Decision`, last, under its own row lock, so a withdrawal committing concurrently
        // either waits or is seen.
        const d = await lockDecisionForConsultation(tx, projectId, decisionId);
        if (!d) throw new NotFoundException(`Decision ${decisionId} not found`);
        assertConsultationEligible(d, decisionId);
        if (consultee.userId === user.sub) {
          throw new BadRequestException('Asking yourself for advice records nothing — name the member you want to hear from');
        }
        // the cycle is FROZEN here, counted under the decision lock the seal re-counts under.
        // 4d-ii-a / A4a — FINALIZED approvals only: a provisional approval awaiting countersign
        // has not closed the cycle, so a question asked beside it belongs to the current one.
        const openCycle = await tx.decisionApprovalRevision.count({ where: { decisionId, finalized: true } });

        // 4d-ii-a / A7b — the requester's FROZEN attribution pair (the role the seal judged, `pmc` or
        // `architect`, and the account's registered name), resolved in this transaction through A2's
        // seam and written on the fact AND handed to the event, so the row and its event are one
        // reading. 4d-iii / R0a — a requester whose role no longer stands is refused with a re-sign-in
        // (the Board's Decision 2), never recorded with a NULL pair.
        const pair = await requireActorEnvelope(tx, projectId, actor);
        const id = `dc-${ctx.commandId}`;
        await tx.decisionConsultation.create({
          data: {
            id, projectId, decisionId,
            requestedById: actor.actorId,
            requestedByRole: pair.actorRole, requestedByName: pair.actorName,
            consulteeMembershipId: input.consulteeMembershipId,
            // the DECISIONS-OWNED canonical audience, resolved by the owner in this transaction —
            // never folded from `Membership` at read time (a cross-module read) and never carried
            // only in an event payload (a rebuild replays none)
            consulteeUserId: consultee.userId,
            question: input.question,
            openCycle,
            requestedAt: new Date(),
            sourceCommandId: ctx.commandId!,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'consultations.request', entity: 'Decision', entityId: decisionId });
        const body = `${actor.actorName} asked you about ${d.title}`;
        const ev = await emitEvent(tx, {
          projectId, actor, actorEnvelope: pair,
          eventType: 'decision.consultation_requested',
          entityType: 'Decision', entityId: decisionId,
          payload: { consultationId: id, consulteeUserId: consultee.userId },
          effectKey: 'decision.consultation_requested',
          // TARGETED at the consultee. The ceiling in the catalog is every role a consultee can
          // hold; this site narrows it to the ONE user, so the delivery reaches their currently
          // valid links and no same-role device.
          dispatch: { push: { body, roles: [consultee.role as 'contractor'], targetUserId: consultee.userId } },
        });
        return { resultRef: id, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 unit 4c-ii (§A) — the NAMED consultee answers, once.
   *
   * Eligibility is re-judged at THIS moment, not inherited from the request: a request made while
   * `pending` outlives the decision, and a stale answer would append immutable advice — and its
   * push — against a row the consultee must no longer see. The same canonical lock order applies.
   *
   * And eligibility is not a STATUS test alone. `decisions.requestChange` moves an `approved`
   * decision back to `change`, so a status-only guard would REVIVE a consultation the approval
   * already closed: ask while `pending` → approve → request change → a late answer appends advice
   * against a question that belonged to the PREVIOUS cycle. The consultation's frozen `openCycle`
   * must still equal the decision's current cycle; asking again in the new cycle means a NEW
   * consultation, the same shape as the register's own "a changed need is a NEW decision" rule.
   */
  async respondToConsultation(
    projectId: string,
    decisionId: string,
    input: RespondToConsultationInput,
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<SnapshotDto> {
    const key = requireIdempotencyKey(idempotencyKey, 'consultations.respond');
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      decisionId, consultationId: input.consultationId, response: input.response,
      recommendedOptionIndex: input.recommendedOptionIndex ?? null,
    });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'consultations.respond', key, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'consultations.respond',
      idempotencyKey: key,
      requestHash,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) {
          throw new ConflictException('This project is archived — no advice can be recorded against it');
        }
        // This unlocked read chooses WHICH membership to lock; it decides nothing. The answered
        // state it returns is deliberately NOT trusted — see the re-read under the lock below.
        const consultation = await tx.decisionConsultation.findFirst({
          where: { id: input.consultationId, projectId, decisionId },
          // `openCycle` and `requestedById` are frozen at request time on an append-only row, so
          // reading them here rather than under the lock changes nothing; the ANSWERED state is
          // the volatile field, and that one is re-read below.
          select: { id: true, consulteeMembershipId: true, openCycle: true, requestedById: true, requestedByRole: true },
        });
        if (!consultation) throw new NotFoundException('That consultation does not exist on this decision');
        // the consultee membership, RE-LOCKED and re-resolved: a consultee removed after their JWT
        // was minted cannot append immutable advice.
        const consultee = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, consultation.consulteeMembershipId);
        if (!consultee) throw new ConflictException('You are no longer an active member of this project');
        if (consultee.userId !== user.sub) {
          throw new ForbiddenException('Only the member who was asked can answer this consultation');
        }
        // THE ANSWERED STATE, re-read UNDER THE MEMBERSHIP LOCK (review round 31).
        //
        // Reading `response` on the unlocked row above and acting on it is a lost update: two
        // answers submitted concurrently under DIFFERENT idempotency keys both observe no
        // response, both proceed, and the loser reaches the `DecisionConsultationResponse`
        // one-per-consultation unique index. `executeCommand` reads that `P2002` as an
        // idempotency-reservation race and answers "concurrent command with this key … retry" —
        // sending the consultee to retry something that can now only ever fail, when the true and
        // useful answer is that the question has already been answered.
        //
        // This is a RE-READ rather than a new `FOR UPDATE` on the consultation, deliberately. The
        // membership lock above is exclusive and both racers take the SAME row — only the named
        // consultee may answer, enforced two lines up — so they are already serialized here, and
        // a fresh read under READ COMMITTED sees the winner's committed response. Taking the
        // consultation row itself would add a lock that the response INSERT's own foreign key
        // (KEY SHARE on that row) conflicts with, which trades this defect for a deadlock; that
        // was measured, not assumed.
        const answered = await tx.decisionConsultationResponse.findFirst({
          where: { consultationId: consultation.id },
          select: { id: true },
        });
        if (answered) {
          throw new ConflictException('This consultation has already been answered — advice is recorded once and never edited');
        }
        const d = await lockDecisionForConsultation(tx, projectId, decisionId);
        if (!d) throw new NotFoundException(`Decision ${decisionId} not found`);
        assertConsultationEligible(d, decisionId);
        // (4d-ii-a / A4a: FINALIZED approvals, the rule the request froze `openCycle` by)
        const cycle = await tx.decisionApprovalRevision.count({ where: { decisionId, finalized: true } });
        if (cycle !== consultation.openCycle) {
          throw new ConflictException(
            'This decision was approved since you were asked — that question is closed. A new question in the reopened decision is a new consultation.',
          );
        }

        // an option INDEX is resolved to the option's id HERE, against this decision's own ordered
        // options: an index is evidence bound to nothing and survives a reordering pointing
        // elsewhere. The stored reference is same-decision by the delivered composite FK.
        let recommendedOptionId: string | null = null;
        if (input.recommendedOptionIndex !== undefined) {
          const options = await tx.decisionOption.findMany({ where: { decisionId }, orderBy: { order: 'asc' }, select: { id: true } });
          const chosen = options[input.recommendedOptionIndex];
          if (!chosen) throw new BadRequestException('Invalid option index');
          recommendedOptionId = chosen.id;
        }

        // 4d-ii-a / A7b — the responder's frozen pair, exactly as the request writes the requester's
        const pair = await requireActorEnvelope(tx, projectId, actor);
        const id = `dcr-${ctx.commandId}`;
        await tx.decisionConsultationResponse.create({
          data: {
            id, projectId, consultationId: consultation.id, decisionId,
            respondedById: actor.actorId,
            respondedByRole: pair.actorRole, respondedByName: pair.actorName,
            response: input.response,
            recommendedOptionId,
            respondedAt: new Date(),
            sourceCommandId: ctx.commandId!,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'consultations.respond', entity: 'Decision', entityId: decisionId });
        const body = `${actor.actorName} answered your question about ${d.title}`;
        // 4d-ii-a / A7b (plan §A.2, #557's review round 1 finding 2 / round 2 finding 4) — the intent
        // RECORDS THE AUDIENCE THE SEND REACHES: the requester's ACTUAL role, read from the
        // consultation row's FROZEN `requestedByRole` (never resolved at response time), so the
        // immutable intent and the claim-time predicate agree. A legacy or drain-window request
        // carries no frozen role, and only a `pmc` could have made one, so NULL reads as `pmc`.
        const requesterRole = (consultation.requestedByRole ?? 'pmc') as 'pmc';
        const ev = await emitEvent(tx, {
          projectId, actor, actorEnvelope: pair,
          eventType: 'decision.consultation_responded',
          entityType: 'Decision', entityId: decisionId,
          payload: { consultationId: consultation.id, responseId: id },
          effectKey: 'decision.consultation_responded',
          // TARGETED at the person who asked. The requester may be an org-admin USER with no
          // membership row on this project, which is exactly why the target is user-keyed.
          dispatch: { push: { body, roles: [requesterRole], targetUserId: consultation.requestedById } },
        });
        return { resultRef: id, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  // ═══ Phase 6 task 4d (4d-ii-a / A8b) — THE CHAIN'S THREE REMAINING WRITERS ═══════════════════════

  /** The decision's OPEN provisional approval: its highest-version revision, still unfinalized, with the
   *  option it chose. What the countersign and the stranded resolution act on (4d-i's
   *  `phase6_t4d_provisional_head` judges the same thing at the fact's insert). */
  private async provisionalHead(tx: Prisma.TransactionClient, projectId: string, decisionId: string) {
    const head = await tx.decisionApprovalRevision.findFirst({
      where: { projectId, decisionId },
      orderBy: { version: 'desc' },
      include: { option: { select: { label: true, material: true } } },
    });
    if (!head || head.finalized) {
      throw new ConflictException('The decision carries no provisional approval to act on — reload and retry');
    }
    if (!head.approvedByName || !head.approvedByRole || (head.approvedFrom !== 'pending' && head.approvedFrom !== 'change')) {
      throw new ConflictException('The provisional approval records no frozen approver or source — it cannot be finalized');
    }
    return head as typeof head & { approvedByName: string; approvedByRole: string; approvedFrom: 'pending' | 'change' };
  }

  /** The decision row under its lock, for the three A8b writers: the status, holder and title as they
   *  stand at this instant (the pre-read was a plain read). */
  private async lockAwaitingDecision(tx: Prisma.TransactionClient, projectId: string, decisionId: string, what: string) {
    const rows = await tx.$queryRaw<Array<{ status: string; deciderKind: string; deciderMembershipId: string | null; title: string }>>`
      SELECT "status"::text AS status, "deciderKind"::text AS "deciderKind", "deciderMembershipId", "title"
        FROM "Decision" WHERE "projectId" = ${projectId} AND "id" = ${decisionId} FOR UPDATE`;
    const cur = rows[0];
    if (!cur || cur.status !== 'awaiting_countersign') {
      throw new ConflictException(`The decision changed while ${what} — reload and retry`);
    }
    return cur;
  }

  /**
   * The FINALIZATION a countersign or a `completed` stranded resolution performs, after its fact is written
   * (the fact FIRST: the countersign and stranded seals judge the subject and the provisional head at the
   * insert): the head's finality flip (the one permitted revision transition, paired by
   * `DecisionApprovalRevision_t4d_flip_paired` to the fact), `awaiting_countersign → approved` (paired by
   * the fact's own seal at commit), the finalizer's audit row, the demands the finalization outdates
   * cancelled by subject (the countersign demand answered; the approval leaves the consultation-open set),
   * and exactly ONE finalizing event — `decision.approved` or `decision.reapproved` by the revision's
   * RECORDED `approvedFrom`, naming the exact revision, the finalization and the approver's frozen pair —
   * with the green notice bound to it: the approver from the revision's frozen facts, the finalizer as a
   * distinct attribution.
   */
  private async finalizeProvisionalApproval(
    tx: Prisma.TransactionClient,
    args: {
      projectId: string; decisionId: string; actor: ReturnType<typeof resolveActor> extends Promise<infer A> ? A : never;
      envelope: { actorRole: string; actorName: string };
      head: Awaited<ReturnType<DecisionsService['provisionalHead']>>;
      cur: { title: string; deciderKind: string };
      finalization: ApprovalFinalization;
      audit: { type: 'countersigned' | 'stranded_resolved'; payload: Prisma.InputJsonObject };
      auditAction: string;
      factRef: Record<string, string>;
    },
  ): Promise<EmittedEventMeta> {
    const { projectId, decisionId, actor, envelope, head, cur } = args;
    const flipped = await tx.decisionApprovalRevision.updateMany({
      where: { id: head.id, projectId, decisionId, finalized: false },
      data: { finalized: true },
    });
    if (flipped.count !== 1) throw new ConflictException('The provisional approval changed while finalizing — reload and retry');
    const { count } = await tx.decision.updateMany({
      where: { id: decisionId, projectId, status: 'awaiting_countersign' },
      data: { status: 'approved' },
    });
    if (count === 0) throw new ConflictException('The decision changed while finalizing — reload and retry');
    await tx.decisionEvent.create({
      data: {
        decisionId, type: args.audit.type,
        actor: envelope.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole,
        payload: { ...args.audit.payload, revisionId: head.id, option: head.option.label, material: head.option.material },
      },
    });
    await recordAudit(tx, { projectId, actor, action: args.auditAction, entity: 'Decision', entityId: decisionId });
    await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.awaiting_countersign' });
    await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.consultation_requested' });
    const family = head.approvedFrom === 'change' ? 'decision.reapproved' : 'decision.approved';
    const approver = {
      actorName: head.approvedByName, actorRole: head.approvedByRole, title: cur.title,
      material: head.option.material, deciderKind: cur.deciderKind, onBehalfOf: head.onBehalfOf,
    };
    const announce = finalizedApprovalNotice(approver, args.finalization, envelope.actorName);
    const eventId = randomUUID();
    const ev = await emitEvent(tx, {
      projectId, actor, eventId, actorEnvelope: envelope,
      eventType: family, entityType: 'Decision', entityId: decisionId,
      payload: {
        option: head.option.label, material: head.option.material, ...(head.onBehalfOf ? { onBehalfOf: head.onBehalfOf } : {}),
        revisionId: head.id, title: cur.title, deciderKind: cur.deciderKind, approvedFrom: head.approvedFrom,
        finalization: args.finalization, approverName: head.approvedByName, approverRole: head.approvedByRole,
        ...args.factRef,
      },
      effectKey: family,
      dispatch: { push: { body: announce } },
    });
    await tx.notification.create({ data: { projectId, text: announce, color: APPROVED_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: family, eventId } });
    return ev;
  }

  /**
   * The REJECTION a disagreement or a `returned` stranded resolution performs: the optional same-bundle
   * forward (through the ONE forward door — the fact first, the holder moved), `awaiting_countersign →
   * change`, the open `countersign_rejection` request citing the exact provisional head with the actor's
   * frozen pair and this receipt, the audit rows, the demands the rejection outdates cancelled, and the
   * events: exactly one `decision.change_requested` (the request's, or the returned resolution's) with the
   * change-request notice bound to it (the title and the reason), and the frozen-audience
   * `decision.forwarded` with its notice when the bundle re-homes the decision.
   * Neither path touches `pending`; the decider (or the new holder) answers by re-approving.
   */
  private async rejectProvisionalApproval(
    tx: Prisma.TransactionClient,
    args: {
      projectId: string; decisionId: string; commandId: string;
      actor: ReturnType<typeof resolveActor> extends Promise<infer A> ? A : never;
      envelope: { actorRole: string; actorName: string };
      head: Awaited<ReturnType<DecisionsService['provisionalHead']>>;
      cur: { title: string; deciderKind: string; deciderMembershipId: string | null };
      reason: string; costImpact: number; timeImpactDays: number;
      target: { kind: 'client' | 'pmc' | 'member' | 'architect'; membershipId: string | null } | null;
      auditAction: string;
      /** the resolution's own audit row, when the bundle is a `returned` resolution */
      resolutionAudit?: { type: 'stranded_resolved'; payload: Prisma.InputJsonObject };
      requestPayload: Prisma.InputJsonObject;
    },
  ): Promise<{ requestId: string; forwardId: string | null; events: EmittedEventMeta[] }> {
    const { projectId, decisionId, actor, envelope, head, cur } = args;
    const events: EmittedEventMeta[] = [];
    let forward: { forwardId: string; targetUserIds: string[]; toLabel: string; from: { kind: string; membershipId: string | null }; to: { kind: string; membershipId: string | null } } | null = null;
    if (args.target) {
      const toKind = args.target.kind;
      const toMembershipId = args.target.membershipId;
      if (cur.deciderKind === toKind && (cur.deciderMembershipId ?? null) === toMembershipId) {
        throw new ConflictException('That designation is already the holder of this decision');
      }
      let targetUserIds: string[];
      let toLabel: string;
      if (toKind === 'member') {
        const to = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, toMembershipId!);
        if (!to) throw new ConflictException('The target holds no active membership on this project — the new holder must be able to act');
        targetUserIds = [to.userId];
        toLabel = to.name;
      } else {
        targetUserIds = await this.orgsParticipant.effectiveRoleHolderUserIds(tx, projectId, toKind);
        if (targetUserIds.length === 0) throw new ConflictException(`Nobody holds the ${toKind} role on this project — the decision would land with nobody able to act on it`);
        toLabel = DESIGNATION_ROLE_LABEL[toKind];
      }
      const forwardId = `dfw-${randomUUID()}`;
      const fromMembershipId = cur.deciderKind === 'member' ? cur.deciderMembershipId : null;
      await tx.decisionForward.create({
        data: {
          id: forwardId, projectId, decisionId,
          fromDesignationKind: cur.deciderKind, fromDesignationMembershipId: fromMembershipId,
          toDesignationKind: toKind, toDesignationMembershipId: toMembershipId,
          forwardedById: actor.actorId, forwardedByRole: envelope.actorRole, forwardedByName: envelope.actorName,
          reason: args.reason, sourceCommandId: args.commandId,
        },
      });
      forward = { forwardId, targetUserIds, toLabel, from: { kind: cur.deciderKind, membershipId: fromMembershipId }, to: { kind: toKind, membershipId: toMembershipId } };
    }
    // ONE row write lands the transition and — when the bundle re-homes — the holder move with it:
    // `Decision_t4d_change_paired` judges every row event of this transaction at commit against the
    // `awaiting_countersign → change` move it recorded, so a holder move written as a SEPARATE statement
    // is an event whose row still reads `awaiting_countersign` and is refused as a walked-back move.
    // The attribution seal's one door (the same-transaction `DecisionForward` from the holder the row
    // carries to the one it moves to) judges the holder columns of this same statement.
    const { count } = await tx.decision.updateMany({
      where: {
        id: decisionId, projectId, status: 'awaiting_countersign',
        ...(forward ? { deciderKind: cur.deciderKind as $Enums.DeciderKind, deciderMembershipId: forward.from.membershipId } : {}),
      },
      data: { status: 'change', ...(forward ? { deciderKind: forward.to.kind as $Enums.DeciderKind, deciderMembershipId: forward.to.membershipId } : {}) },
    });
    if (count === 0) throw new ConflictException('The decision changed while rejecting — reload and retry');
    let requestId = '';
    try {
      const request = await tx.changeRequest.create({
        data: {
          projectId, decisionId, reason: args.reason, costImpact: args.costImpact, timeImpactDays: args.timeImpactDays, status: 'open',
          origin: 'countersign_rejection', revisionId: head.id,
          requestedById: actor.actorId, requestedByRole: envelope.actorRole, requestedByName: envelope.actorName,
          sourceCommandId: args.commandId,
        },
        select: { id: true },
      });
      requestId = request.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A change request is already open for this decision');
      }
      throw e;
    }
    if (args.resolutionAudit) {
      await tx.decisionEvent.create({
        data: {
          decisionId, type: args.resolutionAudit.type,
          actor: envelope.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole,
          payload: { ...args.resolutionAudit.payload, revisionId: head.id, requestId },
        },
      });
    }
    await tx.decisionEvent.create({
      data: {
        decisionId, type: 'change_requested',
        actor: envelope.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole,
        payload: { ...args.requestPayload, origin: 'countersign_rejection', revisionId: head.id, requestId, reason: args.reason, costImpact: args.costImpact, timeImpactDays: args.timeImpactDays },
      },
    });
    if (forward) {
      await tx.decisionEvent.create({
        data: {
          decisionId, type: 'forwarded',
          actor: envelope.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole,
          payload: { forwardId: forward.forwardId, from: forward.from, to: forward.to, toLabel: forward.toLabel, reason: args.reason },
        },
      });
    }
    await recordAudit(tx, { projectId, actor, action: args.auditAction, entity: 'Decision', entityId: decisionId });
    // the demands this rejection outdates: the countersign demand (answered), and — when the decision is
    // re-homed — any earlier hand-off still queued (the new forward supersedes it)
    await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.awaiting_countersign' });
    const cancelledForwards = forward ? await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.forwarded' }) : null;
    // the change-request NOTICE (the plan's correspondence table owes it to the `countersign_rejection`
    // origin; #673 round 1): the reopening and its reason, bound to the event that announces it
    const eventId = randomUUID();
    events.push(await emitEvent(tx, {
      projectId, actor, eventId, actorEnvelope: envelope,
      eventType: 'decision.change_requested', entityType: 'Decision', entityId: decisionId,
      payload: { ...args.requestPayload, reason: args.reason, costImpact: args.costImpact, timeImpactDays: args.timeImpactDays, origin: 'countersign_rejection', revisionId: head.id, requestId, title: cur.title },
      effectKey: 'decision.change_requested', dispatch: {},
    }));
    await tx.notification.create({ data: { projectId, text: changeRequestedNotice(cur.title, args.reason), color: CHANGE_REQUESTED_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.change_requested', eventId } });
    if (forward) {
      const eventId = randomUUID(); // the forward's own, in its own block
      events.push(await emitEvent(tx, {
        projectId, actor, eventId, actorEnvelope: envelope,
        eventType: 'decision.forwarded', entityType: 'Decision', entityId: decisionId,
        payload: {
          forwardId: forward.forwardId, title: cur.title, from: forward.from, to: forward.to, toLabel: forward.toLabel, reason: args.reason,
          pushIntentsCancelled: cancelledForwards ? cancelledForwards.neutralized + cancelledForwards.marked + cancelledForwards.entombed : 0,
        },
        effectKey: 'decision.forwarded',
        dispatch: { push: { body: EXTERNAL_EFFECTS['decision.forwarded'].pushBody, targetUserIds: forward.targetUserIds } },
      }));
      await tx.notification.create({ data: { projectId, text: forwardedDecisionNotice(cur.title, forward.toLabel), color: FORWARDED_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.forwarded', eventId } });
    }
    return { requestId, forwardId: forward?.forwardId ?? null, events };
  }

  /**
   * Phase 6 task 4d (4d-ii-a / A8b, §A.2 "Countersign, and the state that carries it") —
   * `decisions.countersign`: the ARCHITECT finalizes a provisional approval. ONE atomic act, sealed from both
   * sides: the `DecisionCountersign` fact naming the EXACT head revision is written first (the seal judges
   * the architect's standing, the awaiting subject and the provisional head at the insert), then the head's
   * finality flip and `awaiting_countersign → approved` — row, flip and status are one transaction or none.
   * The finalizing event is `decision.approved` or `decision.reapproved` by the revision's RECORDED
   * `approvedFrom`, naming the revision; the audit register gains the `countersigned` row beside the
   * `approved`/`reapproved` row the provisional act appended; the green notice names the approver from the
   * revision's frozen facts and the countersigner as a distinct attribution. A self-countersign (the
   * architect is also the decider) is two acts under two keys — this one never approves.
   *
   * Refused 409 unless the decision awaits its countersign; 403 to anyone but an ACTIVE architect
   * (re-judged under the readiness key through the kernel register the seals judge by).
   */
  async countersign(projectId: string, decisionId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, countersign: true });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.countersign', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId }, select: { projectId: true, status: true } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'awaiting_countersign') {
      throw new ConflictException(`Decision ${decisionId} is ${d.status}, not awaiting its countersign — there is no provisional approval to countersign`);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.countersign',
      idempotencyKey,
      requestHash,
      // the fact's `sourceCommandId` is REQUIRED (§A.3 obligation 6): an unkeyed call takes a per-call
      // server key so the receipt exists; a client key keeps its exactly-once replay
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        await assertCountersignClient(tx, projectId, user.decisionsContract, 'Countersigning a decision');
        // AUTHORITY: an ACTIVE architect, live, through the kernel register the countersign seal judges by
        if (user.role !== 'architect' || !(await RoleStandingQuery.holdsRole(tx, projectId, user.sub, 'architect'))) {
          throw new ForbiddenException('Only an active architect can countersign a provisional approval');
        }
        const envelope = await resolveActorEnvelope(tx, projectId, actor);
        if (!envelope || envelope.actorRole !== 'architect') {
          throw new ConflictException('Your architect standing could not be frozen for this countersign — reload and retry');
        }
        // THE ONE LOCK ORDER (§A.4 (i)): the subject's queued countersign demands and open invitations FOR
        // UPDATE ascending, THEN the decision row
        await lockQueuedPushDeliveries(tx, { projectId, subject: decisionId, eventTypes: ['decision.awaiting_countersign', 'decision.consultation_requested'] });
        const cur = await this.lockAwaitingDecision(tx, projectId, decisionId, 'countersigning');
        const head = await this.provisionalHead(tx, projectId, decisionId);
        // THE FACT FIRST
        const countersignId = `dcs-${randomUUID()}`;
        await tx.decisionCountersign.create({
          data: {
            id: countersignId, projectId, decisionId, revisionId: head.id,
            countersignedById: actor.actorId, countersignedByRole: envelope.actorRole, countersignedByName: envelope.actorName,
            sourceCommandId: ctx.commandId!,
          },
        });
        const ev = await this.finalizeProvisionalApproval(tx, {
          projectId, decisionId, actor, envelope, head, cur,
          finalization: 'countersign',
          audit: { type: 'countersigned', payload: { countersignId } },
          auditAction: 'decision.countersign',
          factRef: { countersignId },
        });
        // the receipt names the FACT (the provenance seal's `resultRef` arm)
        return { resultRef: countersignId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 task 4d (4d-ii-a / A8b, §A.2 "Disagreement — the `change` state's OWN machinery honoured") —
   * `decisions.disagree`: the ARCHITECT's answer to a provisional approval. REJECT BACK keeps the decider
   * as holder — they re-approve and the chain runs again; FORWARD ON re-points the holder to the
   * designation the architect names, through the SAME forward door with the SAME `DecisionForward` fact
   * as the generic command, taken from `awaiting_countersign` in the transaction that lands `change`.
   * Both paths open the `countersign_rejection` request (citing the exact provisional head, the
   * architect's frozen pair and this receipt) whose only closures are the re-approval and — never — the
   * ordinary withdrawal. Neither path returns to `pending`; neither erases the approval act it answers.
   *
   * Refused 409 unless the decision awaits its countersign, and on a forward-on naming the current holder;
   * 403 to anyone but an ACTIVE architect.
   */
  async disagree(projectId: string, decisionId: string, input: DisagreeDecisionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const reason = input.reason;
    const costImpact = input.costImpact ?? 0;
    const timeImpactDays = input.timeImpactDays ?? 0;
    const target = input.path === 'forward_on'
      ? { kind: input.toDesignationKind!, membershipId: input.toDesignationKind === 'member' ? input.toDesignationMembershipId! : null }
      : null;
    const requestHash = hashRequest({ decisionId, path: input.path, reason, costImpact, timeImpactDays, target });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.disagree', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId }, select: { projectId: true, status: true, deciderKind: true, deciderMembershipId: true } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'awaiting_countersign') {
      throw new ConflictException(`Decision ${decisionId} is ${d.status}, not awaiting its countersign — there is no provisional approval to disagree with`);
    }
    if (target && d.deciderKind === target.kind && (d.deciderMembershipId ?? null) === target.membershipId) {
      throw new ConflictException('That designation is already the holder of this decision — reject it back instead');
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.disagree',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        await assertCountersignClient(tx, projectId, user.decisionsContract, 'Rejecting a provisional approval');
        if (user.role !== 'architect' || !(await RoleStandingQuery.holdsRole(tx, projectId, user.sub, 'architect'))) {
          throw new ForbiddenException('Only an active architect can reject a provisional approval');
        }
        const envelope = await resolveActorEnvelope(tx, projectId, actor);
        if (!envelope || envelope.actorRole !== 'architect') {
          throw new ConflictException('Your architect standing could not be frozen for this disagreement — reload and retry');
        }
        // THE ONE LOCK ORDER: the subject's queued countersign demands and hand-offs, THEN the decision row
        await lockQueuedPushDeliveries(tx, { projectId, subject: decisionId, eventTypes: ['decision.awaiting_countersign', 'decision.forwarded'] });
        const cur = await this.lockAwaitingDecision(tx, projectId, decisionId, 'rejecting');
        if (cur.deciderKind !== d.deciderKind || (cur.deciderMembershipId ?? null) !== (d.deciderMembershipId ?? null)) {
          throw new ConflictException('The decision changed while rejecting — reload and retry');
        }
        const head = await this.provisionalHead(tx, projectId, decisionId);
        const { requestId, events } = await this.rejectProvisionalApproval(tx, {
          projectId, decisionId, commandId: ctx.commandId!, actor, envelope, head, cur,
          reason, costImpact, timeImpactDays, target,
          auditAction: 'decision.disagree',
          requestPayload: { path: input.path },
        });
        // the receipt names the REQUEST — the bundle's primary fact (the forward, when present, cites the
        // same receipt through the bundle arm of the provenance seal)
        return { resultRef: requestId, events };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 task 4d (4d-ii-a / A8b, §A.2 "The stranded decision, resolved by a NAMED command") —
   * `decisions.resolveStrandedCountersign`: the PMC's named resolution of a decision left
   * `awaiting_countersign` with NO active architect (the last one left; generic forwarding refuses the
   * status and the countersign needs an architect). Legal ONLY while the decision awaits AND the chain is
   * inactive, both re-judged under the readiness key and the decision row lock. Two attributed outcomes,
   * recorded as the append-only `DecisionStrandedResolution` fact naming the exact head: (a) COMPLETED —
   * the head finalizes under the no-chain rule and the decision lands `approved`, announced by the
   * revision's recorded family; (b) RETURNED — the decision lands `change` with the open
   * `countersign_rejection` request carrying the PMC's reason, so the existing machinery demands a fresh
   * approval (which, under the now-inactive chain, lands `approved` directly). A designation WITHOUT an
   * active holder (the named member departed; the role emptied) is re-homed atomically: `returned`
   * REQUIRES a target then, and the bundle carries a `DecisionForward` from the empty designation to the
   * named active target (400 without one); a target for a designation that still has a holder is an
   * ordinary same-bundle forward through the same door.
   */
  async resolveStrandedCountersign(projectId: string, decisionId: string, input: ResolveStrandedCountersignInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const reason = input.reason;
    const costImpact = input.costImpact ?? 0;
    const timeImpactDays = input.timeImpactDays ?? 0;
    const target = input.toDesignationKind
      ? { kind: input.toDesignationKind, membershipId: input.toDesignationKind === 'member' ? input.toDesignationMembershipId! : null }
      : null;
    const requestHash = hashRequest({ decisionId, outcome: input.outcome, reason, costImpact, timeImpactDays, target });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.resolveStrandedCountersign', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId }, select: { projectId: true, status: true, deciderKind: true, deciderMembershipId: true } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'awaiting_countersign') {
      throw new ConflictException(`Decision ${decisionId} is ${d.status}, not awaiting its countersign — it is not stranded`);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.resolveStrandedCountersign',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        // AUTHORITY: the PMC, live under the standing row's lock (the fact freezes `pmc`)
        if (user.role !== 'pmc' || !(await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, user.sub, ['pmc'], { forUpdate: true }))) {
          throw new ForbiddenException('Only the PMC can resolve a stranded decision');
        }
        const envelope = await resolveActorEnvelope(tx, projectId, actor);
        if (!envelope || envelope.actorRole !== 'pmc') {
          throw new ConflictException('Your PMC standing could not be frozen for this resolution — reload and retry');
        }
        // THE PREMISE, re-judged under the readiness key the architect standing writers take (P36): an
        // architect who could countersign makes this act illegal
        if ((await RoleStandingQuery.activeCount(tx, projectId, 'architect')) > 0) {
          throw new ConflictException('This project still holds an active architect — the decision is not stranded; the countersign is the legal path');
        }
        await lockQueuedPushDeliveries(tx, { projectId, subject: decisionId, eventTypes: ['decision.awaiting_countersign', 'decision.consultation_requested', 'decision.forwarded'] });
        const cur = await this.lockAwaitingDecision(tx, projectId, decisionId, 'resolving');
        const head = await this.provisionalHead(tx, projectId, decisionId);
        const resolutionId = `dsr-${randomUUID()}`;
        if (input.outcome === 'completed') {
          // THE FACT FIRST (the stranded seal judges the PMC, the awaiting subject, the inactive chain and
          // the provisional head at the insert), then the finalization it pairs with at commit
          await tx.decisionStrandedResolution.create({
            data: {
              id: resolutionId, projectId, decisionId, revisionId: head.id, outcome: 'completed',
              resolvedById: actor.actorId, resolvedByRole: envelope.actorRole, resolvedByName: envelope.actorName,
              reason, sourceCommandId: ctx.commandId!,
            },
          });
          const ev = await this.finalizeProvisionalApproval(tx, {
            projectId, decisionId, actor, envelope, head, cur,
            finalization: 'stranded_completed',
            audit: { type: 'stranded_resolved', payload: { resolutionId, outcome: 'completed', reason } },
            auditAction: 'decision.resolveStranded',
            factRef: { resolutionId },
          });
          return { resultRef: resolutionId, events: [ev] };
        }
        // RETURNED. The installed designation's standing decides whether a target is REQUIRED: a named
        // member's active membership, or a role at least one active member holds. A designation nobody
        // can act for is re-homed in this bundle or the resolution is refused — the open-holder rule
        // judges a `change` decision's designation at commit, and would otherwise refuse the transition
        // this outcome advertises.
        const holderPresent = cur.deciderKind === 'member'
          ? (await this.orgsParticipant.lockActiveMembershipById(tx, projectId, cur.deciderMembershipId!)) !== null
          : cur.deciderKind === 'none'
            ? false
            : (await this.orgsParticipant.effectiveRoleHolderUserIds(tx, projectId, cur.deciderKind as 'client' | 'pmc' | 'architect')).length > 0;
        if (!holderPresent && !target) {
          throw new BadRequestException('The decision\'s designation has no active holder — a returned resolution must name a target to re-home it to');
        }
        // THE FACT FIRST: the resolution is the bundle's PRIMARY and its claimant (the request that follows
        // verifies), so it is written before the request and before the event
        await tx.decisionStrandedResolution.create({
          data: {
            id: resolutionId, projectId, decisionId, revisionId: head.id, outcome: 'returned',
            resolvedById: actor.actorId, resolvedByRole: envelope.actorRole, resolvedByName: envelope.actorName,
            reason, sourceCommandId: ctx.commandId!,
          },
        });
        const { events } = await this.rejectProvisionalApproval(tx, {
          projectId, decisionId, commandId: ctx.commandId!, actor, envelope, head, cur,
          reason, costImpact, timeImpactDays, target,
          auditAction: 'decision.resolveStranded',
          resolutionAudit: { type: 'stranded_resolved', payload: { resolutionId, outcome: 'returned', reason } },
          requestPayload: { resolutionId, outcome: 'returned' },
        });
        // the receipt names the RESOLUTION — the bundle's primary fact; the request and the forward cite
        // the same receipt through the bundle arm of the provenance seal
        return { resultRef: resolutionId, events };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Raise a Change Request against a locked decision — the ONE formal reopening.
   *  Exactly one open request per decision: the CAS refuses a decision that moved,
   *  and the partial unique index is the database backstop (P2002 → 409). */
  async requestChange(projectId: string, decisionId: string, input: ChangeInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, reason: input.reason, costImpact: input.costImpact, timeImpactDays: input.timeImpactDays });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.requestChange', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'approved') throw new ConflictException('Only a locked decision can have a change request');

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.requestChange',
      idempotencyKey,
      requestHash,
      // 4d-ii-a / A2 — the request records the receipt that opened it (`sourceCommandId`), so an
      // unkeyed call must still reserve one. Synthesis gives it a per-call server key: two unkeyed
      // retries still each run once, exactly as the ledger-less path did, a keyed caller keeps its
      // replay, and enforcement still refuses a missing key first (§A.3 obligation 6).
      synthesizeKeyWhenAbsent: true,
      run: async (tx, { commandId }) => {
        const events: EmittedEventMeta[] = [];
        let requestId = '';
        try {
          // reopening reverts readiness — a readiness write (gate finding 1)
          await lockProjectReadiness(tx, projectId);
          // 4b rounds 8/18 — the REOPEN re-validates the holder's CURRENT standing: the guard
          // cannot see an approved decision, so its holder may legally have left while it was
          // closed. When the holder is GONE the 409 names the TRUE 4b state: the approved
          // outcome STANDS (a changed need is a NEW decision; re-homing is the 4d forward's
          // job). The DB seals the same transition for hostile writers.
          if (d.deciderKind === 'member') {
            const member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, d.deciderMembershipId!);
            if (!member) {
              throw new ConflictException('The named decider is no longer an active member — the approved outcome stands; a changed need is a NEW decision (or, from 4d, forward this one)');
            }
          } else if (d.deciderKind === 'client' || d.deciderKind === 'pmc') {
            const standing = await this.orgsParticipant.effectiveRoleStanding(tx, projectId, d.deciderKind);
            if (standing === 0) {
              throw new ConflictException(`This project has no active ${d.deciderKind} to re-decide — the approved outcome stands; a changed need is a NEW decision`);
            }
          }
          const { count } = await tx.decision.updateMany({
            where: { id: decisionId, projectId, status: 'approved' },
            data: { status: 'change' },
          });
          if (count === 0) throw new ConflictException('The decision changed while requesting — reload and retry');
          // 4d-ii-a / A2 — the frozen requester pair, resolved HERE, inside the transaction (§A.3
          // obligation 3), by the same predicate and identity read `ChangeRequest_t4d_birth_pair`
          // judges it with. ONE resolution feeds the request, its audit row and its event, so the
          // three records of the act name the same role and name (obligation 7). 4d-iii / R0a — a
          // requester whose token role no longer stands is refused with a re-sign-in (Decision 2).
          const pair = await requireActorEnvelope(tx, projectId, actor);
          const request = await tx.changeRequest.create({
            // Phase 6 unit 4d-i — `projectId` became NOT NULL when the row joined the uniform
            // seal contract (§A.3 obligation 5: every reference project-bound through the
            // child's own column). The migration's BEFORE INSERT trigger fills it from the
            // row's decision for the PREVIOUS RELEASE, which never names it and must keep
            // working through the drain; a writer compiled against the new client names it
            // directly. Same row, same value, no behaviour change — the project is the one this
            // command already holds.
            data: {
              projectId, decisionId, reason: input.reason, costImpact: input.costImpact, timeImpactDays: input.timeImpactDays, status: 'open', requestedById: actor.actorId,
              requestedByRole: pair.actorRole, requestedByName: pair.actorName,
              sourceCommandId: commandId,
            },
            select: { id: true },
          });
          requestId = request.id;
          // The audit row's role and name are the SAME pair, both or neither (#643 Codex
          // 4114025986): where the resolution found none (a stale token role), writing the token
          // role would claim a standing this transaction did not observe. `actor` is the legacy
          // display label (NOT NULL), not attribution; it keeps the account name.
          await tx.decisionEvent.create({ data: {
            decisionId, type: 'change_requested', actor: pair.actorName, actorId: actor.actorId,
            actorName: pair.actorName, actorRole: pair.actorRole, payload: input,
          } });
          await recordAudit(tx, { projectId, actor, action: 'decision.change', entity: 'Decision', entityId: decisionId });
          events.push(await emitEvent(tx, { projectId, actor, eventType: 'decision.change_requested', entityType: 'Decision', entityId: decisionId, payload: { reason: input.reason, ...(input.costImpact !== undefined ? { costImpact: input.costImpact } : {}), ...(input.timeImpactDays !== undefined ? { timeImpactDays: input.timeImpactDays } : {}) }, effectKey: 'decision.change_requested', dispatch: {}, actorEnvelope: pair }));
        } catch (e) {
          // the one-open-per-decision partial unique index fired — a concurrent request won.
          // Translate HERE (inside run) so the command kernel never mistakes THIS P2002 for a
          // duplicate-idempotency-key conflict; it sees a ConflictException and propagates it.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('A change request is already open for this decision');
          }
          throw e;
        }
        // A command that writes a fact names THAT fact (§A.3 obligation 6): the deferred
        // `ChangeRequest_t4d_source_bound` requires this receipt's `resultRef` to be the request.
        return { resultRef: requestId, events };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Withdraw the open change request — only its requester or the PMC. The decision
   *  returns to approved/locked and the request records how and by whom it closed. */
  async withdrawChange(projectId: string, decisionId: string, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.withdrawChange', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status !== 'change') throw new ConflictException('No open change request to withdraw');
    const open = await this.prisma.changeRequest.findFirst({ where: { decisionId, status: 'open' } });
    if (!open) throw new ConflictException('No open change request to withdraw');
    if (user.role !== 'pmc' && open.requestedById !== user.sub) {
      throw new ForbiddenException('Only the requester or the PMC can withdraw a change request');
    }
    // 4d-ii-a / A7b (plan §A.2, P33) — THE ORDINARY ESCAPE HATCH IS CLOSED FOR A DISAGREEMENT. This
    // command restores `change → approved`; on a `countersign_rejection` request that would complete
    // an approval WITHOUT its countersign. Re-approval (which runs the chain again) is the only way
    // forward. Refused here first with an answer, and re-judged under the lock below.
    const refuseRejection = (origin: string): void => {
      if (origin === 'countersign_rejection') {
        throw new ConflictException('This change request is an architect\'s countersign rejection — it cannot be withdrawn; the decision moves forward only through re-approval, which runs the countersign again');
      }
    };
    refuseRejection(open.origin);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.withdrawChange',
      idempotencyKey,
      requestHash,
      // 4d-iii / R0a — the closure cites THIS command's receipt (`resolvedByCommandId`, which the 4d-i
      // closure binding requires to be completed in this transaction), so an unkeyed withdrawal still
      // gets one. The synthesized key is unique per call: never a replay, legacy behaviour unchanged.
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        // restoring the lock flips the decision gate back (gate finding 1)
        await lockProjectReadiness(tx, projectId);
        // 4d-iii / R0a — the resolver's frozen pair, resolved before the request and decision rows are
        // touched (the envelope's locks come first in the one order); a stale role is refused with a
        // re-sign-in (the Board's Decision 2). The closure, its audit and its event are one reading.
        const envelope = await requireActorEnvelope(tx, projectId, actor);
        // A7b — the origin re-judged on the row as it stands (the pre-read was a plain read; the
        // seal freezes `origin`, so a row that was `standard` stays so, but the request the
        // pre-read saw may have closed and another opened)
        const openNow = await tx.changeRequest.findFirst({ where: { id: open.id, status: 'open' }, select: { origin: true } });
        if (!openNow) throw new ConflictException('The change request changed while withdrawing — reload and retry');
        refuseRejection(openNow.origin);
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
          data: {
            status: 'withdrawn', resolution: 'withdrawn', resolvedById: actor.actorId, resolvedAt: new Date(),
            resolvedByCommandId: ctx.commandId!, resolvedByRole: envelope.actorRole, resolvedByName: envelope.actorName,
          },
        });
        if (closed.count !== 1) throw new ConflictException('The change request changed while withdrawing — reload and retry');
        await tx.decisionEvent.create({ data: { decisionId, type: 'change_withdrawn', actor: envelope.actorName, actorId: actor.actorId, actorName: envelope.actorName, actorRole: envelope.actorRole } });
        // 4d-ii-a / A7b (plan §A.4 (i)) — this transition LEAVES the consultation-open set, so the
        // decision's not-yet-sent `consultation_requested` deliveries are cancelled by subject under
        // the decision lock the CAS above took: an invitation `consultation.respond` now refuses.
        // (`consultation_responded` deliveries are information, not invitations, and stand.)
        const cancelled = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.consultation_requested' });
        await recordAudit(tx, { projectId, actor, action: 'decision.change_withdraw', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, actorEnvelope: envelope, eventType: 'decision.change_withdrawn', entityType: 'Decision', entityId: decisionId, effectKey: 'decision.change_withdrawn', dispatch: {},
          payload: { pushIntentsCancelled: cancelled.neutralized + cancelled.marked + cancelled.entombed },
        });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Phase 6 task 4b (§A.1 round 8) — edit a PRIVATE DRAFT: title, location, options, and the
   *  HOLDER (the recovery path for a stranded draft whose named member left), plus the coherent
   *  record⟺choice conversion (kind and status move together — the DB pair CHECK refuses either
   *  alone). Legal only while `publishedAt IS NULL`; from publication every holder write is
   *  refused by trigger. The draft is its author's private workspace — author or PMC edits it. */
  async updateDraft(projectId: string, decisionId: string, input: UpdateDecisionDraftInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, input });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.updateDraft', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    // fast-fail pre-checks on a plain read (404 / published / authorship — `authorId` is frozen
    // from birth by the DB seal, so this read cannot go stale for the authorship rule); the
    // kind/status derivation happens INSIDE the transaction on the LOCKED row (round-4 Codex F1)
    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.publishedAt !== null) throw new ConflictException('Only an unpublished draft can be edited — a published decision\'s content and holder are frozen');
    if (user.role !== 'pmc' && d.authorId !== user.sub) {
      throw new ForbiddenException('Only the draft\'s author or the PMC can edit it');
    }

    // location handling mirrors create
    let nodeId: string | null | undefined = undefined;
    let room: string | undefined = input.room?.trim() ? input.room : undefined;
    if (input.nodeId !== undefined) {
      if (input.nodeId === null) nodeId = null;
      else {
        const node = await this.prisma.projectNode.findUnique({ where: { id: input.nodeId } });
        if (!node || node.projectId !== projectId) throw new BadRequestException('Unknown location for this project');
        nodeId = node.id;
        room = node.name;
      }
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.updateDraft',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // round-3 Codex F4 + round-4 Codex F1 — the readiness key FIRST (the uniform §B.1
        // order: key, then row locks): whether this edit ENTERS `recorded` (firing the seal's
        // conversion arm, whose try-acquire expects the key held) is only knowable from the
        // row's CURRENT kind, which is only knowable under the row lock — and the key must
        // precede that lock, so it is taken unconditionally. A concurrent key holder makes
        // this command WAIT, never fail spuriously on the trigger.
        await lockProjectReadiness(tx, projectId);
        // round-4 Codex F1 — LOCK the draft and derive every conversion decision from the
        // locked truth, never the pre-transaction snapshot: two overlapping valid PATCHes
        // could otherwise interleave (A converts choice → record; B, judged against its stale
        // choice read, re-points the now-record to a choice kind), skipping the record→choice
        // option validation and aborting on the DB swatch CHECK instead of a deliberate 400.
        const lockedRows = await tx.$queryRaw<Array<{ status: $Enums.DecisionStatus; deciderKind: string; publishedAt: Date | null }>>(
          Prisma.sql`SELECT "status"::text AS "status", "deciderKind"::text AS "deciderKind", "publishedAt"
                       FROM "Decision" WHERE "id" = ${decisionId} AND "projectId" = ${projectId} FOR UPDATE`,
        );
        if (lockedRows.length === 0) throw new NotFoundException(`Decision ${decisionId} not found`);
        const cur = lockedRows[0]!;
        if (cur.publishedAt !== null) throw new ConflictException('The draft was published while editing — its content and holder are now frozen');
        // the RESULTING kind decides status coherence and option handling — from the LOCKED row
        const curKind = cur.deciderKind as 'client' | 'pmc' | 'member' | 'none' | 'architect';
        // Phase 6 task 4d (§A.1) — re-pointing a draft at the architect role is reserved until
        // 4d-iii: refused 409 with the drain directive, under the readiness key, before any write
        if (input.deciderKind === 'architect') {
          await assertPhase6_4dOpen(tx, 'A decision designated to the architect role');
          await assertCountersignClient(tx, projectId, user.decisionsContract, 'A decision designated to the architect role');
        }
        const nextKind = input.deciderKind ?? curKind;
        const nextStatus = nextKind === 'none' ? 'recorded' : cur.status === 'recorded' ? 'pending' : cur.status;
        if (input.deciderKind === 'member') {
          const member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, input.deciderMembershipId!);
          if (!member) throw new BadRequestException('The named decider must be an ACTIVE member of this project');
        }
        // round-3 Codex F3 — the REVERSE conversion (record → choice) births the choice's
        // presentation from its lead option's swatch, so a conversion without a usable 2–4
        // option payload would reach the DB swatch CHECK as an uncaught transaction abort:
        // refuse it deliberately here — only the service knows the draft's CURRENT kind
        // (the contract cannot see what the draft is converting FROM).
        if (nextKind !== 'none' && curKind === 'none' && (input.options?.length ?? 0) < 2) {
          throw new BadRequestException('Converting a record into a choice needs its 2–4 options in the same edit');
        }
        // round-5 Codex F6 — the mirror-image hole: an options-ONLY edit on a record draft
        // (deciderKind omitted, so the contract's record-takes-no-options refinement never
        // sees it) would plant options on a `recorded` row and trip the DB record seal as an
        // uncaught abort. The RESULTING kind is a record ⇒ any nonempty options payload is a
        // category error, whatever the edit omitted.
        if (nextKind === 'none' && (input.options?.length ?? 0) > 0) {
          throw new BadRequestException('A record (deciderKind none) takes no options');
        }
        // round-1 Codex F8 — CONVERTING to a record files the frozen author's name in the
        // permanent register: they must hold CURRENT decision authority at that moment (the
        // same check the record birth door runs; the DB seal re-judges it under the readiness
        // key). A colleague cannot convert a departed author's draft into a record attributed
        // to someone with no standing.
        if (nextKind === 'none' && curKind !== 'none') {
          const authorHoldsAuthority = d.authorId
            ? await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, d.authorId, ['pmc'], { forUpdate: true })
            : false;
          if (!authorHoldsAuthority) {
            throw new ConflictException(
              'This draft\'s author no longer holds decision authority on the project — a record files under its author\'s name, so re-issue the record yourself instead of converting their draft',
            );
          }
        }
        if (input.options === undefined && nextKind === 'none' && curKind !== 'none') {
          const remaining = await tx.decisionOption.count({ where: { decisionId } });
          if (remaining > 0) {
            throw new BadRequestException('A record takes no options — remove them in the same edit (send options: [])');
          }
        }
        const lead = input.options?.find((o) => o.recommended) ?? input.options?.[0];
        // CAS on the unpublished state — publish takes the same row lock (round 16), so an
        // edit-vs-publish race has exactly one winner
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, publishedAt: null },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(room !== undefined ? { room } : {}),
            ...(nodeId !== undefined ? { nodeId } : {}),
            ...(input.deciderKind !== undefined
              ? {
                  deciderKind: input.deciderKind,
                  deciderMembershipId: input.deciderKind === 'member' ? input.deciderMembershipId! : null,
                  status: nextStatus,
                  ...(input.deciderKind === 'none' ? { photoSwatch: null } : {}),
                }
              : {}),
            ...(lead !== undefined && nextKind !== 'none' ? { photoSwatch: lead.swatch } : {}),
          },
        });
        if (count === 0) throw new ConflictException('The draft was published while editing — its content and holder are now frozen');
        // options replacement AFTER the head update (drafts are unpublished, so the child freeze
        // permits it — but the recorded-parent INSERT seal means a record converting BACK to a
        // choice must become `pending` before its options may attach; a draft CONVERTING to a
        // record sheds its options in the same edit and the reverse child seal re-counts at commit)
        if (input.options !== undefined) {
          await tx.decisionOption.deleteMany({ where: { decisionId } });
          await tx.decisionOption.createMany({
            data: input.options.map((o, i) => ({
              decisionId,
              label: o.label ?? `Option ${String.fromCharCode(65 + i)}`,
              optionKey: String.fromCharCode(97 + i),
              material: o.material,
              delta: o.delta,
              swatch: o.swatch,
              photoUrl: o.photoUrl || null,
              recommended: o.recommended,
              order: i,
            })),
          });
        }
        await tx.decisionEvent.create({ data: { decisionId, type: 'draft_updated', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole } });
        await recordAudit(tx, { projectId, actor, action: 'decision.updateDraft', entity: 'Decision', entityId: decisionId });
        // a draft edit is weightless: no notice, no push, no invalidation for other viewers
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'decision.drafted', entityType: 'Decision', entityId: decisionId, effectKey: 'decision.drafted', dispatch: {} });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Withdraw a PUBLISHED, never-approved decision — the PMC takes back a question that should
   *  not have been asked (Phase 6 task 4a; the owner's live defect). TERMINAL: the decision
   *  leaves every actionable surface (pending count, client list, action items — all derive
   *  from `status`), the pending bell notice is RETIRED (a stale approval demand is a false
   *  instruction, not history), a queued `decision.published` push is CANCELLED by subject so a
   *  lagging relay cannot announce a decision every surface has since hidden, and the
   *  DecisionEvent register — not the bell — carries the explanation. `pending` is sufficient
   *  proof of never-approved (no transition path re-enters it); the DB seals make the
   *  combination unrepresentable even for hostile SQL. */
  async withdraw(projectId: string, decisionId: string, input: WithdrawDecisionInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const reason = input.reason; // zod `.trim().min(1)` — already trimmed, provably non-blank
    const requestHash = hashRequest({ decisionId, reason });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.withdraw', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    // a DRAFT needs no withdrawal — it is author-private and weightless; the author controls it
    if (d.publishedAt === null) throw new ConflictException('A draft cannot be withdrawn — it was never issued (publish or discard it from Drafts)');
    // an approved/reopened decision carries attributable approvals the register must keep
    // authoritative — the honest path to revisit it is a change request
    // (4d-ii-a / A4d: an approval awaiting the architect's countersign carries one too)
    if (d.status === 'approved' || d.status === 'change' || d.status === 'awaiting_countersign') {
      throw new ConflictException('This decision carries an approval — raise a change request instead; withdraw applies only to a never-approved pending decision');
    }
    if (d.status === 'withdrawn') throw new ConflictException('Decision is already withdrawn');

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.withdraw',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // withdraw moves decision status, which the activity gate reads in `start`'s locked
        // transaction — the lock is taken by CLASS (a readiness-input writer), not by verdict
        // arithmetic, even though `pending` and `withdrawn` both read `wait` today.
        await lockProjectReadiness(tx, projectId);
        // The withdrawal is attributed to an ACTIVE member of THIS project (the FK's target),
        // the row LOCKED in this transaction. An org owner/admin operating as pmc WITHOUT a
        // membership (the project-access super-admin path) is refused HERE with an answer,
        // never by the FK rolling the command back (round 1, Codex F4). `Membership` is
        // orgs-owned, so the OWNER answers through the declared decisions → orgs participant
        // edge (round 3, Codex) — never a raw read of a foreign table from this service.
        const attributable = await this.orgsParticipant.lockActiveMembership(tx, projectId, user.sub);
        if (!attributable) {
          throw new BadRequestException('A withdrawal must be attributed to an ACTIVE member of this project — your account holds no active membership here (org-admin reach does not carry one; join the project to withdraw its decisions).');
        }
        // 4d-ii-a / A7b (plan §A.4 (i), the `withdraw` command's target-aware response cancellation)
        // — the RESPONSE TARGETS' standing, judged BEFORE the decision lock in the canonical order
        // (Membership before Decision): the decision's answered consultations are read WITHOUT the
        // decision lock, each requester's standing rows are locked in ascending requester order and
        // their PMC standing judged (`hasProjectRoleStanding`, the same answer the responded push
        // predicate re-applies), and the set is RE-VALIDATED under the decision lock below — an
        // answer that landed between the two reads names a person whose standing this transaction
        // did not lock in order, so the command refuses as contended rather than lock out of order.
        const answeredBefore = await tx.decisionConsultation.findMany({
          where: { projectId, decisionId, response: { isNot: null } }, select: { id: true, requestedById: true }, orderBy: { id: 'asc' },
        });
        const responseTargetsWithoutPmc: string[] = [];
        for (const requester of [...new Set(answeredBefore.map((c) => c.requestedById))].sort()) {
          if (!(await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, requester, ['pmc'], { forUpdate: true }))) responseTargetsWithoutPmc.push(requester);
        }
        // belt-and-braces: the DB entry seal refuses this too (source-state + register), but a
        // 409 is an answer and a trigger error is a crash — refuse here first.
        // 4d-ii-a / A4a — DELIBERATELY every revision, not the finalized ones the consultation cycle
        // counts: a PROVISIONAL approval is approval evidence too, and a decision awaiting its
        // countersign must never become withdrawable (§A.2's cycle trace names this count as one
        // that must not move).
        const approvals = await tx.decisionApprovalRevision.count({ where: { decisionId } });
        if (approvals > 0) throw new ConflictException('This decision carries approval evidence — it can never be withdrawn');
        // round 9 (Codex): the PR-#192 legacy class holds approvals whose ONLY trace is a
        // DecisionEvent (an empty register) — the same evidence the entry seal and the
        // migration diagnostic count. The belt answers with a 409 before the trigger crashes.
        const legacyApprovals = await tx.decisionEvent.count({ where: { decisionId, type: { in: ['approved', 'reapproved'] } } });
        if (legacyApprovals > 0) throw new ConflictException('This decision carries approval evidence — it can never be withdrawn');
        // CAS: the transition commits only from the published-pending state the eligibility
        // checks saw — a concurrent approve/withdraw makes count 0 and this caller loses.
        const now = new Date();
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, status: 'pending', publishedAt: { not: null } },
          data: { status: 'withdrawn', withdrawnAt: now, withdrawnById: actor.actorId, withdrawnByName: actor.actorName, withdrawReason: reason },
        });
        if (count === 0) throw new ConflictException('The decision changed while withdrawing — reload and retry');

        // RETIRE the pending bell notice — a client bell still saying "awaiting approval" for a
        // decision every other surface has removed is a live false instruction, not history.
        // Stamped rows retire by IDENTITY; only pending notices can be stamped with THIS
        // decision (it was never approved, so no approval announcement exists for it).
        //
        // 4d-ii-a / A4c — KIND-LESS rows only. A kinded notice (bound to its event) is evidence of an
        // act that was announced, and its seal refuses the delete; the kinded readers hide it from
        // everyone the decision is hidden from and suppress its actionable kinds once withdrawn.
        await tx.notification.deleteMany({ where: { projectId, decisionId, kind: null } });
        // A LEGACY unstamped pending notice (the owner's live case predates the stamp) retires
        // by its exact text shape rebuilt from the decision's own title — multiplicity-guarded:
        // if another still-pending published decision shares the title, the text is ambiguous
        // and the rows are LEFT and reported (in the register event), never guessed at.
        const legacyText = pendingDecisionNotice(d.title);
        const titleSharers = await tx.decision.count({
          where: { projectId, title: d.title, status: 'pending', publishedAt: { not: null }, id: { not: decisionId } },
        });
        if (titleSharers === 0) {
          await tx.notification.deleteMany({ where: { projectId, decisionId: null, kind: null, text: legacyText } });
        }

        // the register entry IS the history (the report of a left-ambiguous legacy notice rides it)
        await tx.decisionEvent.create({
          data: {
            decisionId,
            type: 'withdrawn',
            actor: actor.actorName,
            actorId: actor.actorId,
            actorName: actor.actorName,
            actorRole: actor.actorRole,
            payload: { title: d.title, reason, ...(titleSharers > 0 ? { legacyNoticeLeftAmbiguous: true } : {}) },
          },
        });
        // the appended withdrawal notice — pmc-only: `isWithdrawnDecisionNotice` strips it from
        // every non-pmc feed, the same mechanism that hides pending notices (§A.2/§A.3).
        // 4d-ii-a / A7a — KINDED, so it is written AFTER its event below (the binding key is a
        // NOT DEFERRABLE foreign key onto the event); the kinded reader serves it to the pmc alone.

        // outrun the QUEUED past: a committed `decision.published` push intent the relay has
        // not yet delivered must not tell the client "awaiting your approval" about a decision
        // every surface has since hidden. The DOMAIN owns the when; the platform mutates only
        // its own table (cancelled and recorded, never deleted). A delivery leased moments
        // before this commit is caught by the sender's pre-send re-check of its own row; the
        // check→send in-flight residual is the documented boundary (§A.4).
        const cancelled = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.published' });
        // 4d-ii-a / A7b (plan §A.4 (i)) — and the CONSULTATION families, under the decision lock the
        // CAS above took: EVERY `consultation_requested` delivery regardless of target (a request is
        // an invitation to act that `consultation.respond` refuses on a withdrawn subject, for a PMC
        // consultee exactly as for anyone else), and the `consultation_responded` deliveries ONLY
        // where the target lacks PMC standing (a withdrawn decision is pmc-only, but a PMC may still
        // be told advice was given) — the narrowing `targetUserIds` arm, judged against each event's
        // own durable intent. The answered set is re-validated first (see the standing reads above).
        const answeredNow = await tx.decisionConsultation.findMany({
          where: { projectId, decisionId, response: { isNot: null } }, select: { id: true }, orderBy: { id: 'asc' },
        });
        if (answeredNow.length !== answeredBefore.length || answeredNow.some((c, i) => c.id !== answeredBefore[i]!.id)) {
          throw new ConflictException('Advice was recorded on this decision while it was being withdrawn — reload and retry');
        }
        const cancelledRequests = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.consultation_requested' });
        const cancelledResponses = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.consultation_responded', targetUserIds: responseTargetsWithoutPmc });
        const pushIntentsCancelled = [cancelled, cancelledRequests, cancelledResponses].reduce((n, c) => n + c.neutralized + c.marked + c.entombed, 0);

        await recordAudit(tx, { projectId, actor, action: 'decision.withdraw', entity: 'Decision', entityId: decisionId });
        const eventId = randomUUID();
        const ev = await emitEvent(tx, {
          projectId, actor, eventId, eventType: 'decision.withdrawn', entityType: 'Decision', entityId: decisionId,
          payload: { title: d.title, reason, pushIntentsCancelled },
          effectKey: 'decision.withdrawn',
          // surfaces refresh; no push — the lifecycle-correction precedent (change_requested/
          // change_withdrawn), and the pmc who acted needs no announcement
          dispatch: {},
        });
        await tx.notification.create({ data: { projectId, text: withdrawnDecisionNotice(d.title, reason), color: WITHDRAWN_DECISION_NOTICE_COLOR, time: 'just now', decisionId, kind: 'decision.withdrawn', eventId } });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
