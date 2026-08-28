import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { ddMmmYyyy } from '../domain/dates';
import type { AuthUser } from '../common/auth';
import { resolveActor, ROLE_LABEL } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { nextSeqId } from '../domain/ids';
import { pendingDecisionNotice, withdrawnDecisionNotice } from '../domain/notifications';
import { cancelQueuedPushBySubject } from '../platform/outbox/cancellation';
import type { ApproveInput, ChangeInput, CreateDecisionInput, UpdateDecisionDraftInput, WithdrawDecisionInput } from '../contracts';
import type { DeciderKind } from '@vitan/shared';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { OrgsParticipant } from '../orgs/orgs.participant';

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
  ) {}

  /**
   * Phase 6 unit 4b (plan §A.1) — the holder a request NAMES, normalised. Absent is `client`: the
   * historical holder, so a pre-4b payload produces byte-identical state (P15).
   */
  private holderOf(input: { deciderKind?: DeciderKind; deciderMembershipId?: string }): { kind: DeciderKind; membershipId: string | null } {
    return { kind: input.deciderKind ?? 'client', membershipId: input.deciderMembershipId ?? null };
  }

  /**
   * Does the named holder ACTUALLY hold this project right now — and what identity do we freeze
   * for them?
   *
   * The plan's rule (§A.1): a decision may not be PUBLISHED into the zero-holder state. A named
   * member must hold an ACTIVE membership (the FK proves the row exists in this project, which is
   * not standing — a removed membership still satisfies it), and a ROLE-held decision needs
   * someone with effective standing in that role, or publishing it would birth exactly the
   * holderless state the removal guard exists to prevent (round 10).
   *
   * Both questions are orgs-owned facts and both are asked of the owner through the declared
   * `decisions → orgs` participant channel inside the CALLER'S transaction, so the answer is the
   * one that will still be true at commit: `lockActiveMembershipById` locks the membership row, so
   * a concurrent removal serializes behind this publication instead of racing it.
   *
   * Returns the display identity the approval act freezes (§A.1, round 3): a designation alone is
   * not attributable once the holder can later change, so the act keeps its own history.
   */
  private async resolveHolderStanding(
    tx: Prisma.TransactionClient,
    projectId: string,
    holder: { kind: DeciderKind; membershipId: string | null },
    context: 'publish' | 'reopen' = 'publish',
  ): Promise<{ label: string; userId: string | null }> {
    if (holder.kind === 'member') {
      const m = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, holder.membershipId!);
      if (!m) {
        // The two refusals differ because the two exits differ. An unpublished draft is the
        // author's private workspace and its holder is still editable, so the fix is the edit
        // door. A PUBLISHED, approved decision cannot be re-homed in 4b at all: its approved
        // outcome STANDS and a changed need is a NEW decision (the register's append-only
        // answer). Re-homing an approved decision for reopening is the 4d forward's job, and this
        // message says so rather than implying an exit that does not exist yet.
        throw new ConflictException(
          context === 'reopen'
            ? 'The member who decided this is no longer active on the project — the approved outcome stands; raise the changed need as a new decision.'
            : 'The member named to decide this is no longer active on the project — change who decides it (Drafts → who decides) and publish again.',
        );
      }
      return { label: `${m.name} (${ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] ?? m.role})`, userId: m.userId };
    }
    const held = await this.orgsParticipant.roleStandingExists(tx, projectId, holder.kind);
    if (!held) {
      throw new ConflictException(
        context === 'reopen'
          ? `No one on this project currently holds the ${ROLE_LABEL[holder.kind] ?? holder.kind} role — the approved outcome stands; raise the changed need as a new decision.`
          : `No one on this project currently holds the ${ROLE_LABEL[holder.kind] ?? holder.kind} role — a published decision must have someone who can decide it.`,
      );
    }
    return { label: ROLE_LABEL[holder.kind] ?? holder.kind, userId: null };
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
    const requestHash = hashRequest({
      title: input.title,
      nodeId: input.nodeId ?? null,
      room: input.room ?? null,
      options: input.options.map((o) => ({ label: o.label ?? null, material: o.material, delta: o.delta, swatch: o.swatch, photoUrl: o.photoUrl ?? null, recommended: o.recommended })),
      publish: !!input.publish,
      // Phase 6 unit 4b (plan §A.1, round 13) — the preimage covers the DECIDER TUPLE. Without it,
      // reusing a key after changing the intended holder REPLAYS the first decision instead of
      // conflicting, silently preserving the wrong authority. A pre-4b payload hashes the same
      // `('client', null)` pair its state already carries, so no existing key changes meaning.
      deciderKind: input.deciderKind ?? 'client',
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
    const notice = pendingDecisionNotice(input.title);
    const holder = this.holderOf(input);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.create',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // Phase 6 unit 4b — a ONE-STEP publish is a publication, and a publication may not create
        // the zero-holder state. It therefore takes the same readiness lock and the same holder
        // standing check `publish()` does, so the two doors into a live decision cannot disagree.
        // A DRAFT takes neither: it is author-private and weightless, and its holder stays
        // editable until it publishes.
        if (input.publish) {
          await lockProjectReadiness(tx, projectId);
          await this.resolveHolderStanding(tx, projectId, holder);
        }
        await tx.decision.create({
          data: {
            id, projectId, title: input.title, room, nodeId, status: 'pending', ageDays: 0,
            photoSwatch: lead.swatch, authorId: user.sub, publishedAt,
            deciderKind: holder.kind, deciderMembershipId: holder.membershipId,
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
        await tx.decisionEvent.create({ data: { decisionId: id, type: input.publish ? 'issued' : 'drafted', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: input.title } } });
        if (input.publish) {
          // Phase 6 task 4a — decision-notice writers stamp `decisionId`, so a later withdrawal
          // retires the pending notice by IDENTITY, never by matching display text.
          await tx.notification.create({ data: { projectId, text: notice, color: '#C08A2D', time: 'just now', decisionId: id } });
        }
        await recordAudit(tx, { projectId, actor, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: input.publish ? 'decision.published' : 'decision.drafted', entityType: 'Decision', entityId: id, payload: { title: input.title },
          effectKey: input.publish ? 'decision.published' : 'decision.drafted',
          // A one-step ISSUE carries the client push; a draft is weightless (no invalidate, no push).
          // The persisted intent is the ONLY source of the send — the dispatcher reads it post-commit.
          // The push body is the client-facing announcement (distinct from the persisted Notification
          // row text `notice`), preserved exactly as the pre-PR-C in-request push sent it.
          dispatch: input.publish ? { push: { body: `New decision awaiting your approval: ${input.title}` } } : {},
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

    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.publishedAt) throw new ConflictException('Decision is already published');

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.publish',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // Phase 6 unit 4b — publication is the act that gives the holder columns weight (the DB
        // freezes them from here), so it is also the act that must prove the holder is real.
        // Order matters twice over: the readiness lock first (every decisions writer's first
        // statement), then the decision ROW lock, and only then the holder read.
        await lockProjectReadiness(tx, projectId);
        // Round 16 — publish used to derive its notice and event from the PRE-transaction read,
        // so an edit committing in between would let the published head carry another revision's
        // evidence (a stale title in the client's bell). It now locks the row and derives
        // everything from the LOCKED head; `updateDraft` takes the same lock, so the edit and the
        // publication serialize instead of interleaving.
        await tx.$queryRawUnsafe('SELECT 1 FROM "Decision" WHERE "id" = $1 AND "projectId" = $2 FOR UPDATE', decisionId, projectId);
        const head = await tx.decision.findFirst({ where: { id: decisionId, projectId } });
        if (!head) throw new NotFoundException(`Decision ${decisionId} not found`);
        if (head.publishedAt) throw new ConflictException('Decision is already published');
        // The holder must HOLD, right now, under this lock. A draft naming a member who has since
        // left is refused here and the refusal names the fix — the draft-edit door, a product
        // path, never a database operation (plan §A.1, round 8).
        await this.resolveHolderStanding(tx, projectId, { kind: head.deciderKind, membershipId: head.deciderMembershipId });
        // Phase 6 task 4a — publish joins the CAS lifecycle it was the one exception to: the
        // pre-read above is advisory, and THIS guard (`publishedAt: null`) is the transition,
        // so two concurrent publishes admit exactly one (the loser gets the same 409 the
        // pre-read gives) instead of both re-stamping `publishedAt`.
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, publishedAt: null },
          data: { publishedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Decision is already published');
        await tx.decisionEvent.create({ data: { decisionId, type: 'issued', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: head.title } } });
        await tx.notification.create({ data: { projectId, text: pendingDecisionNotice(head.title), color: '#C08A2D', time: 'just now', decisionId } });
        await recordAudit(tx, { projectId, actor, action: 'decision.publish', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'decision.published', entityType: 'Decision', entityId: decisionId, payload: { title: head.title },
          effectKey: 'decision.published',
          // client-facing push body (the Notification row keeps `notice`), preserved from the
          // pre-PR-C in-request push so the pinned behaviour is unchanged.
          dispatch: { push: { body: `New decision awaiting your approval: ${head.title}` } },
        });
        return { resultRef: decisionId, events: [ev] };
      },
    });

    // now it's live — surface it on the client's side, exactly like a one-step issue (fresh only)
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Phase 6 unit 4b (plan §A.1, round 8) — re-point an UNPUBLISHED draft's decider.
   *
   * This exists because publication REFUSES a draft whose named holder has since left, and a
   * refusal that names no exit is a trap. The plan is explicit that the recovery must be a product
   * path and not a database operation: `withdraw` covers only PUBLISHED rows, and the holder
   * columns are write-once FROM PUBLICATION precisely so an unpublished draft — the author's
   * private, weightless workspace — stays editable. Forcing such a draft to publish just to
   * withdraw it would publish private content to escape a validation error.
   *
   * Legal only while `publishedAt IS NULL`, and the CAS says so: the guard is the transition, so a
   * publication committing in between makes this a deterministic 409 rather than an edit that
   * silently lands on a live decision. It takes the SAME decision row lock `publish()` takes, so
   * the edit and the publication serialize in one order or the other and a published head can
   * never carry another revision's evidence (round 16).
   *
   * Deliberately narrow: the HOLDER only. That is what the publish refusal strands, and widening a
   * newly-opened write door beyond the case that justifies it is how doors stop being reviewable.
   */
  async updateDraft(projectId: string, decisionId: string, input: UpdateDecisionDraftInput, user: AuthUser, idempotencyKey?: string): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const holder = this.holderOf(input);
    const requestHash = hashRequest({ decisionId, deciderKind: holder.kind, deciderMembershipId: holder.membershipId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'decisions.updateDraft', idempotencyKey, requestHash)) {
      return this.snapshot.build(projectId, user.role, user.sub);
    }

    const d = await this.prisma.decision.findUnique({ where: { id: decisionId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.publishedAt !== null) {
      throw new ConflictException('A published decision keeps the holder it was issued under — this edit is only for drafts.');
    }

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.updateDraft',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        await tx.$queryRawUnsafe('SELECT 1 FROM "Decision" WHERE "id" = $1 AND "projectId" = $2 FOR UPDATE', decisionId, projectId);
        // The NEW holder must be real NOW. Storing a holder already known to be unpublishable
        // would just move the refusal to publish time and teach the picker nothing.
        await this.resolveHolderStanding(tx, projectId, holder);
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, publishedAt: null },
          data: { deciderKind: holder.kind, deciderMembershipId: holder.membershipId },
        });
        if (count === 0) throw new ConflictException('The decision was published while you were editing it — reload and retry');
        // A draft edit is author-private and weightless: it appends no register event, raises no
        // notice and emits no domain event (the same rule that makes drafting itself silent). The
        // AUDIT log still records who changed the holder, because authority state is never
        // changed anonymously.
        await recordAudit(tx, { projectId, actor, action: 'decision.updateDraft', entity: 'Decision', entityId: decisionId });
        return { resultRef: decisionId, events: [] };
      },
    });

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
      include: { options: { orderBy: { order: 'asc' } } },
    });
    if (!d || d.projectId !== projectId) throw new NotFoundException(`Decision ${decisionId} not found`);
    if (d.status === 'approved') throw new ConflictException('Decision is already approved and locked');
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
    const holder = { kind: d.deciderKind, membershipId: d.deciderMembershipId };

    // Phase 6 unit 4b (plan §A.1) — the AUTHORITY is the decision's own decider, not the route's
    // allowlist. `ROLE_POLICY['decision.approve']` is now the CEILING (the union of roles a
    // decider can hold, so a contractor-decider reaches the service at all); this is the narrowing
    // that makes the designation mean something. A same-role NON-decider is refused HERE — with a
    // 403 and no side effects — which is exactly the distinction a route allowlist cannot draw.
    const holderUserId = holder.kind === 'member'
      ? (await this.orgsParticipant.lockActiveMembershipById(this.prisma, projectId, holder.membershipId!))?.userId ?? null
      : null;
    const actorIsDecider =
      holder.kind === 'member' ? holderUserId !== null && holderUserId === actor.actorId : user.role === holder.kind;
    // The PMC may always approve ON BEHALF of the decider — the practice answering for a client
    // on the phone is the case this product was built around — and the record never disguises it.
    if (!actorIsDecider && user.role !== 'pmc') {
      throw new ForbiddenException('This decision is not yours to decide — only the party it names (or the PMC on their behalf) can approve it.');
    }
    // `onBehalfOf` generalises from the hard-coded 'client' to the DECIDER'S DESIGNATION; the
    // exact holder (kind + named membership + display identity) is frozen on the act itself,
    // because a designation alone stops being attributable once the holder can later change.
    const onBehalfOf = actorIsDecider ? null : holder.kind;
    const holderNoun = holder.kind === 'client' ? 'the client' : holder.kind === 'pmc' ? 'the PMC' : 'the named decider';
    // ...and the ANNOUNCEMENT says so too (gate finding 7): who exercised the authority
    // A client-held decision keeps its exact pre-4b wording in BOTH arms (`the client` is the
    // `holderNoun` for that kind), so P15's byte-identity covers the bell text and the push body,
    // not just the stored columns. Only a decision that actually names someone else reads
    // differently — and then it must, or the announcement would misattribute the authority.
    const announce = onBehalfOf
      ? `${actor.actorName} (${ROLE_LABEL[actor.actorRole] ?? actor.actorRole}) approved ${d.title} on behalf of ${holderNoun} — ${o.material}`
      : holder.kind === 'client'
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
        // Phase 6 unit 4b (plan §A.1, round 3) — the act freezes the EXACT holder it was
        // exercised for: the kind, the named membership, and the display identity as the register
        // renders it. A designation alone stops being attributable the moment the holder can
        // change (4d's forward), so the head columns are current STATE and this tuple is history.
        // It is written by the FIRST approval only: the database seals it immutable from there,
        // and a re-approval after a change request must still name the holder that first consented
        // (probed: PMC-on-behalf-of-A → requestChange → re-approve; the first act still names A).
        // The identity read tolerates a REMOVED membership — the PMC may legitimately approve on
        // behalf of a member who has since left, and recording the truth about that beats
        // stranding the decision.
        const named = holder.kind === 'member' ? await this.orgsParticipant.describeMembership(tx, projectId, holder.membershipId!) : null;
        const holderLabel = named
          ? `${named.name} (${ROLE_LABEL[named.role] ?? named.role})`
          : (ROLE_LABEL[holder.kind] ?? holder.kind);
        const freezeTuple = d.approvedDeciderKind === null
          ? { approvedDeciderKind: holder.kind, approvedDeciderMembershipId: holder.membershipId, approvedDeciderLabel: holderLabel }
          : {};
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
            ...freezeTuple,
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
          // Phase 6 unit 4b (plan §A.1, round 8) — reopening is the ONE transition that can birth
          // a holderless OPEN decision. The removal guard cannot see an `approved` decision, so
          // its member holder may legally leave while it is closed; `approved → change` puts the
          // approval obligation back and therefore re-asks whether anyone still carries it,
          // atomically under this lock. A reopened decision can never be born holderless.
          await this.resolveHolderStanding(tx, projectId, { kind: d.deciderKind, membershipId: d.deciderMembershipId }, 'reopen');
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
