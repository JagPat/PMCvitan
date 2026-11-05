/**
 * Phase 2 Task 10 — the DRAWINGS module contract (shared, runtime-importable on both sides).
 *
 * The controlled-drawing module is reached ONLY through this contract (its commands + queries) and its
 * published `drawing.*` events. This module defines the SHAPE of that contract — the command names, the
 * query names, and the module-owned HTTP read result — as plain data both the API and the web import.
 * The API validates the command inputs at its request boundary (the Zod schemas in
 * `apps/api/src/contracts.ts`); the module's `DrawingsService`/`DrawingsQueryService` implement the
 * command/query behavior; the boundary check proves no other module reads its persistence directly.
 */

import type { Drawing } from '../domain/types';

/** The drawings module's state-changing commands (must equal the manifest `commands`). */
export const DRAWINGS_COMMANDS = [
  'drawings.issue',
  'drawings.publish',
  'drawings.presign',
  'drawings.acknowledge',
  'drawings.setNode',
  'drawings.remove',
] as const;
export type DrawingsCommand = (typeof DRAWINGS_COMMANDS)[number];

/** The drawings module's read queries (must equal the manifest `queries`). */
export const DRAWINGS_QUERIES = [
  'drawings.snapshotSlice',
  // Task 10 — the same register served from the module's rebuildable projection.
  'drawings.projectionSlice',
  'drawings.existsInProject',
  'drawings.resolveRef',
  // #1118 U7a — the project's active Hub link, for the snapshot's project line
  'drawings.hubLink',
] as const;
export type DrawingsQuery = (typeof DRAWINGS_QUERIES)[number];

/**
 * `GET …/drawings` — the MODULE-OWNED read the frontend fetches under XOR read-ownership (Task 10).
 * The COMPLETE HTTP result, defined ONCE here so the API's `DrawingsQueryService.moduleDrawings` and the
 * web gateway model the SAME shape (no drifting duplicate). It is the drawings register (the same
 * per-viewer {@link Drawing} array the snapshot's `drawings` slice carries — draft-author visibility and
 * the viewer's `ackedByMe`/`recipientOfCurrent` baked in) PLUS two observability fields:
 *  • `source` — which path served it: the rebuildable projection, or the live canonical fallback.
 *  • `generation` — the served projection generation, non-null ONLY when served from a safe, caught-up
 *    projection (finding 1); `null` on the live-fallback path.
 */
export interface DrawingsModuleResult {
  readonly drawings: readonly Drawing[];
  readonly source: 'projection' | 'live';
  readonly generation: number | null;
}

/**
 * `drawings.hubLink` — #1118 U7a: the project's active Hub link, from the drawings module's own link events: Hub's
 * project id, the number and name Hub gave it when it was linked, when, and where "Open in Hub" goes (Hub's address
 * while PMC is connected to Hub for the company the link belongs to, else null). Defined here, with the module's
 * contract, so a consumer (the snapshot's project line) depends on the module and never the other way round.
 */
export interface DrawingsHubLink {
  readonly hubProjectId: string;
  readonly number: string | null;
  readonly name: string | null;
  readonly linkedAt: string;
  readonly openUrl: string | null;
}

/** `drawings.existsInProject` / `drawings.resolveRef` — validate a drawing reference belongs to a project. */
export interface DrawingRefQuery {
  readonly projectId: string;
  readonly drawingId: string;
}
