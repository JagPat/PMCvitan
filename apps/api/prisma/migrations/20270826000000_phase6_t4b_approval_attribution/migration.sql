-- Phase 6 task 4b replacement — approval-attribution/evidence expansion only.
--
-- This migration is deliberately compatible with the still-serving pre-4b application:
-- `deciderKind` has the old client default and the approval tuple stays nullable. A later unit
-- must deploy tuple-writing code, drain old writers, stamp approvals created during that window,
-- and only then require a tuple on every new approval.

-- Serialize the legacy stamp with old writers. Every pre-4b approval writes Decision, so it
-- either commits before this lock and is stamped below, or waits until the compatibility shape
-- and seals are installed. Prisma applies this file in one transaction and holds the lock to end.
LOCK TABLE "Decision", "Membership" IN SHARE ROW EXCLUSIVE MODE;

DO $$ BEGIN
  CREATE TYPE "DeciderKind" AS ENUM ('client', 'pmc', 'member');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderKind" "DeciderKind" NOT NULL DEFAULT 'client';
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderMembershipId" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderKind" "DeciderKind";
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderMembershipId" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderLabel" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Membership_projectId_id_key"
  ON "Membership"("projectId", "id");

DO $$ BEGIN
  ALTER TABLE "Decision"
    ADD CONSTRAINT "Decision_projectId_deciderMembershipId_fkey"
    FOREIGN KEY ("projectId", "deciderMembershipId")
    REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Decision_deciderMembershipId_idx"
  ON "Decision"("projectId", "deciderMembershipId");
CREATE INDEX IF NOT EXISTS "Decision_approvedDeciderMembershipId_idx"
  ON "Decision"("projectId", "approvedDeciderMembershipId");
CREATE INDEX IF NOT EXISTS "Decision_open_holder_idx"
  ON "Decision"("projectId", "deciderKind")
  WHERE "publishedAt" IS NOT NULL
    AND "status" IN ('pending'::"DecisionStatus", 'change'::"DecisionStatus");

DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_decider_pair_check" CHECK (
    ("deciderKind"::text = 'member') = ("deciderMembershipId" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Null remains the explicit compatibility state. Once any attribution is supplied, the whole
-- tuple is coherent and the display label follows the repository's full ASCII-whitespace rule.
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_approved_tuple_check" CHECK (
    (
      "approvedDeciderKind" IS NULL
      AND "approvedDeciderMembershipId" IS NULL
      AND "approvedDeciderLabel" IS NULL
    ) OR (
      "approvedDeciderKind" IS NOT NULL
      AND "approvedDeciderLabel" IS NOT NULL
      AND btrim("approvedDeciderLabel", E' \t\n\x0B\f\r') <> ''
      AND (("approvedDeciderKind"::text = 'member') = ("approvedDeciderMembershipId" IS NOT NULL))
      AND "status"::text IN ('approved', 'change')
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "DecisionLegacyApproval" (
  "decisionId" TEXT NOT NULL,
  "stampedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionLegacyApproval_pkey" PRIMARY KEY ("decisionId"),
  CONSTRAINT "DecisionLegacyApproval_decisionId_fkey"
    FOREIGN KEY ("decisionId") REFERENCES "Decision"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Only the migration owns this insert. `change` is approval standing reopened by a change
-- request, and therefore belongs to the same legacy class as `approved`. On a completed rerun
-- the sealed trigger already exists, so skip the INSERT entirely: a BEFORE INSERT trigger fires
-- even for an `ON CONFLICT DO NOTHING` row.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = '"DecisionLegacyApproval"'::regclass
       AND tgname = 'DecisionLegacyApproval_sealed'
       AND NOT tgisinternal
  ) THEN
    INSERT INTO "DecisionLegacyApproval" ("decisionId")
    SELECT d."id"
      FROM "Decision" d
     WHERE d."status"::text IN ('approved', 'change')
       AND d."approvedDeciderKind" IS NULL
    ON CONFLICT ("decisionId") DO NOTHING;
  END IF;
END $do$;

-- Register identity is frozen from birth: re-keying the row or moving it to another project would
-- silently re-identify every holder/approval claim stored on it. Current holder state is editable
-- only while the decision is a private draft. Approval attribution is optional for compatibility,
-- but once supplied it is an immutable act and it must describe the holder on the same approval
-- transition.
CREATE OR REPLACE FUNCTION decision_t4b_attribution_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_writes_tuple BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: decision register identity is frozen from birth (%).', OLD."id";
    END IF;

    -- Round 1 (Codex F1): publication is a permanent register fact. Without this arm the holder
    -- freeze below could be unlocked in two transactions — clear `publishedAt`, then rewrite the
    -- holder while `OLD."publishedAt" IS NULL`. Nothing in the product ever un-publishes a
    -- decision (publish is a one-way `publishedAt IS NULL` transition), so refusing it costs the
    -- compatibility writer nothing and removes the nullable value's power to reopen the seal.
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot be un-published — publication is permanent (%).', OLD."id";
    END IF;

    -- Round 1 (Codex F1): the freeze must not rest on the current nullable publication value
    -- alone. An approval tuple, approval/change standing, or a migration stamp each name the
    -- holder just as durably as publication does — an unpublished row carrying any of them
    -- would otherwise let its current holder drift away from the frozen approval claim, making
    -- the trusted evidence contradict itself. None of the four can be cleared first to reopen
    -- this arm: publication is permanent (above), the tuple is frozen and approval/change
    -- standing cannot be left (below), and the stamp is migration-owned and sealed.
    IF (
         OLD."publishedAt" IS NOT NULL
      OR OLD."approvedDeciderKind" IS NOT NULL
      OR OLD."status"::text IN ('approved', 'change', 'withdrawn')
      OR EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = OLD."id")
    ) AND (
         NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
      OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId"
    ) THEN
      RAISE EXCEPTION 'phase6-4b: a published or attributed decision keeps its holder — the decider tuple is frozen (%).', OLD."id";
    END IF;

    IF OLD."approvedDeciderKind" IS NOT NULL AND (
         NEW."approvedDeciderKind" IS DISTINCT FROM OLD."approvedDeciderKind"
      OR NEW."approvedDeciderMembershipId" IS DISTINCT FROM OLD."approvedDeciderMembershipId"
      OR NEW."approvedDeciderLabel" IS DISTINCT FROM OLD."approvedDeciderLabel"
    ) THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution is frozen once written (%).', OLD."id";
    END IF;

    -- An approval can reopen to `change` and close back to `approved`; it cannot be laundered
    -- into a status that says the approval never happened. Tupleless old-writer rows are covered
    -- by the status itself and by their migration stamp.
    IF OLD."status"::text IN ('approved', 'change')
       AND NEW."status"::text NOT IN ('approved', 'change') THEN
      RAISE EXCEPTION 'phase6-4b: an approval-bearing decision cannot leave approved/change standing (%).', OLD."id";
    END IF;

    v_writes_tuple := OLD."approvedDeciderKind" IS NULL
      AND NEW."approvedDeciderKind" IS NOT NULL;
    IF v_writes_tuple AND NOT (
      OLD."status"::text IN ('pending', 'change') AND NEW."status"::text = 'approved'
    ) THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution may first be written only by an approval transition (%).', OLD."id";
    END IF;
  ELSE
    v_writes_tuple := NEW."approvedDeciderKind" IS NOT NULL;
    IF v_writes_tuple AND NEW."status"::text <> 'approved' THEN
      RAISE EXCEPTION 'phase6-4b: an inserted approval tuple belongs only to an approved decision (%).', NEW."id";
    END IF;
  END IF;

  IF v_writes_tuple THEN
    IF NEW."approvedDeciderKind" IS DISTINCT FROM NEW."deciderKind"
       OR NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution must freeze the decision holder tuple (%).', NEW."id";
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_attribution_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b_attribution_seal"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_attribution_seal();

-- A membership id denotes one person in one project for its lifetime. Re-keying either owner
-- column would silently move every named holder without touching Decision and without firing its
-- holder freeze.
CREATE OR REPLACE FUNCTION membership_t4b_identity_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
    RAISE EXCEPTION 'phase6-4b: membership user/project identity is frozen (%).', OLD."id";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4b_identity_frozen" ON "Membership";
CREATE TRIGGER "Membership_t4b_identity_frozen"
  BEFORE UPDATE OF "userId", "projectId" ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION membership_t4b_identity_frozen();

-- The stamp is trusted because its writer disappears at the end of this migration. A cascading
-- parent delete is allowed only after the parent trigger has been deliberately disabled for a
-- sanctioned destructive reset; every direct application write remains closed.
CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_sealed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "Decision" WHERE "id" = OLD."decisionId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'phase6-4b: legacy approval evidence is migration-owned and sealed.';
END $$;

DROP TRIGGER IF EXISTS "DecisionLegacyApproval_sealed" ON "DecisionLegacyApproval";
CREATE TRIGGER "DecisionLegacyApproval_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "DecisionLegacyApproval"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_legacy_evidence_sealed();

CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionLegacyApproval") THEN
    RAISE EXCEPTION 'phase6-4b: legacy approval evidence cannot be truncated while it holds rows.';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionLegacyApproval_no_truncate" ON "DecisionLegacyApproval";
CREATE TRIGGER "DecisionLegacyApproval_no_truncate"
  BEFORE TRUNCATE ON "DecisionLegacyApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_legacy_evidence_no_truncate();

-- Extend the already-deployed Decision delete seal forward instead of adding a sibling trigger.
-- Existing seed/test destructive resets disable this named trigger in a transaction; production
-- deletes cannot erase either modern attribution or the migration stamp.
CREATE OR REPLACE FUNCTION phase6_t4a_withdrawn_no_delete() RETURNS TRIGGER AS $fn$
BEGIN
  IF OLD."status"::text = 'withdrawn' THEN
    RAISE EXCEPTION 'phase6-t4a: a withdrawn decision is a permanent register entry — it cannot be deleted (decision %)', OLD."id";
  END IF;

  IF OLD."status"::text IN ('approved', 'change')
     OR OLD."approvedById" IS NOT NULL
     OR OLD."approver" IS NOT NULL
     OR OLD."approvedOption" IS NOT NULL
     OR OLD."approvedDeciderKind" IS NOT NULL
     OR EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = OLD."id")
     -- These two pre-4b registers are alternate writers of approval evidence. Their existing
     -- append-only/event seals keep each child durable; this parent arm closes the cascade path.
     OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r WHERE r."decisionId" = OLD."id")
     OR EXISTS (
       SELECT 1 FROM "DecisionEvent" e
        WHERE e."decisionId" = OLD."id" AND e."type" IN ('approved', 'reapproved')
     ) THEN
    RAISE EXCEPTION 'phase6-4b: approval evidence is a permanent register entry — decision % cannot be deleted.', OLD."id";
  END IF;
  RETURN OLD;
