-- Every projection generation records the SERIALIZER VERSION that built it.
--
-- Replaces the generation-fence half of the closed PR #497 (see `Replaces: #497` there), carrying
-- ONLY the two findings that unit never resolved. It is deliberately a unit of its own: what it
-- installs is a platform property — "a generation knows which code wrote its rows" — that is true
-- and useful independently of any one consumer's contract changing, and reviewing it apart from a
-- module's behaviour change is what makes both reviewable.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────────────────────────
--
-- `ProjectionGeneration` rows carry no record of the code that materialized them. A projection
-- read therefore cannot tell a generation built by the RUNNING release from one built by an older
-- one whose serializer produced a different DTO shape.
--
-- The concrete way that bites is the standalone `projection-rebuild` CLI. It constructs
-- `ProjectionRebuilder` and registers projection consumers DIRECTLY — it never calls
-- `syncConsumerCatalog`, so the startup contract assertion that fences out a stale binary taking up
-- service does not run for it at all. A previous release's CLI, run against a database an upgraded
-- release is serving, will happily rebuild a projection with ITS serializer and ACTIVATE the
-- result: a read-model missing whatever the newer serializer adds, swapped in by a SUPPORTED
-- command, at exactly the moment something already looks wrong enough for an operator to be
-- reaching for a rebuild.
--
-- ── WHY THE FENCE IS ON THE READ, NOT THE WRITE ────────────────────────────────────────────────
--
-- The obvious shape is a NOT NULL column with NO DEFAULT: the new code supplies it, and a binary
-- that does not know the column exists cannot insert at all. That was tried, in the closed unit,
-- and it is wrong in two ways — both of which are ordinary, documented operations rather than
-- edge cases:
--
--   (a) IT BREAKS A STILL-RUNNING PREVIOUS RELEASE. `scripts/migrate.sh` applies migrations BEFORE
--       the new processes start, which means there is a window in which this column exists and the
--       OLD binary is still serving. In that window the old `lockActiveGeneration` lazily
--       bootstraps a generation for any (consumer, project) that has none yet, with an INSERT
--       naming no version. A no-default NOT NULL rejects it and STALLS that ordered projection
--       while the previous release is still supposed to be working. Backfilling existing rows does
--       not help: the exposed case is precisely the (consumer, project) that has no row yet.
--
--   (b) IT BREAKS THE DOCUMENTED 4a REPAIR. `20270810000000_phase6_t4a_withdraw` is rerunnable BY
--       DESIGN — the RUNBOOK prescribes replaying it to repair a stale decisions projection — and
--       its repair block inserts a replacement generation with an EXPLICIT column list, which
--       cannot name a column added later. Against a no-default NOT NULL that replay fails instead
--       of repairing. Merged migrations are not edited to accommodate later ones, so the later one
--       has to be the one that accommodates.
--
-- So the column is NOT NULL, an un-versioned INSERT is STAMPED rather than rejected, and the
-- REFUSAL moves to `readServableGeneration` — the one gate every module's projection read already
-- crosses. A generation stamped below the running code's compiled `catalogVersion` is not servable,
-- and the caller falls back to the canonical live read. That is the same answer that function
-- already gives a lagging or blocked generation, and the live read is always current, so the
-- fallback costs correctness nothing. The old CLI can still build and activate an old-serializer
-- generation; what it cannot do is get it SERVED, which is the harm.
--
-- ── WHY THE STAMP IS A TRIGGER AND NOT `DEFAULT 1` ─────────────────────────────────────────────
--
-- `DEFAULT 1` fixes (a). It does not fix (b) in the way that matters. The 4a repair's replacement
-- generation COPIES its rows from the generation it retires, so its true version IS that
-- generation's; stamping it 1 would leave a correctly repaired projection permanently unservable
-- and turn a targeted, cleared repair into "repair, and then run a full rebuild as well".
--
-- The trigger therefore inherits in exactly the case where inheriting is TRUE:
--
--     an INSERT that names no version, in a transaction that has ALREADY RETIRED a sibling
--     generation of the same (consumer, projectId), takes that sibling's version;
--     every other un-versioned INSERT takes 1.
--
-- That is structural, not a guess about intent, and the structure is checkable rather than
-- asserted. `ProjectionRebuilder` INSERTS its new generation in ONE transaction and retires the
-- incumbent in a LATER one — logic that predates this change, so the PREVIOUS release's CLI has
-- the same shape and can never satisfy the same-transaction condition; it always stamps 1, which
-- is what keeps it refusable. The relay's lazy bootstrap retires nothing, so it stamps 1 too. The
-- 4a repair retires-then-inserts in a single transaction and is the only writer that inherits.
--
-- `xmin` is the right instrument for precisely this claim — "written by the transaction that
-- retired the predecessor" — and is used for nothing wider. It is not being asked to prove that
-- some state transition happened, which is the use it is unsuited for.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────────
--
-- It bumps NO consumer's version. Every consumer stays at its current `catalogVersion`, so the
-- serve-side comparison is false for every generation on every deployed database and no read
-- changes behaviour today. The machinery is installed and probed; the first consumer to change its
-- serializer arms it, in the migration that changes that serializer.
--
-- Every statement is retry-safe: a deploy that dies partway must COMPLETE on re-run.

