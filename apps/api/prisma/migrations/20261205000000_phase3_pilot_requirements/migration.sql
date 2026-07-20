-- Phase 3 Task 1 — pilot activation + the ActivityRequirement demand contract (ADDITIVE ONLY).
-- Two new tables + one enum. No existing table, column, constraint or row is touched, so a
-- non-pilot deployment is bit-identical before/after this migration (the §D inertness proof
-- pins it). CHECK constraints are the database backstop for the plan's §B/§F invariants.

-- CreateEnum
CREATE TYPE "RequirementType" AS ENUM ('material', 'labour', 'equipment', 'decision', 'drawing', 'inspection');

-- CreateTable: project-scoped capability activation (plan §D). A Phase-3 surface exists for a
-- project ONLY when its capability row exists.
CREATE TABLE "ProjectCapability" (
    "projectId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledById" TEXT NOT NULL,

    CONSTRAINT "ProjectCapability_pkey" PRIMARY KEY ("projectId","capability")
);

-- CreateTable: the §11 demand contract, APPEND-ONLY revisions (plan §§B/F). The
-- MaterialSpecificationRef is flattened: technical identity (fingerprinted) + decision
-- provenance (never fingerprinted).
CREATE TABLE "ActivityRequirement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "activityId" TEXT NOT NULL,
    "type" "RequirementType" NOT NULL DEFAULT 'material',
    "materialCategory" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "normalizedAttributes" TEXT NOT NULL,
    "baseUom" TEXT NOT NULL,
    "specFingerprint" TEXT NOT NULL,
    "decisionId" TEXT,
    "decisionVersion" INTEGER,
    "optionKey" TEXT,
    "requiredQty" DECIMAL(18,6) NOT NULL,
    "requiredBy" TIMESTAMP(3) NOT NULL,
    "responsibleId" TEXT,
    "criticality" TEXT NOT NULL DEFAULT 'normal',
    "tolerance" DECIMAL(18,6),
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ActivityRequirement_pkey" PRIMARY KEY ("id"),
    -- §F: revisions are 1-based and append-only; §B: quantities are positive decimals
    CONSTRAINT "ActivityRequirement_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "ActivityRequirement_requiredQty_check" CHECK ("requiredQty" > 0),
    CONSTRAINT "ActivityRequirement_tolerance_check" CHECK ("tolerance" IS NULL OR "tolerance" >= 0),
    CONSTRAINT "ActivityRequirement_status_check" CHECK ("status" IN ('open', 'cancelled')),
    CONSTRAINT "ActivityRequirement_criticality_check" CHECK ("criticality" IN ('normal', 'critical'))
);

-- CreateIndex
CREATE INDEX "ActivityRequirement_projectId_activityId_idx" ON "ActivityRequirement"("projectId", "activityId");
CREATE INDEX "ActivityRequirement_projectId_specFingerprint_idx" ON "ActivityRequirement"("projectId", "specFingerprint");
CREATE UNIQUE INDEX "ActivityRequirement_requirementId_revision_key" ON "ActivityRequirement"("requirementId", "revision");
CREATE UNIQUE INDEX "ActivityRequirement_projectId_id_key" ON "ActivityRequirement"("projectId", "id");

-- AddForeignKey — same-project containment (Phase 0 Task 5 discipline)
ALTER TABLE "ProjectCapability" ADD CONSTRAINT "ProjectCapability_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_projectId_decisionId_fkey" FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
