import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ProjectAccessService } from './project-access.service';

/**
 * Marks routes that authorize by IDENTITY, not project access: the /me discovery
 * reads and org administration, whose services check LIVE org-membership rows
 * themselves. Everything else — including routes WITHOUT a `:projectId` param,
 * like the global media/drawing deletes — is live-authorized against the token's
 * project on every request (Codex gate finding 2).
 */
export const IDENTITY_SCOPED = 'auth:identityScoped';
export const IdentityScoped = () => SetMetadata(IDENTITY_SCOPED, true);

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
    private readonly reflector: Reflector,
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
    // LIVE authorization on EVERY guarded route (finding 2): a route without a
    // `:projectId` param (global-scoped deletes) is authorized against the
    // token's own project — a removed member's unexpired token must not retain
    // destructive access anywhere. Identity-scoped routes (/me, org admin) opt
    // out because their services check live org/membership rows themselves.
    const identityScoped = this.reflector.getAllAndOverride<boolean>(IDENTITY_SCOPED, [ctx.getHandler(), ctx.getClass()]);
    req.user = identityScoped ? user : await this.projectAccess.authorize(user, routeProject ?? user.projectId);
    return true;
  }
}

/** Injects the authenticated user (set by JwtGuard) into a handler param. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
