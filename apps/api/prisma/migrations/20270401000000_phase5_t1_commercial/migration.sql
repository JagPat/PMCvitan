-- Phase 5 Task 1 — the COMMERCIAL module: the cost-head catalog + the §C commitment
-- attribution, with the seals §C and §0b require. ADDITIVE and diagnostic-first: two new
-- tables, their same-project composite FKs, CHECKs, partial uniques and immutability triggers.
-- No existing table, column or migration byte changes. A legacy database upgrades with both
-- new tables ROW-FREE (the closing block ABORTS if any row exists — it never invents data).
--
-- RETRY-SAFE: every statement is guarded so a crash between a statement and Prisma recording
-- the migration leaves a rerunnable migration — the retry is a no-op, never "already exists".

CREATE TABLE IF NOT EXISTS "CostHead" (
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "definedById" TEXT NOT NULL,

    CONSTRAINT "CostHead_pkey" PRIMARY KEY ("projectId", "code")
);

-- §C: the attribution is the ONLY new fact. There is deliberately NO amount column — the
-- committed amount stays where it was frozen, on the PO-line snapshot, and `COMMITTED` (Task 2)
-- reads it through the OWNING module's query. A column to copy it into is how that rule gets
-- broken, so the absence is load-bearing and probe 5bi asserts it.
CREATE TABLE IF NOT EXISTS "CommitmentAttribution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poLineId" TEXT,
    "labourPoLineId" TEXT,
    "costHeadCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,

    CONSTRAINT "CommitmentAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommitmentAttribution_projectId_id_key" ON "CommitmentAttribution"("projectId", "id");
CREATE INDEX IF NOT EXISTS "CommitmentAttribution_projectId_costHeadCode_idx" ON "CommitmentAttribution"("projectId", "costHeadCode");

-- §C: exactly one ACTIVE attribution per PO line — the partial unique is per TARGET, not per
-- row, because the two targets are independent obligations. An amendment ISSUES A NEW VERSION
-- with new lines, so per-line uniqueness IS per-live-version uniqueness once the participant
-- supersedes the prior version's attribution in the same transaction (which it does at every
-- one of the four lifecycle sites). A cross-table "is this version live" predicate is not
-- expressible in an index; that half is the participant's, and probe 5y pins it.
CREATE UNIQUE INDEX IF NOT EXISTS "CommitmentAttribution_active_poLine_key"
  ON "CommitmentAttribution"("projectId", "poLineId")
  WHERE "supersededAt" IS NULL AND "poLineId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "CommitmentAttribution_active_labourPoLine_key"
  ON "CommitmentAttribution"("projectId", "labourPoLineId")
  WHERE "supersededAt" IS NULL AND "labourPoLineId" IS NOT NULL;

