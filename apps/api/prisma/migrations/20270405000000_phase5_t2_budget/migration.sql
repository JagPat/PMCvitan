-- Phase 5 Task 2 — the §B BUDGET: versioned, immutable, one live version per cost head.
-- ADDITIVE and diagnostic-first: one new table, its same-project composite FKs, CHECKs, the
-- live-version partial unique and its immutability trigger. No existing table, column or
-- migration byte changes. A legacy database upgrades with the new table ROW-FREE (the closing
-- block ABORTS if it finds any row — it never invents data).
--
-- RETRY-SAFE: every statement is guarded so a crash between a statement and Prisma recording
-- the migration leaves a rerunnable migration — the retry is a no-op, never "already exists".

CREATE TABLE IF NOT EXISTS "BudgetLine" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costHeadCode" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BudgetLine_projectId_id_key" ON "BudgetLine"("projectId", "id");
-- versions are monotonic within a head and never reused, so history cannot be rewritten by
-- inserting a "new" v2 alongside the old one
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetLine_projectId_costHeadCode_version_key" ON "BudgetLine"("projectId", "costHeadCode", "version");
CREATE INDEX IF NOT EXISTS "BudgetLine_projectId_costHeadCode_idx" ON "BudgetLine"("projectId", "costHeadCode");

-- §B/§0 — EXACTLY ONE LIVE version per (project, cost head). `BUDGET(costHead)` is "the amount of
-- the LIVE budget version only", which presupposes there is exactly one: summing two overstates
-- the plan, picking one hides an approved plan.
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetLine_live_costHead_key"
  ON "BudgetLine"("projectId", "costHeadCode")
  WHERE "supersededAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_projectId_fkey') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_projectId_costHeadCode_fkey') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_projectId_costHeadCode_fkey" FOREIGN KEY ("projectId", "costHeadCode") REFERENCES "CostHead"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_createdById_fkey') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_supersededById_fkey') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- §B — a NEGATIVE live amount would feed nonsensical capacity into the budget-vs-committed
  -- exception before any PO exists.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_amount_check') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_amount_check" CHECK ("amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_version_check') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_version_check" CHECK ("version" >= 1);
  END IF;
  -- §0b non-blank discipline, the complete ASCII whitespace set (incl. VT/FF).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_text_nonblank') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_text_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '' AND ("supersedeReason" IS NULL OR btrim("supersedeReason", E' \t\n\x0B\f\r') <> ''));
  END IF;
  -- The supersession stamp is all-or-nothing and always attributable — a half-stamped row would
  -- leave the head with NO live version and nobody accountable for removing it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetLine_supersede_complete') THEN
    ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_supersede_complete" CHECK (
      ("supersededAt" IS NULL AND "supersededById" IS NULL AND "supersedeReason" IS NULL)
      OR ("supersededAt" IS NOT NULL AND "supersededById" IS NOT NULL AND "supersedeReason" IS NOT NULL)
    );
  END IF;
END $$;

-- §B — budget lines are VERSIONED AND IMMUTABLE: a revision appends a new version retaining the
-- prior verbatim. There is no in-place edit, so the seal is the same shape as the attribution's:
-- DELETE refused ALWAYS, UPDATE refused ALWAYS except the ONE controlled transition — stamping a
-- LIVE row superseded. An in-place amount edit would move a recorded plan with no revision, no
-- reason and no evidence that anything moved.
CREATE OR REPLACE FUNCTION phase5_budget_line_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BudgetLine %: append-only — DELETE is refused', OLD."id";
  END IF;
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'BudgetLine %: already superseded — no further UPDATE is permitted', OLD."id";
  END IF;
  IF NEW."supersededAt" IS NULL THEN
    RAISE EXCEPTION 'BudgetLine %: the only permitted UPDATE is stamping the LIVE version superseded', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."costHeadCode" IS DISTINCT FROM OLD."costHeadCode"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'BudgetLine %: the amount, cost head, version, reason and creation provenance are frozen after write — revise by appending a new version', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BudgetLine_append_only" ON "BudgetLine";
CREATE TRIGGER "BudgetLine_append_only" BEFORE UPDATE OR DELETE ON "BudgetLine"
  FOR EACH ROW EXECUTE FUNCTION phase5_budget_line_append_only();

-- Diagnostic close: this migration creates structure only. Any pre-existing row in the NEW table
-- means the database was written outside the sanctioned path — ABORT, never adopt or invent.
DO $$
DECLARE lines integer;
BEGIN
  SELECT COUNT(*) INTO lines FROM "BudgetLine";
  IF lines > 0 THEN
    RAISE EXCEPTION 'phase5_t2: expected a row-free BudgetLine, found %', lines;
  END IF;
END $$;
