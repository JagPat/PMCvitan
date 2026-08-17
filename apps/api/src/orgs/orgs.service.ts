import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, fromIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import { ddMmmYyyy } from '../domain/dates';
import { lockUserCredential } from '../common/credential-lock';
import { lockProjectReadiness } from '../common/readiness-lock';
import { resolveActor, type Actor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { NodeInitParticipant } from '../nodes/node-init.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { InspectionParticipant } from '../inspections/inspection.participant';
import { ActivitiesQueryService } from '../activities/activities.query';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DecisionsParticipant } from '../decisions/decisions.participant';
import { InspectionsQueryService } from '../inspections/inspections.query';
import type { AuthUser } from '../common/auth';
import { modulePayloadSchema, moduleSelectionSchema, type AddOrgMemberInput, type CorrectInvitationEmailInput, type CreateModuleInput, type CreateOrgInput, type CreateProjectInput, type CreateTemplateInput, type ModulePayload, type UpdateOrgMemberInput, type UpdateProjectInput } from '../contracts';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  lockInitializationDisplayIds,
  runSerializableProjectInit,
  validateInitializationGraph,
  type InitializationGraph,
} from './project-initialization';

/** A member of an org's admin roster (owner/admin/member). */
export interface OrgMemberDto {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  orgRole: string;
  credentialState: 'not_set' | 'active';
}

/** A per-project monitoring rollup across every project the user can access. */
export interface PortfolioProject {
  projectId: string;
  name: string;
  short: string;
  stage: string;
  role: string;
  orgName: string | null;
  activityTotal: number;
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  donePct: number;
  openReviews: number;
  pendingDecisions: number; // 0 unless the user is pmc/client on that project (RBAC)
  phaseCount: number;
  milestonePct: number;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'project'
  );
}

/** Where a module payload's ROOT nodes graft (docs/TEMPLATES.md "anchor kind"): zone roots
 *  → top level (null), room roots → 'zone', element roots → 'room'. No nodes → null
 *  (a project-wide/schedule module). Mixed roots anchor at the deepest requirement. */
function anchorKindOf(payload: ModulePayload): string | null {
  const keys = new Set(payload.nodes.map((n) => n.key));
  const roots = payload.nodes.filter((n) => !n.parentKey || !keys.has(n.parentKey));
  if (roots.some((r) => r.kind === 'element')) return 'room';
  if (roots.some((r) => r.kind === 'room')) return 'zone';
  return null;
}

type InitNodeKind = 'zone' | 'room' | 'element';
type InitSelection = { moduleId: string; count: number; underZone?: string; underRoom?: string };

interface PreparedInitSource {
  label: string;
  rootParentKind: InitNodeKind | null;
  rootParentName?: string;
  nodes: Array<{ key: string; parentKey: string | null; name: string; kind: InitNodeKind; order: number }>;
  phases: Array<{
    identity: string;
    coalesceByName: boolean;
    name: string;
    order: number;
    plannedStart: number;
    plannedEnd: number;
  }>;
  activities: Array<{
    name: string;
    zone: string;
    plannedStart: number;
    plannedEnd: number;
    nodeKey?: string;
    phaseIdentity?: string;
    phaseName?: string;
    order: number;
    gateMaterial: string;
    gateTeam: string;
    gateInspection: string;
  }>;
  inspections: Array<{ title: string; zone: string; nodeKey?: string; items: string[] }>;
}

interface InitWriteState {
  targetId: string;
  userId: string;
  // Task 10 (Module 3) correction — the resolved attribution for the init transaction, threaded so
  // InspectionParticipant.createForInit can append `inspection.created` (materializing the projection).
  actor: Actor;
  targetAnchor: string | null;
  today: string;
  activityIds: string[];
  inspectionIds: string[];
  zoneIdByName: Map<string, string>;
  // Nested locations (phase-6-task-2): a room-anchored module grafts under a room the
  // copied source or an EARLIER selection created (first name wins — deterministic), and
  // every created node's 1-based depth is tracked so the graft depth check runs against
  // the ACTUAL tree, not the static minimum the graph validator bounds.
  roomIdByName: Map<string, string>;
  nodeDepthById: Map<string, number>;
  phaseIdByIdentity: Map<string, string>;
  phaseIdByDefinition: Map<string, string>;
}

const normalizedPhaseName = (name: string): string => name.trim().toLocaleLowerCase('en-US');
const phaseDefinitionKey = (phase: { name: string; order: number; plannedStart: number; plannedEnd: number }): string =>
  `${normalizedPhaseName(phase.name)}\u0000${phase.order}\u0000${phase.plannedStart}\u0000${phase.plannedEnd}`;

/**
 * Orgs (accounts) and the projects they own — the multi-tenant admin layer.
 * Org owners/admins create projects and are auto-enrolled as their PMC; project
 * memberships are the access grants tokens scope to (see AuthService).
 */
