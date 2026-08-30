-- Phase 6 unit 4c-i — CONSULTATION, deployed DARK
-- (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md §A, §D).
--
-- This is the migration unit of 4c, and it is deliberately the WHOLE of it: two append-only
-- tables, their keys, their CHECKs, their seals, and the two owned SQL primitives those seals
-- call. Nothing reads or writes these tables — no contract, no command, no route, no reader.
-- The previous release therefore runs unchanged over the migrated schema, which is what makes
-- the migration/service seam real rather than claimed.
--
-- Why every invariant is SEALED here rather than with its caller: a DB invariant whose first
-- probe waits for the behaviour unit can be wrong and become immutable history before anything
-- detects it. No invariant this file installs is probed later than the PR that installs it.
--
-- RETRY-SAFETY is a property of every statement (§D round 2): a deploy that fails after creating
-- an early object must COMPLETE on retry, not stop at the object it already made. Every CREATE,
-- ADD CONSTRAINT and trigger carries `IF NOT EXISTS`, `IF EXISTS`, or a duplicate-object guard.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SHAPE SLICE — the tables, keys and references. The behaviour (CHECKs, primitives, seals) is
-- deliberately absent here so this unit's probes fail on BEHAVIOUR, never on a missing symbol.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- The SAME-DECISION candidate key the response's recommended option binds to. Additive and
-- VACUOUSLY SATISFIABLE: `id` is already unique on its own, so this index can reject no existing
-- and no future row, and no writer changes. Deliberately project-less — `DecisionOption` carries
-- no `projectId`, and adding one would demand a backfill, old-writer compatibility and re-cover
-- of the delivered option evidence seals, none of which a dark migration may do. It is also
-- unneeded: the response's project↔decision pairing is pinned by its consultation FK, whose
-- parent binds `Decision(projectId, id)`, so same-decision binding completes the chain.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionOption_decision_option_key"
  ON "DecisionOption"("decisionId", "id");

-- The approval COMMAND a revision is a product of — NULLABLE, and enforced by nothing in this
-- unit. 4c-i is the dark migration the still-serving previous release must keep running against,
-- and today's `approve` writes no source command: requiring it here would reject every approval a
-- 4b instance performs. The writer lands in 4c-ii and the constraint trigger lands in 4c-ii's own
-- migration, after the drain-first cutover, at the one moment zero old instances are running.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "sourceCommandId" TEXT;
DO $$ BEGIN
  ALTER TABLE "DecisionApprovalRevision"
    ADD CONSTRAINT "DecisionApprovalRevision_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "DecisionConsultation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "consulteeMembershipId" TEXT NOT NULL,
    "consulteeUserId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "openCycle" INTEGER NOT NULL,
    "sourceCommandId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionConsultation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionConsultationResponse" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "respondedById" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "recommendedOptionId" TEXT,
    "sourceCommandId" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionConsultationResponse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DecisionConsultation_projectId_decisionId_idx"
  ON "DecisionConsultation"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionConsultation_consulteeUserId_idx"
  ON "DecisionConsultation"("consulteeUserId");
CREATE INDEX IF NOT EXISTS "DecisionConsultation_projectId_consulteeMembershipId_idx"
  ON "DecisionConsultation"("projectId", "consulteeMembershipId");
-- ONE-USE provenance: a receipt can back at most one row per table.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultation_source_command_key"
  ON "DecisionConsultation"("projectId", "sourceCommandId");
-- the candidate key the response's triple FK references
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultation_response_target_key"
  ON "DecisionConsultation"("projectId", "id", "decisionId");

-- ONE response per consultation — a second is UNREPRESENTABLE, not merely refused by a command.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_consultationId_key"
  ON "DecisionConsultationResponse"("consultationId");
CREATE INDEX IF NOT EXISTS "DecisionConsultationResponse_projectId_decisionId_idx"
  ON "DecisionConsultationResponse"("projectId", "decisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_source_command_key"
  ON "DecisionConsultationResponse"("projectId", "sourceCommandId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_consultation_key"
  ON "DecisionConsultationResponse"("projectId", "consultationId", "decisionId");

DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_decisionId_fkey"
    FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_consulteeMembershipId_fkey"
    FOREIGN KEY ("projectId", "consulteeMembershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_consulteeUserId_fkey"
    FOREIGN KEY ("consulteeUserId") REFERENCES "User"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse"
    ADD CONSTRAINT "DecisionConsultationResponse_projectId_consultationId_deci_fkey"
    FOREIGN KEY ("projectId", "consultationId", "decisionId")
    REFERENCES "DecisionConsultation"("projectId", "id", "decisionId")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_respondedById_fkey"
    FOREIGN KEY ("respondedById") REFERENCES "User"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse"
    ADD CONSTRAINT "DecisionConsultationResponse_decisionId_recommendedOptionI_fkey"
    FOREIGN KEY ("decisionId", "recommendedOptionId") REFERENCES "DecisionOption"("decisionId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
