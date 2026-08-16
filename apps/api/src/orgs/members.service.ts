import { ConflictException, BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockProjectReadiness } from '../common/readiness-lock';
import { DecisionsParticipant } from '../decisions/decisions.participant';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import type { AddMemberInput, UpdateMemberInput } from '../contracts';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';

export interface MemberDto {
  userId: string;
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
 * Project team management (Orgs Slice 2). List/add/change-role/remove members.
 * Adding a member also provisions the account (invited), so with invite-only auth
 * they can then sign in by email-OTP / password / phone-OTP. Gated to the project's
 * PMC or an owner/admin of the owning org.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly decisions: DecisionsParticipant,
  ) {}

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
   * How much standing in `role` this project would have LEFT after a write that ends this
   * membership's active standing in it.
   *
   * Phase 6 task 4b, round 2 (Codex P2). `Membership_t4b_holder_seal` refuses a role-standing
   * orphan only when the write removes the role's LAST effective holder — it subtracts the
   * departing membership from `orgs_effective_role_standing` and passes the departing role to the
   * decisions predicate only when the remainder reaches zero. The service check in front of it
   * passed `existing.role` unconditionally, so it asserted something it had never counted: with
   * two active clients on the project, changing or removing EITHER was refused with a 409 the
   * database would have allowed. A guard that exists to turn the seal's refusal into an actionable
   * message must refuse exactly what the seal refuses; being stricter is its own defect, and a
   * worse one, because the seal is the authority and nobody can appeal to it.
   *
   * So the count is not re-derived here. It calls the same orgs-owned primitive the seal's
   * arithmetic calls — including its org-standing arm, which counts a membership-less owner/admin
   * as a `pmc` — for the same reason `holdsOpenDecisions` calls the seal's own predicate: two
   * spellings of one rule drift, and the drift shows up as a 500.
   *
   * Round 5 (Codex P2) completes that thought. Rounds 2–3 asked the primitive for CURRENT standing
   * and then subtracted one, which is arithmetic ABOUT the primitive rather than a question put to
   * it — and the subtraction is wrong for the shape the primitive is subtle about. An active
   * membership SUPPRESSES its holder's org-derived pmc standing, so removing the sole project pmc
   * who is also an org owner/admin leaves standing at 1: that same person becomes a membership-less
   * effective pmc the moment their membership ends. `count - 1` said 0, and a removal that stranded
   * nobody was refused. The hypothetical is now stated inside the primitive
   * (`orgs_effective_role_standing_after`), which the seal also calls, so the two cannot disagree.
   */
  private async standingAfterDeparture(
    tx: Prisma.TransactionClient,
    projectId: string,
    role: string,
    membershipId: string,
    afterRole: string | null,
    afterActive: boolean,
  ): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ standing: number }>>(
      `SELECT orgs_effective_role_standing_after($1, $2, $3, $4, $5)::int AS standing`,
      projectId, role, membershipId, afterRole, afterActive,
    );
    return Number(rows[0]?.standing ?? 0);
  }

  /**
   * The membership this write is about, READ AND LOCKED inside the caller's transaction.
   *
   * Phase 6 task 4b, round 3 (Codex P2). Round 2 fixed WHAT the guard computed and left WHEN it
   * read its inputs: `role` and `status` still came from a pre-read taken before the transaction
   * and before the readiness lock. With two clients and an open client-held decision, request A
   * reads the target as `client`, request B changes that same target to `pmc` and commits, and A
   * then counts the CURRENT client standing while subtracting a target that is no longer a client
   * — a false 409 for a write the database would have allowed. The stale half of a comparison is
   * as wrong as a stale whole.
   *
   * `FOR UPDATE` makes this the same read the seal's `OLD` row is: the row is held for the rest of
   * the transaction, so a competing role change either lands before this read or waits for it. The
   * pre-read outside remains, and remains ADVISORY — it answers "does this member exist" and "is
   * this self-removal" cheaply; nothing derived from it decides authority.
   */
  private async lockMembership(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<{ id: string; role: string; status: string; discipline: string | null } | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; role: string; status: string; discipline: string | null }>>(
      `SELECT "id", "role", "status", "discipline" FROM "Membership"
        WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE`,
      projectId, userId,
    );
    return rows[0] ?? null;
  }

  async add(projectId: string, requester: AuthUser, input: AddMemberInput): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const email = input.email?.toLowerCase();
    const phone = input.phone;
    const discipline = this.disciplineFor(input.role, input.discipline);

    let user =
      (email && (await this.prisma.user.findUnique({ where: { email } }))) ||
      (phone && (await this.prisma.user.findUnique({ where: { phone } }))) ||
      null;
    if (!user) {
      // provision the invited identity (they set a credential on first sign-in)
      user = await this.prisma.user.create({ data: { projectId, role: input.role, name: input.name, email, phone } });
    }

    const actor = await resolveActor(this.prisma, requester);
    // (re)activating a member can shrink a frozen distribution's outstanding set —
    // a readiness write (gate finding 1), serialized against start()
    const membership = await this.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, projectId);
      const m = await tx.membership.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        update: { role: input.role, discipline, status: 'active' },
        create: { projectId, userId: user.id, role: input.role, discipline, status: 'active' },
      });
      await emitEvent(tx, { projectId, actor, eventType: 'membership.added', entityType: 'Membership', entityId: user.id, payload: discipline ? { role: input.role, discipline } : { role: input.role }, effectKey: 'membership.added', dispatch: {} });
      return m;
    });
    return { userId: user.id, name: user.name, email: user.email, phone: user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status, credentialState: user.passwordHash ? 'active' : 'not_set' };
  }

  async updateRole(projectId: string, requester: AuthUser, userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    const actor = await resolveActor(this.prisma, requester);
    const membership = await this.prisma.$transaction(async (tx) => {
      // Round 2 (Codex P1-adjacent) — the seal re-judges standing in its own statement, so without
      // the readiness lock a membership write committing between this check and the trigger is
      // visible to the trigger and not to it: the guard says "allowed", the seal refuses, and the
      // caller gets back the 500 round 1 removed. `remove` and `add` already take it; the trigger's
      // try-acquire is re-entrant, so holding it here is what makes the two answers one answer.
      await lockProjectReadiness(tx, projectId);
      // Round 3 (Codex P2) — the DEPARTING role and status come from the LOCKED row, not the
      // pre-read: a concurrent role change would otherwise make the subtraction stale.
      const locked = await this.lockMembership(tx, projectId, userId);
      if (!locked) throw new NotFoundException('Member not found on this project');
      // Round 1 (Codex P2) — a role change removes standing from the DEPARTING role. It does NOT
      // displace a named-membership holder: the membership stays active, so it stays the holder
      // (the seal's own F11 correction). Only the role arm is asked here — and only when this
      // membership is the role's LAST effective standing (round 2), which is the condition the seal
      // itself applies. An inactive membership carries no standing to remove, and the seal's arm
      // does not fire for one either.
      if (input.role !== locked.role && locked.status === 'active') {
        // the write leaves this membership ACTIVE in its NEW role — which is why it keeps
        // suppressing its holder's org-derived pmc standing (round 5)
        const surviving = await this.standingAfterDeparture(tx, projectId, locked.role, locked.id, input.role, true);
        const held = surviving <= 0
          && await this.decisions.holdsOpenDecisions(tx, projectId, null, locked.role);
        if (held) {
          throw new ConflictException(
            `Changing this role would leave a published open decision with no ${locked.role} to decide it — cover the role first`,
          );
        }
      }
      const m = await tx.membership.update({
        where: { projectId_userId: { projectId, userId } },
        data: { role: input.role, discipline: this.disciplineFor(input.role, input.discipline) },
      });
      await emitEvent(tx, { projectId, actor, eventType: 'membership.role_changed', entityType: 'Membership', entityId: userId, payload: { role: m.role }, effectKey: 'membership.role_changed', dispatch: {} });
      // a consultant's discipline moving is its own fact — compared against the LOCKED prior
      // value, so a concurrent edit cannot make this emit (or suppress) the wrong fact
      if ((locked.discipline ?? null) !== (m.discipline ?? null)) {
        await emitEvent(tx, { projectId, actor, eventType: 'membership.discipline_changed', entityType: 'Membership', entityId: userId, payload: m.discipline ? { discipline: m.discipline } : undefined, effectKey: 'membership.discipline_changed', dispatch: {} });
      }
      return m;
    });
    return { userId, name: existing.user.name, email: existing.user.email, phone: existing.user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status, credentialState: existing.user.passwordHash ? 'active' : 'not_set' };
  }

  async remove(projectId: string, requester: AuthUser, userId: string): Promise<{ ok: boolean }> {
    await this.assertCanManage(projectId, requester);
    if (userId === requester.sub) throw new BadRequestException('You cannot remove yourself');
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    const actor = await resolveActor(this.prisma, requester);
    // removal changes the active set behind the drawing gate — a readiness write
    // (gate finding 1), serialized against start()
    await this.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, projectId);
      // Phase 6 task 4b, round 1 (Codex P2) — ask the decisions owner BEFORE the write. The
      // `Membership_t4b_holder_seal` refuses this at PostgreSQL and stays the authority, but its
      // exception reaches the caller as a 500; a member who still holds an open decision is an
      // ordinary, actionable conflict and deserves to be told so.
      //
      // Round 2 (Codex P2): the DEPARTING ROLE is passed only when this removal takes the role's
      // LAST effective standing, which is the arithmetic the seal performs. A project with two
      // active clients loses neither of them to this guard. The membership id is unconditional in
      // this path — a removal DOES end the membership's active standing, so a named holder IS
      // displaced (the seal's `v_named_removed`) — and an already-inactive membership is not asked
      // about at all, because the seal's arm does not fire for one.
      //
      // Round 3 (Codex P2): the row is LOCKED and re-read here, so the role this subtracts is the
      // role the seal will see as `OLD.role` — the pre-read above stays advisory.
      const locked = await this.lockMembership(tx, projectId, userId);
      if (!locked) throw new NotFoundException('Member not found on this project');
      // Round 5 (Codex P2): the write leaves this membership INACTIVE, which also lifts the
      // precedence suppression — a departing pmc who is an org owner/admin re-supplies pmc
      // standing through the org the moment their membership ends, and `count - 1` missed that.
      const held = locked.status === 'active'
        && await this.decisions.holdsOpenDecisions(
          tx, projectId, locked.id,
          (await this.standingAfterDeparture(tx, projectId, locked.role, locked.id, null, false)) <= 0
            ? locked.role
            : null,
        );
      if (held) {
        throw new ConflictException(
          'This member holds a published open decision — withdraw and reissue it, or cover the role, before removing them',
        );
      }
      await tx.membership.update({ where: { projectId_userId: { projectId, userId } }, data: { status: 'removed' } });
      await emitEvent(tx, { projectId, actor, eventType: 'membership.removed', entityType: 'Membership', entityId: userId, effectKey: 'membership.removed', dispatch: {} });
    });
    return { ok: true };
  }
}
