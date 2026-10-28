-- Hub #1118 U5m — THE CATALOG GENERATION for the two Hub drawing keys, seeded beside the current one.
--
-- WHAT. A later unit (U5k) adds two keys to `apps/api/src/platform/external-effects.ts`, both on event
-- types that already exist, so the projection rule does not move:
--   · `drawing.superseded_hub` — eventType `drawing.revised`, invalidate, no push;
--   · `drawing.relinked`       — eventType `drawing.refiled`, invalidate, no push.
-- Neither is pairing-required (the existing `drawing.revised` and `drawing.refiled` keys are not). A new
-- key changes `canonicalCatalog()`'s preimage, so the compiled `effectCoverageVersion()` will move from
-- SV1-a's `f9ebcd07…` to `63679450…`. This file seeds THAT generation now, ALONE and AHEAD of the code
-- that compiles it, beside SV1-a's — audited key by key against the generation it extends: exactly the
-- two keys ADDED, every shared key EQUAL in every column.
--
-- WHY AHEAD, AND WHY ALONE. `DomainEvent_t4d_envelope` resolves an event by the exact (coverageVersion,
-- effectKey) its intent carries, so a process compiled with the new catalog cannot emit under a
-- generation the database does not hold. Seeding it in its own release means the release that compiles
-- it finds it already present, and nothing in THIS release reads it: every runtime reader of
-- "ExternalEffectCatalog" (the envelope seal, `platform_t4d_event_pairing_claimed`,
-- `platform_t4d_event_pairing_actor`, the delivery seals) resolves the exact pair, and no application
-- code reads the table. The previous release keeps emitting under SV1-a's generation, which this file
-- does not touch, so it keeps booting and emitting while this release rolls out.
--
-- WHAT THIS FILE DOES NOT DO: no key is compiled (U5k), no consumer contract version moves, no rule,
-- claimant or seal function is installed or re-issued, nothing is retired.
--
-- THE RESEAL IS NOT THIS FILE'S, AND NOT THIS RELEASE'S: this release compiles the same catalog as the
-- previous one, so the `OutboxCutoverState` seal still matches. U5k moves the compiled version and owns
-- the RUNBOOK reseal (docs/RUNBOOK.md §"catalog changed").
--
-- Re-runnable: the seed is ON CONFLICT DO NOTHING behind a total audit of what already sits at this
-- generation, and every check reads state rather than assuming a first run. ONE TRANSACTION: the seed
-- lives in `ON COMMIT DROP` temp tables, so the file is all-or-nothing under Prisma and under `psql -f`.
--
-- REPLAY OF SV1-a. SV1-a's file is on ALWAYS_EXECUTE and its immutable foreign-generation audit admits
-- the five generations it knew; it stands down only on the retirement marker or the serving witness.
-- On a ledger-lost database that carries THIS generation and never served, its replay would refuse
-- these rows, so `scripts/migrate.sh` resolves SV1-a's catalog file as applied on such a database (this
-- file's prerequisite is SV1-a's generation, so its presence evidences SV1-a ran), the rule A7d and
-- SV1-a established one generation earlier each.
--
-- The VALUES literal below is generated from source plus the two declared keys and pinned to it by
-- `src/platform/external-effect-catalog-seed.test.ts` (eleven columns, A7d's format); the generation
-- itself is re-derived by `test/integration/phase6-t4d-i-catalog-generations.test.ts`.

BEGIN;

-- ── THE PREREQUISITE IS SV1-a's GENERATION, VERIFIED, NOT ASSUMED ───────────────────────────
DO $hub_u5m_prereq$
DECLARE v_fn TEXT; v_missing TEXT := ''; v_n BIGINT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['phase6_t4d_retired_at_start', 'phase6_t4d_ii_installed'] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM "ExternalEffectCatalog"
   WHERE "coverageVersion" = 'f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36';
  IF v_missing <> '' OR v_n = 0 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: this generation extends Site Visits SV1-a''s (f9ebcd07…), and this database holds % row(s) of it (missing functions: %). 20280111000000_site_visits_sv1a_catalog applies before this file in the ledger, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES it from ALWAYS_EXECUTE. Apply it first. See docs/RUNBOOK.md §P6T4D.',
      v_n, CASE WHEN v_missing = '' THEN 'none' ELSE v_missing END;
  END IF;
END $hub_u5m_prereq$;

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

-- THE LITERAL LANDS IN A TEMP TABLE FIRST, AND THE TEMP TABLE IS THE AUTHORITY (4d-i's, U3's, A7d's and
-- SV1-a's rule): the WHOLE generation, one row per key, the eight-element preimage's version.
CREATE TEMP TABLE "_hub_catalog_seed" (
    "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
    "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL,
    "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL,
    PRIMARY KEY ("coverageVersion", "effectKey")
) ON COMMIT DROP;

INSERT INTO "_hub_catalog_seed" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.created.init', 'activity.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.awaiting_countersign', 'decision.awaiting_countersign', true, '["architect"]'::jsonb, 'countersign', true, true, 'frozen', 'A decision awaits your countersign', true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.consultation_requested', 'decision.consultation_requested', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.consultation_responded', 'decision.consultation_responded', true, '["architect","pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.forwarded', 'decision.forwarded', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'forward', true, true, 'frozen', 'A decision has been forwarded to you', true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.published', 'decision.published', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.published.record', 'decision.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.relinked', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.superseded_hub', 'drawing.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.approved.closing', 'inspection.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.created.init', 'inspection.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'membership.standing_changed', 'membership.standing_changed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.attendee_added', 'sitevisit.attendee_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.attendee_retired', 'sitevisit.attendee_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.closed', 'sitevisit.closed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.ended', 'sitevisit.ended', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.late_end_recorded', 'sitevisit.late_end_recorded', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.place_added', 'sitevisit.place_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.place_retired', 'sitevisit.place_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'sitevisit.started', 'sitevisit.started', true, NULL, NULL, false, false, NULL, NULL, true),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
;

-- THE GENERATION THIS ONE EXTENDS, named once: `f9ebcd07…` is SV1-a's seed. A7d's (`23f47cd9…`), U3's
-- (`7dac2bd5…`) and 4d-i's two (`842cc9fc…` incoming, `6313b00c…` outgoing) stay ADMITTED beside it.
-- `phase6-t4d-i-catalog-generations.test.ts` re-derives all six from source on every run.
CREATE TEMP TABLE "_hub_catalog_prior" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_hub_catalog_prior" ("v") VALUES ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36');
CREATE TEMP TABLE "_hub_catalog_earlier" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_hub_catalog_earlier" ("v") VALUES
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c'),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61'),
  ('842cc9fcbbd7920b169ef79266680d38f9cd48cc1acf9ea5d02c2f8b242f22a9'),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7');
-- The two keys this generation ADDS, named once, each with the existing event type it rides on.
CREATE TEMP TABLE "_hub_catalog_added" ("k" TEXT PRIMARY KEY, "eventType" TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO "_hub_catalog_added" ("k", "eventType") VALUES
  ('drawing.relinked', 'drawing.refiled'), ('drawing.superseded_hub', 'drawing.revised');

-- ── THIS SEED IS THE DECLARED SUCCESSOR OF SV1-a's GENERATION ───────────────────────────────
--   (1) the prior generation is PRESENT, over exactly this seed's keys MINUS the two added;
--   (2) the two ADDED keys are exactly the declared two, with the declared shape;
--   (3) every SHARED key is equal in EVERY column (this generation moves no existing definition);
--   (4) the prior generation is not RETIRED, unless 4d-iii has genuinely run.
DO $hub_u5m_prior$
DECLARE v_prior TEXT; v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT "v" INTO v_prior FROM "_hub_catalog_prior";
  SELECT count(DISTINCT "coverageVersion") INTO v_n FROM "_hub_catalog_seed";
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'hub U5m ABORT: the seed literal carries % coverage versions; a generation is exactly one.', v_n;
  END IF;
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_hub_catalog_seed";
  IF v_seed = v_prior OR EXISTS (SELECT 1 FROM "_hub_catalog_earlier" e WHERE e."v" = v_seed) THEN
    RAISE EXCEPTION
      'hub U5m ABORT: the seed literal names an EARLIER generation (%) as its own — it was regenerated from an earlier catalog. This unit seeds a NEW generation; re-derive the literal from `external-effects.ts` plus the two Hub keys.',
      v_seed;
  END IF;

  -- (1) the prior generation is PRESENT, over exactly the seed's keys minus the added two
  SELECT count(*), COALESCE(left(string_agg(q.k, ', ' ORDER BY q.k), 200), '') INTO v_n, v_s
    FROM (SELECT s."effectKey" AS k FROM "_hub_catalog_seed" s
           WHERE NOT EXISTS (SELECT 1 FROM "_hub_catalog_added" a WHERE a."k" = s."effectKey")
             AND NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                              WHERE c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND NOT EXISTS (SELECT 1 FROM "_hub_catalog_seed" s WHERE s."effectKey" = c."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND EXISTS (SELECT 1 FROM "_hub_catalog_added" a WHERE a."k" = c."effectKey")) q;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: the prior generation % this unit extends does not carry exactly this seed''s keys minus the two Hub keys — % key(s) differ (%). This unit ADDS exactly two keys and retires none; a key set that moved otherwise needs its own generation with its own audit. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;

  -- (2) the ADDED keys, exactly as declared: an existing event type, invalidate, never push, unclaimed
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_hub_catalog_seed" s JOIN "_hub_catalog_added" a ON a."k" = s."effectKey"
   WHERE NOT (s."eventType" = a."eventType" AND s."invalidate"
              AND s."pushRoles" IS NULL AND s."pushFamily" IS NULL AND NOT s."frozenAudience" AND NOT s."requiresPush"
              AND s."audience" IS NULL AND s."pushBody" IS NULL AND NOT s."pairingRequired");
  IF v_n > 0 OR (SELECT count(*) FROM "_hub_catalog_seed" s JOIN "_hub_catalog_added" a ON a."k" = s."effectKey") <> 2 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: the two keys this unit adds are not declared as stated (% disagree: %) — each rides its existing drawing event type, invalidates, never pushes and owes no pairing claim. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) every SHARED key equal in every column
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_hub_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: % shared key(s) of this seed differ from the prior generation % (%). This generation only ADDS two keys; a definition that changed is a different release''s generation and must be seeded and audited as one. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior, v_s;
  END IF;

  -- (4) and the prior generation is not RETIRED, unless 4d-iii has genuinely run
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_prior AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'hub U5m ABORT: % row(s) of the prior generation % are already stamped retired, and `RolloutRetirement` does not carry `phase6-4d` — retirement is 4d-iii''s act, and the release still serving (and this one) resolves its events through exactly these rows. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_prior;
    END IF;
  END IF;
END $hub_u5m_prior$;

-- ── THE TOTAL AUDIT OF WHAT IS ALREADY AT THIS GENERATION, AND OF EVERY OTHER ONE ───────────
-- SV1-a's four arms, asked of THIS generation. The admitted set is now SIX: 4d-i's two, U3's, A7d's,
-- SV1-a's (the prior) and this one. WITNESS-GATED like SV1-a's: a later unit computes its own
-- generation, and an ungated arm would abort every replay from then on.
DO $hub_u5m_catalog$
DECLARE v_seed TEXT; v_prior TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_hub_catalog_seed";
  SELECT "v" INTO v_prior FROM "_hub_catalog_prior";

  -- (0) FOREIGN GENERATIONS
  IF NOT phase6_t4d_retired_at_start() AND NOT phase6_t4d_ii_installed() THEN
    SELECT COALESCE(sum(q.n), 0)::BIGINT, COALESCE(left(string_agg(q.txt, ', ' ORDER BY q.txt), 200), '') INTO v_n, v_s
      FROM (SELECT count(*) AS n, format('%s (%s row(s))', x."coverageVersion", count(*)) AS txt
              FROM "ExternalEffectCatalog" x
             WHERE x."coverageVersion" <> v_seed AND x."coverageVersion" <> v_prior
               AND NOT EXISTS (SELECT 1 FROM "_hub_catalog_earlier" e WHERE e."v" = x."coverageVersion")
             GROUP BY x."coverageVersion") q;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'hub U5m ABORT: % "ExternalEffectCatalog" row(s) sit in a coverage generation this rollout does not admit — %. Through U5m the catalog holds exactly six generations: the two 4d-i seeded, U3''s, A7d''s, SV1-a''s (%) and the one this unit seeds (%). Remove the rows (or, on a database that has genuinely run a later unit or 4d-iii, restore its witness or marker) before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s, v_prior, v_seed;
    END IF;
  ELSE
    RAISE NOTICE 'hub U5m: the dark window is CLOSED (retirement marker or 4d-ii writers present) — the foreign-generation audit is SKIPPED (a later unit legitimately computes its own generation)';
  END IF;

  -- (1) EXTRAS — a key at this generation this seed does not declare
  SELECT count(*), COALESCE(left(string_agg(x."effectKey", ', ' ORDER BY x."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" x
   WHERE x."coverageVersion" = v_seed
     AND NOT EXISTS (SELECT 1 FROM "_hub_catalog_seed" s WHERE s."effectKey" = x."effectKey");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: % "ExternalEffectCatalog" row(s) already sit at this unit''s generation under a key this seed does not declare — %. Remove them before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (2) DISAGREEMENT — a row already at this generation whose definition is not the seeded one
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_hub_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'hub U5m ABORT: % "ExternalEffectCatalog" row(s) already exist at this unit''s generation and DISAGREE with the seed — %. The envelope, pairing and transition seals read these rows; reconcile or remove them. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) PRE-RETIRED — a stamp on the generation this file is about to seed
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_seed AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'hub U5m ABORT: % row(s) at this unit''s generation are already stamped retired — %. Retirement is 4d-iii''s act; the envelope seal refuses every event at a retired key. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s;
    END IF;
  END IF;
END $hub_u5m_catalog$;

-- ONE insert, the whole generation. `ON CONFLICT DO NOTHING` is safe only because the audit above
-- proved every pre-existing row at this generation equal to the seed.
INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired")
SELECT "coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily",
       "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired"
  FROM "_hub_catalog_seed"
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

-- AND THE SHAPE IS READ BACK from the table the seals will read, failing closed: exactly the seed's
-- row count, exactly SV1-a's seventeen `pairingRequired` keys (the two added owe no claim), exactly
-- A7d's two frozen-audience families, and every row equal to the seed.
DO $hub_u5m_readback$
DECLARE v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_hub_catalog_seed";
  SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed;
  IF v_n <> (SELECT count(*) FROM "_hub_catalog_seed") OR v_n <> 124 THEN
    RAISE EXCEPTION 'hub U5m ABORT: after seeding, generation % holds % row(s), not the 124 the seed declares. See docs/RUNBOOK.md §P6T4D.', v_seed, v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM "_hub_catalog_seed" s
    LEFT JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE c."effectKey" IS NULL
      OR (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired", c."retiredAt" IS NULL)
         IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired", true);
  IF v_n > 0 AND NOT phase6_t4d_retired_at_start() THEN
    RAISE EXCEPTION 'hub U5m ABORT: after seeding, % row(s) of generation % are missing, retired or differ from the seed. See docs/RUNBOOK.md §P6T4D.', v_n, v_seed;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."pairingRequired";
  IF v_n <> 17 OR v_s <> 'decision.approved, decision.awaiting_countersign, decision.change_requested, decision.change_withdrawn, decision.consultation_requested, decision.consultation_responded, decision.forwarded, decision.reapproved, membership.standing_changed, sitevisit.attendee_added, sitevisit.attendee_retired, sitevisit.closed, sitevisit.ended, sitevisit.late_end_recorded, sitevisit.place_added, sitevisit.place_retired, sitevisit.started' THEN
    RAISE EXCEPTION
      'hub U5m ABORT: after seeding, generation % carries `pairingRequired` on % key(s) (%) rather than exactly SV1-a''s seventeen. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."frozenAudience";
  IF v_n <> 2 OR v_s <> 'decision.awaiting_countersign, decision.forwarded' THEN
    RAISE EXCEPTION
      'hub U5m ABORT: after seeding, generation % carries a frozen audience on % key(s) (%) rather than exactly A7d''s two frozen families. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
END $hub_u5m_readback$;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

COMMIT;
