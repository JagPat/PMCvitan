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
  -- §0 `OUTPUT` is a PREDICATE: the cited row must EXIST and belong to this project. The FK is the
  -- authority (the cleared attendance-evidence precedent), and the service asserts it belongs to
  -- the measurement's own activity — a cross-activity citation is progress evidence for other work.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_citedOutputId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_citedOutputId_fkey" FOREIGN KEY ("projectId", "citedOutputId") REFERENCES "ActivityWorkOutput"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_projectId_correctsId_fkey') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_projectId_correctsId_fkey" FOREIGN KEY ("projectId", "correctsId") REFERENCES "Measurement"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Measurement_quantity_check') THEN
    ALTER TABLE "Measurement" ADD CONSTRAINT "Measurement_quantity_check" CHECK ("quantity" <> 0);
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
