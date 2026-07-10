import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtGuard } from './auth';
import { RolesGuard, ROLES_KEY, PUBLIC_KEY, ANY_ROLE_KEY } from './roles';

import { ActivitiesController } from '../activities/activities.controller';
import { PhasesController } from '../activities/phases.controller';
import { AuthController } from '../auth/auth.controller';
import { DailyLogController } from '../daily-log/daily-log.controller';
import { DecisionsController } from '../decisions/decisions.controller';
import { DrawingsController } from '../drawings/drawings.controller';
import { InspectionsController } from '../inspections/inspections.controller';
import { MediaController } from '../media/media.controller';
import { MembersController } from '../orgs/members.controller';
import { CompaniesController } from '../orgs/companies.controller';
import { OrgsController } from '../orgs/orgs.controller';
import { PushController } from '../push/push.controller';
import { ProjectController } from '../snapshot/project.controller';

/**
 * Route-walk policy test — makes role-gating fail closed *by construction*.
 *
 * It reflects over every HTTP handler on every controller and asserts an explicit
 * authorization decision is declared for each mutating route. A new POST/PUT/PATCH/DELETE
 * that forgets `@Roles`, `@AllowAnyRole`, or `@Public` fails CI here rather than shipping
 * unrestricted — which is exactly how the ungated worker-reachable endpoints (drawing ack,
 * media upload, push subscribe) slipped through before. It also catches an inert `@Roles`
 * (present but with no `RolesGuard` in the chain to enforce it).
 */

// Register every controller here. A controller missing from this list is invisible to the
// policy check, so keep it in sync with app.module's `controllers` array.
const CONTROLLERS = [
  ActivitiesController,
  PhasesController,
  AuthController,
  DailyLogController,
  DecisionsController,
  DrawingsController,
  InspectionsController,
  MediaController,
  MembersController,
  CompaniesController,
  OrgsController,
  PushController,
  ProjectController,
];

const MUTATING = new Set([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE]);

interface RouteInfo {
  id: string;
  httpMethod: number;
  isMutating: boolean;
  roles: string[] | undefined;
  isPublic: boolean;
  anyRoleReason: string | undefined;
  hasJwtGuard: boolean;
  hasRolesGuard: boolean;
  handlerKey: string;
}

function guardsOf(target: unknown): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target as object) as unknown[] | undefined) ?? [];
}

function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const Controller of CONTROLLERS) {
    const classGuards = guardsOf(Controller);
    const proto = Controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (httpMethod === undefined) continue; // not a route handler
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
      const guards = [...classGuards, ...guardsOf(handler)];
      routes.push({
        id: `${Controller.name}.${name} [${RequestMethod[httpMethod]} ${path}]`,
        httpMethod,
        isMutating: MUTATING.has(httpMethod),
        roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
        isPublic: Reflect.getMetadata(PUBLIC_KEY, handler) === true,
        anyRoleReason: Reflect.getMetadata(ANY_ROLE_KEY, handler) as string | undefined,
        hasJwtGuard: guards.includes(JwtGuard),
        hasRolesGuard: guards.includes(RolesGuard),
        handlerKey: `${Controller.name}.${name}`,
      });
    }
  }
  return routes;
}

const routes = collectRoutes();

