-- Phase 2 Task 10 — the DRAWINGS read-model projection (the drawings module's rebuildable read path).
--
-- Additive, forward-only. Adds DrawingsProjection: ONE row per (generation, project) — the drawings
-- register is a per-PROJECT composite (every drawing with its revision history + governing-revision
-- distribution facts), not one row per entity — refreshed from canonical state on every drawing.* event
-- by the `drawings.inbox` projection consumer and served (active generation only) by the module's
-- projection query. The stored `dto` is the VIEWER-INDEPENDENT base: draft-author visibility, the
-- viewer's ack/recipient state, and each revision's short-lived signed url are baked at READ time, so
-- the row is neither per-viewer nor time-limited. The CreateTable / CreateIndex DDL below is exactly
-- what Prisma generates from schema.prisma (no drift). Writes NO rows: the projection lazily builds its
-- first generation on first delivery / on rebuild, so a pre-existing project keeps working unchanged and
-- the live snapshot slice stays authoritative until the frontend is switched (the capability-versioned
-- XOR cutover).

-- CreateTable
CREATE TABLE "DrawingsProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrawingsProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DrawingsProjection_generationId_projectId_key" ON "DrawingsProjection"("generationId", "projectId");
