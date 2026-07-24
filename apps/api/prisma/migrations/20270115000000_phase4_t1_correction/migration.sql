-- Phase 4 Task 1 CORRECTION — DB-enforce the labour-demand and skill-reference invariants the
-- service already validated (review findings F2 + F3). ADDITIVE + DIAGNOSTIC-FIRST.
--
-- F2 (demand seal): a `type='labour'` requirement revision is only VALID when, taken as a whole,
--   it carries at least one demand slice, `baseUom = 'person-shift'`, `requiredQty = SUM(personShiftQty)`,
--   `requiredBy = MAX(civilDate)`, and a `labourSpecFingerprint` equal to the canonical SHA-256 over
--   its `(tradeCode, skillCode, shift)` identity. Validated at DEFERRED COMMIT (the revision, spec
--   and slices may land in any order in one tx), so a forged/incoherent labour revision cannot commit.
-- F3 (skill references): `LabourRequirementSpec.skillCode` gets a same-project composite FK to
--   `LabourSkill`, and `Worker.skillCodes[]` (an array cannot carry a per-element FK) gets an
--   equivalent DB-enforced relation — a trigger rejecting any element not in the same-project catalog.
--   A nonexistent OR cross-project skill is now unrepresentable in PostgreSQL, not merely refused in code.

-- pgcrypto supplies digest() for the canonical-fingerprint recomputation (available on the managed
-- Postgres + the CI/dev containers; a no-op if already present).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 0. DIAGNOSTIC-FIRST — never invent data; ABORT if any EXISTING labour row already contradicts
--    the invariants this migration installs (so an operator investigates rather than the deploy
--    silently failing at the first constraint). On a database where the labour pilot has not run,
--    every count is zero and the migration proceeds.
-- ============================================================================
DO $$
DECLARE
  n_bad_spec_skill    bigint;
  n_bad_worker_skill  bigint;
  n_bad_demand        bigint;
BEGIN
  -- F3a: a spec skillCode that is not a same-project catalog skill.
  SELECT count(*) INTO n_bad_spec_skill
    FROM "LabourRequirementSpec" s
   WHERE s."skillCode" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = s."projectId" AND k."code" = s."skillCode");
  IF n_bad_spec_skill > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction ABORTED — % LabourRequirementSpec row(s) reference a skillCode absent from their project catalog. Fix the data before adding the FK; this migration never fabricates a catalog entry.', n_bad_spec_skill;
  END IF;

  -- F3b: a worker skill array element that is not a same-project catalog skill.
  SELECT count(*) INTO n_bad_worker_skill
    FROM "Worker" w, unnest(w."skillCodes") AS sc
   WHERE NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = w."projectId" AND k."code" = sc);
  IF n_bad_worker_skill > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction ABORTED — % Worker skillCodes element(s) reference a skill absent from their project catalog.', n_bad_worker_skill;
  END IF;

  -- F2: a labour revision that violates the demand seal (missing slices / wrong uom / wrong sum /
  -- wrong needed-by / forged fingerprint). Recompute the canonical fingerprint exactly as the app.
  SELECT count(*) INTO n_bad_demand
    FROM "LabourRequirementSpec" s
    JOIN "ActivityRequirement" ar
      ON ar."projectId" = s."projectId" AND ar."requirementId" = s."requirementId" AND ar."revision" = s."revision"
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, COALESCE(sum(d."personShiftQty"), 0) AS q, max(d."civilDate") AS m
        FROM "LabourDemandSlice" d
       WHERE d."projectId" = s."projectId" AND d."requirementId" = s."requirementId" AND d."revision" = s."revision"
    ) sl ON true
   WHERE sl.n < 1
      OR ar."baseUom" IS DISTINCT FROM 'person-shift'
      OR ar."requiredQty" IS DISTINCT FROM sl.q::numeric
      OR ar."requiredBy" IS DISTINCT FROM sl.m
      OR s."labourSpecFingerprint" IS DISTINCT FROM encode(digest(
           'lsf.v1' || chr(31)
           || 'trade:' || lower(btrim(regexp_replace(s."tradeCode", '\s+', ' ', 'g')))
           || chr(31) || 'skill:' || COALESCE(lower(btrim(regexp_replace(s."skillCode", '\s+', ' ', 'g'))), '')
           || chr(31) || 'shift:' || s."shift", 'sha256'), 'hex');
  IF n_bad_demand > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 correction ABORTED — % labour requirement revision(s) violate the demand seal (slices/baseUom/requiredQty/requiredBy/fingerprint). Investigate before re-running.', n_bad_demand;
  END IF;
END $$;

