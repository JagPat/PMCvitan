-- Phase 4 Task 4 — the SEVENTH rebuildable projection: per-project labour-readiness FORECAST
-- (§A/§G). Additive only: one generation-scoped store, identical in shape to the other six
-- projection tables. Recompute-only; storing a derived verdict produces no domain event. The
-- projection's requirements come from the labour-owned `requirement.*` event read-model (folded
-- from event payloads), so no backfill and no data movement: a legacy database upgrades with
-- this table row-free and the consumer/rebuild populates it from canonical facts.
--
-- RETRY-SAFE: every statement is guarded so a crash between a statement and Prisma recording the
-- migration leaves a rerunnable migration — the retry is a no-op, never "relation already exists".
CREATE TABLE IF NOT EXISTS "LabourReadinessProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabourReadinessProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LabourReadinessProjection_generationId_projectId_key" ON "LabourReadinessProjection"("generationId", "projectId");
