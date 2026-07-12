import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from './auth';

/**
 * The canonical LIVE authorization for a user on a project (Phase 0 Task 4).
 * A signed, unexpired token is identity — not continuing authority: membership
 * removal, a role change, or archiving the project revokes access on the very
 * next request, without waiting for the 12h token expiry.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(user: AuthUser, projectId: string): Promise<AuthUser> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { orgId: true, archivedAt: true },
    });
    if (!project || project.archivedAt) throw new ForbiddenException('Project is unavailable');

    const membership = await this.prisma.membership.findUnique({
      where: { projectId_userId: { projectId, userId: user.sub } },
      select: { role: true, status: true },
    });
    if (membership?.status === 'active') {
      if (membership.role !== user.role) throw new ForbiddenException('Project role changed; sign in again');
      return user;
    }

    // Org super-admin: an owner/admin of the project's org operates it as PMC
    // even without an explicit membership (see ORGS.md) — verified LIVE too.
    const orgMembership = project.orgId
      ? await this.prisma.orgMembership.findUnique({
          where: { orgId_userId: { orgId: project.orgId, userId: user.sub } },
          select: { role: true },
        })
      : null;
    if (user.role === 'pmc' && (orgMembership?.role === 'owner' || orgMembership?.role === 'admin')) return user;
    throw new ForbiddenException('Project access has been removed');
  }
}
