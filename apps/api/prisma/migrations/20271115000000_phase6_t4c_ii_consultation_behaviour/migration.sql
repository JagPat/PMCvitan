-- Phase 6 unit 4c-ii — the CONSUMER-VERSION FENCE, in the two places a previous-release process
-- can still reach this database.
--
-- This unit is described as behaviour, and it is: no consultation table changes here, no seal is
-- added or altered, and 20271101000000 (the dark 4c-i migration) is not touched. What this file
-- carries is the pair of DATA/SCHEMA facts that a compiled contract cannot carry by itself.
--
-- 1. THE CATALOG DATA. `syncConsumerCatalog` CREATES a missing consumer row and ASSERTS an
--    existing one — it never UPDATEs, and says so outright ("a changed contract requires an
--    explicit migration, never a silent overwrite"). So bumping only the COMPILED
--    `catalogVersion` on the two consultation-consuming consumers would leave the persisted rows
--    at the old version and abort every UPGRADED process at bootstrap: the fence pointed the
--    wrong way. This migration is what actually arms it, and it is INSEPARABLE from the code by
--    construction — a consumer's compiled contract and its persisted version must land in the
--    same deployment or one of them is wrong.
--
--    The ORDERING is what makes it safe. `migrate.sh` applies this before the new processes
--    start, so an already-running previous-release worker keeps serving (it re-syncs only at
--    startup) while emission is still gated OFF, and it can never come back after a restart. By
--    the time the operator opens the `consultation` capability, only upgraded processes can run.
--
-- 2. THE GENERATION VERSION. The startup fence protects processes that TAKE UP SERVICE.
--    `projection-rebuild.cli.ts` is not one — it constructs `ProjectionRebuilder` and registers
--    projection consumers directly, and never calls `syncConsumerCatalog`. A previous release's
--    CLI run against this database would therefore rebuild `decisions.inbox` with the v1
--    serializer and ACTIVATE that generation: a register with no consultation thread and no
--    widened audience, swapped in by a supported command, with the persisted catalog already at
--    v2 and nothing consulting it. That is worse than the old-worker hazard, because the rebuild
--    is the documented repair for a lagging generation.
--
--    A check added to the NEW CLI cannot make the PREVIOUS binary refuse — that binary contains
--    neither the check nor any sync call. So the fence goes at the DATABASE boundary every binary
--    must cross: a NOT NULL column with NO DEFAULT that the new code supplies and the previous
--    release, which does not know it exists, cannot. Its INSERT is rejected by PostgreSQL before
--    any generation is built or swapped.
--
--    In THREE steps, not one: `ADD COLUMN ... NOT NULL` with no default fails immediately on any
--    deployment that already holds a `ProjectionGeneration` row, because every existing row would
--    take NULL. The column is added NULLABLE, existing generations are backfilled to the version
--    they were ACTUALLY built at, and only then is NOT NULL applied — still with NO DEFAULT,
--    which is what preserves the fence.
--
-- Every statement is retry-safe (the 20271015 discipline): a deploy that dies after an early
-- statement must COMPLETE on re-run, not stop at the object it already created.

-- ── 2a. the column, NULLABLE ────────────────────────────────────────────────────────────────────
ALTER TABLE "ProjectionGeneration" ADD COLUMN IF NOT EXISTS "catalogVersion" INTEGER;

-- ── 2b. the backfill, from the version those generations were actually built at ─────────────────
-- Read from the PERSISTED catalog, which still holds the PRE-4c-ii versions at this point (step 1
-- below is deliberately ordered after this). A generation whose consumer has no catalog row at all
-- predates that registry; version 1 is the only version such a row can have been built at. The
-- value is written EXPLICITLY rather than defaulted, so no row silently acquires a version it was
-- not built with.
UPDATE "ProjectionGeneration" g
   SET "catalogVersion" = COALESCE(
         (SELECT c."catalogVersion" FROM "OutboxConsumerCatalog" c WHERE c."consumer" = g."consumer"),
         1
       )
 WHERE g."catalogVersion" IS NULL;

-- ── 2c. NOT NULL — and NO DEFAULT, which is the fence itself ────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "ProjectionGeneration" ALTER COLUMN "catalogVersion" SET NOT NULL;
EXCEPTION WHEN others THEN
  -- already NOT NULL on a re-run: `SET NOT NULL` is idempotent in PostgreSQL, so reaching this
  -- handler means a row is still NULL — which can only happen if 2b did not run. Re-raise: a
  -- silently skipped fence is worse than a failed deploy.
  RAISE;
END $$;

-- ── 1. the catalog data, for exactly the two consultation-consuming consumers ───────────────────
-- `decisions.inbox` folds the thread into the projected DTO; `webpush.notify` claims the two new
-- push families through their §B.3 predicates. The socket consumer is NOT bumped: it carries no
-- consultation contract — it tells a room to refetch and has nothing new to understand.
--
-- Guarded by the version it is moving FROM, so a re-run is a no-op rather than a second bump, and
-- a database whose consumers were never registered (a fresh install, where `syncConsumerCatalog`
-- will CREATE them at the compiled version) is untouched.
UPDATE "OutboxConsumerCatalog" SET "catalogVersion" = 2
 WHERE "consumer" IN ('decisions.inbox', 'webpush.notify') AND "catalogVersion" = 1;
