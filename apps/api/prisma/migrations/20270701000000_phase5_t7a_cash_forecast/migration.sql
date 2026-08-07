-- Phase 5 Task 7A — the EIGHTH rebuildable projection: the per-project CASH FORECAST (§J).
--
-- Additive only: one generation-scoped store, identical in shape to the seven projection tables
-- before it. Recompute-only; storing a derived money picture produces no domain event (§G). There
-- is no backfill and no data movement — a legacy database upgrades with this table ROW-FREE and
-- the consumer, the write-through refresh and the operator rebuild populate it from canonical
-- facts. Nothing reads it for authority, so an empty table on the first deploy is correct rather
-- than a gap: §B's over-budget exception is raised from the LIVE fold in the writer's transaction.
--
-- RETRY-SAFE: every statement is guarded, so a crash between a statement and Prisma recording the
-- migration leaves a rerunnable migration — the retry is a no-op, never "relation already exists".
CREATE TABLE IF NOT EXISTS "CashForecastProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashForecastProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CashForecastProjection_generationId_projectId_key" ON "CashForecastProjection"("generationId", "projectId");

-- The migration is additive and the table is new, so there is nothing to diagnose over pre-existing
-- rows. The closing ABORT is kept for the same reason every Phase-4/5 additive migration keeps one:
-- it proves the claim "legacy databases upgrade row-free" at deploy time rather than in prose.
DO $$
DECLARE v_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "CashForecastProjection";
  IF v_rows > 0 THEN
    RAISE EXCEPTION
      'phase5_t7a: "CashForecastProjection" must upgrade row-free but holds % row(s). This migration creates the table; rows can only exist if it was created out of band. Investigate before continuing.',
      v_rows;
  END IF;
END $$;

-- ── §B/§J — the `fold_correction` headroom mover ──────────────────────────────────────────────
--
-- Task 7A completes §J's partition, and completing it RAISES exposure on any head that carries an
-- approval: exposure gains `approved` (= `APPROVED − PAID`) and `paid` (= `PAID`), which together
-- add back exactly the `APPROVED` that `certified-payable` subtracts. That is the correct reading —
-- money a practice has authorised is money it still owes — but it changes the answer for data that
-- already exists.
--
-- Concretely: a head with budget 50, a 100 certificate and a 60 approval was BREACHED, then had its
-- exception CLEARED by 6A's code when the approval lowered exposure. Under 7A it reads
-- `headroom = -50` again with no open exception, so the Inbox misses a live breach until some
-- unrelated write happens to touch that head.
--
-- The register is an append-only observation and no migration can recompute the fold in SQL (it
-- spans procurement, inventory, labour and four commercial folds), so the repair is an operator
-- sweep: `pnpm --filter api commercial:reevaluate`. It needs a label that says what actually moved,
-- because `raisedBy` is the durable explanation a human reads months later — and none of the ten
-- existing labels describes "the definition of exposure changed". Reusing one would be exactly the
-- label drift §B's round 4 removed.
ALTER TABLE "BudgetException" DROP CONSTRAINT IF EXISTS "BudgetException_raisedBy_check";
ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check"
  CHECK ("raisedBy" IN ('commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress', 'measurement', 'claim', 'deduction', 'deduction_release', 'payment_approval', 'fold_correction'));
