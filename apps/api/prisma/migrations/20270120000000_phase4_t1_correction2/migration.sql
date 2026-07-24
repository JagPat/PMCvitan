-- Phase 4 Task 1 CORRECTION 2 — make the labour-demand and worker-skill invariants DURABLE under
-- EVERY later database mutation, not merely valid at their initial insertion (re-review findings 1 + 2).
-- The deployed 20270115000000 migration is left BYTE-FOR-BYTE UNCHANGED. ADDITIVE + DIAGNOSTIC-FIRST.
--
-- Finding 1 (P1): the demand seal fired only on LabourRequirementSpec INSERT, so a LabourDemandSlice
--   appended in a LATER transaction was never re-validated — the sealed aggregate silently drifted
--   (requiredQty != SUM, requiredBy != MAX). The validator is refactored to a KEY-BASED check over the
--   WHOLE aggregate and fired at DEFERRED COMMIT from BOTH the spec insert AND every slice insert.
-- Finding 2 (P2): Worker.skillCodes containment fired only on worker INSERT/UPDATE, so a LabourSkill
--   could be DELETEd (or re-keyed) out from under a worker still referencing it. A reverse guard makes
--   the reference bidirectional — the row a worker points at can no longer disappear.

-- pgcrypto supplies digest() for the canonical-fingerprint recomputation (a no-op if already present).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 0. DIAGNOSTIC-FIRST — the gap 20270115 left open may already have produced an inconsistent state on
--    an eligible database (a slice appended after the seal; a skill deleted under a worker). ABORT so
--    an operator repairs the data first; this migration NEVER edits or fabricates a labour row. On a
--    database where the labour pilot has not run (or is coherent), every count is zero and it proceeds.
-- ============================================================================
DO $$
DECLARE
  n_bad_demand    bigint;
  n_orphan_worker bigint;
BEGIN
  -- A labour revision whose FULL slice set no longer matches its frozen aggregate (the finding-1 drift):
  -- missing slices / wrong uom / requiredQty != SUM(personShiftQty) / requiredBy != MAX(civilDate) /
  -- forged fingerprint. The canonical fingerprint is recomputed exactly as the shared helper hashes it.
  SELECT count(*) INTO n_bad_demand
    FROM "LabourRequirementSpec" s
    JOIN "ActivityRequirement" ar
      ON ar."projectId" = s."projectId" AND ar."requirementId" = s."requirementId" AND ar."revision" = s."revision"
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, COALESCE(sum(d."personShiftQty"), 0) AS q, max(d."civilDate") AS m
        FROM "LabourDemandSlice" d
       WHERE d."projectId" = s."projectId" AND d."requirementId" = s."requirementId" AND d."revision" = s."revision"
    ) sl ON true
   WHERE ar."type" = 'labour'
     AND ( sl.n < 1
        OR ar."baseUom" IS DISTINCT FROM 'person-shift'
        OR ar."requiredQty" IS DISTINCT FROM sl.q::numeric
        OR ar."requiredBy" IS DISTINCT FROM sl.m
        OR s."labourSpecFingerprint" IS DISTINCT FROM encode(digest(
             'lsf.v1' || chr(31)
             || 'trade:' || lower(btrim(regexp_replace(s."tradeCode", '\s+', ' ', 'g')))
             || chr(31) || 'skill:' || COALESCE(lower(btrim(regexp_replace(s."skillCode", '\s+', ' ', 'g'))), '')
             || chr(31) || 'shift:' || s."shift", 'sha256'), 'hex') );
  IF n_bad_demand > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction 2 ABORTED — % labour requirement revision(s) hold an inconsistent demand aggregate (a slice was appended after the initial seal, so requiredQty/requiredBy/SUM/MAX no longer agree). Repair the data — within a maintenance window, remove the offending slice(s) so the aggregate matches the frozen revision — before re-running; this migration never edits demand rows.', n_bad_demand;
  END IF;

  -- A Worker.skillCodes element whose LabourSkill has since disappeared (the finding-2 reverse gap).
  SELECT count(*) INTO n_orphan_worker
    FROM "Worker" w, unnest(w."skillCodes") AS sc
   WHERE NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = w."projectId" AND k."code" = sc);
  IF n_orphan_worker > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction 2 ABORTED — % Worker.skillCodes element(s) reference a LabourSkill that no longer exists in the project catalog. Restore the skill (re-INSERT the catalog row), or remove the dangling code from the worker, before re-running.', n_orphan_worker;
  END IF;
END $$;

-- ============================================================================
-- 1. FINDING 1 — the demand seal is KEY-BASED and fired from BOTH the spec and every slice insert.
--    A slice appended in a later transaction re-runs the WHOLE-aggregate check at ITS commit; because
--    requiredQty/requiredBy are frozen on the immutable ActivityRequirement revision row, any added
--    slice breaks SUM/MAX and the commit fails. The error text is preserved so 20270115's probes hold.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase4_labour_demand_check(p_project text, p_req text, p_rev integer) RETURNS void AS $$
DECLARE
  ar_type     TEXT;
  ar_uom      TEXT;
  ar_qty      NUMERIC;
  ar_by       DATE;
  spec_count  INTEGER;
  s_trade     TEXT;
  s_skill     TEXT;
  s_shift     TEXT;
  s_fp        TEXT;
  slice_count INTEGER;
  slice_sum   BIGINT;
  slice_max   DATE;
  expected_fp TEXT;
