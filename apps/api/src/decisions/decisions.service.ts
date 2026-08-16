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
import { pendingDecisionNotice, recordedIssueNotice, withdrawnDecisionNotice } from '../domain/notifications';
import { cancelQueuedPushBySubject } from '../platform/outbox/cancellation';
import type { ApproveInput, ChangeInput, CreateDecisionInput, UpdateDecisionDraftInput, WithdrawDecisionInput } from '../contracts';
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
   * The display identity the register renders for a decision's designated holder.
   *
   * Phase 6 task 4b, round 5 (Codex P1). The approval act freezes this string forever, and
   * `decision_t4b_recorded_seal` now binds it to the designated holder at PostgreSQL. A TypeScript
   * copy of the rule beside a SQL copy of the rule is two rules: the copies would agree until one
   * of them was edited, and the disagreement would surface as a raw trigger exception on a
   * perfectly ordinary approval. So there is one — `decisions_t4b_holder_label`, decisions-owned,
   * composing the two role renderings with the orgs-owned `orgs_membership_display_name` — and this
   * asks it, inside the caller's locked transaction, so the value written and the value the seal
   * recomputes are the same read.
   */
  private async holderLabel(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: string,
    membershipId: string | null,
  ): Promise<string | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ label: string | null }>>(
      `SELECT decisions_t4b_holder_label($1, $2, $3) AS label`,
      projectId, kind, membershipId,
    );
    return rows[0]?.label ?? null;
  }

  /**
   * Can this decision be PUBLISHED as it stands — is its designated holder still there?
   *
   * Phase 6 task 4b, round 6 (Codex P1 + P2). Publication is where a decision stops being
   * weightless: `decision_t4b_publication_seal` validates the holder at that exact moment, for
   * BOTH holder shapes. Round 4 gave the member arm a spokesman on both publish doors and left
   * the ROLE arm to the seal — so a default client-held draft published after the last client
   * left produced a raw PostgreSQL exception and a 500. The last client MAY leave: a draft never
   * blocked their removal, which is precisely what makes this the end of an ordinary sequence.
   *
   * Both arms ask the OWNER of the fact — `describeMembership` for a named holder,
   * `roleHasEffectiveStanding` (which calls the same `orgs_effective_role_standing` the seal's
   * own arm calls) for a role-held one — inside the caller's readiness-locked transaction, so
   * the answer is the one the seal will see.
   *
   * The `pmc`/`member` SURFACE GATE lives here too (round 6, Codex P1). Round 5 gated the
   * designation in `createDecisionSchema`, and `publish()` takes no body — so a draft saved
   * before the gate, or imported directly, could still be published, after which the unchanged
   * client audience sends the wrong party an approval demand and hides the row from its actual
   * holder. A contract gate that only guards one of two doors is not a gate. It is refused where
   * the decision acquires weight, which is the honest place for it: 4b-i keeps the FACTS, and
   * 4b-ii opens this together with the audience that makes it true.
   */
  private async assertPublishableHolder(
    tx: Prisma.TransactionClient,
    projectId: string,
    head: { deciderKind: unknown; deciderMembershipId: string | null },
    memberGoneMessage: string,
  ): Promise<void> {
    const kind = head.deciderKind as string;
    // The HOLDER question first, then the surface question. Both refuse, and both refusals are
    // true — but "the member you named has left" is the more specific and more actionable of the
    // two, and it is the behaviour round 4 proved. A gate that swallowed it would be trading a
    // precise conflict for a generic one.
    if (kind === 'member') {
      const holder = await this.orgsParticipant.describeMembership(tx, projectId, head.deciderMembershipId ?? '');
      if (!holder || !holder.active) throw new ConflictException(memberGoneMessage);
    } else if (kind === 'client' || kind === 'pmc') {
      if (!(await this.orgsParticipant.roleHasEffectiveStanding(tx, projectId, kind))) {
        throw new ConflictException(
          `This project has no active ${kind} to decide it — cover the role before publishing, or file it as a recorded issue`,
        );
      }
    }
    if (kind === 'pmc' || kind === 'member') {
      throw new ConflictException(
        'Publishing a decision held by the PMC or a named member arrives with the decider audience (unit 4b-ii) — issue it to the client, or file it as a recorded issue',
      );
    }
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
      // Phase 6 task 4b (round 13) — the decider joins the preimage: reusing a key after
      // changing the intended HOLDER must be the payload-mismatch conflict, never a replay
      // that silently preserves the wrong authority.
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
    // A RECORD (deciderKind 'none') carries EXACTLY ZERO options, so the option-sourced lead
    // presentation does not exist for it (plan §A.2): the swatch falls back to a neutral token
    // rather than throwing on `input.options[0]`.
    const lead = input.options.find((o) => o.recommended) ?? input.options[0];
    const photoSwatch = lead?.swatch ?? 'recorded';

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
    const deciderKind = input.deciderKind ?? 'client';
    // The side effects BRANCH on the kind (plan §A.2, round 2): today's path unconditionally
    // appends "Decision awaiting approval" and pushes at the pending audience — a false
    // approval demand for a record nobody can approve.
    const isRecord = deciderKind === 'none';
    const notice = isRecord ? recordedIssueNotice(input.title) : pendingDecisionNotice(input.title);

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.create',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // Round 4 (Codex P2) — the publication seal's §B.1 try-acquire REFUSES when the readiness
        // key is contended, so a one-step issue racing a membership write would fail with a raw
        // PostgreSQL error rather than serialize. The protocol's service half is to HOLD the key;
        // advisory locks are re-entrant, so the seal's try-acquire then succeeds. Taken for every
        // create, published or not — a draft's insert reaches the same seal on the record door.
        await lockProjectReadiness(tx, projectId);
        // Phase 6 task 4b (plan §A.2, round 18) — the head is born UNPUBLISHED even for a
        // one-step issue, and the guarded publication UPDATE runs LAST in this same transaction.
        // The publication seal counts a decision's options at BOTH doors (the NULL → NOT NULL
        // update and an already-published INSERT), so inserting the published head before its
        // children would be refused at a zero count — and the option floor cannot be dropped,
        // because that is the seal keeping a published decision approvable. Atomic to every
        // reader: the command's observable result is unchanged.
        await tx.decision.create({
          data: {
            id, projectId, title: input.title, room, nodeId,
            // a record is BORN terminal: `none` ⟺ `recorded`, sealed both directions by CHECK
            status: deciderKind === 'none' ? 'recorded' : 'pending',
            ageDays: 0, photoSwatch, authorId: user.sub, publishedAt: null,
            deciderKind,
            deciderMembershipId: deciderKind === 'member' ? (input.deciderMembershipId ?? null) : null,
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
        // the guarded publication, AFTER the options exist (round 18) — and, for a member-held
        // one-step issue, after the named holder is confirmed ACTIVE (round 4, Codex P2). Naming
        // an existing-but-inactive membership is an ordinary caller mistake and deserves the
        // actionable conflict rather than the seal's raw error.
        //
        // Round 6 (Codex P1 + P2) — BOTH holder shapes, and the surface gate, through the one
        // helper the saved-draft door uses. The role arm was missing here too: a one-step issue
        // on a project whose last client has left reached the seal and 500'd.
        if (publishedAt) {
          await this.assertPublishableHolder(
            tx,
            projectId,
            { deciderKind, deciderMembershipId: input.deciderMembershipId ?? null },
            'The member this decision names is not an active member of this project — name a current decider, or save it as a draft',
          );
        }
        if (publishedAt) await tx.decision.update({ where: { id }, data: { publishedAt } });
        await tx.decisionEvent.create({ data: { decisionId: id, type: input.publish ? 'issued' : 'drafted', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: input.title } } });
        if (input.publish) {
          // Phase 6 task 4a — decision-notice writers stamp `decisionId`, so a later withdrawal
          // retires the pending notice by IDENTITY, never by matching display text.
          await tx.notification.create({ data: { projectId, text: notice, color: '#C08A2D', time: 'just now', decisionId: id } });
        }
        await recordAudit(tx, { projectId, actor, action: input.publish ? 'decision.create' : 'decision.draft', entity: 'Decision', entityId: id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: input.publish ? 'decision.published' : 'decision.drafted', entityType: 'Decision', entityId: id, payload: { title: input.title },
          effectKey: input.publish ? (isRecord ? 'decision.recorded' : 'decision.published') : 'decision.drafted',
          // A one-step ISSUE carries the client push; a draft is weightless (no invalidate, no push).
          // The persisted intent is the ONLY source of the send — the dispatcher reads it post-commit.
          // The push body is the client-facing announcement (distinct from the persisted Notification
          // row text `notice`), preserved exactly as the pre-PR-C in-request push sent it.
          //
          // Round 1 (Codex P1): the WHOLE bundle branches on the kind, not just the notice text. A
          // record has no approver, so "awaiting your approval" is a false demand — `decision.recorded`
          // carries the same event type and invalidation with NO push at all.
          dispatch: input.publish && !isRecord ? { push: { body: `New decision awaiting your approval: ${input.title}` } } : {},
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
        // Round 4 (Codex P2) — the publication seal reads project standing through the §B.1
        // TRY-ACQUIRE protocol, which REFUSES rather than waits when the readiness key is held.
        // That is correct for a direct writer and wrong for a command that never took the key:
        // a membership write holding it would turn a perfectly valid publication into a raw
        // PostgreSQL error and a 500. The protocol's service half is to HOLD the key, and
        // advisory locks are re-entrant, so taking it here is what makes the seal's try-acquire
        // succeed instead of fire.
        await lockProjectReadiness(tx, projectId);
        // Round 4 (Codex P2) — and the holder is validated HERE, before the transition, so a
        // draft whose named member has since left produces an actionable conflict rather than the
        // seal's raw error. A draft deliberately does NOT block that member's removal (it is
        // weightless and its holder is editable), which makes this the expected end of an
        // ordinary sequence, not an exotic one. The seal stays the authority; this is its
        // spokesman, exactly like `requestChange` (F9) and `holdsOpenDecisions` (F12).
        //
        // Round 6 (Codex P1 + P2) — the ROLE arm joins it, and so does the `pmc`/`member` surface
        // gate. `publish()` takes no body, so round 5's contract gate could not see this door at
        // all: a draft saved before that gate, or written directly, published straight through it.
        const draft = await tx.decision.findUniqueOrThrow({ where: { id: decisionId } });
        await this.assertPublishableHolder(
          tx,
          projectId,
          draft,
          'The member this decision names has left the project — re-point the draft to a current decider before publishing it',
        );
        // Phase 6 task 4a — publish joins the CAS lifecycle it was the one exception to: the
        // pre-read above is advisory, and THIS guard (`publishedAt: null`) is the transition,
        // so two concurrent publishes admit exactly one (the loser gets the same 409 the
        // pre-read gives) instead of both re-stamping `publishedAt`.
        const { count } = await tx.decision.updateMany({
          where: { id: decisionId, projectId, publishedAt: null },
          data: { publishedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Decision is already published');
        // Round 3 (Codex P2) — the SIDE-EFFECT BUNDLE is derived from the row this transaction
        // just LOCKED, never from the advisory pre-read. `isRecord` decides whether the client is
        // told a decision awaits their approval, and a draft is editable and convertible right up
        // to publication: between the pre-read and this CAS, a concurrent edit can turn an
        // ordinary draft into a record (the pending notice and push would then demand an approval
        // nobody can give) or a record back into a decision (the required demand would be
        // suppressed). The `updateMany` above holds the row, so what it returns is what published.
        //
        // Round 1 (Codex P1) is what the branch itself is for: publishing a SAVED record draft
        // used the pending notice and the client push unconditionally.
        const head = await tx.decision.findUniqueOrThrow({ where: { id: decisionId } });
        const isRecord = (head.deciderKind as string) === 'none';
        const notice = isRecord ? recordedIssueNotice(head.title) : pendingDecisionNotice(head.title);
        await tx.decisionEvent.create({ data: { decisionId, type: 'issued', actor: actor.actorName, actorId: actor.actorId, actorName: actor.actorName, actorRole: actor.actorRole, payload: { title: head.title } } });
        await tx.notification.create({ data: { projectId, text: notice, color: '#C08A2D', time: 'just now', decisionId } });
        await recordAudit(tx, { projectId, actor, action: 'decision.publish', entity: 'Decision', entityId: decisionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'decision.published', entityType: 'Decision', entityId: decisionId, payload: { title: head.title },
          effectKey: isRecord ? 'decision.recorded' : 'decision.published',
          // client-facing push body (the Notification row keeps `notice`), preserved from the
          // pre-PR-C in-request push so the pinned behaviour is unchanged — except for a record,
          // which announces to nobody.
          dispatch: isRecord ? {} : { push: { body: `New decision awaiting your approval: ${head.title}` } },
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
    // Phase 6 task 4b (plan §A.1, round 3) — the AUTHORITY is the decider: the actor either IS
    // the holder, or is the PMC acting ON their behalf, recorded honestly. `onBehalfOf`
    // generalizes from the hard-coded 'client' to the decider's DESIGNATION.
    const holderKind = d.deciderKind as 'client' | 'pmc' | 'member' | 'none';
    // Round 1 (Codex P1) — the membership facts come from their OWNER. Reading `Membership` here
    // (even through the Prisma client rather than raw SQL) is the undeclared decisions→orgs edge
    // `OrgsParticipant.lockActiveMembership` already exists to close.
    const holder = holderKind === 'member'
      ? await this.orgsParticipant.describeMembership(this.prisma, projectId, d.deciderMembershipId ?? '')
      : null;
    const actorIsHolder =
      holderKind === 'member'
        ? holder !== null && holder.active && holder.userId === user.sub
        : user.role === holderKind;
    if (!actorIsHolder && user.role !== 'pmc') {
      // narrowed at the SERVICE, not the route: the route ceiling admits every role that CAN
      // hold a decision, and only the service knows who holds THIS one.
      throw new ForbiddenException('Only the decider of this decision may approve it');
    }
    const onBehalfOf = actorIsHolder ? null : holderKind;

    const outcome = await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'decisions.approve',
      idempotencyKey,
      requestHash,
      run: async (tx) => {
        // a lock-state transition moves the decision gate (gate finding 1)
        await lockProjectReadiness(tx, projectId);
        // The act freezes the holder TUPLE as it stood AT THE ACT: a designation alone stops being
        // attributable once the holder later changes (4d forwarding), so the act keeps kind, the
        // named membership, and the display identity the register rendered.
        //
        // Round 5 (Codex P1) — the LABEL is now bound at PostgreSQL to the designated holder, and
        // it is derived HERE from the SAME function the seal asks (`decisions_t4b_holder_label`),
        // inside the locked transaction. Not two implementations kept in agreement: one, so a
        // service that computed the label differently — or computed it correctly before the lock
        // and wrote it after a concurrent rename — cannot exist. What the seal recomputes is what
        // this wrote, by construction.
        const holderLabel = await this.holderLabel(tx, projectId, holderKind, d.deciderMembershipId);
        // ...and the ANNOUNCEMENT says so too (gate finding 7, corrected round 1 Codex P2): who
        // exercised the authority, and WHOSE authority it was. The old text said "Client approved"
        // for every decider and "on behalf of the client" for every delegation, so a PMC-held or
        // member-held approval contradicted the `onBehalfOf` the same act persisted.
        const holderName = holderLabel ?? (ROLE_LABEL[holderKind] ?? holderKind);
        const announce = onBehalfOf
          ? `${actor.actorName} (${ROLE_LABEL[actor.actorRole] ?? actor.actorRole}) approved ${d.title} on behalf of ${holderName} — ${o.material}`
          : `${holderName} approved ${d.title} — ${o.material}`;
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
            // the act's own history (round 3) — never rewritten by a later holder change
            approvedDeciderKind: holderKind,
            approvedDeciderMembershipId: holderKind === 'member' ? d.deciderMembershipId : null,
            approvedDeciderLabel: holderLabel,
            date: today,
            photoSwatch: o.swatch,
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
          // Round 1 (Codex P2) — the holder is re-validated HERE, under the lock, before the head
          // moves. The removal guard cannot see an `approved` decision, so a member holder may
          // legally leave while it is closed; `decision_t4b_reopen_seal` then refuses the reopen
          // with a raw PostgreSQL exception that Prisma surfaces as a 500. The valid stale-holder
          // case deserves the actionable conflict, and the DB seal stays as the backstop for a
          // direct transaction that never comes through here.
          //
          // Round 5 (Codex P2) — the seal validates BOTH holder shapes and this validated one. A
          // client- or pmc-held decision names no membership, so it took the other arm of the seal
          // (`orgs_effective_role_standing = 0`), and the last client leaving is exactly as ordinary
          // as the last named holder leaving: closed decisions do not block removal either way. Half
          // a guard in front of a whole seal is not a guard — it is a 500 waiting for the other
          // shape. Both arms are asked here, each through the OWNER of the fact it turns on.
          if ((d.deciderKind as string) === 'member') {
            const holder = await this.orgsParticipant.describeMembership(tx, projectId, d.deciderMembershipId ?? '');
            if (!holder || !holder.active) {
              throw new ConflictException(
                `The decider of ${decisionId} has left the project — the approved outcome stands; a changed need is a NEW decision`,
              );
            }
          } else if ((d.deciderKind as string) === 'client' || (d.deciderKind as string) === 'pmc') {
            const held = await this.orgsParticipant.roleHasEffectiveStanding(tx, projectId, d.deciderKind as string);
            if (!held) {
              throw new ConflictException(
                `This project has no active ${d.deciderKind} to decide ${decisionId} — the approved outcome stands; a changed need is a NEW decision`,
              );
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

  /**
   * Phase 6 task 4b (plan §A.1, round 8) — edit an UNPUBLISHED draft: the decider holder and
   * the other draft fields. This is the recovery path for a draft naming a since-removed
   * member (withdraw covers only published rows, and a write-once column would otherwise
   * force private content to publish), legal ONLY while `publishedAt IS NULL`, taking the
   * decision row lock that publish also takes so an edit can never race a publish into
   * carrying another revision's evidence.
   *
   * SHAPE STAGE: deliberately a no-op so P17's draft-re-point arm fails on BEHAVIOR, never on
   * a missing symbol. The transaction, the row lock, the standing validation and the audit
   * land with the §A.1 implementation.
   */
  async updateDraft(
    projectId: string,
    decisionId: string,
    input: UpdateDecisionDraftInput,
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<SnapshotDto> {
    void decisionId;
    void input;
    void idempotencyKey;
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
