-- Phase 2 Task 10 (Module 4) — the activities module's rebuildable read model (`activities.schedule`).
-- One row per (generation, project) storing the serialized ACTIVITY-OWNED base (activities + overrides +
-- phases as stored facts; derived readiness is baked at read time, never stored). Additive: creates the
-- table only, writes no rows — generations are built by the projection consumer/rebuilder at runtime.
CREATE TABLE "ActivitiesProjection" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dto" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivitiesProjection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActivitiesProjection_generationId_projectId_key" ON "ActivitiesProjection"("generationId", "projectId");
