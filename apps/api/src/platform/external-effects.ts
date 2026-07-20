import { createHash } from 'node:crypto';
import type { DomainEventType } from '@vitan/shared';

/**
 * Phase 2 fix-forward PR C Task 1 — the external-effect catalog.
 *
 * The MACHINE-READABLE, compile-time inventory of every approved external consequence (a socket
 * invalidation and/or a Web Push) a command may request when it appends a {@link DomainEvent}. It is
 * the single source of truth for:
 *   - which effect keys exist (a producer must name one — there is no default),
 *   - whether that key invalidates the project's live snapshot,
 *   - the EXACT push target roles a key may reach (a producer supplies only the body),
 *   - the coverage version (a canonical SHA-256 of the whole catalog) the cutover seal pins.
 *
 * A key is per-command-BRANCH, not per-event-type: a private draft and a published create of the
 * same entity carry different keys (`decision.drafted` invalidates nothing; `decision.published`
 * invalidates and pushes `['client']`). Draft/replay/no-op branches declare no invalidation and no
 * push, so the outbox never sends an external effect for private or already-applied work.
 */

/** The project roles a push may target. A subset of the app's project roles. */
export type PushRole = 'pmc' | 'client' | 'contractor' | 'engineer' | 'consultant';

export interface ExternalEffectDef {
  /** The domain event type this key is emitted as — validated against the shared catalog. */
  readonly eventType: DomainEventType;
  /** Whether this event invalidates the project's live snapshot (a socket `changed` signal). */
  readonly invalidate: boolean;
  /** The push capability: `null` = this key NEVER pushes; otherwise the EXACT allowed target roles.
   *  The producer supplies only the body; the roles are taken from here, so a caller can never widen
   *  or narrow the audience of a key. */
  readonly push: readonly PushRole[] | null;
}

/**
 * Every approved external-effect key. Keyed by `<domain>.<branch>`; the value pins the event type,
 * the invalidation decision and the exact push audience. When a command emits several events, at most
 * one carries the push body — the others invalidate only — so a command produces exactly one push.
 */
