import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type Role = 'pmc' | 'client' | 'engineer' | 'contractor' | 'worker';

export interface AuthUser {
  sub: string;
  role: Role;
  projectId: string;
  orgId?: string;
}

/**
 * Verifies the Bearer token and attaches the decoded user to the request.
 * Tenancy: a token is scoped to one project — a route carrying a `:projectId`
 * param that doesn't match the token's project is rejected, so a valid token for
 * project A can't touch project B. Switching projects requires a fresh token
 * from `POST /auth/switch` (only granted for a project you're a member of).
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
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
    req.user = user;
    return true;
  }
}

/** Injects the authenticated user (set by JwtGuard) into a handler param. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
