import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ProjectAccessService } from './project-access.service';

export type Role = 'pmc' | 'client' | 'engineer' | 'contractor' | 'consultant' | 'worker';

export interface AuthUser {
  sub: string;
  role: Role;
  projectId: string;
  orgId?: string;
}

/**
 * Verifies the Bearer token, then enforces LIVE project access (Phase 0 Task 4).
 * Tenancy: a token is scoped to one project — a route carrying a `:projectId`
 * param that doesn't match the token's project is rejected, so a valid token for
 * project A can't touch project B. Beyond the signature, `:projectId` routes
 * re-check the Membership/Org tables on EVERY request, so removing a member,
 * changing their role, or archiving the project revokes access immediately —
 * an unexpired token alone is not continuing authority. Org routes (`:orgId` /
 * `:pid`) keep their existing org-authorization path in OrgsService.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    let user: AuthUser;
    try {
      user = this.jwt.verify<AuthUser>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const routeProject: string | undefined = req.params?.projectId;
    if (routeProject && routeProject !== user.projectId) {
      throw new ForbiddenException('Token is not scoped to this project');
    }
    req.user = routeProject ? await this.projectAccess.authorize(user, routeProject) : user;
    return true;
  }
}

/** Injects the authenticated user (set by JwtGuard) into a handler param. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
