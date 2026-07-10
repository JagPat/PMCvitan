import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser, Role } from './auth';

export const ROLES_KEY = 'roles';
export const PUBLIC_KEY = 'route:public';
export const ANY_ROLE_KEY = 'route:any-role';

/**
 * Declarative authorization markers, enforced at CI time by `route-policy.test.ts`
 * (the route-walk test asserts every mutating route declares exactly one authz intent:
 * `@Roles`, `@AllowAnyRole`, or `@Public`). They are documentation the test makes
 * binding — no runtime guard reads them, so adding one never changes behavior.
 */

/** This route needs no authentication (sign-in, public file serve, VAPID key). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/**
 * This mutating route is intentionally NOT restricted by project role — any
 * authenticated caller may reach it and finer authorization (if any) happens in the
 * service layer. `reason` documents why (e.g. an org-role check in the service, or a
 * caller acting only on their own resource). Making the exemption explicit is what lets
 * the route-walk test treat an *un*-marked mutation as a bug.
 */
export const AllowAnyRole = (reason: string): MethodDecorator & ClassDecorator => SetMetadata(ANY_ROLE_KEY, reason);

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
