-- Phase 3 Task 6 — the SIXTH rebuildable projection: per-project UI material readiness (§A/§G).
-- Additive only: one generation-scoped store, identical in shape to the other five projection
-- tables. Recompute-only; storing a derived verdict produces no domain event.
CREATE TABLE "MaterialReadinessProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialReadinessProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialReadinessProjection_generationId_projectId_key" ON "MaterialReadinessProjection"("generationId", "projectId");
