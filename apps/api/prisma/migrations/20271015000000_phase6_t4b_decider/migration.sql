-- Phase 6 task 4b — the decider, and the record-only issue
-- (docs/superpowers/plans/2026-08-14-decision-workflow-4b.md §A–§B).
--
-- STAGED SHAPE (the 4a §D discipline): this first slice carries ONLY the contracts/enums/columns
-- the unit's probes need — the behavior (the audit, the §B.2 primitives, the seal network) is
-- deliberately absent at the staged baseline so every probe fails on BEHAVIOR, never on a missing
-- symbol. The seals join this same file in the behavior slice of the same review unit.
--
-- Enum additions ride the migration transaction (PostgreSQL ≥ 12); nothing in THIS transaction
-- consumes the new values, and every later in-file comparison uses ::text, so the
-- unusable-in-same-transaction rule is never tripped.

ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS 'none';
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'recorded';

-- §A.2 — a RECORD has no option-sourced presentation; the choice kinds keep the column required
-- (the CHECK arrives with the seal slice, judged by ::text so it never consumes the new value).
ALTER TABLE "Decision" ALTER COLUMN "photoSwatch" DROP NOT NULL;

-- §A.3 rounds 9/13/14/15 — the OPTIONAL subscription→user linkage for targeted delivery. All
-- nullable and additive: today's rows carry no owner and a backfill cannot invent one; the link
-- is attributed opportunistically on the next authenticated app open.
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedUserId" TEXT;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedCredentialVersion" INTEGER;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedExpiresAt" TIMESTAMP(3);
DO $$ BEGIN
  ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_linkedUserId_fkey"
    FOREIGN KEY ("linkedUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "PushSubscription_linkedUserId_idx"
  ON "PushSubscription"("linkedUserId");

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- BEHAVIOR SLICE — the audit, the §B.2 primitives, and the 4b seal network. Every probe above ran
-- RED at the staged shape baseline; this slice is what turns them green.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── the deployment-window serialization + the diagnostic-first backfill audit (§A.1, rounds
-- 14/16–18) ────────────────────────────────────────────────────────────────────────────────────
-- The pre-4b writers this window is about (MembersService.updateRole, OrgsService org-membership
-- writes, DecisionsService.create(publish=true)) take NO advisory readiness key, so the audit's
-- serialization rests on locks they ALREADY conflict with: the four-table SHARE ROW EXCLUSIVE
-- set below conflicts with every concurrent INSERT/UPDATE/DELETE's ROW EXCLUSIVE lock (old
-- instances included) and with itself (two deploys serialize). `Decision` is IN the list because
-- standing writes are only half the race — an old create path could otherwise birth a published
-- client-held decision AFTER a clean audit. And the migration takes NO advisory readiness key
-- (round 18): holding table locks and then requesting the key an already-rolled 4b writer holds
-- (writer: key → row lock; migration: table lock → key) completes an AB-BA cycle.
LOCK TABLE "Decision", "Membership", "OrgMembership", "Project" IN SHARE ROW EXCLUSIVE MODE;

-- ── §B.2 — cross-module facts as OWNED SQL primitives (never table reads across modules) ──────
-- ORGS-owned: is this membership ACTIVE?
CREATE OR REPLACE FUNCTION phase6_membership_is_active(p_project TEXT, p_membership TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Membership" m
     WHERE m."projectId" = p_project AND m."id" = p_membership AND m."status" = 'active'
  );
$$;

