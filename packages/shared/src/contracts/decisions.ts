/**
 * Phase 2 Task 8 — the DECISIONS module contract (shared, runtime-importable on both sides).
 *
 * The first fully-extracted backend module is reached ONLY through this contract (its commands +
 * queries) and its published events. This module defines the SHAPE of that contract — the command
 * inputs (each carried under a command envelope with the Task-5 idempotency key) and the query
 * inputs/outputs — as plain data types both the API and the web import. The API validates the command
 * inputs at its request boundary (the Zod schemas in `apps/api/src/contracts.ts` implement these
 * types); the module's `DecisionsService`/`DecisionsQueryService` implement the command/query
 * behavior; the boundary check proves no other module reads its persistence directly.
 *
 * The query RESPONSE is the shared {@link Decision} view (re-exported here as `DecisionView`), so the
 * snapshot's decision slice and any future module-owned decision query share one response shape.
 */
import type { Decision, DecisionStatus } from '../domain/types';

/** The decisions module's state-changing commands (must equal the manifest `commands`). */
export const DECISION_COMMANDS = [
  'decisions.create',
  'decisions.publish',
  'decisions.approve',
  'decisions.requestChange',
  'decisions.withdrawChange',
] as const;
export type DecisionCommand = (typeof DECISION_COMMANDS)[number];

/** The decisions module's read queries (must equal the manifest `queries`). */
export const DECISION_QUERIES = [
  'decisions.snapshotSlice',
  // Task 9 — the same decision slice served from the module's rebuildable projection (query-time authz)
  'decisions.projectionSlice',
  'decisions.existsInProject',
  'decisions.resolveRef',
  'decisions.countByNodeIds',
  'decisions.countPending',
] as const;
export type DecisionQuery = (typeof DECISION_QUERIES)[number];

// ── Command inputs (the request bodies; the API's Zod schemas validate to exactly these) ──────────

/** One option offered on a decision (post-validation shape — defaults applied). */
export interface DecisionOptionInput {
  /** A short label; defaults to the material name when omitted. */
  readonly label?: string;
  readonly material: string;
  /** Cost delta in whole rupees (may be negative). */
  readonly delta: number;
  readonly swatch: string;
  readonly photoUrl?: string;
  readonly recommended: boolean;
}

/** `decisions.create` — issue a decision (as a draft, or published in one step). */
export interface CreateDecisionInput {
  readonly title: string;
  readonly nodeId?: string;
  readonly room: string;
  readonly options: readonly DecisionOptionInput[];
  readonly publish: boolean;
}

/** `decisions.approve` — the client chooses an option (locks the decision). */
export interface ApproveDecisionInput {
  readonly optionIndex: number;
}

/** `decisions.requestChange` — reopen a locked decision with a reason + impacts. */
export interface RequestDecisionChangeInput {
  readonly reason: string;
  readonly costImpact: number;
  readonly timeImpactDays: number;
}

/** `decisions.publish` and `decisions.withdrawChange` carry no request body — the decision id comes
 *  from the route. Their input is empty. */
export type EmptyCommandInput = Record<string, never>;

/**
 * Every decision command is carried with the Task-5 idempotency key (the same key + payload replays
 * the result; a different payload for the same key is a 409). Transport-wise the API reads the key
 * from the `Idempotency-Key` header; this envelope is the logical contract both sides model.
 */
export interface DecisionCommandEnvelope<TInput> {
  readonly idempotencyKey?: string;
  readonly input: TInput;
}

// ── Query inputs + outputs ────────────────────────────────────────────────────────────────────────

/** The query response view — the shared decision shape the snapshot slice serializes. */
export type DecisionView = Decision;

/** `decisions.snapshotSlice` — the project's decisions for a viewer (role-filtered) + the id→status
 *  map the readiness derivation consults. */
export interface DecisionSnapshotQuery {
  readonly projectId: string;
  readonly role: string;
  readonly userId?: string;
}
export interface DecisionSnapshotResult {
  readonly decisions: readonly DecisionView[];
  readonly statuses: ReadonlyMap<string, DecisionStatus>;
}

/** `decisions.existsInProject` / `decisions.resolveRef` — validate a decision reference belongs to a project. */
export interface DecisionRefQuery {
  readonly projectId: string;
  readonly decisionId: string;
}

/** `decisions.countByNodeIds` — how many decisions are filed under any of the given location nodes. */
export interface DecisionNodeCountQuery {
  readonly nodeIds: readonly string[];
}

/** `decisions.countPending` — how many of a project's decisions are still pending. */
export interface DecisionPendingCountQuery {
  readonly projectId: string;
}