END $fn$ LANGUAGE plpgsql;

-- Keep the 4b evidence classes protected by their own final trigger as well. The 4a migration is
-- intentionally rerunnable for operator repair and recreates its older function; a later repair
-- must not temporarily reopen DELETE for any approval evidence.
--
-- Round 1 (Codex F2): a tuple and a migration stamp were not the whole set. During the supported
-- compatibility window the old writer approves WITHOUT a tuple, and the migration stamp covers
-- only rows that already existed when this file ran — so such an approval was protected solely by
-- the consolidated body above. A 4a repair replay restores that function's withdrawn-only body,
-- and this trigger then also passed, reopening DELETE. This seal therefore carries the complete
-- approval set independently: standing, every legacy approval column, the tuple, the stamp, and
-- both alternate approval-evidence registers. `withdrawn` is deliberately absent — it is the 4a
-- migration's own arm, restored verbatim by the very replay this trigger guards against.
--
-- Because this is now a full seal, the sanctioned destructive resets that already disable
-- `Decision_t4a_d_no_delete` by name for exactly one wipe (prisma/seed.ts and the t4a/t4b suites)
-- disable this named trigger in the same transaction.
CREATE OR REPLACE FUNCTION decision_t4b_evidence_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."approvedDeciderKind" IS NOT NULL
     OR OLD."status"::text IN ('approved', 'change')
     OR OLD."approvedById" IS NOT NULL
     OR OLD."approver" IS NOT NULL
     OR OLD."approvedOption" IS NOT NULL
     OR EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = OLD."id")
     OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r WHERE r."decisionId" = OLD."id")
     OR EXISTS (
       SELECT 1 FROM "DecisionEvent" e
        WHERE e."decisionId" = OLD."id" AND e."type" IN ('approved', 'reapproved')
     ) THEN
    RAISE EXCEPTION 'phase6-4b: approval attribution/evidence is permanent — decision % cannot be deleted.', OLD."id";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_evidence_no_delete" ON "Decision";
CREATE TRIGGER "Decision_t4b_evidence_no_delete"
  BEFORE DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_evidence_no_delete();

-- TRUNCATE does not fire row triggers. Judge the whole register after PostgreSQL obtains its
-- ACCESS EXCLUSIVE lock; a concurrent attribution writer commits before this check or waits until
-- after a permitted evidence-free truncate, so committed evidence is never erased.
CREATE OR REPLACE FUNCTION decision_t4b_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "Decision" d
     WHERE d."status"::text IN ('approved', 'change', 'withdrawn')
        OR d."approvedById" IS NOT NULL
        OR d."approver" IS NOT NULL
        OR d."approvedOption" IS NOT NULL
        OR d."approvedDeciderKind" IS NOT NULL
  ) OR EXISTS (SELECT 1 FROM "DecisionLegacyApproval")
    OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision")
    OR EXISTS (
      SELECT 1 FROM "DecisionEvent" WHERE "type" IN ('approved', 'reapproved')
    ) THEN
    RAISE EXCEPTION 'phase6-4b: TRUNCATE would erase permanent approval/withdrawal evidence.';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_no_truncate" ON "Decision";
CREATE TRIGGER "Decision_t4b_no_truncate"
  BEFORE TRUNCATE ON "Decision"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_no_truncate();
