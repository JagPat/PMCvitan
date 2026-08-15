-- Phase 6 task 4b — the per-decision decider, and the record-only issue.
-- Plan: docs/superpowers/plans/2026-08-14-decision-workflow-4b.md (cleared, PR #340).
--
-- ADDITIVE, DIAGNOSTIC-FIRST and retry-safe (`IF NOT EXISTS` forms, `pg_constraint`-guarded
-- DO blocks, `CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS`) — the 4a precedent: this file is
-- RERUNNABLE BY DESIGN, because the audit below ABORTS the deploy on a violating database and
-- a re-run after operator repair must get past the statements that already succeeded.
--
-- Nothing here edits or invents a fact. The audit REFUSES rather than fabricating a holder.
--
-- NOTE on the new enum values: `ALTER TYPE ... ADD VALUE` cannot have its value USED in the
-- same transaction, so every reference below compares `::text` (the 4a precedent).

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 0 — SERIALIZATION WITH LIVE TRAFFIC (plan §A.1, rounds 16-18)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Advisory readiness keys serialize only participants that TAKE them, and the pre-4b writers
-- this deployment window is about — `MembersService.updateRole`, `OrgsService.updateOrgMemberRole`
-- / `removeOrgMember`, and `DecisionsService.create(..., publish=true)` — write their tables
-- DIRECTLY with no `lockProjectReadiness`. The serialization therefore rests on locks those
-- writers ALREADY conflict with: SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock every
-- concurrent INSERT/UPDATE/DELETE holds (old-version app instances included) and is
-- self-conflicting, so two deploy runs serialize too.
--
-- `Decision` is IN the list (round 18): with only the membership-side tables locked, the audit
-- could observe a project with a PMC but no active client and PASS, after which the old create
-- path INSERTs a published decision touching none of the locked tables — a row then backfilled
-- 'client' that survives guard installation holderless.
--
-- And this migration takes NO advisory readiness key (round 18, reversing round 17): the table
-- locks already exclude every writer the audit depends on, so an advisory acquisition adds no
-- exclusion — while HOLDING it would invert lock order against an already-rolled 4b writer (that
-- writer takes its readiness key THEN its Membership row lock; a migration holding table locks
-- and then requesting the same key completes the AB-BA cycle and PostgreSQL must abort a side).
--
-- Prisma runs this file in ONE transaction, so the locks are held from here through the last
-- guard installed below.

LOCK TABLE "Decision", "Membership", "OrgMembership", "Project" IN SHARE ROW EXCLUSIVE MODE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — the shape: enum values, columns, candidate key, decider FK
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'recorded';

DO $$ BEGIN
  CREATE TYPE "DeciderKind" AS ENUM ('client', 'pmc', 'member', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- the decider: current state, editable while a draft, write-once FROM publication
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderKind" "DeciderKind" NOT NULL DEFAULT 'client';
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "deciderMembershipId" TEXT;

-- the approval act's frozen holder tuple (round 3): the holder columns are current STATE;
-- the act keeps its OWN history, so a later 4d forward cannot rewrite whose consent was captured
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderKind" "DeciderKind";
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderMembershipId" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "approvedDeciderLabel" TEXT;

-- the candidate key the decider FK targets — a cross-project holder is unrepresentable
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_projectId_id_key" ON "Membership"("projectId", "id");

DO $$ BEGIN
  ALTER TABLE "Decision"
    ADD CONSTRAINT "Decision_projectId_deciderMembershipId_fkey"
    FOREIGN KEY ("projectId", "deciderMembershipId")
    REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Decision_deciderMembershipId_idx" ON "Decision"("projectId", "deciderMembershipId");
CREATE INDEX IF NOT EXISTS "Decision_open_holder_idx" ON "Decision"("projectId", "deciderKind") WHERE "publishedAt" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — THE DIAGNOSTIC-FIRST ORPHAN AUDIT (plan §A.1, round 14)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- The holder-removal guard does not exist before 4b, so a production register can ALREADY hold a
-- published OPEN decision whose last active client left. A silent 'client' backfill would start
-- the new system in the exact zero-holder state every newly published decision is refused for.
--
-- The audit therefore judges every PUBLISHED OPEN decision for CURRENT effective-holder
-- existence and ABORTS with a bounded per-project sample. It NEVER invents a holder: the
-- operator repairs by withdrawing-and-reissuing the decision, or by restoring a covering
-- membership (docs/RUNBOOK.md §P6T4B).

DO $$
DECLARE
  orphan_count  INT;
  sample        TEXT;
BEGIN
  -- Every pre-4b row is 'client'-held (the column default IS the backfill), so the audit asks
  -- exactly one question per project: does an ACTIVE client membership still exist? The org
  -- owner/admin arm of effective-role standing covers `pmc` ONLY (ProjectAccessService's
  -- precedence), so it cannot rescue a client-held decision.
  SELECT COUNT(*) INTO orphan_count
  FROM "Decision" d
  WHERE d."publishedAt" IS NOT NULL
    AND d.status::text IN ('pending', 'change')
    AND d."deciderKind"::text = 'client'
    AND NOT EXISTS (
      SELECT 1 FROM "Membership" m
      WHERE m."projectId" = d."projectId" AND m.role = 'client' AND m.status = 'active'
    );

  IF orphan_count > 0 THEN
    SELECT string_agg(line, E'\n') INTO sample FROM (
      SELECT '    project ' || d."projectId" || ': ' || COUNT(*)::text || ' decision(s), e.g. ' ||
             string_agg(d.id, ', ' ORDER BY d.id) FILTER (WHERE d.rn <= 3) AS line
      FROM (
        SELECT d.*, row_number() OVER (PARTITION BY d."projectId" ORDER BY d.id) AS rn
        FROM "Decision" d
        WHERE d."publishedAt" IS NOT NULL
          AND d.status::text IN ('pending', 'change')
          AND d."deciderKind"::text = 'client'
          AND NOT EXISTS (
            SELECT 1 FROM "Membership" m
            WHERE m."projectId" = d."projectId" AND m.role = 'client' AND m.status = 'active'
          )
      ) d
      GROUP BY d."projectId"
      ORDER BY d."projectId"
      LIMIT 20
    ) s;

    RAISE EXCEPTION E'phase6-4b: % published OPEN decision(s) have NO effective holder.\n%\n\nThe 4b holder guard refuses to create this state, so the migration refuses to START in it.\nRepair each listed decision (docs/RUNBOOK.md §P6T4B) by EITHER withdrawing and reissuing it,\nOR restoring an active client membership on the project, then redeploy. This migration NEVER\ninvents a holder.', orphan_count, sample;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — §B.2 CROSS-MODULE DB PRIMITIVES (owned, declared, never a raw table read)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- A decisions-owned trigger must NOT select from the orgs-owned `Membership` table, and vice
-- versa: the module boundary the TypeScript participant channels enforce does not stop at the
-- database. Each module exposes the facts its seals owe the other as OWNED, DECLARED functions
-- — the database analogue of the participant channel, named for the OWNER.

-- ── ORGS-owned (callable by decisions-owned seals) ─────────────────────────────────────────

/** Is this membership currently ACTIVE in this project? */
CREATE OR REPLACE FUNCTION orgs_membership_is_active(p_project_id TEXT, p_membership_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Membership"
    WHERE "projectId" = p_project_id AND id = p_membership_id AND status = 'active'
  );
$$;

/**
 * How many effective holders does this ROLE have on this project (round 8 — a bare membership
 * count does not model the authority rule)? Active memberships in the role, PLUS — for `pmc`
 * ONLY — owner/admin standing on the project's org, with the SAME precedence authorization uses:
 * an explicit ACTIVE membership WINS, so an org admin who also holds an active `client`
 * membership is a client here and does NOT count as a PMC.
 */
CREATE OR REPLACE FUNCTION orgs_effective_role_standing(p_project_id TEXT, p_role TEXT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT (
    SELECT COUNT(*) FROM "Membership" m
    WHERE m."projectId" = p_project_id AND m.role = p_role AND m.status = 'active'
  )::int
  + CASE WHEN p_role = 'pmc' THEN (
      SELECT COUNT(*) FROM "OrgMembership" om
      JOIN "Project" p ON p."orgId" = om."orgId"
      WHERE p.id = p_project_id
        AND om.role IN ('owner', 'admin')
        -- membership-less ONLY: an explicit ACTIVE membership takes precedence
        AND NOT EXISTS (
          SELECT 1 FROM "Membership" m2
          WHERE m2."projectId" = p_project_id AND m2."userId" = om."userId" AND m2.status = 'active'
        )
    )::int ELSE 0 END;
$$;

/**
 * Does this user currently hold standing that authorizes CREATING decisions on this project
 * (round 7; operability round 9; precedence round 14)? The user's EFFECTIVE project role must
 * satisfy decision-create authority, resolved with the same precedence as
 * `ProjectAccessService.authorize` — an explicit ACTIVE membership WINS over org standing — AND
 * the project must be OPERABLE (`archivedAt IS NULL`), judged while holding the `Project` row
 * lock so an archive committing concurrently either waits or is seen.
 *
 * Consumed by the recorded-insert seal to validate `authorId`: a terminal `recorded` row is BORN
 * permanent with no later act to catch a forged author.
 */
-- VOLATILE, not STABLE: this primitive takes the `Project` row lock (`FOR SHARE`), and
-- PostgreSQL allows row locking only in a volatile function. The lock is the point — the
-- operability judgement must not race an archive committing concurrently.
CREATE OR REPLACE FUNCTION orgs_user_decision_authority(p_project_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_org_id      TEXT;
  v_archived    TIMESTAMP(3);
  v_role        TEXT;
  v_org_role    TEXT;
BEGIN
  IF p_user_id IS NULL THEN RETURN FALSE; END IF;

  -- the operability judgement, under the Project row lock (the order authorize implies)
  SELECT "orgId", "archivedAt" INTO v_org_id, v_archived
  FROM "Project" WHERE id = p_project_id FOR SHARE;
  IF NOT FOUND OR v_archived IS NOT NULL THEN RETURN FALSE; END IF;

  -- an explicit ACTIVE membership WINS (round 15): an org owner/admin who also holds an active
  -- `client` membership resolves to `client` and is refused exactly as every request path
  -- refuses them.
  SELECT role INTO v_role FROM "Membership"
  WHERE "projectId" = p_project_id AND "userId" = p_user_id AND status = 'active';
  IF FOUND THEN
    RETURN v_role IN ('pmc', 'engineer');
  END IF;

  -- membership-less org owner/admin operates the project as PMC
  IF v_org_id IS NOT NULL THEN
    SELECT role INTO v_org_role FROM "OrgMembership"
    WHERE "orgId" = v_org_id AND "userId" = p_user_id;
    IF FOUND AND v_org_role IN ('owner', 'admin') THEN RETURN TRUE; END IF;
  END IF;

  RETURN FALSE;
END $$;

-- ── DECISIONS-owned (callable by the orgs-owned membership seal) ───────────────────────────

/**
 * Does any PUBLISHED OPEN decision name this holder — by NAMED MEMBERSHIP, or by a ROLE this
 * membership is the LAST effective holder of? The DB re-judgement of the `holdsOpenDecisions`
 * participant answer, mirroring the existing bidirectional orgs ⇄ decisions TS channel.
 *
 * `p_departing` is the standing the write would REMOVE: pass the role the membership currently
 * holds. A private DRAFT never blocks — it is weightless and its holder is editable until publish.
 */
CREATE OR REPLACE FUNCTION decisions_open_decision_names_holder(
  p_project_id TEXT, p_membership_id TEXT, p_departing_role TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_named   BOOLEAN;
  v_role    BOOLEAN;
BEGIN
  -- (1) the NAMED-member designation
  SELECT EXISTS (
    SELECT 1 FROM "Decision" d
    WHERE d."projectId" = p_project_id
      AND d."publishedAt" IS NOT NULL
      AND d.status::text IN ('pending', 'change')
      AND d."deciderKind"::text = 'member'
      AND d."deciderMembershipId" = p_membership_id
  ) INTO v_named;
  IF v_named THEN RETURN TRUE; END IF;

  -- (2) the ROLE designation — orphaned just the same when the LAST effective holder of that
  -- role leaves. The caller has already excluded this membership from the standing count.
  IF p_departing_role IS NULL THEN RETURN FALSE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM "Decision" d
    WHERE d."projectId" = p_project_id
      AND d."publishedAt" IS NOT NULL
      AND d.status::text IN ('pending', 'change')
      AND d."deciderKind"::text = p_departing_role
  ) INTO v_role;
  RETURN v_role;
END $$;

-- ── the §B.1 try-acquire-or-refuse protocol ────────────────────────────────────────────────

/**
 * Seals that read CROSS-TABLE standing serialize by TRY-ACQUIRE, never by waiting in a trigger.
 * A trigger that BLOCKS on the readiness advisory key inverts the service's lock order (a direct
 * write holds its row lock before its trigger runs, so it would wait on the key while a service
 * command holding that key waits on the same row — a deadlock, not serialization).
 *
 *   - SERVICE path: the command already holds the key from `lockProjectReadiness`; advisory locks
 *     are reentrant, so the try-acquire SUCCEEDS.
 *   - DIRECT write, key FREE: acquires and HOLDS to commit — the standing read is exclusive.
 *   - DIRECT write, key CONTENDED: REFUSES outright. A seal refuses; it never waits.
 *
 * The key is `hashtextextended('readiness:' || projectId, 0)` — the SAME derivation
 * `readiness-lock.ts` exports, never one that merely looks like it.
 */
CREATE OR REPLACE FUNCTION t4b_require_readiness_key(p_project_id TEXT, p_what TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('readiness:' || p_project_id, 0)) THEN
    RAISE EXCEPTION 'phase6-4b: % refused — the project readiness lock is held by another transaction; retry through the command path', p_what;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — the coherence CHECKs (structural truths, no cross-table read)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- kind ⟺ membershipId: a member-held decision NAMES its member; no other kind may.
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_decider_pair_check" CHECK (
    ("deciderKind"::text = 'member') = ("deciderMembershipId" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- kind ⟺ status, BOTH directions: 'none' is exactly 'recorded', and 'recorded' is exactly 'none'.
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_kind_status_check" CHECK (
    ("deciderKind"::text = 'none') = (status::text = 'recorded')
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- a record can never carry approval evidence (round 9/10 — the FULL set `approve` writes)
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_recorded_no_approval_check" CHECK (
    status::text <> 'recorded' OR (
      "approvedOption" IS NULL AND "approvedById" IS NULL AND approver IS NULL
      AND "onBehalfOf" IS NULL AND material IS NULL AND cost IS NULL AND date IS NULL
      AND "approvedDeciderKind" IS NULL AND "approvedDeciderMembershipId" IS NULL
      AND "approvedDeciderLabel" IS NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- the frozen act tuple is coherent with itself: a named holder iff the act's kind is 'member'
DO $$ BEGIN
  ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_approved_decider_pair_check" CHECK (
    "approvedDeciderKind" IS NULL
    OR (("approvedDeciderKind"::text = 'member') = ("approvedDeciderMembershipId" IS NOT NULL))
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — the Decision seals
-- ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The publication boundary — every 4b freeze binds here (plan §A.1, rounds 4/9/11/16/18/19).
 *
 *   • `publishedAt` is WRITE-ONCE for every decision: a published → draft transition is refused
 *     for all kinds, so the draft-edit door exists only for rows that were NEVER published
 *     (without this, the two-transaction bypass — clear publishedAt, re-point the holder through
 *     the now-legal draft door, republish — reopens every freeze below).
 *   • `Decision.id` is immutable once published: a direct re-key cascades child FKs to the new
 *     key while non-FK evidence (event and outbox entity identifiers) keeps the old one,
 *     splitting a published decision from its own trail.
 *   • `authorId` and `projectId` are INSERT-frozen for EVERY decision, draft included (round 14):
 *     re-checking the FINAL tuple's authority still accepts a forged-but-authorized identity, so
 *     the freeze forecloses the launder. No product path re-attributes or re-homes a decision.
 *   • The HOLDER columns are write-once FROM publication: while `publishedAt IS NULL` the author
 *     edits the holder like any other draft field; from publication the trigger refuses ANY
 *     holder change (4d loosens this to exactly one opening — a change accompanied by its
 *     same-transaction DecisionForward row).
 *   • The option floor is re-judged AT publication, at BOTH doors — the NULL → NOT NULL UPDATE
 *     and an INSERT arriving already-published — because a server-only recheck leaves hostile SQL
 *     able to publish a zero-option ordinary draft that no one can ever approve.
 *   • A member-held decision's holder must be ACTIVE at publication, and a ROLE-held decision's
 *     role must have effective standing (round 10) — publishing into a project with no active
 *     client would birth the zero-holder state the removal guard exists to prevent.
 */
CREATE OR REPLACE FUNCTION decision_t4b_publication_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_publishing  BOOLEAN;
  v_options     INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_publishing := NEW."publishedAt" IS NOT NULL;
  ELSE
    -- identity + publication freezes (published rows only, except identity which binds at birth)
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot return to draft (%).', OLD.id;
    END IF;
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" <> OLD."publishedAt" THEN
      RAISE EXCEPTION 'phase6-4b: publishedAt is write-once (%).', OLD.id;
    END IF;
    IF OLD."publishedAt" IS NOT NULL AND NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'phase6-4b: a published decision keeps the identity it was filed under (%).', OLD.id;
    END IF;
    IF NEW."authorId" IS DISTINCT FROM OLD."authorId" THEN
      RAISE EXCEPTION 'phase6-4b: authorId is frozen from birth (%) — attribution is never rewritten.', OLD.id;
    END IF;
    IF NEW."projectId" <> OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: projectId is frozen from birth (%) — a decision never moves register.', OLD.id;
    END IF;
    -- the holder columns: write-once FROM publication
    IF OLD."publishedAt" IS NOT NULL AND (
         NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
      OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId"
    ) THEN
      RAISE EXCEPTION 'phase6-4b: the decider of a PUBLISHED decision is write-once (%) — re-homing arrives with 4d forwarding.', OLD.id;
    END IF;
    v_publishing := OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL;
  END IF;

  IF v_publishing THEN
    -- the option floor, in the DATABASE (round 17), at BOTH doors (round 18)
    SELECT COUNT(*) INTO v_options FROM "DecisionOption" WHERE "decisionId" = NEW.id;
    IF NEW."deciderKind"::text = 'none' THEN
      IF v_options <> 0 THEN
        RAISE EXCEPTION 'phase6-4b: a recorded issue carries no options (% has %).', NEW.id, v_options;
      END IF;
    ELSIF v_options < 2 THEN
      RAISE EXCEPTION 'phase6-4b: a decision needs at least two options to publish (% has %).', NEW.id, v_options;
    END IF;

    -- the holder must EXIST at publication (rounds 4/10), read through the orgs-owned primitive
    -- under the try-acquire protocol
    IF NEW."deciderKind"::text = 'member' THEN
      PERFORM t4b_require_readiness_key(NEW."projectId", 'publishing a member-held decision');
      IF NOT orgs_membership_is_active(NEW."projectId", NEW."deciderMembershipId") THEN
        RAISE EXCEPTION 'phase6-4b: the named decider is not an active member of this project (%) — edit the draft''s holder.', NEW.id;
      END IF;
    ELSIF NEW."deciderKind"::text IN ('client', 'pmc') THEN
      PERFORM t4b_require_readiness_key(NEW."projectId", 'publishing a role-held decision');
      IF orgs_effective_role_standing(NEW."projectId", NEW."deciderKind"::text) = 0 THEN
        RAISE EXCEPTION 'phase6-4b: this project has no active % to decide (%) — publishing would birth a holderless decision.', NEW."deciderKind"::text, NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_publication_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b_publication_seal"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_publication_seal();

/**
 * `recorded` is TERMINAL — in BOTH verbs and its EVIDENCE (rounds 1/2/6/11/12/15/18/19).
 *
 *   • EXIT: refused for a PUBLISHED row, with exactly ONE unpublished door — while
 *     `publishedAt IS NULL`, `decisions.updateDraft` may change kind and status together as one
 *     coherent pair (either alone is already refused by the kind⟺status CHECK).
 *   • ENTRY: refused for every PUBLISHED transition INTO `recorded` — guarding only exits leaves
 *     one hostile statement able to turn a published `approved` decision into a "record" that
 *     still carries its immutable approval revision and approved event children: an unapprovable
 *     permanent entry BORN FROM an approval.
 *   • The unpublished conversion is APPROVAL-CLEAN and CLAIM-CLEAN: zero approval children, zero
 *     ChangeRequest children (a planted request would survive as a hidden, unclosable claim that
 *     neither requestChange nor withdrawChange can ever close, the head being terminal).
 *   • The published record's question and option EVIDENCE is frozen (a permanent register entry
 *     whose content can be rewritten is not permanent).
 *   • A record's `authorId` is validated through the orgs-owned authority primitive: a terminal
 *     row is BORN permanent with no later act to catch a forged author.
 */
CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_changes   INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'recorded' THEN
      PERFORM t4b_require_readiness_key(NEW."projectId", 'filing a recorded issue');
      IF NOT orgs_user_decision_authority(NEW."projectId", NEW."authorId") THEN
        RAISE EXCEPTION 'phase6-4b: a recorded issue must be filed by a user with decision authority on an operable project (%).', NEW.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- EXIT from recorded
  IF OLD.status::text = 'recorded' AND NEW.status::text <> 'recorded' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published recorded issue is permanent (%) — it has no transition out.', OLD.id;
    END IF;
    -- the ONE unpublished door: kind and status move together (the CHECK enforces the pairing)
    IF NEW."deciderKind"::text = 'none' THEN
      RAISE EXCEPTION 'phase6-4b: converting a draft record must re-point its decider in the same update (%).', OLD.id;
    END IF;
  END IF;

  -- ENTRY into recorded
  IF OLD.status::text <> 'recorded' AND NEW.status::text = 'recorded' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot become a record (%) — a record is born, never converted.', OLD.id;
    END IF;
    -- approval-clean AND claim-clean at the moment of conversion
    SELECT COUNT(*) INTO v_approvals FROM "DecisionApprovalRevision" WHERE "decisionId" = OLD.id;
    IF v_approvals > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying approval evidence cannot become a record (%).', OLD.id;
    END IF;
    SELECT COUNT(*) INTO v_changes FROM "ChangeRequest" WHERE "decisionId" = OLD.id;
    IF v_changes > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying a change request cannot become a record (%) — the record would hold an unclosable claim.', OLD.id;
    END IF;
  END IF;

  -- the PUBLISHED record's evidence freeze
  IF OLD.status::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
    IF NEW.title <> OLD.title OR NEW.room <> OLD.room
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
       OR NEW."photoSwatch" <> OLD."photoSwatch" THEN
      RAISE EXCEPTION 'phase6-4b: the content of a published record is frozen (%).', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_recorded_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b_recorded_seal"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_recorded_seal();

/**
 * The REOPEN path re-validates the holder AT THE DATABASE (rounds 8/18).
 *
 * The removal guard cannot see an `approved` decision, so its member holder may legally leave
 * while it is closed. `requestChange` re-validates under the readiness lock — but a service check
 * binds only the product path: a direct transaction can flip the head to `change` and insert its
 * open ChangeRequest without touching the frozen holder or any membership row, and the published
 * decision becomes openly holderless. The same transition is therefore sealed here.
 */
CREATE OR REPLACE FUNCTION decision_t4b_reopen_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text = 'approved' AND NEW.status::text = 'change' AND NEW."publishedAt" IS NOT NULL THEN
    PERFORM t4b_require_readiness_key(NEW."projectId", 'reopening an approved decision');
    IF NEW."deciderKind"::text = 'member' THEN
      IF NOT orgs_membership_is_active(NEW."projectId", NEW."deciderMembershipId") THEN
        RAISE EXCEPTION 'phase6-4b: the decider of % has left the project — the approved outcome stands; a changed need is a NEW decision (re-homing arrives with 4d).', NEW.id;
      END IF;
    ELSIF NEW."deciderKind"::text IN ('client', 'pmc') THEN
      IF orgs_effective_role_standing(NEW."projectId", NEW."deciderKind"::text) = 0 THEN
        RAISE EXCEPTION 'phase6-4b: this project has no active % to decide % — the approved outcome stands.', NEW."deciderKind"::text, NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_reopen_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b_reopen_seal"
  BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_reopen_seal();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 — the option floor SURVIVES publication (round 19)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Counting only AT publication left a later direct DELETE of a published pending decision's two
-- options unrefused: the 4a child trigger guards only `withdrawn` parents, and no head transition
-- fires the publication trigger — stranding a published decision with no approvable option.
--
-- Once `publishedAt` is set, a decision's options admit no INSERT, DELETE or UPDATE. Re-pointing
-- is judged against BOTH the old and the new parent. No product path edits options after
-- publication, so the seal costs nothing legal.

CREATE OR REPLACE FUNCTION decision_option_t4b_published_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_published TIMESTAMP(3);
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "publishedAt" INTO v_published FROM "Decision" WHERE id = NEW."decisionId";
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: the options of a published decision are frozen (%).', NEW."decisionId";
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "publishedAt" INTO v_published FROM "Decision" WHERE id = OLD."decisionId";
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: the options of a published decision are frozen (%).', OLD."decisionId";
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_t4b_published_frozen" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_t4b_published_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION decision_option_t4b_published_frozen();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 7 — ChangeRequest: no claim on a record, and no re-pointing (rounds 18/19)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- `ChangeRequest.decisionId` is freely updatable in the base schema, so hostile SQL could
-- RE-POINT a legitimate open request from its `change` decision onto an already-published record
-- — no INSERT, no head transition, so neither the conversion check nor an INSERT-only reverse
-- seal would fire — stranding the source decision's required request while the permanent record
-- gained a hidden, unclosable claim. A child's PARENT IDENTITY joins the identity-freeze class.

CREATE OR REPLACE FUNCTION change_request_t4b_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."decisionId" <> OLD."decisionId" THEN
    RAISE EXCEPTION 'phase6-4b: a change request belongs to the decision it was raised on (%) — it is never re-pointed.', OLD.id;
  END IF;
  SELECT status::text INTO v_status FROM "Decision" WHERE id = NEW."decisionId";
  IF v_status = 'recorded' THEN
    RAISE EXCEPTION 'phase6-4b: a recorded issue cannot carry a change request (%) — nobody can close it.', NEW."decisionId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4b_seal" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4b_seal"
  BEFORE INSERT OR UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION change_request_t4b_seal();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 — the orgs-side seals: the standing-derivation chain (rounds 5/11/12/13/19)
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- THE IDENTITY-FREEZE CLASS, stated once (round 13): every IDENTITY column of every row in the
-- STANDING-DERIVATION CHAIN — Membership.userId/projectId, OrgMembership.userId/orgId, and
-- Project.orgId (the link selecting WHICH org's owner/admin rows provide effective-PMC standing
-- at all) — is FROZEN. Re-homing ANY link is a REMOVAL plus an ADDITION, each judged under the
-- affected project's readiness key, never a single UPDATE. A future column joining the chain
-- joins the freeze by construction.
--
-- THE HOLDER-ORPHAN GUARD: removing (or demoting, or DELETING) a membership that is the holder
-- of a PUBLISHED OPEN decision is refused — for BOTH designations, at BOTH layers. And the
-- ACTIVATION arm judges standing DISPLACEMENT, not merely loss-by-removal (round 19): upserting
-- an ACTIVE `client` membership for a membership-less org admin who is the sole effective PMC is
-- neither a removal nor a demotion, yet precedence instantly re-classifies them and the PMC
-- holder is gone.

CREATE OR REPLACE FUNCTION membership_t4b_holder_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_role_after      TEXT;
  v_standing_left   INT;
  v_departing       TEXT;
  v_displaced       TEXT;
BEGIN
  -- ── the identity freeze ──────────────────────────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" <> OLD."userId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its user (%) — a new person is a NEW membership.', OLD.id;
    END IF;
    IF NEW."projectId" <> OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its project (%) — a move is a removal plus an addition.', OLD.id;
    END IF;
  END IF;

  -- ── ACTIVATION / INSERT: does this displace standing another decision depends on? ────────
  IF (TG_OP = 'INSERT' AND NEW.status = 'active')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status <> 'active') THEN
    PERFORM t4b_require_readiness_key(NEW."projectId", 'activating a membership');
    -- an explicit ACTIVE membership takes precedence over org standing, so activating a
    -- NON-pmc membership for a user who was covering `pmc` through org owner/admin standing
    -- REMOVES that pmc standing.
    IF NEW.role <> 'pmc' THEN
      SELECT 'pmc' INTO v_displaced
      WHERE EXISTS (
        SELECT 1 FROM "OrgMembership" om
        JOIN "Project" p ON p."orgId" = om."orgId"
        WHERE p.id = NEW."projectId" AND om."userId" = NEW."userId" AND om.role IN ('owner', 'admin')
      );
      IF v_displaced IS NOT NULL
         AND orgs_effective_role_standing(NEW."projectId", 'pmc') <= 1
         AND decisions_open_decision_names_holder(NEW."projectId", NULL, 'pmc') THEN
        RAISE EXCEPTION 'phase6-4b: activating this membership would remove the last effective pmc from a published open decision on % — cover the decision first.', NEW."projectId";
      END IF;
    END IF;
  END IF;

  -- ── REMOVAL / ROLE CHANGE / DELETE: does an open decision still name this holder? ────────
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW.status <> 'active' OR NEW.role <> OLD.role)) THEN
    IF (TG_OP = 'DELETE' AND OLD.status = 'active') OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
      PERFORM t4b_require_readiness_key(OLD."projectId", 'removing or re-roling a membership');
      v_role_after := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.role END;
      -- the role this write REMOVES standing from (NULL when the role is unchanged and active)
      v_departing := CASE WHEN v_role_after IS DISTINCT FROM OLD.role OR TG_OP = 'DELETE'
                          OR (TG_OP = 'UPDATE' AND NEW.status <> 'active')
                     THEN OLD.role ELSE NULL END;
      -- how much standing in the departing role SURVIVES this write?
      SELECT orgs_effective_role_standing(OLD."projectId", OLD.role)
             - CASE WHEN v_departing IS NOT NULL THEN 1 ELSE 0 END
        INTO v_standing_left;
      IF decisions_open_decision_names_holder(
           OLD."projectId", OLD.id,
           CASE WHEN v_standing_left <= 0 THEN v_departing ELSE NULL END
         ) THEN
        RAISE EXCEPTION 'phase6-4b: this membership holds a published open decision on % — withdraw-and-reissue it first (re-homing arrives with 4d forwarding).', OLD."projectId";
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS "Membership_t4b_holder_seal" ON "Membership";
CREATE TRIGGER "Membership_t4b_holder_seal"
  BEFORE INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION membership_t4b_holder_seal();

/**
 * The ORG-membership writes flip membership-less effective-PMC standing WITHOUT touching
 * `Membership` at all (round 11), and `OrgMembership.orgId` is FROZEN (round 12) so the
 * one-statement hostile move of the sole effective PMC's org-membership to another org — role
 * untouched, no named guard arm re-judging the old org — is unrepresentable.
 */
CREATE OR REPLACE FUNCTION org_membership_t4b_holder_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" <> OLD."userId" THEN
      RAISE EXCEPTION 'phase6-4b: an org membership is born bound to its user (%).', OLD.id;
    END IF;
    IF NEW."orgId" <> OLD."orgId" THEN
      RAISE EXCEPTION 'phase6-4b: an org membership is born bound to its org (%) — a move is a removal plus an addition.', OLD.id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.role <> OLD.role AND OLD.role IN ('owner', 'admin')) THEN
    -- judged PER AFFECTED PROJECT, in stable ascending id order (round 13 — two concurrent org
    -- role changes locking P1/P2 in opposite orders would deadlock on the blocking service path)
    FOR r IN
      SELECT p.id AS project_id FROM "Project" p WHERE p."orgId" = OLD."orgId" ORDER BY p.id
    LOOP
      PERFORM t4b_require_readiness_key(r.project_id, 'changing org membership');
      IF orgs_effective_role_standing(r.project_id, 'pmc') <= 1
         AND decisions_open_decision_names_holder(r.project_id, NULL, 'pmc') THEN
        RAISE EXCEPTION 'phase6-4b: this org write would remove the last effective pmc from a published open decision on % — cover the decision first.', r.project_id;
      END IF;
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS "OrgMembership_t4b_holder_seal" ON "OrgMembership";
CREATE TRIGGER "OrgMembership_t4b_holder_seal"
  BEFORE UPDATE OR DELETE ON "OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION org_membership_t4b_holder_seal();

/** `Project.orgId` selects WHICH org's owner/admin rows provide effective-PMC standing at all —
 *  the last link of the standing-derivation chain, frozen with the rest of the class. */
CREATE OR REPLACE FUNCTION project_t4b_org_freeze() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION 'phase6-4b: a project is born in its org (%) — re-homing it would silently re-derive every effective-PMC standing.', OLD.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Project_t4b_org_freeze" ON "Project";
CREATE TRIGGER "Project_t4b_org_freeze"
  BEFORE UPDATE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION project_t4b_org_freeze();
