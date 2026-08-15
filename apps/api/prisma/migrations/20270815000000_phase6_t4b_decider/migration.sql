-- Phase 6 task 4b — the per-decision decider, and the record-only issue.
-- Plan: docs/superpowers/plans/2026-08-14-decision-workflow-4b.md (cleared, PR #340).
--
-- SHAPE STAGE (staged-RED discipline): this file currently carries ONLY the additive
-- columns/enums/keys so the probes fail on BEHAVIOR, never a missing symbol. Before this
-- unit's review head, this same in-branch file grows the plan's §A migration semantics:
-- the ONE transaction taking LOCK TABLE "Decision","Membership","OrgMembership","Project"
-- IN SHARE ROW EXCLUSIVE MODE (NO advisory readiness keys — round 18), the diagnostic-first
-- published-open-decision orphan audit that ABORTS with a bounded per-project sample, and
-- the full seal network (rounds 1–19).
--
-- ADDITIVE and retry-safe (`IF NOT EXISTS` forms), the 4a precedent: a re-run after
-- operator repair must get past statements that already succeeded.

-- the enum values (never used in this file's immediate SQL)
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'recorded';

DO $$ BEGIN
  CREATE TYPE "DeciderKind" AS ENUM ('client', 'pmc', 'member', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- the decider columns: current state, editable while a draft, write-once from publication
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderKind" "DeciderKind" NOT NULL DEFAULT 'client';
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderMembershipId" TEXT;

-- the approval act's frozen holder tuple (round 3): the act keeps its own history
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderKind" "DeciderKind";
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderMembershipId" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderLabel" TEXT;

-- the candidate key the decider FK targets: a cross-project membership reference is
-- unrepresentable
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_projectId_id_key" ON "Membership"("projectId", "id");

DO $$ BEGIN
  ALTER TABLE "Decision"
    ADD CONSTRAINT "Decision_projectId_deciderMembershipId_fkey"
    FOREIGN KEY ("projectId", "deciderMembershipId")
    REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