BEGIN
  SELECT ar."type"::text, ar."baseUom", ar."requiredQty", ar."requiredBy"
    INTO ar_type, ar_uom, ar_qty, ar_by
    FROM "ActivityRequirement" ar
   WHERE ar."projectId" = p_project AND ar."requirementId" = p_req AND ar."revision" = p_rev;
  -- only labour revisions carry a demand aggregate; a material revision (or a revision its FK forbids
  -- from vanishing) has nothing to seal here.
  IF ar_type IS DISTINCT FROM 'labour' THEN
    RETURN;
  END IF;

  SELECT count(*) INTO spec_count FROM "LabourRequirementSpec" s
   WHERE s."projectId" = p_project AND s."requirementId" = p_req AND s."revision" = p_rev;
  IF spec_count <> 1 THEN
    RAISE EXCEPTION 'labour requirement %/rev % must have exactly one LabourRequirementSpec (found %)', p_req, p_rev, spec_count;
  END IF;
  SELECT s."tradeCode", s."skillCode", s."shift", s."labourSpecFingerprint"
    INTO s_trade, s_skill, s_shift, s_fp
    FROM "LabourRequirementSpec" s
   WHERE s."projectId" = p_project AND s."requirementId" = p_req AND s."revision" = p_rev;

  SELECT count(*), COALESCE(sum("personShiftQty"), 0), max("civilDate")
    INTO slice_count, slice_sum, slice_max
    FROM "LabourDemandSlice"
   WHERE "projectId" = p_project AND "requirementId" = p_req AND "revision" = p_rev;
  IF slice_count < 1 THEN
    RAISE EXCEPTION 'labour requirement %/rev % must carry at least one demand slice', p_req, p_rev;
  END IF;
  IF ar_uom IS DISTINCT FROM 'person-shift' THEN
    RAISE EXCEPTION 'labour requirement %/rev % baseUom must be person-shift (found %)', p_req, p_rev, ar_uom;
  END IF;
  IF ar_qty IS DISTINCT FROM slice_sum::numeric THEN
    RAISE EXCEPTION 'labour requirement %/rev % requiredQty (%) must equal SUM(personShiftQty)=%', p_req, p_rev, ar_qty, slice_sum;
  END IF;
  IF ar_by IS DISTINCT FROM slice_max THEN
    RAISE EXCEPTION 'labour requirement %/rev % requiredBy (%) must equal MAX(civilDate)=%', p_req, p_rev, ar_by, slice_max;
  END IF;
  expected_fp := encode(digest(
    'lsf.v1' || chr(31)
    || 'trade:' || lower(btrim(regexp_replace(s_trade, '\s+', ' ', 'g')))
    || chr(31) || 'skill:' || COALESCE(lower(btrim(regexp_replace(s_skill, '\s+', ' ', 'g'))), '')
    || chr(31) || 'shift:' || s_shift, 'sha256'), 'hex');
  IF s_fp IS DISTINCT FROM expected_fp THEN
    RAISE EXCEPTION 'labour requirement %/rev % labourSpecFingerprint does not match the canonical (tradeCode,skillCode,shift) hash', p_req, p_rev;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The spec-insert wrapper (the existing LabourRequirementSpec_demand_sealed constraint trigger keeps
-- calling this function by name; its body now delegates to the key-based check).
CREATE OR REPLACE FUNCTION phase4_labour_demand_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase4_labour_demand_check(NEW."projectId", NEW."requirementId", NEW."revision");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The slice-insert wrapper — the gap the re-review found. A slice landing in any transaction re-checks
-- the whole aggregate at that transaction's commit.
CREATE OR REPLACE FUNCTION phase4_labour_demand_sealed_slice() RETURNS trigger AS $$
BEGIN
  PERFORM phase4_labour_demand_check(NEW."projectId", NEW."requirementId", NEW."revision");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LabourDemandSlice_demand_sealed" ON "LabourDemandSlice";
CREATE CONSTRAINT TRIGGER "LabourDemandSlice_demand_sealed"
  AFTER INSERT ON "LabourDemandSlice"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase4_labour_demand_sealed_slice();

-- ============================================================================
-- 2. FINDING 2 — worker-skill referential integrity made BIDIRECTIONAL.
--    The forward trigger (Worker_skills_contained) rejects an unknown/cross-project code on worker
--    insert/update. This reverse guard rejects a LabourSkill DELETE, or a (code/projectId) re-key,
--    while any same-project Worker.skillCodes element still references it — so a reference can never
--    dangle. (LabourRequirementSpec.skillCode is already protected by its composite FK.)
-- ============================================================================
CREATE OR REPLACE FUNCTION phase4_labour_skill_referenced_guard() RETURNS trigger AS $$
BEGIN
  -- an UPDATE that leaves (projectId, code) unchanged creates no dangling reference.
  IF TG_OP = 'UPDATE' AND OLD."code" = NEW."code" AND OLD."projectId" = NEW."projectId" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Worker" w
     WHERE w."projectId" = OLD."projectId" AND OLD."code" = ANY(w."skillCodes")
  ) THEN
    RAISE EXCEPTION 'LabourSkill %/% is referenced by a Worker.skillCodes element and cannot be deleted or re-keyed', OLD."projectId", OLD."code";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LabourSkill_referenced_guard" ON "LabourSkill";
CREATE TRIGGER "LabourSkill_referenced_guard"
  BEFORE DELETE OR UPDATE ON "LabourSkill"
  FOR EACH ROW EXECUTE FUNCTION phase4_labour_skill_referenced_guard();
