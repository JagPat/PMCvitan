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
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true; // no @Roles → not role-restricted
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException('Your role is not permitted to perform this action');
    }
    return true;
  }
}
