-- Site Visits #792 SV1-a — THE CATALOG GENERATION for the eight site-visit event types.
--
-- WHAT. `apps/api/src/platform/external-effects.ts` gains eight keys, one per new domain event type
-- (`sitevisit.started`, `.ended`, `.closed`, `.late_end_recorded`, `.place_added`, `.place_retired`,
-- `.attendee_added`, `.attendee_retired`), each `invalidate: true, push: null, pairingRequired: true`.
-- A new key changes `canonicalCatalog()`'s preimage, so the compiled `effectCoverageVersion()` moves
-- from A7d's `23f47cd9…` to `f9ebcd07…`. This file seeds that generation BESIDE A7d's — A7d's rows stay
-- for the drain (a still-serving A7d-era process emits under them) — audited key by key against the
-- generation it extends: exactly the eight keys ADDED, every shared key EQUAL in every column.
--
-- WHY. `DomainEvent_t4d_envelope` resolves an event by the exact (coverageVersion, effectKey) its
-- intent carries, and `DomainEvent_t4d_pairing_claimed` reads `pairingRequired` from the same row. A
-- process compiled with this catalog cannot emit under a generation the database does not hold, and
-- the site-visits claimant triggers (installed by `20280112000000_site_visits_sv1a_record`) are what
-- satisfy the pairing obligation these rows declare.
--
-- WHAT THIS FILE DOES NOT DO (A7d's Parts 2–4 have no counterpart here): no consumer contract version
-- moves (no push family is added, so `webpush.notify` reads nothing new), no persisted rule is
-- rewritten, no claimant is installed here (the record migration owns them), and the kernel actor
-- seal is not re-issued.
--
-- THE RESEAL IS NOT THIS FILE'S (docs/RUNBOOK.md §"catalog changed"): the `OutboxCutoverState` seal
-- names a coverage version and `OutboxBootstrap` refuses `OUTBOX_SENDER_MODE=outbox` while it differs
-- from the compiled catalog; a migration cannot supply the operator identity or the build hash. Deploy
-- in `legacy`/`shadow`, `outbox:status` clean, `outbox:seal-external`, then restart in `outbox`.
--
-- Re-runnable: the seed is ON CONFLICT DO NOTHING behind a total audit of what already sits at this
-- generation, and every check reads state rather than assuming a first run. ONE TRANSACTION: the seed
-- lives in `ON COMMIT DROP` temp tables, so the file is all-or-nothing under Prisma and under `psql -f`.
--
-- The VALUES literal below is generated from source and pinned to it by
-- `src/platform/external-effect-catalog-seed.test.ts` (eleven columns, A7d's format), and the
-- generation itself is re-derived by `test/integration/phase6-t4d-i-catalog-generations.test.ts`.

BEGIN;

-- ── THE PREREQUISITE IS A7d's GENERATION, VERIFIED, NOT ASSUMED ─────────────────────────────
DO $sv1a_prereq$
DECLARE v_fn TEXT; v_missing TEXT := ''; v_n BIGINT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['phase6_t4d_retired_at_start', 'phase6_t4d_ii_installed', 'phase6_t4d_forward_claims_event'] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM "ExternalEffectCatalog"
   WHERE "coverageVersion" = '23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c';
  IF v_missing <> '' OR v_n = 0 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: this generation extends 4d-ii-a / A7d''s (23f47cd9…), and this database holds % row(s) of it (missing functions: %). 20280104000000_phase6_t4d_ii_a7d_catalog_change applies before this file in the ledger, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES it from ALWAYS_EXECUTE. Apply it first. See docs/RUNBOOK.md §P6T4D.',
      v_n, CASE WHEN v_missing = '' THEN 'none' ELSE v_missing END;
  END IF;
END $sv1a_prereq$;

-- ── THE RETIREMENT SNAPSHOT (A7d's rule, against the same artifact) ──────────────────────────
DO $snapshot$
BEGIN
  PERFORM set_config('vitan.phase6_4d_retired_at_start',
                     CASE WHEN EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d')
                           AND to_regproc('phase6_t4d_change_request_paired') IS NOT NULL
                          THEN 'on' ELSE 'off' END, true);
END $snapshot$;

-- The catalog INSERT gate (4d-i's `ExternalEffectCatalog` seal) admits rows only under this setting.
SELECT set_config('vitan.phase6_4d_catalog', 'on', true);

-- THE LITERAL LANDS IN A TEMP TABLE FIRST, AND THE TEMP TABLE IS THE AUTHORITY (4d-i's, U3's and A7d's
-- rule): the WHOLE generation, one row per compiled key, the eight-element preimage's version.
CREATE TEMP TABLE "_sv1a_catalog_seed" (
    "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
    "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL,
    "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL,
    PRIMARY KEY ("coverageVersion", "effectKey")
) ON COMMIT DROP;

INSERT INTO "_sv1a_catalog_seed" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.created.init', 'activity.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.awaiting_countersign', 'decision.awaiting_countersign', true, '["architect"]'::jsonb, 'countersign', true, true, 'frozen', 'A decision awaits your countersign', true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.consultation_requested', 'decision.consultation_requested', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.consultation_responded', 'decision.consultation_responded', true, '["architect","pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.forwarded', 'decision.forwarded', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'forward', true, true, 'frozen', 'A decision has been forwarded to you', true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.published', 'decision.published', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.published.record', 'decision.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.approved.closing', 'inspection.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.created.init', 'inspection.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'membership.standing_changed', 'membership.standing_changed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.attendee_added', 'sitevisit.attendee_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.attendee_retired', 'sitevisit.attendee_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.closed', 'sitevisit.closed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.ended', 'sitevisit.ended', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.late_end_recorded', 'sitevisit.late_end_recorded', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.place_added', 'sitevisit.place_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.place_retired', 'sitevisit.place_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'sitevisit.started', 'sitevisit.started', true, NULL, NULL, false, false, NULL, NULL, true),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
;

-- THE GENERATION THIS ONE EXTENDS, named once: `23f47cd9…` is A7d's seed. U3's (`7dac2bd5…`) and
-- 4d-i's two (`842cc9fc…` incoming, `6313b00c…` outgoing) stay ADMITTED beside it.
-- `phase6-t4d-i-catalog-generations.test.ts` re-derives all five from source on every run.
CREATE TEMP TABLE "_sv1a_catalog_prior" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_sv1a_catalog_prior" ("v") VALUES ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c');
CREATE TEMP TABLE "_sv1a_catalog_earlier" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_sv1a_catalog_earlier" ("v") VALUES
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61'),
  ('842cc9fcbbd7920b169ef79266680d38f9cd48cc1acf9ea5d02c2f8b242f22a9'),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7');
-- The eight keys this generation ADDS, named once.
CREATE TEMP TABLE "_sv1a_catalog_added" ("k" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_sv1a_catalog_added" ("k") VALUES
  ('sitevisit.attendee_added'), ('sitevisit.attendee_retired'), ('sitevisit.closed'), ('sitevisit.ended'),
  ('sitevisit.late_end_recorded'), ('sitevisit.place_added'), ('sitevisit.place_retired'), ('sitevisit.started');

-- ── THIS SEED IS THE DECLARED SUCCESSOR OF A7d's GENERATION ─────────────────────────────────
--   (1) the prior generation is PRESENT, over exactly this seed's keys MINUS the eight added;
--   (2) the eight ADDED keys are exactly the declared eight, with the declared shape;
--   (3) every SHARED key is equal in EVERY column (this generation moves no existing definition);
--   (4) the prior generation is not RETIRED, unless 4d-iii has genuinely run.
DO $sv1a_prior$
DECLARE v_prior TEXT; v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT "v" INTO v_prior FROM "_sv1a_catalog_prior";
  SELECT count(DISTINCT "coverageVersion") INTO v_n FROM "_sv1a_catalog_seed";
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'site-visits SV1-a ABORT: the seed literal carries % coverage versions; a generation is exactly one.', v_n;
  END IF;
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_sv1a_catalog_seed";
  IF v_seed = v_prior OR EXISTS (SELECT 1 FROM "_sv1a_catalog_earlier" e WHERE e."v" = v_seed) THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: the seed literal names an EARLIER generation (%) as its own — it was regenerated from an earlier catalog. This unit compiles a NEW generation; re-derive the literal from `external-effects.ts`.',
      v_seed;
  END IF;

  -- (1) the prior generation is PRESENT, over exactly the seed's keys minus the added eight
  SELECT count(*), COALESCE(left(string_agg(q.k, ', ' ORDER BY q.k), 200), '') INTO v_n, v_s
    FROM (SELECT s."effectKey" AS k FROM "_sv1a_catalog_seed" s
           WHERE NOT EXISTS (SELECT 1 FROM "_sv1a_catalog_added" a WHERE a."k" = s."effectKey")
             AND NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                              WHERE c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND NOT EXISTS (SELECT 1 FROM "_sv1a_catalog_seed" s WHERE s."effectKey" = c."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND EXISTS (SELECT 1 FROM "_sv1a_catalog_added" a WHERE a."k" = c."effectKey")) q;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: the prior generation % this unit extends does not carry exactly this seed''s keys minus the eight site-visit keys — % key(s) differ (%). This unit ADDS exactly eight keys and retires none; a key set that moved otherwise needs its own generation with its own audit. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;

  -- (2) the ADDED keys, exactly as declared: invalidate, never push, claimed by their facts
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_sv1a_catalog_seed" s JOIN "_sv1a_catalog_added" a ON a."k" = s."effectKey"
   WHERE NOT (s."eventType" = s."effectKey" AND s."invalidate"
              AND s."pushRoles" IS NULL AND s."pushFamily" IS NULL AND NOT s."frozenAudience" AND NOT s."requiresPush"
              AND s."audience" IS NULL AND s."pushBody" IS NULL AND s."pairingRequired");
  IF v_n > 0 OR (SELECT count(*) FROM "_sv1a_catalog_seed" s JOIN "_sv1a_catalog_added" a ON a."k" = s."effectKey") <> 8 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: the eight keys this unit adds are not declared as stated (% disagree: %) — each is its own event type, invalidates, never pushes and is claimed by its site-visits fact. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) every SHARED key equal in every column
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_sv1a_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: % shared key(s) of this seed differ from the prior generation % (%). This generation only ADDS eight keys; a definition that changed is a different release''s generation and must be seeded and audited as one. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior, v_s;
  END IF;

  -- (4) and the prior generation is not RETIRED, unless 4d-iii has genuinely run
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_prior AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'site-visits SV1-a ABORT: % row(s) of the prior generation % are already stamped retired, and `RolloutRetirement` does not carry `phase6-4d` — retirement is 4d-iii''s act, and a still-serving A7d-era process resolves its events through exactly these rows. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_prior;
    END IF;
  END IF;
END $sv1a_prior$;

-- ── THE TOTAL AUDIT OF WHAT IS ALREADY AT THIS GENERATION, AND OF EVERY OTHER ONE ───────────
-- A7d's four arms, asked of THIS generation. The admitted set is now FIVE: 4d-i's two, U3's, A7d's
-- (the prior) and this one. WITNESS-GATED like A7d's: a later unit computes its own generation, and an
-- ungated arm would abort every replay from then on.
DO $sv1a_catalog$
DECLARE v_seed TEXT; v_prior TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_sv1a_catalog_seed";
  SELECT "v" INTO v_prior FROM "_sv1a_catalog_prior";

  -- (0) FOREIGN GENERATIONS
  IF NOT phase6_t4d_retired_at_start() AND NOT phase6_t4d_ii_installed() THEN
    SELECT COALESCE(sum(q.n), 0)::BIGINT, COALESCE(left(string_agg(q.txt, ', ' ORDER BY q.txt), 200), '') INTO v_n, v_s
      FROM (SELECT count(*) AS n, format('%s (%s row(s))', x."coverageVersion", count(*)) AS txt
              FROM "ExternalEffectCatalog" x
             WHERE x."coverageVersion" <> v_seed AND x."coverageVersion" <> v_prior
               AND NOT EXISTS (SELECT 1 FROM "_sv1a_catalog_earlier" e WHERE e."v" = x."coverageVersion")
             GROUP BY x."coverageVersion") q;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'site-visits SV1-a ABORT: % "ExternalEffectCatalog" row(s) sit in a coverage generation this rollout does not admit — %. Through SV1-a the catalog holds exactly five generations: the two 4d-i seeded, U3''s, A7d''s (%) and the one this unit seeds (%). Remove the rows (or, on a database that has genuinely run a later unit or 4d-iii, restore its witness or marker) before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s, v_prior, v_seed;
    END IF;
  ELSE
    RAISE NOTICE 'site-visits SV1-a: the dark window is CLOSED (retirement marker or 4d-ii writers present) — the foreign-generation audit is SKIPPED (a later unit legitimately computes its own generation)';
  END IF;

  -- (1) EXTRAS — a key at this generation this release did not compile
  SELECT count(*), COALESCE(left(string_agg(x."effectKey", ', ' ORDER BY x."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" x
   WHERE x."coverageVersion" = v_seed
     AND NOT EXISTS (SELECT 1 FROM "_sv1a_catalog_seed" s WHERE s."effectKey" = x."effectKey");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: % "ExternalEffectCatalog" row(s) already sit at this unit''s generation under a key this release never compiled — %. Remove them before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (2) DISAGREEMENT — a row already at this generation whose definition is not the compiled one
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_sv1a_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: % "ExternalEffectCatalog" row(s) already exist at this unit''s generation and DISAGREE with the compiled catalog — %. The envelope, pairing and transition seals read these rows; reconcile or remove them. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) PRE-RETIRED — a stamp on the generation this file is about to seed
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_seed AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'site-visits SV1-a ABORT: % row(s) at this unit''s generation are already stamped retired — %. Retirement is 4d-iii''s act; the envelope seal refuses every event at a retired key. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s;
    END IF;
  END IF;
END $sv1a_catalog$;

-- ONE insert, the whole generation. `ON CONFLICT DO NOTHING` is safe only because the audit above
-- proved every pre-existing row at this generation equal to the seed.
INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired")
SELECT "coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily",
       "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired"
  FROM "_sv1a_catalog_seed"
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

-- AND THE SHAPE IS READ BACK from the table the seals will read, failing closed: exactly the seed's
-- row count, exactly seventeen `pairingRequired` keys (A7d's nine and this unit's eight), exactly
-- A7d's two frozen-audience families, and every row equal to the seed.
DO $sv1a_readback$
DECLARE v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_sv1a_catalog_seed";
  SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed;
  IF v_n <> (SELECT count(*) FROM "_sv1a_catalog_seed") OR v_n <> 122 THEN
    RAISE EXCEPTION 'site-visits SV1-a ABORT: after seeding, generation % holds % row(s), not the 122 the compiled catalog declares. See docs/RUNBOOK.md §P6T4D.', v_seed, v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM "_sv1a_catalog_seed" s
    LEFT JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE c."effectKey" IS NULL
      OR (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired", c."retiredAt" IS NULL)
         IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired", true);
  IF v_n > 0 AND NOT phase6_t4d_retired_at_start() THEN
    RAISE EXCEPTION 'site-visits SV1-a ABORT: after seeding, % row(s) of generation % are missing, retired or differ from the seed. See docs/RUNBOOK.md §P6T4D.', v_n, v_seed;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."pairingRequired";
  IF v_n <> 17 OR v_s <> 'decision.approved, decision.awaiting_countersign, decision.change_requested, decision.change_withdrawn, decision.consultation_requested, decision.consultation_responded, decision.forwarded, decision.reapproved, membership.standing_changed, sitevisit.attendee_added, sitevisit.attendee_retired, sitevisit.closed, sitevisit.ended, sitevisit.late_end_recorded, sitevisit.place_added, sitevisit.place_retired, sitevisit.started' THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: after seeding, generation % carries `pairingRequired` on % key(s) (%) rather than exactly the seventeen — A7d''s nine and this unit''s eight. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."frozenAudience";
  IF v_n <> 2 OR v_s <> 'decision.awaiting_countersign, decision.forwarded' THEN
    RAISE EXCEPTION
      'site-visits SV1-a ABORT: after seeding, generation % carries a frozen audience on % key(s) (%) rather than exactly A7d''s two frozen families. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
END $sv1a_readback$;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

COMMIT;
