-- Phase 6 unit 4c-i — CONSULTATION, deployed DARK
-- (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md §A, §D "4c-i, the migration unit").
--
-- ONE additive migration. It creates the two append-only consultation facts, the composite FKs
-- and candidate keys they need, their CHECKs and UNIQUEs, the two NEW orgs-owned SQL primitives
-- the seals call, the two INSERT eligibility seals, the §C rule-ii provenance pair (INSERT arm +
-- DEFERRED commit arm), the row-level append-only seals, the statement-level no-TRUNCATE seals,
-- and the `consultation` capability reservation. There is NO caller, NO contract and NO route:
-- the previous release runs unchanged over this schema because nothing reads or writes the new
-- tables, and the one existing table that changes gains a NULLABLE column enforced by nothing.
--
-- EVERY STATEMENT IS RETRY-SAFE (plan §D, review round 2). A deploy that fails after creating an
-- early object must COMPLETE on retry, not stop at the object it already made — so each CREATE /
-- ADD CONSTRAINT / trigger carries `IF NOT EXISTS`, `DROP … IF EXISTS` first, or a
-- duplicate-object guard, the 20271015 discipline. The upgrade proof exercises exactly that: kill
-- after the first objects, re-run, assert every seal armed.
--
-- THE CANONICAL LOCK ORDER, which every seal below follows without exception:
--
--     readiness advisory key  →  "Project"  →  "Membership"  →  "Decision"
--
-- It is chosen to agree with the DELIVERED writers rather than to be internally tidy. The 4b
-- seals already take the readiness key first (§B.1 try-acquire-or-refuse) and then `Project`
-- (`phase6_user_decision_authority`); `decisions.approve` takes the readiness key and then the
-- `Decision` row. Putting `Decision` last therefore means no consultation write can hold a
-- decision row while asking for a project or membership lock that an approval already holds in
-- the other order — the AB-BA shape that would deadlock `decisions.approve`, a live command, on
-- a dark table's seal.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE CAPABILITY RESERVATION — INSTALLED BEFORE THE AUDIT READS
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- `ProjectCapability` is `@@id([projectId, capability])` over a FREE-TEXT column with no
-- whitelist, and the delivered `capability:enable` accepts any string. So a `consultation` row
-- could exist before 4c-ii deploys, and the first upgraded instance would emit while old workers
-- still ran — precisely what the gate exists to prevent.
--
-- ORDER MATTERS, and "diagnostic-first" is not sufficient on its own (review round 24). An audit
-- that READ first could observe no `consultation` row, a concurrent `capability:enable` against
-- the previous release could commit, and only THEN would `CREATE TRIGGER` take its lock — leaving
-- 4c-i committed having passed its own diagnostic with the gate already open. `CREATE TRIGGER`
-- takes ACCESS EXCLUSIVE on `ProjectCapability` inside this transaction, so creating it FIRST
-- means any concurrent writer blocks until commit and the audit reads a snapshot no other session
-- can extend. A writer already in flight either committed before the lock (the audit sees its row
-- and ABORTS) or resumes after commit (the reservation REJECTS it). No new mechanism, no
-- table-level LOCK statement.
--
-- BOTH DOORS (review round 21): `capability` is a mutable key with no freeze trigger, so an
-- INSERT-only guard would leave `UPDATE "ProjectCapability" SET "capability" = 'consultation'`
-- open — the same gate-open state by another route.
--
-- NO CHECK CONSTRAINT ON THE COLUMN — Board decision, 2026-08-29 on PR #480, not re-litigable.
-- Restricting an existing free-text column would break the previous release's generic
-- `capability:enable` writer during the dark window, and would not prevent an operator enabling
-- `consultation` between 4c-i and 4c-ii anyway (the RUNBOOK order and §D staging govern that).
CREATE OR REPLACE FUNCTION phase6_t4c_capability_reserved() RETURNS trigger AS $fn$
BEGIN
  IF NEW."capability" = 'consultation' THEN
    RAISE EXCEPTION 'phase6-4c: the `consultation` capability is RESERVED until unit 4c-iii enables it (project %). Enabling it now would open the write gate while previous-release workers can still serve.', NEW."projectId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ProjectCapability_t4c_consultation_reserved" ON "ProjectCapability";
