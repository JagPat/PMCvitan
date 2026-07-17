-- Phase 2 Task 9 — the DECISIONS read-model projection (the first module's rebuildable read path).
--
-- Additive, forward-only. Adds DecisionProjection: one row per (generation, decision), refreshed from
-- the canonical Decision on every decision.* event by the `decisions.inbox` projection consumer and
-- served (active generation only) by the module's projection query with query-time authz. The
-- CreateTable / CreateIndex DDL below is exactly what Prisma generates from schema.prisma (no drift).
-- Writes NO rows: the projection lazily builds its first generation on first delivery / on rebuild, so
-- a pre-existing project keeps working unchanged and the live snapshot slice stays authoritative until
-- the frontend is switched (the capability-versioned XOR cutover).

-- CreateTable
CREATE TABLE "DecisionProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "authorId" TEXT,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DecisionProjection_generationId_decisionId_key" ON "DecisionProjection"("generationId", "decisionId");

-- CreateIndex
CREATE INDEX "DecisionProjection_generationId_projectId_idx" ON "DecisionProjection"("generationId", "projectId");
