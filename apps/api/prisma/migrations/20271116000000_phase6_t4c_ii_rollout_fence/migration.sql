-- Phase 6 unit 4c-ii — the ROLLOUT FENCE, in the places a previous-release process can still
-- reach this database.
--
-- This unit is described as behaviour, and it is: no consultation table changes here, and
-- 20271101000000 (the dark 4c-i migration) is not touched. What this file carries is the
-- DATA/SCHEMA facts a compiled contract cannot carry by itself, plus one obligation §D placed in
-- 4c-i that the merged 4c-i does not discharge.
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
-- The APPROVAL REGISTER's provenance seal is deliberately NOT here: it lives in this unit's
-- companion migration `20271115000000_phase6_t4c_ii_approval_provenance`, as a DEFERRABLE
-- commit-time trigger that requires the cited receipt to have SUCCEEDED with its `resultRef`
-- naming this decision. A BEFORE INSERT null-check would be weaker in exactly the way review
-- round 29 identified: the delivered receipt protocol permits a `reserved` INSERT and validates
-- completion only if an UPDATE occurs, so a writer could insert a reserved receipt and a revision
-- citing it in ONE transaction, commit, and advance the cycle without ever approving anything.
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

-- ── 3. the CAPABILITY RESERVATION — a 4c-i obligation this unit carries forward ─────────────────
-- §D requires the `consultation` capability row to be IMPOSSIBLE to create while the dark window
-- is open, and places both halves (a diagnostic-first abort over any pre-existing row, and a
-- reservation trigger rejecting new ones) in 4c-i. The merged 20271101000000 ships neither — it
-- contains no `ProjectCapability` statement at all — so the hole is live right now: the previous
-- release's generic `capability:enable` CLI accepts ANY string, so an operator can enable
-- `consultation` today, and the first upgraded instance would emit `decision.consultation_*` while
-- old workers were still claiming deliveries. That is precisely the state the gate exists to
-- prevent, and it is THIS unit whose compatibility story depends on it, so the obligation is
-- carried here rather than left for a unit that runs after the risk has already passed.
--
-- The ORDERING is the round-24 rule: the trigger is created BEFORE the audit reads. "Diagnostic
-- first" orders the abort before the SCHEMA CHANGE, which is not sufficient — an audit that reads
-- first can observe no row, a concurrent `capability:enable` can commit against the previous
-- release, and only THEN would `CREATE TRIGGER` take its lock; the trigger is not retroactive, so
-- this migration would commit having passed its own diagnostic with the gate already open.
-- `CREATE TRIGGER` takes ACCESS EXCLUSIVE on `ProjectCapability` inside this transaction, so any
-- concurrent writer blocks until commit and the audit then reads a snapshot no other session can
-- extend: a writer already in flight either committed before the lock (the audit sees its row and
-- aborts) or resumes after commit (the reservation rejects it).
--
-- This does NOT reopen the Board decision that there is no CHECK on the column's vocabulary. The
-- column stays free text, every SHIPPED capability still enables through the unchanged generic
-- writer, and the ONE rejected value is the one no legitimate caller can yet have reason to write.
-- The reservation gives way at 4c-iii, atomically with the controlled enablement, where it is
-- REPLACED by the preservation seal rather than simply dropped.
CREATE OR REPLACE FUNCTION phase6_t4c_capability_reserved() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- BOTH doors: an INSERT naming the reserved value, and an UPDATE transitioning an existing row
  -- into it. `capability` is a mutable key with no freeze trigger, so an INSERT-only guard would
  -- leave `UPDATE "ProjectCapability" SET "capability" = 'consultation'` wide open — the same
  -- gate-open state by another route.
  IF NEW."capability" = 'consultation' THEN
    RAISE EXCEPTION 'phase6-4c: the `consultation` capability is RESERVED until the enablement unit — it is the rollout latch for an unreleased workflow, and enabling it now would let an upgraded instance emit consultation events while previous-release workers can still claim them (project %)', NEW."projectId";
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "ProjectCapability_t4c_reserved" ON "ProjectCapability";
CREATE TRIGGER "ProjectCapability_t4c_reserved"
  BEFORE INSERT OR UPDATE OF "capability" ON "ProjectCapability"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_capability_reserved();

-- the audit, reading a snapshot the trigger above has already frozen
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg("projectId", ', ' ORDER BY "projectId")
    INTO bad, sample
    FROM (SELECT "projectId" FROM "ProjectCapability" WHERE "capability" = 'consultation' LIMIT 20) s;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-4c ABORT: % project(s) already hold the reserved `consultation` capability (sample: %). The unit was dark, so nothing legitimate can have created one — an operator enabled it early through the generic capability:enable CLI. Remove those rows before deploying: the gate must be OFF until the drain-first cutover is confirmed complete.', bad, sample;
  END IF;
END $$;
