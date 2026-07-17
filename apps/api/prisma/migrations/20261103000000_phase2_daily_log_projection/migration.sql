-- Phase 2 Task 10 — the DAILY-LOG read-model projection (the daily-log module's rebuildable read path).
--
-- Additive, forward-only. Adds DailyLogProjection: ONE row per (generation, project) — the daily-log
-- slice is a per-PROJECT composite (latest log core + every project material), not one row per entity —
-- refreshed from canonical state on every dailylog.*/material.* event by the `daily-log.inbox`
-- projection consumer and served (active generation only) by the module's projection query. The slice
-- carries no per-viewer visibility, so the read applies no query-time filter. The CreateTable /
-- CreateIndex DDL below is exactly what Prisma generates from schema.prisma (no drift). Writes NO rows:
-- the projection lazily builds its first generation on first delivery / on rebuild, so a pre-existing
-- project keeps working unchanged and the live snapshot slice stays authoritative until the frontend is
-- switched (the capability-versioned XOR cutover).

-- CreateTable
CREATE TABLE "DailyLogProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyLogProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyLogProjection_generationId_projectId_key" ON "DailyLogProjection"("generationId", "projectId");
