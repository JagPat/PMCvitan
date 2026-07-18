/**
 * Phase 2 Task 10 (Module 3) — the INSPECTIONS module contract (shared, runtime-importable on both sides).
 *
 * Stage-wise quality inspections are reached ONLY through this contract (its commands + queries) and the
 * published `inspection.*` events. This module defines the SHAPE of that contract — the command names,
 * the query names, and the module-owned HTTP read result — as plain data both the API and the web import.
 * The API validates the command inputs at its request boundary (the Zod schemas in
 * `apps/api/src/contracts.ts`); the module's `InspectionsService`/`InspectionsQueryService` implement the
 * command/query behavior; the boundary check proves no other module reads its persistence directly.
 *
 * NOTE the atomic activity↔inspection edges stay workflow contracts, not events: a CLOSING inspection's
 * `inspections.decide` writes the activity sign-off/revert THROUGH the activities participant in the SAME
 * transaction, and the closing-inspection CREATE half is this module's `InspectionParticipant` for the
 * activities `complete` workflow — none of that is loosened by this read/idempotency extraction.
 */

import type { Checklist, Review, PlacedInspection } from '../domain/types';

/** The inspections module's state-changing commands (must equal the manifest `commands`). */
export const INSPECTIONS_COMMANDS = [
  'inspections.create',
  'inspections.submit',
  'inspections.decide',
] as const;
export type InspectionsCommand = (typeof INSPECTIONS_COMMANDS)[number];

/** The inspections module's read queries (must equal the manifest `queries`). */
export const INSPECTIONS_QUERIES = [
  'inspections.snapshotSlice',
  // Task 10 — the same slices served from the module's rebuildable projection.
  'inspections.projectionSlice',
  'inspections.existsInProject',
  'inspections.resolveRef',
] as const;
export type InspectionsQuery = (typeof INSPECTIONS_QUERIES)[number];

/**
 * `GET …/inspections` — the MODULE-OWNED read the frontend fetches under XOR read-ownership (Task 10).
 * The COMPLETE HTTP result, defined ONCE here so the API's `InspectionsQueryService.moduleInspections`
 * and the web gateway model the SAME shape (no drifting duplicate). It carries the SAME five role-gated
 * inspection slices the snapshot's inspection keys do — baked per-viewer/role from ONE canonical base:
 *  • `checklist` — the engineer's current field checklist (all roles), evidence as fresh signed paths.
 *  • `reviews` / `review` — the PMC review queue (PMC only; empty/null otherwise). `review` is the
 *    deprecated single (first pending) back-compat field.
 *  • `reinspectionCreated` — PMC only.
 *  • `placedInspections` — the Site-Map placement (pmc/engineer only; empty otherwise).
 * PLUS two observability fields:
 *  • `source` — which path served it: the rebuildable projection, or the live canonical fallback.
 *  • `generation` — the served projection generation, non-null ONLY when served from a safe, caught-up
 *    projection (finding 1); `null` on the live-fallback path.
 */
export interface InspectionsModuleResult {
  readonly checklist: Checklist | null;
  readonly reviews: readonly Review[];
  readonly review: Review | null;
  readonly reinspectionCreated: boolean;
  readonly placedInspections: readonly PlacedInspection[];
  readonly source: 'projection' | 'live';
  readonly generation: number | null;
}

/** `inspections.existsInProject` — validate an inspection reference belongs to a project (the
 *  tenant-ownership check a consumer — e.g. a media evidence upload — runs before storing an
 *  `inspectionId`). */
export interface InspectionRefQuery {
  readonly projectId: string;
  readonly inspectionId: string;
}
