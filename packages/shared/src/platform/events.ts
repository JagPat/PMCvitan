/**
 * Phase 2 Task 4 — the shared DomainEvent envelope + catalog.
 *
 * Every consequential state change appends ONE immutable, tenant-consistent, totally
 * ordered domain event inside its owning mutation transaction. This is the canonical
 * envelope shape the API (which writes it) and future consumers/projections (which read
 * it) agree on.
 *
 * Ordering is a **gap-safe per-project stream position** (`projectId` + `streamPosition`),
 * assigned by locking + incrementing the project's `ProjectEventStream` counter inside the
 * same transaction. `occurredAt` is DISPLAY/AUDIT ONLY — never an ordering key or a
 * checkpoint (equal timestamps still get distinct positions; a transaction that started
 * later but committed earlier still gets a later position and is never skipped).
 */

/** A change is attributed to a real person or a named system process — the same
 *  {@link Actor} kind the audit kernel resolves in Task 3. */
export type ActorKind = 'human' | 'system';

/**
 * The full Task-1 event vocabulary (`docs/reviews/phase2-projection-matrix.md` §0). The
 * `eventType` column stores the base name; the schema version is the separate integer
 * `payloadVersion` column (all `@1` today). This is the PROJECT-SCOPED store — every event
 * carries a non-null `projectId` and orders in that project's stream. Three groups of Task-1
 * vocabulary are therefore intentionally absent:
 *   - `activity.readiness_changed` — readiness is DERIVED at read time from explicit links;
 *     emitting it would contradict the Phase 1 readiness architecture.
 *   - `org.updated` — no org-update mutation exists yet.
 *   - `org.created`, `orgMembership.added|role_changed|removed` — ORG-scoped, with no single
 *     project to order under; a per-org event stream is a separate future concern, out of
 *     scope for this project-scoped store (Task 4).
 */