-- Same-project composite FKs: a cross-project reference is unrepresentable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CostHead_projectId_fkey') THEN
    ALTER TABLE "CostHead" ADD CONSTRAINT "CostHead_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CostHead_definedById_fkey') THEN
    ALTER TABLE "CostHead" ADD CONSTRAINT "CostHead_definedById_fkey" FOREIGN KEY ("definedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_projectId_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_projectId_poLineId_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_projectId_poLineId_fkey" FOREIGN KEY ("projectId", "poLineId") REFERENCES "PurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_projectId_labourPoLineId_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_projectId_labourPoLineId_fkey" FOREIGN KEY ("projectId", "labourPoLineId") REFERENCES "LabourPurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_projectId_costHeadCode_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_projectId_costHeadCode_fkey" FOREIGN KEY ("projectId", "costHeadCode") REFERENCES "CostHead"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_createdById_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_supersededById_fkey') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- §C: EXACTLY ONE attribution target. BOTH makes one row stand for two obligations (so
  -- superseding the material side silently un-attributes a live labour line); NEITHER lets
  -- issuance satisfy the never-unattributed partial unique with a fact that attributes nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_target_xor') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_target_xor" CHECK (("poLineId" IS NULL) <> ("labourPoLineId" IS NULL));
  END IF;
  -- §0b non-blank discipline, the complete ASCII whitespace set (incl. VT/FF).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CostHead_text_nonblank') THEN
    ALTER TABLE "CostHead" ADD CONSTRAINT "CostHead_text_nonblank" CHECK (btrim("code", E' \t\n\x0B\f\r') <> '' AND btrim("name", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_text_nonblank') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_text_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '' AND ("supersedeReason" IS NULL OR btrim("supersedeReason", E' \t\n\x0B\f\r') <> ''));
  END IF;
  -- The supersession stamp is all-or-nothing and always attributable: a half-stamped row would
  -- leave the line unattributed (out of the active partial unique) with nobody accountable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommitmentAttribution_supersede_complete') THEN
    ALTER TABLE "CommitmentAttribution" ADD CONSTRAINT "CommitmentAttribution_supersede_complete" CHECK (
      ("supersededAt" IS NULL AND "supersededById" IS NULL AND "supersedeReason" IS NULL)
      OR ("supersededAt" IS NOT NULL AND "supersededById" IS NOT NULL AND "supersedeReason" IS NOT NULL)
    );
  END IF;
END $$;

-- §0b "a key that groups facts is FROZEN after write": re-keying a cost head moves every
-- attribution and every budget exception that fired against it, with no evidence that it moved.
-- The FK already refuses re-keying a REFERENCED head; this trigger closes the unreferenced case,
-- which is exactly the silent `CIVIL -> MEP` rename. DELETE of an unreferenced head stays legal
-- (a referenced one is refused by the FK); `name` is a display label and stays editable.
CREATE OR REPLACE FUNCTION phase5_cost_head_key_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'CostHead %/%: the cost-head key is frozen after write — reclassify by defining a new head and re-attributing', OLD."projectId", OLD."code";
  END IF;
  IF NEW."definedAt" IS DISTINCT FROM OLD."definedAt" OR NEW."definedById" IS DISTINCT FROM OLD."definedById" THEN
    RAISE EXCEPTION 'CostHead %/%: definition provenance is frozen after write', OLD."projectId", OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CostHead_key_frozen" ON "CostHead";
CREATE TRIGGER "CostHead_key_frozen" BEFORE UPDATE ON "CostHead"
  FOR EACH ROW EXECUTE FUNCTION phase5_cost_head_key_frozen();

-- §C: the attribution is EVIDENCE, so the seal is on EVERY row from insertion — not only once
-- superseded. The ACTIVE row is precisely the one an in-place `CIVIL -> MEP` edit would move,
-- and it is not superseded at the moment of the edit. So: DELETE is refused ALWAYS, and UPDATE
-- is refused ALWAYS except the ONE controlled transition — stamping an ACTIVE row superseded.
-- Reclassification therefore has exactly one representable path and always leaves TWO rows.
CREATE OR REPLACE FUNCTION phase5_attribution_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CommitmentAttribution %: append-only — DELETE is refused', OLD."id";
  END IF;
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CommitmentAttribution %: already superseded — no further UPDATE is permitted', OLD."id";
  END IF;
  IF NEW."supersededAt" IS NULL THEN
    RAISE EXCEPTION 'CommitmentAttribution %: the only permitted UPDATE is stamping an ACTIVE row superseded', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."poLineId" IS DISTINCT FROM OLD."poLineId"
     OR NEW."labourPoLineId" IS DISTINCT FROM OLD."labourPoLineId"
     OR NEW."costHeadCode" IS DISTINCT FROM OLD."costHeadCode"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'CommitmentAttribution %: the attribution target, cost head, reason and creation provenance are frozen after write — reclassify by superseding this row and inserting a new one', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CommitmentAttribution_append_only" ON "CommitmentAttribution";
CREATE TRIGGER "CommitmentAttribution_append_only" BEFORE UPDATE OR DELETE ON "CommitmentAttribution"
  FOR EACH ROW EXECUTE FUNCTION phase5_attribution_append_only();

-- Diagnostic close: this migration creates structure only. Any pre-existing row in a NEW table
-- means the database was written outside the sanctioned path — ABORT, never adopt or invent.
DO $$
DECLARE heads integer; attributions integer;
BEGIN
  SELECT COUNT(*) INTO heads FROM "CostHead";
  SELECT COUNT(*) INTO attributions FROM "CommitmentAttribution";
  IF heads > 0 OR attributions > 0 THEN
    RAISE EXCEPTION 'phase5_t1: expected row-free new tables, found CostHead=% CommitmentAttribution=%', heads, attributions;
  END IF;
END $$;