export const EXTERNAL_EFFECTS = {
  // ── decisions ──────────────────────────────────────────────────────────────────────────────
  'decision.drafted': { eventType: 'decision.drafted', invalidate: false, push: null },
  'decision.published': { eventType: 'decision.published', invalidate: true, push: ['client'] },
  'decision.approved': { eventType: 'decision.approved', invalidate: true, push: ['pmc', 'contractor', 'engineer'] },
  'decision.reapproved': { eventType: 'decision.reapproved', invalidate: true, push: ['pmc', 'contractor', 'engineer'] },
  'decision.change_requested': { eventType: 'decision.change_requested', invalidate: true, push: null },
  'decision.change_withdrawn': { eventType: 'decision.change_withdrawn', invalidate: true, push: null },
  // ── activities ─────────────────────────────────────────────────────────────────────────────
  'activity.created': { eventType: 'activity.created', invalidate: true, push: ['engineer', 'contractor'] },
  'activity.updated': { eventType: 'activity.updated', invalidate: true, push: null },
  'activity.deleted': { eventType: 'activity.deleted', invalidate: true, push: null },
  'activity.started': { eventType: 'activity.started', invalidate: true, push: null },
  'activity.completion_requested': { eventType: 'activity.completion_requested', invalidate: true, push: ['pmc'] },
  'activity.override_granted': { eventType: 'activity.override_granted', invalidate: true, push: ['engineer', 'contractor'] },
  'activity.override_revoked': { eventType: 'activity.override_revoked', invalidate: true, push: null },
  'activity.signed_off': { eventType: 'activity.signed_off', invalidate: true, push: ['contractor', 'client'] },
  'activity.signoff_rejected': { eventType: 'activity.signoff_rejected', invalidate: true, push: null },
  // Task 10 (Module 4) — the activity-owned signal events a FOREIGN command appends through the activities
  // participant (daily-log material-mismatch block; node-deletion unfiling). Signal-only: they refresh the
  // activities projection and dedupe with the foreign command's own socket invalidation; no push.
  'activity.material_blocked': { eventType: 'activity.material_blocked', invalidate: true, push: null },
  'activity.unfiled': { eventType: 'activity.unfiled', invalidate: true, push: null },
  // ── phases ─────────────────────────────────────────────────────────────────────────────────
  // Phase 3 Task 1 — requirement demand-contract events (pilot projects only; §D gate).
  // Snapshot-invalidate only; no push notification (Inbox/notification semantics arrive with
  // the readiness surfaces in later tasks).
  'requirement.created': { eventType: 'requirement.created', invalidate: true, push: null },
  'requirement.revised': { eventType: 'requirement.revised', invalidate: true, push: null },
  'requirement.cancelled': { eventType: 'requirement.cancelled', invalidate: true, push: null },
  // ── procurement (Phase 3 Task 2) ───────────────────────────────────────────────────────────
  // The §G pipeline events (submitted/approved + the comparison approval ONLY). Snapshot-
  // invalidate only; Inbox/notification semantics arrive with the readiness surfaces later.
  'requisition.submitted': { eventType: 'requisition.submitted', invalidate: true, push: null },
  'requisition.approved': { eventType: 'requisition.approved', invalidate: true, push: null },
  'comparison.approved': { eventType: 'comparison.approved', invalidate: true, push: null },
  // Task 3 — §G PO/delivery events (issued/amended/cancelled + committed/revised/defaulted
  // ONLY). Snapshot-invalidate only; the §A at-risk consumption arrives with Task 6.
  'po.issued': { eventType: 'po.issued', invalidate: true, push: null },
  'po.amended': { eventType: 'po.amended', invalidate: true, push: null },
  'po.cancelled': { eventType: 'po.cancelled', invalidate: true, push: null },
  'delivery.committed': { eventType: 'delivery.committed', invalidate: true, push: null },
  'delivery.revised': { eventType: 'delivery.revised', invalidate: true, push: null },
  'delivery.defaulted': { eventType: 'delivery.defaulted', invalidate: true, push: null },
  // Task 4 — the §G inventory ledger event (ONE per appended §C stock transaction).
  // Snapshot-invalidate only; the readiness/store projections consume it in Tasks 5–6.
  'stock.transacted': { eventType: 'stock.transacted', invalidate: true, push: null },
  'phase.created': { eventType: 'phase.created', invalidate: true, push: null },
  'phase.removed': { eventType: 'phase.removed', invalidate: true, push: null },
  // ── inspections ────────────────────────────────────────────────────────────────────────────
  'inspection.created': { eventType: 'inspection.created', invalidate: true, push: ['engineer'] },
  'inspection.submitted': { eventType: 'inspection.submitted', invalidate: true, push: null },
  // approve carries the push ONLY when the inspection has no linked activity (else the signoff does);
  // it may reach contractor + client either way.
  'inspection.approved': { eventType: 'inspection.approved', invalidate: true, push: ['contractor', 'client'] },
  'inspection.rejected': { eventType: 'inspection.rejected', invalidate: true, push: null },
  'inspection.reinspection_created': { eventType: 'inspection.reinspection_created', invalidate: true, push: ['engineer'] },
  // Phase 2 Task 10 (Module 3) correction — inspection-owned events appended by the workflow participant in
  // a FOREIGN mutation's transaction, so the inspections.inbox projection observes changes to its serialized
  // fields that formerly rode only another module's event. Signal-only: the invalidation deduplicates with
  // the foreign command's own invalidation (one socket signal per project), and none carries a push (the
  // foreign command owns any push body).
  'inspection.closing_created': { eventType: 'inspection.closing_created', invalidate: true, push: null },
  'inspection.evidence_added': { eventType: 'inspection.evidence_added', invalidate: true, push: null },
  'inspection.evidence_removed': { eventType: 'inspection.evidence_removed', invalidate: true, push: null },
  'inspection.relabeled': { eventType: 'inspection.relabeled', invalidate: true, push: null },
  'inspection.unfiled': { eventType: 'inspection.unfiled', invalidate: true, push: null },
  // ── drawings ───────────────────────────────────────────────────────────────────────────────
  'drawing.issued': { eventType: 'drawing.issued', invalidate: true, push: ['engineer', 'contractor'] },
  // a draft issue emits the same event type but reaches no one (private).
  'drawing.issued_draft': { eventType: 'drawing.issued', invalidate: false, push: null },
  'drawing.revised': { eventType: 'drawing.revised', invalidate: true, push: ['engineer', 'contractor'] },
  // a revision added to a STILL-DRAFT drawing (not yet published) reaches no one.
  'drawing.revised_draft': { eventType: 'drawing.revised', invalidate: false, push: null },
  // recipients-frozen is an internal bookkeeping event on the published issue/publish path — no send.
  'drawing.recipients_frozen': { eventType: 'drawing.recipients_frozen', invalidate: false, push: null },
  'drawing.published': { eventType: 'drawing.published', invalidate: true, push: ['engineer', 'contractor'] },
  'drawing.acknowledged': { eventType: 'drawing.acknowledged', invalidate: true, push: ['pmc'] },
  'drawing.refiled': { eventType: 'drawing.refiled', invalidate: true, push: null },
  'drawing.removed': { eventType: 'drawing.removed', invalidate: true, push: null },
  // Task 10 (Module 4) correction — drawing-owned SET-NULL signals (invalidate only, never push)
  'drawing.activity_unlinked': { eventType: 'drawing.activity_unlinked', invalidate: true, push: null },
  'drawing.unfiled': { eventType: 'drawing.unfiled', invalidate: true, push: null },
  // ── daily-log ──────────────────────────────────────────────────────────────────────────────
  'dailylog.started': { eventType: 'dailylog.started', invalidate: true, push: null },
  'dailylog.submitted': { eventType: 'dailylog.submitted', invalidate: true, push: null },
  'material.added': { eventType: 'material.added', invalidate: true, push: null },
  'material.mismatch_flagged': { eventType: 'material.mismatch_flagged', invalidate: true, push: ['pmc', 'contractor'] },
  // Task 10 (Module 4) correction — the daily-log-owned SET-NULL signal (invalidate only, never push)
  'material.unfiled': { eventType: 'material.unfiled', invalidate: true, push: null },
  // ── nodes (location spine) — signal only, never a push ───────────────────────────────────────
  'node.created': { eventType: 'node.created', invalidate: true, push: null },
  'node.published': { eventType: 'node.published', invalidate: true, push: null },
  'node.renamed': { eventType: 'node.renamed', invalidate: true, push: null },
  'node.moved': { eventType: 'node.moved', invalidate: true, push: null },
  'node.removed': { eventType: 'node.removed', invalidate: true, push: null },
  // ── media — signal only, never a push ────────────────────────────────────────────────────────
  'media.uploaded': { eventType: 'media.uploaded', invalidate: true, push: null },
  'media.refiled': { eventType: 'media.refiled', invalidate: true, push: null },
  'media.removed': { eventType: 'media.removed', invalidate: true, push: null },
  // ── project lifecycle + membership — no in-request socket sender today, so no external effect ──
  'project.created': { eventType: 'project.created', invalidate: false, push: null },
  'project.updated': { eventType: 'project.updated', invalidate: false, push: null },
  'project.archived': { eventType: 'project.archived', invalidate: false, push: null },
  'project.restored': { eventType: 'project.restored', invalidate: false, push: null },
  'membership.added': { eventType: 'membership.added', invalidate: false, push: null },
  'membership.role_changed': { eventType: 'membership.role_changed', invalidate: false, push: null },
  'membership.discipline_changed': { eventType: 'membership.discipline_changed', invalidate: false, push: null },
  'membership.removed': { eventType: 'membership.removed', invalidate: false, push: null },
} as const satisfies Record<string, ExternalEffectDef>;

