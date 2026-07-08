import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import type { CreateOrgInput, CreateProjectInput } from '../contracts';

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

  /** Projects in an org (members only). */
  async listProjects(orgId: string, userId: string): Promise<Array<{ id: string; name: string; short: string; stage: string }>> {
    if (!(await this.orgRole(orgId, userId))) throw new ForbiddenException('Not a member of this org');
    const org = await this.prisma.org.findUnique({ where: { id: orgId }, include: { projects: { orderBy: { createdAt: 'asc' } } } });
    if (!org) throw new NotFoundException('Org not found');
    return org.projects.map((p) => ({ id: p.id, name: p.name, short: p.short, stage: p.stage }));
  }
}
