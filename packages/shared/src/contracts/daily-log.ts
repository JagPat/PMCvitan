/**
 * Phase 2 Task 10 — the DAILY-LOG module contract (shared, runtime-importable on both sides).
 *
 * The second fully-extracted backend module is reached ONLY through this contract (its commands +
 * queries) and its published events. This module defines the SHAPE of that contract — the command
 * inputs and the query inputs/outputs — as plain data types both the API and the web import. The API
 * validates the command inputs at its request boundary (the Zod schemas in `apps/api/src/contracts.ts`
 * implement these types); the module's `DailyLogService`/`DailyLogQueryService` implement the
 * command/query behavior; the boundary check proves no other module reads its persistence directly.
 */

/** The daily-log module's state-changing commands (must equal the manifest `commands`). */
export const DAILY_LOG_COMMANDS = [
  'daily-log.start',
  'daily-log.addMaterial',
  'daily-log.flagMismatch',
  // Phase 3 Task 5 (§E) — close ONE mismatch observation with an explicit, audited resolution
  // (pilot-gated; the observation row is never edited; the activity's block clears only when
  // no unresolved mismatch remains)
  'daily-log.resolveMismatch',
  'daily-log.submit',
] as const;
export type DailyLogCommand = (typeof DAILY_LOG_COMMANDS)[number];

/** The daily-log module's read queries (must equal the manifest `queries`). */
export const DAILY_LOG_QUERIES = [
  'daily-log.snapshotSlice',
  // Task 10 — the same slice served from the module's rebuildable projection (per-project read model)
  'daily-log.projectionSlice',
  'daily-log.existsInProject',
  'daily-log.resolveRef',
] as const;
export type DailyLogQuery = (typeof DAILY_LOG_QUERIES)[number];

// ── Command inputs (the request bodies; the API's Zod schemas validate to exactly these) ──────────

/** `daily-log.start` — open (or reopen) today's daily log. No request body: the server derives the
 *  civil day from its clock. */
export type StartDailyLogInput = Record<string, never>;

/** `daily-log.addMaterial` — record a material delivered/staged on site (post-validation shape). */
export interface AddMaterialInput {
  readonly name: string;
  readonly qty: string;
  /** free-text zone; defaults to '' when omitted. */
  readonly zone: string;
  readonly decisionId?: string;
  /** swatch key; defaults to 'tile' when omitted. */
  readonly swatch: string;
  /** the location-tree node where the material was delivered/staged. */
  readonly nodeId?: string;
}

/** `daily-log.flagMismatch` — flag a delivered material as NOT matching its approved decision (blocks
 *  the linked activity in one atomic workflow with the activities module). */
export interface FlagMismatchInput {
  readonly decisionId: string;
}

/** `daily-log.resolveMismatch` (Phase 3 Task 5, §E) — close ONE `matched: false` observation with an
 *  explicit disposition + reason. The observation row is NEVER edited; `siteMaterialId` is UNIQUE on
 *  the resolution table, so a second resolution of the same observation is refused. */
export interface ResolveMismatchInput {
  readonly siteMaterialId: string;
  /** the disposition, e.g. 'returned-and-replaced', 'accepted-by-client' — short, free-form. */
  readonly resolution: string;
  readonly reason: string;
}

/** The `mismatch.resolved` event payload (§G catalog: siteMaterialId, resolution, authority). */
export interface MismatchResolvedPayload {
  readonly siteMaterialId: string;
  readonly resolution: string;
  readonly authority: string; // the resolving user's id — real attribution
}

/** `daily-log.submit` — submit the day's log with attendance, progress and the crew roster. */
export interface SubmitDailyLogInput {
  readonly checkedIn: boolean;
  readonly checkinTime: string | null;
  readonly progress: number;
  readonly crew: readonly { readonly trade: string; readonly count: number }[];
}

/**
 * Every daily-log command is carried with the Task-5 idempotency key (the same key + payload replays
 * the result; a different payload for the same key is a 409). Transport-wise the API reads the key
 * from the `Idempotency-Key` header; this envelope is the logical contract both sides model.
 */
export interface DailyLogCommandEnvelope<TInput> {
  readonly idempotencyKey?: string;
  readonly input: TInput;
}

// ── Query inputs + outputs ────────────────────────────────────────────────────────────────────────

/** One crew row on a daily log. */
export interface CrewRowView {
  readonly trade: string;
  readonly count: number;
}

/** A material on the current day's log (the daily-log-inline shape). */
export interface DailyLogMaterialView {
  readonly name: string;
  readonly decisionId: string;
  readonly qty: string;
  readonly zone: string;
  readonly matched: boolean;
  readonly swatch: string;
  readonly photo: boolean;
}

/** The daily-log-OWNED core of the DailyLog slice — the module's view WITHOUT the media-sourced
 *  `photos`, which the snapshot composes (media is a separate module). */
export interface DailyLogCoreView {
  readonly date: string;
  readonly logDate: string | null;
  readonly checkedIn: boolean;
  readonly checkinTime: string | null;
  readonly submitted: boolean;
  readonly progress: number;
  readonly crew: readonly CrewRowView[];
  readonly materials: readonly DailyLogMaterialView[];
}

/** A project-wide site material (for the Site Map's "materials here"). */
export interface SiteMaterialView {
  readonly id: string;
  readonly name: string;
  readonly qty: string;
  readonly zone: string;
  readonly matched: boolean;
  readonly swatch: string;
  readonly decisionId?: string;
  readonly nodeId?: string;
}

/** `daily-log.snapshotSlice` — the latest daily-log core + every project material. */
export interface DailyLogSnapshotQuery {
  readonly projectId: string;
}
export interface DailyLogSnapshotResult {
  readonly dailyLog: DailyLogCoreView | null;
  readonly materials: readonly SiteMaterialView[];
}

/**
 * `GET …/daily-log` — the MODULE-OWNED read the frontend fetches under XOR read-ownership (Task 10).
 * The COMPLETE HTTP result, defined ONCE here so the API's `DailyLogQueryService.moduleDailyLog` and
 * the web gateway model the SAME shape (no drifting duplicate). It is the {@link DailyLogSnapshotResult}
 * slice (the photo-less {@link DailyLogCoreView} + project materials) PLUS two observability fields:
 *  • `source` — which path served it: the rebuildable projection, or the live canonical fallback.
 *  • `generation` — the served projection generation, non-null ONLY when served from a safe, caught-up
 *    projection (finding 1); `null` on the live-fallback path.
 * The `swatch` fields are open strings (the wire truth); the web narrows them to its `SwatchKey` set at
 * the store boundary.
 */
export interface DailyLogModuleResult {
  readonly dailyLog: DailyLogCoreView | null;
  readonly materials: readonly SiteMaterialView[];
  readonly source: 'projection' | 'live';
  readonly generation: number | null;
}

/** `daily-log.existsInProject` / `daily-log.resolveRef` — validate a daily-log reference belongs to a project. */
export interface DailyLogRefQuery {
  readonly projectId: string;
  readonly dailyLogId: string;
}
