-- Phase 4 Task 1 CORRECTION 3 — make the worker-skill referential invariant CONCURRENCY-SAFE by
-- NORMALIZING Worker.skillCodes into a WorkerSkill table with real composite FKs (re-review P1).
-- The earlier migrations (20270115000000, 20270120000000) are left BYTE-FOR-BYTE UNCHANGED.
-- ADDITIVE (new table) + DATA-PRESERVING (backfill) + DIAGNOSTIC-FIRST (abort on pre-existing orphans).
--
-- Re-review P1: the forward `Worker_skills_contained` trigger and the reverse `LabourSkill_referenced_guard`
--   trigger were two separate row-level triggers reading each other's table WITHOUT a shared lock, so a
--   concurrent worker-insert and skill-delete could each pass its own check (neither sees the other's
--   uncommitted row) and BOTH commit — orphaning the reference. A denormalized array cannot carry a
--   per-element FK, so the fix normalizes skills into WorkerSkill(projectId, workerId, skillCode) with a
--   composite FK to LabourSkill(projectId, code): PostgreSQL's FK machinery takes a KEY-SHARE lock on the
--   referenced skill row when a WorkerSkill is inserted, so a concurrent skill delete/re-key BLOCKS then
--   fails (or the insert fails if the delete won) — exactly one side commits and the DB is always valid.

-- ============================================================================
-- 0. DIAGNOSTIC-FIRST — never invent data. If any EXISTING Worker.skillCodes element already lacks its
--    same-project LabourSkill (e.g. an orphan left by the pre-fix race), ABORT so the operator repairs
--    it: the WorkerSkill backfill would otherwise fail the new FK, and this migration never fabricates a
--    catalog row or silently drops a skill. On a coherent (or labour-pilot-free) database, the count is
--    zero and it proceeds.
-- ============================================================================
DO $$
DECLARE
  n_orphan bigint;
BEGIN
  SELECT count(*) INTO n_orphan
    FROM "Worker" w, unnest(w."skillCodes") AS sc
   WHERE NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = w."projectId" AND k."code" = sc);
  IF n_orphan > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction 3 ABORTED — % Worker.skillCodes element(s) reference a LabourSkill absent from their project catalog. Repair the data (restore the missing skill, or remove the dangling code from the worker) before re-running; the WorkerSkill backfill will not fabricate a catalog entry.', n_orphan;
  END IF;
END $$;

-- ============================================================================
-- 1. The NORMALIZED relation — one row per (worker, skill), FK-bound to BOTH sides.
-- ============================================================================
CREATE TABLE "WorkerSkill" (
  "projectId" TEXT NOT NULL,
  "workerId"  TEXT NOT NULL,
  "skillCode" TEXT NOT NULL,
  CONSTRAINT "WorkerSkill_pkey" PRIMARY KEY ("projectId", "workerId", "skillCode")
);
CREATE INDEX "WorkerSkill_projectId_skillCode_idx" ON "WorkerSkill"("projectId", "skillCode");

-- ============================================================================
-- 2. DATA-PRESERVING backfill — every existing Worker.skillCodes element becomes a WorkerSkill row.
--    DISTINCT guards the PK in case an array ever carried a duplicate. (Diagnostic §0 guarantees each
--    referenced skill exists, so every backfilled row satisfies the FK added next.)
-- ============================================================================
INSERT INTO "WorkerSkill" ("projectId", "workerId", "skillCode")
  SELECT DISTINCT w."projectId", w."id", sc
    FROM "Worker" w, unnest(w."skillCodes") AS sc;

-- ============================================================================
-- 3. The real composite FKs — the concurrency-safe replacement for the two triggers.
--    - to Worker(projectId, id): a worker's skills belong to it (ON DELETE CASCADE).
--    - to LabourSkill(projectId, code): a referenced skill cannot be deleted OR re-keyed
--      (ON DELETE/UPDATE NO ACTION) — enforced with FK row locking, so the worker-insert vs
--      skill-delete race serializes instead of both committing.
-- ============================================================================
ALTER TABLE "WorkerSkill" ADD CONSTRAINT "WorkerSkill_projectId_workerId_fkey"
  FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "WorkerSkill" ADD CONSTRAINT "WorkerSkill_projectId_skillCode_fkey"
  FOREIGN KEY ("projectId", "skillCode") REFERENCES "LabourSkill"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 4. Retire the racing triggers + the denormalized column. The forward containment trigger and the
--    reverse-guard trigger are both SUPERSEDED by the WorkerSkill FKs (which are concurrency-safe);
--    the skillCodes array is now redundant (its data lives in WorkerSkill).
-- ============================================================================
DROP TRIGGER IF EXISTS "Worker_skills_contained" ON "Worker";
DROP FUNCTION IF EXISTS phase4_worker_skills_contained();
DROP TRIGGER IF EXISTS "LabourSkill_referenced_guard" ON "LabourSkill";
DROP FUNCTION IF EXISTS phase4_labour_skill_referenced_guard();

ALTER TABLE "Worker" DROP COLUMN "skillCodes";
