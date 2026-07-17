-- Phase 2 Task 9 — Projection Generations (rebuildable read-model + final activation barrier).
--
-- Additive, forward-only. Adds ProjectionGeneration: the rebuildable read-model instance a
-- projection consumer serves + advances. Each (consumer, projectId) has a monotone series of
-- generations; the live relay applies each ordered `db` projection delivery into the ACTIVE
-- generation (advancing `appliedPosition` CONTIGUOUSLY), while an online REBUILD builds a NEW
-- 'building' generation and a final ACTIVATION BARRIER hands over with zero gap. See
-- src/platform/projections/rebuilder.service.ts for the barrier protocol and the relay's
-- dispatchProjection for the live apply.
--
-- The CreateTable / CreateIndex DDL below is exactly what Prisma generates from schema.prisma (no
-- drift). The PARTIAL unique index `one active generation per (consumer, projectId)` is the
-- hand-added, not-Prisma-expressible part (the same accepted-drift convention Task 5's scope-
-- specific partial indexes used). This migration writes NO rows: a projection lazily creates its
-- first generation on first delivery, so a pre-existing project keeps working unchanged.

-- CreateTable
CREATE TABLE "ProjectionGeneration" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "appliedPosition" BIGINT,
    "cursorStatus" TEXT NOT NULL DEFAULT 'live',
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectionGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectionGeneration_consumer_projectId_generation_key" ON "ProjectionGeneration"("consumer", "projectId", "generation");

-- CreateIndex
CREATE INDEX "ProjectionGeneration_consumer_projectId_status_idx" ON "ProjectionGeneration"("consumer", "projectId", "status");

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PARTIAL unique index (raw SQL — Prisma cannot express WHERE): AT MOST ONE 'active' generation
-- per (consumer, projectId). This is the DB-enforced invariant behind the activation barrier —
-- the atomic swap (retire the old active generation, then activate the new one) can never leave two
-- serving generations, and a buggy double-activation is rejected by PostgreSQL, not by convention.
CREATE UNIQUE INDEX "ProjectionGeneration_one_active"
  ON "ProjectionGeneration"("consumer", "projectId")
  WHERE "status" = 'active';

-- Status + cursorStatus are small closed sets — a generation never holds a value outside the protocol.
ALTER TABLE "ProjectionGeneration" ADD CONSTRAINT "ProjectionGeneration_status_check" CHECK (
  "status" IN ('building', 'active', 'retired')
);
ALTER TABLE "ProjectionGeneration" ADD CONSTRAINT "ProjectionGeneration_cursor_status_check" CHECK (
  "cursorStatus" IN ('live', 'blocked')
);