describe('route authorization policy', () => {
  it('discovers the controllers routes (guards against a vacuous pass)', () => {
    // If reflection silently found nothing, every assertion below would pass for free.
    expect(routes.length).toBeGreaterThan(25);
  });

  it('every mutating route declares exactly one authz intent (@Roles | @AllowAnyRole | @Public)', () => {
    const offenders = routes
      .filter((r) => r.isMutating)
      .filter((r) => {
        const declared = [r.roles !== undefined, r.anyRoleReason !== undefined, r.isPublic].filter(Boolean).length;
        return declared !== 1;
      })
      .map((r) => `${r.id} — declared ${[r.roles !== undefined && '@Roles', r.anyRoleReason !== undefined && '@AllowAnyRole', r.isPublic && '@Public'].filter(Boolean).join('+') || 'NOTHING'}`);
    expect(offenders, `Mutating routes must declare exactly one authz intent:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every @Roles route is actually enforced (RolesGuard in its guard chain)', () => {
    const offenders = routes
      .filter((r) => r.roles !== undefined && !r.hasRolesGuard)
      .map((r) => `${r.id} — has @Roles(${r.roles?.join(',')}) but no RolesGuard in chain (metadata is inert)`);
    expect(offenders, `@Roles without RolesGuard is silently unenforced:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every role-restricted or any-role mutation requires authentication (JwtGuard in chain)', () => {
    const offenders = routes
      .filter((r) => (r.roles !== undefined || r.anyRoleReason !== undefined) && !r.hasJwtGuard)
      .map((r) => `${r.id} — role-guarded but no JwtGuard, so req.user is never set`);
    expect(offenders, `Role-guarded routes need JwtGuard first:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no route is both @Public and role-restricted (contradictory intent)', () => {
    const offenders = routes
      .filter((r) => r.isPublic && (r.roles !== undefined || r.anyRoleReason !== undefined))
      .map((r) => `${r.id} — marked @Public but also role-restricted`);
    expect(offenders, `Contradictory authz markers:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * Drift guard for review finding #8. This map MUST stay identical to the canonical
 * `ROLE_POLICY` in `@vitan/shared` (the web derives its UI gating from that map). The API
 * can't import the source-only shared package at runtime, so we pin the values here and a
 * change to any endpoint's `@Roles` fails this test — forcing the shared map to be updated
 * in lockstep. (Once `@vitan/shared` is a built package the API should `@RolesFor(action)`
 * straight from it and this mirror goes away.)
 */
const EXPECTED_ROLES: Record<string, string[]> = {
  'ProjectController.snapshotFor': ['pmc', 'client', 'engineer', 'contractor'], // SEC-02: no worker tokens
  'DecisionsController.create': ['pmc'],
  'DecisionsController.approve': ['client', 'pmc'],
  'DecisionsController.change': ['pmc', 'client', 'contractor', 'engineer'],
  'ActivitiesController.create': ['pmc'],
  'ActivitiesController.update': ['pmc'],
  'ActivitiesController.remove': ['pmc'],
  'ActivitiesController.start': ['engineer', 'pmc'],
  'ActivitiesController.complete': ['engineer', 'pmc'],
  'PhasesController.create': ['pmc'],
  'PhasesController.remove': ['pmc'],
  'InspectionsController.create': ['pmc'],
  'InspectionsController.submit': ['engineer', 'pmc'],
  'InspectionsController.decide': ['pmc'],
  'DailyLogController.start': ['engineer', 'pmc'],
  'DailyLogController.addMaterial': ['engineer', 'pmc'],
  'DailyLogController.flag': ['engineer', 'pmc'],
  'DailyLogController.submit': ['engineer', 'pmc'],
  'MediaController.upload': ['pmc', 'engineer'],
  'MediaController.remove': ['pmc', 'engineer'],
  'DrawingsController.issue': ['pmc'],
  'DrawingsController.presign': ['pmc'],
  'DrawingsController.acknowledge': ['pmc', 'engineer', 'contractor'],
  'DrawingsController.remove': ['pmc'],
  'OrgsController.createOrg': ['pmc', 'client', 'engineer', 'contractor'],
};

describe('role allowlists mirror the shared ROLE_POLICY (finding #8 drift guard)', () => {
  const gated = routes.filter((r) => r.roles !== undefined);

  it('every @Roles endpoint matches its expected allowlist', () => {
    for (const r of gated) {
      const expected = EXPECTED_ROLES[r.handlerKey];
      expect(expected, `No expected allowlist for ${r.handlerKey} — add it here and to @vitan/shared ROLE_POLICY`).toBeDefined();
      expect([...(r.roles ?? [])].sort(), `${r.handlerKey} @Roles drifted from the shared policy`).toEqual([...expected].sort());
    }
  });

  it('every expected allowlist maps to a real gated endpoint (no stale entries)', () => {
    const gatedKeys = new Set(gated.map((r) => r.handlerKey));
    const stale = Object.keys(EXPECTED_ROLES).filter((k) => !gatedKeys.has(k));
    expect(stale, `Expected allowlists with no matching @Roles endpoint:\n${stale.join('\n')}`).toEqual([]);
  });
});
