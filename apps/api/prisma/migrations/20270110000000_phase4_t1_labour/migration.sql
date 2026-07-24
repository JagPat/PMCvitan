-- Phase 4 Task 1 — Labour readiness foundation (plan §§B/D/H).
--
-- ADDITIVE + DIAGNOSTIC-FIRST. All new tables are project-contained (same-project composite
-- FKs make a cross-project reference unrepresentable in PostgreSQL). Every Prisma-inexpressible
-- seal — the labour-aware type<->detail correspondence, the append-only triggers, the demand
-- CHECKs, the one-active-crew-membership partial unique — is raw SQL here.
--
-- The `labour` capability itself needs no schema change: ProjectCapability.capability is a free
-- string, so `--capability labour` reuses the existing pilot-activation table + CLI. A non-pilot
-- project stays byte-for-byte unchanged (no labour rows, routes 404, no events).

-- ============================================================================
-- 0. DIAGNOSTIC-FIRST — never invent data; ABORT if any legacy row already contradicts the
--    invariants this migration installs. Labour demand was never written before this task
--    (the requirement command hardcoded type='material'), so a labour-typed revision without a
--    labour detail cannot exist on a valid legacy DB; if one somehow does, stop rather than
--    silently pass it through the new type<->detail trigger.
-- ============================================================================
DO $$
DECLARE
  n_orphan_labour bigint;
BEGIN
  SELECT count(*) INTO n_orphan_labour
    FROM "ActivityRequirement" ar
    WHERE ar."type" = 'labour';
  IF n_orphan_labour > 0 THEN
    RAISE EXCEPTION E'Phase 4 Task 1 ABORTED — % pre-existing labour-typed ActivityRequirement revision(s) exist before the labour detail table was introduced. This is impossible on a valid database (the requirement command only ever wrote type=material). Investigate before re-running; this migration never fabricates a labour spec.', n_orphan_labour;
  END IF;
END $$;

-- ============================================================================
-- 1. BASE DDL — the WorkerDevice->Worker binding column + the seven labour tables.
--    (Only labour-relevant statements; the unrelated FK-name churn `prisma migrate diff`
--    emits for earlier hand-written constraints is deliberately excluded — this migration is
--    purely additive and touches no existing constraint.)
-- ============================================================================

-- AlterTable — the trusted-identity binding (NULLABLE: anonymous QR/tap onboarding keeps working)
ALTER TABLE "WorkerDevice" ADD COLUMN "workerId" TEXT;

-- CreateTable
CREATE TABLE "LabourTrade" (
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "LabourTrade_pkey" PRIMARY KEY ("projectId","code")
);

-- CreateTable
CREATE TABLE "LabourSkill" (
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "LabourSkill_pkey" PRIMARY KEY ("projectId","code")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "skillCodes" TEXT[],
    "activeFrom" DATE NOT NULL,
    "activeTo" DATE,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Crew" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inchargeWorkerId" TEXT,
    "activeFrom" DATE NOT NULL,
    "activeTo" DATE,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "Crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMembership" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "crewId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    CONSTRAINT "CrewMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourRequirementSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "skillCode" TEXT,
    "shift" TEXT NOT NULL,
    "labourSpecFingerprint" TEXT NOT NULL,
    "decisionId" TEXT,
    "decisionVersion" INTEGER,
    "optionKey" TEXT,
    CONSTRAINT "LabourRequirementSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourDemandSlice" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "civilDate" DATE NOT NULL,
    "personShiftQty" INTEGER NOT NULL,
    CONSTRAINT "LabourDemandSlice_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. INDEXES + candidate keys (the composite (projectId, id) keys that the same-project FKs
--    reference — this is what makes a cross-project labour reference impossible).
-- ============================================================================
CREATE INDEX "Worker_projectId_tradeCode_idx" ON "Worker"("projectId", "tradeCode");
CREATE UNIQUE INDEX "Worker_projectId_id_key" ON "Worker"("projectId", "id");
CREATE UNIQUE INDEX "Crew_projectId_id_key" ON "Crew"("projectId", "id");
CREATE INDEX "CrewMembership_projectId_crewId_idx" ON "CrewMembership"("projectId", "crewId");
CREATE INDEX "CrewMembership_projectId_workerId_idx" ON "CrewMembership"("projectId", "workerId");
CREATE INDEX "LabourRequirementSpec_projectId_labourSpecFingerprint_idx" ON "LabourRequirementSpec"("projectId", "labourSpecFingerprint");
CREATE UNIQUE INDEX "LabourRequirementSpec_projectId_requirementId_revision_key" ON "LabourRequirementSpec"("projectId", "requirementId", "revision");
CREATE INDEX "LabourDemandSlice_projectId_requirementId_revision_idx" ON "LabourDemandSlice"("projectId", "requirementId", "revision");

