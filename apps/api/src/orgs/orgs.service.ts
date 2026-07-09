import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import type { CreateOrgInput, CreateProjectInput } from '../contracts';

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

/**
 * Orgs (accounts) and the projects they own — the multi-tenant admin layer.
 * Org owners/admins create projects and are auto-enrolled as their PMC; project
 * memberships are the access grants tokens scope to (see AuthService).
 */
@Injectable()
export class OrgsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Org role of a user, or null if not a member. */
  private async orgRole(orgId: string, userId: string): Promise<string | null> {
    const m = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    return m?.role ?? null;
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

  /** Create a project under an org (owner/admin only); enrol the creator as PMC. */
  async createProject(orgId: string, userId: string, input: CreateProjectInput): Promise<{ id: string; name: string; short: string }> {
    const role = await this.orgRole(orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenException('Only an org owner or admin can create projects');
    }
    const id = `${slugify(input.short)}-${randomUUID().slice(0, 4)}`;
    const project = await this.prisma.project.create({
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
        elapsedPct: 0,
        todayDay: 0,
        milestonePct: 0,
      },
    });
    // the creator runs the project as its PMC
    await this.prisma.membership.create({ data: { projectId: id, userId, role: 'pmc', status: 'active' } });
    return { id: project.id, name: project.name, short: project.short };
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
    await this.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
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
    await this.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    return { ok: true };
  }

  /** Projects in an org (members only). Archived projects are hidden. */
  async listProjects(orgId: string, userId: string): Promise<Array<{ id: string; name: string; short: string; stage: string }>> {
    if (!(await this.orgRole(orgId, userId))) throw new ForbiddenException('Not a member of this org');
    const org = await this.prisma.org.findUnique({ where: { id: orgId }, include: { projects: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } } } });
    if (!org) throw new NotFoundException('Org not found');
    return org.projects.map((p) => ({ id: p.id, name: p.name, short: p.short, stage: p.stage }));
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
    let scoped = memberships.filter((m) => !m.project.archivedAt).map((m) => ({ project: m.project, role: m.role }));

    // Org super-admin reach: owners/admins see every (non-archived) project in their org (as PMC).
    const adminOrgs = await this.prisma.orgMembership.findMany({ where: { userId, role: { in: ['owner', 'admin'] } }, select: { orgId: true } });
    if (adminOrgs.length) {
      const have = new Set(scoped.map((s) => s.project.id));
      const projects = await this.prisma.project.findMany({ where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null }, include: { org: true } });
      for (const p of projects) {
        if (!have.has(p.id)) { scoped.push({ project: p, role: 'pmc' }); have.add(p.id); }
      }
    }

    if (scoped.length === 0) {
      // back-compat: a user provisioned before memberships still has a home project
      const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { project: { include: { org: true } } } });
      if (user) scoped = [{ project: user.project, role: user.role }];
    }

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