-- ── 1. the column, NULLABLE ────────────────────────────────────────────────────────────────────
ALTER TABLE "ProjectionGeneration" ADD COLUMN IF NOT EXISTS "catalogVersion" INTEGER;

-- ── 2. the backfill, from the version those generations were ACTUALLY built at ─────────────────
-- Read from the PERSISTED catalog rather than defaulted, so no row silently acquires a version it
-- was not built with. A generation whose consumer has no catalog row at all predates that registry;
-- 1 is the only version such a row can have been built at.
UPDATE "ProjectionGeneration" g
   SET "catalogVersion" = COALESCE(
         (SELECT c."catalogVersion" FROM "OutboxConsumerCatalog" c WHERE c."consumer" = g."consumer"),
         1
       )
 WHERE g."catalogVersion" IS NULL;

-- ── 3. the STAMP, for writers that do not know the column exists ───────────────────────────────
-- Installed BEFORE `SET NOT NULL` so an un-versioned writer is never briefly rejected while this
-- migration is mid-flight, and AFTER the backfill so it never touches an existing row.
CREATE OR REPLACE FUNCTION projection_generation_stamp_version() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE inherited INTEGER;
BEGIN
  IF NEW."catalogVersion" IS NOT NULL THEN
    RETURN NEW; -- the running code stamped it explicitly; never second-guess that
  END IF;
  -- The 4a-repair shape: this transaction has already retired the generation whose ROWS this one
  -- copies, so that generation's version is this one's. `xmin` is what makes it the SAME
  -- transaction and not merely some earlier retirement — a rebuild retires in a later transaction
  -- than it inserts, so the previous release's CLI cannot reach this branch.
  SELECT s."catalogVersion" INTO inherited
    FROM "ProjectionGeneration" s
   WHERE s."consumer" = NEW."consumer" AND s."projectId" = NEW."projectId"
     AND s."status" = 'retired'
     AND s.xmin::text::bigint = pg_current_xact_id()::text::bigint
   ORDER BY s."generation" DESC
   LIMIT 1;
  -- Otherwise 1, which is the TRUTH about such a row: it was written by something that does not
  -- know this column exists, so 1 is the only version its contents can have.
  NEW."catalogVersion" := COALESCE(inherited, 1);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ProjectionGeneration_stamp_version" ON "ProjectionGeneration";
CREATE TRIGGER "ProjectionGeneration_stamp_version"
  BEFORE INSERT ON "ProjectionGeneration"
  FOR EACH ROW EXECUTE FUNCTION projection_generation_stamp_version();

-- ── 4. NOT NULL — satisfied by the stamp above, which runs first ───────────────────────────────
DO $$ BEGIN
  ALTER TABLE "ProjectionGeneration" ALTER COLUMN "catalogVersion" SET NOT NULL;
EXCEPTION WHEN others THEN
  -- `SET NOT NULL` is idempotent, so reaching this handler means a row is still NULL — which can
  -- only happen if step 2 did not run. Re-raise: a silently skipped stamp is worse than a failed
  -- deploy.
  RAISE;
END $$;