-- one ACTIVE crew membership per (crew, worker) — a re-add after a removal is allowed
CREATE UNIQUE INDEX "CrewMembership_active_member_key"
  ON "CrewMembership" ("projectId", "crewId", "workerId") WHERE "removedAt" IS NULL;
-- explicit slices: one slice per (requirement revision, civilDate) — the shift is the spec's
CREATE UNIQUE INDEX "LabourDemandSlice_one_per_date_key"
  ON "LabourDemandSlice" ("projectId", "requirementId", "revision", "civilDate");

-- ============================================================================
-- 3. FOREIGN KEYS — same-project composite FKs (containment) + attribution FKs.
-- ============================================================================
ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_projectId_workerId_fkey"
  FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourTrade" ADD CONSTRAINT "LabourTrade_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabourTrade" ADD CONSTRAINT "LabourTrade_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourSkill" ADD CONSTRAINT "LabourSkill_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabourSkill" ADD CONSTRAINT "LabourSkill_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Worker" ADD CONSTRAINT "Worker_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_projectId_tradeCode_fkey"
  FOREIGN KEY ("projectId", "tradeCode") REFERENCES "LabourTrade"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Crew" ADD CONSTRAINT "Crew_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_projectId_inchargeWorkerId_fkey"
  FOREIGN KEY ("projectId", "inchargeWorkerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_projectId_crewId_fkey"
  FOREIGN KEY ("projectId", "crewId") REFERENCES "Crew"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_projectId_workerId_fkey"
  FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_addedById_fkey"
  FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_removedById_fkey"
  FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_projectId_requirementId_revision_fkey"
  FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_projectId_tradeCode_fkey"
  FOREIGN KEY ("projectId", "tradeCode") REFERENCES "LabourTrade"("projectId", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_provenance_fkey"
  FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey") REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourDemandSlice" ADD CONSTRAINT "LabourDemandSlice_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabourDemandSlice" ADD CONSTRAINT "LabourDemandSlice_projectId_requirementId_revision_fkey"
  FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 4. CHECK CONSTRAINTS — the shape rules Prisma cannot express.
-- ============================================================================
-- Worker/Crew: activeTo (when present) is not before activeFrom; a revoke stamps BOTH columns.
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_active_window_ck" CHECK ("activeTo" IS NULL OR "activeTo" >= "activeFrom");
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_revoke_all_or_none_ck"
  CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL) OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL));
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_active_window_ck" CHECK ("activeTo" IS NULL OR "activeTo" >= "activeFrom");
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_revoke_all_or_none_ck"
  CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL) OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL));
-- CrewMembership: a removal stamps BOTH columns.
ALTER TABLE "CrewMembership" ADD CONSTRAINT "CrewMembership_remove_all_or_none_ck"
  CHECK (("removedAt" IS NULL AND "removedById" IS NULL) OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL));
-- LabourRequirementSpec: a recognised shift; decision provenance is all-null OR all-present
-- (the exact all-or-none discipline MaterialRequirementSpec uses).
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_shift_ck" CHECK ("shift" IN ('day','night'));
ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_provenance_all_or_none_ck"
  CHECK (
    ("decisionId" IS NULL AND "decisionVersion" IS NULL AND "optionKey" IS NULL)
    OR ("decisionId" IS NOT NULL AND "decisionVersion" IS NOT NULL AND "optionKey" IS NOT NULL)
  );
-- LabourDemandSlice: a person-shift quantity is a positive integer.
ALTER TABLE "LabourDemandSlice" ADD CONSTRAINT "LabourDemandSlice_positive_qty_ck" CHECK ("personShiftQty" > 0);

-- ============================================================================
-- 5. APPEND-ONLY — the labour detail + its slices are database-immutable, exactly like
--    MaterialRequirementSpec. Reuse the shared function (defined by the Phase-3 requirements
--    integrity migration); revise/cancel APPEND a new revision, never UPDATE/DELETE a row.
-- ============================================================================
CREATE TRIGGER "LabourRequirementSpec_append_only"
  BEFORE UPDATE OR DELETE ON "LabourRequirementSpec"
  FOR EACH ROW EXECUTE FUNCTION phase3_requirements_append_only();
CREATE TRIGGER "LabourDemandSlice_append_only"
  BEFORE UPDATE OR DELETE ON "LabourDemandSlice"
  FOR EACH ROW EXECUTE FUNCTION phase3_requirements_append_only();

-- ============================================================================
-- 6. TYPE<->DETAIL CORRESPONDENCE (plan §B) — make the commit-time pairing trigger LABOUR-AWARE:
--    type='material' <=> exactly one MaterialRequirementSpec AND zero LabourRequirementSpec;
--    type='labour'   <=> exactly one LabourRequirementSpec  AND zero MaterialRequirementSpec;
--    any other type  <=> zero of both. Material semantics are preserved EXACTLY (a material
--    revision already committed with 0 labour specs, so the added `labour_count=0` arm never
--    changes an existing material outcome). Deferred to COMMIT so the revision and its detail
--    may land in either order within one transaction.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_requirement_spec_pairing() RETURNS trigger AS $$
DECLARE
  rev_type       TEXT;
  material_count INTEGER;
  labour_count   INTEGER;