CREATE TRIGGER "ProjectCapability_t4c_consultation_reserved"
  BEFORE INSERT OR UPDATE ON "ProjectCapability"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_capability_reserved();

-- …and only now the diagnostic. The unit is dark, so nothing legitimate can have created such a
-- row; the abort names the project rather than reporting a bare count.
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg(x."projectId", ', ' ORDER BY x."projectId"), '')
    INTO bad, sample
    FROM (
      SELECT pc."projectId" FROM "ProjectCapability" pc
       WHERE pc."capability" = 'consultation' LIMIT 20
    ) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-4c ABORT: % project(s) already carry the RESERVED `consultation` capability (sample: %) — the 4c gate would be open before unit 4c-ii deploys. Operator repair (docs/RUNBOOK.md §P6T4C): disable the capability on each named project with the operator CLI, then redeploy. Never leave it enabled and skip the abort.', bad, sample;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE TWO NEW ORGS-OWNED SQL PRIMITIVES (§B.2, review rounds 6/7/9)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The delivered inventory cannot express what 4c's seals need. `phase6_membership_is_active`
-- returns only a boolean, so it can neither lock the membership row nor return the `userId` the
-- response seal must compare; and nothing exposes a lockable project-operability check. Following
-- the old inventory would force the decisions-owned triggers to read `Membership`/`Project`
-- directly — the exact cross-module raw read the primitives exist to prevent — or to drop the
-- active-standing and archival predicates and admit the P25/P25d hostile inserts.
--
-- Both are ORGS-owned: `orgs` owns `membership` and `project` (`orgsManifest.ownsModels`), and
-- these are the DB-side twins of the existing lock-bearing `OrgsParticipant.isProjectOperable`
-- the delivered decider claim path already calls. They reach the decisions seals over the
-- ALREADY-DECLARED decisions → orgs edge; no new module dependency.

-- ORGS-owned: lock this membership row and return its `userId` IF the membership is ACTIVE,
-- NULL otherwise — standing and identity in ONE owned call.
--
-- Identity itself is frozen by the delivered `Membership_t4b_identity_frozen`, so this is not a
-- re-key defence (review round 9). What it serializes against is the ACTIVE→removed transition,
-- which IS a live state change: a boolean check followed by a separate read would leave a window
-- in which the membership is removed between the two.
CREATE OR REPLACE FUNCTION phase6_membership_active_user(p_project TEXT, p_membership TEXT)
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE m RECORD;
BEGIN
  IF p_project IS NULL OR p_membership IS NULL THEN RETURN NULL; END IF;
  SELECT "userId", "status" INTO m FROM "Membership"
   WHERE "projectId" = p_project AND "id" = p_membership FOR UPDATE;
  IF NOT FOUND OR m."status" <> 'active' THEN RETURN NULL; END IF;
  RETURN m."userId";
END $$;

