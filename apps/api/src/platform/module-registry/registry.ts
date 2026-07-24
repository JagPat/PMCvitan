import { enabledModules, modelOwnership, validateRegistry, type ModuleManifest, type RegistryValidationError } from '@vitan/shared';
import { decisionsManifest } from '../../decisions/decisions.manifest';
import { activitiesManifest } from '../../activities/activities.manifest';
import { inspectionsManifest } from '../../inspections/inspections.manifest';
import { drawingsManifest } from '../../drawings/drawings.manifest';
import { dailyLogManifest } from '../../daily-log/daily-log.manifest';
import { nodesManifest } from '../../nodes/nodes.manifest';
import { mediaManifest } from '../../media/media.manifest';
import { orgsManifest } from '../../orgs/orgs.manifest';
import { authManifest } from '../../auth/auth.manifest';
import { platformManifest } from '../platform.manifest';
import { procurementManifest } from '../../procurement/procurement.manifest';
import { inventoryManifest } from '../../inventory/inventory.manifest';
import { labourManifest } from '../../labour/labour.manifest';

/**
 * Phase 2 Task 7 — the compiled module registry.
 *
 * Every module contributes ONE manifest; the registry is the whole compiled set. It is
 * validated at API startup ({@link ModuleRegistryService}) AND in CI
 * (`module-registry.test.ts` + `boundary.test.ts`) so a boundary can never silently
 * drift. Enablement (finding 7) is "every module in this array" — there is no per-tenant
 * `ModuleInstallation` used as runtime truth.
 */
export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
  decisionsManifest,
  activitiesManifest,
  procurementManifest,
  inventoryManifest,
  labourManifest,
  inspectionsManifest,
  drawingsManifest,
  dailyLogManifest,
  nodesManifest,
  mediaManifest,
  orgsManifest,
  authManifest,
  platformManifest,
];

/** The authoritative RBAC role vocabulary (token roles ∪ org roles) manifests reference. */
export const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'pmc',
  'client',
  'engineer',
  'contractor',
  'consultant',
  'worker',
  'owner',
  'admin',
  'member',
]);

/** Validate the whole compiled registry. Empty ⇒ valid. */
export function validateModuleRegistry(): RegistryValidationError[] {
  return validateRegistry(MODULE_MANIFESTS, KNOWN_ROLES);
}

/** The single enablement source (finding 7): every compiled, registered module. */
export function enabledModuleIds(): string[] {
  return enabledModules(MODULE_MANIFESTS);
}

/** `prisma model -> owning module id` derived from the manifests (used by the boundary check). */
export function moduleModelOwnership(): Map<string, string> {
  return modelOwnership(MODULE_MANIFESTS);
}

/** Module id → manifest, for lookups (e.g. resolving a module's `kind`). */
export const MANIFEST_BY_ID: ReadonlyMap<string, ModuleManifest> = new Map(MODULE_MANIFESTS.map((m) => [m.id, m]));