BEGIN
  SELECT ar."type" INTO rev_type FROM "ActivityRequirement" ar
  WHERE ar."projectId" = NEW."projectId" AND ar."requirementId" = NEW."requirementId" AND ar."revision" = NEW."revision";
  IF rev_type IS NULL THEN
    RAISE EXCEPTION 'requirement detail (%, %, rev %) names no requirement revision', NEW."projectId", NEW."requirementId", NEW."revision";
  END IF;
  SELECT COUNT(*) INTO material_count FROM "MaterialRequirementSpec" m
  WHERE m."projectId" = NEW."projectId" AND m."requirementId" = NEW."requirementId" AND m."revision" = NEW."revision";
  SELECT COUNT(*) INTO labour_count FROM "LabourRequirementSpec" l
  WHERE l."projectId" = NEW."projectId" AND l."requirementId" = NEW."requirementId" AND l."revision" = NEW."revision";
  IF rev_type = 'material' AND (material_count <> 1 OR labour_count <> 0) THEN
    RAISE EXCEPTION 'a material requirement revision must commit with exactly one MaterialRequirementSpec and no LabourRequirementSpec (found % material, % labour for % rev %)', material_count, labour_count, NEW."requirementId", NEW."revision";
  END IF;
  IF rev_type = 'labour' AND (labour_count <> 1 OR material_count <> 0) THEN
    RAISE EXCEPTION 'a labour requirement revision must commit with exactly one LabourRequirementSpec and no MaterialRequirementSpec (found % labour, % material for % rev %)', labour_count, material_count, NEW."requirementId", NEW."revision";
  END IF;
  IF rev_type <> 'material' AND rev_type <> 'labour' AND (material_count <> 0 OR labour_count <> 0) THEN
    RAISE EXCEPTION 'a % requirement revision must commit with no material/labour spec (found % material, % labour for % rev %)', rev_type, material_count, labour_count, NEW."requirementId", NEW."revision";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- the labour detail participates in the same deferred commit-time pairing check as the material
-- detail (the ActivityRequirement + MaterialRequirementSpec triggers already call this function).
CREATE CONSTRAINT TRIGGER "LabourRequirementSpec_spec_pairing"
  AFTER INSERT ON "LabourRequirementSpec"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase3_requirement_spec_pairing();

-- ============================================================================
-- 7. LABOUR SLICE TYPE GUARD — a demand slice may only attach to a labour-typed revision, so
--    slices can never accrete on a material/other requirement even on a direct write.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase4_labour_slice_typed() RETURNS trigger AS $$
DECLARE
  rev_type TEXT;
BEGIN
  SELECT ar."type" INTO rev_type FROM "ActivityRequirement" ar
  WHERE ar."projectId" = NEW."projectId" AND ar."requirementId" = NEW."requirementId" AND ar."revision" = NEW."revision";
  IF rev_type IS DISTINCT FROM 'labour' THEN
    RAISE EXCEPTION 'a LabourDemandSlice may only attach to a labour requirement revision (found type % for % rev %)', COALESCE(rev_type, '<none>'), NEW."requirementId", NEW."revision";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourDemandSlice_typed"
  BEFORE INSERT ON "LabourDemandSlice"
  FOR EACH ROW EXECUTE FUNCTION phase4_labour_slice_typed();

-- ============================================================================
-- 8. IMMUTABLE ROOT TYPE (plan §B) — a requirement's `type` is fixed at its first revision. A
--    BEFORE INSERT trigger rejects any later revision whose type differs from the requirement's
--    earliest revision, so a material requirement can never be revised (or cancelled) into a
--    labour one, or vice versa. Existing material requirements are uniformly type='material',
--    so this never changes a Phase-3 outcome (revision 1 has no prior row and always passes).
-- ============================================================================
CREATE OR REPLACE FUNCTION phase4_requirement_type_immutable() RETURNS trigger AS $$
DECLARE
  existing_type TEXT;
BEGIN
  -- `type` is the RequirementType ENUM; compare via text so the operator resolves.
  SELECT ar."type"::text INTO existing_type FROM "ActivityRequirement" ar
  WHERE ar."projectId" = NEW."projectId" AND ar."requirementId" = NEW."requirementId"
  ORDER BY ar."revision" ASC LIMIT 1;
  IF existing_type IS NOT NULL AND existing_type IS DISTINCT FROM NEW."type"::text THEN
    RAISE EXCEPTION 'requirement % is type % — a revision cannot change it to %', NEW."requirementId", existing_type, NEW."type";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ActivityRequirement_type_immutable"
  BEFORE INSERT ON "ActivityRequirement"
  FOR EACH ROW EXECUTE FUNCTION phase4_requirement_type_immutable();