export const DOMAIN_EVENT_TYPES = [
  // decisions
  'decision.drafted',
  'decision.published',
  'decision.approved',
  'decision.reapproved',
  'decision.change_requested',
  'decision.change_withdrawn',
  // activities
  'activity.created',
  'activity.updated',
  'activity.deleted',
  'activity.started',
  'activity.completion_requested',
  'activity.override_granted',
  'activity.override_revoked',
  'activity.signed_off',
  'activity.signoff_rejected',
  // Task 10 (Module 4) — the two activity-owned SIGNAL events a FOREIGN command appends through the
  // activities participant so the ordered activities projection refreshes when a foreign mutation touches
  // an activity-owned serialized field (the Module-3 owner-aligned pattern): the daily-log material
  // mismatch failing the stored material gate + blocking, and a node deletion unfiling placed activities.
  'activity.material_blocked',
  // Phase 3 Task 5 — the inverse owner-aligned signal: a mismatch RESOLUTION clears the
  // material block (only when no unresolved mismatch remains), appended by the activities
  // participant in the daily-log resolve transaction so the projection observes the change.
  'activity.material_unblocked',
  'activity.unfiled',
  // phases
  // Phase 3 Task 1 — the ActivityRequirement demand contract (activities-owned; plan §G:
  // created/revised/cancelled ONLY — derived satisfaction produces no domain event)
  'requirement.created',
  'requirement.revised',
  'requirement.cancelled',
  // Phase 3 Task 6 — approved substitutions (§B satisfaction rule): a canonical, audited,
  // activities-owned fact that changes material coverage. Approval and revocation each emit an
  // event the readiness projection consumes to RECOMPUTE verdicts (there is still NO
  // material.readiness_changed event — a derived verdict is never a domain fact).
  'substitution.approved',
  'substitution.revoked',
  // Phase 3 Task 2 — the procurement pipeline (plan §G catalog: submitted/approved and the
  // comparison approval ONLY; drafts, rejections and RFQ/quote bookkeeping are audit facts)
  'requisition.submitted',
  'requisition.approved',
  'comparison.approved',
  // Phase 3 Task 3 — POs + delivery commitments (plan §G catalog: issued/amended/cancelled
  // and committed/revised/defaulted ONLY; drafts, close-short and fulfilment are audit facts)
  'po.issued',
  'po.amended',
  'po.cancelled',
  'delivery.committed',
  'delivery.revised',
  'delivery.defaulted',
  // Phase 3 Task 4 — the inventory stock ledger (plan §G catalog: ONE event per appended §C
  // ledger row — receipts, acceptance, rejection, vendor-return, adjustment, reversal; buckets
  // are derived, so there is no bucket-changed event)
  'stock.transacted',
  // Phase 3 Task 5 — the §E canonical issue record (what LEFT THE STORE for an activity):
  // one event per MaterialIssue, alongside the ledger row's stock.transacted
  'issue.recorded',
  // Phase 3 Task 5 — §E: an explicit, audited resolution closing ONE mismatch observation
  // (the observation row itself is never edited)
  'mismatch.resolved',
  'phase.created',
  'phase.removed',
  // inspections
  'inspection.created',
  'inspection.submitted',
  'inspection.approved',
  'inspection.rejected',
  'inspection.reinspection_created',
  // Phase 2 Task 10 (Module 3) correction — inspection-owned events for changes to the projection's
  // serialized fields that formerly rode ONLY a foreign module's event (so the inspection projection
  // could not observe them). Each is appended by the inspections workflow participant IN the foreign
  // mutation's transaction, so the inspections.inbox cursor refreshes the row. All signal-only.
  'inspection.closing_created', // the closing inspection an activity-completion claim creates (edge 1)
  'inspection.evidence_added', // item evidence linked by a media upload
  'inspection.evidence_removed', // item evidence unlinked by a media delete
  'inspection.relabeled', // the inspection-owned activity label updated when the linked activity is renamed
  'inspection.unfiled', // the inspection's location cleared when its placed node is deleted
  // drawings
  'drawing.issued',
  'drawing.revised',
  'drawing.recipients_frozen',
  'drawing.published',
  'drawing.acknowledged',
  'drawing.refiled',
  'drawing.removed',
  // Phase 2 Task 10 (Module 4) correction — drawing-owned signal events for changes to the drawings
  // projection's serialized fields that formerly happened ONLY through an ON DELETE SET NULL FK (so the
  // drawings.inbox cursor could not observe them). Each is appended by the drawings workflow participant
  // IN the deleting command's transaction. Signal-only (invalidate, no push).
  'drawing.activity_unlinked', // the drawing's governed-activity link cleared when that activity is deleted
  'drawing.unfiled', // the drawing's location cleared when its filed node is deleted
  // daily-log
  'dailylog.started',
  'dailylog.submitted',
  'material.added',
  'material.mismatch_flagged',
  // Phase 2 Task 10 (Module 4) correction — same owner-aligned discipline for the daily-log projection's
  // serialized material location (formerly mutated only by the SET NULL FK on a node delete).
  'material.unfiled', // the material's staging place cleared when its filed node is deleted
  // nodes (location spine)
  'node.created',
  'node.published',
  'node.renamed',
  'node.moved',
  'node.removed',
  // media
  'media.uploaded',
  'media.refiled',
  'media.removed',
  // project lifecycle
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  // project membership
  'membership.added',
  'membership.role_changed',
  'membership.discipline_changed',
  'membership.removed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/**
 * The persisted envelope. `streamPosition` is a per-project `BIGINT`; it is modelled as a JS
 * number here because a single project's lifetime event count never approaches 2^53.
 */
export interface DomainEventEnvelope {
  /** UUID primary key, assigned by the writer. */
  eventId: string;
  /** e.g. `decision.approved`, `activity.started` — one of {@link DOMAIN_EVENT_TYPES}. */
  eventType: string;
  /** Schema version of `payload`, so a consumer can migrate an old shape. */
  payloadVersion: number;
  /** Tenant — ALWAYS non-null. A composite FK ties `(organizationId, projectId)` to the real org. */
  organizationId: string;
  /** The project (site) the event belongs to; the ordering scope. */
  projectId: string;
  /** Gap-safe position within the project's stream. Ordering key — NEVER `occurredAt`. */
  streamPosition: number;
  /** Optional location (ProjectNode) the change happened at; null when not location-bound. */
  siteId: string | null;
  /** The real user id for a `human` actor; null for `system` (which names `systemActor`). */
  actorId: string | null;
  /** Whether a person or a named system process caused this. */
  actorKind: ActorKind;
  /** The named constant system actor (e.g. `system:migrator`) — non-null iff `actorKind='system'`. */
  systemActor: string | null;
  /** The domain entity type, e.g. `Decision`, `Activity`, `Inspection`. */
  entityType: string;
  /** The domain entity id. */
  entityId: string;
  /** Human-facing timestamp — DISPLAY/AUDIT ONLY, never an ordering key. ISO-8601 string. */
  occurredAt: string;
  /** Correlates events produced by one logical operation across entities. */
  correlationId: string | null;
  /** The event that directly caused this one, for causal chains. */
  causedByEventId: string | null;
  /** The event-type-specific body. */
  payload: unknown;
}
