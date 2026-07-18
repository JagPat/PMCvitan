-- Phase 2 Task 10 (Module 3) — the INSPECTIONS read-model projection (the inspections module's
-- rebuildable read path).
--
-- Additive, forward-only. Adds InspectionsProjection: ONE row per (generation, project) — the inspection
-- slices are a per-PROJECT composite (every inspection with its items + evidence linkage + closing/
-- activity labelling), not one row per entity — refreshed from canonical state on every inspection.*
-- event by the `inspections.inbox` projection consumer and served (active generation only) by the
-- module's projection query. The stored `dto` is the VIEWER-INDEPENDENT base: the PMC/engineer role
-- gating and each item's short-lived signed evidence paths are baked at READ time, so the row is neither
-- per-viewer nor time-limited. The CreateTable / CreateIndex DDL below is exactly what Prisma generates
-- from schema.prisma (no drift). Writes NO rows: the projection lazily builds its first generation on
-- first delivery / on rebuild, so a pre-existing project keeps working unchanged and the live snapshot
-- slice stays authoritative until the frontend is switched (the capability-versioned XOR cutover).

-- CreateTable
CREATE TABLE "InspectionsProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionsProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionsProjection_generationId_projectId_key" ON "InspectionsProjection"("generationId", "projectId");
