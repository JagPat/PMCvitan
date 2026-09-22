-- Phase 6 task 4d, unit 4d-i-b — U3: THE PAIRING FLIP, WITH ITS CLAIMANTS, TOGETHER
-- (docs/superpowers/plans/2026-09-21-4d-i-b-additive-units.md §U3, and the §D 4d-i-b inventory
-- (b)+(c) — the third and final additive unit of the switch-on the owner carved out of #590).
--
-- U1 (20271222000000) installed the bound-event/actor primitive and the dormant DomainEvent actor
-- seal. U2 (20271223000000) installed the change-request bundle seals — request-side and
-- decision-side — and the transition recorders, all JUDGING and CLAIMING nothing, dark behind
-- `phase6_t4d_change_pairing_active()`. Both are on main and refuse nothing in production, because
-- no coverage generation carries `pairingRequired = true` yet. THIS FILE PERFORMS THE FLIP, and
-- with it installs every claimant the six flipped types need — because flipping a type to
-- `pairingRequired` without its claimant refuses every legitimate event of that type at commit,
-- and installing a claimant for a type still `false` claims into a register nothing reads. These
-- two are the pair §D calls inseparable, and they ship as ONE unit.
--
-- ITS INVENTORY IS §D's (c) and (b), and ONLY the part U1 and U2 did not deliver:
--
--   (c) THE FLIP, delivered as a NEW COVERAGE GENERATION. The six decision types are already
--       committed `false` at `842cc9fc…` (4d-i's generation) and
--       `ExternalEffectCatalog_t4d_sealed` admits no UPDATE but the retirement stamp, so
--       `pairingRequired` joined the compiled catalog's `canonicalCatalog()` PREIMAGE
--       (`apps/api/src/platform/external-effects.ts`), which moves `effectCoverageVersion()` from
--       `842cc9fc…` to the generation seeded below, `pairingRequired` true on EXACTLY the plan's
--       six types, every other column of every key equal to 4d-i's row. That is the ONE successor
--       shape 4d-i's catalog audit admits by derivation, and the audit below proves this seed IS
--       that shape against the deployed prior generation rather than assuming it. The two 4d-i
--       generations stay exactly as they are — a still-serving 4d-i process keeps resolving its
--       rows through the version its intents carry. NOTHING IS RETIRED HERE.
--
--   (b) `platform_claim_event_pairing_once` and every claimant the six types need beside their
--       fact: the request's own two claims (re-added to `phase6_t4d_change_request_paired`, which
--       U2 installed JUDGING only), the request's immediate `ChangeRequest_t4d_claim`, the
--       finalized `DecisionApprovalRevision` birth's claim of `decision.approved`/`.reapproved`,
--       and the consultation request/response claims of their two families — each order-
--       independent (an immediate `AFTER INSERT` half and a `DEFERRED` constraint half through
--       `platform_claim_event_pairing_once`), each lookup through U1's actor primitive, each
--       bundle judged by U2's seals. The ONE conditional `countersign_rejection` claim is decided
--       at COMMIT (not a `returned` `DecisionStrandedResolution`).
--
-- WHAT IS NOT HERE, because U1 and U2 already carry it: the recorders and readers
-- (`phase6_t4d_decision_change_here`, `phase6_t4d_change_request_here`, the `_moved_in_tx`
-- readers, `phase6_t4d_tx_audit_count`), the actor primitives (`phase6_t4d_tx_actor_event`,
-- `_count`) and the decision-side seal `phase6_t4d_change_transition_paired` — that seal is
-- UNCHANGED by this file: it judges only, and the flip below is what ACTIVATES it (its gate reads
-- the catalog this file writes). The diff surface under `src/` is EXACTLY the compiled catalog's
-- six `pairingRequired` declarations and the preimage change (c) requires; it adds no table and
-- no column.
--
-- ORDERED after both U1 and U2 and DEPENDENT ON BOTH (and on 4d-i beneath them): it seeds beside
-- 4d-i's generations, claims through 4d-i's primitive, reads U2's carrier and U1's actor lookup,
-- and is judged by 4d-i's kernel seal and U2's bundle seals. The prerequisite audit below refuses
-- to run over a database that holds none of that. RE-RUNNABLE (`CREATE OR REPLACE`,
-- `DROP TRIGGER IF EXISTS`, `ON CONFLICT DO NOTHING`) and MARKER-AWARE on the same terms as its
-- partners. The claimants here are PERMANENT; 4d-iii replaces by name what it replaces.

BEGIN;

-- ── THE DEPLOYMENT WINDOW, ALL-OR-NOTHING, BEFORE ANYTHING ELSE ─────────────────────────────
-- The shape both 4d-i halves and U1/U2 take (#582's rounds 8, 36 and 37): every PRE-EXISTING
-- table this file takes a lock on, in ONE `NOWAIT` acquisition inside a subtransaction, so a
-- partial set is released by the exception rollback, retried, and after the cap the migration
-- FAILS CLOSED — clean and re-runnable. This transaction is then never a waiting party on these
-- tables, so it cannot be one side of a deadlock with a serving command.
--
-- The set is derived from this file's own DDL and enforced by the harness's round-36/37 oracles
-- (the census reads `pg_locks`): the FOUR tables that gain a trigger below —
-- `ChangeRequest` (the re-added immediate claim), `DecisionApprovalRevision`,
-- `DecisionConsultation` and `DecisionConsultationResponse` (their claimants). NOT `Decision`:
-- the decision-side seal is U2's and unchanged here, and the flip's catalog INSERT contends with
-- nothing (RowExclusive). The request-side seal is a `CREATE OR REPLACE FUNCTION` its existing
-- trigger already points at.
DO $t4d_window$
DECLARE attempts INT := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "ChangeRequest",
                 "DecisionApprovalRevision",
                 "DecisionConsultation",
                 "DecisionConsultationResponse"
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 600 THEN
        RAISE EXCEPTION 'phase6 4d-i-b U3: could not obtain the deployment window on the four pre-existing tables after % attempts — retry the deploy when writer traffic quiets. Nothing has been changed. See docs/RUNBOOK.md §P6T4D.', attempts;
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
END $t4d_window$;


-- ── THE PREREQUISITES ARE 4d-i's, U1's AND U2's, AND THEY ARE VERIFIED, NOT ASSUMED ─────────
-- Every claimant and the flipped request seal below CALLS one of these. A plpgsql body is not
-- validated at CREATE time, so a claimant calling a primitive that is not there would fail on the
-- first real approval, in production, rather than here. The set is the PRIMITIVES the bodies call
-- — five from 4d-i's registers half, two from its decisions half, the two actor primitives U1
-- adds, and the four change-lifecycle primitives U2 adds — so a database missing 4d-i, U1 or U2 is
-- named. UNGATED: the dependency holds at every stage. It runs BEFORE the retirement snapshot
-- below, because the snapshot reads `RolloutRetirement`, which 4d-i creates.
DO $t4dib_prereq$
DECLARE v_fn TEXT; v_missing TEXT := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'platform_claim_event_pairing', 'platform_tx_event', 'platform_tx_event_count',
    'phase6_t4d_retired_at_start', 'phase6_t4d_ii_installed',
    'phase6_t4d_decision_approved_in_tx', 'phase6_t4d_decision_awaiting_in_tx',
    'phase6_t4d_tx_actor_event', 'phase6_t4d_tx_actor_event_count',
    'phase6_t4d_change_pairing_active', 'phase6_t4d_decision_moved_in_tx',
    'phase6_t4d_requests_moved_in_tx', 'phase6_t4d_tx_audit_count'
  ] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'phase6 4d-i-b U3 ABORT: this unit flips a mechanism 4d-i, U1 and U2 install, and this database holds none of: %. 4d-i''s two halves (20271220000000, 20271221000000) and U1 (20271222000000) and U2 (20271223000000) apply before this file, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES them from ALWAYS_EXECUTE for exactly this reason. Apply them first. See docs/RUNBOOK.md §P6T4D.',
      v_missing;
  END IF;
END $t4dib_prereq$;

-- ── THE RETIREMENT SNAPSHOT, TAKEN AGAIN, AGAINST THIS FILE'S OWN ARTIFACT ──────────────────
-- `phase6_t4d_retired_at_start()` reads a TRANSACTION-LOCAL setting (#582's round 3, finding 1,
-- and round 16, finding 2 for why each file re-takes it): the earlier units' settings died with
-- their commits, and an unset predicate reads "not retired", which is the wrong answer on a
-- genuinely retired database. Round 7's design, applied per file: the verdict names an artifact
-- THIS file's family creates (`phase6_t4d_change_request_paired`, on main since U2) and is taken
-- here. A forged marker on a db-push baseline reads FALSE (no such function yet on a pre-4d-i-b
-- base) and every audit runs; a genuine retirement reads TRUE.
DO $snapshot$
BEGIN
  PERFORM set_config('vitan.phase6_4d_retired_at_start',
                     CASE WHEN EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d')
                           AND to_regproc('phase6_t4d_change_request_paired') IS NOT NULL
                          THEN 'on' ELSE 'off' END, true);
END $snapshot$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — (c) THE FLIP, AS A NEW COVERAGE GENERATION
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- The catalog gate 4d-i's INSERT arm requires: a migration DECLARES itself, and nothing else
-- writes. Transaction-local (`is_local = true`), so a failed apply leaves no gate open.
SELECT set_config('vitan.phase6_4d_catalog', 'on', true);

-- THE LITERAL LANDS IN A TEMP TABLE FIRST, AND THE TEMP TABLE IS THE AUTHORITY (#582's review
-- round 9, finding 2 — the same reason 4d-i's seed does). Generated from
-- `apps/api/src/platform/external-effects.ts` rather than transcribed, and pinned to it by
-- `external-effect-catalog-seed.test.ts`, which parses this VALUES list and compares it, column
-- for column, with the compiled catalog at the compiled version. Eleven columns, exactly 4d-i's.
CREATE TEMP TABLE "_t4dib_catalog_seed" (
    "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
    "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL,
    "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL,
    PRIMARY KEY ("coverageVersion", "effectKey")
) ON COMMIT DROP;

INSERT INTO "_t4dib_catalog_seed" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.created.init', 'activity.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.consultation_requested', 'decision.consultation_requested', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.consultation_responded', 'decision.consultation_responded', true, '["pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.published', 'decision.published', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.published.record', 'decision.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, true),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.approved.closing', 'inspection.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.created.init', 'inspection.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('7dac2bd5646fa8b1a4062d0b844f2514179cf13ce7f59d345d837fd634aa3a61', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
;
-- THE GENERATION THIS ONE EXTENDS, named once. `842cc9fc…` is what 4d-i's seed calls
-- `_t4d_catalog_incoming` — the generation the 4d-i release compiles, which is this preimage
-- with the `pairingRequired` element removed. `phase6-t4d-i-catalog-generations.test.ts`
-- re-derives that equality from source on every run (and the outgoing `6313b00c…` beside it),
-- so neither literal can outlive its proof. Both are ADMITTED by the foreign-generation arm
-- below; the prior one is also what the seed is CHECKED against.
CREATE TEMP TABLE "_t4dib_catalog_prior" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_t4dib_catalog_prior" ("v") VALUES ('842cc9fcbbd7920b169ef79266680d38f9cd48cc1acf9ea5d02c2f8b242f22a9');
CREATE TEMP TABLE "_t4dib_catalog_outgoing" ("v" TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO "_t4dib_catalog_outgoing" ("v") VALUES ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7');

-- ── THIS SEED IS THE ONE SUCCESSOR 4d-i ADMITS, PROVEN AGAINST THE DEPLOYED PRIOR GENERATION ──
-- 4d-i's `_t4d_catalog_successor` derivation (rounds 36 and 38) admits exactly one shape: the
-- SAME effect keys as the incoming generation, every column equal to that generation's row
-- except `pairingRequired`, and the flips EXACTLY the plan's six, false → true. This file does
-- not trust its own literal to be that shape — it reads the prior generation the database
-- actually holds and compares, key by key, so a catalog edit that moved a key, an audience or a
-- seventh flip between the two literals aborts here with the keys named, before anything is
-- adopted. RETIREMENT-GATED on one arm only: after 4d-iii the prior generation is legitimately
-- stamped retired and still resolvable for history, so the "unretired" demand stands down there
-- and every other comparison still runs.
DO $t4dib_prior$
DECLARE
  v_prior TEXT; v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT "v" INTO v_prior FROM "_t4dib_catalog_prior";
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dib_catalog_seed";
  IF v_seed = v_prior THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: the seed literal names the PRIOR generation % as its own — the compiled catalog no longer carries `pairingRequired` in its coverage preimage, or the literal was regenerated from a catalog with no flips. This unit compiles a NEW generation; re-derive the literal from `external-effects.ts`.',
      v_prior;
  END IF;

  -- (1) the prior generation is PRESENT, over exactly this seed's keys, in both directions
  SELECT count(*), COALESCE(left(string_agg(q.k, ', ' ORDER BY q.k), 200), '') INTO v_n, v_s
    FROM (SELECT s."effectKey" AS k FROM "_t4dib_catalog_seed" s
           WHERE NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                              WHERE c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey")
          UNION ALL
          SELECT c."effectKey" FROM "ExternalEffectCatalog" c
           WHERE c."coverageVersion" = v_prior
             AND NOT EXISTS (SELECT 1 FROM "_t4dib_catalog_seed" s WHERE s."effectKey" = c."effectKey")) q;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: the prior generation % this unit extends does not carry the same effect keys as this seed — % key(s) differ (%). A pairing switch-on changes ONE column of ONE generation and nothing else; a key set that moved means the compiled catalog changed between 4d-i and this file, and that change needs its own generation with its own audit. Apply 4d-i first (its replay re-seeds a missing generation) or re-derive this seed. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;

  -- (2) every column but `pairingRequired` equal, key by key
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dib_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = v_prior AND c."effectKey" = s."effectKey"
   WHERE c."eventType"      IS DISTINCT FROM s."eventType"
      OR c."invalidate"     IS DISTINCT FROM s."invalidate"
      OR c."pushRoles"      IS DISTINCT FROM s."pushRoles"
      OR c."pushFamily"     IS DISTINCT FROM s."pushFamily"
      OR c."frozenAudience" IS DISTINCT FROM s."frozenAudience"
      OR c."requiresPush"   IS DISTINCT FROM s."requiresPush"
      OR c."audience"       IS DISTINCT FROM s."audience"
      OR c."pushBody"       IS DISTINCT FROM s."pushBody";
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: % key(s) of this seed differ from the prior generation % in a column other than `pairingRequired` (%). The switch-on flips one flag; a definition that changed its event type, invalidation, audience or push obligation is a different release''s generation and must be seeded and audited as one. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_prior, v_s;
  END IF;

  -- (3) the prior generation is UNFLIPPED, and the seed's flips are EXACTLY the plan's six
  SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = v_prior AND c."pairingRequired";
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: the prior generation % already carries `pairingRequired` on % key(s) (%) — 4d-i seeds that flag false on every row, so a true there was written by a hand and the switch-on cannot be stated against it. See docs/RUNBOOK.md §P6T4D.',
      v_prior, v_n, v_s;
  END IF;
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dib_catalog_seed" s
   WHERE s."pairingRequired" IS DISTINCT FROM (s."effectKey" IN (
           'decision.approved', 'decision.reapproved',
           'decision.change_requested', 'decision.change_withdrawn',
           'decision.consultation_requested', 'decision.consultation_responded'));
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: the seed literal flips `pairingRequired` on a key set that is not the plan''s six (% key(s) disagree: %). §D names exactly six types; a seventh flip, a missing one, or a flip on a type whose claimant this unit does not install would refuse every legitimate event of that type at commit. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (4) and it is not RETIRED, unless 4d-iii has genuinely run
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_n FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_prior AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b ABORT: % row(s) of the prior generation % are already stamped retired, and `RolloutRetirement` does not carry `phase6-4d` — retirement is 4d-iii''s act, and a still-serving 4d-i process resolves its events through exactly these rows. Clear the stamps before this unit seeds beside them. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_prior;
    END IF;
  END IF;
END $t4dib_prior$;

-- ── THE TOTAL AUDIT OF WHAT IS ALREADY AT THIS GENERATION, AND OF EVERY OTHER ONE ───────────
-- 4d-i's three arms, asked of THIS generation (#582's rounds 9, 12, 13 and 21): a pre-existing
-- row here — reachable on the supported db-push / P3005 path, where `schema.prisma` creates the
-- table before any guard exists — is adopted by `ON CONFLICT DO NOTHING` and then frozen, so it
-- is compared BEFORE the seed and refused rather than kept. Plus the FOREIGN-GENERATION arm this
-- unit owes because it changes the admitted set: 4d-i's own arm admits any successor-SHAPED
-- generation, which was right when this file did not exist and is one generation too wide now
-- that it does — a SECOND successor-shaped generation at some other version is a dispatch policy
-- no release compiled, and the envelope seal would resolve events against it. So before 4d-ii's
-- writers arrive (or the unit is retired), the admitted generations are EXACTLY three: the two
-- 4d-i seeds and this one. WITNESS-GATED like 4d-i's dark-register audit: 4d-ii computes its own
-- generation, and an ungated arm would abort every replay from then on.
DO $t4dib_catalog$
DECLARE
  v_seed TEXT; v_prior TEXT; v_out TEXT;
  v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dib_catalog_seed";
  SELECT "v" INTO v_prior FROM "_t4dib_catalog_prior";
  SELECT "v" INTO v_out FROM "_t4dib_catalog_outgoing";

  -- (0) FOREIGN GENERATIONS
  IF NOT phase6_t4d_retired_at_start() AND NOT phase6_t4d_ii_installed() THEN
    -- counted in ROWS, named per generation: the abort says how many rows are foreign and which
    -- generations they sit in, not how many generations there are.
    SELECT COALESCE(sum(q.n), 0)::BIGINT, COALESCE(left(string_agg(q.txt, ', ' ORDER BY q.txt), 200), '') INTO v_n, v_s
      FROM (SELECT count(*) AS n, format('%s (%s row(s))', x."coverageVersion", count(*)) AS txt
              FROM "ExternalEffectCatalog" x
             WHERE x."coverageVersion" NOT IN (v_seed, v_prior, v_out)
             GROUP BY x."coverageVersion") q;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b ABORT: % "ExternalEffectCatalog" row(s) sit in a coverage generation this rollout does not admit — %. Between 4d-i-b and 4d-ii the catalog holds exactly three generations: the two 4d-i seeded (% and %) and the pairing generation this unit seeds (%). The envelope seal resolves an event by the exact (coverageVersion, effectKey) it carries, so any other generation is a dispatch policy no release compiled — and 4d-i''s own audit admits one by SHAPE, which this unit''s existence makes one too many. Remove the rows (or, on a database that has genuinely run 4d-ii or 4d-iii, restore its witness or marker) before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s, v_prior, v_out, v_seed;
    END IF;
  ELSE
    RAISE NOTICE 'phase6 4d-i-b: the dark window is CLOSED (retirement marker or 4d-ii writers present) — the foreign-generation audit is SKIPPED (4d-ii legitimately computes its own generation)';
  END IF;

  -- (1) EXTRAS — a key at this generation this release did not compile
  SELECT count(*), COALESCE(left(string_agg(x."effectKey", ', ' ORDER BY x."effectKey"), 200), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" x
   WHERE x."coverageVersion" = v_seed
     AND NOT EXISTS (SELECT 1 FROM "_t4dib_catalog_seed" s WHERE s."effectKey" = x."effectKey");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: % "ExternalEffectCatalog" row(s) already sit at this unit''s generation under a key this release never compiled — %. A generation holds exactly the keys its release compiled; remove these rows before this unit adopts the catalog. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (2) DISAGREEMENT — a row already at this generation whose definition is not the compiled one
  SELECT count(*), COALESCE(left(string_agg(s."effectKey", ', ' ORDER BY s."effectKey"), 200), '') INTO v_n, v_s
    FROM "_t4dib_catalog_seed" s
    JOIN "ExternalEffectCatalog" c ON c."coverageVersion" = s."coverageVersion" AND c."effectKey" = s."effectKey"
   WHERE (c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience",
          c."requiresPush", c."audience", c."pushBody", c."pairingRequired")
      IS DISTINCT FROM
         (s."eventType", s."invalidate", s."pushRoles", s."pushFamily", s."frozenAudience",
          s."requiresPush", s."audience", s."pushBody", s."pairingRequired");
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: % "ExternalEffectCatalog" row(s) already exist at this unit''s generation and DISAGREE with the compiled catalog — %. The pairing seal reads `pairingRequired` from these rows to decide which events owe a claim; adopting a definition this release did not compute would refuse valid events or admit unclaimed ones. Reconcile or remove the conflicting rows. See docs/RUNBOOK.md §P6T4D.',
      v_n, v_s;
  END IF;

  -- (3) PRE-RETIRED — a stamp on the generation this file is about to seed
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*), COALESCE(left(string_agg(c."effectKey", ', ' ORDER BY c."effectKey"), 200), '') INTO v_n, v_s
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_seed AND c."retiredAt" IS NOT NULL;
    IF v_n > 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b ABORT: % row(s) at this unit''s generation are already stamped retired — %. Retirement is 4d-iii''s act and `RolloutRetirement` does not carry this unit; the envelope seal refuses every event at a retired key, so adopting these would refuse every approval, change request and consultation this release emits. Clear the stamps first. See docs/RUNBOOK.md §P6T4D.',
        v_n, v_s;
    END IF;
  END IF;
END $t4dib_catalog$;

-- ONE insert, the whole generation. `ON CONFLICT DO NOTHING` is safe only because the audit
-- above proved every pre-existing row at this generation equal to the seed.
INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired")
SELECT "coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily",
       "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired"
  FROM "_t4dib_catalog_seed"
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

-- AND THE FLIP IS READ BACK from the table the seals will read, not inferred from the literal:
-- exactly six rows at this generation carry `pairingRequired`, and they are the plan's six.
DO $t4dib_flip$
DECLARE v_seed TEXT; v_n BIGINT; v_s TEXT;
BEGIN
  SELECT DISTINCT "coverageVersion" INTO v_seed FROM "_t4dib_catalog_seed";
  -- ordered under "C": the comparison below is byte-wise against a literal, and the database's own
  -- collation is whatever the deployment chose.
  SELECT count(*), COALESCE(string_agg(c."effectKey", ', ' ORDER BY c."effectKey" COLLATE "C"), '') INTO v_n, v_s
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = v_seed AND c."pairingRequired";
  IF v_n <> 6 OR v_s <> 'decision.approved, decision.change_requested, decision.change_withdrawn, decision.consultation_requested, decision.consultation_responded, decision.reapproved' THEN
    RAISE EXCEPTION
      'phase6 4d-i-b ABORT: after seeding, generation % carries `pairingRequired` on % key(s) (%) rather than exactly the plan''s six — the switch-on did not land as specified and nothing below may be installed over it. See docs/RUNBOOK.md §P6T4D.',
      v_seed, v_n, v_s;
  END IF;
END $t4dib_flip$;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE IDEMPOTENT CLAIM PRIMITIVE (kernel-owned, beside platform_claim_event_pairing)
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── the claim that may be asked twice of ONE row ────────────────────────────────────────────
-- Kernel-owned, beside `platform_claim_event_pairing`, and it decides nothing about facts: it
-- makes the two halves of an order-independent claimant (an immediate AFTER INSERT trigger and
-- a DEFERRED one, on one function) safe to run in either order. The FIRST call claims; the
-- SECOND, from the same (table, row), finds its own claim and returns. Any OTHER row still meets
-- the register's per-event UNIQUE inside `platform_claim_event_pairing`, so "exactly one fact
-- per event branch" is exactly as strong as it was — a second claimant is refused by the
-- constraint, not by a rule someone has to remember.
CREATE OR REPLACE FUNCTION platform_claim_event_pairing_once(
  p_project TEXT, p_event TEXT, p_table TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DomainEventPairingClaim" k
              WHERE k."projectId" = p_project AND k."eventId" = p_event
                AND k."claimedBy" = p_table AND k."claimedById" = p_row) THEN
    RETURN;
  END IF;
  PERFORM platform_claim_event_pairing(p_project, p_event, p_table, p_row);
END $$;


-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — (a) THE REQUEST SEAL NOW CLAIMS, AND ITS IMMEDIATE HALF (U2 judged; U3 claims)
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- U2 installed `phase6_t4d_change_request_paired` JUDGING the opening/closure/reapproval bundle
-- and CLAIMING nothing (its seal-contract `forbid` pinned the absence of the claim). U3 replaces
-- that function body with the version that ALSO claims the two events the request row is the
-- primary fact of, and installs the request's IMMEDIATE claim half so its claims are order-
-- independent. The gate U2 gave the seal STAYS (dark if the catalog is ever rolled back before
-- 4d-iii retirement); PART 1's flip makes it TRUE. The decision-side seal
-- `phase6_t4d_change_transition_paired` is U2's and UNCHANGED — it judges only, and the flip
-- above is what activates it.

-- ── the REQUEST side: `ChangeRequest_t4d_paired` ────────────────────────────────────────────
-- The ONE deferred pairing seal on the table (§A.3; §D 4d-i-b (a)). A `ChangeRequest` row is
-- written by TWO acts in its life — the REQUEST that opens it and the CLOSURE that takes it out
-- of `open` — and each act is a BUNDLE with the decision's transition, the audit row that
-- registers it and the event that announces it. This seal judges the request's side of both
-- bundles at COMMIT, when the whole transaction is visible, and CLAIMS the two events the
-- request row is the primary fact of:
--
--   INSERT, `status = 'open'`:
--     · the decision landed `change` in THIS transaction (own table, `xmin` current) — a request
--       opened beside an untouched decision occupies `ChangeRequest_one_open_per_decision` and
--       strands the decision in whatever state it was in (#568's round 1, finding 3);
--     · for `origin = 'standard'`, the move was the EXACT `approved → change` the delivered
--       `requestChange` performs, read from the recorder above — a `pending → change` with a
--       planted request is a state, not that act — and exactly ONE `change_requested` audit row
--       was appended here: the delivered writer appends it beside the fact, and a request with
--       no audit row is an act the register cannot show (#590 round 2, finding 6);
--     · for `origin = 'countersign_rejection'`, the move was the EXACT
--       `awaiting_countersign → change` the disagreement performs, read from the same recorder.
--       4d-i's `Decision_t4d_disagreement_paired` demands this request when that move happens;
--       this is the converse, and a decision merely SITTING in `change` (a no-op UPDATE supplies
--       its `xmin`) is not that move (#590 round 2, finding 2). The disagreement's audit row is
--       4d-ii's to declare with its writers and is not asked here — which is why the request
--       itself binds its event's ACTOR: exactly one same-transaction `decision.change_requested`
--       attributed to `requestedById` (#590 round 4), where a `standard` request's is bound by
--       4d-i's audit-row correspondence;
--     · exactly ONE same-transaction `decision.change_requested` event for the decision, and the
--       request CLAIMS it — unless the bundle's primary is a `returned`
--       `DecisionStrandedResolution` (the §A.3 table names the resolution as that branch's
--       claimant, "NOT its paired ChangeRequest"), in which case the request verifies only.
--
--   UPDATE, `open → withdrawn` (the delivered `withdrawChange`, any origin):
--     · the decision was RESTORED in this transaction — `change → approved`, from the recorder,
--       and still `approved` at commit;
--     · exactly one `change_withdrawn` audit row appended here (finding 6, the withdrawal arm);
--     · exactly one same-transaction `decision.change_withdrawn` event, CLAIMED by the closure.
--
--   UPDATE, `open → resolved` (the reapproval's closure):
--     · the decision landed `approved` (no chain) or `awaiting_countersign` (chain) in this
--       transaction, from `change`;
--     · exactly one `DecisionApprovalRevision` born in this transaction — the reapproval's own
--       head, which is the branch's CLAIMANT (#572's round 9, finding 1) — and its event
--       (`decision.approved`, `decision.reapproved` or `decision.awaiting_countersign`) present.
--       VERIFICATION ONLY: the closure claims nothing here, because the revision does — and the
--       revision's own claimant below demands the audit row, so it is not asked twice.
--
-- Anything else about a request's lifecycle — INSERT-born closures, a third state, a closed row
-- reopened, the outcome/status pair — is `ChangeRequest_t4d_evidence_frozen`'s rule (4d-i,
-- round 35) and is not restated here. DEFERRED, because within one transaction the request may
-- be written before or after its transition, its audit row and its event, and every delivered
-- writer writes the event LAST. The ONE admitted bypass is the seed's DL-003 plant, which
-- disables this seal by name for exactly that row and re-enables it in the same transaction.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  d RECORD;
  v_event  TEXT;
  v_events BIGINT;
  v_audits BIGINT;
  v_births BIGINT;
BEGIN
  IF NOT phase6_t4d_change_pairing_active() THEN RETURN NULL; END IF;   -- active once U3's flip flags the change keys (the gate U2 installed; the flip below makes it TRUE)

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'open' THEN RETURN NULL; END IF;   -- the evidence freeze's refusal

    SELECT "status"::text AS status, "xmin" = txid_current()::text::xid AS here
      INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";
    IF NOT FOUND OR d.status IS DISTINCT FROM 'change' OR NOT COALESCE(d.here, FALSE) THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was opened in this transaction, but decision % is `%` at commit and was % — the OPENING is one bundle in both directions: the request and the decision''s move into `change` commit together or neither does. A request beside an untouched decision occupies the one-open-request slot and strands the decision where it stands',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>'),
        CASE WHEN COALESCE(d.here, FALSE) THEN 'written here' ELSE 'NOT written in this transaction' END;
    END IF;
    IF NEW."origin" = 'standard' THEN
      IF NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'change_from_approved') THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % was opened in this transaction, but no `approved → change` move of decision % was performed in it — the standard request pairs with EXACTLY that transition (the delivered `requestChange` performs the CAS and the insert together), and a decision written into `change` from any other state carries a request no act opened',
          NEW."id", NEW."decisionId";
      END IF;
      v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['change_requested']);
      IF v_audits <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % was opened in this transaction with % `change_requested` audit row(s) for decision % — the delivered `requestChange` appends the audit row beside the request and the event, and the register, the fact and the stream record the SAME act: a request with no audit row is an opening the decision log cannot show, and one with two is an act registered twice',
          NEW."id", v_audits, NEW."decisionId";
      END IF;
      -- ONE act, ONE actor (#590 round 4; Codex U3 round 1). A `standard` request carries a
      -- `change_requested` audit row, but 4d-i's `DecisionEvent_t4d_correspondence` binds the
      -- event's actor to the request's `requestedById` only when it is non-null (it SKIPS NULL,
      -- made total at 4d-iii), so a request opened with a NULL requester and a human-attributed
      -- event would commit with the opening bound to nobody. The request binds its own actor here,
      -- exactly as the `countersign_rejection` arm below does: exactly ONE same-transaction
      -- `decision.change_requested` attributed to `requestedById`, and that requester present.
      v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                   ARRAY['decision.change_requested'], NEW."requestedById");
      IF NEW."requestedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % of decision % names % as its requester, and this transaction carries % `decision.change_requested` event(s) attributed to that person (`actorId`) — the opening is ONE act with ONE actor: the request records who asked and the event announces who did, and a request that names no requester, or whose event is attributed to someone else, is an opening the register cannot pin to a person',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedById", '<nobody>'), v_events;
      END IF;
    ELSIF NEW."origin" = 'countersign_rejection' THEN
      IF NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'change_from_awaiting') THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % was opened in this transaction, but no `awaiting_countersign → change` move of decision % was performed in it — the rejection request pairs with EXACTLY the disagreement''s transition (`Decision_t4d_disagreement_paired` demands the request when that move happens; this is its converse), and a decision that merely sits in `change` at commit, its `xmin` supplied by a no-op UPDATE, has not been disagreed with here',
          NEW."id", NEW."decisionId";
      END IF;
      -- ONE act, ONE actor (#590 round 4). No audit row is declared for this branch, so 4d-i's
      -- `DecisionEvent_t4d_correspondence` never compares the event's envelope with the request:
      -- the request does it, and does it for the `returned` resolution's request too (the PMC
      -- who returned the decision is the requester that request records).
      v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                   ARRAY['decision.change_requested'], NEW."requestedById");
      IF NEW."requestedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % of decision % names % as its requester, and this transaction carries % `decision.change_requested` event(s) attributed to that person (`actorId`) — the disagreement is ONE act with ONE actor: the request records who disagreed and the event announces who did, no `DecisionEvent` audit row is declared for this branch for 4d-i''s correspondence to bind them through, and two immutable records that disagree about who reopened the decision leave a register that cannot say',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedById", '<nobody>'), v_events;
      END IF;
    END IF;

    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.change_requested']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was opened in this transaction with % `decision.change_requested` event(s) for decision % — the act that opens a request announces it exactly ONCE, in the same transaction; a request with no event is an act nobody can see, and one with two is an act recorded twice',
        NEW."id", v_events, NEW."decisionId";
    END IF;

    -- the `returned` stranded resolution's bundle: the resolution is the primary fact and the
    -- claimant; this request verifies only. Decided at commit, where the whole bundle is visible.
    -- The immediate half claims a rejection request's event when no resolution is visible yet, so
    -- the one order it cannot judge — event, request, THEN resolution — arrives here with the
    -- request holding a claim the resolution owns, and is refused by name (#590 round 3): the
    -- returned bundle writes its resolution before its request, or its event after both.
    IF NEW."origin" = 'countersign_rejection' AND EXISTS (
         SELECT 1 FROM "DecisionStrandedResolution" s
          WHERE s."projectId" = NEW."projectId" AND s."decisionId" = NEW."decisionId"
            AND s."outcome" = 'returned' AND s."xmin" = txid_current()::text::xid) THEN
      IF EXISTS (SELECT 1 FROM "DomainEventPairingClaim" k
                  WHERE k."projectId" = NEW."projectId" AND k."claimedBy" = 'ChangeRequest' AND k."claimedById" = NEW."id") THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % of decision % claimed its `decision.change_requested` event, but this transaction also carries a `returned` DecisionStrandedResolution for the decision — in the returned bundle the RESOLUTION is the branch''s primary fact and its claimant (§A.3), and the request verifies only. The request claimed because the event was already written when it was inserted and no resolution was visible yet: write the resolution before the request, or the event after both',
          NEW."id", NEW."decisionId";
      END IF;
      RETURN NULL;
    END IF;

    v_event := platform_tx_event(NEW."projectId", 'Decision', NEW."decisionId",
                                 ARRAY['decision.change_requested']);
    PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'ChangeRequest', NEW."id");
    RETURN NULL;
  END IF;

  -- UPDATE: only the CLOSURE — the row LEAVING `open` — is a pairing question.
  IF OLD."status" IS DISTINCT FROM 'open' OR NEW."status" IS NOT DISTINCT FROM 'open' THEN
    RETURN NULL;
  END IF;

  SELECT "status"::text AS status, "xmin" = txid_current()::text::xid AS here
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF NEW."status" = 'withdrawn' THEN
    IF NOT COALESCE(d.here, FALSE) OR d.status IS DISTINCT FROM 'approved'
       OR NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change') THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was WITHDRAWN in this transaction, but decision % is `%` at commit and its `change → approved` restoration was % — the closure and the restoration are ONE bundle in both directions (#558 round 1, finding 2): a withdrawn request beside a decision still in `change` leaves it stranded with nothing to withdraw and no state to approve from',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>'),
        CASE WHEN phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change')
             THEN 'performed here' ELSE 'NOT performed in this transaction' END;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['change_withdrawn']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was withdrawn in this transaction with % `change_withdrawn` audit row(s) for decision % — the delivered `withdrawChange` appends the audit row beside the closure and the event, and a withdrawal the decision log cannot show is a closure nobody registered',
        NEW."id", v_audits, NEW."decisionId";
    END IF;
    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.change_withdrawn']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was withdrawn in this transaction with % `decision.change_withdrawn` event(s) for decision % — a withdrawal announces itself exactly ONCE in the same transaction',
        NEW."id", v_events, NEW."decisionId";
    END IF;
    v_event := platform_tx_event(NEW."projectId", 'Decision', NEW."decisionId",
                                 ARRAY['decision.change_withdrawn']);
    PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'ChangeRequest', NEW."id");
    RETURN NULL;
  END IF;

  IF NEW."status" = 'resolved' THEN
    IF NOT COALESCE(d.here, FALSE)
       OR NOT (   (d.status = 'approved'             AND phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change'))
               OR (d.status = 'awaiting_countersign' AND phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'awaiting_from_change'))) THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was RESOLVED in this transaction, but decision % is `%` at commit and did not leave `change` for `approved` (no chain) or `awaiting_countersign` (chain) here — a resolution is the reapproval''s closure and pairs with the reapproval''s own transition (#558 round 2, finding 6); a request resolved beside a decision that stays in `change` records an approval nobody made',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
    END IF;
    SELECT count(*) INTO v_births FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
       AND r."xmin" = txid_current()::text::xid;
    IF v_births <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was resolved by a reapproval of decision % that wrote % approval revision(s) in this transaction — the reapproval IS the act that closes the request, and its revision is that act''s immutable record and the claimant of its event; a closure with no head behind it is a request closed by nobody',
        NEW."id", NEW."decisionId", v_births;
    END IF;
    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.approved', 'decision.reapproved', 'decision.awaiting_countersign']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was resolved in this transaction with % approval-family event(s) for decision % — the reapproval that closes a request announces itself exactly ONCE (claimed by its revision, never by this closure)',
        NEW."id", v_events, NEW."decisionId";
    END IF;
    RETURN NULL;
  END IF;

  -- any other way out of `open` is refused by the evidence freeze; nothing to pair.
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_paired" ON "ChangeRequest";
CREATE CONSTRAINT TRIGGER "ChangeRequest_t4d_paired"
  AFTER INSERT OR UPDATE ON "ChangeRequest" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_paired();

-- ── and the request's IMMEDIATE claim half, so its two claims are order-independent too ─────
-- The seal above is DEFERRED and is the only place the request's bundle can be JUDGED. But a
-- deferred claim alone serves only the delivered order (fact, then event): a bundle that emits
-- FIRST queues the kernel's deferred check ahead of this seal, and the check would find an
-- empty register (measured while this file was written — the withdrawal bundle written
-- event-first was refused as unclaimed). So the two claims the request owns are ALSO made
-- immediately, by a claimant that judges nothing: when the event is already there it claims it,
-- and the deferred seal's own `_once` call then finds the claim made. The standard opening and
-- the withdrawal claim unconditionally. A `countersign_rejection` request claims when the event
-- is there AND no `returned` `DecisionStrandedResolution` for its decision has been written in
-- this transaction yet — in the returned bundle the RESOLUTION is the branch's primary and the
-- request verifies only (§A.3, the derived-primary rule), and a resolution already present is
-- the one fact this half can see. #590's review round 3: the first head left the rejection
-- request's claim to the deferred seal alone, so a reject-back or forward-on written EVENT-FIRST
-- reached the kernel's deferred check with an empty register and was refused whole. The one
-- order this half cannot judge — event, then request, then the resolution — is refused by the
-- deferred seal below, which finds the request holding a claim the resolution owns.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'open' THEN RETURN NULL; END IF;
    IF NEW."origin" = 'countersign_rejection' AND EXISTS (
         SELECT 1 FROM "DecisionStrandedResolution" s
          WHERE s."projectId" = NEW."projectId" AND s."decisionId" = NEW."decisionId"
            AND s."outcome" = 'returned' AND s."xmin" = txid_current()::text::xid) THEN
      RETURN NULL;   -- the returned bundle: the resolution is the claimant, this request verifies
    END IF;
    IF NEW."origin" = 'countersign_rejection' THEN
      -- bound to the requester (#590 round 4): the deferred seal demands exactly one event of the
      -- family attributed to `requestedById`, so an event attributed to anyone else is not this
      -- request's to claim, whichever order the bundle is written in
      v_event := phase6_t4d_tx_actor_event(NEW."projectId", NEW."decisionId",
                                           ARRAY['decision.change_requested'], NEW."requestedById");
    ELSIF NEW."origin" = 'standard' THEN
      -- bound to the requester (#590 round 4; Codex U3 round 1), like the countersign_rejection arm
      -- above: the deferred seal demands exactly one `decision.change_requested` attributed to
      -- `requestedById`, so an event attributed to anyone else — or a NULL requester — is not this
      -- request's to claim, whichever order the bundle is written in.
      v_event := phase6_t4d_tx_actor_event(NEW."projectId", NEW."decisionId",
                                           ARRAY['decision.change_requested'], NEW."requestedById");
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    IF OLD."status" IS DISTINCT FROM 'open' OR NEW."status" IS DISTINCT FROM 'withdrawn' THEN
      RETURN NULL;
    END IF;
    v_event := platform_tx_event(NEW."projectId", 'Decision', NEW."decisionId",
                                 ARRAY['decision.change_withdrawn']);
  END IF;
  IF v_event IS NULL THEN RETURN NULL; END IF;   -- not written yet: the deferred seal claims at commit
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'ChangeRequest', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_claim" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_claim"
  AFTER INSERT OR UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_claims_event();

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — (b) THE REMAINING PER-BRANCH CLAIMANTS, EACH ORDER-INDEPENDENT
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Each claimant is ONE function on TWO triggers: an immediate AFTER INSERT (claims when the
-- event is already written — the event-first order) and a DEFERRED constraint trigger (claims
-- at commit when the event arrived after the fact — the delivered order, where the fact's
-- deferred claimant is queued AHEAD of the event's deferred check). Through
-- `platform_claim_event_pairing_once`, so the half that finds its own claim already made is a
-- no-op. THE TWO HALVES ARE NOT THE SAME QUESTION. The IMMEDIATE half may defer absence: the
-- event is usually not written yet, and returning is the only correct answer. The DEFERRED half
-- runs at commit, when the whole bundle is visible, and there absence is a VERDICT: #590's first
-- head let both halves return on absence ("the missing event is the correspondence's or the entry
-- seal's refusal"), and no such seal exists for a fact written with NO audit row and NO event —
-- `DecisionEvent_t4d_correspondence` fires on the audit row, the kernel seal fires on the event,
-- and a bundle that writes neither is judged by nobody (round 2, findings 1, 3 and 5). So at
-- commit each claimant COUNTS the evidence its fact's act must have produced — exactly one event
-- of the family, BOUND to this fact where the payload names it, to its recipient where the
-- delivered writer targets one, and to the ACTOR the fact records where no audit row exists for
-- 4d-i's correspondence to bind them through (round 4), and exactly one audit row where the
-- delivered writer appends one — and refuses anything else. The event is resolved through the kernel's own
-- same-transaction primitive or the same `xmin` scope it uses, never by a lookup that looks
-- outside this transaction. A legacy plant that carries no event declares itself by name
-- (`plantLegacyApprovalRevision` disables the deferred half beside 4d-i's birth seals) and is
-- not admitted by silence.

-- ── the FINALIZED revision birth claims `decision.approved` / `decision.reapproved` ─────────
-- The direct approve from `pending` and the no-chain reapproval from `change` each write ONE
-- revision born `finalized = true`, ONE `approved` / `reapproved` audit row and ONE event of the
-- family; the revision is the branch's fact on every instance (the `change` arm's request
-- CLOSURE exists only when approving from `change`, so the revision claims and the closure
-- verifies — #572's round 9, finding 1). A PROVISIONAL birth (`finalized = false`) claims
-- nothing here: its event is `decision.awaiting_countersign`, a 4d-ii type declared with its
-- claimant in that unit, and a claimant for a type the catalog does not carry would be a roster
-- to keep in step. At commit the deferred half demands exactly one event and exactly one audit
-- row: a finalized head with neither is an approval the stream never announced and the decision
-- log cannot show, and the transition-and-receipt seals of 4d-i, which judge the revision's
-- birth against the decision's move, say nothing about either (round 2, finding 5).
CREATE OR REPLACE FUNCTION phase6_t4d_revision_claims_approval() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event TEXT; v_events BIGINT; v_audits BIGINT;
BEGIN
  IF NEW."finalized" IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;
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
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionApprovalRevision', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_claim" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4d_claim"
  AFTER INSERT ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_claims_approval();
DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_claim_deferred" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4d_claim_deferred"
  AFTER INSERT ON "DecisionApprovalRevision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_claims_approval();

-- ── the payload/audience-qualified tx-event primitive (U1's actor-event read, widened) ──────
-- U1's `phase6_t4d_tx_actor_event` is the kernel's `platform_tx_event` narrowed to one actor, and
-- U1's own note said the no-audit-row claimants "ask through this". The consultation claimants
-- below need it narrowed FURTHER — to the fact named IN the event's payload and the recipient
-- named IN its dispatch intent — because a type-and-actor lookup alone is satisfied by an event
-- that names ANOTHER consultation, or pushes to a stranger (#590 round 2, finding 3). Rather than
-- have a decisions claimant reach into the kernel's `DomainEvent` table itself (Codex U3 round 1),
-- this expresses that qualified read ONCE, as a sibling of U1's primitive: `p_payload` matched with
-- `@>` (the event's payload CONTAINS these keys), `p_push_target` against
-- `dispatchIntent.push.targetUserId`, `p_actor` against `actorId`. STABLE, scoped to THIS
-- transaction's rows, so an earlier transaction's event is never mistaken for one this bundle
-- produced. Returns the match count and (the single) eventId, so the claimant judges the count and
-- claims the row without a second query.
CREATE OR REPLACE FUNCTION phase6_t4d_tx_qualified_event(
  p_project TEXT, p_decision TEXT, p_type TEXT, p_actor TEXT, p_payload JSONB, p_push_target TEXT,
  OUT n BIGINT, OUT event_id TEXT
) LANGUAGE sql STABLE AS $$
  SELECT count(*), max(e."eventId") FROM "DomainEvent" e
   WHERE e."projectId" = p_project
     AND e."entityType" = 'Decision' AND e."entityId" = p_decision
     AND e."eventType" = p_type
     AND e."actorId" = p_actor
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> p_payload
     AND e."dispatchIntent" -> 'push' ->> 'targetUserId' = p_push_target;
$$;

-- ── the consultation request and response claim their families, BOUND to the row ───────────
-- One function over both 4c fact tables, by `TG_TABLE_NAME`. The delivered writers emit the
-- event with the fact IN the payload and the recipient IN the dispatch intent:
--   `consultations.request` — `payload = {consultationId, consulteeUserId}`,
--                             `dispatchIntent.push.targetUserId = consulteeUserId`;
--   `consultations.respond` — `payload = {consultationId, responseId}`,
--                             `dispatchIntent.push.targetUserId = <the consultation's requestedById>`.
-- A type-only lookup (#590's first head) is satisfied by an event that names ANOTHER
-- consultation, or names this one and pushes to someone who was never consulted — the
-- consultee's notice going to a stranger, the requester's answer going back to the consultee —
-- because the 4c seals judge the row and the envelope seal judges the push's SHAPE, and nothing
-- judged that the event's payload and audience are THIS row's (round 2, finding 3). So the event
-- a claimant may claim is the same-transaction event of the family, for this decision, under
-- this project, whose payload names THIS row (and, for the request, THIS consultee) and whose
-- push targets the person the act is for — AND whose `actorId` is the person the row records as
-- acting (`requestedById`; `respondedById`). Identity and audience alone admit an event that
-- names this consultation, pushes to its consultee and announces it as SOMEONE ELSE's ask, and
-- the 4c seals judge `requestedById` while the envelope seal judges `actorId` with nothing
-- equating the two (#590's review round 4); the four audit-bearing branches get that equation
-- from 4d-i's `DecisionEvent_t4d_correspondence`, and consultations carry no audit row by the
-- delivered contract, so the claimant asks it here. Exactly one such event at commit; a
-- consultation with none is an ask nobody was told about (finding 1), and the deferred half
-- refuses it. No audit row is asked, because none is written.
CREATE OR REPLACE FUNCTION phase6_t4d_consultation_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event TEXT; v_type TEXT; v_n BIGINT; v_target TEXT;
BEGIN
  v_type := CASE TG_TABLE_NAME
    WHEN 'DecisionConsultation'         THEN 'decision.consultation_requested'
    WHEN 'DecisionConsultationResponse' THEN 'decision.consultation_responded'
    ELSE NULL END;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'phase6 4d-i-b: phase6_t4d_consultation_claims_event is installed on %, which is not a consultation fact table', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    SELECT q.n, q.event_id INTO v_n, v_event
      FROM phase6_t4d_tx_qualified_event(
             NEW."projectId", NEW."decisionId", v_type, NEW."requestedById",
             jsonb_build_object('consultationId', NEW."id", 'consulteeUserId', NEW."consulteeUserId"),
             NEW."consulteeUserId") q;
    IF TG_NAME LIKE '%\_deferred' AND v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: consultation % of decision % was written in this transaction with % `decision.consultation_requested` event(s) that name it (`payload.consultationId`), carry its consultee (`payload.consulteeUserId`), target that consultee (`dispatchIntent.push.targetUserId` — the delivered `consultations.request` pushes to exactly the person asked) and are attributed to its requester (`actorId` = `requestedById`) — a consultation is an ask, and an ask announced to nobody, announced as another consultation, pushed to a stranger, or announced in somebody else''s name, is not the act this row records',
        NEW."id", NEW."decisionId", v_n;
    END IF;
  ELSE
    SELECT c."requestedById" INTO v_target FROM "DecisionConsultation" c
     WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."consultationId";
    SELECT q.n, q.event_id INTO v_n, v_event
      FROM phase6_t4d_tx_qualified_event(
             NEW."projectId", NEW."decisionId", v_type, NEW."respondedById",
             jsonb_build_object('responseId', NEW."id", 'consultationId', NEW."consultationId"),
             v_target) q;
    IF TG_NAME LIKE '%\_deferred' AND v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: consultation response % of decision % was written in this transaction with % `decision.consultation_responded` event(s) that name it (`payload.responseId`), name its consultation (`payload.consultationId`), target the requester (`dispatchIntent.push.targetUserId` = the consultation''s `requestedById`, who the delivered `consultations.respond` pushes to) and are attributed to its responder (`actorId` = `respondedById`) — an answer announced to nobody, announced as another response, pushed to anyone but the person who asked, or announced in somebody else''s name, is not the act this row records',
        NEW."id", NEW."decisionId", v_n;
    END IF;
  END IF;

  IF v_n <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, TG_TABLE_NAME, NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_claim" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_claim"
  AFTER INSERT ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_claims_event();
DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_claim_deferred" ON "DecisionConsultation";
CREATE CONSTRAINT TRIGGER "DecisionConsultation_t4d_claim_deferred"
  AFTER INSERT ON "DecisionConsultation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_claims_event();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_claim" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_claim"
  AFTER INSERT ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_claims_event();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_claim_deferred" ON "DecisionConsultationResponse";
CREATE CONSTRAINT TRIGGER "DecisionConsultationResponse_t4d_claim_deferred"
  AFTER INSERT ON "DecisionConsultationResponse" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_claims_event();

-- No "installation verified" audit closes this file: a trigger created in this transaction cannot
-- be absent at its end, so such an audit would witness nothing — and it would refuse the
-- seal-stripped harness, which omits one named seal from the unit and requires the rest to apply
-- over that database. The installed SET is pinned where a set belongs, in
-- `phase6-t4d-i-seal-inventory.test.ts` (names, timing, enablement) and the seal-contract oracle.


COMMIT;
