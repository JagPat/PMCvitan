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
  'decision.approve': ['client', 'pmc'],
  'decision.change': ['pmc', 'client', 'contractor', 'engineer'],
  'activity.start': ['engineer', 'pmc'],
  'activity.complete': ['engineer', 'pmc'],
  'inspection.submit': ['engineer', 'pmc'],
  'inspection.decide': ['pmc'],
  'dailyLog.flagMismatch': ['engineer', 'pmc'],
  'dailyLog.submit': ['engineer', 'pmc'],
  'media.upload': ['pmc', 'engineer'],
  'media.delete': ['pmc', 'engineer'],
  'drawing.issue': ['pmc'],
  'drawing.presign': ['pmc'],
  'drawing.acknowledge': ['pmc', 'engineer', 'contractor'],
  'drawing.delete': ['pmc'],
  // Real account holders only — a `worker` device token has no User row (see the API's
  // POST /orgs gate), so it is intentionally excluded.
  'org.create': ['pmc', 'client', 'engineer', 'contractor'],
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
