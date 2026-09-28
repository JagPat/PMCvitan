import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockProjectReadiness } from '../common/readiness-lock';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import type { AddMemberInput, UpdateMemberInput } from '../contracts';
import { resolveActor, type Actor, type EventActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { resolveActorEnvelope, type ActorEnvelope } from '../platform/actor-envelope';
import { executeCommand, hashRequest, peekReplay, type CommandScope } from '../platform/commands';
import { DecisionsParticipant } from '../decisions/decisions.participant';
import { OrgsParticipant } from './orgs.participant';
import { InvitationsService } from './invitations.service';
import { assertPhase6_4dOpen } from '../platform/phase6-4d-rollout';
import { RoleStandingQuery } from '../platform/role-standing.query';

export interface MemberDto {
  userId: string;
  /** Phase 6 task 4b (§A.1) — the Membership row's own id: the value a NAMED member-decider
   *  designation stores (`Decision.deciderMembershipId`), surfaced so the web picker can offer it. */
  membershipId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  /** for a `consultant` member: the discipline they cover */
  discipline?: string;
  status: string;
  credentialState?: 'not_set' | 'active';
}

/**
 * Phase 6 task 4b (§A.1/§B.1) — the DB holder seals (`Membership_t4b2_holder_guard`,
 * `OrgMembership_t4b2_holder_guard`) are immediate AFTER-row triggers, so on the service path
 * they judge the standing write at the WRITE STATEMENT — before the command's own post-write
 * participant consultation can run. The seal judges the SAME content the command judges (the
 * decisions-owned holder predicates over the orgs-owned standing primitives), so its raise on a
 * command path is exactly the command's deliberate refusal, translated here to the 409 the
 * caller is owed instead of surfacing as a raw database error. Hostile direct SQL still gets
 * the raw raise — this translation exists only behind the command doors.
 */
export function rethrowHolderSealViolation(e: unknown, message: string): never {
  if (e instanceof Error && /phase6-4b/.test(e.message)) throw new ConflictException(message);
  if (e instanceof Error) {
    const translated = holderGuard4dRefusal(e.message);
    if (translated) throw new ConflictException(translated);
  }
  throw e;
}

/** The refusal a member command gives for the named holder of a decision awaiting countersign. */
const awaitingNamedHolderRefusal = (architects: number) =>
  `This member is the named holder of a decision awaiting countersign — resolve or forward it first (the project still has ${architects} active architect(s), so the countersign is still pending)`;
/** …for the last holder of a role an open (`pending`/`change`) decision is designated to. */
const heldRoleRefusal = (role: string) =>
  `An open decision is held by the ${role} role and this change would leave it without a holder — withdraw and reissue the decision first`;
/** …for the last holder of a role a decision awaiting countersign is designated to. */
const awaitingRoleRefusal = (role: string) =>
  `A decision awaiting countersign is designated to the ${role} role and this change would leave it without a holder — cover it first`;

/**
 * Phase 6 task 4d (§A.2, P39) — 4d-i's `Membership_t4d_holder_guard` is, like the 4b seal above, an
 * immediate AFTER-row trigger: on the service path it refuses at the membership WRITE STATEMENT,
 * before the command's post-write judgement runs. It judges the same rule, so each of its three
 * refusal arms is the command's own refusal, answered with the command's 409 text. Its readiness
 * arm is unreachable behind the command's readiness key and is left raw, as is any other raise.
 */
function holderGuard4dRefusal(message: string): string | null {
  const named = /phase6 4d-i: membership \S+ is the named holder of a decision awaiting countersign[\s\S]*still holds (\d+) active architect/.exec(message);
  if (named) return awaitingNamedHolderRefusal(Number(named[1]));
  if (/phase6 4d-i: this change leaves NO active architect while a published OPEN decision is designated to that role/.test(message)) {
    return heldRoleRefusal('architect');
  }
  const role = /phase6 4d-i: this change leaves NO effective (\S+) holder while a decision awaiting countersign is designated to that role/.exec(message);
  if (role) return awaitingRoleRefusal(role[1]!);
  return null;
}

/**
 * Phase 6 task 4d unit 4d-ii-a / A3b — the one 4d-i transition-seal refusal a correct command can
 * still meet: the actor's team-management authority, re-judged LIVE by
 * `MembershipTransition_t4d_seal` at the fact's insert. `canManage` read it before the
 * transaction (and a `pmc` token is trusted as issued), so a PMC demoted or an owner/admin removed
 * in between reaches the seal, and the caller is owed the 403 `canManage` would now give.
 */
function rethrowTransitionAuthority(e: unknown): never {
  if (e instanceof Error && /holds neither owner\/admin authority/.test(e.message)) {
    throw new ForbiddenException('Only the project PMC or an org admin can manage the team');
  }
  throw e;
}

type MembershipWithUser = Prisma.MembershipGetPayload<{ include: { user: true } }>;

/** The two ledger commands one member PATCH can land in; a keyed retry is matched against both. */
const PATCH_COMMAND_TYPES = ['members.updateRole', 'members.updateDiscipline'] as const;

/** One `MembershipTransition` row, exactly as 4d-i's table spells it. */
interface TransitionFact {
  projectId: string;
  membershipId: string;
  userId: string;
  fromRole: string | null;
  fromStatus: string | null;
  toRole: string;
  toStatus: string;
}

/**
 * Project team management (Orgs Slice 2). List/add/change-role/remove members.
 * Adding a member also provisions the account (invited), so with invite-only auth
 * they can then sign in by email-OTP / password / phone-OTP. Gated to the project's
 * PMC or an owner/admin of the owning org.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    // Phase 6 task 4b (§A.1) — the holder-orphan guard: before a standing write commits, the
    // decisions-owned participant answers which published open decisions this project's roles
    // and named members currently HOLD, and the orgs-owned standing primitive judges whether
    // the write would leave one holderless. Both edges are the declared orgs ⇄ decisions
    // participant channels.
    private readonly decisionHolders: DecisionsParticipant,
    private readonly standing: OrgsParticipant,
    // Phase 7c-auth — the post-commit invite notice. Optional so the many unit suites that
    // construct this service directly keep working; a deployment always has it from DI.
    private readonly invitations?: InvitationsService,
  ) {}

  /**
   * Phase 6 task 4b (§A.1) — refuse a standing write that would strand a published open
   * decision's ROLE holder. Called AFTER the membership write inside the same transaction
   * (the standing primitive sees the uncommitted write), judging ONLY the roles this write
   * could have reduced — never an unrelated pre-existing state.
   */
  private async refuseHolderOrphan(
    tx: Prisma.TransactionClient,
    projectId: string,
    atRisk: ReadonlySet<string>,
  ): Promise<void> {
    if (atRisk.size === 0) return;
    const { heldRoles, awaitingRoles } = await this.decisionHolders.holdsOpenDecisions(tx, { projectId });
    // Phase 6 task 4d (§A.2, P39) — the architect's standing is the KERNEL register's (the
    // delivered orgs derivation knows nothing of the role); `client`/`pmc` stay on it
    const holders = (role: string) =>
      role === 'architect'
        ? RoleStandingQuery.activeCount(tx, projectId, 'architect')
        : this.standing.effectiveRoleStanding(tx, projectId, role);
    for (const role of heldRoles) {
      if (!atRisk.has(role)) continue;
      if ((await holders(role)) === 0) {
        throw new ConflictException(heldRoleRefusal(role));
      }
    }
    // …and a decision AWAITING COUNTERSIGN designated to a role (4d-i's widened guard). The architect
    // role is never refused here: an architect remaining still holds it, and the LAST architect
    // leaving deactivates the chain and strands the decision for the stranded resolution (the one
    // named exemption).
    for (const role of awaitingRoles) {
      if (role === 'architect' || !atRisk.has(role)) continue;
      if ((await holders(role)) === 0) {
        throw new ConflictException(awaitingRoleRefusal(role));
      }
    }
  }

  /**
   * Phase 6 task 4d (§A.2, P39) — refuse removing or re-roling the NAMED holder of a decision
   * AWAITING COUNTERSIGN, unless this is the LAST architect leaving: that departure deactivates the
   * chain and strands the decision for `decisions.resolveStrandedCountersign`, so it is permitted.
   * Called AFTER the membership write, so the architect count read is the post-write one the
   * database guard judges. Where that guard is installed it refuses first, at the write statement,
   * and `rethrowHolderSealViolation` answers it with this same 409.
   */
  private async refuseAwaitingHolderOrphan(
    tx: Prisma.TransactionClient,
    projectId: string,
    membershipId: string,
    lostRole: string,
  ): Promise<void> {
    const { namedAwaiting } = await this.decisionHolders.holdsOpenDecisions(tx, { projectId, membershipId });
    if (!namedAwaiting) return;
    const architects = await RoleStandingQuery.activeCount(tx, projectId, 'architect');
    if (lostRole === 'architect' && architects === 0) return;
    throw new ConflictException(awaitingNamedHolderRefusal(architects));
  }

  /** True if the requester may manage this project's team (project PMC or org owner/admin). */
  private async canManage(projectId: string, user: AuthUser): Promise<boolean> {
    if (user.role === 'pmc') return true; // token is already scoped to this project
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.orgId) return false;
    const om = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId: user.sub } } });
    return om?.role === 'owner' || om?.role === 'admin';
  }

  private async assertCanManage(projectId: string, user: AuthUser): Promise<void> {
    if (!(await this.canManage(projectId, user))) {
      throw new ForbiddenException('Only the project PMC or an org admin can manage the team');
    }
  }

  async list(projectId: string, requester: AuthUser): Promise<MemberDto[]> {
    const showCredentialState = await this.canManage(projectId, requester);
    const rows = await this.prisma.membership.findMany({
      where: { projectId, status: { not: 'removed' } },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      userId: m.userId,
      membershipId: m.id,
      name: m.user.name,
      email: m.user.email,
      phone: m.user.phone,
      role: m.role,
      discipline: m.discipline ?? undefined,
      status: m.status,
      ...(showCredentialState ? { credentialState: m.user.passwordHash ? 'active' as const : 'not_set' as const } : {}),
    }));
  }

  /** A discipline is only meaningful for a consultant — clear it for any other role. */
  private disciplineFor(role: string, discipline?: string): string | null {
    return role === 'consultant' ? (discipline ?? null) : null;
  }

  /**
   * 4d-ii-a / A3b — the actor's frozen `(actorRole, actorName)` for a transition fact, resolved
   * INSIDE the command's transaction by the same predicate and identity read the fact's seal
   * (`phase6_t4d_actor_bound`) judges it with, and BEFORE the membership write: the fact records
   * the standing the actor held when they acted, so a PMC re-roling themselves is recorded as the
   * PMC they were. The fact's columns are NOT NULL, so where no pair resolves (the token's role no
   * longer stands) there is no attributable act to record and the command is refused.
   */
  private async factPair(tx: Prisma.TransactionClient, projectId: string, actor: EventActor): Promise<ActorEnvelope> {
    const pair = await resolveActorEnvelope(tx, projectId, actor);
    if (!pair) {
      throw new ForbiddenException('Your standing on this project changed — reload and retry');
    }
    return pair;
  }

  /**
   * 4d-ii-a / A3b — write the command's `MembershipTransition` FIRST, before the membership write
   * it describes: 4d-i's `Membership_t4d_fact_first` refuses a membership write under a member
   * receipt with no fact for it yet, and the fact's insert seal reads the actor's authority and
   * pair against the pre-state. The deferred `MembershipTransition_t4d_provenance_bound` then binds
   * it at commit to this receipt (`resultRef` = the membership id) and to the write.
   */
  private async recordTransition(
    tx: Prisma.TransactionClient,
    fact: TransitionFact,
    actor: EventActor,
    pair: ActorEnvelope,
    commandId: string | null,
  ): Promise<void> {
    if (!commandId) throw new Error('members: a membership transition needs the receipt it cites');
    await tx.membershipTransition
      .create({
        data: {
          id: randomUUID(),
          ...fact,
          actorId: actor.actorId,
          actorRole: pair.actorRole,
          actorName: pair.actorName,
          sourceCommandId: commandId,
        },
        select: { id: true },
      })
      .catch(rethrowTransitionAuthority);
  }

  private toDto(m: MembershipWithUser): MemberDto {
    return {
      userId: m.userId, membershipId: m.id, name: m.user.name, email: m.user.email, phone: m.user.phone, role: m.role,
      discipline: m.discipline ?? undefined, status: m.status, credentialState: m.user.passwordHash ? 'active' : 'not_set',
    };
  }

  /**
   * The member as they stand now. Used BEFORE a write (a no-op) and on a REPLAY, where nothing this
   * call did has committed; a fresh write returns the row its own transaction produced instead, so
   * no fallible read ever follows a commit (round-1 Codex F1 on `add`).
   */
  private async memberDto(projectId: string, userId: string): Promise<MemberDto> {
    const m = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
    if (!m) throw new NotFoundException('Member not found on this project');
    return this.toDto(m);
  }

  /**
   * The other branch's receipt for THIS PATCH, read under the readiness lock. The pre-transaction
   * replay check cannot see a same-key request still in flight on the other branch; both branches
   * take the readiness lock first, so by the time this runs that request has committed or rolled
   * back, and a committed one is the act this call repeats. Only a CLIENT key can be shared —
   * a synthesized one is unique per call.
   */
  private async priorPatchReceipt(
    tx: Prisma.TransactionClient, projectId: string, actorId: string, otherType: string,
    idempotencyKey: string | undefined, requestHash: string,
  ): Promise<boolean> {
    const key = idempotencyKey?.trim();
    if (!key) return false;
    const prior = await tx.commandExecution.findFirst({
      where: { scopeKind: 'project', projectId, actorId, commandType: otherType, idempotencyKey: key, status: 'succeeded' },
      select: { requestHash: true },
    });
    if (!prior) return false;
    if (prior.requestHash !== requestHash) throw new ConflictException('This idempotency key was already used for a different request.');
    return true;
  }

  /**
   * `members.add` — a ledger command (4d-ii-a / A3b). Its receipt covers the IDENTITY too: the
   * account lookup and the provisioning create run inside `executeCommand.run`, so two requests
   * with one `Idempotency-Key` for a new email replay rather than race the user uniqueness key,
   * and a later failure leaves no identity behind (plan §A.3 obligation 6). Keyless calls, which
   * every deployed tab makes, get a per-call server key (`synthesizeKeyWhenAbsent`) so the fact
   * always has a receipt to cite.
   *
   * An add ENDS active and BEGINS from nothing or from `removed` — the shape 4d-i's binding admits
   * for a `members.add` receipt. So an add naming someone already on the team is refused (their
   * role is changed from the team list), except an add that asks for exactly what they already
   * are, which records nothing and succeeds.
   */
  async add(projectId: string, requester: AuthUser, input: AddMemberInput, idempotencyKey?: string): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const email = input.email?.toLowerCase();
    const phone = input.phone;
    const discipline = this.disciplineFor(input.role, input.discipline);
    const actor = await resolveActor(this.prisma, requester);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ name: input.name, role: input.role, email: email ?? null, phone: phone ?? null, discipline });
    // round-1 Codex F1 — read BEFORE the transaction. A fallible lookup AFTER commit could
    // reject `add` when the membership and its `membership.added` event are already durable,
    // handing the caller a failure for a write it can see — the partial success this notice
    // exists to avoid. Read here and a transient error fails the add before anything commits.
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });

    const outcome = await executeCommand<MembershipWithUser>(this.prisma, {
      scope,
      actor,
      commandType: 'members.add',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx, { commandId }) => {
        // (re)activating a member can shrink a frozen distribution's outstanding set —
        // a readiness write (gate finding 1), serialized against start()
        await lockProjectReadiness(tx, projectId);
        // Phase 6 task 4d (§A.1) — the architect role is reserved until 4d-iii: refused 409 with the
        // drain directive BEFORE ANY WRITE, the invited identity's provisioning included (4d-i's doors
        // would refuse the `User` or `Membership` INSERT mid-transaction instead)
        if (input.role === 'architect') await assertPhase6_4dOpen(tx, 'Adding a member in the architect role');
        let user =
          (email && (await tx.user.findUnique({ where: { email } }))) ||
          (phone && (await tx.user.findUnique({ where: { phone } }))) ||
          null;
        if (!user) {
          // provision the invited identity (they set a credential on first sign-in)
          user = await tx.user.create({ data: { projectId, role: input.role, name: input.name, email, phone } }).catch((e: unknown) => {
            // The same email or phone provisioned by another project's add a moment ago. Translated
            // HERE so the command kernel never mistakes this P2002 for an idempotency-key conflict.
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
              throw new ConflictException('That email or phone was just registered by another request — retry');
            }
            throw e;
          });
        }
        const prior = await tx.membership.findUnique({ where: { projectId_userId: { projectId, userId: user.id } } });
        if (prior && prior.status !== 'removed') {
          if (prior.status === 'active' && prior.role === input.role && (prior.discipline ?? null) === discipline) {
            return { resultRef: prior.id, value: { ...prior, user }, events: [] };
          }
          throw new ConflictException(`${user.name} is already on this project's team — change their role from the team list instead`);
        }
        // §A.1 round 19 (activation DISPLACEMENT): the roles this activation could reduce — the
        // membership-less effective-PMC arm that an explicit non-pmc membership suppresses by
        // precedence. (A prior row here is `removed`, so it held no active role to displace.)
        const atRisk = new Set<string>();
        if (input.role !== 'pmc') {
          const owning = await tx.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
          const om = owning?.orgId
            ? await tx.orgMembership.findUnique({ where: { orgId_userId: { orgId: owning.orgId, userId: user.id } } })
            : null;
          if (om?.role === 'owner' || om?.role === 'admin') atRisk.add('pmc');
        }
        // An ADD's membership does not exist yet, so its id is minted here for the fact to name;
        // the fact's membership FK is deferred to commit for exactly this order.
        const membershipId = prior?.id ?? randomUUID();
        const pair = await this.factPair(tx, projectId, actor);
        await this.recordTransition(tx, {
          projectId, membershipId, userId: user.id,
          fromRole: prior?.role ?? null, fromStatus: prior?.status ?? null,
          toRole: input.role, toStatus: 'active',
        }, actor, pair, commandId);
        const holderRefusal = (e: unknown) =>
          rethrowHolderSealViolation(
            e,
            'An open decision is held by a role this activation would displace and the change would leave it without a holder — withdraw and reissue the decision first',
          );
        const m = prior
          ? await tx.membership.update({ where: { id: prior.id }, data: { role: input.role, discipline, status: 'active' } }).catch(holderRefusal)
          : await tx.membership.create({ data: { id: membershipId, projectId, userId: user.id, role: input.role, discipline, status: 'active' } }).catch(holderRefusal);
        await this.refuseHolderOrphan(tx, projectId, atRisk);
        // The event's pair is resolved by `emitEvent` itself, AFTER the write: it records the
        // actor as they stand when the event is emitted, which the envelope seal judges live.
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'membership.added', entityType: 'Membership', entityId: user.id, payload: discipline ? { role: input.role, discipline } : { role: input.role }, effectKey: 'membership.added', dispatch: {} });
        return { resultRef: m.id, value: { ...m, user }, events: [ev] };
      },
    });

    // A replay committed nothing in THIS call, so reading the member back is not a read after a
    // commit of ours; a fresh execution hands back the row its own transaction wrote.
    const membership: MembershipWithUser = outcome.value
      ?? (await this.prisma.membership.findUniqueOrThrow({ where: { id: outcome.resultRef }, include: { user: true } }));
    if (!outcome.replayed) {
      // AFTER commit, success path only: the membership above is durable and the readiness lock
      // is released, so the SMTP round-trip holds nothing. Every project-team member gets an
      // ACTIVE membership here, so `signInAccess` will admit them once they hold a credential.
      // `notify` re-reads the credential state itself and never throws.
      await this.invitations?.notify(membership.userId, {
        context: project?.name ? `the ${project.name} project` : 'a project',
        role: membership.role,
        // Only a human actor's id is a real `User` row; a system actor's id is a name, and
        // `SecurityAuditEvent.actorUserId` is an FK.
        actorUserId: actor.actorKind === 'human' ? actor.actorId : null,
      });
    }
    return this.toDto(membership);
  }

  /**
   * `members.updateRole` — a ledger command (4d-ii-a / A3b) when the ROLE moves: a re-role moves
   * the role of a membership that is ACTIVE on both sides, which is the only shape 4d-i's binding
   * admits for its receipt, so a removed member is refused (they are added again instead).
   *
   * A change that leaves the role where it is is not a standing change and writes no fact: a
   * consultant's discipline moving is its own act (`membership.discipline_changed`), and a
   * request for exactly the current state records nothing. That path takes no member receipt,
   * because 4d-i's fact-first seal would demand a transition for every membership write under
   * one, and no transition describes a move that keeps role and status.
   */
  async updateRole(projectId: string, requester: AuthUser, userId: string, input: UpdateMemberInput, idempotencyKey?: string): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const discipline = this.disciplineFor(input.role, input.discipline);
    const actor = await resolveActor(this.prisma, requester);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ userId, role: input.role, discipline });
    // ONE PATCH IS ONE ACT, whichever ledger command it lands in (#647 review, finding 4115635418).
    // A request that keeps the role is receipted as `members.updateDiscipline` and one that moves it
    // as `members.updateRole`, and a receipt is looked up per command type. So a keyed retry is
    // matched against BOTH before the current row decides the branch: otherwise a no-op answered
    // under one type, followed by another manager's re-role, would send the retry down the other
    // branch and perform a change instead of replaying the act it repeats.
    for (const type of PATCH_COMMAND_TYPES) {
      if (await peekReplay(this.prisma, scope, actor.actorId, type, idempotencyKey, requestHash)) {
        return this.memberDto(projectId, userId);
      }
    }
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    if (existing.role === input.role) {
      return this.updateDiscipline(projectId, userId, existing.role, discipline, actor, scope, requestHash, idempotencyKey);
    }

    const outcome = await executeCommand<MembershipWithUser>(this.prisma, {
      scope,
      actor,
      commandType: 'members.updateRole',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx, { commandId }) => {
        // Phase 6 task 4b (§A.1/§B.1) — a role change is a standing write behind the decider
        // gate: serialized on the readiness key so the seal's try-acquire sees one writer.
        await lockProjectReadiness(tx, projectId);
        // Phase 6 task 4d (§A.1) — moving a member into the architect role is reserved until 4d-iii:
        // refused 409 with the drain directive before any write
        if (input.role === 'architect') await assertPhase6_4dOpen(tx, 'Moving a member into the architect role');
        const cur = await tx.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
        if (!cur) throw new NotFoundException('Member not found on this project');
        if (await this.priorPatchReceipt(tx, projectId, actor.actorId, 'members.updateDiscipline', idempotencyKey, requestHash)) {
          return { resultRef: cur.id, value: cur, events: [] };
        }
        if (cur.status !== 'active') {
          throw new ConflictException('Only an active member\'s role can be changed — add them to the team again instead');
        }
        if (cur.role === input.role) throw new ConflictException('This member\'s role changed while updating — reload and retry');
        const pair = await this.factPair(tx, projectId, actor);
        await this.recordTransition(tx, {
          projectId, membershipId: cur.id, userId,
          fromRole: cur.role, fromStatus: cur.status, toRole: input.role, toStatus: 'active',
        }, actor, pair, commandId);
        const m = await tx.membership.update({ where: { id: cur.id }, data: { role: input.role, discipline }, include: { user: true } })
          .catch((e: unknown) =>
            rethrowHolderSealViolation(
              e,
              `An open decision is held by the ${cur.role} role and this change would leave it without a holder — withdraw and reissue the decision first`,
            ),
          );
        await this.refuseHolderOrphan(tx, projectId, new Set([cur.role]));
        await this.refuseAwaitingHolderOrphan(tx, projectId, cur.id, cur.role);
        const events = [await emitEvent(tx, { projectId, actor, eventType: 'membership.role_changed', entityType: 'Membership', entityId: userId, payload: { role: m.role }, effectKey: 'membership.role_changed', dispatch: {} })];
        // a consultant's discipline moving is its own fact
        if ((cur.discipline ?? null) !== (m.discipline ?? null)) {
          events.push(await emitEvent(tx, { projectId, actor, eventType: 'membership.discipline_changed', entityType: 'Membership', entityId: userId, payload: m.discipline ? { discipline: m.discipline } : undefined, effectKey: 'membership.discipline_changed', dispatch: {} }));
        }
        return { resultRef: m.id, value: m, events };
      },
    });
    return outcome.value ? this.toDto(outcome.value) : this.memberDto(projectId, userId);
  }

  /**
   * `members.updateDiscipline` — the role stays, only the discipline moves (or nothing does). Not a
   * standing change, so it writes no fact; and not under a member receipt, because 4d-i's
   * fact-first seal demands a transition for every membership write under `members.add`,
   * `members.updateRole` or `members.remove`, and no transition describes a move that keeps role and
   * status. It is still a LEDGER command (#647 review, finding 4115635418): the caller's key is
   * consumed here even when nothing changes, so a retry replays this act. The write is
   * compare-and-set on the role the caller saw AND on active standing — removal leaves the role in
   * place, so it is the status check, not the role check, that refuses a removed member — and a
   * concurrent re-role or removal is a 409.
   */
  private async updateDiscipline(
    projectId: string, userId: string, role: string, discipline: string | null, actor: Actor,
    scope: CommandScope, requestHash: string, idempotencyKey?: string,
  ): Promise<MemberDto> {
    const outcome = await executeCommand<MembershipWithUser>(this.prisma, {
      scope,
      actor,
      commandType: 'members.updateDiscipline',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const cur = await tx.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
        if (!cur) throw new NotFoundException('Member not found on this project');
        if (await this.priorPatchReceipt(tx, projectId, actor.actorId, 'members.updateRole', idempotencyKey, requestHash)) {
          return { resultRef: cur.id, value: cur, events: [] };
        }
        if (cur.role !== role) throw new ConflictException('This member\'s role changed while updating — reload and retry');
        // A REMOVED membership keeps its role, so the role comparison above cannot see a removal
        // (#647's shadow review on `91dd0af`). Only an active member is edited, by either branch.
        if (cur.status !== 'active') {
          throw new ConflictException('Only an active member can be changed — add them to the team again instead');
        }
        if ((cur.discipline ?? null) === discipline) return { resultRef: cur.id, value: cur, events: [] };
        const m = await tx.membership.update({ where: { id: cur.id }, data: { discipline }, include: { user: true } });
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'membership.discipline_changed', entityType: 'Membership', entityId: userId, payload: discipline ? { discipline } : undefined, effectKey: 'membership.discipline_changed', dispatch: {} });
        return { resultRef: m.id, value: m, events: [ev] };
      },
    });
    return outcome.value ? this.toDto(outcome.value) : this.memberDto(projectId, userId);
  }

  /**
   * `members.remove` — a ledger command (4d-ii-a / A3b). A removal ends a standing that EXISTED
   * and lands `removed`, the shape 4d-i's binding admits for its receipt; removing someone already
   * removed records nothing and succeeds, as the repeated click of a slow tab expects — under a
   * receipt all the same, which is admissible because 4d-i's fact-first seal judges membership
   * WRITES and this one makes none.
   */
  async remove(projectId: string, requester: AuthUser, userId: string, idempotencyKey?: string): Promise<{ ok: boolean }> {
    await this.assertCanManage(projectId, requester);
    if (userId === requester.sub) throw new BadRequestException('You cannot remove yourself');
    const actor = await resolveActor(this.prisma, requester);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ userId });
    if (await peekReplay(this.prisma, scope, actor.actorId, 'members.remove', idempotencyKey, requestHash)) return { ok: true };
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    // An already-removed member still goes through the command (#647 review, finding 4115635421):
    // its receipt consumes the caller's key with nothing recorded, so a retry after the member was
    // re-added replays this no-op instead of removing them again.

    // removal changes the active set behind the drawing gate — a readiness write
    // (gate finding 1), serialized against start()
    await executeCommand(this.prisma, {
      scope,
      actor,
      commandType: 'members.remove',
      idempotencyKey,
      requestHash,
      synthesizeKeyWhenAbsent: true,
      run: async (tx, { commandId }) => {
        await lockProjectReadiness(tx, projectId);
        const cur = await tx.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
        if (!cur) throw new NotFoundException('Member not found on this project');
        if (cur.status === 'removed') return { resultRef: cur.id, events: [] };
        // Phase 6 task 4b (§A.1) — BOTH holder designations: a published open decision that NAMES
        // this membership refuses the removal outright; a ROLE-held decision refuses it only when
        // this member was the last effective holder of that role. A private draft blocks nothing.
        const holders = await this.decisionHolders.holdsOpenDecisions(tx, { projectId, membershipId: cur.id });
        if (holders.named) {
          throw new ConflictException(
            'This member is the named decider on an open decision — withdraw and reissue it first',
          );
        }
        const pair = await this.factPair(tx, projectId, actor);
        await this.recordTransition(tx, {
          projectId, membershipId: cur.id, userId,
          fromRole: cur.role, fromStatus: cur.status, toRole: cur.role, toStatus: 'removed',
        }, actor, pair, commandId);
        await tx.membership.update({ where: { id: cur.id }, data: { status: 'removed' } })
          .catch((e: unknown) =>
            rethrowHolderSealViolation(
              e,
              `An open decision is held by the ${cur.role} role and removing its last active holder would leave it undecidable — withdraw and reissue the decision first`,
            ),
          );
        if (cur.status === 'active') {
          // Phase 6 task 4d (§A.2, P39) — the architect's standing is the KERNEL register's
          const remaining = () =>
            cur.role === 'architect'
              ? RoleStandingQuery.activeCount(tx, projectId, 'architect')
              : this.standing.effectiveRoleStanding(tx, projectId, cur.role);
          if (holders.heldRoles.includes(cur.role) && (await remaining()) === 0) {
            throw new ConflictException(
              `An open decision is held by the ${cur.role} role and removing its last active holder would leave it undecidable — withdraw and reissue the decision first`,
            );
          }
          // a decision AWAITING COUNTERSIGN designated to the role; never the architect role, whose
          // last member leaving deactivates the chain instead (the one named exemption)
          if (cur.role !== 'architect' && holders.awaitingRoles.includes(cur.role) && (await remaining()) === 0) {
            throw new ConflictException(
              `A decision awaiting countersign is designated to the ${cur.role} role and removing its last active holder would leave it without a holder — cover it first`,
            );
          }
          await this.refuseAwaitingHolderOrphan(tx, projectId, cur.id, cur.role);
        }
        const ev = await emitEvent(tx, { projectId, actor, eventType: 'membership.removed', entityType: 'Membership', entityId: userId, effectKey: 'membership.removed', dispatch: {} });
        return { resultRef: cur.id, events: [ev] };
      },
    });
    return { ok: true };
  }
}
