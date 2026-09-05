-- Phase 6 unit 4c-v — the SEAL RETIREMENT, the last gate of 4c
-- (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md §D, review rounds 25–26).
--
-- THIS MIGRATION MAY LAND ONLY AFTER THE 4c-iv ROLLOUT IS ATTESTED COMPLETE. The
-- `phase-6-4c-iv-rollout-complete` directive was cleared on an explicit OPERATOR-ATTESTATION
-- (issue #482, comment 5548460858: every PMC Vitan process is on release 76027074 or later). It is
-- cited in docs/STATUS.md, not restated here as fact; an immutable migration is not the place for
-- a claim about the world outside the repository.
--
-- WHAT THE SEAL WAS FOR, and why it can go. The per-project `consultation` capability was never a
-- product pilot: it was a ROLLOUT LATCH (§D, round 11) that let 4c-ii ship gate-reading code dark,
-- 4c-iii open the gate for every project atomically, and 4c-iv remove the reads. 4c-iii's
-- PRESERVATION seal existed for exactly one hazard — while ANY serving instance still READ the row,
-- an alternate writer deleting or re-keying it made a gate-reading instance refuse a project a
-- gate-blind instance accepted. 4c-iv removed every read (the two write commands, the shell
-- contract, the client; the emitter was gated through the commands), and its rollout is attested
-- complete, so no reader exists. A seal protecting a row nothing reads protects nothing, and a
-- creation trigger manufacturing that row for every new project is the latch still running.
--
-- WHAT THIS DROPS, in one transaction:
--   * the preservation seal — its row arm (`ProjectCapability_t4c_preserved`: DELETE, re-key,
--     re-parent, attribution) and its statement arm (`ProjectCapability_t4c_no_truncate`);
--   * the orgs-owned delete flag the seal consulted (`Project_t4c_deleting`), which has no other
--     reader;
--   * the creation trigger (`Project_t4c_consultation_enabled`);
--   * the four functions behind them;
--   * and the `consultation` rows themselves, for every project. The rows were written by this
--     ledger's own 20271120 (`enabledById = 'system:phase6-4c-iii'`) or by the generic writer as
--     inert data; none records a human approval of anything, so none is evidence this repository
--     must preserve. Removing them is the latch retiring, not data loss.
--
-- WHAT THIS KEEPS. `ProjectCapability`'s `ON DELETE CASCADE` foreign key (4c-iii step 1a) stays: it
-- is modelled in schema.prisma and is not part of the latch. `capability` stays free text — the
-- Board pin that no CHECK or vocabulary whitelist is added holds, so `consultation` can still be
-- upserted through the generic writer; it is simply a row nothing reads.
--
-- ORDER MATTERS. The triggers are dropped BEFORE the rows are deleted: the seal refuses exactly the
-- DELETE this file performs, and this file does not disable it by name to slip past — it retires
-- it. Every statement is re-runnable (`DROP … IF EXISTS`; a DELETE with nothing to delete), which
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE set requires: on the P3005 baseline path 20271120 is left
-- PENDING so its raw transition really runs, and this file must be left pending WITH it — resolving
-- it as applied while 20271120 executes would record the retirement in the ledger the moment the
-- seal was installed, and nothing downstream would notice.
--
-- THE DISCLOSED RESIDUAL, unchanged. A pre-4c-iv browser tab still reads the shell's
-- `capabilities`; the Board ruled (2026-08-29, on PR #480) that a consultation INFORMS and never
-- GATES, so nothing is blocked or lost and the state resolves on reload. No drain condition is
-- invented for it here.
BEGIN;

-- ── 1. the seal and its helpers retire, by name ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS "ProjectCapability_t4c_preserved" ON "ProjectCapability";
DROP TRIGGER IF EXISTS "ProjectCapability_t4c_no_truncate" ON "ProjectCapability";
DROP TRIGGER IF EXISTS "Project_t4c_deleting" ON "Project";
DROP TRIGGER IF EXISTS "Project_t4c_consultation_enabled" ON "Project";

DROP FUNCTION IF EXISTS phase6_t4c_capability_preserved();
DROP FUNCTION IF EXISTS phase6_t4c_capability_no_truncate();
DROP FUNCTION IF EXISTS phase6_t4c_project_deleting();
DROP FUNCTION IF EXISTS phase6_t4c_project_consultation_row();

-- ── 2. the latch's rows go with it ─────────────────────────────────────────────────────────────
DELETE FROM "ProjectCapability" WHERE "capability" = 'consultation';

-- ── 3. the retirement is COMPLETE, checked rather than asserted ────────────────────────────────
-- Nothing of the latch may survive this commit: not a trigger, not a function, not a row. If any
-- does, the file above did not do what it says and the transaction must not commit.
DO $$
DECLARE triggers_left BIGINT; functions_left BIGINT; rows_left BIGINT;
BEGIN
  SELECT count(*) INTO triggers_left FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN (
     'ProjectCapability_t4c_preserved', 'ProjectCapability_t4c_no_truncate',
     'Project_t4c_deleting', 'Project_t4c_consultation_enabled', 'ProjectCapability_t4c_reserved');
  SELECT count(*) INTO functions_left FROM pg_proc
   WHERE proname IN (
     'phase6_t4c_capability_preserved', 'phase6_t4c_capability_no_truncate',
     'phase6_t4c_project_deleting', 'phase6_t4c_project_consultation_row', 'phase6_t4c_capability_reserved');
  SELECT count(*) INTO rows_left FROM "ProjectCapability" WHERE "capability" = 'consultation';
  IF triggers_left > 0 OR functions_left > 0 OR rows_left > 0 THEN
    RAISE EXCEPTION 'phase6-4c-v ABORT: the consultation latch is not fully retired (% trigger(s), % function(s), % row(s) remain). Refusing to commit.',
      triggers_left, functions_left, rows_left;
  END IF;
END $$;

-- Everything above becomes visible together, or not at all.
COMMIT;
