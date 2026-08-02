-- Phase 5 Task 2 — the §B over-budget EXCEPTION, with a lifecycle.
-- ADDITIVE and diagnostic-first: one new table, its same-project composite FKs, CHECKs, the
-- one-open-per-head partial unique and its lifecycle trigger. No existing table, column or
-- migration byte changes. A legacy database upgrades with the new table ROW-FREE.
--
-- RETRY-SAFE: every statement is guarded, so a crash between a statement and Prisma recording
-- the migration leaves a rerunnable migration.

CREATE TABLE IF NOT EXISTS "BudgetException" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "costHeadCode" TEXT NOT NULL,
    "headroom" DECIMAL(18,2) NOT NULL,
    "budget" DECIMAL(18,2) NOT NULL,
    "exposure" DECIMAL(18,2) NOT NULL,
    "raisedBy" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raisedById" TEXT NOT NULL,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "BudgetException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BudgetException_projectId_id_key" ON "BudgetException"("projectId", "id");
CREATE INDEX IF NOT EXISTS "BudgetException_projectId_costHeadCode_idx" ON "BudgetException"("projectId", "costHeadCode");

-- §B — exactly ONE OPEN exception per cost head. Three different writes can move headroom, and
-- without this a second one on an already-excepted head stacks a duplicate Inbox action for a
-- breach the practice has already been told about.
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetException_open_costHead_key"
  ON "BudgetException"("projectId", "costHeadCode")
  WHERE "clearedAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_projectId_fkey') THEN
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_projectId_costHeadCode_fkey') THEN
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_projectId_costHeadCode_fkey" FOREIGN KEY ("projectId", "costHeadCode") REFERENCES "CostHead"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_raisedById_fkey') THEN
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- an exception exists BECAUSE headroom went negative; a non-negative one is not an exception
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_headroom_check') THEN
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_headroom_check" CHECK ("headroom" < 0);
  END IF;
  -- the recorded inputs must be the ones that produced the recorded headroom
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_arithmetic_check') THEN
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_arithmetic_check" CHECK ("headroom" = "budget" - "exposure");
  END IF;
  -- §B names exactly three writes that can move headroom; a fourth source is a bug, not data
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BudgetException_raisedBy_check') THEN
    -- §B's five headroom-moving writes. `acceptance` is here because §G authorises accepting more
    -- than the ordered quantity and §J values that overage at the frozen rate with no commitment
    -- released against it; `receipt_progress` because a CLOSED-SHORT line's released remainder is
    -- computed from `receivedQty`, so recording, rejecting or reversing a receipt moves exposure
    -- with nothing accepted at all. A closed set at PostgreSQL means an unlabelled mover cannot be
    -- recorded as one — and `raisedBy` is the durable explanation a human reads months later, so a
    -- wrong-but-permitted label would be worse than a refused write.
    ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check" CHECK ("raisedBy" IN ('commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress'));
  END IF;
END $$;

-- The exception is a RECORD of a breach, so its inputs are history: the ONE permitted UPDATE is
-- clearing an open row when a later write returns headroom to non-negative. Everything else is
-- refused, and DELETE always — a breach that can be deleted is a breach nobody has to answer for.
CREATE OR REPLACE FUNCTION phase5_budget_exception_lifecycle() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BudgetException %: append-only — DELETE is refused', OLD."id";
  END IF;
  IF OLD."clearedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'BudgetException %: already cleared — no further UPDATE is permitted', OLD."id";
  END IF;
  IF NEW."clearedAt" IS NULL THEN
    RAISE EXCEPTION 'BudgetException %: the only permitted UPDATE is clearing an OPEN exception', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."costHeadCode" IS DISTINCT FROM OLD."costHeadCode"
     OR NEW."headroom" IS DISTINCT FROM OLD."headroom"
     OR NEW."budget" IS DISTINCT FROM OLD."budget"
     OR NEW."exposure" IS DISTINCT FROM OLD."exposure"
     OR NEW."raisedBy" IS DISTINCT FROM OLD."raisedBy"
     OR NEW."raisedAt" IS DISTINCT FROM OLD."raisedAt"
     OR NEW."raisedById" IS DISTINCT FROM OLD."raisedById" THEN
    RAISE EXCEPTION 'BudgetException %: the recorded breach and its provenance are frozen after write', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BudgetException_lifecycle" ON "BudgetException";
CREATE TRIGGER "BudgetException_lifecycle" BEFORE UPDATE OR DELETE ON "BudgetException"
  FOR EACH ROW EXECUTE FUNCTION phase5_budget_exception_lifecycle();

-- Diagnostic close: structure only. Any pre-existing row means the database was written outside
-- the sanctioned path — ABORT, never adopt or invent.
DO $$
DECLARE rows integer;
BEGIN
  SELECT COUNT(*) INTO rows FROM "BudgetException";
  IF rows > 0 THEN
    RAISE EXCEPTION 'phase5_t2_exception: expected a row-free BudgetException, found %', rows;
  END IF;
END $$;
