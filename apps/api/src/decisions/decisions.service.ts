import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type $Enums } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import { resolveActor, ROLE_LABEL } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { nextSeqId } from '../domain/ids';
import { pendingDecisionNotice, recordedDecisionNotice, withdrawnDecisionNotice } from '../domain/notifications';
import { cancelQueuedPushBySubject } from '../platform/outbox/cancellation';
import type { ApproveInput, ChangeInput, CreateDecisionInput, RequestConsultationInput, RespondToConsultationInput, UpdateDecisionDraftInput, WithdrawDecisionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { CapabilitiesService } from '../platform/capabilities.service';

/** Phase 6 unit 4c-ii (§D) — the per-project pilot gate both consultation commands, the emitter
 *  and the client read. Named once so the three reads retire together in 4c-iv. */
export const CONSULTATION_CAPABILITY = 'consultation';

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
 * The ELIGIBILITY carve-out, applied identically at the request and at the response.
 *
 * A consultation belongs only to a decision whose question is still OPEN — `pending` or `change`
 * in 4c (the `awaiting_countersign` arm is ADDED BY 4d with the status itself) — AND PUBLISHED.
 * Status alone would admit an author-private DRAFT whose status is `pending`. Never `withdrawn`,
 * whose title and reason are pmc-only: a consultation there would leak exactly what 4a hides.
 * Never `approved` or `recorded`: there is nothing left to inform.
 */
function assertConsultationEligible(d: { status: string; publishedAt: Date | null }, decisionId: string): void {
  if (d.publishedAt === null) {
    throw new ConflictException(`Decision ${decisionId} is an unpublished draft — there is nobody to consult about it yet`);
  }
  if (d.status !== 'pending' && d.status !== 'change') {
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
    // Phase 6 unit 4c-ii (§D) — the per-project `consultation` capability. Both write commands
    // and the emitter read it, and so does the client (the delivered `capabilities: string[]`
    // shell contract), so a gate-off project renders no affordance rather than affordances whose
    // every request 404s. All three reads retire together in 4c-iv.
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** Phase 6 task 4b (§A.3) — the decider-routed push: the catalog names the CEILING and this
   *  site narrows to the ACTUAL decider. A role-held decision pushes at that role's audience; a
   *  NAMED member resolves to a USER target (delivered only to their currently-valid links —
   *  never a role fan-out that would reach every same-role device). */
  private deciderPush(
    body: string,
    kind: 'client' | 'pmc' | 'member' | 'none',
    member: { userId: string; role: string } | null,
  ): { body: string; roles?: readonly ('pmc' | 'client' | 'contractor' | 'engineer' | 'consultant')[]; targetUserId?: string } {
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
        if (input.publish) {
          // Phase 6 task 4a — decision-notice writers stamp `decisionId`, so a later withdrawal
          // retires the pending notice by IDENTITY, never by matching display text.
          await tx.notification.create({ data: { projectId, text: notice, color: record ? '#6B665C' : '#C08A2D', time: 'just now', decisionId: id } });
        }
        await recordAudit(tx, { projectId, actor, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: input.publish ? 'decision.published' : 'decision.drafted', entityType: 'Decision', entityId: id, payload: { title: input.title },
          effectKey: input.publish ? 'decision.published' : 'decision.drafted',
          // A one-step ISSUE carries the approval-demand push AT THE DECIDER (§A.3): the catalog
          // names the role CEILING; the persisted intent narrows to the actual decider — the
          // named member's USER for `member`, the role audience for `client`/`pmc`, and NOBODY
          // for a record (a false approval demand for a decision nobody can approve).
          dispatch: input.publish && !record
            ? { push: this.deciderPush(`New decision awaiting your approval: ${input.title}`, input.deciderKind, member) }
            : {},
        });
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
        await tx.notification.create({ data: { projectId, text: notice, color: record ? '#6B665C' : '#C08A2D', time: 'just now', decisionId } });
        await recordAudit(tx, { projectId, actor, action: 'decision.publish', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'decision.published', entityType: 'Decision', entityId: decisionId, payload: { title: d.title },
          effectKey: 'decision.published',
          // §A.3: the approval demand pushes AT THE DECIDER; a record pushes at NOBODY (there
          // is nothing to approve — the bell notice above is the announcement).
          dispatch: record
            ? {}
            : { push: this.deciderPush(`New decision awaiting your approval: ${d.title}`, d.deciderKind as 'client', member) },
        });
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
    const isRoleDecider =
      (d.deciderKind === 'client' && user.role === 'client') || (d.deciderKind === 'pmc' && user.role === 'pmc');
    if (!isNamedDecider && !isRoleDecider && user.role !== 'pmc') {
      throw new ForbiddenException('Only this decision\'s decider (or the PMC on their behalf) can approve it');
    }
    const onBehalfOf = isNamedDecider || isRoleDecider ? null : d.deciderKind;
    // the display identity of the HOLDER the act freezes (round 3 — the act keeps its own
    // history even after a later forward re-homes the decision)
    const holderLabel =
      d.deciderKind === 'member' ? `Member ${d.deciderMembershipId}` : d.deciderKind === 'pmc' ? 'PMC' : 'Client';
    // ...and the ANNOUNCEMENT says who exercised the authority (gate finding 7)
    const announce = onBehalfOf
      ? `${actor.actorName} (${ROLE_LABEL[actor.actorRole] ?? actor.actorRole}) approved ${d.title} on behalf of the ${onBehalfOf === 'member' ? 'named decider' : onBehalfOf} — ${o.material}`
      : d.deciderKind === 'client'
        ? `Client approved ${d.title} — ${o.material}`
        : `${actor.actorName} approved ${d.title} — ${o.material}`;

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.approve',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // a lock-state transition moves the decision gate (gate finding 1)
        await lockProjectReadiness(tx, projectId);
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
            // the approval act FREEZES the holder tuple it captured consent for (round 3);
            // the holder columns stay current STATE, the act keeps its own history — so a
            // RE-approval never rewrites the FIRST act's tuple (the DB seal refuses it too)
            ...(d.approvedDeciderKind === null
              ? {
                  approvedDeciderKind: d.deciderKind,
                  approvedDeciderMembershipId: d.deciderKind === 'member' ? d.deciderMembershipId : null,
                  approvedDeciderLabel: holderDisplay,
                }
              : {}),
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
        // The IMMUTABLE approval revision (Phase 3 Task 1 correction round 2, finding 1) —
        // created in the SAME transaction as the approval it records, with the option pinned
        // by its real key. Version allocation is monotonic across UNPROVABLE legacy history
        // too: the floor is both the register head AND the count of recorded approval events
        // (counted BEFORE this approval's own event lands below), so a legacy approval whose
        // register row could not be backfilled still reapproves as version 2, never as a
        // colliding version 1. Identity SERVED to consumers comes solely from these rows —
        // `decisions.approvedRef` reads the head revision, never event counts or labels.
        const registerHead = await tx.decisionApprovalRevision.findFirst({
          where: { decisionId }, orderBy: { version: 'desc' }, select: { version: true },
        });
        const priorApprovals = await tx.decisionEvent.count({
          where: { decisionId, type: { in: ['approved', 'reapproved'] } },
        });
        const version = Math.max(registerHead?.version ?? 0, priorApprovals) + 1;
        await tx.decisionApprovalRevision.create({
          data: {
            id: `dar-${decisionId}-v${version}`,
            projectId, decisionId, version,
            optionKey: o.optionKey,
            approvedAt: new Date(),
            approvedById: actor.actorId,
            onBehalfOf,
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
        await tx.notification.create({ data: { projectId, text: announce, color: '#3F7A54', time: 'just now', decisionId } });
        await recordAudit(tx, { projectId, actor, action: 'decision.approve', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: prior === 'change' ? 'decision.reapproved' : 'decision.approved', entityType: 'Decision', entityId: decisionId, payload: { option: o.label, material: o.material, ...(onBehalfOf ? { onBehalfOf } : {}) },
          effectKey: prior === 'change' ? 'decision.reapproved' : 'decision.approved',
          dispatch: { push: { body: announce } },
        });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    // the decision is locked; PMC/contractor/engineer act on it — told truthfully by whom (fresh only)
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
    await this.capabilities.assertEnabled(projectId, CONSULTATION_CAPABILITY);
    // Review round 19 — the key is REQUIRED, and refused at the contract with a deliberate 400.
    // Both consultation facts carry a NOT NULL `sourceCommandId` naming the receipt of the
    // command currently executing; when `COMMAND_KEY_ENFORCED` is unset and a caller omits the
    // header, the delivered kernel takes its LEGACY unkeyed branch, which reserves NO ledger row
    // and runs with `{ commandId: null }`. Without this refusal the write reaches PostgreSQL and
    // surfaces as an internal constraint failure — a 500 where the honest answer is that this
    // command needs a key.
    const key = requireIdempotencyKey(idempotencyKey, 'decisions.requestConsultation');
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ decisionId, consulteeMembershipId: input.consulteeMembershipId, question: input.question });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.requestConsultation', key, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.requestConsultation',
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
        const standing = await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, user.sub, ['pmc'], { forUpdate: true });
        if (!standing) {
          throw new ForbiddenException('Your project standing changed — asking for advice on this decision is a PMC authority');
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
        const openCycle = await tx.decisionApprovalRevision.count({ where: { decisionId } });

        const id = `dc-${ctx.commandId}`;
        await tx.decisionConsultation.create({
          data: {
            id, projectId, decisionId,
            requestedById: actor.actorId,
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
        await recordAudit(tx, { projectId, actor, action: 'decisions.requestConsultation', entity: 'Decision', entityId: decisionId });
        const body = `${actor.actorName} asked you about ${d.title}`;
        const ev = await emitEvent(tx, {
          projectId, actor,
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
    await this.capabilities.assertEnabled(projectId, CONSULTATION_CAPABILITY);
    const key = requireIdempotencyKey(idempotencyKey, 'decisions.respondToConsultation');
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({
      decisionId, consultationId: input.consultationId, response: input.response,
      recommendedOptionIndex: input.recommendedOptionIndex ?? null,
    });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.respondToConsultation', key, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.respondToConsultation',
      idempotencyKey: key,
      requestHash,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) {
          throw new ConflictException('This project is archived — no advice can be recorded against it');
        }
        const consultation = await tx.decisionConsultation.findFirst({
          where: { id: input.consultationId, projectId, decisionId },
          include: { response: { select: { id: true } } },
        });
        if (!consultation) throw new NotFoundException('That consultation does not exist on this decision');
        if (consultation.response) {
          throw new ConflictException('This consultation has already been answered — advice is recorded once and never edited');
        }
        // the consultee membership, RE-LOCKED and re-resolved: a consultee removed after their JWT
        // was minted cannot append immutable advice.
        const consultee = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, consultation.consulteeMembershipId);
        if (!consultee) throw new ConflictException('You are no longer an active member of this project');
        if (consultee.userId !== user.sub) {
          throw new ForbiddenException('Only the member who was asked can answer this consultation');
        }
        const d = await lockDecisionForConsultation(tx, projectId, decisionId);
        if (!d) throw new NotFoundException(`Decision ${decisionId} not found`);
        assertConsultationEligible(d, decisionId);
        const cycle = await tx.decisionApprovalRevision.count({ where: { decisionId } });
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

        const id = `dcr-${ctx.commandId}`;
        await tx.decisionConsultationResponse.create({
          data: {
            id, projectId, consultationId: consultation.id, decisionId,
            respondedById: actor.actorId,
            response: input.response,
            recommendedOptionId,
            respondedAt: new Date(),
            sourceCommandId: ctx.commandId!,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'decisions.respondToConsultation', entity: 'Decision', entityId: decisionId });
        const body = `${actor.actorName} answered your question about ${d.title}`;
        const ev = await emitEvent(tx, {
          projectId, actor,
          eventType: 'decision.consultation_responded',
          entityType: 'Decision', entityId: decisionId,
          payload: { consultationId: consultation.id, responseId: id },
          effectKey: 'decision.consultation_responded',
          // TARGETED at the person who asked. The requester may be an org-admin USER with no
          // membership row on this project, which is exactly why the target is user-keyed.
          dispatch: { push: { body, roles: ['pmc'], targetUserId: consultation.requestedById } },
        });
        return { resultRef: id, events: [ev] };
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
      run: async (tx) => {
        const events: EmittedEventMeta[] = [];
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
          await tx.changeRequest.create({
            data: { decisionId, reason: input.reason, costImpact: input.costImpact, timeImpactDays: input.timeImpactDays, status: 'open', requestedById: actor.actorId },
          });
          await tx.decisionEvent.create({ data: { decisionId, type: 'change_requested', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: input } });
          await recordAudit(tx, { projectId, actor, action: 'decision.change', entity: 'Decision', entityId: decisionId });
          events.push(await emitEvent(tx, { projectId, actor, eventType: 'decision.change_requested', entityType: 'Decision', entityId: decisionId, payload: { reason: input.reason, ...(input.costImpact !== undefined ? { costImpact: input.costImpact } : {}), ...(input.timeImpactDays !== undefined ? { timeImpactDays: input.timeImpactDays } : {}) }, effectKey: 'decision.change_requested', dispatch: {} }));
        } catch (e) {
          // the one-open-per-decision partial unique index fired — a concurrent request won.
          // Translate HERE (inside run) so the command kernel never mistakes THIS P2002 for a
          // duplicate-idempotency-key conflict; it sees a ConflictException and propagates it.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('A change request is already open for this decision');
          }
          throw e;
        }
        return { resultRef: decisionId, events };
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

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.withdrawChange',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
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
        await recordAudit(tx, { projectId, actor, action: 'decision.change_withdraw', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'decision.change_withdrawn', entityType: 'Decision', entityId: decisionId, effectKey: 'decision.change_withdrawn', dispatch: {} });
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
        const curKind = cur.deciderKind as 'client' | 'pmc' | 'member' | 'none';
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
    if (d.status === 'approved' || d.status === 'change') {
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
        // belt-and-braces: the DB entry seal refuses this too (source-state + register), but a
        // 409 is an answer and a trigger error is a crash — refuse here first.
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
        await tx.notification.deleteMany({ where: { projectId, decisionId } });
        // A LEGACY unstamped pending notice (the owner's live case predates the stamp) retires
        // by its exact text shape rebuilt from the decision's own title — multiplicity-guarded:
        // if another still-pending published decision shares the title, the text is ambiguous
        // and the rows are LEFT and reported (in the register event), never guessed at.
        const legacyText = pendingDecisionNotice(d.title);
        const titleSharers = await tx.decision.count({
          where: { projectId, title: d.title, status: 'pending', publishedAt: { not: null }, id: { not: decisionId } },
        });
        if (titleSharers === 0) {
          await tx.notification.deleteMany({ where: { projectId, decisionId: null, text: legacyText } });
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
        // every non-pmc feed, the same mechanism that hides pending notices (§A.2/§A.3)
        await tx.notification.create({ data: { projectId, text: withdrawnDecisionNotice(d.title, reason), color: '#6B665C', time: 'just now', decisionId } });

        // outrun the QUEUED past: a committed `decision.published` push intent the relay has
        // not yet delivered must not tell the client "awaiting your approval" about a decision
        // every surface has since hidden. The DOMAIN owns the when; the platform mutates only
        // its own table (cancelled and recorded, never deleted). A delivery leased moments
        // before this commit is caught by the sender's pre-send re-check of its own row; the
        // check→send in-flight residual is the documented boundary (§A.4).
        const cancelled = await cancelQueuedPushBySubject(tx, { projectId, subject: decisionId, eventType: 'decision.published' });

        await recordAudit(tx, { projectId, actor, action: 'decision.withdraw', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'decision.withdrawn', entityType: 'Decision', entityId: decisionId,
          payload: { title: d.title, reason, pushIntentsCancelled: cancelled.neutralized + cancelled.marked + cancelled.entombed },
          effectKey: 'decision.withdrawn',
          // surfaces refresh; no push — the lifecycle-correction precedent (change_requested/
          // change_withdrawn), and the pmc who acted needs no announcement
          dispatch: {},
        });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
