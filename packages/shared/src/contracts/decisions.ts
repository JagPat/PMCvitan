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
import type { Decision, DecisionStatus, DeciderKind } from '../domain/types';

/** The decisions module's state-changing commands (must equal the manifest `commands`). */
export const DECISION_COMMANDS = [
  'decisions.create',
  'decisions.publish',
  'decisions.approve',
  'decisions.requestChange',
  'decisions.withdrawChange',
  // Phase 6 task 4a — take back a published, never-approved decision (pmc authority, terminal).
  'decisions.withdraw',
  // Phase 6 task 4b (§A.1/§A.2 round 8) — edit an UNPUBLISHED draft: re-point its decider
  // (kind / named membership), convert to/from a record (`none` ⟺ `recorded` as one coherent
  // pair), or replace its options. Publication freezes the holder; this is the drafting door.
  'decisions.updateDraft',
  // Phase 6 task 4c (§A) — ASK a named project member for advice on a published, still-open
  // decision, and ANSWER that request. A consultation INFORMS and never GATES: neither command
  // moves a status, an approval or a readiness verdict (P24).
  'consultations.request',
  'consultations.respond',
] as const;
export type DecisionCommand = (typeof DECISION_COMMANDS)[number];

/** Phase 6 task 4c — the CLIENT CONTRACT value a consultation-aware bundle advertises in the
 *  `x-vitan-decisions-contract` header (the 4b `recorded-v1` mechanism, extended rather than
 *  reinvented). The consultation WRITE commands refuse a caller that has not advertised it: a
 *  stale tab must never originate a consultation its own UI could not then show. Reads are
 *  unaffected — a pre-4c bundle keeps receiving the shape it understands. */
export const DECISIONS_CONTRACT_CONSULTATION = 'consultation-v1';

/** The decisions module's read queries (must equal the manifest `queries`). */
export const DECISION_QUERIES = [
  'decisions.snapshotSlice',
  // Task 9 — the same decision slice served from the module's rebuildable projection (query-time authz)
  'decisions.projectionSlice',
  'decisions.existsInProject',
  // Phase 6 task 4a round 9 (Codex) — existence is not LINKABILITY: a withdrawn decision is
  // terminal, so a consumer validating a NEW reference asks this instead of bare existence
  // (activities' assertRefs; the write-path twin of the web picker rule).
  'decisions.linkableInProject',
  'decisions.resolveRef',
  'decisions.countByNodeIds',
  'decisions.countPending',
  // Phase 3 Task 1 correction — the AUTHORITATIVE approval reference a requirement's material
  // spec pins: server-resolved approved/reapproved version + the selected option; pending or
  // reopened decisions refuse (caller-authored provenance is never accepted).
  'decisions.approvedRef',
  // Phase 6 task 4b (§A.2) — statusMap/statusOf plus the DRAFT flag: the gate reader's recorded
  // arm gates a linked DRAFT record `wait` and a published one `na`, so readiness bakes need both.
  'decisions.statusAndDraftMap',
  'decisions.statusAndDraftOf',
  // Phase 6 task 4b (§A.3) — the decider push family's claim-time predicate (bound at bootstrap):
  // is a queued "decide this" push still actionable, and for whom?
  'decisions.deciderPushTarget',
  // Phase 6 task 4c (§B.3) — the two consultation push families' claim-time predicates, bound at
  // bootstrap exactly like the decider family's: is a queued "you were asked" / "they answered"
  // push still actionable, and for whom?
  'decisions.consultationPushTarget',
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

/** `decisions.create` — issue a decision (as a draft, or published in one step).
 *  Phase 6 task 4b (§A.1; round-10 Codex F2) — the decider designation is part of the PUBLIC
 *  command contract, not an API-private widening: consumers typed against this package must be
 *  able to construct a pmc/member/record issue without casts. Post-validation shape: the
 *  `deciderKind` default ('client') is applied, so it is REQUIRED here. */
export interface CreateDecisionInput {
  readonly title: string;
  readonly nodeId?: string;
  readonly room: string;
  readonly options: readonly DecisionOptionInput[];
  readonly publish: boolean;
  /** WHO decides — 'client' (the legacy default), 'pmc', a named 'member', or 'none' (a record). */
  readonly deciderKind: DeciderKind;
  /** the named holder's ACTIVE membership id — required exactly when `deciderKind='member'`. */
  readonly deciderMembershipId?: string;
}

/** `decisions.updateDraft` — edit an UNPUBLISHED draft (Phase 6 task 4b §A.1 round 8; the
 *  contract joined the shared surface in round-10 Codex F2): re-point the decider (kind / named
 *  membership), convert to/from a record (`none` ⟺ `recorded` as one coherent pair — a
 *  conversion off a record carries its 2–4 options in the SAME edit, and a conversion TO a
 *  record removes them in the same edit), or replace title/location/options. Omitted fields are
 *  left untouched; `nodeId: null` explicitly clears the tree link. */
export interface UpdateDecisionDraftInput {
  readonly title?: string;
  readonly nodeId?: string | null;
  readonly room?: string;
  readonly options?: readonly DecisionOptionInput[];
  readonly deciderKind?: DeciderKind;
  readonly deciderMembershipId?: string;
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

/** `decisions.withdraw` — take back a published, never-approved decision (Phase 6 task 4a).
 *  The reason is REQUIRED: a withdrawal without one is the silent delete this design refuses. */
export interface WithdrawDecisionInput {
  readonly reason: string;
}

/** `consultations.request` — ask a named ACTIVE project member for advice on a published,
 *  still-open decision (Phase 6 task 4c §A). The consultee is named by MEMBERSHIP: the server
 *  resolves the canonical audience user from it, so a caller can never forge who gets to see the
 *  decision. The question is required and non-blank — a request with nothing asked is not one. */
export interface RequestConsultationInput {
  readonly consulteeMembershipId: string;
  readonly question: string;
}

/** `consultations.respond` — answer one outstanding consultation (Phase 6 task 4c §A). Only the
 *  named consultee may answer, once, and only while the decision is still the one they were asked
 *  about: an approval closes every consultation of its cycle. The recommended option is ADVICE —
 *  naming it moves no status and locks nothing. */
export interface RespondToConsultationInput {
  readonly consultationId: string;
  readonly response: string;
  /** the option key the consultee recommends, when they name one. */
  readonly recommendedOptionKey?: string;
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