-- ORGS-owned: lock the `Project` row BEFORE reading `archivedAt`, and return operability. The
-- seals' lock-before-read ordering is the PRIMITIVE's contract rather than each trigger's private
-- SQL, so an archive committing concurrently either waits or is seen.
CREATE OR REPLACE FUNCTION phase6_project_operable(p_project TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE archived TIMESTAMP(3);
BEGIN
  IF p_project IS NULL THEN RETURN FALSE; END IF;
  SELECT "archivedAt" INTO archived FROM "Project" WHERE "id" = p_project FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN archived IS NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 3. THE ADDITIVE CANDIDATE KEY ON THE EXISTING `DecisionOption`
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The supporting key for the response's `(decisionId, recommendedOptionId)` FK. Additive and
-- VACUOUSLY SATISFIABLE — `id` alone is already unique, so this index can reject no existing or
-- future row — with no writer change, exactly the shape of 4b's `Membership (projectId, id)` key.
--
-- The tuple is DELIBERATELY project-less (review round 3). `DecisionOption` has no `projectId`
-- column, so a `(projectId, decisionId, id)` key is unrealizable inside a dark migration (it
-- would demand a backfill, old-writer compatibility, and re-cover of the delivered option
-- evidence seals). It is also unneeded: the response's project↔decision pairing is pinned by its
-- consultation FK, whose parent's own `(projectId, decisionId)` FK onto `Decision(projectId, id)`
-- makes a cross-project decision unrepresentable — so same-decision binding on the option
-- completes the chain transitively.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionOption_decisionId_id_key" ON "DecisionOption"("decisionId", "id");

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 4. THE STAGED APPROVAL-COMMAND PROVENANCE COLUMN (review rounds 27–29)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 4c makes the `DecisionApprovalRevision` COUNT trusted cycle evidence, and the delivered
-- `DecisionApprovalRevision_no_withdrawn` trigger asserts only that the decision is not withdrawn
-- — no approval transition, no matching event. So a direct writer could insert a syntactically
-- valid revision against a live `pending` decision, advance the count past every open
-- consultation's frozen `openCycle`, and DENY a fact the workflow promises to keep answerable.
--
-- The correspondence must be to the TRANSITION, which only the approval COMMAND performs (round
-- 28): an `xmin = txid_current()` test on the `Decision` tuple proves only that the row was
-- written in this transaction, and a NO-OP `UPDATE` against an already-approved decision supplies
-- that for free. So the revision carries a receipt, checked at DEFERRED COMMIT TIME for a
-- SUCCEEDED completion whose `resultRef` identifies this decision (round 29).
--
-- AND IT IS STAGED HERE, BECAUSE 4c-i CANNOT ENFORCE IT. `DecisionsService.approve` writes its
-- revision with no `sourceCommandId`, and 4c-i is explicitly the DARK unit the previous release
-- must keep running against: installing the requirement now would reject every approval performed
-- by a still-serving 4b instance — a live workflow broken by a migration whose whole premise is
-- that nothing else changes. The column is NULLABLE and enforced by NOTHING; 4c-ii's writer
-- populates it and 4c-ii's own migration, which runs after the drain-first cutover, installs the
-- trigger. The compatibility probe proves it: a PREVIOUS-RELEASE approval against this schema
-- SUCCEEDS.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "sourceCommandId" TEXT;
DO $$ BEGIN
  ALTER TABLE "DecisionApprovalRevision"
    ADD CONSTRAINT "DecisionApprovalRevision_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the register's statement-level no-TRUNCATE seal (review round 15) ─────────────────────────
-- Sealing a fact append-only is incomplete until the tables its predicates COUNT are sealed at
-- the STATEMENT level as well. The register's delivered append-only trigger is ROW-level, and
-- PostgreSQL row triggers never fire for TRUNCATE, so `TRUNCATE "DecisionApprovalRevision"
-- CASCADE` would return every decision's cycle to 0 and make both the response command AND the
-- response INSERT seal accept a stale cycle-0 consultation in a REOPENED cycle — the exact
-- revival `openCycle` exists to prevent, reached by ERASING the evidence instead of forging it.
--
-- The sanctioned reset is updated in this SAME unit: `prisma/sanctioned-reset.ts` gains the
-- entry, which is the whole reset contract now that 4c-0 centralized it. A seal whose only
-- artifact is its migration is not finished.
CREATE OR REPLACE FUNCTION phase6_t4c_approval_revision_no_truncate() RETURNS trigger AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionApprovalRevision") THEN
    RAISE EXCEPTION 'phase6-4c: TRUNCATE would erase the approval revision register, which is the cycle evidence every consultation is bound to.';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_no_truncate" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_no_truncate"
  BEFORE TRUNCATE ON "DecisionApprovalRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_approval_revision_no_truncate();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 5. THE TWO TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "DecisionConsultation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "consulteeMembershipId" TEXT NOT NULL,
    "consulteeUserId" TEXT NOT NULL,
    "openCycle" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

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
    "respondedAt" TIMESTAMP(3) NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "DecisionConsultationResponse_pkey" PRIMARY KEY ("id")
);

-- ── the candidate keys and indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "DecisionConsultation_projectId_decisionId_idx" ON "DecisionConsultation"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionConsultation_projectId_consulteeMembershipId_idx" ON "DecisionConsultation"("projectId", "consulteeMembershipId");
-- the candidate key the response binds to, CARRYING THE DECISION so a response can never straddle
-- two decisions (review round 21: the cross-project arms pass even if `decisionId` is omitted —
-- only a SAME-PROJECT writer pairing consultation A with decision B proves this third column
-- participates)
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultation_response_target_key" ON "DecisionConsultation"("projectId", "id", "decisionId");
-- §C rule-ii: each command receipt is ONE-USE
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultation_source_command_key" ON "DecisionConsultation"("projectId", "sourceCommandId");

