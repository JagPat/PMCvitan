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
