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

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- SEAL SLICE — the CHECKs, the two owned ORGS primitives, and the seal network. Every probe above
-- ran RED against the shape; this slice is what turns them green.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── §B.2: two NEW owned SQL primitives, ORGS-owned ────────────────────────────────────────────
-- Cross-module facts reach a seal through an OWNED primitive, never a raw join invented per-seal.
-- The delivered inventory cannot express what 4c needs: `phase6_membership_is_active` returns only
-- a boolean, so it can neither lock the membership row nor return the `userId` the response seal
-- must compare, and nothing exposes a LOCKABLE project-operability check. Following the old
-- inventory would force these decisions-owned triggers to read `Membership`/`Project` directly —
-- the exact cross-module raw read the primitives exist to prevent.
--
-- ORGS, not a "projects" module: there is no `projects` module in the registry — `orgs` owns
-- `project`, and the lock-bearing `isProjectOperable` is already an `OrgsParticipant` method. These
-- are the DB-side twins of that participant, on the already-declared decisions → orgs edge.

-- Takes the membership row's lock, then returns its `userId` when ACTIVE and NULL otherwise — so a
-- seal establishes standing and reads the identity in ONE owned call. Identity itself is frozen by
-- the delivered `Membership_t4b_identity_frozen`, so this is not a re-key defence; what it
-- serializes against is the ACTIVE→removed transition, which is a live state change, and splitting
-- it into a boolean check plus a separate read would leave a window between them.
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

