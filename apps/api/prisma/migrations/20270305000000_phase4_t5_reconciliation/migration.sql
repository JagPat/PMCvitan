-- Phase 4 Task 5 — §E labour-mismatch reconciliation + §I measured output. ADDITIVE and
-- diagnostic-first: three new tables (LabourMismatch, LabourMismatchResolution — labour-owned;
-- ActivityWorkOutput — activities-owned), their same-project composite FKs, append-only seals and
-- CHECKs. No existing table, column or migration byte changes. A legacy database upgrades with
-- every new table ROW-FREE (the closing block ABORTS if any row exists — never invents data).
--
-- RETRY-SAFE: every statement is guarded so a crash between a statement and Prisma recording the
-- migration leaves a rerunnable migration — the retry is a no-op, never "relation already exists".

CREATE TABLE IF NOT EXISTS "LabourMismatch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "civilDate" DATE NOT NULL,
    "shift" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workerId" TEXT,
    "note" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "LabourMismatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LabourMismatchResolution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mismatchId" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "LabourMismatchResolution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ActivityWorkOutput" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "civilDate" DATE NOT NULL,
    "shift" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "uom" TEXT NOT NULL,
    "evidenceMediaId" TEXT,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "ActivityWorkOutput_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LabourMismatch_projectId_id_key" ON "LabourMismatch"("projectId", "id");
CREATE INDEX IF NOT EXISTS "LabourMismatch_projectId_activityId_idx" ON "LabourMismatch"("projectId", "activityId");
-- ONE resolution per observation (§E) — a second resolution is unrepresentable
CREATE UNIQUE INDEX IF NOT EXISTS "LabourMismatchResolution_projectId_mismatchId_key" ON "LabourMismatchResolution"("projectId", "mismatchId");
CREATE UNIQUE INDEX IF NOT EXISTS "LabourMismatchResolution_projectId_id_key" ON "LabourMismatchResolution"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityWorkOutput_projectId_id_key" ON "ActivityWorkOutput"("projectId", "id");
CREATE INDEX IF NOT EXISTS "ActivityWorkOutput_projectId_activityId_civilDate_shift_idx" ON "ActivityWorkOutput"("projectId", "activityId", "civilDate", "shift");

-- Same-project composite FKs: a cross-project reference is unrepresentable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_projectId_fkey') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_projectId_activityId_fkey') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_projectId_workerId_fkey') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_projectId_workerId_fkey" FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_recordedById_fkey') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatchResolution_projectId_fkey') THEN
    ALTER TABLE "LabourMismatchResolution" ADD CONSTRAINT "LabourMismatchResolution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatchResolution_projectId_mismatchId_fkey') THEN
    ALTER TABLE "LabourMismatchResolution" ADD CONSTRAINT "LabourMismatchResolution_projectId_mismatchId_fkey" FOREIGN KEY ("projectId", "mismatchId") REFERENCES "LabourMismatch"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatchResolution_resolvedById_fkey') THEN
    ALTER TABLE "LabourMismatchResolution" ADD CONSTRAINT "LabourMismatchResolution_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_projectId_fkey') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_projectId_activityId_fkey') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_projectId_evidenceMediaId_fkey') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_projectId_evidenceMediaId_fkey" FOREIGN KEY ("projectId", "evidenceMediaId") REFERENCES "Media"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_recordedById_fkey') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- Provenance: every fact row cites the committed command that produced it — a nonexistent or
-- other-project command id is unrepresentable (the §C composite-FK rule).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_projectId_sourceCommandId_fkey') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_projectId_sourceCommandId_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatchResolution_projectId_sourceCommandId_fkey') THEN
    ALTER TABLE "LabourMismatchResolution" ADD CONSTRAINT "LabourMismatchResolution_projectId_sourceCommandId_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_projectId_sourceCommandId_fkey') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_projectId_sourceCommandId_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- CHECKs: the observation kind is closed; measured output is strictly positive; user-supplied
-- evidence text can never be blank (the complete-whitespace set, incl. VT/FF).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_kind_check') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_kind_check" CHECK ("kind" IN ('wrong_trade', 'shortfall'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_quantity_check') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_quantity_check" CHECK ("quantity" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatch_note_nonblank') THEN
    ALTER TABLE "LabourMismatch" ADD CONSTRAINT "LabourMismatch_note_nonblank" CHECK (btrim("note", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourMismatchResolution_text_nonblank') THEN
    ALTER TABLE "LabourMismatchResolution" ADD CONSTRAINT "LabourMismatchResolution_text_nonblank" CHECK (btrim("resolution", E' \t\n\x0B\f\r') <> '' AND btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityWorkOutput_text_nonblank') THEN
    ALTER TABLE "ActivityWorkOutput" ADD CONSTRAINT "ActivityWorkOutput_text_nonblank" CHECK (btrim("uom", E' \t\n\x0B\f\r') <> '' AND ("note" IS NULL OR btrim("note", E' \t\n\x0B\f\r') <> ''));
  END IF;
END $$;

-- Append-only seals: an observation, its resolution and a measured-output fact are history —
-- UPDATE and DELETE are forbidden (the Phase-3 generic immutability function, already deployed).
DROP TRIGGER IF EXISTS "LabourMismatch_append_only" ON "LabourMismatch";
CREATE TRIGGER "LabourMismatch_append_only" BEFORE UPDATE OR DELETE ON "LabourMismatch"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
DROP TRIGGER IF EXISTS "LabourMismatchResolution_append_only" ON "LabourMismatchResolution";
CREATE TRIGGER "LabourMismatchResolution_append_only" BEFORE UPDATE OR DELETE ON "LabourMismatchResolution"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
DROP TRIGGER IF EXISTS "ActivityWorkOutput_append_only" ON "ActivityWorkOutput";
CREATE TRIGGER "ActivityWorkOutput_append_only" BEFORE UPDATE OR DELETE ON "ActivityWorkOutput"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- Diagnostic close: this migration creates structure only. Any pre-existing row in a NEW table
-- means the database was written outside the sanctioned path — ABORT, never adopt or invent.
DO $$
DECLARE mismatches integer; resolutions integer; outputs integer;
BEGIN
  SELECT COUNT(*) INTO mismatches FROM "LabourMismatch";
  SELECT COUNT(*) INTO resolutions FROM "LabourMismatchResolution";
  SELECT COUNT(*) INTO outputs FROM "ActivityWorkOutput";
  IF mismatches > 0 OR resolutions > 0 OR outputs > 0 THEN
    RAISE EXCEPTION 'phase4_t5: expected row-free new tables, found LabourMismatch=% LabourMismatchResolution=% ActivityWorkOutput=%', mismatches, resolutions, outputs;
  END IF;
END $$;