-- AT MOST ONE response per consultation. This is the real seal; the composite tuple below is only
-- what Prisma requires to express the one-to-one over a composite FK, and is strictly weaker.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_consultationId_key" ON "DecisionConsultationResponse"("consultationId");
CREATE INDEX IF NOT EXISTS "DecisionConsultationResponse_projectId_decisionId_idx" ON "DecisionConsultationResponse"("projectId", "decisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_consultation_key" ON "DecisionConsultationResponse"("projectId", "consultationId", "decisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionConsultationResponse_source_command_key" ON "DecisionConsultationResponse"("projectId", "sourceCommandId");

-- ── the composite FKs: every cross-project pairing UNREPRESENTABLE (P27) ──────────────────────
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_decisionId_fkey"
    FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_requestedById_fkey"
    FOREIGN KEY ("projectId", "requestedById") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_consulteeMembershipId_fkey"
    FOREIGN KEY ("projectId", "consulteeMembershipId") REFERENCES "Membership"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_consulteeUserId_fkey"
    FOREIGN KEY ("consulteeUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_projectId_consultationId_deci_fkey"
    FOREIGN KEY ("projectId", "consultationId", "decisionId") REFERENCES "DecisionConsultation"("projectId", "id", "decisionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_projectId_respondedById_fkey"
    FOREIGN KEY ("projectId", "respondedById") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_decisionId_recommendedOptionI_fkey"
    FOREIGN KEY ("decisionId", "recommendedOptionId") REFERENCES "DecisionOption"("decisionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the evidence CHECKs (P23, review round 4) ─────────────────────────────────────────────────
-- `question` and `response` are user-supplied EVIDENCE. The columns are NOT NULL *and* non-blank:
-- a CHECK over NULL evaluates to UNKNOWN and PASSES, so the btrim guard alone would let a direct
-- insert commit an append-only consultation or response with no evidence text at all.
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_question_non_blank"
    CHECK (btrim("question", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_response_non_blank"
    CHECK (btrim("response", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- a cycle generation is a COUNT of immutable rows; it can never be negative
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_open_cycle_non_negative"
    CHECK ("openCycle" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 6. THE REQUEST INSERT ELIGIBILITY SEAL
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Everything the service checks, checked again at the DATABASE — because these rows are
-- APPEND-ONLY. A forgery that lands here is permanent, and there is no later act to catch it.
--
-- The order of the arms below IS the canonical lock order stated at the head of this file, and
-- the §B.1 round-8 KEY-BEFORE-JUDGEMENT rule: the serialization key is taken BEFORE any row is
-- consulted, never after a prefilter that concurrent uncommitted writes can empty.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_seal() RETURNS trigger AS $fn$
DECLARE
  resolved_user TEXT;
  d RECORD;
  cycle BIGINT;
  cmd RECORD;
BEGIN
  -- (1) the readiness key, FIRST. On the command path the transaction already holds it (advisory
  -- locks are reentrant, so the try succeeds); on a direct write with the key free this acquires
  -- and HOLDS it to commit; on a direct write with the key CONTENDED it REFUSES outright. A seal
  -- never WAITS inside a trigger, so no lock-order inversion can exist.
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is contended — retry the consultation request (consultation %)', NEW."id";
  END IF;

  -- (2) "Project" — through the orgs-owned primitive, which takes the row lock BEFORE reading
  -- `archivedAt`, so an archive committing concurrently either waits or is seen.
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived or absent — a consultation cannot be requested on it', NEW."projectId";
  END IF;

  -- (3) "Membership" — standing AND identity in ONE owned call. Two forgeries die here:
  --   • the REMOVED-CONSULTEE forgery — a consultation naming a membership that no longer stands,
  --     which would publish a decision to someone the project has already removed;
  --   • the WRONG-AUDIENCE forgery — a `consulteeUserId` that is not the user this membership
  --     resolves to. The column is the DECISIONS-OWNED CANONICAL AUDIENCE and it exists because
  --     `rebuildSeed` replays no historical payloads: an audience living only in an event payload
  --     is lost by every rebuild, and folding it from `Membership` would be a cross-module read.
  --     It cannot DRIFT (identity is frozen by `Membership_t4b_identity_frozen`), but a raw writer
  --     can FORGE it, and a forged audience is a permanent read grant to the wrong person.
  resolved_user := phase6_membership_active_user(NEW."projectId", NEW."consulteeMembershipId");
  IF resolved_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership % does not currently stand as ACTIVE on project % — a consultation cannot be recorded against it', NEW."consulteeMembershipId", NEW."projectId";
  END IF;
  IF resolved_user <> NEW."consulteeUserId" THEN
    RAISE EXCEPTION 'phase6-4c: the recorded consultee audience (%) is not the user membership % resolves to — the canonical audience column may not be forged', NEW."consulteeUserId", NEW."consulteeMembershipId";
  END IF;

  -- (4) the REQUESTER must currently hold decision authority here (the delivered orgs-owned
  -- primitive; the membership-less org owner/admin path included). `architect` joins the
  -- requester set in 4d WITH the role, the same staging rule the decider value followed.
  IF NOT phase6_user_decision_authority(NEW."projectId", NEW."requestedById") THEN
    RAISE EXCEPTION 'phase6-4c: a consultation must be requested by a user with CURRENT decision authority on its project (consultation %)', NEW."id";
  END IF;

  -- (5) "Decision", LAST and under its own row lock. FOR SHARE is the lock-before-read the 4a
  -- linkability authority follows: it conflicts with the FOR UPDATE that `withdraw`, `approve`
  -- and `requestChange` take, so a withdrawal committing concurrently either waits or is seen.
  --
  -- ELIGIBILITY is "the question is still OPEN" — `pending` or `change` (the
  -- `awaiting_countersign` arm is ADDED BY 4d with the status itself) AND PUBLISHED. Status alone
  -- would admit an author-private DRAFT whose `status` is `pending`. `withdrawn` is excluded
  -- because its title and reason are pmc-only and a consultation there would leak exactly what 4a
  -- hides; `approved` and `recorded` because there is nothing left to inform.
  SELECT "status"::text AS status, "publishedAt" INTO d
    FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: decision % does not exist on project %', NEW."decisionId", NEW."projectId";
  END IF;
  IF d."publishedAt" IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: decision % is not published — an author-private draft has no consultees', NEW."decisionId";
  END IF;
  IF d.status NOT IN ('pending', 'change') THEN
    RAISE EXCEPTION 'phase6-4c: decision % is % — a consultation may be requested only while the question is still open', NEW."decisionId", d.status;
  END IF;

  -- (6) the INITIAL CYCLE is SEALED HERE, not merely compared later (review round 12). A seal that
  -- only compares `openCycle` at RESPONSE time trusts whatever the request wrote — so a command
  -- bug storing `current + 1` would mint a consultation that is unanswerable NOW but becomes
  -- answerable after ONE approve-and-reopen: the exact revival this field exists to prevent,
  -- arriving through a legitimate writer rather than a hostile one. Counted under the SAME
  -- decision row lock taken above, so a concurrent approval cannot slip a revision in between.
  SELECT count(*) INTO cycle FROM "DecisionApprovalRevision" WHERE "decisionId" = NEW."decisionId";
  IF NEW."openCycle" <> cycle THEN
    RAISE EXCEPTION 'phase6-4c: the frozen open cycle (%) is not the decision''s current cycle (%) — a consultation is bound to the cycle it was asked in', NEW."openCycle", cycle;
  END IF;

  -- (7) §C rule-ii PROVENANCE, insert arm. The composite FK already contains the receipt to this
  -- project; what the FK cannot say is WHICH receipt. `executeCommand` RESERVES the row, RUNS the
  -- mutation — which is this INSERT — and only THEN flips it to `succeeded` with its `resultRef`,
  -- all in one transaction, so a BEFORE INSERT trigger can never see `succeeded`. The reachable
  -- claim at this moment is therefore: same project, MATCHING type, still `reserved` — which is
  -- precisely the command CURRENTLY EXECUTING, since every past consultation command is already
  -- `succeeded` and so cannot be borrowed — and the ACTOR matches the fact's own recorded actor.
  --
  -- Without the actor arm the receipt would constrain project, type, state, reuse and result
  -- identity but say nothing about WHO acted: an alternate writer could reserve a genuine
  -- `consultations.request` as PMC A, attribute the immutable row to a different authorized PMC B,
  -- let the command complete with the correct `resultRef`, and satisfy every other arm — leaving
  -- an append-only fact that permanently contradicts its own provenance.
  SELECT "projectId", "commandType", "status", "actorId" INTO cmd
    FROM "CommandExecution" WHERE "id" = NEW."sourceCommandId";
  IF NOT FOUND OR cmd."projectId" IS DISTINCT FROM NEW."projectId" THEN
    RAISE EXCEPTION 'phase6-4c: the source command % does not exist in project %', NEW."sourceCommandId", NEW."projectId";
  END IF;
  IF cmd."commandType" <> 'consultations.request' THEN
    RAISE EXCEPTION 'phase6-4c: the source command % is a % receipt, not consultations.request', NEW."sourceCommandId", cmd."commandType";
  END IF;
  IF cmd."status" <> 'reserved' THEN
    RAISE EXCEPTION 'phase6-4c: the source command % is % — a consultation may cite only the receipt of the command CURRENTLY executing', NEW."sourceCommandId", cmd."status";
  END IF;
  IF cmd."actorId" <> NEW."requestedById" THEN
    RAISE EXCEPTION 'phase6-4c: the source command % was executed by % but the consultation records % as its requester', NEW."sourceCommandId", cmd."actorId", NEW."requestedById";
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_insert_seal" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_insert_seal"
  BEFORE INSERT ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_seal();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 7. THE RESPONSE INSERT ELIGIBILITY SEAL
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The response RE-CHECKS eligibility at ITS OWN moment (review round 3). A request made while
-- `pending` outlives the decision, and a stale response after a withdrawal would append evidence
-- — and push — against a row the consultee must no longer see. Same lock order, same key-first
-- rule; the response path is not a weaker echo of the request path.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_response_seal() RETURNS trigger AS $fn$
DECLARE
  c RECORD;
  resolved_user TEXT;
  d RECORD;
  cycle BIGINT;
  cmd RECORD;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is contended — retry the consultation response (response %)', NEW."id";
  END IF;

  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived or absent — a consultation cannot be answered on it', NEW."projectId";
  END IF;

  -- the parent, read from THIS module's own table. The composite FK already makes a foreign
  -- consultation, a disagreeing `projectId`, and a decision that is not the consultation's own
  -- unrepresentable; what is read here is the frozen audience and cycle the arms below compare.
  SELECT "consulteeMembershipId", "openCycle" INTO c
    FROM "DecisionConsultation"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."consultationId" AND "decisionId" = NEW."decisionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: consultation % does not exist on decision % in project %', NEW."consultationId", NEW."decisionId", NEW."projectId";
  END IF;

  -- THE NAMED CONSULTEE ANSWERS, AND NOBODY ELSE. `respondedById` exists precisely so this is
  -- checkable: without it a raw writer could forge advice presented forever as the consultee's.
  -- The membership must ALSO still stand — advice from a removed member, appended permanently
  -- after their removal, is not advice the project asked for.
  resolved_user := phase6_membership_active_user(NEW."projectId", c."consulteeMembershipId");
  IF resolved_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership % no longer stands as ACTIVE on project % — the consultation can no longer be answered', c."consulteeMembershipId", NEW."projectId";
  END IF;
  IF resolved_user <> NEW."respondedById" THEN
    RAISE EXCEPTION 'phase6-4c: response % records % as the responder, but the consultation names a different consultee — only the named consultee may answer', NEW."id", NEW."respondedById";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d
    FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: decision % does not exist on project %', NEW."decisionId", NEW."projectId";
  END IF;
  IF d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change') THEN
    RAISE EXCEPTION 'phase6-4c: decision % is no longer open for consultation (status %) — a late response may not append advice against it', NEW."decisionId", d.status;
  END IF;

  -- ELIGIBILITY IS NOT A STATUS TEST ALONE (review round 11). `decisions.requestChange` moves an
  -- `approved` decision back to `change`, so a status-only guard REVIVES a consultation the
  -- approval already closed: request while `pending` → approve → request change → a late response
  -- appends immutable advice against a question that belonged to the PREVIOUS cycle, and whose
  -- request push was already cancelled at the approval. An approval permanently closes every
  -- consultation from the cycle it ended; asking again in the new cycle means a NEW consultation,
  -- the same shape as the register's own "a changed need is a NEW decision" rule.
  SELECT count(*) INTO cycle FROM "DecisionApprovalRevision" WHERE "decisionId" = NEW."decisionId";
  IF c."openCycle" <> cycle THEN
    RAISE EXCEPTION 'phase6-4c: consultation % was asked in cycle % but the decision is now in cycle % — an approval closed that thread and a reopen does not revive it', NEW."consultationId", c."openCycle", cycle;
  END IF;

  SELECT "projectId", "commandType", "status", "actorId" INTO cmd
    FROM "CommandExecution" WHERE "id" = NEW."sourceCommandId";
  IF NOT FOUND OR cmd."projectId" IS DISTINCT FROM NEW."projectId" THEN
    RAISE EXCEPTION 'phase6-4c: the source command % does not exist in project %', NEW."sourceCommandId", NEW."projectId";
  END IF;
  IF cmd."commandType" <> 'consultations.respond' THEN
    RAISE EXCEPTION 'phase6-4c: the source command % is a % receipt, not consultations.respond', NEW."sourceCommandId", cmd."commandType";
  END IF;
  IF cmd."status" <> 'reserved' THEN
    RAISE EXCEPTION 'phase6-4c: the source command % is % — a response may cite only the receipt of the command CURRENTLY executing', NEW."sourceCommandId", cmd."status";
  END IF;
  -- worse here than on the request path: without this arm a writer could record the NAMED
  -- CONSULTEE as the responder while a different actor executed the command — exactly the forgery
  -- `respondedById` exists to prevent.
  IF cmd."actorId" <> NEW."respondedById" THEN
    RAISE EXCEPTION 'phase6-4c: the source command % was executed by % but the response records % as its responder', NEW."sourceCommandId", cmd."actorId", NEW."respondedById";
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_insert_seal" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_insert_seal"
  BEFORE INSERT ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_response_seal();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 8. §C RULE-II PROVENANCE, THE COMMIT ARM (review round 12)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The INSERT arm above binds a VALID receipt. It does not yet bind the command's RESULT — and a
-- same-project FK plus a `reserved` state still lets a direct writer reserve a receipt, insert a
-- row citing it, and commit WITHOUT emitting: the absent/foreign/fabricated probes all pass while
-- the projected read stays stale exactly as before. That matters because the `decisions.inbox`
-- consumer dispatches only on `decision.*` and then refreshes the whole generation from canonical
-- state, so a row appended with NO event leaves an already-active generation classified as caught
-- up while it serves its pre-insert DTO. An earlier draft treated such a row as
-- ACCEPTED-BUT-INVISIBLE and probed only that a REBUILD eventually recovered it; that is a stale
-- read served as current, and the fix is to make the state UNREPRESENTABLE, not recoverable.
--
-- DEFERRABLE INITIALLY DEFERRED, the delivered `phase4_labour_demand_sealed` pattern: at COMMIT
-- the cited command must be `succeeded` with its `resultRef` EQUAL to this row's own id, which
-- `executeCommand` writes before the transaction ends. The command's result IS this row, or the
-- commit fails. The actor is re-asserted at this moment too, because the receipt could in
-- principle have been completed by a different path than the one that reserved it.
--
-- The residual, stated honestly: a writer who forges a whole ledger row — which is forging a
-- COMMAND, the command ledger's own discipline, not something these two tables re-litigate. That
-- discipline is itself a DELIVERED database seal:
-- `20270425000000_platform_command_receipt_seal` installs `CommandExecution_receipt_protocol`,
-- which refuses a receipt minted already terminal, freezes `actorId`/`commandType`/
-- `idempotencyKey`/`requestHash`/`createdAt`/`id` and the scope columns, makes a completed receipt
-- immutable in outcome and result, and requires the completing UPDATE to come from the SAME
-- transaction that inserted the row (`xmin = txid_current()`). So an unused receipt cannot be
-- re-pointed at a chosen actor or command type, a receipt reserved in an earlier transaction
-- cannot be adopted and completed later, and an existing fact's provenance cannot be rewritten
-- afterwards. What remains is a deliberate multi-statement forgery inside ONE transaction by a
-- role holding INSERT/UPDATE on the ledger, whose answer is a privilege grant
-- (`docs/RUNBOOK.md §CMDR`) rather than another trigger — no trigger can distinguish "the
-- application ran" from "SQL that reproduced what the application would have written".
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_result_bound() RETURNS trigger AS $fn$
DECLARE cmd RECORD; actor TEXT;
BEGIN
  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    actor := NEW."requestedById";
  ELSE
    actor := NEW."respondedById";
  END IF;

  SELECT "status", "resultRef", "actorId" INTO cmd
    FROM "CommandExecution" WHERE "id" = NEW."sourceCommandId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: the source command % for %.% vanished before commit', NEW."sourceCommandId", TG_TABLE_NAME, NEW."id";
  END IF;
  IF cmd."status" <> 'succeeded' THEN
    RAISE EXCEPTION 'phase6-4c: %.% cites command %, which is % at commit — an accepted consultation write that never completed its command would be invisible to the projection', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", cmd."status";
  END IF;
  IF cmd."resultRef" IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION 'phase6-4c: command % committed with resultRef % — it is not the command that produced %.%', NEW."sourceCommandId", COALESCE(cmd."resultRef", '<null>'), TG_TABLE_NAME, NEW."id";
  END IF;
  IF cmd."actorId" <> actor THEN
    RAISE EXCEPTION 'phase6-4c: command % completed as actor % but %.% records % — an append-only fact may not contradict its own provenance', NEW."sourceCommandId", cmd."actorId", TG_TABLE_NAME, NEW."id", actor;
  END IF;

  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_result_bound" ON "DecisionConsultation";
CREATE CONSTRAINT TRIGGER "DecisionConsultation_t4c_result_bound"
  AFTER INSERT ON "DecisionConsultation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_result_bound();

DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_result_bound" ON "DecisionConsultationResponse";
CREATE CONSTRAINT TRIGGER "DecisionConsultationResponse_t4c_result_bound"
  AFTER INSERT ON "DecisionConsultationResponse"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_result_bound();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 9. APPEND-ONLY — UPDATE, DELETE, *AND* TRUNCATE (review round 3)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A question that was asked was asked, and advice that was given was given. Neither is editable
-- and neither is removable: the thread is the record of who was consulted and what they said, and
-- a decision approved after advice must remain checkable against the advice it had.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'phase6-4c: % is append-only — a consultation question and its advice are permanent evidence (% attempted)', TG_TABLE_NAME, TG_OP;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_append_only" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_append_only();

DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_append_only" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_append_only();

-- ── and the STATEMENT level, because row triggers never fire for TRUNCATE ─────────────────────
-- Row-level seals alone leave `TRUNCATE "DecisionConsultationResponse"` free to erase every
-- immutable response — and `TRUNCATE "DecisionConsultation" CASCADE` the whole register — while
-- the decisions stand. Both carry the NAMED statement-level seal, the delivered pattern
-- `Decision`/`DecisionOption`/`OrgMembership` already hold, each hostile-probed directly (P23).
-- Both names are registered in `prisma/sanctioned-reset.ts` in this same unit, which is what
-- keeps the integration battery runnable: a `BEFORE TRUNCATE` trigger fires even on an EMPTY
-- table, so an unregistered seal fails in the SETUP of every suite whose reset reaches the table.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_no_truncate() RETURNS trigger AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionConsultation") THEN
    RAISE EXCEPTION 'phase6-4c: TRUNCATE would erase the consultation register, which records who was asked and in which decision cycle.';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_no_truncate" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_no_truncate"
  BEFORE TRUNCATE ON "DecisionConsultation"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_consultation_no_truncate();

CREATE OR REPLACE FUNCTION phase6_t4c_response_no_truncate() RETURNS trigger AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionConsultationResponse") THEN
    RAISE EXCEPTION 'phase6-4c: TRUNCATE would erase recorded consultation advice, which a decision approved after it must remain checkable against.';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_no_truncate" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_no_truncate"
  BEFORE TRUNCATE ON "DecisionConsultationResponse"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_response_no_truncate();
