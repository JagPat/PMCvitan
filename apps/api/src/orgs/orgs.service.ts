import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { nextSeqId } from '../domain/ids';
import { ddMmmYyyy } from '../domain/dates';
import { lockUserCredential } from '../common/credential-lock';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import { NodeInitParticipant } from '../nodes/node-init.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { InspectionParticipant } from '../inspections/inspection.participant';
import type { AuthUser } from '../common/auth';
import { modulePayloadSchema, moduleSelectionSchema, type AddOrgMemberInput, type CorrectInvitationEmailInput, type CreateModuleInput, type CreateOrgInput, type CreateProjectInput, type CreateTemplateInput, type ModulePayload, type UpdateOrgMemberInput, type UpdateProjectInput } from '../contracts';
import { z } from 'zod';

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

    const membership = await this.prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId, userId: user.id } },
      update: { role: input.role },
      create: { orgId, userId: user.id, role: input.role },
    });
    return { userId: user.id, name: user.name, email: user.email, phone: user.phone, orgRole: membership.role, credentialState: user.passwordHash ? 'active' : 'not_set' };
  }

  /**
   * Change an org member's role (owner/admin/member). Owner only. Refuses to strip
   * the last owner — the org must always have someone who can manage the roster.
   */
  async updateOrgMemberRole(orgId: string, callerId: string, userId: string, input: UpdateOrgMemberInput): Promise<OrgMemberDto> {
    if ((await this.orgRole(orgId, callerId)) !== 'owner') throw new ForbiddenException('Only an org owner can change roles');
    const existing = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } }, include: { user: true } });
    if (!existing) throw new NotFoundException('Not a member of this org');
    if (existing.role === 'owner' && input.role !== 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw new BadRequestException('The org must keep at least one owner');
    }
    const membership = await this.prisma.orgMembership.update({ where: { orgId_userId: { orgId, userId } }, data: { role: input.role } });
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
    if (existing.role === 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw new BadRequestException('The org must keep at least one owner');
    }
    await this.prisma.orgMembership.delete({ where: { orgId_userId: { orgId, userId } } });
    return { ok: true };
  }

  /** Create a project under an org (owner/admin only); enrol the creator as PMC. */
  async createProject(orgId: string, userId: string, input: CreateProjectInput): Promise<{ id: string; name: string; short: string }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an org owner or admin can create projects');
    }
    // Resolve + validate EVERY starting-structure source before persisting anything — a
    // rejected template, stale module pick, or foreign source must fail the whole request,
    // never strand an orphaned blank project + membership (adversarial review, F1).
    const selections = [
      ...(input.templateId ? await this.templateSelections(orgId, input.templateId) : []),
      ...(input.modules ?? []),
    ];
    if (selections.length) await this.assertPlaceable(orgId, selections);
    if (input.structureFrom) await this.assertSourceProject(orgId, input.structureFrom);

    const id = `${slugify(input.short)}-${randomUUID().slice(0, 4)}`;
    // Real civil dates (Task 6): a new project's schedule anchor defaults to TODAY in
    // its time zone; templates/copies convert their relative offsets against it.
    const timeZone = input.timeZone ?? 'Asia/Kolkata';
    const scheduleStartDate = input.scheduleStartDate ?? this.clock.today(timeZone);
    const actor = await resolveActor(this.prisma, { sub: userId, role, projectId: id } as unknown as AuthUser);
    // The project row, its PMC membership and the project.created event commit together — the
    // AFTER INSERT trigger also creates the ProjectEventStream row in this same transaction, so
    // a project can never exist without its tenant, its PMC or its event counter. (Copying
    // structure / instantiating modules keep their own transactions after this core commit.)
    const project = await this.prisma.$transaction(async (tx) => {
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
      await emitEvent(tx, { projectId: id, actor, eventType: 'project.created', entityType: 'Project', entityId: id, payload: { name: input.name } });
      return p;
    });
    // Templates Slice 1: optionally start from another project's structure instead of a blank slate
    if (input.structureFrom) await this.copyStructure(orgId, input.structureFrom, id, userId);
    // Templates Slice 2+3: compose from org modules — a named preset expands first, then any
    // à-la-carte picks; all sources union (structureFrom included).
    if (selections.length) await this.instantiateModules(orgId, id, userId, selections);
    return { id: project.id, name: project.name, short: project.short };
  }

  /** The Slice-1 source guard: a structure source must be an unarchived project in this org. */
  private async assertSourceProject(orgId: string, sourceId: string): Promise<void> {
    const source = await this.prisma.project.findUnique({ where: { id: sourceId }, select: { orgId: true, archivedAt: true } });
    if (!source || source.orgId !== orgId || source.archivedAt) throw new NotFoundException('Source project not found in this org');
  }

  /** Every selection's module must be this org's, unarchived, and placeable at create time —
   *  checked BEFORE the project row exists, so a stale pick can never strand an orphan. */
  private async assertPlaceable(orgId: string, selections: { moduleId: string }[]): Promise<void> {
    const rows = await this.prisma.templateModule.findMany({
      where: { id: { in: selections.map((s) => s.moduleId) } },
      select: { id: true, orgId: true, archivedAt: true, anchorKind: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const s of selections) {
      const m = byId.get(s.moduleId);
      if (!m || m.orgId !== orgId || m.archivedAt) throw new NotFoundException('Module not found in this org');
      if (m.anchorKind === 'room') {
        throw new BadRequestException(`"${m.name}" anchors to a room — element modules can't be placed at project creation yet`);
      }
    }
  }

  // ── Templates Slice 3 — named presets (docs/TEMPLATES.md) ───────────────────

  /** A preset's module selection, ready for instantiation (org-checked, defaults filled). */
  private async templateSelections(orgId: string, templateId: string) {
    const t = await this.prisma.projectTemplate.findUnique({ where: { id: templateId } });
    if (!t || t.orgId !== orgId || t.archivedAt) throw new NotFoundException('Template not found in this org');
    return z.array(moduleSelectionSchema).parse(t.items ?? []);
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
        // a preset exists only to be expanded at create-project, which can't place element
        // modules yet — refuse at save time rather than minting an unusable preset (review F3)
        if (m.anchorKind === 'room') {
          throw new BadRequestException(`"${m.name}" anchors to a room — element modules can't join a preset yet`);
        }
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
    await this.assertSourceProject(orgId, sourceId);

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

    const inspections = await this.prisma.inspection.findMany({
      where: fromNodeId ? { projectId: sourceId, kind: 'checklist', nodeId: { in: [...nodeIds] } } : { projectId: sourceId, kind: 'checklist' },
      include: { items: { orderBy: { order: 'asc' } } },
    });
    // phases + planned activities only travel for a whole-project extraction — a space
    // module is spatial; the schedule shape belongs to schedule/whole-project modules
    const [phases, activities] = fromNodeId
      ? [[], []]
      : await Promise.all([
          this.prisma.phase.findMany({ where: { projectId: sourceId }, orderBy: { order: 'asc' } }),
          this.prisma.activity.findMany({ where: { projectId: sourceId }, orderBy: { order: 'asc' } }),
        ]);
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
        items: i.items.map((it) => it.name),
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
    orgId: string,
    targetId: string,
    userId: string,
    selections: { moduleId: string; count: number; underZone?: string }[],
  ): Promise<void> {
    // Task 6: same offset->date conversion as copyStructure (module payload ints are relative)
    const target = await this.prisma.project.findUniqueOrThrow({ where: { id: targetId }, select: { scheduleStartDate: true } });
    const targetAnchor = toIsoCivilDate(target.scheduleStartDate);
    const datesFor = (start: number, end: number) =>
      targetAnchor
        ? { plannedStartDate: fromIsoCivilDate(addCivilDays(targetAnchor, start)), plannedEndDate: fromIsoCivilDate(addCivilDays(targetAnchor, end)) }
        : {};
    const [allActIds, allInspIds] = await Promise.all([
      this.prisma.activity.findMany({ select: { id: true } }),
      this.prisma.inspection.findMany({ select: { id: true } }),
    ]);
    const actIds = allActIds.map((a) => a.id);
    const newActId = (): string => { const id = nextSeqId('ACT-', actIds); actIds.push(id); return id; };
    const inspIds = allInspIds.map((i) => i.id);
    const newInspId = (): string => { const id = nextSeqId('INSP-', inspIds); inspIds.push(id); return id; };
    const today = ddMmmYyyy(new Date());

    await this.prisma.$transaction(async (tx) => {
      // zones already created into the target (by structureFrom, or a prior selection) — by name
      const zoneIdByName = new Map<string, string>();
      for (const z of await tx.projectNode.findMany({ where: { projectId: targetId, kind: 'zone' } })) {
        zoneIdByName.set(z.name, z.id);
      }
      const zoneFor = async (name: string): Promise<string> => {
        const existing = zoneIdByName.get(name);
        if (existing) return existing;
        const created = await this.nodeInit.createForInit(tx, {
          data: { projectId: targetId, parentId: null, name, kind: 'zone', order: zoneIdByName.size, publishedAt: null, authorId: userId },
        });
        zoneIdByName.set(name, created.id);
        return created.id;
      };
      const phaseIdByName = new Map<string, string>();

      for (const sel of selections) {
        const row = await this.prisma.templateModule.findUnique({ where: { id: sel.moduleId } });
        if (!row || row.orgId !== orgId || row.archivedAt) throw new NotFoundException('Module not found in this org');
        const payload = modulePayloadSchema.parse(row.payload ?? {});
        if (row.anchorKind === 'room') {
          throw new BadRequestException(`"${row.name}" anchors to a room — element modules can't be placed at project creation yet`);
        }

        for (let copy = 1; copy <= sel.count; copy++) {
          const suffix = sel.count > 1 ? ` ${copy}` : '';
          // root nodes graft to the top level (zone roots) or under the chosen zone (room roots)
          const rootParentId = row.anchorKind === 'zone' ? await zoneFor(sel.underZone ?? 'Ground Floor') : null;

          const keyToId = new Map<string, string>();
          let remaining = [...payload.nodes];
          while (remaining.length) {
            const batch = remaining.filter((n) => !n.parentKey || keyToId.has(n.parentKey));
            if (batch.length === 0) break; // malformed payload parentage — skip rather than loop
            for (const n of batch) {
              const created = await this.nodeInit.createForInit(tx, {
                data: {
                  projectId: targetId,
                  parentId: n.parentKey ? (keyToId.get(n.parentKey) ?? null) : rootParentId,
                  name: n.parentKey ? n.name : `${n.name}${suffix}`,
                  kind: n.kind,
                  order: n.order,
                  publishedAt: null,
                  authorId: userId,
                },
              });
              keyToId.set(n.key, created.id);
              if (n.kind === 'zone' && !n.parentKey) zoneIdByName.set(`${n.name}${suffix}`, created.id);
            }
            remaining = remaining.filter((n) => !keyToId.has(n.key));
          }

          for (const p of payload.phases) {
            if (phaseIdByName.has(p.name)) continue; // phases merge by name across modules/copies
            const created = await this.activityInit.createPhaseForInit(tx, {
              data: { projectId: targetId, name: p.name, order: p.order, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd, ...datesFor(p.plannedStart, p.plannedEnd) },
            });
            phaseIdByName.set(p.name, created.id);
          }

          for (const a of payload.activities) {
            await this.activityInit.createForInit(tx, {
              data: {
                id: newActId(),
                projectId: targetId,
                name: `${a.name}${suffix}`,
                zone: a.zone,
                status: 'not_started',
                plannedStart: a.plannedStart,
                plannedEnd: a.plannedEnd,
                ...datesFor(a.plannedStart, a.plannedEnd),
                gateMaterial: 'wait',
                gateTeam: 'wait',
                gateInspection: 'wait',
                decisionId: null,
                phaseId: a.phaseName ? (phaseIdByName.get(a.phaseName) ?? null) : null,
                nodeId: a.nodeKey ? (keyToId.get(a.nodeKey) ?? null) : null,
                order: a.order,
              },
            });
          }

          for (const i of payload.inspections) {
            await this.inspectionInit.createForInit(tx, {
              data: {
                id: newInspId(),
                projectId: targetId,
                kind: 'checklist',
                title: `${i.title}${suffix}`,
                zone: i.zone,
                by: null,
                date: today,
                submitted: false,
                decided: false,
                nodeId: i.nodeKey ? (keyToId.get(i.nodeKey) ?? null) : null,
                items: { create: i.items.map((name, idx) => ({ name, order: idx })) },
              },
            });
          }
        }
      }
    });
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
  private async copyStructure(orgId: string, sourceId: string, targetId: string, userId: string): Promise<void> {
    await this.assertSourceProject(orgId, sourceId);
    // Task 6: legacy ints ARE relative offsets; the target's real dates come from ITS
    // schedule anchor + offset — absolute source dates are never copied across projects.
    const target = await this.prisma.project.findUniqueOrThrow({ where: { id: targetId }, select: { scheduleStartDate: true } });
    const targetAnchor = toIsoCivilDate(target.scheduleStartDate);
    const datesFor = (start: number, end: number) =>
      targetAnchor
        ? { plannedStartDate: fromIsoCivilDate(addCivilDays(targetAnchor, start)), plannedEndDate: fromIsoCivilDate(addCivilDays(targetAnchor, end)) }
        : {};

    const [nodes, phases, activities, inspections, allActIds, allInspIds] = await Promise.all([
      this.prisma.projectNode.findMany({ where: { projectId: sourceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.phase.findMany({ where: { projectId: sourceId }, orderBy: { order: 'asc' } }),
      this.prisma.activity.findMany({ where: { projectId: sourceId }, orderBy: { order: 'asc' } }),
      this.prisma.inspection.findMany({ where: { projectId: sourceId, kind: 'checklist' }, include: { items: { orderBy: { order: 'asc' } } } }),
      this.prisma.activity.findMany({ select: { id: true } }), // display ids are global (DATA-01) — allocate against ALL rows
      this.prisma.inspection.findMany({ select: { id: true } }),
    ]);

    // Display ids (ACT-###/INSP-###) allocated up-front against the global sequence.
    const actIds = allActIds.map((a) => a.id);
    const newActId = (): string => { const id = nextSeqId('ACT-', actIds); actIds.push(id); return id; };
    const inspIds = allInspIds.map((i) => i.id);
    const newInspId = (): string => { const id = nextSeqId('INSP-', inspIds); inspIds.push(id); return id; };
    const stripGate = (g: string): string => (g === 'na' ? 'na' : 'wait');
    const today = ddMmmYyyy(new Date());

    const nodeIdMap = new Map<string, string>();
    const phaseIdMap = new Map<string, string>();

    await this.prisma.$transaction(async (tx) => {
      // Nodes parents-first so the parent FK always resolves; the copy lands as one draft
      // branch (publish cascades reveal it zone-by-zone as the PMC firms it up).
      let remaining = [...nodes];
      while (remaining.length) {
        const batch = remaining.filter((n) => !n.parentId || nodeIdMap.has(n.parentId));
        if (batch.length === 0) break; // orphaned rows (shouldn't happen) — skip, never loop forever
        for (const n of batch) {
          const created = await this.nodeInit.createForInit(tx, {
            data: {
              projectId: targetId,
              parentId: n.parentId ? (nodeIdMap.get(n.parentId) ?? null) : null,
              name: n.name,
              kind: n.kind,
              order: n.order,
              publishedAt: null, // the skeleton arrives as a private draft
              authorId: userId,
            },
          });
          nodeIdMap.set(n.id, created.id);
        }
        remaining = remaining.filter((n) => !nodeIdMap.has(n.id));
      }

      for (const p of phases) {
        const created = await this.activityInit.createPhaseForInit(tx, {
          data: { projectId: targetId, name: p.name, order: p.order, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd, ...datesFor(p.plannedStart, p.plannedEnd) },
        });
        phaseIdMap.set(p.id, created.id);
      }

      for (const a of activities) {
        await this.activityInit.createForInit(tx, {
          data: {
            id: newActId(),
            projectId: targetId,
            name: a.name,
            zone: a.zone,
            status: 'not_started',
            plannedStart: a.plannedStart,
            plannedEnd: a.plannedEnd,
            ...datesFor(a.plannedStart, a.plannedEnd),
            actualStart: null,
            actualEnd: null,
            block: null,
            gateMaterial: stripGate(a.gateMaterial) as never,
            gateTeam: stripGate(a.gateTeam) as never,
            gateInspection: stripGate(a.gateInspection) as never,
            decisionId: null, // decisions aren't copied in Slice 1 — the D-gate derives as 'na'
            phaseId: a.phaseId ? (phaseIdMap.get(a.phaseId) ?? null) : null,
            nodeId: a.nodeId ? (nodeIdMap.get(a.nodeId) ?? null) : null,
            order: a.order,
          },
        });
      }

      for (const i of inspections) {
        await this.inspectionInit.createForInit(tx, {
          data: {
            id: newInspId(),
            projectId: targetId,
            kind: 'checklist',
            title: i.title,
            zone: i.zone,
            by: null,
            date: today,
            submitted: false,
            decided: false,
            nodeId: i.nodeId ? (nodeIdMap.get(i.nodeId) ?? null) : null,
            items: { create: i.items.map((it, idx) => ({ name: it.name, order: idx })) },
          },
        });
      }
    });
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
      await emitEvent(tx, { projectId: pid, actor, eventType: 'project.updated', entityType: 'Project', entityId: pid });
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
      await emitEvent(tx, { projectId, actor, eventType: 'project.archived', entityType: 'Project', entityId: projectId });
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
      await emitEvent(tx, { projectId, actor, eventType: 'project.restored', entityType: 'Project', entityId: projectId });
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
        const [activities, openReviews, pendingDecisions, phaseCount] = await Promise.all([
          this.prisma.activity.findMany({ where: { projectId: project.id }, select: { status: true } }),
          this.prisma.inspection.count({ where: { projectId: project.id, submitted: true, decided: false } }),
          canSeePending ? this.prisma.decision.count({ where: { projectId: project.id, status: 'pending' } }) : Promise.resolve(0),
          this.prisma.phase.count({ where: { projectId: project.id } }),
        ]);
        const done = activities.filter((a) => a.status === 'done').length;
        const inProgress = activities.filter((a) => a.status === 'in_progress').length;
        const blocked = activities.filter((a) => a.status === 'blocked').length;
        const notStarted = activities.filter((a) => a.status === 'not_started').length;
        return {
          projectId: project.id,
          name: project.name,
          short: project.short,
          stage: project.stage,
          role,
          orgName: project.org?.name ?? null,
          activityTotal: activities.length,
          done,
          inProgress,
          blocked,
          notStarted,
          donePct: activities.length ? Math.round((done / activities.length) * 100) : 0,
          openReviews,
          pendingDecisions,
          phaseCount,
          milestonePct: project.milestonePct,
        };
      }),
    );
  }
}
