import type { Org, Project } from '@prisma/client';
import type { PrismaService } from '../prisma.service';

/**
 * The projects a user can reach across orgs, with the role they hold on each — ONE definition shared
 * by the cross-project reads (`/me/portfolio`, U3a's `/me/brief`) so they can never disagree on who
 * sees what:
 *  - every ACTIVE project membership, with its role;
 *  - org super-admin reach: an org owner/admin sees every project of that org, as PMC (unless a
 *    membership already places them on it).
 * Archived projects are dropped. There is deliberately NO fallback to the legacy `User.projectId` /
 * `User.role` home fields (the org-escalation fix): a removed user or a roster `member` reaches
 * nothing through them.
 */
export async function projectsInReach(prisma: PrismaService, userId: string): Promise<{ project: Project & { org: Org | null }; role: string }[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'active' },
    include: { project: { include: { org: true } } },
  });
  const scoped = memberships.filter((m) => !m.project.archivedAt).map((m) => ({ project: m.project, role: m.role as string }));

  const adminOrgs = await prisma.orgMembership.findMany({ where: { userId, role: { in: ['owner', 'admin'] } }, select: { orgId: true } });
  if (adminOrgs.length) {
    const have = new Set(scoped.map((s) => s.project.id));
    const projects = await prisma.project.findMany({ where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null }, include: { org: true } });
    for (const p of projects) {
      if (!have.has(p.id)) { scoped.push({ project: p, role: 'pmc' }); have.add(p.id); }
    }
  }
  return scoped;
}
