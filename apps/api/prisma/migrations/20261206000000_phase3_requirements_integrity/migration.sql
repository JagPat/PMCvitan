-- Phase 3 Task 1 CORRECTION (review findings 1-3) — requirement canonical integrity.
-- DATA-PRESERVING restructure of the Task-1 tables (no production deployment carries rows yet;
-- if rows exist they are migrated, never dropped — a row that cannot be migrated fails LOUDLY
-- rather than being silently discarded). Diagnostic-first: every structural guarantee the
-- review demanded becomes a database object here (root lineage FK, append-only triggers,
-- composite revision identity, all-or-none provenance CHECK, DATE requiredBy, identity FKs).

-- 1. The stable project-contained requirement ROOT (finding 2: lineage cannot cross projects).
CREATE TABLE "ActivityRequirementRoot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "ActivityRequirementRoot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ActivityRequirementRoot_projectId_id_key" ON "ActivityRequirementRoot"("projectId", "id");

-- backfill roots from any existing revision rows (earliest revision defines the root)
INSERT INTO "ActivityRequirementRoot" ("id", "projectId", "createdAt", "createdById")
SELECT DISTINCT ON ("requirementId") "requirementId", "projectId", "createdAt", "createdById"
FROM "ActivityRequirement"
ORDER BY "requirementId", "revision" ASC;

-- 2. The revision-owned MATERIAL specification detail (finding 3: the common contract stays
--    type-neutral; material-only fields move here).
CREATE TABLE "MaterialRequirementSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "materialCategory" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "normalizedAttributes" TEXT NOT NULL,
    "baseUom" TEXT NOT NULL,
    "specFingerprint" TEXT NOT NULL,
    "decisionId" TEXT,
    "decisionVersion" INTEGER,
    "optionKey" TEXT,
    CONSTRAINT "MaterialRequirementSpec_pkey" PRIMARY KEY ("id"),
    -- finding 1: provenance is ALL-OR-NONE — manual spec (all null) or a complete
    -- server-resolved approval reference (all non-null)
    CONSTRAINT "MaterialRequirementSpec_provenance_check" CHECK (
      ("decisionId" IS NULL AND "decisionVersion" IS NULL AND "optionKey" IS NULL) OR
      ("decisionId" IS NOT NULL AND "decisionVersion" IS NOT NULL AND "optionKey" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX "MaterialRequirementSpec_projectId_requirementId_revision_key" ON "MaterialRequirementSpec"("projectId", "requirementId", "revision");
CREATE INDEX "MaterialRequirementSpec_projectId_specFingerprint_idx" ON "MaterialRequirementSpec"("projectId", "specFingerprint");

-- backfill specs from the existing material columns. Pre-correction rows carried
-- CALLER-AUTHORED provenance (the finding-1 defect), which the all-or-none CHECK may refuse —
-- normalize any incomplete triple to the manual form (all null) rather than inventing an
-- approval record; complete triples are preserved as-is for the operator to re-verify.
INSERT INTO "MaterialRequirementSpec" ("id", "projectId", "requirementId", "revision", "materialCategory", "make", "grade", "normalizedAttributes", "baseUom", "specFingerprint", "decisionId", "decisionVersion", "optionKey")
SELECT 'mrs-' || "id", "projectId", "requirementId", "revision", "materialCategory", "make", "grade", "normalizedAttributes", "baseUom", "specFingerprint",
  CASE WHEN "decisionId" IS NOT NULL AND "decisionVersion" IS NOT NULL AND "optionKey" IS NOT NULL THEN "decisionId" END,
  CASE WHEN "decisionId" IS NOT NULL AND "decisionVersion" IS NOT NULL AND "optionKey" IS NOT NULL THEN "decisionVersion" END,
  CASE WHEN "decisionId" IS NOT NULL AND "decisionVersion" IS NOT NULL AND "optionKey" IS NOT NULL THEN "optionKey" END
FROM "ActivityRequirement";

-- 3. Type-neutral revision table: requiredBy becomes civil DATE; material columns depart.
ALTER TABLE "ActivityRequirement" DROP CONSTRAINT "ActivityRequirement_projectId_decisionId_fkey";
ALTER TABLE "ActivityRequirement"
  ALTER COLUMN "requiredBy" TYPE DATE USING ("requiredBy"::date),
  DROP COLUMN "materialCategory",
  DROP COLUMN "make",
  DROP COLUMN "grade",
  DROP COLUMN "normalizedAttributes",
  DROP COLUMN "specFingerprint",
  DROP COLUMN "decisionId",
  DROP COLUMN "decisionVersion",
  DROP COLUMN "optionKey";

-- 4. The downstream-FK identity (finding 2/3 of the instruction): later phases pin this triple.
CREATE UNIQUE INDEX "ActivityRequirement_projectId_requirementId_revision_key" ON "ActivityRequirement"("projectId", "requirementId", "revision");

-- 5. Containment + identity FKs. responsibleId must be a same-project membership; a value that
--    matches no membership is normalized to NULL FIRST (diagnostic: pre-correction rows never
--    validated it — finding 3), so the FK addition cannot mask a bad row silently.
UPDATE "ActivityRequirement" ar SET "responsibleId" = NULL
WHERE ar."responsibleId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."projectId" = ar."projectId" AND m."userId" = ar."responsibleId");
ALTER TABLE "ActivityRequirementRoot" ADD CONSTRAINT "ActivityRequirementRoot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityRequirementRoot" ADD CONSTRAINT "ActivityRequirementRoot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_projectId_requirementId_fkey" FOREIGN KEY ("projectId", "requirementId") REFERENCES "ActivityRequirementRoot"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_projectId_responsibleId_fkey" FOREIGN KEY ("projectId", "responsibleId") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityRequirement" ADD CONSTRAINT "ActivityRequirement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_projectId_requirementId_revision_fkey" FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_projectId_decisionId_fkey" FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 6. APPEND-ONLY, database-enforced (finding 2): revisions and their specs can never be
--    updated or deleted — corrections APPEND the next revision. (TRUNCATE, used by test
--    harness resets, fires no row triggers and stays available to operators.)
CREATE OR REPLACE FUNCTION phase3_requirements_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ActivityRequirement revisions are append-only: % on % is forbidden', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ActivityRequirement_append_only" BEFORE UPDATE OR DELETE ON "ActivityRequirement" FOR EACH ROW EXECUTE FUNCTION phase3_requirements_append_only();
CREATE TRIGGER "MaterialRequirementSpec_append_only" BEFORE UPDATE OR DELETE ON "MaterialRequirementSpec" FOR EACH ROW EXECUTE FUNCTION phase3_requirements_append_only();
