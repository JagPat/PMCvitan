import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from './auth';
import { isProduction } from '../config';
import { PROJECT_ACCESS_CODES, type ProjectAccessCode } from '@vitan/shared';

/**
 * #1373: a lost-project 403 carries its machine `code`. The body is Nest's default for a 403 (`message`, `error`,
 * `statusCode`, in that order) plus `code`, so the status, message and key order are as before; a client that ignores `code` sees no
 * change.
 */
function lostProject(message: string, code: ProjectAccessCode): ForbiddenException {
  return new ForbiddenException({ message, error: 'Forbidden', statusCode: 403, code });
}

/**
 * The canonical LIVE authorization for a user on a project (Phase 0 Task 4).
 * A signed, unexpired token is identity — not continuing authority: membership
 * removal, a role change, or archiving the project revokes access on the very
 * next request, without waiting for the 12h token expiry.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** A password reset increments the durable version, invalidating all older
   * named-user JWTs. Legacy tokens without the claim represent version zero. */
  async assertCredentialVersion(user: AuthUser): Promise<void> {
    if (user.worker) return;
    if (!isProduction() && user.sub.startsWith('dev-')) return;
    const current = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { credentialVersion: true },
    });
    if (!current || current.credentialVersion !== (user.credentialVersion ?? 0)) {
      throw new UnauthorizedException('Session expired');
    }
  }

  async authorize(user: AuthUser, projectId: string): Promise<AuthUser> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { orgId: true, archivedAt: true },
    });
    if (!project || project.archivedAt) throw lostProject('Project is unavailable', PROJECT_ACCESS_CODES.unavailable);

    const membership = await this.prisma.membership.findUnique({
      where: { projectId_userId: { projectId, userId: user.sub } },
      select: { role: true, status: true },
    });
    if (membership?.status === 'active') {
      if (membership.role !== user.role) throw lostProject('Project role changed; sign in again', PROJECT_ACCESS_CODES.roleChanged);
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
    throw lostProject('Project access has been removed', PROJECT_ACCESS_CODES.accessRemoved);
  }
}
