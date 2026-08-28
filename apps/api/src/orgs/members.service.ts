import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockProjectReadiness } from '../common/readiness-lock';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import type { AddMemberInput, UpdateMemberInput } from '../contracts';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { DecisionsParticipant } from '../decisions/decisions.participant';
import { OrgsParticipant } from './orgs.participant';

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
    const { heldRoles } = await this.decisionHolders.holdsOpenDecisions(tx, { projectId });
    for (const role of heldRoles) {
      if (!atRisk.has(role)) continue;
      if ((await this.standing.effectiveRoleStanding(tx, projectId, role)) === 0) {
        throw new ConflictException(
          `An open decision is held by the ${role} role and this change would leave it without a holder — withdraw and reissue the decision first`,
        );
      }
    }
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
      // §A.1 round 19 (activation DISPLACEMENT): the roles this activation could reduce — the
      // OLD explicit role a role-change deactivates, and the membership-less effective-PMC arm
      // that an explicit non-pmc membership suppresses by precedence.
      const prior = await tx.membership.findUnique({ where: { projectId_userId: { projectId, userId: user.id } } });
      const atRisk = new Set<string>();
      if (prior?.status === 'active' && prior.role !== input.role) atRisk.add(prior.role);
      if (input.role !== 'pmc' && prior?.status !== 'active') {
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
        const om = project?.orgId
          ? await tx.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId: user.id } } })
          : null;
        if (om?.role === 'owner' || om?.role === 'admin') atRisk.add('pmc');
      }
      const m = await tx.membership.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        update: { role: input.role, discipline, status: 'active' },
        create: { projectId, userId: user.id, role: input.role, discipline, status: 'active' },
      });
      await this.refuseHolderOrphan(tx, projectId, atRisk);
      await emitEvent(tx, { projectId, actor, eventType: 'membership.added', entityType: 'Membership', entityId: user.id, payload: discipline ? { role: input.role, discipline } : { role: input.role }, effectKey: 'membership.added', dispatch: {} });
      return m;
    });
    return { userId: user.id, membershipId: membership.id, name: user.name, email: user.email, phone: user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status, credentialState: user.passwordHash ? 'active' : 'not_set' };
  }

  async updateRole(projectId: string, requester: AuthUser, userId: string, input: UpdateMemberInput): Promise<MemberDto> {
    await this.assertCanManage(projectId, requester);
    const existing = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId, userId } }, include: { user: true } });
    if (!existing) throw new NotFoundException('Member not found on this project');
    const actor = await resolveActor(this.prisma, requester);
    const membership = await this.prisma.$transaction(async (tx) => {
      // Phase 6 task 4b (§A.1/§B.1) — a role change is a standing write behind the decider
      // gate: serialized on the readiness key so the seal's try-acquire sees one writer.
      await lockProjectReadiness(tx, projectId);
      const atRisk = new Set<string>();
      if (existing.status === 'active' && existing.role !== input.role) atRisk.add(existing.role);
      const m = await tx.membership.update({
        where: { projectId_userId: { projectId, userId } },
        data: { role: input.role, discipline: this.disciplineFor(input.role, input.discipline) },
      });
      await this.refuseHolderOrphan(tx, projectId, atRisk);
      await emitEvent(tx, { projectId, actor, eventType: 'membership.role_changed', entityType: 'Membership', entityId: userId, payload: { role: m.role }, effectKey: 'membership.role_changed', dispatch: {} });
      // a consultant's discipline moving is its own fact
      if ((existing.discipline ?? null) !== (m.discipline ?? null)) {
        await emitEvent(tx, { projectId, actor, eventType: 'membership.discipline_changed', entityType: 'Membership', entityId: userId, payload: m.discipline ? { discipline: m.discipline } : undefined, effectKey: 'membership.discipline_changed', dispatch: {} });
      }
      return m;
    });
    return { userId, membershipId: membership.id, name: existing.user.name, email: existing.user.email, phone: existing.user.phone, role: membership.role, discipline: membership.discipline ?? undefined, status: membership.status, credentialState: existing.user.passwordHash ? 'active' : 'not_set' };
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
      // Phase 6 task 4b (§A.1) — BOTH holder designations: a published open decision that NAMES
      // this membership refuses the removal outright; a ROLE-held decision refuses it only when
      // this member was the last effective holder of that role. A private draft blocks nothing.
      const holders = await this.decisionHolders.holdsOpenDecisions(tx, { projectId, membershipId: existing.id });
      if (holders.named) {
        throw new ConflictException(
          'This member is the named decider on an open decision — withdraw and reissue it first',
        );
      }
      await tx.membership.update({ where: { projectId_userId: { projectId, userId } }, data: { status: 'removed' } });
      if (existing.status === 'active' && holders.heldRoles.includes(existing.role)) {
        if ((await this.standing.effectiveRoleStanding(tx, projectId, existing.role)) === 0) {
          throw new ConflictException(
            `An open decision is held by the ${existing.role} role and removing its last active holder would leave it undecidable — withdraw and reissue the decision first`,
          );
        }
      }
      await emitEvent(tx, { projectId, actor, eventType: 'membership.removed', entityType: 'Membership', entityId: userId, effectKey: 'membership.removed', dispatch: {} });
    });
    return { ok: true };
  }
}
