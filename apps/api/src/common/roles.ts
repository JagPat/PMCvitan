import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser, Role } from './auth';

export const ROLES_KEY = 'roles';

/**
 * Restrict a handler to specific project roles. Runs after JwtGuard (which sets
 * `req.user`), so it reads the verified token's role — a token cannot claim a role
 * it wasn't issued. Handlers without `@Roles(...)` are unrestricted (tenancy still
 * applies via JwtGuard). An org owner/admin operates a project as `pmc`, so `pmc`
 * covers the super-admin case.
 *
 * At least one role is required — `@Roles()` with no args is a compile error, and an
 * explicitly empty allowlist denies everyone (fail closed), so a stray/placeholder
 * decorator can never silently grant access.
 */
export const Roles = (...roles: [Role, ...Role[]]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    // Absent metadata (undefined) → the handler is not role-restricted. An empty array is
    // NOT passthrough: it means `@Roles` was applied with no permitted role, so it falls
    // through to the check below and denies everyone (fail closed).
    if (!roles) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException('Your role is not permitted to perform this action');
    }
    return true;
  }
}
