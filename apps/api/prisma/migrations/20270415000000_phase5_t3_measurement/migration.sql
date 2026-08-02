-- Phase 5 Task 3 — the §D MEASUREMENT: a contractually agreed quantity at a contract rate.
-- ADDITIVE and diagnostic-first: one new table, its same-project composite FKs, CHECKs and the
-- immutability trigger. No existing table, column or migration byte changes. A legacy database
-- upgrades with the new table ROW-FREE.
--
-- RETRY-SAFE: every statement is guarded, so a crash between a statement and Prisma recording the
-- migration leaves a rerunnable migration.

CREATE TABLE IF NOT EXISTS "Measurement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "labourPoLineId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "correctsId" TEXT,
    "reason" TEXT,
    "measuredOn" DATE NOT NULL,
    "citedOutputId" TEXT NOT NULL,
    "evidenceMediaId" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Measurement_projectId_id_key" ON "Measurement"("projectId", "id");
-- Codex round-4 P2 — the candidate key a CORRECTION binds to, so a correction and the row it
-- adjusts necessarily describe the same work. Unique because `(projectId,"id")` already is:
-- widening a unique key adds an FK target, it never constrains what may be stored.
CREATE UNIQUE INDEX IF NOT EXISTS "Measurement_corrects_identity_key" ON "Measurement"("projectId", "id", "labourPoLineId", "activityId", "citedOutputId");
-- …and the same widening on the ACTIVITIES-owned output table, so a cited output can be bound to
-- the measurement's own activity. Additive on an existing table: no row can fail it.
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityWorkOutput_projectId_id_activityId_key" ON "ActivityWorkOutput"("projectId", "id", "activityId");
CREATE INDEX IF NOT EXISTS "Measurement_projectId_labourPoLineId_idx" ON "Measurement"("projectId", "labourPoLineId");
CREATE INDEX IF NOT EXISTS "Measurement_projectId_activityId_idx" ON "Measurement"("projectId", "activityId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- §D: LABOUR only. There is no `poLineId` column, so a MATERIAL measurement is unrepresentable
  -- rather than merely refused — `ACCEPTED(poLine)` already is the measurement of a delivery.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_labourPoLineId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_labourPoLineId_fkey" FOREIGN KEY ("projectId", "labourPoLineId") REFERENCES "LabourPurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_activityId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- §0 `OUTPUT` is a PREDICATE: the cited row must EXIST and belong to this project — AND to the
  -- measurement's OWN activity. Codex round-4 P2: project containment alone let a maintenance
  -- insert or a future writer store `activityId = A` while citing an output recorded against B,
  -- and because the row is immutable, sign-off withdrawal and later billing would treat B's
  -- progress as evidence for A permanently. The service check protects the rows IT writes; this
  -- protects the rows the READ will find.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_citedOutputId_activityId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_citedOutputId_activityId_fkey" FOREIGN KEY ("projectId", "citedOutputId", "activityId") REFERENCES "ActivityWorkOutput"("projectId", "id", "activityId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- Codex round-4 P2 — a correction carries the target's WHOLE WORK IDENTITY. Proving only that
  -- the target EXISTS let a correction name original A while its own line/activity/output
  -- described B's work: the fold applied the signed quantity to B while `netOf(A)` counted it as
  -- A's child, so the register could add or withdraw payable evidence for a line the correction
  -- does not name.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_corrects_identity_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_corrects_identity_fkey" FOREIGN KEY ("projectId", "correctsId", "labourPoLineId", "activityId", "citedOutputId") REFERENCES "Measurement"("projectId", "id", "labourPoLineId", "activityId", "citedOutputId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_evidenceMediaId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_evidenceMediaId_fkey" FOREIGN KEY ("projectId", "evidenceMediaId") REFERENCES "Media"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_takenById_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_takenById_fkey" FOREIGN KEY ("takenById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_sourceCommandId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_sourceCommandId_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- a row that measures NOTHING is not a measurement and not a correction; the interesting bounds
  -- (never negative, never above EFFORT, never above the ordered authority) are properties of the
  -- FOLD, which no per-row CHECK can express — they are re-derived under lock by the service
  -- An ORIGINAL measurement records work that HAPPENED, so it is strictly positive; only a
  -- CORRECTION carries a sign. Without this a direct insert can leave a negative original in the
  -- register — and because the row is immutable, that corrupted billing evidence is permanent and
  -- bypasses every service-side floor the sign-off and ordered guards reason over.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_quantity_check') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_quantity_check" CHECK (
      ("correctsId" IS NULL AND "quantity" > 0) OR ("correctsId" IS NOT NULL AND "quantity" <> 0)
    );
  END IF;
  -- a signed delta with no reason is unauditable; an ORIGINAL measurement needs none
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_correction_reasoned') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_correction_reasoned" CHECK (
      ("correctsId" IS NULL) OR ("reason" IS NOT NULL AND btrim("reason", E' \t\n\x0B\f\r') <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_reason_nonblank') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_reason_nonblank" CHECK (
      "reason" IS NULL OR btrim("reason", E' \t\n\x0B\f\r') <> ''
    );
  END IF;
  -- a row cannot correct ITSELF: the fold would be self-referential and the §E consumption freeze
  -- could never resolve which row a certificate rests on
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_corrects_not_self') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_corrects_not_self" CHECK ("correctsId" IS NULL OR "correctsId" <> "id");
  END IF;
END $$;

-- §D — a correction targets an ORIGINAL measurement, never another correction. The service
-- refuses it too; this is the seal that makes a chain unrepresentable rather than merely refused,
-- because the row-level correction floor is only sound over a ONE-LEVEL tree.
--
-- Codex round-4 P1 — this MUST run at COMMIT, not BEFORE INSERT. A BEFORE trigger's ordinary
-- SELECT reads the inserting transaction's snapshot, which cannot see a CONCURRENT uncommitted
-- sibling: session 1 inserts correction B against original A; session 2, before B commits, inserts
-- C naming B. B is invisible to C's BEFORE trigger, so the check passed. The self-FK still held —
-- an FK check WAITS on the uncommitted referenced row, so C blocked until B committed and then
-- validated — which is precisely the problem: the FK settled AFTER the trigger had already
-- returned, and a correction-of-correction landed in an immutable register.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at C's COMMIT, by which point C has
-- necessarily blocked on B's FK and B is committed and visible. The one path to a chain is
-- therefore closed rather than narrowed. (The `phase4_labour_demand_sealed` deferred-seal
-- precedent, for the same reason: a check whose input another transaction can still change is not
-- a seal.)
CREATE OR REPLACE FUNCTION phase5_measurement_correction_target() RETURNS trigger AS $$
DECLARE target_corrects text;
BEGIN
  IF NEW."correctsId" IS NULL THEN RETURN NULL; END IF;
  SELECT "correctsId" INTO target_corrects FROM "Measurement"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."correctsId";
  IF target_corrects IS NOT NULL THEN
    RAISE EXCEPTION 'Measurement %: a correction may not target another correction (%) — address the original', NEW."id", NEW."correctsId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Measurement_correction_target" ON "Measurement";
CREATE CONSTRAINT TRIGGER "Measurement_correction_target" AFTER INSERT ON "Measurement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_measurement_correction_target();

-- §D — IMMUTABLE ONCE TAKEN. A correction is a NEW row carrying a signed delta, never an edit,
-- so there is no permitted UPDATE at all and no permitted DELETE. This is stricter than the
-- append-only tables that allow one supersession stamp: a measurement has no lifecycle to move
-- through, and its whole value as evidence is that the number recorded on the day cannot change.
CREATE OR REPLACE FUNCTION phase5_measurement_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Measurement %: immutable — a correction is a NEW row with a signed delta, never a DELETE', OLD."id";
  END IF;
  RAISE EXCEPTION 'Measurement %: immutable — a correction is a NEW row with a signed delta, never an UPDATE', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Measurement_immutable" ON "Measurement";
CREATE TRIGGER "Measurement_immutable" BEFORE UPDATE OR DELETE ON "Measurement"
  FOR EACH ROW EXECUTE FUNCTION phase5_measurement_immutable();

-- Diagnostic close: structure only. Any pre-existing row means the database was written outside
-- the sanctioned path — ABORT, never adopt or invent.
DO $$
DECLARE rows integer;
BEGIN
  SELECT COUNT(*) INTO rows FROM "Measurement";
  IF rows > 0 THEN
    RAISE EXCEPTION 'phase5_t3_measurement: expected a row-free Measurement, found %', rows;
  END IF;
END $$;

-- §B — `measurement` joins the headroom-mover set (§D makes measured person-shifts the labour
-- CONSUMPTION term). The set is closed at PostgreSQL so an unlabelled mover cannot be recorded.
ALTER TABLE "BudgetException" DROP CONSTRAINT IF EXISTS "BudgetException_raisedBy_check";
ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check"
  CHECK ("raisedBy" IN ('commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress', 'measurement'));
