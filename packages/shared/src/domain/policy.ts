/**
 * Authorization policy — the single source of truth for "which roles may perform which
 * project action". One map, consumed by both sides so they cannot drift:
 *   • the web UI gates action affordances with `can(action, role)` (e.g. show the
 *     "Acknowledge" button only to roles the server will accept), and
 *   • the API's `@Roles`/`RolesGuard` enforce the same allowlists on the endpoints.
 *
 * Keep these lists identical to the API's `@Roles(...)` decorators. Today the API
 * hard-codes matching literals because `@vitan/shared` is a source-only package the
 * Node runtime can't import; once it's promoted to a built package the API should
 * `@RolesFor(action)` straight from this map and the duplication disappears entirely.
 *
 * Drift this fixes: the drawings "acknowledge" button was gated to contractor|engineer
 * in the UI while the API accepts pmc too — so a PMC saw no button for an action the
 * server allowed. Both now read `ROLE_POLICY['drawing.acknowledge']`.
 */
import type { TokenRole } from './types';

export const ROLE_POLICY = {
  'decision.create': ['pmc'],
  // publish a private draft decision → issue it to the client (the architect's authority)
  'decision.publish': ['pmc'],
  'decision.approve': ['client', 'pmc'],
  // consultants raise change requests to flag a conflict in their discipline (read-mostly otherwise)
  'decision.change': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  // withdraw an open change request — endpoint allowlist; the SERVICE narrows it to the
  // actual requester or the PMC, so the UI must also check requestedById (Phase 1 Task 2)
  'decision.withdrawChange': ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
  'activity.start': ['engineer', 'pmc'],
  'activity.complete': ['engineer', 'pmc'],
  // planning & scheduling — the PMC authors the plan
  'activity.manage': ['pmc'],
  'phase.manage': ['pmc'],
  'node.manage': ['pmc'],
  'inspection.create': ['pmc'],
  'inspection.submit': ['engineer', 'pmc'],
  'inspection.decide': ['pmc'],
  'dailyLog.start': ['engineer', 'pmc'],
  'dailyLog.addMaterial': ['engineer', 'pmc'],
  'dailyLog.flagMismatch': ['engineer', 'pmc'],
  'dailyLog.submit': ['engineer', 'pmc'],
  'media.upload': ['pmc', 'engineer'],
  'media.delete': ['pmc', 'engineer'],
  // re-file a photo onto a location-tree node (or unfile) — same authority as upload
  'media.file': ['pmc', 'engineer'],
  'drawing.issue': ['pmc'],
  // publish a private draft drawing → issue it to the build team
  'drawing.publish': ['pmc'],
  'drawing.presign': ['pmc'],
  'drawing.acknowledge': ['pmc', 'engineer', 'contractor'],
  'drawing.delete': ['pmc'],
  // re-file a drawing onto a location-tree node (or unfile) — architect controls placement
  'drawing.file': ['pmc'],
  // Real account holders only — a `worker` device token has no User row (see the API's
  // POST /orgs gate), so it is intentionally excluded.
  'org.create': ['pmc', 'client', 'engineer', 'contractor'],
  // ── Read surfaces that require a REAL account (a worker device token is excluded,
  // SEC-02 / P1-2). The API GETs derive their allowlist from here too (Phase 2 Task 2),
  // so the whole role-gated surface — reads and writes — has ONE source of truth. The web
  // UI does not currently gate these reads, so `can()` simply isn't called for them.
  'project.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'members.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
  'companies.read': ['pmc', 'client', 'engineer', 'contractor', 'consultant'],
} as const satisfies Record<string, readonly TokenRole[]>;

/** A permissioned project action, e.g. `'drawing.acknowledge'`. */
export type PolicyAction = keyof typeof ROLE_POLICY;

/** True when `role` is permitted to perform `action`. Mirrors the server's allowlist. */
export function can(action: PolicyAction, role: TokenRole): boolean {
  return (ROLE_POLICY[action] as readonly TokenRole[]).includes(role);
}

/** The roles permitted to perform `action` (readonly). */
export function rolesFor(action: PolicyAction): readonly TokenRole[] {
  return ROLE_POLICY[action];
}