@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    // Task 7 (edge 8) — project INITIALIZATION participants: instantiating a project's
    // starting structure (copyStructure / instantiateModules) creates ProjectNode/Phase/
    // Activity/Inspection rows THROUGH these owning-module participants, so orgs never
    // writes another domain's tables directly.
    private readonly nodeInit: NodeInitParticipant,
    private readonly activityInit: ActivityParticipant,
    private readonly inspectionInit: InspectionParticipant,
    // Task 8 — the portfolio's pending-decision tile count comes from the decisions query.
    private readonly decisions: DecisionsQueryService,
    // Phase 6 task 4b, round 4 (Codex P2) — org membership is one of the two ways project pmc
    // standing can vanish, and `OrgMembership_t4b_holder_seal` refuses the write that strands a
    // published open pmc-held decision. The seal is the authority; without a spokesman its
    // exception reaches an org owner as a 500 for what is an ordinary, actionable conflict. Same
    // channel and same predicate as `MembersService` uses, so the two cannot answer differently.
    private readonly decisionHolders: DecisionsParticipant,
    // Task 10 (Module 3) — the source-copy checklist reads, the init id scan, and the portfolio's
    // open-inspection count all route through the inspections query (inspection is read-encapsulated).
    private readonly inspections: InspectionsQueryService,
    // Task 10 (Module 4) — the source-copy schedule reads, the init id scan, and the portfolio's
    // activity-status rollup all route through the activities query (activity/phase/gateOverride are
    // read-encapsulated).
    private readonly activitiesQuery: ActivitiesQueryService,
  ) {}

  /** Org role of a user, or null if not a member. */
  private async orgRole(orgId: string, userId: string): Promise<string | null> {
    const m = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    return m?.role ?? null;
  }

  /** How many owners the org currently has — used to protect the last one. */
  private async ownerCount(orgId: string): Promise<number> {
    return this.prisma.orgMembership.count({ where: { orgId, role: 'owner' } });
  }

  /**
   * The last-owner rule, asked where it is enforced — round 15 (Codex P2).
   *
   * `ownerCount` is a plain read. Taken outside the transaction that performs the demotion it
   * answers a question about a database that no longer exists by the time the write lands: two
   * owners demoting EACH OTHER touch different rows, conflict on nothing, both observe two owners,
   * and both commit. The org is then left with nobody who can add or remove anyone — an
   * unrecoverable state reached by two individually legal actions.
   *
   * Locking the org's owner rows makes the count true at the moment it is used. `FOR UPDATE` in
   * stable `userId` order means two overlapping demotions queue rather than deadlock, and the
   * loser re-reads a count that now includes its rival's commit. It is taken FIRST, before
   * `assertOrgWriteKeepsDecisionHolders` reaches for the target row and the projects' readiness
   * keys, so every org roster writer acquires the same locks in the same order.
   *
   * Round 16 (Codex P2) — and WHETHER the rule applies is decided from that same locked set, not
   * from the caller's pre-read. Round 15 put the COUNT under the lock and left the entry condition
   * reading a `departingRole` fetched before the transaction opened: a request that saw the target
   * as `member` skipped the lock entirely, so a promotion committing in between made its own write
   * the one that removed the last owner. The guard was holding a lock it had already decided it
   * did not need.
   *
   * The parameter is therefore GONE rather than validated. `assertOrgWriteKeepsDecisionHolders`
   * next door learned this in round 6 — "the DEPARTING role comes from the row LOCKED inside this
   * transaction, never from the caller's pre-read" — and a stale value that cannot be passed cannot
   * be trusted. The owner set is read first and answers both questions: is this target currently an
   * owner, and is it the last one.
   *
   * The lock is now taken for any write that does not RESULT in an owner, including a plain
   * addition. That is a little more contention on the org's owner rows and it buys the only
   * ordering that is safe: decide under the lock, or do not decide.
   *
   * Round 18 (Codex P2) — THE DOORS, ENUMERATED, so the next reader can check rather than trust.
   * Four places write `OrgMembership`, and three of them can take owner standing away:
   *
   *   1. `createOrg`            — creates the founding owner. Adds standing; never removes it.
   *   2. `addOrgMember`         — upsert; its UPDATE arm is a demotion.          GUARDED (round 15)
   *   3. `updateOrgMemberRole`  — a demotion.                                    GUARDED (round 15)
   *   4. `removeOrgMember`      — a DELETE, which removes an owner outright.     GUARDED (round 18)
   *
   * Door 4 was missed twice: round 15 fixed the pair in front of it and round 17 revisited that
   * pair without asking how many doors there were. A removal is not a role change, so it never
   * looked like the same rule — and it is exactly the same rule. `nextRole` is `null` for it,
   * which is not `'owner'`, so the guard runs in full.
   */
  private async assertOrgKeepsAnOwner(
    tx: Prisma.TransactionClient,
    orgId: string,
    userId: string,
    nextRole: string | null,
  ): Promise<void> {
    if (nextRole === 'owner') return; // the write leaves an owner behind by construction
    // The lock is over the org's WHOLE roster, not over `role = 'owner'`. A predicate lock is the
    // trap this round nearly shipped: under READ COMMITTED, `FOR UPDATE` re-checks the rows it
    // scanned and DROPS the ones that stopped matching, but it never picks up rows that started
    // matching while it waited. A request blocked behind a promotion would resume, see the old
    // owner drop out of its result, never see the new owner arrive, and conclude the org had no
    // owners at all — the opposite of the truth, and silently permissive. Membership of an org is
    // stable in a way its roles are not, so that is what is locked.
    const roster = await tx.$queryRawUnsafe<Array<{ userId: string; role: string }>>(
      `SELECT "userId", "role" FROM "OrgMembership" WHERE "orgId" = $1 ORDER BY "userId" FOR UPDATE`,
      orgId,
    );
    const owners = roster.filter((m) => m.role === 'owner');
    if (!owners.some((o) => o.userId === userId)) return; // not an owner NOW — this write removes none
    if (owners.length <= 1) throw new BadRequestException('The org must keep at least one owner');
  }

  /** Create a new org; the creator becomes its owner. */
  async createOrg(userId: string, input: CreateOrgInput): Promise<{ id: string; name: string; slug: string }> {
    const slug = `${slugify(input.name)}-${randomUUID().slice(0, 4)}`;
    const org = await this.prisma.org.create({ data: { name: input.name, slug } });
    await this.prisma.orgMembership.create({ data: { orgId: org.id, userId, role: 'owner' } });
    return { id: org.id, name: org.name, slug: org.slug };
  }

  /** Orgs the user administers or belongs to. */
  async myOrgs(userId: string): Promise<Array<{ id: string; name: string; slug: string; role: string }>> {
    const memberships = await this.prisma.orgMembership.findMany({ where: { userId }, include: { org: true } });
    return memberships.map((m) => ({ id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role }));
  }

  /** The org's admin roster — owners/admins/members. Org owner/admin only. */
  async listOrgMembers(orgId: string, callerId: string): Promise<OrgMemberDto[]> {
    const role = await this.orgRole(orgId, callerId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can view the roster');
    const rows = await this.prisma.orgMembership.findMany({ where: { orgId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, phone: m.user.phone, orgRole: m.role, credentialState: m.user.passwordHash ? 'active' : 'not_set' }));
  }

  /**
   * Add someone to the org's admin roster (owner/admin/member) — the only way to
   * grant org-tier power, which an existing project-member API can't. Gated to an
   * org **owner**: granting/revoking admin access is the owner's alone, so an admin
   * can't escalate itself or seed new admins.
   *
   * Access model (ORG escalation fix): an org `owner`/`admin` reaches every project in
   * the org as PMC via the super-admin switch (`isOrgAdminOfProject`), so they need NO
   * project membership; a plain `member` gets NO project access here — they must be
   * added to a specific project's team to operate it. A brand-new identity is created
   * WITHOUT any project grant (no membership, and the required `User.projectId` FK is
   * homed on the org's first project purely to satisfy the schema — it no longer
   * confers access, since resolution reads memberships + org role only). This is what
   * makes demotion/removal actually revoke: strip the OrgMembership and an admin loses
   * the super-admin reach, with no phantom PMC membership left behind. Phone is stored
   * bare (10-digit) to match sign-in.
   */
  async addOrgMember(orgId: string, callerId: string, input: AddOrgMemberInput): Promise<OrgMemberDto> {
    if ((await this.orgRole(orgId, callerId)) !== 'owner') throw new ForbiddenException('Only an org owner can manage the admin roster');

    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      include: { projects: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!org) throw new NotFoundException('Org not found');
    const homeProject = org.projects[0];
    if (!homeProject) throw new BadRequestException('Create a project in this org first, so the new member has a home project');

    const email = input.email?.toLowerCase();
    const phone = input.phone;
    let user =
      (email && (await this.prisma.user.findUnique({ where: { email } }))) ||
      (phone && (await this.prisma.user.findUnique({ where: { phone } }))) ||
      null;
    if (!user) {
      // Least-privilege home role: dormant now (access is membership + org-role only),
      // but if the field is ever consulted again it must not read as `pmc`.
      user = await this.prisma.user.create({ data: { projectId: homeProject.id, role: 'contractor', name: input.name, email, phone } });
    }

    // Round 12 (Codex R12-2) — this upsert's UPDATE arm is a role change, and it was the one org
    // roster door that never asked the holder question. Adding an existing owner/admin with
    // `role: 'member'` DEMOTES them; if they are a project's sole effective pmc, the seal correctly
    // refuses and its raw PostgreSQL exception escaped as a 500 for something `updateOrgMemberRole`
    // answers with an actionable 409. It also took no readiness key, so under contention the seal's
    // try-acquire REFUSED rather than waited.
    //
    // This is the third instance of one shape in this PR (R9-3 `members.add` vs `updateRole`;
    // R11-3 the INSERT vs CONVERSION doors): a rule asked at one of the two ways into the same
    // write. The fix is the same each time — the second door asks what the first door asks, in the
    // same transaction, holding the same keys.
    //
    // The last-owner rule is asked here for the same reason. `updateOrgMemberRole` refuses to strip
    // the org's last owner, and this door could do it silently — a defect the finding does not name
    // but which is the identical sentence at the identical door, and splitting them would leave the
    // pair disagreeing again by the next round.
    const existing = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId: user.id } } });
    const membership = await this.prisma.$transaction(async (tx) => {
      // round 15 — the last-owner count is taken UNDER the org's owner-row locks, inside the
      // transaction that demotes. Read outside it, two owners demoting each other both passed.
      await this.assertOrgKeepsAnOwner(tx, orgId, user.id, input.role);
      // A pure CREATE short-circuits inside the guard: with no row to lock, the departing role is
      // the one being written, and a role that still supplies pmc standing (or never did) returns
      // before any project is examined.
      await this.assertOrgWriteKeepsDecisionHolders(tx, orgId, user.id, existing?.role ?? input.role, input.role);
      return tx.orgMembership.upsert({
        where: { orgId_userId: { orgId, userId: user.id } },
        update: { role: input.role },
        create: { orgId, userId: user.id, role: input.role },
      });
    });
    return { userId: user.id, name: user.name, email: user.email, phone: user.phone, orgRole: membership.role, credentialState: user.passwordHash ? 'active' : 'not_set' };
  }

  /**
   * Change an org member's role (owner/admin/member). Owner only. Refuses to strip
   * the last owner — the org must always have someone who can manage the roster.
   */
  /**
   * Would this org write strand a published open pmc-held decision on any of the org's projects?
   *
   * Phase 6 task 4b, round 4 (Codex P2). `OrgMembership_t4b_holder_seal` already refuses it at
   * PostgreSQL and remains the authority — but an org owner demoting or removing the person who
   * happens to be a project's sole effective pmc got a raw database error and a 500 for something
   * that is an ordinary, actionable conflict. This is the same shape as F12 (`members.remove`) and
   * F9 (`requestChange`), and it is answered the same way: the SERVICE asks first, through the
   * decisions-owned participant, and the seal stays the backstop.
   *
   * The arithmetic mirrors the seal's exactly (R3-6): an org row supplies effective pmc standing
   * to a project only when the user holds NO active `Membership` there, and only a write that
   * REMOVES that supply can strand anything. `orgs_effective_role_standing` is orgs-owned, so it
   * is computed here; the holder question belongs to decisions, so it is asked of them.
   *
   * Round 5 (Codex P2) — the check and the write it guards are now ONE transaction holding each
   * affected project's readiness key. Round 4 asked the question outside any transaction, which
   * left two ways for the 500 it exists to replace to come back: a competing demotion committing
   * between the answer and the write (the database then correctly refuses, and its raw exception
   * escapes), and the seal's own §B.1 try-acquire-or-refuse, which REFUSES rather than waits when
   * some other transaction owns the key. Holding the keys here makes the trigger's acquire
   * re-entrant and makes the answer still true when the write lands. They are taken in ASCENDING
   * project id — the order the trigger's own loop takes them in, so two overlapping org writes
   * queue instead of deadlocking.
   */
  private async assertOrgWriteKeepsDecisionHolders(
    tx: Prisma.TransactionClient,
    orgId: string,
    userId: string,
    currentRole: string,
    nextRole: string | null,
  ): Promise<void> {
    // Round 6 (Codex P2) — the DEPARTING role comes from the row LOCKED inside this transaction,
    // never from the caller's pre-read. Removal A can read its target as a plain `member` while
    // transaction B promotes that same target to admin and removes the previous sole admin; A then
    // skips every readiness lock and holder check on a `currentRole` that is no longer true, and
    // its delete reaches the seal as the removal of the project's sole pmc — leaking the raw
    // trigger error this guard exists to replace. `FOR UPDATE` makes B wait for A or A see B.
    const locked = await tx.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT "role" FROM "OrgMembership" WHERE "orgId" = $1 AND "userId" = $2 FOR UPDATE`,
      orgId, userId,
    );
    const departing = locked[0]?.role ?? currentRole;
    if (departing !== 'owner' && departing !== 'admin') return;
    const stillSupplies = nextRole === 'owner' || nextRole === 'admin';
    if (stillSupplies) return;
    const projects = await tx.project.findMany({ where: { orgId }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const p of projects) {
      await lockProjectReadiness(tx, p.id);
      const rows = await tx.$queryRawUnsafe<Array<{ standing: number; membered: boolean }>>(
        `SELECT orgs_effective_role_standing($1, 'pmc')::int AS standing,
                EXISTS (SELECT 1 FROM "Membership" m
                         WHERE m."projectId" = $1 AND m."userId" = $2 AND m."status" = 'active') AS membered`,
        p.id, userId,
      );
      const row = rows[0];
      if (!row || row.membered) continue; // an active project membership decides; the org row supplies nothing
      if (Number(row.standing) > 1) continue; // another effective pmc survives this write
      if (await this.decisionHolders.holdsOpenDecisions(tx, p.id, null, 'pmc')) {
        throw new ConflictException(
          `This change would leave a published open decision on ${p.id} with no PMC to decide it — cover the project first`,
        );
      }
    }
  }

  async updateOrgMemberRole(orgId: string, callerId: string, userId: string, input: UpdateOrgMemberInput): Promise<OrgMemberDto> {
    if ((await this.orgRole(orgId, callerId)) !== 'owner') throw new ForbiddenException('Only an org owner can change roles');
    const existing = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } }, include: { user: true } });
    if (!existing) throw new NotFoundException('Not a member of this org');
    // round 5 — guard and write in ONE transaction, holding the affected projects' readiness keys
    const membership = await this.prisma.$transaction(async (tx) => {
      // round 15 — and the last-owner rule is asked HERE too, under the same owner-row locks. The
      // finding named `addOrgMember`; this door had the identical read-outside-the-write defect,
      // and fixing one of a pair has been this PR's most repeated mistake.
      await this.assertOrgKeepsAnOwner(tx, orgId, userId, input.role);
      await this.assertOrgWriteKeepsDecisionHolders(tx, orgId, userId, existing.role, input.role);
      return tx.orgMembership.update({ where: { orgId_userId: { orgId, userId } }, data: { role: input.role } });
    });
    return { userId, name: existing.user.name, email: existing.user.email, phone: existing.user.phone, orgRole: membership.role, credentialState: existing.user.passwordHash ? 'active' : 'not_set' };
  }

  /**
   * Correct a mistyped invitation address before the identity establishes a
   * credential. The authority, target containment, enrolled-state check, email
   * update, outstanding-challenge revocation and audit record are one transaction.
   */
  async correctInvitationEmail(
    orgId: string,
    callerId: string,
    userId: string,
    input: CorrectInvitationEmailInput,
  ): Promise<OrgMemberDto> {
    const now = new Date();
    const email = input.email.trim().toLowerCase();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockUserCredential(tx, userId);
        const caller = await tx.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId: callerId } } });
        if (caller?.role !== 'owner' && caller?.role !== 'admin') {
          throw new ForbiddenException('Only an org owner or admin can correct invitation emails');
        }

        const target = await tx.orgMembership.findUnique({
          where: { orgId_userId: { orgId, userId } },
          include: { user: true },
        });
        if (!target) throw new NotFoundException('Not a member of this org');
        if (target.user.passwordHash || target.user.emailVerifiedAt) {
          throw new BadRequestException('This account has already established its sign-in credential');
        }

        const user = await tx.user.update({ where: { id: userId }, data: { email } });
        await tx.passwordCredentialChallenge.updateMany({
          where: { userId, consumedAt: null },
          data: { consumedAt: now },
        });
        await tx.securityAuditEvent.create({
          data: {
            action: 'auth.invitation_email_changed',
            targetUserId: userId,
            actorUserId: callerId,
            actorKind: 'administrator',
            correlationId: randomUUID(),
            payload: { orgId },
          },
        });
        return {
          userId,
          name: user.name,
          email: user.email,
          phone: user.phone,
          orgRole: target.role,
          credentialState: 'not_set',
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('That email address cannot be used');
      }
      throw error;
    }
  }

  /**
   * Revoke someone's org membership. Owner only. You can't remove yourself, nor the
   * last owner (both would leave the org with no one able to manage it).
   */
  async removeOrgMember(orgId: string, callerId: string, userId: string): Promise<{ ok: boolean }> {
    if ((await this.orgRole(orgId, callerId)) !== 'owner') throw new ForbiddenException('Only an org owner can remove members');
    if (userId === callerId) throw new BadRequestException('You cannot remove yourself from the org');
    const existing = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    if (!existing) throw new NotFoundException('Not a member of this org');
    // round 5 — guard and write in ONE transaction, holding the affected projects' readiness keys
    await this.prisma.$transaction(async (tx) => {
      // round 18 — the THIRD door. A removal takes owner standing away exactly as a demotion does,
      // and its `ownerCount` was the same unlocked pre-read the other two doors had already shed.
      await this.assertOrgKeepsAnOwner(tx, orgId, userId, null);
      await this.assertOrgWriteKeepsDecisionHolders(tx, orgId, userId, existing.role, null);
      await tx.orgMembership.delete({ where: { orgId_userId: { orgId, userId } } });
    });
    return { ok: true };
  }

  /** Create a project under an org (owner/admin only); enrol the creator as PMC. */
  async createProject(orgId: string, userId: string, input: CreateProjectInput): Promise<{ id: string; name: string; short: string }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an org owner or admin can create projects');
    }
    const id = `${slugify(input.short)}-${randomUUID().slice(0, 4)}`;
    const timeZone = input.timeZone ?? 'Asia/Kolkata';
    const scheduleStartDate = input.scheduleStartDate ?? this.clock.today(timeZone);
    const actor = await resolveActor(this.prisma, { sub: userId, role, projectId: id } as unknown as AuthUser);
    const explicitSelections = [...(input.modules ?? [])] as InitSelection[];
    const targetAnchor = scheduleStartDate;
    const today = ddMmmYyyy(new Date());

    const project = await runSerializableProjectInit(this.prisma, async (tx) => {
      const templateSelections = input.templateId ? await this.templateSelections(tx, orgId, input.templateId) : [];
      const selections = [...templateSelections, ...explicitSelections];
      const source = input.structureFrom ? await this.loadSourceStructure(tx, orgId, input.structureFrom) : null;
      const modules = selections.length ? await this.loadModuleCopies(tx, orgId, selections) : [];
      const sources = [...(source ? [source] : []), ...modules];

      validateInitializationGraph('Project initialization', this.initializationGraph(sources));
      await lockInitializationDisplayIds(tx);
      const [allActivityIds, allInspectionIds] = await Promise.all([
        this.activitiesQuery.allIds(tx),
        this.inspections.allIds(tx),
      ]);

      const p = await tx.project.create({
        data: {
          id,
          orgId,
          name: input.name,
          short: input.short,
          descriptor: input.descriptor,
          stage: input.stage,
          siteCode: input.siteCode,
          projStart: input.projStart,
          projEnd: input.projEnd,
          scheduleStartDate: fromIsoCivilDate(scheduleStartDate),
          timeZone,
          elapsedPct: 0,
          todayDay: 0,
          milestonePct: 0,
        },
      });
      // the creator runs the project as its PMC
      await tx.membership.create({ data: { projectId: id, userId, role: 'pmc', status: 'active' } });
      await emitEvent(tx, { projectId: id, actor, eventType: 'project.created', entityType: 'Project', entityId: id, payload: { name: input.name }, effectKey: 'project.created', dispatch: {} });

      const state: InitWriteState = {
        targetId: id,
        userId,
        actor,
        targetAnchor,
        today,
        activityIds: allActivityIds,
        inspectionIds: allInspectionIds,
        zoneIdByName: new Map<string, string>(),
        roomIdByName: new Map<string, string>(),
        nodeDepthById: new Map<string, number>(),
        phaseIdByIdentity: new Map<string, string>(),
        phaseIdByDefinition: new Map<string, string>(),
      };
      await this.createInitializationPhases(tx, sources, state);
      if (source) await this.copyStructure(tx, source, state);
      if (modules.length) await this.instantiateModules(tx, modules, state);
      return p;
    });
    return { id: project.id, name: project.name, short: project.short };
  }

  /** The Slice-1 source guard: a structure source must be an unarchived project in this org. */
  private async assertSourceProject(tx: Prisma.TransactionClient, orgId: string, sourceId: string): Promise<void> {
    const source = await tx.project.findUnique({ where: { id: sourceId }, select: { orgId: true, archivedAt: true } });
    if (!source || source.orgId !== orgId || source.archivedAt) throw new NotFoundException('Source project not found in this org');
  }

  /** Every selection's module must be this org's, unarchived, and placeable at create time —
   *  checked BEFORE the project row exists, so a stale pick can never strand an orphan. */
  private async assertPlaceable(tx: Prisma.TransactionClient, orgId: string, selections: InitSelection[]) {
    const rows = await tx.templateModule.findMany({
      where: { id: { in: selections.map((s) => s.moduleId) } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const s of selections) {
      const m = byId.get(s.moduleId);
      if (!m || m.orgId !== orgId || m.archivedAt) throw new NotFoundException('Module not found in this org');
      this.assertSelectionTarget(m, s);
    }
    return byId;
  }

  /** The anchor-specific graft target rule, shared by project creation AND preset save
   *  (a preset exists only to be expanded, so what expansion would refuse, saving refuses
   *  too — with the same words). A room-anchored (element-root) module grafts under a
   *  NAMED room or directly under a zone: exactly one of the two, stated explicitly —
   *  never a silently invented default container. `underRoom` on a zone-anchored module
   *  is meaningless and refused rather than ignored. */
  private assertSelectionTarget(m: { name: string; anchorKind: string | null }, s: { underZone?: string; underRoom?: string }): void {
    if (m.anchorKind === 'room') {
      if (Boolean(s.underRoom) === Boolean(s.underZone)) {
        throw new BadRequestException(
          `"${m.name}" anchors to a room — pick exactly one graft target: underRoom (a room the structure creates) or underZone (directly under that zone)`,
        );
      }
      return;
    }
    if (s.underRoom) {
      throw new BadRequestException(`"${m.name}" does not anchor to a room — underRoom applies to element modules only`);
    }
  }

  // ── Templates Slice 3 — named presets (docs/TEMPLATES.md) ───────────────────

  /** A preset's module selection, ready for instantiation (org-checked, defaults filled). */
  private async templateSelections(tx: Prisma.TransactionClient, orgId: string, templateId: string): Promise<InitSelection[]> {
    const t = await tx.projectTemplate.findUnique({ where: { id: templateId } });
    if (!t || t.orgId !== orgId || t.archivedAt) throw new NotFoundException('Template not found in this org');
    const parsed = z.array(moduleSelectionSchema).safeParse(t.items ?? []);
    if (!parsed.success) throw new BadRequestException(`Project initialization: template "${templateId}" has invalid module selections`);
    return parsed.data;
  }

  private async loadSourceStructure(tx: Prisma.TransactionClient, orgId: string, sourceId: string): Promise<PreparedInitSource> {
    await this.assertSourceProject(tx, orgId, sourceId);
    const [nodes, schedule, inspections] = await Promise.all([
      tx.projectNode.findMany({ where: { projectId: sourceId }, orderBy: { createdAt: 'asc' } }),
      // Task 10 (Module 4) — the source schedule (phases + activities as PLANNED structure) comes from
      // the activities module's query, never a direct `prisma.phase`/`prisma.activity` read.
      this.activitiesQuery.scheduleStructures(sourceId, { tx }),
      this.inspections.checklistStructures(sourceId, { tx }),
    ]);
    return {
      label: `source project "${sourceId}"`,
      rootParentKind: null,
      nodes: nodes.map((node) => ({ key: node.id, parentKey: node.parentId, name: node.name, kind: node.kind as InitNodeKind, order: node.order })),
      phases: schedule.phases.map((phase) => ({
        identity: phase.id,
        coalesceByName: false,
        name: phase.name,
        order: phase.order,
        plannedStart: phase.plannedStart,
        plannedEnd: phase.plannedEnd,
      })),
      activities: schedule.activities.map((activity) => ({
        name: activity.name,
        zone: activity.zone,
        plannedStart: activity.plannedStart,
        plannedEnd: activity.plannedEnd,
        ...(activity.nodeId ? { nodeKey: activity.nodeId } : {}),
        ...(activity.phaseId ? { phaseIdentity: activity.phaseId } : {}),
        order: activity.order,
        gateMaterial: activity.gateMaterial === 'na' ? 'na' : 'wait',
        gateTeam: activity.gateTeam === 'na' ? 'na' : 'wait',
        gateInspection: activity.gateInspection === 'na' ? 'na' : 'wait',
      })),
      inspections: inspections.map((inspection) => ({
        title: inspection.title,
        zone: inspection.zone,
        ...(inspection.nodeId ? { nodeKey: inspection.nodeId } : {}),
        items: inspection.items,
      })),
    };
  }

  private async loadModuleCopies(tx: Prisma.TransactionClient, orgId: string, selections: InitSelection[]): Promise<PreparedInitSource[]> {
    const modulesById = await this.assertPlaceable(tx, orgId, selections);
    const sources: PreparedInitSource[] = [];
    for (const [selectionIndex, selection] of selections.entries()) {
      const row = modulesById.get(selection.moduleId)!;
      const parsed = modulePayloadSchema.safeParse(row.payload ?? {});
      if (!parsed.success) throw new BadRequestException(`Project initialization: module "${row.name}" has an invalid payload`);
      for (let copy = 1; copy <= selection.count; copy += 1) {
        const suffix = selection.count > 1 ? ` ${copy}` : '';
        const label = `module "${row.name}" selection ${selectionIndex + 1} copy ${copy}`;
        // Where this copy's roots graft. A zone-anchored (room-root) module grafts under the
        // named zone (created as a draft if new — its default container is the historical
        // 'Ground Floor'). A room-anchored (element-root) module grafts under the NAMED room
        // when `underRoom` is given, or directly under the named zone (the nested-locations
        // decision's element-under-zone edge) — `assertPlaceable` already proved exactly one
        // target is present.
        const graft: Pick<PreparedInitSource, 'rootParentKind' | 'rootParentName'> =
          row.anchorKind === 'zone'
            ? { rootParentKind: 'zone', rootParentName: selection.underZone ?? 'Ground Floor' }
            : row.anchorKind === 'room'
              ? selection.underRoom
                ? { rootParentKind: 'room', rootParentName: selection.underRoom }
                : { rootParentKind: 'zone', rootParentName: selection.underZone! }
              : { rootParentKind: null };
        sources.push({
          label,
          ...graft,
          nodes: parsed.data.nodes.map((node) => ({
            key: node.key,
            parentKey: node.parentKey,
            name: node.parentKey ? node.name : `${node.name}${suffix}`,
            kind: node.kind,
            order: node.order,
          })),
          phases: parsed.data.phases.map((phase) => ({
            identity: normalizedPhaseName(phase.name),
            coalesceByName: true,
            ...phase,
          })),
          activities: parsed.data.activities.map((activity) => ({
            ...activity,
            name: `${activity.name}${suffix}`,
            ...(activity.phaseName ? { phaseIdentity: normalizedPhaseName(activity.phaseName) } : {}),
            gateMaterial: 'wait',
            gateTeam: 'wait',
            gateInspection: 'wait',
          })),
          inspections: parsed.data.inspections.map((inspection) => ({ ...inspection, title: `${inspection.title}${suffix}` })),
        });
      }
    }
    return sources;
  }

  private initializationGraph(sources: PreparedInitSource[]): InitializationGraph {
    return {
      nodes: sources.flatMap((source) => source.nodes.map((node) => ({
        source: source.label,
        key: node.key,
        parentKey: node.parentKey,
        kind: node.kind,
        ...(!node.parentKey ? { rootParentKind: source.rootParentKind } : {}),
      }))),
      phases: sources.flatMap((source) => source.phases.map((phase) => ({ source: source.label, ...phase }))),
      activities: sources.flatMap((source) => source.activities.map((activity) => ({
        source: source.label,
        name: activity.name,
        ...(activity.nodeKey ? { nodeKey: activity.nodeKey } : {}),
        ...(activity.phaseIdentity ? { phaseIdentity: activity.phaseIdentity } : {}),
        ...(activity.phaseName ? { phaseName: activity.phaseName } : {}),
      }))),
      inspections: sources.flatMap((source) => source.inspections.map((inspection) => ({
        source: source.label,
        title: inspection.title,
        ...(inspection.nodeKey ? { nodeKey: inspection.nodeKey } : {}),
      }))),
    };
  }

  /** The org's named presets, with module names resolved for display (any org member). */
  async listTemplates(orgId: string, userId: string) {
    if (!(await this.orgRole(orgId, userId))) throw new ForbiddenException('Not a member of this org');
    const [rows, modules] = await Promise.all([
      this.prisma.projectTemplate.findMany({ where: { orgId, archivedAt: null }, orderBy: { name: 'asc' } }),
      this.prisma.templateModule.findMany({ where: { orgId }, select: { id: true, name: true, archivedAt: true } }),
    ]);
    const moduleOf = new Map(modules.map((m) => [m.id, m]));
    return rows.map((t) => {
      const items = z.array(moduleSelectionSchema).parse(t.items ?? []);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.version,
        items,
        // an archived/missing module is surfaced honestly rather than listing as healthy (review F2)
        moduleNames: items.map((i) => {
          const m = moduleOf.get(i.moduleId);
          const label = m ? `${m.name}${m.archivedAt ? ' (archived)' : ''}` : 'missing module';
          return `${label}${i.count > 1 ? ` ×${i.count}` : ''}`;
        }),
      };
    });
  }

  /**
   * Create a named preset (org owner/admin). Two paths:
   *   • explicit `items` — every module must be this org's and unarchived;
   *   • `fromProject` — capture the project's FULL structure as one new module (a single
   *     coherent module keeps activity/checklist place references intact) and wrap it in
   *     a preset. Richer multi-module presets are hand-composed from the menu.
   */
  async createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can manage templates');

    if (input.items) {
      const modules = await this.prisma.templateModule.findMany({
        where: { id: { in: input.items.map((i) => i.moduleId) } },
        select: { id: true, orgId: true, archivedAt: true, anchorKind: true, name: true },
      });
      const ok = new Map(modules.map((m) => [m.id, m]));
      for (const i of input.items) {
        const m = ok.get(i.moduleId);
        if (!m || m.orgId !== orgId || m.archivedAt) throw new NotFoundException('Module not found in this org');
        // a preset exists only to be expanded at create-project — so saving applies the SAME
        // graft-target rule expansion applies (review F3's principle, now that element modules
        // ARE placeable): a room-anchored item must carry its explicit target, or the preset
        // would be minted unusable and fail only at expansion.
        this.assertSelectionTarget(m, i);
      }
      const created = await this.prisma.projectTemplate.create({
        data: { orgId, name: input.name, description: input.description, items: input.items },
      });
      return {
        id: created.id,
        name: created.name,
        description: created.description,
        version: created.version,
        items: input.items,
        moduleNames: input.items.map((i) => `${ok.get(i.moduleId)!.name}${i.count > 1 ? ` ×${i.count}` : ''}`),
      };
    }

    const payload = await this.extractPayload(orgId, input.fromProject!);
    const modName = `${input.name} — full structure`;
    // The captured module and its wrapping preset commit together — a failed save must
    // never strand an orphan module in the menu (review F4).
    const { tpl, moduleId } = await this.prisma.$transaction(async (tx) => {
      const mod = await tx.templateModule.create({
        data: {
          orgId,
          name: modName,
          category: payload.nodes.length ? 'zone' : 'schedule',
          anchorKind: anchorKindOf(payload),
          description: `Captured from a project for the "${input.name}" template`,
          payload,
        },
      });
      const created = await tx.projectTemplate.create({
        data: { orgId, name: input.name, description: input.description, items: [{ moduleId: mod.id, count: 1 }] },
      });
      return { tpl: created, moduleId: mod.id };
    });
    return {
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      version: tpl.version,
      items: [{ moduleId, count: 1 }],
      moduleNames: [modName],
    };
  }

  /** Archive a preset — leaves the picker; its modules and existing projects are untouched. */
  async archiveTemplate(orgId: string, userId: string, templateId: string): Promise<{ ok: boolean }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can manage templates');
    const t = await this.prisma.projectTemplate.findUnique({ where: { id: templateId }, select: { orgId: true } });
    if (!t || t.orgId !== orgId) throw new NotFoundException('Template not found in this org');
    await this.prisma.projectTemplate.update({ where: { id: templateId }, data: { archivedAt: new Date() } });
    return { ok: true };
  }

  // ── Templates Slice 2 — the org module menu (docs/TEMPLATES.md) ─────────────

  /** Shape a module row for the menu: identity + content counts, never the raw payload. */
  private moduleSummary(m: { id: string; name: string; category: string; anchorKind: string | null; version: number; description: string; payload: unknown }) {
    const p = modulePayloadSchema.parse(m.payload ?? {});
    return {
      id: m.id,
      name: m.name,
      category: m.category,
      anchorKind: m.anchorKind,
      version: m.version,
      description: m.description,
      counts: { nodes: p.nodes.length, phases: p.phases.length, activities: p.activities.length, inspections: p.inspections.length },
    };
  }

  /** The org's module menu (any org member; archived modules hidden). */
  async listModules(orgId: string, userId: string) {
    if (!(await this.orgRole(orgId, userId))) throw new ForbiddenException('Not a member of this org');
    const rows = await this.prisma.templateModule.findMany({ where: { orgId, archivedAt: null }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    return rows.map((m) => this.moduleSummary(m));
  }

  /**
   * Create a module (org owner/admin) — with an explicit payload, or EXTRACTED from a
   * same-org project: `fromNodeId` captures that node's subtree (+ the checklist
   * definitions filed within it); no `fromNodeId` captures the whole project's structure
   * (tree + phases + planned activities + checklists). Extraction is the same
   * structure-not-actuals rule as Slice 1 — item names travel, states/photos/people don't.
   */
  async createModule(orgId: string, userId: string, input: CreateModuleInput) {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can manage modules');

    let payload: ModulePayload;
    let anchorKind: string | null = null;
    if (input.payload) {
      payload = input.payload;
      anchorKind = anchorKindOf(payload);
    } else {
      const extracted = await this.extractPayload(orgId, input.fromProject!, input.fromNodeId);
      payload = extracted;
      anchorKind = anchorKindOf(extracted);
    }

    const created = await this.prisma.templateModule.create({
      data: { orgId, name: input.name, category: input.category, anchorKind, description: input.description, payload },
    });
    return this.moduleSummary(created);
  }

  /** Archive a module — it leaves the menu; existing projects are untouched (owner/admin).
   *  Refused while a live preset references it: the preset would keep listing as healthy
   *  and then hard-fail at create-project (adversarial review, F2). */
  async archiveModule(orgId: string, userId: string, moduleId: string): Promise<{ ok: boolean }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can manage modules');
    const m = await this.prisma.templateModule.findUnique({ where: { id: moduleId }, select: { orgId: true } });
    if (!m || m.orgId !== orgId) throw new NotFoundException('Module not found in this org');
    const presets = await this.prisma.projectTemplate.findMany({ where: { orgId, archivedAt: null }, select: { name: true, items: true } });
    const referencing = presets.filter((t) => {
      const parsed = z.array(moduleSelectionSchema).safeParse(t.items ?? []);
      return parsed.success && parsed.data.some((i) => i.moduleId === moduleId);
    });
    if (referencing.length) {
      throw new BadRequestException(`This module is used by ${referencing.map((t) => `"${t.name}"`).join(', ')} — archive those templates first`);
    }
    await this.prisma.templateModule.update({ where: { id: moduleId }, data: { archivedAt: new Date() } });
    return { ok: true };
  }

  /** Build a module payload from a live project (same-org, unarchived) — see createModule. */
  private async extractPayload(orgId: string, sourceId: string, fromNodeId?: string): Promise<ModulePayload> {
    await this.assertSourceProject(this.prisma, orgId, sourceId);

    const allNodes = await this.prisma.projectNode.findMany({ where: { projectId: sourceId }, orderBy: { createdAt: 'asc' } });
    let nodes = allNodes;
    if (fromNodeId) {
      const inSubtree = new Set<string>([fromNodeId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of allNodes) {
          if (n.parentId && inSubtree.has(n.parentId) && !inSubtree.has(n.id)) {
            inSubtree.add(n.id);
            grew = true;
          }
        }
      }
      if (!inSubtree.has(fromNodeId) || !allNodes.some((n) => n.id === fromNodeId)) throw new NotFoundException('Node not found in the source project');
      nodes = allNodes.filter((n) => inSubtree.has(n.id));
    }
    const nodeIds = new Set(nodes.map((n) => n.id));

    const inspections = await this.inspections.checklistStructures(sourceId, fromNodeId ? { nodeIds: [...nodeIds] } : {});
    // phases + planned activities only travel for a whole-project extraction — a space
    // module is spatial; the schedule shape belongs to schedule/whole-project modules
    // (Task 10 Module 4 — read through the activities query, never `prisma.phase`/`prisma.activity`).
    const { phases, activities } = fromNodeId
      ? { phases: [], activities: [] }
      : await this.activitiesQuery.scheduleStructures(sourceId);
    const phaseName = new Map(phases.map((p) => [p.id, p.name]));

    return modulePayloadSchema.parse({
      nodes: nodes.map((n) => ({
        key: n.id, // payload-internal keys; instantiation mints fresh ids
        parentKey: n.parentId && nodeIds.has(n.parentId) ? n.parentId : null,
        name: n.name,
        kind: n.kind,
        order: n.order,
      })),
      phases: phases.map((p) => ({ name: p.name, order: p.order, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd })),
      activities: activities.map((a) => ({
        name: a.name,
        zone: a.zone,
        plannedStart: a.plannedStart,
        plannedEnd: a.plannedEnd,
        nodeKey: a.nodeId && nodeIds.has(a.nodeId) ? a.nodeId : undefined,
        phaseName: a.phaseId ? phaseName.get(a.phaseId) : undefined,
        order: a.order,
      })),
      inspections: inspections.map((i) => ({
        title: i.title,
        zone: i.zone,
        nodeKey: i.nodeId && nodeIds.has(i.nodeId) ? i.nodeId : undefined,
        items: i.items,
      })),
    });
  }

  /**
   * Stamp the chosen modules into a freshly created project — the à-la-carte composition
   * (docs/TEMPLATES.md "How you modulate"). Per selection: `count` repeats the module with
   * the root names suffixed ("Bedroom 1/2/3"); a room-anchored module grafts under the
   * `underZone` zone (found by name among the project's zones, created as a draft if new).
   * Everything lands as drafts authored by the creator, same as Slice 1.
   */
  private async instantiateModules(
    tx: Prisma.TransactionClient,
    sources: PreparedInitSource[],
    state: InitWriteState,
  ): Promise<void> {
    for (const source of sources) await this.writeInitializationSource(tx, source, state);
  }

  /**
   * Copy a source project's STRUCTURE — never its actuals — into a freshly created target
   * (Templates Slice 1, see docs/TEMPLATES.md). What travels:
   *   • the location tree (zones → rooms → objects), re-created as private DRAFTS authored by
   *     the creator, so the skeleton is refined then published per project;
   *   • phases (name/order/planned window);
   *   • activities as their PLANNED shape only — name/zone/planned offsets/phase/place; status
   *     reset to not_started, actual dates/decision link/block cleared, and stored gates
   *     stripped of outcomes (ok|fail → wait) while `na` stays (it's structural: "gate not
   *     applicable" is part of the shape, "gate passed" is an actual);
   *   • inspection CHECKLIST definitions (title/zone/place + item names) — unsubmitted,
   *     undecided, item states/photos/notes cleared. Reviews (incl. auto-created closing
   *     inspections) are results, not structure, and are never copied.
   * Decisions, drawings, media, daily logs, notifications, and people are never copied.
   * The source must be an unarchived project in the SAME org (the caller already proved
   * org owner/admin authority, and org admins can operate every org project).
   */
  private async copyStructure(tx: Prisma.TransactionClient, source: PreparedInitSource, state: InitWriteState): Promise<void> {
    await this.writeInitializationSource(tx, source, state);
  }

  private async createInitializationPhases(tx: Prisma.TransactionClient, sources: PreparedInitSource[], state: InitWriteState): Promise<void> {
    const datesFor = (start: number, end: number) =>
      state.targetAnchor
        ? { plannedStartDate: fromIsoCivilDate(addCivilDays(state.targetAnchor, start)), plannedEndDate: fromIsoCivilDate(addCivilDays(state.targetAnchor, end)) }
        : {};
    const phases = sources.flatMap((source) => source.phases.map((phase) => ({ source, phase })));
    const ordered = [
      ...phases.filter(({ phase }) => !phase.coalesceByName),
      ...phases.filter(({ phase }) => phase.coalesceByName),
    ];
    for (const { source, phase } of ordered) {
      const identityKey = `${source.label}\u0000${phase.identity}`;
      const definitionKey = phaseDefinitionKey(phase);
      const coalescedId = phase.coalesceByName ? state.phaseIdByDefinition.get(definitionKey) : undefined;
      if (coalescedId) {
        state.phaseIdByIdentity.set(identityKey, coalescedId);
        continue;
      }
      // the participant appends `phase.created` {init:true} so the activities projection materializes
      const created = await this.activityInit.createPhaseForInit(tx, {
        data: {
          projectId: state.targetId,
          name: phase.name,
          order: phase.order,
          plannedStart: phase.plannedStart,
          plannedEnd: phase.plannedEnd,
          ...datesFor(phase.plannedStart, phase.plannedEnd),
        },
      }, { projectId: state.targetId, actor: state.actor });
      state.phaseIdByIdentity.set(identityKey, created.id);
      if (!state.phaseIdByDefinition.has(definitionKey)) state.phaseIdByDefinition.set(definitionKey, created.id);
    }
  }

  private async writeInitializationSource(tx: Prisma.TransactionClient, source: PreparedInitSource, state: InitWriteState): Promise<void> {
    const datesFor = (start: number, end: number) =>
      state.targetAnchor
        ? { plannedStartDate: fromIsoCivilDate(addCivilDays(state.targetAnchor, start)), plannedEndDate: fromIsoCivilDate(addCivilDays(state.targetAnchor, end)) }
        : {};
    const required = (map: Map<string, string>, key: string, kind: string): string => {
      const id = map.get(key);
      if (!id) throw new Error(`${source.label}: unresolved ${kind} "${key}" after graph validation`);
      return id;
    };
    const zoneFor = async (name: string): Promise<string> => {
      const existing = state.zoneIdByName.get(name);
      if (existing) return existing;
      const created = await this.nodeInit.createForInit(tx, {
        data: { projectId: state.targetId, parentId: null, name, kind: 'zone', order: state.zoneIdByName.size, publishedAt: null, authorId: state.userId },
      });
      state.zoneIdByName.set(name, created.id);
      state.nodeDepthById.set(created.id, 1);
      return created.id;
    };

    // Where this source's roots graft. A zone target may be created fresh (a draft zone is a
    // legal top-level invention); a ROOM target must already exist in the structure — a room
    // cannot be invented without its own parent, so an unknown name is a refusal with the
    // reason stated, never a silently minted container.
    const rootParentId = source.rootParentName
      ? source.rootParentKind === 'room'
        ? (state.roomIdByName.get(source.rootParentName)
          ?? (() => {
            throw new BadRequestException(
              `${source.label}: no room named "${source.rootParentName}" exists in the project structure — `
              + 'an element module grafts under a room created by the copied source or an earlier selection, '
              + 'or directly under a zone via underZone',
            );
          })())
        : await zoneFor(source.rootParentName)
      : null;
    const nodeIdByKey = new Map<string, string>();
    let remaining = [...source.nodes];
    while (remaining.length) {
      const batch = remaining.filter((node) => !node.parentKey || nodeIdByKey.has(node.parentKey));
      if (!batch.length) throw new Error(`${source.label}: unresolved node creation state for "${remaining[0]!.key}"`);
      for (const node of batch) {
        const parentId = node.parentKey ? required(nodeIdByKey, node.parentKey, 'parent key') : rootParentId;
        // The depth cap at the ACTUAL graft depth (the graph validator bounds only the static
        // minimum): initialization is the second write path, and the same 5-level rule the
        // node endpoints enforce holds here — a module whose graft would exceed it is refused.
        const depth = parentId ? (state.nodeDepthById.get(parentId) ?? 1) + 1 : 1;
        if (depth > 5) {
          throw new BadRequestException(
            `${source.label}: node "${node.name}" would land at level ${depth} — locations nest to 5 levels`,
          );
        }
        const created = await this.nodeInit.createForInit(tx, {
          data: {
            projectId: state.targetId,
            parentId,
            name: node.name,
            kind: node.kind,
            order: node.order,
            publishedAt: null,
            authorId: state.userId,
          },
        });
        nodeIdByKey.set(node.key, created.id);
        state.nodeDepthById.set(created.id, depth);
        if (node.kind === 'zone') state.zoneIdByName.set(node.name, created.id);
        if (node.kind === 'room' && !state.roomIdByName.has(node.name)) state.roomIdByName.set(node.name, created.id);
      }
      remaining = remaining.filter((node) => !nodeIdByKey.has(node.key));
    }

    for (const activity of source.activities) {
      const id = nextSeqId('ACT-', state.activityIds);
      state.activityIds.push(id);
      await this.activityInit.createForInit(tx, {
        data: {
          id,
          projectId: state.targetId,
          name: activity.name,
          zone: activity.zone,
          status: 'not_started',
          plannedStart: activity.plannedStart,
          plannedEnd: activity.plannedEnd,
          ...datesFor(activity.plannedStart, activity.plannedEnd),
          actualStart: null,
          actualEnd: null,
          block: null,
          gateMaterial: activity.gateMaterial as never,
          gateTeam: activity.gateTeam as never,
          gateInspection: activity.gateInspection as never,
          decisionId: null,
          phaseId: activity.phaseIdentity
            ? required(state.phaseIdByIdentity, `${source.label}\u0000${activity.phaseIdentity}`, 'phase identity')
            : null,
          nodeId: activity.nodeKey ? required(nodeIdByKey, activity.nodeKey, 'node key') : null,
          order: activity.order,
        },
        // the participant appends `activity.created` {init:true} so the activities projection materializes
      }, { projectId: state.targetId, actor: state.actor });
    }

    for (const inspection of source.inspections) {
      const id = nextSeqId('INSP-', state.inspectionIds);
      state.inspectionIds.push(id);
      await this.inspectionInit.createForInit(
        tx,
        {
          data: {
            id,
            projectId: state.targetId,
            kind: 'checklist',
            title: inspection.title,
            zone: inspection.zone,
            by: null,
            date: state.today,
            submitted: false,
            decided: false,
            nodeId: inspection.nodeKey ? required(nodeIdByKey, inspection.nodeKey, 'node key') : null,
            items: { create: inspection.items.map((name, index) => ({ name, order: index })) },
          },
        },
        // Task 10 (Module 3) correction — append `inspection.created` in the init tx so the
        // inspections.inbox projection MATERIALIZES from init events (no indefinite live fallback).
        { projectId: state.targetId, actor: state.actor },
      );
    }
  }

  /** Edit a project's details (name/stage/dates…). The project's PMC or an org
   *  owner/admin may edit; only the provided fields change. */
  async updateProject(orgId: string, userId: string, pid: string, input: UpdateProjectInput): Promise<{ id: string; name: string; short: string }> {
    const orgRole = await this.orgRole(orgId, userId);
    let allowed = orgRole === 'owner' || orgRole === 'admin';
    if (!allowed) {
      const m = await this.prisma.membership.findUnique({ where: { projectId_userId: { projectId: pid, userId } } });
      allowed = m?.role === 'pmc' && m?.status === 'active';
    }
    if (!allowed) throw new ForbiddenException('Only the project PMC or an org admin can edit a project');
    const project = await this.prisma.project.findUnique({ where: { id: pid }, select: { orgId: true } });
    if (!project || project.orgId !== orgId) throw new NotFoundException('Project not found in this org');
    const actor = await resolveActor(this.prisma, { sub: userId, role: orgRole ?? 'pmc', projectId: pid } as unknown as AuthUser);
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.project.update({ where: { id: pid }, data: input });
      await emitEvent(tx, { projectId: pid, actor, eventType: 'project.updated', entityType: 'Project', entityId: pid, effectKey: 'project.updated', dispatch: {} });
      return u;
    });
    return { id: updated.id, name: updated.name, short: updated.short };
  }

  /** Archive (soft-delete) a project — hides it from listings/switcher/portfolio.
   *  Reversible via restore. Org owner/admin only; the project must belong to the org. */
  async deleteProject(orgId: string, userId: string, projectId: string): Promise<{ ok: boolean }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an org owner or admin can delete projects');
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    if (!project || project.orgId !== orgId) throw new NotFoundException('Project not found in this org');
    const actor = await resolveActor(this.prisma, { sub: userId, role, projectId } as unknown as AuthUser);
    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      await emitEvent(tx, { projectId, actor, eventType: 'project.archived', entityType: 'Project', entityId: projectId, effectKey: 'project.archived', dispatch: {} });
    });
    return { ok: true };
  }

  /** Restore a previously archived project. Org owner/admin only. */
  async restoreProject(orgId: string, userId: string, projectId: string): Promise<{ ok: boolean }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an org owner or admin can restore projects');
    }
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    if (!project || project.orgId !== orgId) throw new NotFoundException('Project not found in this org');
    const actor = await resolveActor(this.prisma, { sub: userId, role, projectId } as unknown as AuthUser);
    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { archivedAt: null } });
      await emitEvent(tx, { projectId, actor, eventType: 'project.restored', entityType: 'Project', entityId: projectId, effectKey: 'project.restored', dispatch: {} });
    });
    return { ok: true };
  }

  /**
   * Projects in an org, scoped by the caller's reach (ORG member-isolation).
   * An org `owner`/`admin` sees every (non-archived) project — that's the
   * super-admin reach. A plain `member` sees ONLY the projects where they hold an
   * active project `Membership`, so they can't enumerate the whole org. Archived
   * projects are hidden either way.
   */
  async listProjects(orgId: string, userId: string): Promise<Array<{ id: string; name: string; short: string; stage: string }>> {
    const role = await this.orgRole(orgId, userId);
    if (!role) throw new ForbiddenException('Not a member of this org');
    const org = await this.prisma.org.findUnique({ where: { id: orgId }, include: { projects: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } } } });
    if (!org) throw new NotFoundException('Org not found');

    let visible = org.projects;
    if (role !== 'owner' && role !== 'admin') {
      const memberships = await this.prisma.membership.findMany({
        where: { userId, status: 'active', projectId: { in: org.projects.map((p) => p.id) } },
        select: { projectId: true },
      });
      const allowed = new Set(memberships.map((m) => m.projectId));
      visible = org.projects.filter((p) => allowed.has(p.id));
    }
    return visible.map((p) => ({ id: p.id, name: p.name, short: p.short, stage: p.stage }));
  }

  /** Archived (soft-deleted) projects in an org — owner/admin only, for the restore UI. */
  async listArchivedProjects(orgId: string, userId: string): Promise<Array<{ id: string; name: string; short: string; archivedAt: string }>> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') throw new ForbiddenException('Only an org owner or admin can view archived projects');
    const rows = await this.prisma.project.findMany({ where: { orgId, archivedAt: { not: null } }, orderBy: { archivedAt: 'desc' } });
    return rows.map((p) => ({ id: p.id, name: p.name, short: p.short, archivedAt: p.archivedAt!.toISOString() }));
  }

  /**
   * A cross-project monitoring rollup — one row per project the user is a member
   * of (active memberships, with the legacy home project as a fallback). Each row
   * counts activities by status, open reviews and (RBAC-gated) pending decisions,
   * so a PMC running several sites sees them all at a glance.
   */
  async portfolio(userId: string): Promise<PortfolioProject[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'active' },
      include: { project: { include: { org: true } } },
    });
    // archived projects are hidden from the board
    const scoped = memberships.filter((m) => !m.project.archivedAt).map((m) => ({ project: m.project, role: m.role }));

    // Org super-admin reach: owners/admins see every (non-archived) project in their org (as PMC).
    const adminOrgs = await this.prisma.orgMembership.findMany({ where: { userId, role: { in: ['owner', 'admin'] } }, select: { orgId: true } });
    if (adminOrgs.length) {
      const have = new Set(scoped.map((s) => s.project.id));
      const projects = await this.prisma.project.findMany({ where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null }, include: { org: true } });
      for (const p of projects) {
        if (!have.has(p.id)) { scoped.push({ project: p, role: 'pmc' }); have.add(p.id); }
      }
    }

    // No legacy `User.projectId`/`User.role` fallback (org-escalation fix, mirrors
    // AuthService.listMemberships): the portfolio board is built from active memberships
    // and org owner/admin reach only. Falling back to the per-user home fields would put a
    // project card — with pending-decision counts when the stale role is pmc/client — in
    // front of a roster `member` or a removed user. Genuine pre-membership accounts are
    // covered by the `ensure-accounts` membership backfill.

    return Promise.all(
      scoped.map(async ({ project, role }) => {
        const canSeePending = role === 'pmc' || role === 'client';
        // Task 10 (Module 4) — the activity-status rollup + phase count come from the activities query,
        // never a direct `prisma.activity.findMany`/`prisma.phase.count` read.
        const [statusCounts, openReviews, pendingDecisions] = await Promise.all([
          this.activitiesQuery.statusCounts(project.id),
          this.inspections.openInspectionCount(project.id),
          canSeePending ? this.decisions.countPending(project.id) : Promise.resolve(0),
        ]);
        const { total: activityTotal, done, inProgress, blocked, notStarted, phaseCount } = statusCounts;
        return {
          projectId: project.id,
          name: project.name,
          short: project.short,
          stage: project.stage,
          role,
          orgName: project.org?.name ?? null,
          activityTotal,
          done,
          inProgress,
          blocked,
          notStarted,
          donePct: activityTotal ? Math.round((done / activityTotal) * 100) : 0,
          openReviews,
          pendingDecisions,
          phaseCount,
          milestonePct: project.milestonePct,
        };
      }),
    );
  }
}
