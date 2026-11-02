-- "Who fixes this?" RM-e-m — THE CATALOG GENERATION for `inspection.responsible_set`, seeded beside the current one.
--
-- WHAT. A later unit (RM-e-c) adds one key to `apps/api/src/platform/external-effects.ts`:
--   · `inspection.responsible_set` — a NEW event type of the same name, invalidate, no push.
-- It is not pairing-required (no fact claims it). `setResponsible` (#1297) emits it so that every open
-- tab of the project refreshes when a PMC or engineer names, or clears, who fixes an inspection. A new
-- key changes `canonicalCatalog()`'s preimage, so the compiled `effectCoverageVersion()` will move from
-- SV1-a's `f9ebcd07…` to `e356309f…`. This file seeds THAT generation now, ALONE and AHEAD of the code
-- that compiles it, beside SV1-a's — audited key by key against the generation it extends: exactly the
-- one key ADDED, every shared key EQUAL in every column.
--
-- BESIDE HUB U5m, NOT ON TOP OF IT. Hub U5m (20280127) seeded `63679450…` = SV1-a's keys plus the two Hub
-- drawing keys, for U5k, which is parked. This generation extends SV1-a's, not U5m's: it carries neither
-- Hub key. When U5k resumes it must seed a generation over whatever the source then compiles (SV1-a's
-- keys, this key and the two Hub keys) with its own file, one step later; `notes/hub/u5k/README.md`.
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
-- WHAT THIS FILE DOES NOT DO: no key is compiled (RM-e-c), no event type is emitted, no consumer contract
-- version moves, no rule, claimant or seal function is installed or re-issued, nothing is retired.
--
-- THE RESEAL IS NOT THIS FILE'S, AND NOT THIS RELEASE'S: this release compiles the same catalog as the
-- previous one, so the `OutboxCutoverState` seal still matches. RM-e-c moves the compiled version and owns
-- the RUNBOOK reseal (docs/RUNBOOK.md §"catalog changed").
--
-- Re-runnable: the seed is ON CONFLICT DO NOTHING behind a total audit of what already sits at this
-- generation, and every check reads state rather than assuming a first run. ONE TRANSACTION: the seed
-- lives in `ON COMMIT DROP` temp tables, so the file is all-or-nothing under Prisma and under `psql -f`.
--
-- REPLAY OF U5m (AND, THROUGH U5m's RULE, OF SV1-a). U5m's file is on ALWAYS_EXECUTE and its immutable
-- foreign-generation audit admits the six generations it knew; it stands down only on the retirement
-- marker or the serving witness. On a ledger-lost database that carries THIS generation and never served,
-- its replay would refuse these rows, so `scripts/migrate.sh` resolves U5m's catalog file as applied on
-- such a database. This file's prerequisite is U5m's generation as well as SV1-a's, so its presence
-- evidences U5m ran (and U5m's presence already resolves SV1-a's catalog file): the rule A7d, SV1-a and
-- U5m established one generation earlier each.
--
-- The VALUES literal below is generated from source plus the one declared key and pinned to it by
-- `src/platform/external-effect-catalog-seed.test.ts` (eleven columns, A7d's format); the generation
-- itself is re-derived by `test/integration/phase6-t4d-i-catalog-generations.test.ts`.

BEGIN;

-- ── THE PREREQUISITE IS SV1-a's GENERATION AND U5m's, VERIFIED, NOT ASSUMED ─────────────────
-- SV1-a's is the generation this one extends. U5m's is required too, so that a database holding THIS
-- generation is evidence that U5m's catalog file ran to completion: that is what lets the runner resolve
-- U5m's file as applied on a ledger-lost restore (scripts/migrate.sh).
DO $rme_prereq$
DECLARE v_fn TEXT; v_missing TEXT := ''; v_sv1a BIGINT; v_hub BIGINT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['phase6_t4d_retired_at_start', 'phase6_t4d_ii_installed'] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_sv1a FROM "ExternalEffectCatalog"
   WHERE "coverageVersion" = 'f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36';
  SELECT count(*) INTO v_hub FROM "ExternalEffectCatalog"
   WHERE "coverageVersion" = '63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848';
  IF v_missing <> '' OR v_sv1a = 0 OR v_hub = 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: this generation extends Site Visits SV1-a''s (f9ebcd07…) and requires Hub U5m''s (63679450…) beside it, and this database holds % row(s) of SV1-a''s and % of U5m''s (missing functions: %). 20280111000000_site_visits_sv1a_catalog and 20280127000000_hub_catalog_generation apply before this file in the ledger, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES them from ALWAYS_EXECUTE. Apply them first. See docs/RUNBOOK.md §P6T4D.',
      v_sv1a, v_hub, CASE WHEN v_missing = '' THEN 'none' ELSE v_missing END;
  END IF;
END $rme_prereq$;

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

-- THE LITERAL LANDS IN A TEMP TABLE FIRST, AND THE TEMP TABLE IS THE AUTHORITY (4d-i's, U3's, A7d's,
-- SV1-a's and U5m's rule): the WHOLE generation, one row per key, the eight-element preimage's version.
CREATE TEMP TABLE "_rme_catalog_seed" (
    "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
    "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL,
    "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL,
    PRIMARY KEY ("coverageVersion", "effectKey")
) ON COMMIT DROP;

INSERT INTO "_rme_catalog_seed" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.created.init', 'activity.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.awaiting_countersign', 'decision.awaiting_countersign', true, '["architect"]'::jsonb, 'countersign', true, true, 'frozen', 'A decision awaits your countersign', true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.consultation_requested', 'decision.consultation_requested', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.consultation_responded', 'decision.consultation_responded', true, '["architect","pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.forwarded', 'decision.forwarded', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'forward', true, true, 'frozen', 'A decision has been forwarded to you', true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.published', 'decision.published', true, '["architect","client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.published.record', 'decision.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.approved.closing', 'inspection.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.created.init', 'inspection.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.responsible_set', 'inspection.responsible_set', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'membership.standing_changed', 'membership.standing_changed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.attendee_added', 'sitevisit.attendee_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.attendee_retired', 'sitevisit.attendee_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.closed', 'sitevisit.closed', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.ended', 'sitevisit.ended', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.late_end_recorded', 'sitevisit.late_end_recorded', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.place_added', 'sitevisit.place_added', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.place_retired', 'sitevisit.place_retired', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'sitevisit.started', 'sitevisit.started', true, NULL, NULL, false, false, NULL, NULL, true),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('e356309f11ec2e865a5a68f0f89c9baa52f88ab69898f3578ac7356c34147093', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
;

-- THE GENERATION THIS ONE EXTENDS, named once: `f9ebcd07…` is SV1-a's seed. Hub U5m's (`63679450…`, its
-- sibling, also over SV1-a's), A7d's (`23f47cd9…`), U3's (`7dac2bd5…`) and 4d-i's two (`842cc9fc…`
-- incoming, `6313b00c…` outgoing) stay ADMITTED beside it. `phase6-t4d-i-catalog-generations.test.ts`
-- re-derives all seven from source on every run.
CREATE TEMP TABLE "_rme_catalog_prior" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_rme_catalog_prior" ("v") VALUES ('f9ebcd074cd453c00ba9b806ae1e6488f17a8c34ab79ed4b4836055bd534dd36');
CREATE TEMP TABLE "_rme_catalog_earlier" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_rme_catalog_earlier" ("v") VALUES
  ('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848'),
  ('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c'),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61'),
  ('842cc9fcbbd7920b169ef79266680d38f9cd48cc1acf9ea5d02c2f8b242f22a9'),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7');
-- The one key this generation ADDS, named once, with its own new event type.
CREATE TEMP TABLE "_rme_catalog_added" ("k" TEXT PRIMARY KEY, "eventType" TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO "_rme_catalog_added" ("k", "eventType") VALUES
  ('inspection.responsible_set', 'inspection.responsible_set');

-- ── THIS SEED IS THE DECLARED SUCCESSOR OF SV1-a's GENERATION ───────────────────────────────
--   (1) the prior generation is PRESENT, over exactly this seed's keys MINUS the one added;
--   (2) the ADDED key is exactly the declared one, with the declared shape, on an event type no
--       admitted generation carries yet;
--   (3) every SHARED key is equal in EVERY column (this generation moves no existing definition);
--   (4) the prior generation is not RETIRED, unless 4d-iii has genuinely run.
DO $rme_prior$
DECLARE v_prior TEXT; v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT "v" INTO v_prior FROM "_rme_catalog_prior";
  SELECT count(DISTINCT "coverageVersion") INTO v_n FROM "_rme_catalog_seed";
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'inspection RM-e ABORT: the seed literal carries % coverage versions; a generation is exactly one.', v_n;
  END IF;
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_rme_catalog_seed";
  IF v_seed = v_prior OR EXISTS (SELECT 1 FROM "_rme_catalog_earlier" e WHERE e."v" = v_seed) THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: the seed literal names an EARLIER generation (%) as its own — it was regenerated from an earlier catalog. This unit seeds a NEW generation; re-derive the literal from `external-effects.ts` plus `inspection.responsible_set`.',
      v_seed;
  END IF;

  -- (1) the prior generation is PRESENT, over exactly the seed's keys minus the added one
  SELECT count(*), COALESCE(left(string_agg(q.k, ', ' ORDER BY q.k), 200), '') INTO v_n, v_s
    FROM (SELECT s."effectKey" AS k FROM "_rme_catalog_seed" s
           WHERE NOT EXISTS (SELECT 1 FROM "_rme_catalog_added" a WHERE a."k" = s."effectKey")
             AND NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                              WHERE c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND NOT EXISTS (SELECT 1 FROM "_rme_catalog_seed" s WHERE s."effectKey" = c."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND EXISTS (SELECT 1 FROM "_rme_catalog_added" a WHERE a."k" = c."effectKey")) q;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: the prior generation % this unit extends does not carry exactly this seed''s keys minus `inspection.responsible_set` — % key(s) differ (%). This unit ADDS exactly one key and retires none; a key set that moved otherwise needs its own generation with its own audit. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;

  -- (2) the ADDED key, exactly as declared: its own event type, invalidate, never push, unclaimed; and
  --     that event type is NEW — no admitted generation (and no other key of this seed) carries it
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_rme_catalog_seed" s JOIN "_rme_catalog_added" a ON a."k" = s."effectKey"
   WHERE NOT (s."eventType" = a."eventType" AND s."invalidate"
              AND s."pushRoles" IS NULL AND s."pushFamily" IS NULL AND NOT s."frozenAudience" AND NOT s."requiresPush"
              AND s."audience" IS NULL AND s."pushBody" IS NULL AND NOT s."pairingRequired");
  IF v_n > 0 OR (SELECT count(*) FROM "_rme_catalog_seed" s JOIN "_rme_catalog_added" a ON a."k" = s."effectKey") <> 1 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: the key this unit adds is not declared as stated (% disagree: %) — it rides its own new event type, invalidates, never pushes and owes no pairing claim. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(left(string_agg(DISTINCT x."effectKey", ', '), 200), '') INTO v_n, v_s
    FROM (SELECT c."effectKey", c."eventType" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
              OR EXISTS (SELECT 1 FROM "_rme_catalog_earlier" e WHERE e."v" = c."coverageVersion")
          UNION ALL
          SELECT s."effectKey", s."eventType" FROM "_rme_catalog_seed" s
           WHERE NOT EXISTS (SELECT 1 FROM "_rme_catalog_added" a WHERE a."k" = s."effectKey")) x
   WHERE x."eventType" IN (SELECT a."eventType" FROM "_rme_catalog_added" a);
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: the event type this unit introduces is already carried by % row(s) of an admitted generation or another key of this seed (%). It must be new: the existing keys of that type would change meaning under it. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) every SHARED key equal in every column
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_rme_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: % shared key(s) of this seed differ from the prior generation % (%). This generation only ADDS one key; a definition that changed is a different release''s generation and must be seeded and audited as one. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior, v_s;
  END IF;

  -- (4) and the prior generation is not RETIRED, unless 4d-iii has genuinely run
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_prior AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'inspection RM-e ABORT: % row(s) of the prior generation % are already stamped retired, and `RolloutRetirement` does not carry `phase6-4d` — retirement is 4d-iii''s act, and the release still serving (and this one) resolves its events through exactly these rows. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_prior;
    END IF;
  END IF;
END $rme_prior$;

-- ── THE TOTAL AUDIT OF WHAT IS ALREADY AT THIS GENERATION, AND OF EVERY OTHER ONE ───────────
-- U5m's four arms, asked of THIS generation. The admitted set is now SEVEN: 4d-i's two, U3's, A7d's,
-- SV1-a's (the prior), U5m's (the sibling) and this one. WITNESS-GATED like U5m's: a later unit computes
-- its own generation, and an ungated arm would abort every replay from then on.
DO $rme_catalog$
DECLARE v_seed TEXT; v_prior TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_rme_catalog_seed";
  SELECT "v" INTO v_prior FROM "_rme_catalog_prior";

  -- (0) FOREIGN GENERATIONS
  IF NOT phase6_t4d_retired_at_start() AND NOT phase6_t4d_ii_installed() THEN
    SELECT COALESCE(sum(q.n), 0)::BIGINT, COALESCE(left(string_agg(q.txt, ', ' ORDER BY q.txt), 200), '') INTO v_n, v_s
      FROM (SELECT count(*) AS n, format('%s (%s row(s))', x."coverageVersion", count(*)) AS txt
              FROM "ExternalEffectCatalog" x
             WHERE x."coverageVersion" <> v_seed AND x."coverageVersion" <> v_prior
               AND NOT EXISTS (SELECT 1 FROM "_rme_catalog_earlier" e WHERE e."v" = x."coverageVersion")
             GROUP BY x."coverageVersion") q;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'inspection RM-e ABORT: % "ExternalEffectCatalog" row(s) sit in a coverage generation this rollout does not admit — %. Through RM-e the catalog holds exactly seven generations: the two 4d-i seeded, U3''s, A7d''s, SV1-a''s (%), Hub U5m''s and the one this unit seeds (%). Remove the rows (or, on a database that has genuinely run a later unit or 4d-iii, restore its witness or marker) before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s, v_prior, v_seed;
    END IF;
  ELSE
    RAISE NOTICE 'inspection RM-e: the dark window is CLOSED (retirement marker or 4d-ii writers present) — the foreign-generation audit is SKIPPED (a later unit legitimately computes its own generation)';
  END IF;

  -- (1) EXTRAS — a key at this generation this seed does not declare
  SELECT count(*), COALESCE(left(string_agg(x."effectKey", ', ' ORDER BY x."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" x
   WHERE x."coverageVersion" = v_seed
     AND NOT EXISTS (SELECT 1 FROM "_rme_catalog_seed" s WHERE s."effectKey" = x."effectKey");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: % "ExternalEffectCatalog" row(s) already sit at this unit''s generation under a key this seed does not declare — %. Remove them before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (2) DISAGREEMENT — a row already at this generation whose definition is not the seeded one
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_rme_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: % "ExternalEffectCatalog" row(s) already exist at this unit''s generation and DISAGREE with the seed — %. The envelope, pairing and transition seals read these rows; reconcile or remove them. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) PRE-RETIRED — a stamp on the generation this file is about to seed
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_seed AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'inspection RM-e ABORT: % row(s) at this unit''s generation are already stamped retired — %. Retirement is 4d-iii''s act; the envelope seal refuses every event at a retired key. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s;
    END IF;
  END IF;
END $rme_catalog$;

-- ONE insert, the whole generation. `ON CONFLICT DO NOTHING` is safe only because the audit above
-- proved every pre-existing row at this generation equal to the seed.
INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired")
SELECT "coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily",
       "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired"
  FROM "_rme_catalog_seed"
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

-- AND THE SHAPE IS READ BACK from the table the seals will read, failing closed: exactly the seed's
-- row count, exactly SV1-a's seventeen `pairingRequired` keys (the added one owes no claim), exactly
-- A7d's two frozen-audience families, and every row equal to the seed.
DO $rme_readback$
DECLARE v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_rme_catalog_seed";
  SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed;
  IF v_n <> (SELECT count(*) FROM "_rme_catalog_seed") OR v_n <> 123 THEN
    RAISE EXCEPTION 'inspection RM-e ABORT: after seeding, generation % holds % row(s), not the 123 the seed declares. See docs/RUNBOOK.md §P6T4D.', v_seed, v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM "_rme_catalog_seed" s
    LEFT JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE c."effectKey" IS NULL
      OR (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired", c."retiredAt" IS NULL)
         IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired", true);
  IF v_n > 0 AND NOT phase6_t4d_retired_at_start() THEN
    RAISE EXCEPTION 'inspection RM-e ABORT: after seeding, % row(s) of generation % are missing, retired or differ from the seed. See docs/RUNBOOK.md §P6T4D.', v_n, v_seed;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."pairingRequired";
  IF v_n <> 17 OR v_s <> 'decision.approved, decision.awaiting_countersign, decision.change_requested, decision.change_withdrawn, decision.consultation_requested, decision.consultation_responded, decision.forwarded, decision.reapproved, membership.standing_changed, sitevisit.attendee_added, sitevisit.attendee_retired, sitevisit.closed, sitevisit.ended, sitevisit.late_end_recorded, sitevisit.place_added, sitevisit.place_retired, sitevisit.started' THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: after seeding, generation % carries `pairingRequired` on % key(s) (%) rather than exactly SV1-a''s seventeen. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c WHERE c."coverageVersion" = v_seed AND c."frozenAudience";
  IF v_n <> 2 OR v_s <> 'decision.awaiting_countersign, decision.forwarded' THEN
    RAISE EXCEPTION
      'inspection RM-e ABORT: after seeding, generation % carries a frozen audience on % key(s) (%) rather than exactly A7d''s two frozen families. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
END $rme_readback$;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

COMMIT;