-- ============================================================================
-- 1. F3 — SKILL REFERENCES ENFORCED IN POSTGRESQL.
-- ============================================================================
-- LabourRequirementSpec.skillCode: a same-project composite FK (NULLABLE — a bare-trade demand has
-- no skill; MATCH SIMPLE passes when skillCode IS NULL, and when present requires the same-project
-- catalog row, so a nonexistent OR cross-project skill is unrepresentable).
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_projectId_skillCode_fkey"
  FOREIGN KEY ("projectId", "skillCode") REFERENCES "LabourSkill"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Worker.skillCodes[]: an array field cannot carry a per-element referential FK, so a BEFORE
-- INSERT OR UPDATE trigger is the equivalent DB-enforced relation — every element must be a skill
-- in the SAME project's catalog (a nonexistent OR cross-project code is rejected).
CREATE OR REPLACE FUNCTION phase4_worker_skills_contained() RETURNS trigger AS $$
DECLARE
  bad TEXT;
BEGIN
  IF NEW."skillCodes" IS NOT NULL AND array_length(NEW."skillCodes", 1) IS NOT NULL THEN
    SELECT sc INTO bad
      FROM unnest(NEW."skillCodes") AS sc
     WHERE NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = NEW."projectId" AND k."code" = sc)
     LIMIT 1;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'Worker skill "%" is not a skill in this project''s catalog (project %)', bad, NEW."projectId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Worker_skills_contained"
  BEFORE INSERT OR UPDATE ON "Worker"
  FOR EACH ROW EXECUTE FUNCTION phase4_worker_skills_contained();

-- ============================================================================
-- 2. F2 — LABOUR DEMAND SEALED AT DEFERRED COMMIT.
--    One LabourRequirementSpec exists per labour revision, so a DEFERRABLE INITIALLY DEFERRED
--    constraint trigger on it fires exactly once per revision at commit — by which point the
--    ActivityRequirement row and every slice are present, whatever order they were inserted in.
--    Material revisions have no LabourRequirementSpec row, so this trigger never touches them.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase4_labour_demand_sealed() RETURNS trigger AS $$
DECLARE
  ar_type     TEXT;
  ar_uom      TEXT;
  ar_qty      NUMERIC;
  ar_by       DATE;
  slice_count INTEGER;
  slice_sum   BIGINT;
  slice_max   DATE;
  expected_fp TEXT;
BEGIN
  SELECT ar."type"::text, ar."baseUom", ar."requiredQty", ar."requiredBy"
    INTO ar_type, ar_uom, ar_qty, ar_by
    FROM "ActivityRequirement" ar
   WHERE ar."projectId" = NEW."projectId" AND ar."requirementId" = NEW."requirementId" AND ar."revision" = NEW."revision";
  -- the row that fired this trigger is a labour spec; the type<->detail pairing trigger owns any
  -- type mismatch, so here we only enforce the demand shape of a genuine labour revision.
  IF ar_type IS DISTINCT FROM 'labour' THEN
    RETURN NULL;
  END IF;
  SELECT count(*), COALESCE(sum("personShiftQty"), 0), max("civilDate")
    INTO slice_count, slice_sum, slice_max
    FROM "LabourDemandSlice"
   WHERE "projectId" = NEW."projectId" AND "requirementId" = NEW."requirementId" AND "revision" = NEW."revision";
  IF slice_count < 1 THEN
    RAISE EXCEPTION 'labour requirement %/rev % must carry at least one demand slice', NEW."requirementId", NEW."revision";
  END IF;
  IF ar_uom IS DISTINCT FROM 'person-shift' THEN
    RAISE EXCEPTION 'labour requirement %/rev % baseUom must be person-shift (found %)', NEW."requirementId", NEW."revision", ar_uom;
  END IF;
  IF ar_qty IS DISTINCT FROM slice_sum::numeric THEN
    RAISE EXCEPTION 'labour requirement %/rev % requiredQty (%) must equal SUM(personShiftQty)=%', NEW."requirementId", NEW."revision", ar_qty, slice_sum;
  END IF;
  IF ar_by IS DISTINCT FROM slice_max THEN
    RAISE EXCEPTION 'labour requirement %/rev % requiredBy (%) must equal MAX(civilDate)=%', NEW."requirementId", NEW."revision", ar_by, slice_max;
  END IF;
  expected_fp := encode(digest(
    'lsf.v1' || chr(31)
    || 'trade:' || lower(btrim(regexp_replace(NEW."tradeCode", '\s+', ' ', 'g')))
    || chr(31) || 'skill:' || COALESCE(lower(btrim(regexp_replace(NEW."skillCode", '\s+', ' ', 'g'))), '')
    || chr(31) || 'shift:' || NEW."shift", 'sha256'), 'hex');
  IF NEW."labourSpecFingerprint" IS DISTINCT FROM expected_fp THEN
    RAISE EXCEPTION 'labour requirement %/rev % labourSpecFingerprint does not match the canonical (tradeCode,skillCode,shift) hash', NEW."requirementId", NEW."revision";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LabourRequirementSpec_demand_sealed"
  AFTER INSERT ON "LabourRequirementSpec"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase4_labour_demand_sealed();