-- Takes the `Project` row's lock BEFORE reading `archivedAt`, so the seals' lock-before-read
-- ordering is the primitive's own contract rather than each trigger's private SQL. A seal that
-- merely READ the column could see the project operable, lose the race to a committing archive,
-- and still commit its immutable row.
CREATE OR REPLACE FUNCTION phase6_project_operable(p_project TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_archived TIMESTAMP(3);
BEGIN
  SELECT "archivedAt" INTO v_archived FROM "Project" WHERE "id" = p_project FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN v_archived IS NULL;
END $$;

-- ── the evidence CHECKs ───────────────────────────────────────────────────────────────────────
-- NOT NULL and non-blank are TWO obligations, not one: a CHECK over NULL evaluates to UNKNOWN and
-- PASSES, so the btrim guard alone would let a direct insert commit append-only evidence with no
-- text at all. The columns are NOT NULL in the shape slice; these close the whitespace-only door.
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_question_present_check"
    CHECK (btrim("question", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_response_present_check"
    CHECK (btrim("response", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the §C rule-ii provenance seal, shared by both tables ─────────────────────────────────────
-- Every accepted write must be one the projection can see. An eventless alternate write is
-- precisely what `decisions.inbox` would never observe, so each row is bound to a command receipt
-- the ledger already governs: RESERVED right now (not a terminal receipt borrowed after the fact),
-- of the RIGHT command type, and attributed to the SAME actor the row records — otherwise a
-- genuine receipt reserved by one PMC could attribute an immutable row to another.
-- One-use is the `(projectId, sourceCommandId)` UNIQUE in the shape slice.
CREATE OR REPLACE FUNCTION phase6_t4c_provenance_reserved(
  p_project TEXT, p_command TEXT, p_type TEXT, p_actor TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
DECLARE c RECORD;
BEGIN
  SELECT "status", "commandType", "actorId" INTO c FROM "CommandExecution"
   WHERE "projectId" = p_project AND "id" = p_command FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: no command receipt % in this project backs row % — an eventless write is invisible to the projection', p_command, p_row;
  END IF;
  IF c."status" <> 'reserved' THEN
    RAISE EXCEPTION 'phase6-4c: the cited receipt is not the RESERVED command currently executing (status %) — a terminal receipt cannot be borrowed to back row %', c."status", p_row;
  END IF;
  IF c."commandType" <> p_type THEN
    RAISE EXCEPTION 'phase6-4c: the cited receipt is a % command, not % — row % must be the product of its own command', c."commandType", p_type, p_row;
  END IF;
  IF c."actorId" IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'phase6-4c: the cited receipt was reserved by a different actor than row % records — attribution may not be borrowed', p_row;
  END IF;
END $$;

-- The DEFERRED half: the receipt must have SUCCEEDED **at commit**, naming THIS row. A
-- reserved-only test is not enough — the delivered receipt protocol permits a `reserved` INSERT
-- and validates completion only if an UPDATE occurs, so an alternate writer could insert a
-- reserved receipt and a row citing it in ONE transaction and commit, never running the command.
-- Checking at commit is exactly when `executeCommand` writes its succeeded receipt.
CREATE OR REPLACE FUNCTION phase6_t4c_provenance_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  SELECT "status", "resultRef" INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION 'phase6-4c: row % cites a command that did not succeed in this transaction — the receipt must be completed by the command that wrote the row', NEW."id";
  END IF;
  IF c."resultRef" IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION 'phase6-4c: the cited command''s result names %, not row % — a receipt for another result cannot be borrowed', COALESCE(c."resultRef", '<null>'), NEW."id";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_provenance_bound" ON "DecisionConsultation";
CREATE CONSTRAINT TRIGGER "DecisionConsultation_t4c_provenance_bound"
  AFTER INSERT ON "DecisionConsultation"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_provenance_bound();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_provenance_bound" ON "DecisionConsultationResponse";
CREATE CONSTRAINT TRIGGER "DecisionConsultationResponse_t4c_provenance_bound"
  AFTER INSERT ON "DecisionConsultationResponse"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_provenance_bound();

-- ── the REQUEST INSERT seal ───────────────────────────────────────────────────────────────────
-- The append-only consultation row is the durable fact that WIDENS visibility, so a direct INSERT
-- bypassing the locked command path would grant standing sight of an ineligible decision — a
-- withdrawn row's pmc-only title and reason leaking to a fabricated consultee.
--
-- ONE CANONICAL LOCK ORDER for the whole 4c surface: readiness key → Project → Membership →
-- Decision. Not decision-first: `decisions.approve` takes the readiness key, then the named
-- decider's MEMBERSHIP, and only then updates the DECISION — so a 4c path holding `Decision` and
-- waiting on `Membership` would deadlock against it whenever the consultee IS the decider, which
-- is an ordinary case (the person best placed to advise is often the one deciding).
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_request_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  -- §B.1 try-acquire-or-refuse: reentrant on the service path (the command already holds the
  -- key), acquired and held to commit on a free direct write, REFUSED when contended — a seal
  -- never waits inside a trigger, so no lock-order inversion can exist.
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct consultation write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no consultation may be recorded against it', NEW."projectId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", NEW."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is not ACTIVE on this project — a request for a removed member would become answerable if they were ever restored (%)', NEW."id";
  END IF;
  -- the WRONG-AUDIENCE forgery: `consulteeUserId` is the projection's REBUILDABLE audience, so an
  -- arbitrary user there would mint a projected slice — and a widened view — for a stranger.
  IF NEW."consulteeUserId" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: the recorded audience is not the user this membership resolves to — the canonical audience may not be forged (%)', NEW."id";
  END IF;
  -- the contract's actor-standing obligation, applied to this fact's RECORDED actor
  IF NOT phase6_user_decision_authority(NEW."projectId", NEW."requestedById") THEN
    RAISE EXCEPTION 'phase6-4c: the recorded requester holds no active authority to ask for advice on this project (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: decision % is not in this project', NEW."decisionId";
  END IF;
  -- eligibility: PUBLISHED (status alone admits an author-private draft whose status is
  -- `pending`) and still OPEN. Never `withdrawn` (whose title and reason are pmc-only — a
  -- consultation there leaks exactly what 4a hides), `approved` or `recorded` (nothing to inform).
  IF d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change') THEN
    RAISE EXCEPTION 'phase6-4c: a consultation belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- the INITIAL cycle is SEALED, not merely compared later: a command bug storing `current + 1`
  -- would mint a consultation unanswerable now that becomes answerable after ONE approve-and-
  -- reopen — the exact revival this column exists to prevent, arriving through a legitimate writer.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId";
  IF NEW."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: the frozen open cycle % is not the decision''s current approval count % — a consultation is born in the cycle it was asked in', NEW."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.request', NEW."requestedById", NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_request_seal" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_request_seal"
  BEFORE INSERT ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_request_seal();

-- ── the RESPONSE INSERT seal ──────────────────────────────────────────────────────────────────
-- The request-side seal's twin, at the response's own moment. A request made while `pending`
-- outlives the decision, so eligibility is re-judged here: a stale answer would append immutable
-- advice against a row the consultee must no longer see.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_response_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct response write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no advice may be recorded against it', NEW."projectId";
  END IF;

  SELECT "consulteeMembershipId", "openCycle", "decisionId" INTO c FROM "DecisionConsultation"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."consultationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: no consultation % in this project', NEW."consultationId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", c."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is no longer ACTIVE — a removed member cannot append immutable advice (%)', NEW."id";
  END IF;
  -- without a recorded actor compared against the named consultee, a raw writer could forge advice
  -- presented forever as the member's own
  IF NEW."respondedById" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: only the named consultee may be recorded as the responder (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND OR d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change') THEN
    RAISE EXCEPTION 'phase6-4c: advice belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- eligibility is not a STATUS test alone. Approve then `requestChange` returns the decision to
  -- an open status while the append-only consultation row remains by design; a status-only guard
  -- would REVIVE a consultation the approval already closed and mix two decision cycles in one
  -- immutable thread. Asking again in the new cycle means a NEW consultation.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId";
  IF c."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: this consultation belongs to cycle %, and the decision is now in cycle % — an approval permanently closes the consultations of the cycle it ended', c."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.respond', NEW."respondedById", NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_response_seal" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_response_seal"
  BEFORE INSERT ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_response_seal();

-- ── append-only: UPDATE, DELETE, and TRUNCATE ─────────────────────────────────────────────────
-- Row triggers never fire for TRUNCATE, so a row-level seal alone would leave
-- `TRUNCATE "DecisionConsultationResponse"` free to erase every immutable answer — and
-- `TRUNCATE "DecisionConsultation" CASCADE` the whole register — while the decisions stand.
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase6-4c: % is append-only evidence — a recorded consultation is never rewritten or removed (%)', TG_TABLE_NAME, COALESCE(OLD."id", '<row>');
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_append_only" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_append_only();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_append_only" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_consultation_append_only();

CREATE OR REPLACE FUNCTION phase6_t4c_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase6-4c: TRUNCATE would erase append-only evidence from % — row triggers do not fire for TRUNCATE, which is why this statement-level seal exists', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4c_no_truncate" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4c_no_truncate"
  BEFORE TRUNCATE ON "DecisionConsultation"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_no_truncate();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4c_no_truncate" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4c_no_truncate"
  BEFORE TRUNCATE ON "DecisionConsultationResponse"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_no_truncate();

-- Sealing a fact append-only is INCOMPLETE until the tables its predicates COUNT are sealed at the
-- statement level too. 4c makes the approval-revision COUNT trusted cycle evidence, so
-- `TRUNCATE "DecisionApprovalRevision" CASCADE` would return the count to 0 and make a stale
-- cycle-0 consultation answerable in a reopened cycle — the revival `openCycle` exists to prevent,
-- reached by ERASING the evidence rather than forging it. The sanctioned reset disables this
-- trigger by name (prisma/sanctioned-reset.ts), which is the whole reset contract.
DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4c_no_truncate" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4c_no_truncate"
  BEFORE TRUNCATE ON "DecisionApprovalRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_no_truncate();