-- ORGS-owned: EFFECTIVE role standing (renamed from active-member-count, §B.2 round 8): active
-- memberships in the role PLUS, for pmc, owner/admin standing on the project's org with the SAME
-- precedence as authorization — an org owner holding an explicit ACTIVE membership is judged on
-- that membership's role alone and never upgraded through the org.
CREATE OR REPLACE FUNCTION phase6_effective_role_standing(p_project TEXT, p_role TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT (
    SELECT count(*) FROM "Membership" m
     WHERE m."projectId" = p_project AND m."status" = 'active' AND m."role" = p_role
  ) + CASE WHEN p_role = 'pmc' THEN (
    SELECT count(*) FROM "Project" p
      JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
     WHERE p."id" = p_project
       AND NOT EXISTS (
         SELECT 1 FROM "Membership" m2
          WHERE m2."projectId" = p_project AND m2."userId" = om."userId" AND m2."status" = 'active'
       )
  ) ELSE 0 END;
$$;

-- ORGS-owned: does this USER currently hold standing that authorizes creating decisions here
-- (§B.2 rounds 7/9/15)? The effective project role — explicit ACTIVE membership WINS over org
-- standing — must satisfy decision-create authority (pmc), AND the project must be OPERABLE:
-- `archivedAt` is judged while HOLDING the Project row lock, the same order
-- `ProjectAccessService.authorize` implies, so an already-archived insert is refused and an
-- archive committing concurrently either waits or is seen.
CREATE OR REPLACE FUNCTION phase6_user_decision_authority(p_project TEXT, p_user TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE proj RECORD; explicit_role TEXT;
BEGIN
  IF p_user IS NULL THEN RETURN FALSE; END IF;
  SELECT "orgId", "archivedAt" INTO proj FROM "Project" WHERE "id" = p_project FOR UPDATE;
  IF NOT FOUND OR proj."archivedAt" IS NOT NULL THEN RETURN FALSE; END IF;
  SELECT m."role" INTO explicit_role FROM "Membership" m
   WHERE m."projectId" = p_project AND m."userId" = p_user AND m."status" = 'active';
  IF explicit_role IS NOT NULL THEN RETURN explicit_role = 'pmc'; END IF;
  RETURN EXISTS (
    SELECT 1 FROM "OrgMembership" om
     WHERE om."orgId" = proj."orgId" AND om."userId" = p_user AND om."role" IN ('owner', 'admin')
  );
END $$;

-- DECISIONS-owned: does any PUBLISHED OPEN decision name this holder (§A.1)? Both designations:
-- the named membership, and the ROLE a decision holds while this is its project. The caller
-- composes the role arm with standing (the orgs seal asks "would standing be zero").
CREATE OR REPLACE FUNCTION phase6_decisions_name_membership(p_project TEXT, p_membership TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = p_project AND d."deciderMembershipId" = p_membership
       AND d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change')
  );
$$;
CREATE OR REPLACE FUNCTION phase6_decisions_hold_role(p_project TEXT, p_role TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = p_project AND d."deciderKind"::text = p_role
       AND d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change')
  );
$$;

-- §B.1 — the TRY-ACQUIRE-OR-REFUSE protocol. The seal takes the SAME readiness key the service
-- takes (readiness-lock.ts: 'readiness:<projectId>'): on the service path the command already
-- holds it (advisory locks are reentrant — try succeeds); on a direct write with the key free it
-- acquires and HOLDS to commit; on a direct write with the key CONTENDED it REFUSES outright —
-- a seal never waits inside a trigger, so no lock-order inversion exists.
CREATE OR REPLACE FUNCTION phase6_try_readiness(p_project TEXT)
RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
  SELECT pg_try_advisory_xact_lock(hashtextextended('readiness:' || p_project, 0));
$$;

-- ── the diagnostic-first audit (round 14): every PUBLISHED OPEN decision must have a CURRENT
-- effective holder BEFORE the guards install — never inventing one. Every legacy row backfills
-- `deciderKind='client'` by column default; the audit refuses to certify a register already in
-- the zero-holder state a newly published decision is refused for.
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg(x."projectId" || '/' || x."id", ', ' ORDER BY x."id"), '')
    INTO bad, sample
    FROM (
      SELECT d."projectId", d."id" FROM "Decision" d
       WHERE d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change')
         AND CASE
               WHEN d."deciderKind"::text = 'member'
                 THEN NOT phase6_membership_is_active(d."projectId", d."deciderMembershipId")
               WHEN d."deciderKind"::text IN ('client', 'pmc')
                 THEN phase6_effective_role_standing(d."projectId", d."deciderKind"::text) = 0
               ELSE FALSE
             END
       LIMIT 20
    ) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-4b ABORT: % published open decision(s) have NO current effective holder (sample: %) — the guards below would start life violated. Operator repair (docs/RUNBOOK.md §P6T4B): withdraw-and-reissue each orphaned decision, or restore a covering membership; never invent a holder.', bad, sample;
  END IF;
END $$;

-- ── the kind⟺status pair + record coherence CHECKs (§A.2) ────────────────────────────────────
-- Judged by ::text so this transaction never consumes the enum values it just added.
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b2_kind_status_check" CHECK (
    ("deciderKind"::text = 'none') = ("status"::text = 'recorded')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- a record can never carry approval evidence in ANY column the approve path writes (rounds 9/10)
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b2_record_approval_null_check" CHECK (
    "status"::text <> 'recorded' OR (
      "approvedOption" IS NULL AND "approvedById" IS NULL AND "approver" IS NULL
      AND "onBehalfOf" IS NULL AND "material" IS NULL AND "cost" IS NULL AND "date" IS NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- the option-sourced swatch stays REQUIRED for every choice kind; only a record may omit it
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b2_swatch_check" CHECK (
    "photoSwatch" IS NOT NULL OR "deciderKind"::text = 'none'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the 4b lifecycle seal (BEFORE INSERT OR UPDATE on Decision) ───────────────────────────────
-- The arms this trigger owns: the recorded-birth author standing (P18), the publication and
-- reopen holder-standing re-validation at the DB (§A.1 rounds 10/18), the recorded TERMINAL +
-- entry + published-evidence freeze (§A.2 rounds 1/6/11/12/15/18), and the from-birth identity
-- freeze (`authorId`, round 14 — `id`/`projectId` are frozen by the 20270826 seal).
CREATE OR REPLACE FUNCTION phase6_t4b2_decision_seal() RETURNS trigger AS $fn$
DECLARE approvals BIGINT; changes BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- a terminal `recorded` row is BORN permanent with no later act to catch a forged author:
    -- the author must currently hold decision-create authority here (the orgs-owned primitive;
    -- the membership-less org owner/admin path included). Under the §B.1 protocol.
    IF NEW."status"::text = 'recorded' THEN
      IF NOT phase6_try_readiness(NEW."projectId") THEN
        RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry the record insert (decision %)', NEW."id";
      END IF;
      IF NOT phase6_user_decision_authority(NEW."projectId", NEW."authorId") THEN
        RAISE EXCEPTION 'phase6-4b: a record must be authored by a user with CURRENT decision authority on its project (decision %)', NEW."id";
      END IF;
    END IF;
    -- a MEMBER-held row born published must name an ACTIVE membership (the service path births
    -- unpublished and publishes by UPDATE; this is the hostile-INSERT door)
    IF NEW."publishedAt" IS NOT NULL AND NEW."deciderKind"::text = 'member'
       AND NOT phase6_membership_is_active(NEW."projectId", NEW."deciderMembershipId") THEN
      RAISE EXCEPTION 'phase6-4b: a published decision must name an ACTIVE membership as decider (decision %)', NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  -- from-birth identity: no product path ever re-attributes a decision (draft edits cover
  -- content and the holder, never identity) — the forged-but-authorized launder is foreclosed
  IF NEW."authorId" IS DISTINCT FROM OLD."authorId" THEN
    RAISE EXCEPTION 'phase6-4b: decision authorship is frozen from birth (%)', OLD."id";
  END IF;

  -- the PUBLISHED record is a permanent register entry: no transition out, no evidence rewrite
  -- (title, location, publishedAt, author, swatch — the whole filed issue). `ageDays` is the one
  -- derived display counter that may tick.
  IF OLD."status"::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
    IF NEW."status"::text IS DISTINCT FROM OLD."status"::text
       OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."room" IS DISTINCT FROM OLD."room"
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
       OR NEW."photoSwatch" IS DISTINCT FROM OLD."photoSwatch"
       OR NEW."deciderKind"::text IS DISTINCT FROM OLD."deciderKind"::text
       OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'phase6-4b: a published record is a permanent register entry — its evidence is frozen (%)', OLD."id";
    END IF;
  END IF;

  -- entry INTO `recorded` (round 12 + rounds 15/18): the only legal entries are birth as a
  -- record and the coherent UNPUBLISHED draft conversion — which must be APPROVAL-CLEAN and
  -- CHANGE-CLEAN (evidence planted on a pending draft must not survive conversion into a
  -- permanent unapprovable entry).
  IF NEW."status"::text = 'recorded' AND OLD."status"::text <> 'recorded' THEN
    IF OLD."publishedAt" IS NOT NULL OR NEW."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a PUBLISHED decision can never become a record — records are born, not laundered (%)', OLD."id";
    END IF;
    SELECT count(*) INTO approvals FROM "DecisionApprovalRevision" r WHERE r."decisionId" = OLD."id";
    IF approvals = 0 THEN
      SELECT count(*) INTO approvals FROM "DecisionEvent" e
       WHERE e."decisionId" = OLD."id" AND e."type" IN ('approved', 'reapproved');
    END IF;
    IF approvals > 0 THEN
      RAISE EXCEPTION 'phase6-4b: this draft carries approval evidence — it can never become a record (%)', OLD."id";
    END IF;
    SELECT count(*) INTO changes FROM "ChangeRequest" c WHERE c."decisionId" = OLD."id";
    IF changes > 0 THEN
      RAISE EXCEPTION 'phase6-4b: this draft carries change-request evidence — it can never become a record (%)', OLD."id";
    END IF;
  END IF;

  -- the PUBLICATION boundary (publishedAt NULL → NOT NULL): re-validate the holder's CURRENT
  -- standing at the DB — the named membership ACTIVE; a ROLE-held decider through
  -- effective-role-standing (publishing into a project with no active holder would birth the
  -- zero-holder state the removal guard exists to prevent). Under the §B.1 protocol. The child
  -- OPTION floor at this same boundary is the DEFERRED commit-time seal below (both doors).
  IF OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL THEN
    IF NOT phase6_try_readiness(NEW."projectId") THEN
      RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry the publication (decision %)', OLD."id";
    END IF;
    IF NEW."deciderKind"::text = 'member' AND NOT phase6_membership_is_active(NEW."projectId", NEW."deciderMembershipId") THEN
      RAISE EXCEPTION 'phase6-4b: the named decider membership is no longer active — edit the draft''s holder before publishing (decision %)', OLD."id";
    END IF;
    IF NEW."deciderKind"::text IN ('client', 'pmc')
       AND phase6_effective_role_standing(NEW."projectId", NEW."deciderKind"::text) = 0 THEN
      RAISE EXCEPTION 'phase6-4b: this project has no active % holder — publishing would birth a decision nobody can decide; edit the draft''s holder first (decision %)', NEW."deciderKind"::text, OLD."id";
    END IF;
  END IF;

  -- the REOPEN arm (round 18): `approved → change` re-validates the FROZEN holder's CURRENT
  -- standing at the DB — a direct transaction flipping the head while inserting its
  -- ChangeRequest touches no membership row, so no other seal would fire.
  IF OLD."status"::text = 'approved' AND NEW."status"::text = 'change' THEN
    IF NOT phase6_try_readiness(NEW."projectId") THEN
      RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry the change request (decision %)', OLD."id";
    END IF;
    IF NEW."deciderKind"::text = 'member' AND NOT phase6_membership_is_active(NEW."projectId", NEW."deciderMembershipId") THEN
      RAISE EXCEPTION 'phase6-4b: the decider membership is no longer active — a reopened decision cannot be born holderless; the approved outcome stands (a changed need is a NEW decision, or the 4d forward re-homes it) (decision %)', OLD."id";
    END IF;
    IF NEW."deciderKind"::text IN ('client', 'pmc')
       AND phase6_effective_role_standing(NEW."projectId", NEW."deciderKind"::text) = 0 THEN
      RAISE EXCEPTION 'phase6-4b: this project has no active % holder — a reopened decision cannot be born holderless; the approved outcome stands (decision %)', NEW."deciderKind"::text, OLD."id";
    END IF;
  END IF;

  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4b2_lifecycle_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b2_lifecycle_seal"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_decision_seal();

-- ── the OPTION floor at the publication boundary — BOTH doors, judged AT COMMIT ───────────────
-- (§A.2 rounds 13/17/18/19.) A BEFORE trigger on Decision cannot count children that are
-- inserted after the head row, so the floor is a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger judged when the transaction commits: a PUBLISHED choice-kind decision must hold 2–4
-- options and a PUBLISHED record exactly zero, whether publication arrived by the guarded UPDATE
-- or by an INSERT born published. The re-ordered create (head births unpublished → options →
-- publication UPDATE, one transaction) and every legal nested-create fixture pass; the hostile
-- direct-SQL publication of a zero-option draft, the hostile published INSERT, and the
-- zero-option converted draft reaching the publish door are all refused alike. Fired from BOTH
-- tables: the Decision transition and any DecisionOption write on a published parent re-judge
-- the same aggregate (the Phase-4 demand-seal shape).
CREATE OR REPLACE FUNCTION phase6_t4b2_option_floor() RETURNS trigger AS $fn$
DECLARE d RECORD; n BIGINT; did TEXT;
BEGIN
  -- an IF, not a CASE expression: PL/pgSQL resolves EVERY field reference in one expression
  -- against the row type, so `NEW."decisionId"` inside an untaken CASE arm still errors when
  -- the firing row is a Decision.
  IF TG_TABLE_NAME = 'Decision' THEN did := NEW."id"; ELSE did := NEW."decisionId"; END IF;
  SELECT "id", "deciderKind"::text AS kind, "publishedAt" INTO d
    FROM "Decision" WHERE "id" = did;
  IF NOT FOUND OR d."publishedAt" IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO n FROM "DecisionOption" o WHERE o."decisionId" = d."id";
  IF d.kind = 'none' AND n <> 0 THEN
    RAISE EXCEPTION 'phase6-4b: a record takes no options — % carries % (an optioned record is a category error)', d."id", n;
  END IF;
  IF d.kind <> 'none' AND (n < 2 OR n > 4) THEN
    RAISE EXCEPTION 'phase6-4b: a published choice needs 2-4 approvable options — % has % (a decision nobody can approve must not publish)', d."id", n;
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4b2_option_floor" ON "Decision";
CREATE CONSTRAINT TRIGGER "Decision_t4b2_option_floor"
  AFTER INSERT OR UPDATE ON "Decision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_option_floor();
DROP TRIGGER IF EXISTS "DecisionOption_t4b2_option_floor" ON "DecisionOption";
CREATE CONSTRAINT TRIGGER "DecisionOption_t4b2_option_floor"
  AFTER INSERT ON "DecisionOption"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_option_floor();

-- ── the child-side option freeze extends from `withdrawn`-only to EVERY PUBLISHED parent ──────
-- (§A.2 round 19.) Once `publishedAt` is set, the decision's DecisionOption rows admit no
-- INSERT, DELETE or UPDATE (a re-point is judged against BOTH parents) — the question-and-option
-- evidence freeze the published record already carries, stated for every kind. No product path
-- edits options after publication, so the seal costs nothing legal. A RECORDED parent refuses
-- option INSERTs even unpublished (the one-way zero-option child seal, round 16). The trigger
-- KEEPS the 4a name — the sanctioned destructive resets disable it by that name.
CREATE OR REPLACE FUNCTION phase6_t4a_option_frozen_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT; dpublished TIMESTAMP(3);
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT d."status"::text, d."publishedAt" INTO dstatus, dpublished
      FROM "Decision" d WHERE d."id" = OLD."decisionId" FOR UPDATE;
    IF dstatus = 'withdrawn' OR dpublished IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: decision % is published — its options are part of the frozen question and cannot change', OLD."decisionId";
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId") THEN
    SELECT d."status"::text, d."publishedAt" INTO dstatus, dpublished
      FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
    IF dstatus = 'withdrawn' OR dpublished IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: decision % is published — its options are part of the frozen question and cannot change', NEW."decisionId";
    END IF;
    IF dstatus = 'recorded' THEN
      RAISE EXCEPTION 'phase6-4b: decision % is a record — no option may ever attach to it', NEW."decisionId";
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── ChangeRequest: recorded parents refuse the child; the parent identity is FROZEN ───────────
-- (§A.2 rounds 18/19.) A change claim can neither attach to a permanent record (INSERT judged
-- under the parent row lock) nor be RE-POINTED between decisions (a child's parent identity
-- joins the identity-freeze class — re-pointing a legitimate open request onto a record would
-- strand the source decision's required request while the record gains an unclosable claim).
CREATE OR REPLACE FUNCTION phase6_t4b2_change_request_seal() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
    RAISE EXCEPTION 'phase6-4b: a change request stays with the decision it was raised against (%)', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
    IF dstatus = 'recorded' THEN
      RAISE EXCEPTION 'phase6-4b: decision % is a record — nothing about it is approvable, so no change can be requested', NEW."decisionId";
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "ChangeRequest_t4b2_seal" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4b2_seal"
  BEFORE INSERT OR UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_change_request_seal();

-- ── the approval reverse arms extend to `recorded` (§A.2 rounds 9/10) ─────────────────────────
-- A record can carry approval evidence in NO table. Function identities and trigger names are
-- preserved (the sanctioned destructive resets disable them by name); the bodies gain exactly
-- the recorded arm.
CREATE OR REPLACE FUNCTION phase6_t4a_no_approval_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
  IF dstatus IN ('withdrawn', 'recorded') THEN
    RAISE EXCEPTION 'phase6-t4a: decision % is % — an approval revision can no longer be recorded', NEW."decisionId", dstatus;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase6_t4a_no_approval_event_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" IN ('approved', 'reapproved') THEN
      RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — it cannot be deleted (decision %)', OLD."id", OLD."decisionId";
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."type" IN ('approved', 'reapproved') AND NEW."type" NOT IN ('approved', 'reapproved') THEN
    RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — its type cannot be downgraded (decision %)', OLD."id", OLD."decisionId";
  END IF;
  IF NEW."type" IN ('approved', 'reapproved') THEN
    SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
    IF dstatus IN ('withdrawn', 'recorded') THEN
      RAISE EXCEPTION 'phase6-t4a: decision % is % — an approval event can no longer be recorded', NEW."decisionId", dstatus;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."type" IN ('approved', 'reapproved') AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
    RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — it cannot be re-pointed away from decision %', OLD."id", OLD."decisionId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── a PUBLISHED record cannot be deleted (the 4a no-delete discipline) ────────────────────────
-- An unpublished draft record stays the author's weightless workspace — deletable like any
-- draft. The sanctioned destructive resets disable this named trigger for exactly their wipe.
CREATE OR REPLACE FUNCTION phase6_t4b2_record_no_delete() RETURNS trigger AS $fn$
BEGIN
  IF OLD."status"::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'phase6-4b: a published record is a permanent register entry — it cannot be deleted (decision %)', OLD."id";
  END IF;
  RETURN OLD;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4b2_record_no_delete" ON "Decision";
CREATE TRIGGER "Decision_t4b2_record_no_delete"
  BEFORE DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_record_no_delete();

-- ── the ORGS-owned membership seal: the holder-orphan refusal at the DATABASE ─────────────────
-- (§A.1 rounds 2/5/11/19; §B.1.) AFTER ROW, not deferred: the row change is applied in this
-- transaction, so the effective standing computed here IS the post-write state — including the
-- ACTIVATION-DISPLACEMENT shape (an explicit membership re-classifying a membership-less org
-- admin) and the precedence resurfacing an org owner when their explicit membership leaves. The
-- rule is ONE question after every guarded write: for each role any published open decision
-- holds, is effective standing now zero? Plus the named-designation arm: a membership that IS
-- the decider of a published open decision cannot be removed, deactivated or hard-deleted.
-- Under the §B.1 try-acquire protocol.
CREATE OR REPLACE FUNCTION phase6_t4b2_membership_guard() RETURNS trigger AS $fn$
DECLARE pid TEXT; r TEXT; judged TEXT[] := ARRAY[]::TEXT[];
BEGIN
  pid := COALESCE(NEW."projectId", OLD."projectId");
  -- the guarded set: activation, removal/restore (hard DELETE included), role change — any
  -- write that can flip holder-relevant standing. Pure display/limit updates pass untouched.
  IF TG_OP = 'UPDATE'
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;
  -- Only roles THIS write could have reduced are judged — the seal answers for the write in
  -- front of it, never for a pre-existing shortfall some unrelated write did not cause:
  --   · losing an ACTIVE row (delete/deactivate/role-change-away) reduces OLD.role;
  --   · an ACTIVATION reduces only the user's membership-less org-PMC arm (the round-19
  --     displacement: explicit-membership precedence re-classifies an org owner/admin).
  IF (TG_OP IN ('UPDATE', 'DELETE')) AND OLD."status" = 'active'
     AND (TG_OP = 'DELETE' OR NEW."status" <> 'active' OR NEW."role" IS DISTINCT FROM OLD."role") THEN
    judged := array_append(judged, OLD."role");
  END IF;
  IF ((TG_OP = 'INSERT' AND NEW."status" = 'active')
      OR (TG_OP = 'UPDATE' AND OLD."status" <> 'active' AND NEW."status" = 'active'))
     AND EXISTS (
       SELECT 1 FROM "Project" p
         JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."userId" = NEW."userId"
        WHERE p."id" = pid AND om."role" IN ('owner', 'admin')
     ) THEN
    judged := array_append(judged, 'pmc');
  END IF;
  IF array_length(judged, 1) IS NULL THEN RETURN NULL; END IF;
  IF NOT phase6_try_readiness(pid) THEN
    RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry this membership change (project %)', pid;
  END IF;
  -- the NAMED designation: the decider membership of a published open decision must stay active
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD."status" = 'active' AND NEW."status" <> 'active') THEN
    IF phase6_decisions_name_membership(pid, OLD."id") THEN
      RAISE EXCEPTION 'phase6-4b: membership % is the named decider of a published open decision — withdraw-and-reissue (or, from 4d, forward) before removing it', OLD."id";
    END IF;
  END IF;
  -- the ROLE designations: after this write, every judged role a published open decision holds
  -- must still have effective standing (client; pmc — including membership-less org admins)
  FOREACH r IN ARRAY judged LOOP
    IF r IN ('client', 'pmc') AND phase6_decisions_hold_role(pid, r)
       AND phase6_effective_role_standing(pid, r) = 0 THEN
      RAISE EXCEPTION 'phase6-4b: this change leaves NO effective % holder while a published open decision is held by that role (project %) — cover the decision first (withdraw-and-reissue, or restore standing)', r, pid;
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Membership_t4b2_holder_guard" ON "Membership";
CREATE TRIGGER "Membership_t4b2_holder_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_membership_guard();

-- ── the ORG-membership writes join the same guard (§A.1 rounds 11/12/13) ──────────────────────
-- Effective PMC standing deliberately includes the membership-less org owner/admin, so the
-- write that orphans a pmc-held decision is not always a project-Membership write. Every
-- affected project (ascending id — the deadlock-free §C order) is judged under its own
-- readiness key. And the STANDING-DERIVATION CHAIN's identity columns are FROZEN as a CLASS:
-- `OrgMembership.userId`/`orgId` never re-key — an org move is a REMOVAL plus an ADDITION, each
-- judged here; a single-statement hostile move is unrepresentable.
CREATE OR REPLACE FUNCTION phase6_t4b2_org_membership_guard() RETURNS trigger AS $fn$
DECLARE proj RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
      RAISE EXCEPTION 'phase6-4b: org-membership identity is frozen — an org move is a removal plus an addition, each judged per project (%)', OLD."id";
    END IF;
  END IF;
  -- only writes that can LOSE effective-PMC standing are judged (adding standing orphans nothing)
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD."role" IN ('owner', 'admin') AND NEW."role" NOT IN ('owner', 'admin')) THEN
    FOR proj IN
      SELECT p."id" FROM "Project" p
       WHERE p."orgId" = OLD."orgId"
         AND phase6_decisions_hold_role(p."id", 'pmc')
         -- this user's org arm is SUPPRESSED wherever they hold an active explicit membership
         -- (the precedence rule), so this write cannot have reduced that project's standing
         AND NOT EXISTS (
           SELECT 1 FROM "Membership" m
            WHERE m."projectId" = p."id" AND m."userId" = OLD."userId" AND m."status" = 'active'
         )
       ORDER BY p."id" ASC
    LOOP
      IF NOT phase6_try_readiness(proj."id") THEN
        RAISE EXCEPTION 'phase6-4b: the readiness key for project % is contended — retry this org-membership change', proj."id";
      END IF;
      IF phase6_effective_role_standing(proj."id", 'pmc') = 0 THEN
        RAISE EXCEPTION 'phase6-4b: this change leaves project % with NO effective pmc while a published open decision is pmc-held — cover the decision first', proj."id";
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "OrgMembership_t4b2_holder_guard" ON "OrgMembership";
CREATE TRIGGER "OrgMembership_t4b2_holder_guard"
  AFTER UPDATE OR DELETE ON "OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_org_membership_guard();

-- ── `Project.orgId` joins the frozen standing-derivation chain (round 13, the CLASS rule) ─────
-- The link that selects WHICH org's owner/admin rows provide effective-PMC standing at all.
-- Re-homing a project is a removal-plus-addition lifecycle no current product path offers.
CREATE OR REPLACE FUNCTION phase6_t4b2_project_org_frozen() RETURNS trigger AS $fn$
BEGIN
  IF NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION 'phase6-4b: a project''s org is part of the frozen standing-derivation chain — re-homing is a removal plus an addition, never an UPDATE (%)', OLD."id";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Project_t4b2_org_frozen" ON "Project";
CREATE TRIGGER "Project_t4b2_org_frozen"
  BEFORE UPDATE OF "orgId" ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4b2_project_org_frozen();