export type ExternalEffectKey = keyof typeof EXTERNAL_EFFECTS;

/** The immutable dispatch intent persisted WITH each event (PR C). Derives entirely from the catalog
 *  key plus the command-supplied body, so a scanner reproduces the exact plan long after the request. */
export interface DispatchIntent {
  readonly effectKey: ExternalEffectKey;
  readonly coverageVersion: string;
  readonly invalidate: boolean;
  readonly push?: { body: string; roles: readonly PushRole[] };
}

/** The command-supplied part of an emit's dispatch: only the push BODY (roles come from the catalog).
 *  A key whose catalog `push` is `null` must not carry a push body. */
export interface DispatchInput {
  push?: { body: string };
}

/** A canonical, order-independent serialization of the whole catalog — the coverage-version preimage. */
function canonicalCatalog(): string {
  const keys = Object.keys(EXTERNAL_EFFECTS).sort();
  return JSON.stringify(
    keys.map((k) => {
      const d = EXTERNAL_EFFECTS[k as ExternalEffectKey];
      return [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort()];
    }),
  );
}

let cachedVersion: string | null = null;

/** The current effect-coverage version: SHA-256 of the canonical catalog. Stable across process runs
 *  for a fixed catalog; changes iff a key/eventType/invalidate/role set changes. The cutover seal
 *  (Task 3) pins this exact value and outbox-mode startup requires it. */
export function effectCoverageVersion(): string {
  if (cachedVersion === null) cachedVersion = createHash('sha256').update(canonicalCatalog()).digest('hex');
  return cachedVersion;
}

/**
 * Validate a producer's `effectKey` + `dispatch` against the catalog and build the intent to persist.
 * Throws (no event should be written) when the key is unknown, the declared `eventType` disagrees with
 * the catalog, or a push body is supplied for a key that may not push. Roles always come from the
 * catalog, so a caller can never forge the audience.
 */
export function buildDispatchIntent(effectKey: ExternalEffectKey, eventType: DomainEventType, dispatch: DispatchInput): DispatchIntent {
  const def = EXTERNAL_EFFECTS[effectKey];
  if (!def) throw new Error(`unknown external-effect key '${String(effectKey)}'`);
  if (def.eventType !== eventType) {
    throw new Error(`effect key '${effectKey}' is declared for event '${def.eventType}', not '${eventType}'`);
  }
  if (dispatch.push && def.push === null) {
    throw new Error(`effect key '${effectKey}' may not push (catalog push is null), but a push body was supplied`);
  }
  return {
    effectKey,
    coverageVersion: effectCoverageVersion(),
    invalidate: def.invalidate,
    ...(dispatch.push ? { push: { body: dispatch.push.body, roles: def.push ?? [] } } : {}),
  };
}
