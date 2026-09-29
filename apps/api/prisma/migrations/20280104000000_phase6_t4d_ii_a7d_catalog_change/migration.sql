-- Phase 6 task 4d unit 4d-ii-a / A7d — THE CATALOG CHANGE (the plan's §D: "4d-ii-a is a CATALOG
-- CHANGE, staged as one: its new push families and widened targeted entries change the sealed
-- external-effect coverage hash"; the staging document's A7d note: "the widened external-effect
-- catalog at the new coverage version beside the old (the architect in the targeted entries,
-- `decision.consultation_responded` to `['pmc','architect']`, the frozen-audience families,
-- `membership.standing_changed`); ... `webpush.notify` 2→3 with its `OutboxConsumerCatalog` row;
-- `decisions.effects` registered INACTIVE (its head from A6's catalog-INSERT trigger) ...;
-- `ALWAYS_EXECUTE`; the reseal sequence in the packet").
--
-- WHAT THIS FILE DOES, in ledger order:
--   PART 1  seeds the COMPILED catalog's new coverage generation (`23f47cd9…`) BESIDE 4d-i-b U3's
--           (`7dac2bd5…`), audited key by key against the generation it extends — the 4d-i / U3
--           shape, widened for what this generation legitimately changes: three keys ADDED
--           (`decision.forwarded`, `decision.awaiting_countersign`, `membership.standing_changed`),
--           the `architect` role JOINING exactly three targeted ceilings, and nothing else moving.
--           The prior rows stay for the drain (a still-serving A7c process emits under them).
--   PART 2  moves `webpush.notify`'s DURABLE contract version 2 → 3, guarded on the version it
--           moves from (the 4c-ii and A7c precedent): the compiled consumer now claims two frozen-
--           audience families and reads `targetUserIds`, and `syncConsumerCatalog` refuses a
--           previous-release process at its start.
--   PART 3  inside the A6c rule-migration transition: `decisions.inbox`'s persisted `types` rule
--           gains the two decision types (the compiled rule is `eventTypesUnder('decision.')`, and
--           startup VERIFIES a rule and never writes one that exists), and `decisions.effects` is
--           REGISTERED INACTIVE — the decisions-owned ORDERED consumer of `membership.standing_changed`
--           — guarded on the row's ABSENCE (a replay is a no-op); its activation head comes from A6a's
--           catalog-INSERT trigger, and 4d-iii activates it after the drain.
--   PART 4  the CLAIMANTS of the three new `pairingRequired` types (§A.3 obligation 7: the branch's
--           PRIMARY fact claims): the `MembershipTransition` of an architect-standing flip claims
--           `membership.standing_changed`; the `DecisionForward` fact claims `decision.forwarded`;
--           the PROVISIONAL `DecisionApprovalRevision` birth claims `decision.awaiting_countersign`
--           (the finalized arm A7a re-issued is byte-identical); the re-notification's claimant is
--           4d-i's `DecisionEvent_t4d_renotified_claim`, already installed. And U1's kernel actor seal
--           is re-issued with the ONE exemption the plan states: the `decisions.effects` re-emit is a
--           SYSTEM act (`system:membership-standing`), bound to the committed crossing it names.
--   PART 5  fails closed on its own installation.
--
-- WHY ONE FILE. The compiled coverage version, the consumer contract version, the persisted rules
-- and the claimants must move together: a process compiled with this catalog cannot start against
-- rows at the old version (`syncConsumerCatalog` refuses), cannot emit under a generation the
-- database does not hold (`DomainEvent_t4d_envelope` refuses), and cannot commit a pairingRequired
-- event no fact claims (`DomainEvent_t4d_pairing_claimed` refuses). The packet declares the
-- migration seam inseparable for the reason 4c-ii did.
--
-- THE RESEAL IS NOT THIS FILE'S (docs/RUNBOOK.md §"catalog changed"): the `OutboxCutoverState` seal
-- names a coverage version, `OutboxBootstrap` refuses `OUTBOX_SENDER_MODE=outbox` while the seal
-- differs from the compiled catalog, and a migration cannot supply the operator identity or the
-- running build's hash. Deploy this build in `legacy`/`shadow`, `outbox:status` clean, then
-- `outbox:seal-external`, then restart in `outbox` — the packet's steps, before 4d-iii.
--
-- Re-runnable: every INSERT is guarded or ON CONFLICT DO NOTHING, every UPDATE guarded on the shape
-- it moves from, every function CREATE OR REPLACE, every trigger DROP IF EXISTS + CREATE.
-- ONE TRANSACTION (U3's shape): the seed lives in `ON COMMIT DROP` temp tables and the rule
-- transition is open for exactly this transaction, so the file is all-or-nothing wherever it runs —
-- under Prisma, and under `psql -f` from the proofs' replays.

BEGIN;

-- ── THE PREREQUISITES ARE 4d-i's, 4d-i-b's AND 4d-ii-a's, VERIFIED, NOT ASSUMED ────────────
DO $t4dii_a7d_prereq$
DECLARE v_fn TEXT; v_missing TEXT := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'platform_claim_event_pairing', 'platform_claim_event_pairing_once', 'platform_tx_event',
    'platform_tx_event_count', 'phase6_t4d_retired_at_start', 'phase6_t4d_ii_installed',
    'phase6_t4d_tx_actor_event', 'phase6_t4d_tx_actor_event_count', 'phase6_t4d_tx_audit_count',
    'platform_role_standing', 'platform_t4d_event_pairing_actor', 'phase6_t4d_revision_claims_approval',
    'phase6_t4d_renotified_claims_event', 'platform_t4d_catalog_registration_head', 'platform_t4d_catalog_rules'
  ] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: this unit extends a mechanism 4d-i, 4d-i-b and 4d-ii-a''s A6/A7a install, and this database holds none of: %. Those files apply before this one in the ledger, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES them from ALWAYS_EXECUTE for exactly this reason. Apply them first. See docs/RUNBOOK.md §P6T4D.',
      v_missing;
  END IF;
END $t4dii_a7d_prereq$;

-- ── THE RETIREMENT SNAPSHOT, TAKEN AGAIN, AGAINST THIS FILE'S OWN ARTIFACT ──────────────────
-- Transaction-local (U3's rule): the verdict names an artifact this family creates (U3's request
-- claimant, on main since U3) so a forged marker on a db-push baseline reads FALSE.
DO $snapshot$
BEGIN
  PERFORM set_config('vitan.phase6_4d_retired_at_start',
                     CASE WHEN EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d')
                           AND to_regproc('phase6_t4d_change_request_paired') IS NOT NULL
                          THEN 'on' ELSE 'off' END, true);
END $snapshot$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE WIDENED CATALOG, AS A NEW COVERAGE GENERATION BESIDE THE OLD
-- ════════════════════════════════════════════════════════════════════════════════════════════

SELECT set_config('vitan.phase6_4d_catalog', 'on', true);

-- THE LITERAL LANDS IN A TEMP TABLE FIRST, AND THE TEMP TABLE IS THE AUTHORITY (4d-i's and U3's
-- rule). Generated from `apps/api/src/platform/external-effects.ts` and pinned to it by
-- `external-effect-catalog-seed.test.ts`, which parses this VALUES list and compares it, column for
-- column, with the compiled catalog at the compiled version. Eleven columns, exactly 4d-i's. The
-- coverage version is the EIGHT-element preimage (4d-i-b's six, plus `frozenAudience` and the frozen
-- family's constant `pushBody` — both sealed columns a seal reads, so a release disagreeing about
-- either cannot share a generation).
CREATE TEMP TABLE "_t4dii_catalog_seed" (
    "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
    "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL,
    "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL,
    PRIMARY KEY ("coverageVersion", "effectKey")
) ON COMMIT DROP;

INSERT INTO "_t4dii_catalog_seed" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.created.init', 'activity.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.awaiting_countersign', 'decision.awaiting_countersign', true, '["architect"]'::jsonb, 'countersign', true, true, 'frozen', 'A decision awaits your countersign', true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.consultation_requested', 'decision.consultation_requested', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.consultation_responded', 'decision.consultation_responded', true, '["architect","pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.forwarded', 'decision.forwarded', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'forward', true, true, 'frozen', 'A decision has been forwarded to you', true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.published', 'decision.published', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.published.record', 'decision.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.approved.closing', 'inspection.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.created.init', 'inspection.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'membership.standing_changed', 'membership.standing_changed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
;
-- THE GENERATION THIS ONE EXTENDS, named once: `7dac2bd5…` is 4d-i-b U3's seed (the six-element
-- preimage, the flag on the plan's six). The two 4d-i generations (`842cc9fc…` incoming, `6313b00c…`
-- outgoing) stay ADMITTED beside it. `phase6-t4d-i-catalog-generations.test.ts` re-derives all four
-- from source on every run, so no literal here can outlive its proof.
CREATE TEMP TABLE "_t4dii_catalog_prior" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_t4dii_catalog_prior" ("v") VALUES ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61');
CREATE TEMP TABLE "_t4dii_catalog_earlier" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_t4dii_catalog_earlier" ("v") VALUES
  ('842cc9fcbbd7920b169ef79266680d38f9cd48cc1acf9ea5d02c2f8b242f22a9'),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7');

-- ── THIS SEED IS THE DECLARED SUCCESSOR OF THE DEPLOYED PRIOR GENERATION ────────────────────
-- U3's audit admitted ONE shape (same keys, one flag flipped on six). This unit's shape is stated
-- with the same exactness and checked against the rows the database actually holds:
--   (1) the prior generation is PRESENT, over exactly this seed's keys MINUS the three added;
--   (2) the three ADDED keys are exactly the declared three, with the declared shape;
--   (3) every SHARED key is equal in every column but `pushRoles`, and `pushRoles` moves on exactly
--       three keys, each by the `architect` role JOINING (prior ⊂ seed, the difference one role);
--   (4) the prior generation is not RETIRED, unless 4d-iii has genuinely run.
DO $t4dii_prior$
DECLARE v_prior TEXT; v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT "v" INTO v_prior FROM "_t4dii_catalog_prior";
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dii_catalog_seed";
  IF v_seed = v_prior OR EXISTS (SELECT 1 FROM "_t4dii_catalog_earlier" e WHERE e."v" = v_seed) THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: the seed literal names an EARLIER generation (%) as its own — the compiled catalog no longer carries the A7d elements in its coverage preimage, or the literal was regenerated from an earlier catalog. This unit compiles a NEW generation; re-derive the literal from `external-effects.ts`.',
      v_seed;
  END IF;

  -- (1) the prior generation is PRESENT, over exactly the seed's keys minus the added three
  SELECT count(*), COALESCE(left(string_agg(q.k, ', ' ORDER BY q.k), 200), '') INTO v_n, v_s
    FROM (SELECT s."effectKey" AS k FROM "_t4dii_catalog_seed" s
           WHERE s."effectKey" NOT IN ('decision.forwarded', 'decision.awaiting_countersign', 'membership.standing_changed')
             AND NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                              WHERE c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND NOT EXISTS (SELECT 1 FROM "_t4dii_catalog_seed" s WHERE s."effectKey" = c."effectKey")) q;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: the prior generation % this unit extends does not carry this seed''s keys minus the three A7d adds — % key(s) differ (%). This unit ADDS exactly three keys and retires none; a key set that moved otherwise means the compiled catalog changed between 4d-i-b and this file, and that change needs its own generation with its own audit. Apply 4d-i-b U3 first (its replay re-seeds a missing generation) or re-derive this seed. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;

  -- (2) the ADDED keys, exactly as declared
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dii_catalog_seed" s
   WHERE s."effectKey" IN ('decision.forwarded', 'decision.awaiting_countersign', 'membership.standing_changed')
     AND NOT (
          (s."effectKey" = 'decision.forwarded' AND s."eventType" = 'decision.forwarded' AND s."invalidate"
             AND s."pushFamily" = 'forward' AND s."frozenAudience" AND s."requiresPush" AND s."audience" = 'frozen'
             AND s."pushBody" IS NOT NULL AND s."pairingRequired")
       OR (s."effectKey" = 'decision.awaiting_countersign' AND s."eventType" = 'decision.awaiting_countersign' AND s."invalidate"
             AND s."pushFamily" = 'countersign' AND s."frozenAudience" AND s."requiresPush" AND s."audience" = 'frozen'
             AND s."pushRoles" = '["architect"]'::jsonb AND s."pushBody" IS NOT NULL AND s."pairingRequired")
       OR (s."effectKey" = 'membership.standing_changed' AND s."eventType" = 'membership.standing_changed' AND s."invalidate"
             AND s."pushRoles" IS NULL AND s."pushFamily" IS NULL AND NOT s."frozenAudience" AND NOT s."requiresPush"
             AND s."audience" IS NULL AND s."pushBody" IS NULL AND s."pairingRequired"));
  IF v_n > 0 OR (SELECT count(*) FROM "_t4dii_catalog_seed" s
                  WHERE s."effectKey" IN ('decision.forwarded', 'decision.awaiting_countersign', 'membership.standing_changed')) <> 3 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: the three keys this unit adds are not declared as the plan states them (% disagree: %) — `decision.forwarded` and `decision.awaiting_countersign` are FROZEN-audience families that always announce and are claimed by their facts, `membership.standing_changed` invalidates, never pushes and is claimed by its transition. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) every SHARED key equal in every column but `pushRoles`, and `pushRoles` moved on exactly the
  --     three targeted keys by the one role joining
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dii_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE c."eventType"       IS DISTINCT FROM s."eventType"
      OR c."invalidate"      IS DISTINCT FROM s."invalidate"
      OR c."pushFamily"      IS DISTINCT FROM s."pushFamily"
      OR c."frozenAudience"  IS DISTINCT FROM s."frozenAudience"
      OR c."requiresPush"    IS DISTINCT FROM s."requiresPush"
      OR c."audience"        IS DISTINCT FROM s."audience"
      OR c."pushBody"        IS DISTINCT FROM s."pushBody"
      OR c."pairingRequired" IS DISTINCT FROM s."pairingRequired";
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: % shared key(s) of this seed differ from the prior generation % in a column other than `pushRoles` (%). This generation widens three ceilings by one role and adds three keys; a definition that changed its event type, invalidation, family, obligation, audience or pairing is a different release''s generation and must be seeded and audited as one. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior, v_s;
  END IF;
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dii_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE c."pushRoles" IS DISTINCT FROM s."pushRoles"
     AND NOT (s."effectKey" IN ('decision.published', 'decision.consultation_requested', 'decision.consultation_responded')
              AND c."pushRoles" IS NOT NULL AND s."pushRoles" IS NOT NULL
              AND c."pushRoles" <@ s."pushRoles"
              AND (SELECT count(*) FROM jsonb_array_elements_text(s."pushRoles") r WHERE NOT (c."pushRoles" ? r.value)) = 1
              AND s."pushRoles" ? 'architect' AND NOT (c."pushRoles" ? 'architect'));
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: % key(s) move their push ceiling in a way this unit does not declare (%). The declared widening is `architect` JOINING exactly three targeted ceilings — `decision.published`, `decision.consultation_requested`, `decision.consultation_responded` — and every other ceiling stays. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;
  SELECT count(*) INTO v_n
    FROM "_t4dii_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE s."effectKey" IN ('decision.published', 'decision.consultation_requested', 'decision.consultation_responded')
     AND c."pushRoles" IS NOT DISTINCT FROM s."pushRoles";
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: % of the three targeted ceilings this unit widens already carry the role at the prior generation % — the widening is what this generation IS, and a prior row that already holds it was written by a hand. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior;
  END IF;

  -- (4) and the prior generation is not RETIRED, unless 4d-iii has genuinely run
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_prior AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d ABORT: % row(s) of the prior generation % are already stamped retired, and `RolloutRetirement` does not carry `phase6-4d` — retirement is 4d-iii''s act, and a still-serving A7c process resolves its events through exactly these rows. Clear the stamps before this unit seeds beside them. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_prior;
    END IF;
  END IF;
END $t4dii_prior$;

-- ── THE TOTAL AUDIT OF WHAT IS ALREADY AT THIS GENERATION, AND OF EVERY OTHER ONE ───────────
-- U3's four arms, asked of THIS generation. The admitted set is now FOUR: 4d-i's two, U3's, this.
-- WITNESS-GATED like U3's: a later unit computes its own generation, and an ungated arm would abort
-- every replay from then on.
DO $t4dii_catalog$
DECLARE v_seed TEXT; v_prior TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dii_catalog_seed";
  SELECT "v" INTO v_prior FROM "_t4dii_catalog_prior";

  -- (0) FOREIGN GENERATIONS
  IF NOT phase6_t4d_retired_at_start() AND NOT phase6_t4d_ii_installed() THEN
    SELECT COALESCE(sum(q.n), 0)::BIGINT, COALESCE(left(string_agg(q.txt, ', ' ORDER BY q.txt), 200), '') INTO v_n, v_s
      FROM (SELECT count(*) AS n, format('%s (%s row(s))', x."coverageVersion", count(*)) AS txt
              FROM "ExternalEffectCatalog" x
             WHERE x."coverageVersion" <> v_seed AND x."coverageVersion" <> v_prior
               AND NOT EXISTS (SELECT 1 FROM "_t4dii_catalog_earlier" e WHERE e."v" = x."coverageVersion")
             GROUP BY x."coverageVersion") q;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d ABORT: % "ExternalEffectCatalog" row(s) sit in a coverage generation this rollout does not admit — %. Through 4d-ii-a the catalog holds exactly four generations: the two 4d-i seeded, the pairing generation U3 seeded (%) and the widened generation this unit seeds (%). The envelope seal resolves an event by the exact (coverageVersion, effectKey) it carries, so any other generation is a dispatch policy no release compiled. Remove the rows (or, on a database that has genuinely run a later unit or 4d-iii, restore its witness or marker) before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s, v_prior, v_seed;
    END IF;
  ELSE
    RAISE NOTICE 'phase6 4d-ii-a A7d: the dark window is CLOSED (retirement marker or 4d-ii writers present) — the foreign-generation audit is SKIPPED (a later unit legitimately computes its own generation)';
  END IF;

  -- (1) EXTRAS — a key at this generation this release did not compile
  SELECT count(*), COALESCE(left(string_agg(x."effectKey", ', ' ORDER BY x."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" x
   WHERE x."coverageVersion" = v_seed
     AND NOT EXISTS (SELECT 1 FROM "_t4dii_catalog_seed" s WHERE s."effectKey" = x."effectKey");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: % "ExternalEffectCatalog" row(s) already sit at this unit''s generation under a key this release never compiled — %. A generation holds exactly the keys its release compiled; remove these rows before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (2) DISAGREEMENT — a row already at this generation whose definition is not the compiled one
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dii_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: % "ExternalEffectCatalog" row(s) already exist at this unit''s generation and DISAGREE with the compiled catalog — %. The envelope, pairing and transition seals read these rows; adopting a definition this release did not compute would refuse valid events or admit unclaimed ones. Reconcile or remove the conflicting rows. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) PRE-RETIRED — a stamp on the generation this file is about to seed
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_seed AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d ABORT: % row(s) at this unit''s generation are already stamped retired — %. Retirement is 4d-iii''s act and `RolloutRetirement` does not carry this unit; the envelope seal refuses every event at a retired key. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s;
    END IF;
  END IF;
END $t4dii_catalog$;

-- ONE insert, the whole generation. `ON CONFLICT DO NOTHING` is safe only because the audit above
-- proved every pre-existing row at this generation equal to the seed.
INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired")
SELECT "coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily",
       "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired"
  FROM "_t4dii_catalog_seed"
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

-- AND THE SHAPE IS READ BACK from the table the seals will read: exactly nine `pairingRequired` keys
-- (U3's six and this unit's three) and exactly two frozen-audience families at this generation.
DO $t4dii_readback$
DECLARE v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dii_catalog_seed";
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."pairingRequired";
  IF v_n <> 9 OR v_s <> 'decision.approved, decision.awaiting_countersign, decision.change_requested, decision.change_withdrawn, decision.consultation_requested, decision.consultation_responded, decision.forwarded, decision.reapproved, membership.standing_changed' THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: after seeding, generation % carries `pairingRequired` on % key(s) (%) rather than exactly the nine — U3''s six and this unit''s three. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."frozenAudience";
  IF v_n <> 2 OR v_s <> 'decision.awaiting_countersign, decision.forwarded' THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: after seeding, generation % carries a frozen audience on % key(s) (%) rather than exactly the two frozen families. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
END $t4dii_readback$;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — `webpush.notify` 2 → 3, the DURABLE contract version (the 4c-ii / A7c precedent)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The compiled push consumer now recognises the `forward` and `countersign` families and sends to
-- the frozen `targetUserIds` set; a version-2 process would meet a frozen delivery it cannot judge
-- and fall through to a send no predicate re-judged. `syncConsumerCatalog` asserts the compiled
-- version at every start, so from this row's move a previous-release process is refused on EVERY
-- start. Guarded on the version it moves FROM; a fresh install (no row) is untouched.
UPDATE "OutboxConsumerCatalog" SET "catalogVersion" = 3
 WHERE "consumer" = 'webpush.notify' AND "catalogVersion" = 2;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — the persisted RULES, inside the rule-migration transition; `decisions.effects` INACTIVE
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A6c: a rule is written ONLY by a versioned catalog-data migration inside its own transaction —
-- `OutboxConsumerCatalog_t4d_rules` admits the rewrite while `platform_t4d_catalog_rule_migration_open()`
-- exists and its creating transaction is in progress. The literal below is PINNED to the compiled
-- consumers by `catalog-rules.test.ts` (this file's literals applied over A6c's, in ledger order,
-- must equal every compiled consumer's rule).
--
--   `decisions.inbox` — its compiled rule is `types` over `eventTypesUnder('decision.')`, and the
--   closed event list gained `decision.awaiting_countersign` and `decision.forwarded`. Guarded on
--   the EXACT A6c shape it moves from (the 4c-era nine), so a replay rewrites nothing and a row born
--   at the compiled rule (a fresh install) is left as born.
--
--   `decisions.effects` — REGISTERED HERE, INACTIVE (§A.2: "registered beside `decisions.inbox` —
--   INACTIVE by 4d-ii's catalog-data migration, ACTIVATED by 4d-iii's appended
--   `OutboxConsumerActivation` row once the fleet is drained, since a still-serving pre-4d-ii
--   process writes no row for a consumer it does not know and the delivery seal requires a row for
--   every ACTIVE consumer"). Its head (`seq = 1`, `active = false`) is appended by A6a's catalog-
--   INSERT trigger in this statement. Guarded on the row's ABSENCE, so a replay is a no-op and an
--   operator's later activation is never overridden. The registration barrier (A6c) serializes this
--   INSERT against every in-flight event.
DO $t4dii_rules$
DECLARE v_n BIGINT;
BEGIN
  EXECUTE 'CREATE FUNCTION platform_t4d_catalog_rule_migration_open() RETURNS void LANGUAGE sql AS ''SELECT''';

  UPDATE "OutboxConsumerCatalog" AS c
     SET "subscribedEventTypes" = r.types
    FROM (VALUES
      ('decisions.inbox', 'types', ARRAY['decision.approved', 'decision.awaiting_countersign', 'decision.change_requested', 'decision.change_withdrawn', 'decision.consultation_requested', 'decision.consultation_responded', 'decision.drafted', 'decision.forwarded', 'decision.published', 'decision.reapproved', 'decision.withdrawn']::TEXT[])
    ) AS r(consumer, rule, types)
   WHERE c."consumer" = r.consumer
     AND c."dispatchRule" = r.rule
     AND c."subscribedEventTypes" = ARRAY['decision.approved', 'decision.change_requested', 'decision.change_withdrawn', 'decision.consultation_requested', 'decision.consultation_responded', 'decision.drafted', 'decision.published', 'decision.reapproved', 'decision.withdrawn']::TEXT[];

  INSERT INTO "OutboxConsumerCatalog" ("consumer", "consumerKind", "consumerEffect", "catalogVersion", "active", "dispatchRule", "subscribedEventTypes", "registeredAt", "updatedAt")
  SELECT r.consumer, 'ordered', 'db', 1, false, r.rule, r.types, now(), now()
    FROM (VALUES
      ('decisions.effects', 'types', ARRAY['membership.standing_changed']::TEXT[])
    ) AS r(consumer, rule, types)
   WHERE NOT EXISTS (SELECT 1 FROM "OutboxConsumerCatalog" c WHERE c."consumer" = r.consumer);

  EXECUTE 'DROP FUNCTION platform_t4d_catalog_rule_migration_open()';

  SELECT count(*) INTO v_n FROM "OutboxConsumerCatalog"
   WHERE "consumer" = 'decisions.effects' AND "consumerKind" = 'ordered' AND "consumerEffect" = 'db'
     AND "catalogVersion" = 1 AND "dispatchRule" = 'types'
     AND "subscribedEventTypes" = ARRAY['membership.standing_changed']::TEXT[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d ABORT: the `decisions.effects` catalog row does not stand as this unit registers it (ordered / db / version 1 / `types` over exactly `membership.standing_changed`) — a row of another shape was here before this file, and `syncConsumerCatalog` would refuse every upgraded process at startup. See docs/RUNBOOK.md §P6T4D.';
  END IF;
END $t4dii_rules$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — THE CLAIMANTS of the three new pairing-required types, and the kernel actor seal
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── the architect-standing flip's `MembershipTransition` claims `membership.standing_changed` ─
-- §A.2 (the membership paragraph): "for every write that flips active architect standing ... exactly
-- ONE same-transaction `membership.standing_changed` event whose `entityId` is the membership, whose
-- payload `transitionId` is that fact's id, whose payload `membershipId`, `role`, `from` and `to`
-- equal the fact's ..., whose envelope `actorId`, `actorRole` and `actorName` equal the fact's actorId
-- and frozen pair, and whose payload `activeCount` equals the register's `activeCount` for
-- `(projectId, 'architect')` at commit". The FACT is the branch's primary record (present on every
-- instance: add, re-role, removal), so the fact claims. A FLIP is the fact's own shape: exactly one
-- end of the transition is `(architect, active)`. The immediate half claims when the event is
-- already written (the delivered commands write the fact FIRST and emit after the membership write,
-- so this half usually finds nothing); the DEFERRED half demands exactly one such event at commit
-- for a flip and NONE for a non-flip (a standing announced for a move that flipped nothing), reads
-- the register's head for the after-count, and claims. `platform_claim_event_pairing_once` makes the
-- two halves idempotent on the same (table, row).
CREATE OR REPLACE FUNCTION phase6_t4d_transition_claims_standing() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  -- an ADD's pre-state is NULL/NULL (no prior row): COALESCEd, so "not an active architect before"
  -- reads FALSE rather than NULL — an add in any other role flips nothing
  v_flip  BOOLEAN := (COALESCE(NEW."fromRole" = 'architect' AND NEW."fromStatus" = 'active', FALSE)
                      IS DISTINCT FROM COALESCE(NEW."toRole" = 'architect' AND NEW."toStatus" = 'active', FALSE));
  v_n     BIGINT;
  v_event TEXT;
  v_count INTEGER;
BEGIN
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Membership' AND e."entityId" = NEW."membershipId"
     AND e."eventType" = 'membership.standing_changed'
     AND e."xmin" = txid_current()::text::xid
     AND e."actorId" = NEW."actorId"
     AND e."actorRole" = NEW."actorRole" AND e."actorName" = NEW."actorName"
     AND e."payload" @> jsonb_build_object(
           'transitionId', NEW."id", 'membershipId', NEW."membershipId", 'role', 'architect',
           'from', jsonb_build_object('role', NEW."fromRole", 'status', NEW."fromStatus"),
           'to',   jsonb_build_object('role', NEW."toRole",   'status', NEW."toStatus"));

  IF NOT v_flip THEN
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d: membership transition % (user %, (%, %) → (%, %)) flips no architect standing, yet this transaction carries % `membership.standing_changed` event(s) naming it — a standing change is announced only for the write that activates or deactivates the chain, and a consumer deriving a crossing from this event would act on a move that made none',
        NEW."id", NEW."userId", COALESCE(NEW."fromRole", '<none>'), COALESCE(NEW."fromStatus", '<none>'), NEW."toRole", NEW."toStatus", v_n;
    END IF;
    RETURN NULL;
  END IF;

  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d: membership transition % (user %, (%, %) → (%, %)) flips the project''s architect standing, and this transaction carries % `membership.standing_changed` event(s) that name it (`payload.transitionId`), describe the same move (`membershipId`, `role`, `from`, `to`), are attributed to its actor (`actorId` and the frozen pair) and are about the membership (`entityType`/`entityId`) — a standing flip is announced exactly ONCE in the same transaction: every open tab refetches the countersign overlay from it and `decisions.effects` derives the re-notification and the last-architect cancellation from it, so a flip announced to nobody, or twice, is a chain the decisions module cannot see',
        NEW."id", NEW."userId", COALESCE(NEW."fromRole", '<none>'), COALESCE(NEW."fromStatus", '<none>'), NEW."toRole", NEW."toStatus", v_n;
    END IF;
    -- the after-count is the register's HEAD at commit: `Membership_t4d_architect_provenance`
    -- admits at most one standing-flipping write per project per transaction, so there is no
    -- intermediate value to disagree with (§A.2; #572 r20 f1)
    SELECT platform_role_standing(NEW."projectId", 'architect')::int INTO v_count;
    IF NOT EXISTS (SELECT 1 FROM "DomainEvent" e WHERE e."eventId" = v_event
                     AND jsonb_typeof(e."payload" -> 'activeCount') = 'number'
                     AND (e."payload" ->> 'activeCount')::int = v_count) THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d: the `membership.standing_changed` event % for transition % records an `activeCount` that is not the architect register''s head at commit (%) — `decisions.effects` classifies the crossing from that count (0 = the chain deactivated, 1 with an active architect arriving = activated), so a count the register does not hold would be acted on as a crossing that did not happen',
        v_event, NEW."id", v_count;
    END IF;
  END IF;

  IF v_n <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'MembershipTransition', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_claim" ON "MembershipTransition";
CREATE TRIGGER "MembershipTransition_t4d_claim"
  AFTER INSERT ON "MembershipTransition"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_transition_claims_standing();
DROP TRIGGER IF EXISTS "MembershipTransition_t4d_claim_deferred" ON "MembershipTransition";
CREATE CONSTRAINT TRIGGER "MembershipTransition_t4d_claim_deferred"
  AFTER INSERT ON "MembershipTransition" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_transition_claims_standing();

-- ── the `DecisionForward` fact claims `decision.forwarded` ──────────────────────────────────
-- The hand-off's one fact (4d-i's `DecisionForward_t4d_paired` already counts exactly one per
-- transaction and binds it to the holder at commit) claims the same-transaction `decision.forwarded`
-- of its decision whose payload names THIS row (`forwardId`) and whose `actorId` is the person the
-- row records as forwarding (`forwardedById`). A8a's `decisions.forward` writes both; the frozen
-- recipient set's correspondence to the new holder is 4d-iii's trailing seal (§D). Exactly one such
-- event at commit; a forward announced to nobody, or as another forward, is not this act.
CREATE OR REPLACE FUNCTION phase6_t4d_forward_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT; v_event TEXT;
BEGIN
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
     AND e."eventType" = 'decision.forwarded'
     AND e."actorId" = NEW."forwardedById"
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> jsonb_build_object('forwardId', NEW."id");
  IF TG_NAME LIKE '%\_deferred' AND v_n <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A7d: forward % of decision % was written in this transaction with % `decision.forwarded` event(s) that name it (`payload.forwardId`) and are attributed to its actor (`actorId` = `forwardedById`) — a hand-off is announced exactly ONCE, at its new holder, in the same transaction, in the name of the person who made it',
      NEW."id", NEW."decisionId", v_n;
  END IF;
  IF v_n <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionForward', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionForward_t4d_claim" ON "DecisionForward";
CREATE TRIGGER "DecisionForward_t4d_claim"
  AFTER INSERT ON "DecisionForward"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_claims_event();
DROP TRIGGER IF EXISTS "DecisionForward_t4d_claim_deferred" ON "DecisionForward";
CREATE CONSTRAINT TRIGGER "DecisionForward_t4d_claim_deferred"
  AFTER INSERT ON "DecisionForward" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_claims_event();

-- ── the revision claimant, re-issued: the PROVISIONAL birth claims `decision.awaiting_countersign` ─
-- U3 wrote "a PROVISIONAL birth (`finalized = false`) claims nothing here: its event is
-- `decision.awaiting_countersign`, a 4d-ii type declared with its claimant in that unit". This is
-- that unit. The FINALIZED arm is byte-identical to A7a's (20280102); the provisional arm mirrors it:
-- the head is the branch's primary fact on every instance (the approve under a chain from `pending`,
-- the chain reapproval from `change` — whose request CLOSURE verifies and never claims, U3's rule),
-- so it claims the one same-transaction countersign DEMAND of its decision attributed to its
-- approver and naming THIS head (`payload.revisionId`, the A7a arm made total for the new type,
-- which no previous release emits), beside exactly one `approved` / `reapproved` audit row (the
-- correspondence table pairs both kinds with `awaiting_countersign`). The re-notification's demand
-- is claimed by its audit row and never reaches here: no revision is born in that transaction.
CREATE OR REPLACE FUNCTION phase6_t4d_revision_claims_approval() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event TEXT; v_events BIGINT; v_audits BIGINT; v_named TEXT;
BEGIN
  IF NEW."finalized" IS DISTINCT FROM TRUE THEN
    -- 4d-ii-a / A7d — THE PROVISIONAL ARM
    SELECT count(*), max(e."eventId") INTO v_events, v_event
      FROM "DomainEvent" e
     WHERE e."projectId" = NEW."projectId"
       AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
       AND e."eventType" = 'decision.awaiting_countersign'
       AND e."actorId" = NEW."approvedById"
       AND e."xmin" = txid_current()::text::xid
       AND e."payload" @> jsonb_build_object('revisionId', NEW."id");
    IF TG_NAME LIKE '%\_deferred' THEN
      IF NEW."approvedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A7d: approval revision % of decision % was born PROVISIONAL in this transaction naming % as its approver, and this transaction carries % `decision.awaiting_countersign` event(s) attributed to that person (`actorId`) and naming this head (`payload.revisionId`) — a provisional approval IS the countersign demand and announces itself exactly ONCE, in the same transaction, in the approver''s name and for the revision it wrote: a head with no such event is a demand no architect is told of, one with two is a demand raised twice, and one whose head names no approver is an approval the register cannot pin to a person',
          NEW."id", NEW."decisionId", COALESCE(NEW."approvedById", '<nobody>'), v_events;
      END IF;
      v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['approved', 'reapproved']);
      IF v_audits <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A7d: approval revision % of decision % was born provisional in this transaction with % `approved` / `reapproved` audit row(s) — the approve under a chain appends the audit row beside the head and the demand, and the register, the fact and the stream record the SAME act',
          NEW."id", NEW."decisionId", v_audits;
      END IF;
    END IF;
    IF v_events <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
    PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionApprovalRevision', NEW."id");
    RETURN NULL;
  END IF;
  IF TG_NAME LIKE '%\_deferred' THEN
    -- ONE act, ONE actor (#590 round 4; Codex U3 round 1). The finalized head carries a
    -- `DecisionEvent` audit row, but 4d-i's `DecisionEvent_t4d_correspondence` binds the event's
    -- actor to the fact ONLY when the fact names one — it SKIPS a NULL `approvedById` (made total
    -- only at 4d-iii) — so a finalized head born with a NULL approver and a human-attributed event
    -- would commit with the announcement bound to nobody. The claimant binds it here, as the
    -- consultation and countersign_rejection arms bind theirs: exactly ONE approval-family event
    -- attributed to the approver the head records (`approvedById`), and that approver present.
    v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                ARRAY['decision.approved', 'decision.reapproved'], NEW."approvedById");
    IF NEW."approvedById" IS NULL OR v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: approval revision % of decision % was born finalized in this transaction naming % as its approver, and this transaction carries % approval-family event(s) (`decision.approved` / `decision.reapproved`) attributed to that person (`actorId`) — the finalized head IS the approval and announces itself exactly ONCE, in the same transaction, in the name of the approver it records: a head with no such event is an approval the stream never carried, one with two is an act announced twice, and one whose head names no approver (or whose event is attributed to someone else) is an approval the register cannot pin to a person',
        NEW."id", NEW."decisionId", COALESCE(NEW."approvedById", '<nobody>'), v_events;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['approved', 'reapproved']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: approval revision % of decision % was born finalized in this transaction with % `approved` / `reapproved` audit row(s) — the delivered `approve` appends the audit row beside the head and the event, and the register, the fact and the stream record the SAME act: a head with no audit row is an approval the decision log cannot show',
        NEW."id", NEW."decisionId", v_audits;
    END IF;
  END IF;
  v_event := phase6_t4d_tx_actor_event(NEW."projectId", NEW."decisionId",
                                       ARRAY['decision.approved', 'decision.reapproved'], NEW."approvedById");
  IF v_event IS NULL THEN RETURN NULL; END IF;   -- the immediate half, before the event (or a NULL approver): the deferred half decides
  -- 4d-ii-a / A7a — THE EVENT NAMES THIS REVISION (#665's review round 1, the P1 finding). From A7a
  -- the direct approve's `decision.approved` / `decision.reapproved` payload carries `revisionId`,
  -- the exact revision the act wrote, and the kinded green notice renders its approver facts (the
  -- option, the on-behalf fact) from the revision the event names. The claims above bind the event
  -- to a same-transaction finalized head of THIS decision by type, entity and actor, but the payload
  -- is a JSON field no seal read: a receipt-backed bundle could write a valid head, audit row and
  -- event whose `revisionId` named ANOTHER decision's revision (or an older one of this decision),
  -- and the feed would render that revision's option under this decision's title. So the named
  -- revision must be the head this transaction is claiming for. ABSENT, it is admitted: a
  -- still-serving previous-release process emits the family with no `revisionId` through the drain
  -- (the plan's fallback to the same-transaction head, made required at 4d-iii), and the reader
  -- renders no green notice from an event that names none — an omission, never a forged fact.
  SELECT e."payload" ->> 'revisionId' INTO v_named
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId" AND e."eventId" = v_event;
  IF v_named IS NOT NULL AND v_named IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A7a: approval event % of decision % names revision `%` as the one its act wrote, but the finalized head born in this transaction is % — the green notice renders the approver facts from the revision the event names, so an event naming any other revision (another decision''s, or an older one of this decision) announces facts this act did not produce',
      v_event, NEW."decisionId", v_named, NEW."id";
  END IF;
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionApprovalRevision', NEW."id");
  RETURN NULL;
END $$;

-- ── U1's kernel actor seal, re-issued with the re-notification's ONE exemption ──────────────
-- `DomainEvent_t4d_pairing_actor` says a pairingRequired event names the human who acted. The
-- `decisions.effects` re-emit of `decision.awaiting_countersign` is the plan's one SYSTEM act among
-- the sealed types (§A.2: "attributed to the envelope's system actor `system:membership-standing`
-- with the crossing event's id and `transitionId` in its payload — the human act is recoverable by
-- an auditor from the immutable `MembershipTransition` fact the event names"). U1 was written while
-- the type was not compiled; this is the unit that compiles it. The exemption is as narrow as the
-- act: that system actor, that type, `payload.renotified = true`, a `transitionId`, and a
-- `crossingEventId` that names a `membership.standing_changed` event of the SAME project (committed,
-- or this transaction's) — read from the kernel's own table, so the kernel still installs nothing
-- that reads a module's. The claim itself stays demanded by `DomainEvent_t4d_pairing_claimed`
-- (4d-i's `DecisionEvent_t4d_renotified_claim` is the claimant) and the crossing's uniqueness per
-- decision by 4d-i's `DecisionEvent_countersign_renotified_key`. Every other pairingRequired event
-- is judged exactly as U1 wrote it.
CREATE OR REPLACE FUNCTION platform_t4d_event_pairing_actor() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_required BOOLEAN;
BEGIN
  SELECT c."pairingRequired" INTO v_required
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = NEW."dispatchIntent" ->> 'coverageVersion'
     AND c."effectKey"       = NEW."dispatchIntent" ->> 'effectKey';
  IF v_required IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;

  -- 4d-ii-a / A7d — the re-notification: a system act bound to the crossing it names
  IF NEW."actorKind" = 'system' AND NEW."systemActor" = 'system:membership-standing'
     AND NEW."eventType" = 'decision.awaiting_countersign'
     AND NEW."payload" ->> 'renotified' = 'true' THEN
    IF NEW."payload" ->> 'transitionId' IS NULL
       OR NOT EXISTS (SELECT 1 FROM "DomainEvent" x
                       WHERE x."projectId" = NEW."projectId"
                         AND x."eventId" = NEW."payload" ->> 'crossingEventId'
                         AND x."eventType" = 'membership.standing_changed') THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A7d: event % is a countersign re-notification (`renotified`) attributed to `system:membership-standing`, but its payload does not name the crossing it answers — `crossingEventId` must be a `membership.standing_changed` event of project % and `transitionId` the transition that event names; a re-notification bound to no crossing is a standalone demand the relay would send',
        NEW."eventId", NEW."projectId";
    END IF;
    RETURN NULL;
  END IF;

  -- A paired event records one person's act; its envelope must name that person. A `system`
  -- announcement with `actorId = NULL` is exactly the shape the round-4 defect let commit beside
  -- a fact approved by a real user.
  IF NEW."actorKind" IS DISTINCT FROM 'human' OR NEW."actorId" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i-b: event % of type `%` is pairingRequired but is attributed to actorKind=% / actorId=% — a paired event records one person''s act and its envelope must name a human actor, never a system announcement with no actor',
      NEW."eventId", NEW."eventType", COALESCE(NEW."actorKind", '<null>'), COALESCE(NEW."actorId", '<null>');
  END IF;
  RETURN NULL;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 5 — FAIL CLOSED ON ITS OWN INSTALLATION
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $verify$
DECLARE n integer; v_src text; v_seed text;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dii_catalog_seed";
  SELECT count(*) INTO n FROM "ExternalEffectCatalog" WHERE "coverageVersion" = v_seed;
  IF n <> (SELECT count(*) FROM "_t4dii_catalog_seed") THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: generation % holds % row(s) after seeding, not the whole compiled catalog. The deploy is refused.', v_seed, n;
  END IF;
  SELECT count(*) INTO n FROM "OutboxConsumerCatalog" WHERE "consumer" = 'webpush.notify' AND "catalogVersion" <> 3;
  IF n <> 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: the persisted webpush.notify contract is not at version 3 after this migration — syncConsumerCatalog would refuse every upgraded process at startup. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n FROM "OutboxConsumerCatalog"
   WHERE "consumer" = 'decisions.inbox' AND NOT ("subscribedEventTypes" @> ARRAY['decision.awaiting_countersign', 'decision.forwarded']::TEXT[]);
  IF n <> 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: the persisted decisions.inbox rule does not carry the two decision types this release compiles — syncConsumerCatalog would refuse every upgraded process at startup. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n FROM "OutboxConsumerCatalog" c
    JOIN "OutboxConsumerActivation" a ON a."consumer" = c."consumer" AND a."seq" = c."activationSeq"
   WHERE c."consumer" = 'decisions.effects' AND NOT c."active" AND NOT a."active";
  IF n <> 1 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: `decisions.effects` is not registered INACTIVE with its activation head in the register after this migration. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgqual IS NULL AND t.tgtype = 5
     AND ((c.relname = 'MembershipTransition' AND p.proname = 'phase6_t4d_transition_claims_standing'
             AND ((t.tgname = 'MembershipTransition_t4d_claim' AND NOT t.tgdeferrable)
               OR (t.tgname = 'MembershipTransition_t4d_claim_deferred' AND t.tgdeferrable AND t.tginitdeferred)))
       OR (c.relname = 'DecisionForward' AND p.proname = 'phase6_t4d_forward_claims_event'
             AND ((t.tgname = 'DecisionForward_t4d_claim' AND NOT t.tgdeferrable)
               OR (t.tgname = 'DecisionForward_t4d_claim_deferred' AND t.tgdeferrable AND t.tginitdeferred)))
       OR (c.relname = 'DecisionApprovalRevision' AND p.proname = 'phase6_t4d_revision_claims_approval'
             AND ((t.tgname = 'DecisionApprovalRevision_t4d_claim' AND NOT t.tgdeferrable)
               OR (t.tgname = 'DecisionApprovalRevision_t4d_claim_deferred' AND t.tgdeferrable AND t.tginitdeferred)))
       OR (c.relname = 'DomainEvent' AND p.proname = 'platform_t4d_event_pairing_actor'
             AND t.tgname = 'DomainEvent_t4d_pairing_actor'));
  IF n <> 7 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: the three claimants and the kernel actor seal are not standing as this file installs them (found % of the 7 required triggers). The deploy is refused.', n;
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'phase6_t4d_revision_claims_approval';
  IF v_src IS NULL OR position('THE PROVISIONAL ARM' in v_src) = 0 OR position('names revision' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: the revision claimant does not carry both the provisional arm and A7a''s revision-naming arm after this file ran. The deploy is refused.';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'platform_t4d_event_pairing_actor';
  IF v_src IS NULL OR position('system:membership-standing' in v_src) = 0 OR position('never a system announcement' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A7d: the kernel actor seal does not carry the re-notification exemption beside U1''s rule after this file ran. The deploy is refused.';
  END IF;
END
$verify$;

COMMIT;
