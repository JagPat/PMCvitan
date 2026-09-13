-- Phase 6 task 4d, unit 4d-i — THE DARK MIGRATION, PART TWO: THE DECISIONS-OWNED FACTS
-- (docs/superpowers/plans/2026-09-07-decision-workflow-4d.md §A and §D).
--
-- THE SECOND HALF OF THE SPLIT. `20271220000000_phase6_t4d_i_dark_migration` installs the
-- retirement marker, the three shared helpers, the platform registers, the orgs membership fact
-- and the WHOLE platform kernel — envelope, allocator, notice binding and pairing mechanism, none
-- of it divided; this file installs the decisions half and DEPENDS ON ALL OF IT. The dependency
-- runs one way only, which is what made the seam a seam: nothing in the first file names a table
-- created here, while the seals here read the registers, call the shared helpers and claim
-- pairings through the kernel.
--
-- It is therefore ordered immediately after its partner and is not independently appliable —
-- exactly as a stacked review unit should be. Both files are re-runnable against an
-- already-migrated database, measured rather than assumed, which is what the `ALWAYS_EXECUTE`
-- baseline path and the harness's repaired re-applies rest on.
--
-- WHAT IS HERE: the enum values for the chain's own states, the doors that reserve those states
-- and the forward fact, the three decisions-owned fact tables with their seven obligation seals,
-- the existing-table columns those seals read (on `ChangeRequest`, `DecisionApprovalRevision`,
-- the two consultation tables and the two requirement-spec tables) with the audit that refuses a
-- pre-baseline row already in a 4d-only shape, the decisions-owned `DecisionEvent` audit
-- register's append-only and correspondence seals, the delivered 4b and 4c seals widened with
-- their architect arms, and the approval register's finality key.
--
-- MIGRATION-ONLY and DARK, on the same terms as its partner: no service, controller, query,
-- emitter, participant or UI change rides with it. 4d-ii carries the application half.
--
-- ENUM VALUES ADDED HERE ARE NEVER CONSUMED HERE. `ALTER TYPE … ADD VALUE` inside a transaction
-- leaves the value unusable until commit, so every comparison against `architect` and
-- `awaiting_countersign` in this file is made on `::text` — the way 20271015 added `recorded`.
-- That is also why the doors below can be created BEFORE the values they name exist: a trigger's
-- body is not evaluated until a row is written.
--
-- RE-RUNNABLE AND MARKER-AWARE, on the same terms as its partner.

BEGIN;

-- ── THE ACQUISITION IS ALL-OR-NOTHING, NOT ORDERED (#582's review rounds 35/36) ──────────────
-- Round 35 read this as a question of ORDER and got the order wrong, in a way worth stating
-- plainly because the correction is the rule: it put `Membership` first, having found
-- `hasProjectRoleStanding(..., { forUpdate: true })` by name and inferred a serving order from
-- that ONE call. The serving paths actually lock the other way — `decisions.publish` and
-- `decisions.updateDraft` both take the readiness key, then `"Decision" … FOR UPDATE`
-- (decisions.service.ts), and only afterwards a `Membership` row — so round 35's list was the
-- inversion it was written to remove, and PostgreSQL's deadlock detector kills the USER's
-- command, not the deploy.
--
-- AND ORDERING IS THE WRONG INSTRUMENT ANYWAY. An ordered list is a standing claim about every
-- serving path in the codebase, now and in future; it is re-falsified by the next command that
-- locks these two tables the other way, and nothing in the file would notice. Round 35 also
-- asserted that one comma-separated statement "removes the window between them". It does not:
-- `LOCK TABLE a, b` acquires the relations ONE AT A TIME, which is #582's own round-8 finding 1
-- — the finding round 35 cited by number in this very comment while implementing the weaker
-- thing it was written to replace.
--
-- So the acquisition is the shape that finding established, and 20271015's four-table window
-- already uses: `NOWAIT` inside a subtransaction, so a partial set is RELEASED by the exception
-- rollback, retried with a short sleep, and after the cap the migration FAILS CLOSED — clean and
-- re-runnable. This transaction is then NEVER A WAITING PARTY on these tables, and a deadlock
-- cycle needs one; no claim about anyone else's lock order is required, so none is made.
--
-- The list is every PRE-EXISTING table this half takes a lock on. Tables this transaction
-- CREATES cannot be locked before they exist and cannot contend with anyone. The mode is the one
-- the DDL below takes anyway, so this changes WHEN, never WHAT.
DO $t4d_window$
DECLARE attempts INT := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "Membership",
                 "Decision",
                 "ChangeRequest",
                 "DecisionApprovalRevision",
                 "DecisionEvent",
                 "DecisionConsultation",
                 "DecisionConsultationResponse",
                 "MaterialRequirementSpec",
                 "LabourRequirementSpec"
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 600 THEN
        RAISE EXCEPTION 'phase6 4d-i (decisions half): could not obtain the deployment window on the nine pre-existing tables after % attempts — retry the deploy when writer traffic quiets. Nothing has been changed. See docs/RUNBOOK.md §P6T4D.', attempts;
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
END $t4d_window$;

-- ── THE RETIREMENT SNAPSHOT, TAKEN AGAIN ─────────────────────────────────────────────────────
-- #582's review round 16, finding 2 — A REGRESSION THE SPLIT INTRODUCED, and the one gate every
-- proof of the split missed.
--
-- `phase6_t4d_retired_at_start()` reads a setting the FIRST file establishes with
-- `set_config(..., is_local => true)`. That is transaction-LOCAL, and the two halves are two
-- Prisma migrations and therefore two transactions: the setting is discarded when the first one
-- commits, and before this block existed nothing set it again. So the predicate was silently
-- FALSE for all eight of its readers in this file — and false is the "not retired yet" answer.
--
-- On a fresh install that is the right answer by accident, which is exactly why it survived: every
-- apply I measured was of a fresh or once-migrated database. The path it breaks is the mature
-- `ALWAYS_EXECUTE` REPLAY of a database that has genuinely run 4d-iii, where the marker means
-- "leave it alone" — and where a false predicate instead REINSTALLS the Decision reservation
-- doors on a live chain, DOWNGRADES the consultation and correspondence seals from 4d-iii's
-- bodies back to these weaker ones, and ABORTS the dark-table audit on fact tables 4d-ii
-- legitimately filled.
--
-- Proving "both files apply" was a PROJECTION of proving the split correct. Applying is one
-- dimension; the marker-aware replay is a second, and it had no arm until this round added one.
--
-- AND THE VERDICT RESTS ON *THIS* FILE'S OWN EVIDENCE, not on `phase6_t4d_retired()`.
-- Round 7's fix made the retirement predicate name an artifact 4d-i creates, so that a FORGED
-- marker on a db-push baseline reads as false until the real unit has run. That works while the
-- verdict is taken before the artifact exists — which is true of the registers half, and false
-- here: by the time this transaction starts, the registers half has COMMITTED
-- `phase6_t4d_membership_transition_seal`, so `phase6_t4d_retired()` would call a forged marker
-- genuine and this whole file would skip. (Measured: the harness's forged-marker arm went red on
-- exactly that, expecting four doors and finding one.)
--
-- The answer is round 7's own design applied PER FILE: this half's verdict names an artifact THIS
-- half creates — `phase6_t4d_forward_seal`, a few hundred lines below — and is taken here, before
-- it exists. Forged marker, no such function: false, and every door installs. Genuinely retired
-- database: both halves' artifacts are present, and both halves skip.
DO $snapshot$
BEGIN
  PERFORM set_config('vitan.phase6_4d_retired_at_start',
                     CASE WHEN EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d')
                           AND to_regproc('phase6_t4d_forward_seal') IS NOT NULL
                          THEN 'on' ELSE 'off' END, true);
END $snapshot$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE CHAIN'S OWN RESERVATION DOORS (TRANSIENT)
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The architect chain's `deciderKind` and `awaiting_countersign` state are RESERVED between this
-- migration and 4d-iii: the enum values exist so the schema is deployable, and these doors make
-- them unreachable so no row can be written into a state whose seals are not installed yet. They
-- are TEXT-judged, so they can be created before Part 2 adds the values they name.
--
-- The refusal function they share, `phase6_t4d_reserved`, is defined by the FIRST file — one
-- message, one place to change it, and a single object for 4d-iii to drop. The doors reserving
-- architect STANDING (Membership, User) live there too, beside the registers they protect.


DO $$
DECLARE v_bad TEXT;
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RETURN;
  END IF;

  -- `deciderKind = 'architect'` is unreachable until the designation's seals exist. Judged on
  -- ::text because Part 2 has not committed the enum value yet.
  -- Adopted through the one question `phase6_t4d_trigger_mismatch` asks (#582's review round 34):
  -- `tgtype` says nothing about the WHEN clause or an `UPDATE OF` column restriction, and a door
  -- narrowed either way is tgtype 23 and open.
  v_bad := phase6_t4d_trigger_mismatch('Decision_t4d_architect_reserved', 'Decision',
    $def$CREATE TRIGGER "Decision_t4d_architect_reserved" BEFORE INSERT OR UPDATE ON public."Decision" FOR EACH ROW WHEN (((new."deciderKind")::text = 'architect'::text)) EXECUTE FUNCTION phase6_t4d_reserved('Decision.deciderKind = architect')$def$);
  IF v_bad = 'ABSENT' THEN
    CREATE TRIGGER "Decision_t4d_architect_reserved" BEFORE INSERT OR UPDATE ON "Decision"
      FOR EACH ROW WHEN (NEW."deciderKind"::text = 'architect')
      EXECUTE FUNCTION phase6_t4d_reserved('Decision.deciderKind = architect');
  ELSIF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: %s %s See docs/RUNBOOK.md §P6T4D.',
      'Decision_t4d_architect_reserved does not reserve the designation:', v_bad;
  END IF;

  -- `status = 'awaiting_countersign'` is unreachable until the chain's seals exist.
  v_bad := phase6_t4d_trigger_mismatch('Decision_t4d_awaiting_reserved', 'Decision',
    $def$CREATE TRIGGER "Decision_t4d_awaiting_reserved" BEFORE INSERT OR UPDATE ON public."Decision" FOR EACH ROW WHEN (((new.status)::text = 'awaiting_countersign'::text)) EXECUTE FUNCTION phase6_t4d_reserved('Decision.status = awaiting_countersign')$def$);
  IF v_bad = 'ABSENT' THEN
    CREATE TRIGGER "Decision_t4d_awaiting_reserved" BEFORE INSERT OR UPDATE ON "Decision"
      FOR EACH ROW WHEN (NEW."status"::text = 'awaiting_countersign')
      EXECUTE FUNCTION phase6_t4d_reserved('Decision.status = awaiting_countersign');
  ELSIF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: %s %s See docs/RUNBOOK.md §P6T4D.',
      'Decision_t4d_awaiting_reserved does not reserve the chain state:', v_bad;
  END IF;
END $$;

-- ── and the AUDIT the doors owe: nothing may ALREADY hold a reserved value ───────────────────
-- #582's review round 16, findings 1 and 5, which are ONE rule stated at two tables:
--
--   A DOOR THAT RESERVES A VALUE IS HALF AN ANSWER. It judges NEW and UPDATED rows; it cannot see
--   a row that already holds the value. The other half is a diagnostic-first AUDIT that refuses
--   the apply while one exists — and the registers half has carried exactly that for
--   `Membership.role` and `User.role` since round 1. `Decision` and `DecisionEvent.type` never
--   got it, and round 15's own new kind door shipped protecting future inserts only, which is the
--   same omission made one round after the rule was restated.
--
-- The exposure is the supported `db push` / P3005 baseline. `DeciderKind` and `DecisionStatus`
-- carry the widened values from `schema.prisma` there, and `DecisionEvent.type` is an
-- unconstrained TEXT column, so all three can already hold a reserved value before any raw
-- trigger exists. What each adopted row then means:
--
--   · `Decision.status = 'awaiting_countersign'` — a decision waiting for a countersign with no
--     provisional revision to countersign and no `DecisionCountersign` fact to produce.
--     `phase6_t4d_provisional_head` finds no head, so neither the countersign nor the stranded
--     resolution can resolve it: unfinalizable by construction.
--   · `Decision.deciderKind = 'architect'` — a decision held by a designation whose standing
--     register is empty, so it has no holder any surface can resolve.
--   · `DecisionEvent.type` in the four 4d-only kinds — evidence of an act whose command does not
--     exist, which `DecisionEvent_t4d_append_only` then makes permanent and which 4d-iii's
--     stronger INSERT correspondence can never examine, because it judges only NEW rows.
--
-- DIAGNOSTIC-FIRST and BOUNDED, like its siblings: the doors above are already installed (and
-- with them the locks), so this counts a settled table, names up to ten of each, and aborts.
-- Gated on the retirement snapshot, because after 4d-iii every one of these values is legitimate.
DO $reserved_rows$
DECLARE
  v_awaiting BIGINT; v_architect BIGINT; v_kinds BIGINT;
  v_sample TEXT; v_found TEXT := '';
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the reserved-value audit is SKIPPED (these values are legitimate after 4d-iii)';
    RETURN;
  END IF;

  SELECT count(*) INTO v_awaiting FROM "Decision" WHERE "status"::text = 'awaiting_countersign';
  IF v_awaiting > 0 THEN
    SELECT string_agg(q.id, ', ') INTO v_sample FROM (
      SELECT "id" AS id FROM "Decision" WHERE "status"::text = 'awaiting_countersign' ORDER BY "id" LIMIT 10) q;
    v_found := v_found || format('%s"Decision"."status" = awaiting_countersign: %s row(s) [%s]',
                                 CASE WHEN v_found = '' THEN '' ELSE '; ' END, v_awaiting, v_sample);
  END IF;

  SELECT count(*) INTO v_architect FROM "Decision" WHERE "deciderKind"::text = 'architect';
  IF v_architect > 0 THEN
    SELECT string_agg(q.id, ', ') INTO v_sample FROM (
      SELECT "id" AS id FROM "Decision" WHERE "deciderKind"::text = 'architect' ORDER BY "id" LIMIT 10) q;
    v_found := v_found || format('%s"Decision"."deciderKind" = architect: %s row(s) [%s]',
                                 CASE WHEN v_found = '' THEN '' ELSE '; ' END, v_architect, v_sample);
  END IF;

  SELECT count(*) INTO v_kinds FROM "DecisionEvent"
   WHERE "type" IN ('countersigned', 'stranded_resolved', 'forwarded', 'countersign_renotified');
  IF v_kinds > 0 THEN
    SELECT string_agg(q.id, ', ') INTO v_sample FROM (
      SELECT "id" AS id FROM "DecisionEvent"
       WHERE "type" IN ('countersigned', 'stranded_resolved', 'forwarded', 'countersign_renotified')
       ORDER BY "id" LIMIT 10) q;
    v_found := v_found || format('%s"DecisionEvent"."type" in the 4d-only kinds: %s row(s) [%s]',
                                 CASE WHEN v_found = '' THEN '' ELSE '; ' END, v_kinds, v_sample);
  END IF;

  IF v_found <> '' THEN
    RAISE EXCEPTION
      'phase6 4d-i ABORT: row(s) already hold a value this unit RESERVES until 4d-iii — %. The doors installed just above judge new and updated rows and cannot see these; the seals below would adopt and freeze them. An awaiting decision has no provisional revision to countersign and is unfinalizable by construction; an architect-held decision has no holder any surface can resolve; a 4d-only audit kind is evidence of an act whose command does not exist until 4d-ii. Return the named decisions to a state this release can serve (`pending`, `approved` or `change`, with a `client`, `pmc`, `member` or `none` designation) and remove the named audit rows, then re-run. On a database that has genuinely run 4d-iii, restore its RolloutRetirement marker instead. See docs/RUNBOOK.md §P6T4D.',
      v_found;
  END IF;
END $reserved_rows$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE ENUM ADDITIONS
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Each its own statement. Nothing in THIS transaction consumes either value — every comparison
-- above and below is made on ::text — so the unusable-in-same-transaction rule is never tripped.

ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS 'architect';
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'awaiting_countersign';

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3a — THE THREE DECISIONS-OWNED FACT TABLES (shape)
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Each lives under the uniform seal contract of §A.3, whose seven obligations are installed in
-- the seal slice below. This slice is SHAPE ONLY — tables, keys, references and the CHECKs that
-- are properties of a row rather than of a transition — so the probes fail on BEHAVIOUR and
-- never on a missing symbol (the 4c-i convention).
--
-- WHY THE DESIGNATION AND ROLE COLUMNS ARE `TEXT` AND NOT THE ENUM: `DeciderKind` gained
-- `architect` in Part 2 of THIS transaction, and a value added by `ALTER TYPE … ADD VALUE` is
-- unusable until it commits. A column typed `"DeciderKind"` could be declared, but any CHECK,
-- DEFAULT or comparison naming `'architect'` in this file would abort. TEXT with a CHECK over
-- the vocabulary keeps the whole file judgeable in one transaction and matches the discipline
-- Parts 1 and 3 already use, where every comparison against the reserved values is made on
-- `::text`. The seals below compare these columns to `Decision."deciderKind"::text`.

-- The provenance and same-project FK targets these facts need. Both are ADDITIVE and VACUOUSLY
-- SATISFIABLE — `id` is already unique on its own, so neither index can reject an existing or a
-- future row, and no writer changes (the argument 4c-i used for
-- `DecisionOption_decision_option_key`).
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionApprovalRevision_project_revision_key"
  ON "DecisionApprovalRevision"("projectId", "id");

CREATE TABLE IF NOT EXISTS "DecisionForward" (
    "id"                          TEXT NOT NULL,
    "projectId"                   TEXT NOT NULL,
    "decisionId"                  TEXT NOT NULL,
    -- the DISPLACED holder, kind + membership, exactly as the decision carried it
    "fromDesignationKind"         TEXT NOT NULL,
    "fromDesignationMembershipId" TEXT,
    -- the NEW holder
    "toDesignationKind"           TEXT NOT NULL,
    "toDesignationMembershipId"   TEXT,
    -- the ACTOR, who need not be the displaced holder: forward authority includes non-holders,
    -- so a PMC forwarding a client-held decision is recorded as the PMC displacing the client.
    "forwardedById"               TEXT NOT NULL,
    "forwardedByRole"             TEXT NOT NULL,
    "forwardedByName"             TEXT NOT NULL,
    "reason"                      TEXT NOT NULL,
    "at"                          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"             TEXT NOT NULL,
    CONSTRAINT "DecisionForward_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionCountersign" (
    "id"                    TEXT NOT NULL,
    "projectId"             TEXT NOT NULL,
    "decisionId"            TEXT NOT NULL,
    -- the EXACT revision countersigned. Not "the decision's head at some later moment": the
    -- fact records which provisional approval this act finalized, and the one-per-revision key
    -- below is what makes a decision re-stranded on a LATER revision resolvable again while the
    -- same revision can never be finalized twice.
    "revisionId"            TEXT NOT NULL,
    "countersignedById"     TEXT NOT NULL,
    "countersignedByRole"   TEXT NOT NULL,
    "countersignedByName"   TEXT NOT NULL,
    "at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"       TEXT NOT NULL,
    CONSTRAINT "DecisionCountersign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionStrandedResolution" (
    "id"               TEXT NOT NULL,
    "projectId"        TEXT NOT NULL,
    "decisionId"       TEXT NOT NULL,
    "revisionId"       TEXT NOT NULL,
    "outcome"          TEXT NOT NULL,
    "resolvedById"     TEXT NOT NULL,
    "resolvedByRole"   TEXT NOT NULL,
    "resolvedByName"   TEXT NOT NULL,
    "reason"           TEXT NOT NULL,
    "at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"  TEXT NOT NULL,
    CONSTRAINT "DecisionStrandedResolution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DecisionForward_projectId_decisionId_idx"
  ON "DecisionForward"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionCountersign_projectId_decisionId_idx"
  ON "DecisionCountersign"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionStrandedResolution_projectId_decisionId_idx"
  ON "DecisionStrandedResolution"("projectId", "decisionId");

-- ONE-USE provenance (§A.3 obligation 6): a receipt backs AT MOST ONE row per table, so a single
-- genuine receipt cannot be replayed to mint a second fact.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionForward_source_command_key"
  ON "DecisionForward"("projectId", "sourceCommandId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionCountersign_source_command_key"
  ON "DecisionCountersign"("projectId", "sourceCommandId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionStrandedResolution_source_command_key"
  ON "DecisionStrandedResolution"("projectId", "sourceCommandId");

-- One finalization per revision, and one disposal per revision. A decision re-stranded on a
-- LATER revision resolves again; the SAME revision never twice.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionCountersign_revision_key"
  ON "DecisionCountersign"("projectId", "decisionId", "revisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionStrandedResolution_revision_key"
  ON "DecisionStrandedResolution"("projectId", "decisionId", "revisionId");

DO $$
DECLARE
  t TEXT;
  fk TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    -- §A.3 obligation 5: every reference is project-bound through the child's own `projectId`.
    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "decisionId")'
              || ' REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_decisionId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;

    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "sourceCommandId")'
              || ' REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_sourceCommandId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "revisionId")'
              || ' REFERENCES "DecisionApprovalRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_revisionId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_forwardedById_fkey"
    FOREIGN KEY ("forwardedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionCountersign" ADD CONSTRAINT "DecisionCountersign_countersignedById_fkey"
    FOREIGN KEY ("countersignedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionStrandedResolution" ADD CONSTRAINT "DecisionStrandedResolution_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_from_membership_fkey"
    FOREIGN KEY ("projectId", "fromDesignationMembershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_to_membership_fkey"
    FOREIGN KEY ("projectId", "toDesignationMembershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the row CHECKs ───────────────────────────────────────────────────────────────────────────
-- NOT NULL and non-blank are TWO obligations, not one: a CHECK over NULL evaluates to UNKNOWN
-- and PASSES, so a `btrim` guard alone would let a direct insert commit append-only evidence
-- with no text at all. The columns are NOT NULL above; these close the whitespace-only door,
-- over the COMPLETE ASCII whitespace set rather than the space character alone.
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('DecisionForward',            'reason'),
      ('DecisionForward',            'forwardedByRole'),
      ('DecisionForward',            'forwardedByName'),
      ('DecisionCountersign',        'countersignedByRole'),
      ('DecisionCountersign',        'countersignedByName'),
      ('DecisionStrandedResolution', 'reason'),
      ('DecisionStrandedResolution', 'resolvedByRole'),
      ('DecisionStrandedResolution', 'resolvedByName')
    ) AS v(tbl, col)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (btrim(%I, E'' \t\n\x0B\f\r'') <> '''')',
        spec.tbl, spec.tbl || '_' || spec.col || '_present_check', spec.col);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

-- The DISCRIMINATORS. `member` is the only kind that names a membership, and every other kind
-- names a role — so the kind and the membership column agree or the row is not a designation at
-- all. `none` is the RECORD designation (4b §A.2) and can neither be forwarded from nor to: a
-- record has no decider to displace and no decider to hand it to.
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_from_designation_check"
    CHECK ("fromDesignationKind" IN ('client', 'pmc', 'member', 'architect')
           AND (("fromDesignationKind" = 'member') = ("fromDesignationMembershipId" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_to_designation_check"
    CHECK ("toDesignationKind" IN ('client', 'pmc', 'member', 'architect')
           AND (("toDesignationKind" = 'member') = ("toDesignationMembershipId" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A forward that changes NOTHING is not a forward. The command refuses a same-target hand-off
-- 409 "already the holder", the holder-door arm requires the holder columns to actually change,
-- and this is the same claim made where it cannot be argued around: `from` and `to` DIFFER.
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_designation_moves_check"
    CHECK ("fromDesignationKind" IS DISTINCT FROM "toDesignationKind"
           OR "fromDesignationMembershipId" IS DISTINCT FROM "toDesignationMembershipId");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two explicit attributed outcomes, and nothing else. `completed` finalizes under the
-- no-chain rule; `returned` sends the decision back to its decider with an open
-- `countersign_rejection` request carrying the PMC's reason. Neither touches `pending`.
DO $$ BEGIN
  ALTER TABLE "DecisionStrandedResolution" ADD CONSTRAINT "DecisionStrandedResolution_outcome_check"
    CHECK ("outcome" IN ('completed', 'returned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3a — THE SEVEN OBLIGATIONS, INSTALLED
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- §A.3 states the contract once and every 4b–4d fact carries all seven. What follows installs
-- obligations 1, 3, 4, 5, 6 and the fact-side half of 2 for the three tables above. Obligation
-- 7 (effect correspondence) and the DECISION-side half of 2 need the kernel envelope columns and
-- the widened delivered seals, and are installed with them.
--
-- WHY HERE AND NOT WITH THE CALLER: a DB invariant whose first probe waits for the behaviour
-- unit can be wrong and become immutable history before anything detects it. No invariant this
-- file installs is probed later than the PR that installs it (the 4c-i rule).

-- ── obligation 1: append-only + evidence freeze ──────────────────────────────────────────────
-- These three facts have NO permitted mutations. §A.3 allows "the named close-transitions" as
-- exceptions, and none of the three has one: a forward, a countersign and a stranded resolution
-- are each complete at the instant they are written. So the seal is total — every UPDATE and
-- every DELETE refused, with no column-by-column comparison to get wrong.
CREATE OR REPLACE FUNCTION phase6_t4d_fact_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "%" is an append-only register and its rows are immutable evidence — a % is refused. A forward, a countersign and a stranded resolution are each COMPLETE at the instant they are written; none has a close transition, so there is nothing legitimate to rewrite. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME.',
    TG_TABLE_NAME, TG_OP;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I'
      || ' FOR EACH ROW EXECUTE FUNCTION phase6_t4d_fact_append_only()',
      t || '_t4d_append_only', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_no_truncate', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I'
      || ' FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_fact_no_truncate()',
      t || '_t4d_no_truncate', t);
  END LOOP;
END $$;

-- ── the FORWARD INSERT seal ──────────────────────────────────────────────────────────────────
-- Status-gated AND PUBLICATION-gated (#572's review round 21, finding 2). Status alone is not
-- the question: an unpublished DRAFT also carries `status = 'pending'` — `decisions.service.ts`
-- creates it that way and stamps `publishedAt` only on publication — and a draft is its
-- author's private workspace, hidden by `decisionVisibleToViewer`. Forwarding one would hand
-- someone an action item that renders as nothing, while every effect still committed. The
-- delivered code draws this line one command over (`assertConsultationEligible` refuses when
-- `publishedAt IS NULL`); the forward door is the sibling that did not.
--
-- `awaiting_countersign` is EXCLUDED from the generic command — that status is the ARCHITECT's
-- action item — and admitted by the DOOR only when the transaction also carries the
-- `countersign_rejection` request, which is the disagreement's forward-on. That arm is judged
-- at COMMIT by the pairing seal below, because the request may be written after the forward.
CREATE OR REPLACE FUNCTION phase6_t4d_forward_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  d RECORD;
  v_holder_user TEXT;
BEGIN
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."forwardedById", NEW."forwardedByRole",
                                 NEW."forwardedByName", 'DecisionForward ' || NEW."id");

  -- AUTHORITY, which `phase6_t4d_actor_bound` does not supply (Codex round 1, finding 14).
  -- That helper proves the actor TRULY holds the role and name they wrote down — it is an
  -- honesty check, not a permission one, and every project member passes it about themselves.
  -- The policy is the owner's settled 2026-08-13 amendment, carried into this plan at line
  -- 1930: FORWARD AUTHORITY = the current HOLDER + PMC + architect (once one exists). Without
  -- this arm an active engineer or contractor could write a truthful fact, hand a client-held
  -- decision to an active target, and pass every other check in this trigger.
  --
  -- The HOLDER arm reads the DISPLACED designation, which the field-for-field comparison below
  -- ties to the decision's actual holder: a named membership resolves to its ACTIVE user, a role
  -- designation to anyone holding that role. (`none` is not representable here — the designation
  -- CHECK admits `client`, `pmc`, `member` and `architect` only — so every forward displaces a
  -- designation somebody can hold.)
  IF NEW."fromDesignationKind" = 'member' THEN
    v_holder_user := platform_membership_active_user(NEW."projectId", NEW."fromDesignationMembershipId");
  END IF;
  IF NOT (
       (v_holder_user IS NOT NULL AND v_holder_user = NEW."forwardedById")
    OR (NEW."fromDesignationKind" <> 'member'
        AND platform_user_holds_role(NEW."projectId", NEW."forwardedById", NEW."fromDesignationKind"))
    OR platform_user_holds_role(NEW."projectId", NEW."forwardedById", 'pmc')
    OR platform_user_holds_role(NEW."projectId", NEW."forwardedById", 'architect')
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % hands decision % on, but user % is neither its current holder (%/%) nor a `pmc` nor an active `architect` on project % — forwarding is an AUTHORIZED act, and holding the role you truthfully named is not the same as being allowed to perform it',
      NEW."id", NEW."decisionId", NEW."forwardedById", NEW."fromDesignationKind",
      COALESCE(NEW."fromDesignationMembershipId", '<role>'), NEW."projectId";
  END IF;

  SELECT "status"::text AS status, "publishedAt", "deciderKind"::text AS kind, "deciderMembershipId"
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6 4d-i: DecisionForward % names decision %, which does not exist in project %', NEW."id", NEW."decisionId", NEW."projectId";
  END IF;
  IF d."publishedAt" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is an unpublished DRAFT and may not be forwarded — it is its author''s private workspace, hidden from the target by `decisionVisibleToViewer`, so the hand-off would deliver an action item that renders as nothing (DecisionForward %)',
      NEW."decisionId", NEW."id";
  END IF;
  IF d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%` and may not be forwarded — forwarding is legal only in states the NEW holder can act on (DecisionForward %)',
      NEW."decisionId", d.status, NEW."id";
  END IF;

  -- Mere row presence is forgeable: a hostile transaction could insert a forward naming
  -- unrelated designations and re-home the holder to a third member. So the fact is compared to
  -- the decision FIELD-FOR-FIELD — the row it displaces must be the holder the decision
  -- actually carries at this instant.
  IF NEW."fromDesignationKind" IS DISTINCT FROM d.kind
     OR NEW."fromDesignationMembershipId" IS DISTINCT FROM d."deciderMembershipId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % records displacing %/% but decision % is held by %/% — a forward is evidence of the hand-off that actually happened, never of one asserted about it',
      NEW."id", NEW."fromDesignationKind", COALESCE(NEW."fromDesignationMembershipId", '<role>'),
      NEW."decisionId", d.kind, COALESCE(d."deciderMembershipId", '<role>');
  END IF;

  -- The TARGET must be able to act, judged at the DB too. A named-member designation resolves
  -- through `platform_membership_active_user` (the composite FK pins existence and project;
  -- ACTIVE standing is the primitive's read, under the membership row lock); a role designation
  -- must have at least one active holder.
  IF NEW."toDesignationKind" = 'member' THEN
    IF platform_membership_active_user(NEW."projectId", NEW."toDesignationMembershipId") IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionForward % hands decision % to membership %, which holds no ACTIVE standing on this project — the new holder must be able to act',
        NEW."id", NEW."decisionId", NEW."toDesignationMembershipId";
    END IF;
  ELSIF NOT platform_role_has_holder(NEW."projectId", NEW."toDesignationKind") THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % hands decision % to the `%` role, which has no active holder on this project — the decision would land with nobody able to act on it',
      NEW."id", NEW."decisionId", NEW."toDesignationKind";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionForward_t4d_seal" ON "DecisionForward";
CREATE TRIGGER "DecisionForward_t4d_seal" BEFORE INSERT ON "DecisionForward"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_seal();

-- ── the finalizer's subject: the PROVISIONAL HEAD, not merely "a revision of this decision" ──
-- Codex round 1, finding 15. A finalizer names WHICH provisional approval it finalizes, and
-- `revisionId` is writer-chosen, so "belongs to this decision" is not the question — a decision
-- reopened after an earlier approval carries an OLDER FINALIZED revision beside its new
-- provisional one. A countersign citing the old row passes a belongs-to check, drives the
-- decision to `approved`, and satisfies the deferred flip pairing because that row is already
-- `finalized` and never flips — leaving the ACTUAL provisional head unfinalized forever, with a
-- final-looking decision resting on a finalization of something else.
--
-- The head is the highest `version` for the decision, and it must still be PROVISIONAL: the
-- revision the awaiting transition produced. Both finalizers ask this — the countersign and the
-- `completed` stranded resolution alike — because both end the same provisional approval.
CREATE OR REPLACE FUNCTION phase6_t4d_provisional_head(
  p_project TEXT, p_decision TEXT, p_revision TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_head TEXT; v_head_version INTEGER;
BEGIN
  SELECT "decisionId", "finalized", "version" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = p_project AND "id" = p_revision FOR UPDATE;
  IF NOT FOUND OR r."decisionId" <> p_decision THEN
    RAISE EXCEPTION
      'phase6 4d-i: % names revision %, which is not a revision of decision % — the fact records WHICH provisional approval it finalized',
      p_row, p_revision, p_decision;
  END IF;

  SELECT "id", "version" INTO v_head, v_head_version FROM "DecisionApprovalRevision"
   WHERE "projectId" = p_project AND "decisionId" = p_decision
   ORDER BY "version" DESC LIMIT 1;
  IF v_head IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION
      'phase6 4d-i: % finalizes revision % (version %), but decision %''s current revision is % (version %) — a finalizer ends the approval that is OPEN, and citing a superseded one would leave the live provisional approval unfinalized behind a decision that reads as final',
      p_row, p_revision, r."version", p_decision, v_head, v_head_version;
  END IF;
  IF r."finalized" THEN
    RAISE EXCEPTION
      'phase6 4d-i: % finalizes revision %, which is ALREADY final — there is no provisional approval left for it to end',
      p_row, p_revision;
  END IF;
END $$;

-- ── the COUNTERSIGN INSERT seal ──────────────────────────────────────────────────────────────
-- The countersigner must BE an architect, and the subject must be exactly `awaiting_countersign`
-- — the only state a countersign is legal in.
CREATE OR REPLACE FUNCTION phase6_t4d_countersign_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  IF NEW."countersignedByRole" <> 'architect' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % freezes the role `%` — a countersign is the ARCHITECT''s act and no other role performs it',
      NEW."id", NEW."countersignedByRole";
  END IF;
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."countersignedById", 'architect',
                                 NEW."countersignedByName", 'DecisionCountersign ' || NEW."id");

  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND OR d.status <> 'awaiting_countersign' THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%`, not `awaiting_countersign` — there is no provisional approval for DecisionCountersign % to finalize',
      NEW."decisionId", COALESCE(d.status, '<missing>'), NEW."id";
  END IF;

  PERFORM phase6_t4d_provisional_head(NEW."projectId", NEW."decisionId", NEW."revisionId",
                                      'DecisionCountersign ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_seal" ON "DecisionCountersign";
CREATE TRIGGER "DecisionCountersign_t4d_seal" BEFORE INSERT ON "DecisionCountersign"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_seal();

-- ── the STRANDED RESOLUTION INSERT seal ──────────────────────────────────────────────────────
-- Legal ONLY while the decision is `awaiting_countersign` AND no active architect exists. Both
-- are re-judged here, under the decision row lock and the readiness key the helper takes, so the
-- architect-reappears race is closed at the DB and not only at the command's CAS.
CREATE OR REPLACE FUNCTION phase6_t4d_stranded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  IF NEW."resolvedByRole" <> 'pmc' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionStrandedResolution % freezes the role `%` — resolving a stranded decision is the PMC''s named act and no other role performs it',
      NEW."id", NEW."resolvedByRole";
  END IF;
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."resolvedById", 'pmc',
                                 NEW."resolvedByName", 'DecisionStrandedResolution ' || NEW."id");

  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND OR d.status <> 'awaiting_countersign' THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%`, not `awaiting_countersign` — it is not stranded, so DecisionStrandedResolution % has nothing to resolve',
      NEW."decisionId", COALESCE(d.status, '<missing>'), NEW."id";
  END IF;

  -- The whole premise of the command: an architect who could countersign makes this act
  -- illegal. Judged from the counted register under the readiness key already held.
  IF platform_role_standing(NEW."projectId", 'architect') > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: project % still holds an ACTIVE architect, so decision % is not stranded — the countersign is the legal path and DecisionStrandedResolution % is refused',
      NEW."projectId", NEW."decisionId", NEW."id";
  END IF;

  -- the same subject rule as the countersign, on BOTH outcomes: `completed` ends the open
  -- provisional approval and `returned` sends it back, and neither is an act about a superseded
  -- or already-final revision (Codex round 1, finding 15's second half).
  PERFORM phase6_t4d_provisional_head(NEW."projectId", NEW."decisionId", NEW."revisionId",
                                      'DecisionStrandedResolution ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_seal" ON "DecisionStrandedResolution";
CREATE TRIGGER "DecisionStrandedResolution_t4d_seal" BEFORE INSERT ON "DecisionStrandedResolution"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_seal();

-- ── obligation 6: BUNDLE-AWARE command provenance ────────────────────────────────────────────
-- The delivered `phase6_t4c_provenance_bound` requires the receipt's `resultRef` to name the ROW
-- ITSELF. A command that writes ONE fact satisfies that; a command that writes a BUNDLE cannot.
-- Two bundles exist (§A.3, obligation 6):
--
--   * `decisions.disagree` — the forward-on writes a `countersign_rejection` REQUEST and a
--     `DecisionForward`; the reject-back writes the request alone. The REQUEST is the primary.
--   * `decisions.resolveStrandedCountersign` — the `returned` outcome writes a RESOLUTION, a
--     request, and (when the installed designation has no active holder) a `DecisionForward`
--     re-homing it. The RESOLUTION is the primary.
--
-- So the 4d-owned check accepts a `resultRef` naming the row ITSELF **or** the bundle's PRIMARY
-- fact, when the same transaction pairs them and BOTH cite the SAME receipt. The per-table
-- one-use UNIQUE still holds, so the widening cannot be used to mint two facts from one receipt
-- in the same table.
--
-- DEFERRED, like its 4c sibling: the receipt is `reserved` while the command runs and only
-- becomes `succeeded` when it completes, so an immediate check would judge a receipt that has
-- not finished yet.
--
-- THE RECEIPT IS IDENTIFIED BEFORE IT IS MATCHED (Codex round 1, finding 12 — a hole in the
-- CONTRACT's rule, not an abbreviation of it, so §A.3 obligation 6 gains this paragraph with
-- the code). `status` and `resultRef` alone do not say WHICH command the receipt belongs to,
-- and `resultRef = NEW."id"` is an equality over a writer-CHOSEN column: give a forged
-- `DecisionForward` the id of an existing decision and cite that decision''s `decisions.create`
-- receipt, and the identity arm accepts it as forward provenance. Nor does either column say
-- who acted — a fact could name one actor while its receipt recorded another, and the frozen
-- attribution pair would be truthful about a person who did nothing.
--
-- So the receipt must be the RIGHT KIND of command, run by the SAME actor:
--
--   · `DecisionForward` — `decisions.forward`, or the two BUNDLES that also write one:
--     `decisions.disagree`''s forward-on and `decisions.resolveStrandedCountersign`''s
--     departed-holder re-homing;
--   · `DecisionCountersign` — `decisions.countersign`;
--   · `DecisionStrandedResolution` — `decisions.resolveStrandedCountersign`.
--
-- These are the four ledgered commands the plan derives from the §A.3 fact table (lines
-- 4325-4336), and naming them here means a 4d-ii command that spells its type differently is
-- REFUSED rather than silently admitted — which is the coupling this seal is for. A table
-- added to the loop below without an entry here is refused outright: the map fails CLOSED,
-- because a fact whose expected command kind nobody stated is a fact nothing is checking.
CREATE OR REPLACE FUNCTION phase6_t4d_provenance_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  v_primary_ok BOOLEAN := FALSE;
  v_types TEXT[];
  v_actor_column TEXT;
  v_actor TEXT;
BEGIN
  v_types := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN
      ARRAY['decisions.forward', 'decisions.disagree', 'decisions.resolveStrandedCountersign']
    WHEN 'DecisionCountersign' THEN ARRAY['decisions.countersign']
    WHEN 'DecisionStrandedResolution' THEN ARRAY['decisions.resolveStrandedCountersign']
    -- #582's review round 20, finding 1 — THE CHANGE REQUEST'S BIRTH RECEIPT IS PROVENANCE TOO,
    -- and it was FROZEN without ever being judged. Round 8 made `sourceCommandId` immutable from
    -- the moment it lands and round 17 bound the requester PAIR to its actor; between them nothing
    -- asked what the receipt IS. A direct standard-request bundle could therefore cite any unused
    -- historical same-project `CommandExecution` — the FK is satisfied, the unique index is
    -- satisfied — and the freeze then made that false provenance permanent, beyond anything
    -- 4d-iii's future-write seals can reach.
    --
    -- The kinds are the ones that OPEN a request, keyed to the discriminator the row already
    -- carries: a `standard` request is opened by `decisions.requestChange`, and a
    -- `countersign_rejection` by the architect's `decisions.disagree`. Naming them per origin
    -- rather than as one list is the round-7 rule (bind each command to the shape it performs):
    -- a disagreement receipt may not back a standard request, or the origin column would be a
    -- label with nothing behind it.
    WHEN 'ChangeRequest' THEN
      CASE to_jsonb(NEW) ->> 'origin'
        WHEN 'countersign_rejection' THEN ARRAY['decisions.disagree']
        ELSE ARRAY['decisions.requestChange']
      END
    ELSE NULL
  END;
  v_actor_column := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN 'forwardedById'
    WHEN 'DecisionCountersign' THEN 'countersignedById'
    WHEN 'DecisionStrandedResolution' THEN 'resolvedById'
    WHEN 'ChangeRequest' THEN 'requestedById'
    ELSE NULL
  END;
  IF v_types IS NULL OR v_actor_column IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% is bound by phase6_t4d_provenance_bound, but no command kind or actor column is declared for table % — a fact whose expected provenance nobody stated is a fact nothing is checking',
      TG_TABLE_NAME, NEW."id", TG_TABLE_NAME;
  END IF;
  v_actor := to_jsonb(NEW) ->> v_actor_column;

  -- THE RECEIPT IS THIS TRANSACTION'S (#582 round 4, finding 3). Round 3's finding 3 corrected
  -- exactly this shape on `phase6_t4d_membership_transition_bound` — a message that has said "in
  -- this transaction" since round 1 over a query with no transaction predicate — and the commit
  -- that carried it reasoned that the DECISION facts were safe because their commands are new.
  -- They are not: `decisions.forward`, `decisions.disagree`, `decisions.countersign` and
  -- `decisions.resolveStrandedCountersign` are all DELIVERED and ledgered today, so a mature
  -- database holds succeeded receipts for every one of them that no 4d fact has ever cited. A
  -- later direct transaction can write a forward, countersign or resolution citing one of those
  -- HISTORICAL receipts and satisfy every other clause here truthfully — right command kind, right
  -- actor, right result — presenting a new act as an old command's. `xmin` closes it, and it is
  -- read under an alias no other predicate in this body uses so the contract register can witness
  -- THIS clause rather than some other use of `txid_current`.
  SELECT "status", "resultRef", "commandType", "actorId",
         "xmin" = txid_current()::text::xid AS "receiptThisTx"
    INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the row',
      TG_TABLE_NAME, NEW."id";
  END IF;
  IF NOT COALESCE(c."receiptThisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites receipt %, which was completed by an EARLIER transaction — the fact and its receipt are one act seen twice, and a receipt lying around from a past forward, countersign or resolution cannot back an act performed now',
      TG_TABLE_NAME, NEW."id", NEW."sourceCommandId";
  END IF;

  IF NOT (c."commandType" = ANY (v_types)) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a `%` receipt, which is not a command that writes this fact (expected one of %) — provenance names the act, and a receipt borrowed from an unrelated command proves nothing about this one',
      TG_TABLE_NAME, NEW."id", c."commandType", array_to_string(v_types, ', ');
  END IF;

  IF c."actorId" IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% attributes the act to %, but its receipt was run by % — the fact and the receipt are one act seen twice, and a truthful attribution pair naming someone who ran no command is exactly the forgery the frozen pair exists to prevent',
      TG_TABLE_NAME, NEW."id", COALESCE(v_actor, '<null>'), COALESCE(c."actorId", '<null>');
  END IF;

  IF c."resultRef" = NEW."id" THEN RETURN NULL; END IF;

  -- The bundle arm. The primary is looked up by the SHARED receipt, which is what makes this a
  -- bundle rather than two unrelated rows: a row citing a receipt whose result names some other
  -- command's fact finds nothing here and is refused.
  SELECT EXISTS (
    SELECT 1 FROM "ChangeRequest" cr
     WHERE cr."projectId" = NEW."projectId" AND cr."id" = c."resultRef"
       AND cr."sourceCommandId" = NEW."sourceCommandId"
       AND cr."decisionId" = NEW."decisionId"
  ) OR EXISTS (
    SELECT 1 FROM "DecisionStrandedResolution" sr
     WHERE sr."projectId" = NEW."projectId" AND sr."id" = c."resultRef"
       AND sr."sourceCommandId" = NEW."sourceCommandId"
       AND sr."decisionId" = NEW."decisionId"
  ) INTO v_primary_ok;

  IF NOT v_primary_ok THEN
    RAISE EXCEPTION
      'phase6 4d-i: the receipt cited by %.% names result %, which is neither this row nor a PRIMARY fact of its bundle citing the same receipt for the same decision — a receipt for another result cannot be borrowed',
      TG_TABLE_NAME, NEW."id", COALESCE(c."resultRef", '<null>');
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_provenance_bound', t);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I'
      || ' DEFERRABLE INITIALLY DEFERRED'
      || ' FOR EACH ROW EXECUTE FUNCTION phase6_t4d_provenance_bound()',
      t || '_t4d_provenance_bound', t);
  END LOOP;
END $$;

-- ── obligation 2: the FACT side of the pairing, in both directions ───────────────────────────
-- A fact and its transition commit together or neither does. The DECISION side of each pairing
-- is installed with the widened delivered seals; this is the FACT side — an orphan row would
-- fabricate immutable evidence for a transition that never happened.
--
-- DEFERRED, because within one transaction the fact may be written before or after the
-- transition it records, and a seal that demanded one order would reject valid bundles.

CREATE OR REPLACE FUNCTION phase6_t4d_forward_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; v_facts BIGINT;
BEGIN
  SELECT "deciderKind"::text AS kind, "deciderMembershipId"
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF d.kind IS DISTINCT FROM NEW."toDesignationKind"
     OR d."deciderMembershipId" IS DISTINCT FROM NEW."toDesignationMembershipId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % records handing decision % to %/%, but at commit the decision is held by %/% — the row is ORPHAN evidence of a hand-off that did not happen',
      NEW."id", NEW."decisionId", NEW."toDesignationKind",
      COALESCE(NEW."toDesignationMembershipId", '<role>'),
      COALESCE(d.kind, '<missing>'), COALESCE(d."deciderMembershipId", '<role>');
  END IF;

  -- ONE ACT, ONE FACT — AND "ONE" IS A COUNT (#582 round 10, finding 1).
  --
  -- The arm above compares each fact against the FINAL holder, which every fact naming that
  -- holder satisfies at once. So two `DecisionForward` rows with identical designations and
  -- DISTINCT receipts pass together: `DecisionForward_command_key` is `(projectId,
  -- sourceCommandId)`, so the index bounds facts per RECEIPT and says nothing about facts per
  -- MUTATION, and the provenance seal above binds each row to its own valid receipt. The result
  -- is two immutable rows, two frozen actors, each claiming to have performed the single
  -- hand-off the register records — the same permanent contradiction `phase6_t4d_revision_flip_paired`
  -- refuses for finalizers, asked here of the act rather than of the effect.
  --
  -- Counted on the DECISION, not on the designation: a genuine two-hop bundle (A → B → C) is
  -- already impossible, because at commit only the C row can match the holder and the A row is
  -- refused as orphan evidence above. So one transaction that moves a decision's holder holds
  -- exactly one forward fact, and any other number is refused here.
  SELECT count(*) INTO v_facts FROM "DecisionForward" f
   WHERE f."projectId" = NEW."projectId" AND f."decisionId" = NEW."decisionId"
     AND f."xmin" = txid_current()::text::xid;
  IF v_facts <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % carries % DecisionForward rows written by THIS transaction for one hand-off — a holder mutation is ONE act with ONE attributable record, and duplicate facts citing different receipts are two immutable actors claiming a single mutation (row %)',
      NEW."decisionId", v_facts, NEW."id";
  END IF;
  RETURN NULL;
END $$;

-- ── the DISAGREEMENT transition owes its request, judged WHERE THE TRANSITION IS ─────────────
-- #582 round 10, finding 2, and it is a REGRESSION of my own round-8 fix rather than a new gap.
-- Round 8 put this demand inside the forward's reverse seal, keyed on the decision's status at
-- commit being `change`. That predicate is not the rule. The plan's transition table (line 5759)
-- and the P30 paragraph (line 3349) both name the obligation on the TRANSITION —
-- "the DB door admits `awaiting_countersign → change` ONLY when the transaction also carries the
-- `countersign_rejection` request" — and final status `change` is a state, not a transition:
--
--   · it is TOO WIDE. `decisions.forward` on a decision ALREADY in `change` moves only the
--     holder; that decision's open request is a `standard` one, so the round-8 arm aborted at
--     commit an ordinary generic forward the plan explicitly permits ("the holder mutation
--     (forward, generic or forward-on)" is its own row in the same table). A seal that refuses
--     the delivered path is worse than the gap it closed.
--   · it is TOO NARROW. The disagreement's other shape — the reject-back, which opens the
--     request without handing the decision anywhere — writes no `DecisionForward` at all, so the
--     round-8 arm never judged it.
--
-- The transition can only be seen where OLD is in hand, which is the same architectural sentence
-- round 6's finding 2 wrote about the membership pre-state and plan line 2915 wrote before that.
-- A DEFERRED constraint trigger on `Decision` has both: OLD and NEW are the images of the
-- statement that fired it, and the demand is still asked at COMMIT, because the request may be
-- written after the transition inside the same bundle.
--
-- The `returned` stranded resolution is the third route across this transition and owes the same
-- request (`phase6_t4d_stranded_paired` demands it from the resolution side); one door over the
-- transition covers all three shapes, and no shape is exempted.
CREATE OR REPLACE FUNCTION phase6_t4d_disagreement_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text <> 'awaiting_countersign' OR NEW."status"::text <> 'change' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ChangeRequest" cr
     WHERE cr."projectId" = NEW."projectId" AND cr."decisionId" = NEW."id"
       AND cr."status" = 'open' AND cr."origin" = 'countersign_rejection'
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % crossed `awaiting_countersign → change` in this transaction with no open `countersign_rejection` request — the disagreement is a BUNDLE (reject-back, forward-on or `returned` resolution alike), and the transition without its request leaves a decision whose reason no reader can see and which neither approve nor withdrawChange can close',
      NEW."id";
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4d_countersign_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD;
BEGIN
  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";
  SELECT "finalized" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId";

  -- Row, flip and status are ONE transaction or none. Both the orphan row and the split
  -- two-transaction replay are refused here (P31).
  IF d.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % finalizes decision %, but at commit the decision is `%` rather than `approved` — the fact, the finality flip and the status transition commit together or not at all',
      NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
  END IF;
  IF r."finalized" IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % names revision %, which is not finalized at commit — a countersign that does not flip the revision it countersigns is evidence of nothing',
      NEW."id", NEW."revisionId";
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4d_stranded_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD;
BEGIN
  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF NEW."outcome" = 'completed' THEN
    SELECT "finalized" INTO r FROM "DecisionApprovalRevision"
     WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId";
    IF d.status IS DISTINCT FROM 'approved' OR r."finalized" IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % resolves decision % as `completed`, which owes BOTH the finality flip on revision % and the `awaiting_countersign → approved` transition — at commit the decision is `%` and the revision finalized=%',
        NEW."id", NEW."decisionId", NEW."revisionId",
        COALESCE(d.status, '<missing>'), COALESCE(r."finalized"::text, '<missing>');
    END IF;
  ELSE
    -- `returned`. The transition ALONE is not enough: without the request the decision lands in
    -- `change` with a reason no reader can see, and neither `approve` nor `withdrawChange` can
    -- close it, both requiring exactly one open request.
    IF d.status IS DISTINCT FROM 'change' THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % returns decision % to its decider, but at commit the decision is `%` rather than `change`',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ChangeRequest" cr
                    WHERE cr."projectId" = NEW."projectId" AND cr."decisionId" = NEW."decisionId"
                      AND cr."status" = 'open' AND cr."origin" = 'countersign_rejection') THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % returns decision % with no open `countersign_rejection` request in the same transaction — the bundle is the resolution AND the request, and the transition alone commits a decision nothing can close',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionForward_t4d_paired" ON "DecisionForward";
CREATE CONSTRAINT TRIGGER "DecisionForward_t4d_paired"
  AFTER INSERT ON "DecisionForward" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_paired();
DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_paired" ON "DecisionCountersign";
CREATE CONSTRAINT TRIGGER "DecisionCountersign_t4d_paired"
  AFTER INSERT ON "DecisionCountersign" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_paired();
DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_paired" ON "DecisionStrandedResolution";
CREATE CONSTRAINT TRIGGER "DecisionStrandedResolution_t4d_paired"
  AFTER INSERT ON "DecisionStrandedResolution" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_paired();
-- ── and the ENTRY into `awaiting_countersign` owes its provisional revision ──────────────────
-- #582 round 12, finding 6, and it is the converse of round 10's and round 11's work rather than
-- a new idea. Every pairing in this unit is stated IN BOTH DIRECTIONS — a fact with no write is
-- an orphan, a write with no fact is unattributable — and the revision birth got one of them:
-- `phase6_t4d_revision_birth_paired` refuses a provisional revision whose decision did not land
-- `awaiting_countersign`, and NOTHING refused the transition that lands there carrying no
-- revision at all.
--
-- After 4d-iii drops the reservation door that is a direct `pending → awaiting_countersign`
-- update under an active chain, committing with no revision, no receipt, no event, no audit row
-- and no notice. The decision is then unfinalizable by construction: both the countersign and the
-- stranded resolution resolve their subject through `phase6_t4d_provisional_head`, which has no
-- head to find. The decision sits in the architect's queue forever.
--
-- DEFERRED, because the revision may be written before or after the transition inside the
-- command's transaction — the same reason the seal in the other direction is deferred. Counted,
-- not merely found, because that is this file's settled answer to "one act, one fact": the
-- revision seal already refuses a second provisional head, and demanding exactly one here means
-- neither direction can be satisfied by a number the other would refuse.
CREATE OR REPLACE FUNCTION phase6_t4d_awaiting_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_born BIGINT; v_from TEXT;
BEGIN
  IF NEW."status"::text <> 'awaiting_countersign'
     OR OLD."status"::text = 'awaiting_countersign' THEN
    RETURN NULL;
  END IF;

  -- COUNTED AND THEN READ (#582 round 13, finding 4). Round 12 counted the provisional births and
  -- stopped there, which is the same shape as round 10's "found, not counted" one level along: a
  -- count settles HOW MANY rows there are and says nothing about WHAT IS IN THEM. The row this
  -- count admits carries `approvedFrom`, the discriminator its finalizer reads to decide between
  -- `decision.approved` and `decision.reapproved` — so a receipt-backed `pending -> awaiting_countersign`
  -- bundle could store `approvedFrom = 'change'`, satisfy every seal in this file, and make the
  -- countersign announce a REAPPROVAL of a decision that had never been approved once.
  SELECT count(*), min(r."approvedFrom") INTO v_born, v_from
    FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."id"
     AND r."finalized" = FALSE
     AND r."xmin" = txid_current()::text::xid;
  IF v_born = 1 AND v_from IS DISTINCT FROM OLD."status"::text THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % entered `awaiting_countersign` FROM `%` but its provisional revision records `approvedFrom = %` — the discriminator is what the countersign and the stranded resolution read to choose between `decision.approved` and `decision.reapproved`, so a revision that misreports its own source makes the finalizer announce an act that never happened',
      NEW."id", OLD."status", COALESCE(v_from, '<null>');
  END IF;
  IF v_born <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % entered `awaiting_countersign` in this transaction with % PROVISIONAL revisions born here — the state IS a parked approval, so the act that enters it writes exactly one, and a decision parked with none can never be finalized: both the countersign and the stranded resolution act on a provisional head that does not exist',
      NEW."id", v_born;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_disagreement_paired" ON "Decision";
CREATE CONSTRAINT TRIGGER "Decision_t4d_disagreement_paired"
  AFTER UPDATE ON "Decision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_disagreement_paired();
DROP TRIGGER IF EXISTS "Decision_t4d_awaiting_paired" ON "Decision";
CREATE CONSTRAINT TRIGGER "Decision_t4d_awaiting_paired"
  AFTER UPDATE ON "Decision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_awaiting_paired();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3e (partial) — THE EXISTING-TABLE COLUMNS THE FACT SEALS ABOVE READ
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Placed here, before the rest of Part 3, because the pairing and provenance seals just
-- installed read `ChangeRequest."origin"`, `ChangeRequest."sourceCommandId"` and
-- `DecisionApprovalRevision."finalized"`. Everything is one transaction, so a later position
-- would still be correct at COMMIT — but a file whose seals name columns declared 400 lines
-- further down is not reviewable, and "reviewable in one pass" is the reason the repository
-- writes SHAPE before SEAL at all.

-- ── ChangeRequest gains a project ────────────────────────────────────────────────────────────
-- The table carries no `projectId` today, and obligation 5 requires every reference to be
-- project-bound through the child's own column. Three steps, in the only order that keeps the
-- PREVIOUS RELEASE working through the drain:
--
--   1. add it NULLABLE and backfill from each row's decision;
--   2. install a BEFORE INSERT trigger that fills it from the row's decision when the writer
--      omits it — the delivered `requestChange` never names it, and it must keep working;
--   3. only then make it NOT NULL, which is now true of every row past and future.
--
-- A BEFORE INSERT trigger runs before constraint checks, so the NOT NULL never sees the gap.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

UPDATE "ChangeRequest" cr SET "projectId" = d."projectId"
  FROM "Decision" d WHERE d."id" = cr."decisionId" AND cr."projectId" IS NULL;

CREATE OR REPLACE FUNCTION phase6_t4d_change_request_project() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."projectId" IS NULL THEN
    SELECT "projectId" INTO NEW."projectId" FROM "Decision" WHERE "id" = NEW."decisionId";
    IF NEW."projectId" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: ChangeRequest % names decision %, which does not exist — there is no project for the row to belong to',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_project" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_project" BEFORE INSERT ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_project();

DO $$
DECLARE v_orphans BIGINT;
BEGIN
  SELECT count(*) INTO v_orphans FROM "ChangeRequest" WHERE "projectId" IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i ABORT: % "ChangeRequest" row(s) name a decision that does not exist, so the backfill cannot give them a project. Refusing to commit rather than dropping the column''s guarantee.',
      v_orphans;
  END IF;
END $$;

ALTER TABLE "ChangeRequest" ALTER COLUMN "projectId" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_decisionId_fkey"
    FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the origin discriminator, and the evidence the two origins owe ───────────────────────────
-- `standard` is the delivered request every existing row is, so it is the DEFAULT and the
-- backfill is the default itself. `countersign_rejection` is 4d's: the architect's disagreement
-- under an ACTIVE chain, or the PMC's stranded return under an INACTIVE one — TWO legal
-- producers, discriminated by the fact each is paired with (§B.6).
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'standard';
-- The exact revision this rejection DISPOSED of, so a rejected head can never be re-entered by
-- a bare status flip while a real re-approval appends a fresh head that passes.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "revisionId" TEXT;
-- The frozen requester pair (§A.3 obligation 3). Nullable for legacy rows and for the previous
-- release's writer during the drain; 4d-ii writes it and 4d-iii requires it.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "requestedByRole" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "requestedByName" TEXT;
-- TWO provenance columns, because the row is written by TWO commands (#572's review round 5,
-- finding 5): the REQUEST that opens it and the CLOSURE that takes it out of `open`.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "sourceCommandId" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByCommandId" TEXT;
-- The frozen RESOLVER pair, owed by every writer of `resolvedById` (#572's review round 7).
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByRole" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByName" TEXT;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_origin_check"
    CHECK ("origin" IN ('standard', 'countersign_rejection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A rejection names the revision it disposed of; a standard request has no revision to dispose
-- of and names none. CHECK-pinned in both directions.
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_revision_by_origin_check"
    CHECK (("origin" = 'countersign_rejection') = ("revisionId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- THE ATTRIBUTION PAIRS ARE PAIRS (#582's review round 8, finding 5). A role without a name, or
-- a name without a role, is half an attribution: it names an authority nobody can be checked
-- against, or a person whose capacity is unstated. Both halves or neither, and a present half is
-- non-blank — the all-NULL shape stays legal because legacy and drain-window rows carry it.
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_requested_pair_check"
    CHECK (("requestedByRole" IS NULL) = ("requestedByName" IS NULL)
           AND ("requestedByRole" IS NULL OR btrim("requestedByRole", E' \t\n\x0B\f\r') <> '')
           AND ("requestedByName" IS NULL OR btrim("requestedByName", E' \t\n\x0B\f\r') <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_resolved_pair_check"
    CHECK (("resolvedByRole" IS NULL) = ("resolvedByName" IS NULL)
           AND ("resolvedByRole" IS NULL OR btrim("resolvedByRole", E' \t\n\x0B\f\r') <> '')
           AND ("resolvedByName" IS NULL OR btrim("resolvedByName", E' \t\n\x0B\f\r') <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_revisionId_fkey"
    FOREIGN KEY ("projectId", "revisionId") REFERENCES "DecisionApprovalRevision"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_resolvedByCommandId_fkey"
    FOREIGN KEY ("projectId", "resolvedByCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ONE-USE, and PARTIAL because the legacy and drain-window rows carry NULL. Prisma cannot
-- express a predicate on `@@unique`, so these live in SQL only — the shape
-- `DecisionApprovalRevision_source_command_key` already uses.
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeRequest_source_command_key"
  ON "ChangeRequest"("projectId", "sourceCommandId") WHERE "sourceCommandId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeRequest_resolved_command_key"
  ON "ChangeRequest"("projectId", "resolvedByCommandId") WHERE "resolvedByCommandId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ChangeRequest_projectId_decisionId_idx"
  ON "ChangeRequest"("projectId", "decisionId");

-- ── DecisionApprovalRevision gains its finality key and the act it records ───────────────────
-- `finalized` is born TRUE outside a chain — today's behaviour byte-identical, and the reason
-- the DEFAULT is `true` rather than `false`: every existing row IS final, and every approval a
-- still-serving 4b/4c instance performs during the drain is too.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "finalized" BOOLEAN NOT NULL DEFAULT TRUE;
-- The finalizing event is a fact the PROVISIONAL approval RECORDED, not a guess the finalizer
-- makes: the delivered `approve` emits `decision.reapproved` when it acts from `change` and
-- `decision.approved` from `pending`. Under a chain that act is provisional and its finalizer
-- runs later, so the revision carries which one it was.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedFrom" TEXT;
-- The approval-time display name and the role HELD at the act — the register's `approvedById`
-- names an account whose name can change between the provisional approval and its finalization.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedByName" TEXT;
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedByRole" TEXT;

DO $$ BEGIN
  ALTER TABLE "DecisionApprovalRevision" ADD CONSTRAINT "DecisionApprovalRevision_approvedFrom_check"
    CHECK ("approvedFrom" IS NULL OR "approvedFrom" IN ('pending', 'change'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `ChangeRequest` joins the no-TRUNCATE set (§D). A statement trigger fires even on an EMPTY
-- table, and the harness's `TRUNCATE "Decision" … CASCADE` reaches this table — so the seal is
-- met by suites that never opened a request, which is why it is registered in `TRUNCATE_SEALS`
-- in the same unit that installs it.
DROP TRIGGER IF EXISTS "ChangeRequest_t4d_no_truncate" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_no_truncate" BEFORE TRUNCATE ON "ChangeRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_fact_no_truncate();

-- ── the EVIDENCE FREEZE on the columns this unit introduces ──────────────────────────────────
-- §A.3 obligation 1 puts `ChangeRequest` in the fact class: "every evidence AND discriminator
-- column immutable (`origin`, kinds, designations, `outcome`, the frozen `<act>ByRole` /
-- `<act>ByName` pair included)", and P33 names the columns — `decisionId`, `origin`,
-- `revisionId`, `projectId`, `sourceCommandId` and the frozen role/name pair — with the
-- re-point, the re-label, the NULLing and the replacing UPDATE each refused.
--
-- NOTHING WAS ENFORCING THAT (#582's review round 3, finding 4). The delivered
-- `ChangeRequest_t4b2_seal` freezes `decisionId` and nothing else, and it is a MERGED migration
-- that stays byte-for-byte unchanged — so the eight evidence columns this unit adds arrived with
-- no freeze at all. Until 4d-iii trusts and permanently seals the row, a direct UPDATE could
-- re-point `sourceCommandId` at another receipt, NULL `resolvedByCommandId`, re-label `origin`
-- from `standard` to `countersign_rejection`, or rewrite the frozen actor pair — changing which
-- command and which person the record says opened or closed the request, and the later stages
-- would then seal the forgery.
--
-- TWO CLASSES, because the columns are written at two different moments:
--
--   · FROZEN OUTRIGHT — `projectId`, `origin`, `revisionId`. These are the row's identity and
--     its discriminator, decided at INSERT. `revisionId` is CHECK-tied to `origin`, so admitting
--     a later write to either would let the pair be re-formed after the fact.
--   · ONE-WAY — `sourceCommandId` and the requester pair, `resolvedByCommandId` and the
--     resolver pair. NULL -> value is admitted because that is how they are legitimately
--     written: the drain leaves `sourceCommandId` NULL (4d-iii requires it), and the CLOSURE is
--     what writes the resolver set when the request leaves `open`. Once written they are
--     evidence, so value -> anything else, value -> NULL included, is refused.
--
-- `decisionId` is deliberately NOT repeated here: the delivered seal already refuses it by name,
-- and two triggers raising different messages about one write helps nobody.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_evidence_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_col TEXT;
BEGIN
  -- ── A REQUEST IS BORN OPEN (#582's review round 35, finding 1) ─────────────────────────────
  --
  -- Everything below this branch governs a TRANSITION, and until round 35 the trigger fired on
  -- UPDATE only. So did `ChangeRequest_t4d_closure_bound`. A row INSERTED already carrying
  -- `status = 'withdrawn'`, a `resolution`, a `resolvedAt` of any date, any `resolvedById`, and a
  -- `resolvedByCommandId` borrowed from any historical same-project receipt met the foreign key
  -- and the pair CHECK and was never judged by either: no closure transition ever occurred, so no
  -- closure rule ran. Rounds 26, 27, 30 and 31 between them decided what a closure may say, when
  -- it may say it, and whose receipt may vouch for it — and all four were bypassed by being born
  -- closed instead of closing.
  --
  -- THE FIX IS NOT A SECOND COPY OF THOSE RULES ON INSERT. That is the two-spellings defect round
  -- 32 was caught by and round 33 had to unpick, and it would need re-proving every time the
  -- lifecycle changes. It is the other half of the plan's own sentence: a change request is OPENED
  -- by a requester and CLOSED by a later act, so a request that is born closed is not a request
  -- with a history — it is a record of an act nobody performed. Birth is therefore narrowed to the
  -- one state a request can legitimately start in, and every closure must then travel through the
  -- UPDATE branch below, where the single spelling of the lifecycle governs it.
  --
  -- This is what both serving writers already do: `decisions.service.ts` opens every change
  -- request with `status: 'open'` and no resolver column, and closes it later through
  -- `decisions.reapprove` or `decisions.withdrawChange`. The seal refuses nothing the product does.
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % is born as `%` — a request is OPENED by a requester and closed only by a later act, so a row inserted already closed is a record of a closure nobody performed. Insert it `open` and close it with the command that closes it.',
        NEW."id", COALESCE(NEW."status", '<null>');
    END IF;
    IF NEW."resolution" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL
       OR NEW."resolvedById" IS NOT NULL OR NEW."resolvedByCommandId" IS NOT NULL
       OR NEW."resolvedByRole" IS NOT NULL OR NEW."resolvedByName" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % is born carrying resolver evidence (%) while still open — the resolver set records WHO closed the request, WHEN, with which outcome and on whose receipt, and none of that has happened yet. A birth that pre-fills it would freeze evidence of an act that never occurred, and the one-way arms below would make it unrepairable.',
        NEW."id",
        concat_ws(', ',
          CASE WHEN NEW."resolution" IS NOT NULL THEN 'resolution' END,
          CASE WHEN NEW."resolvedAt" IS NOT NULL THEN 'resolvedAt' END,
          CASE WHEN NEW."resolvedById" IS NOT NULL THEN 'resolvedById' END,
          CASE WHEN NEW."resolvedByCommandId" IS NOT NULL THEN 'resolvedByCommandId' END,
          CASE WHEN NEW."resolvedByRole" IS NOT NULL THEN 'resolvedByRole' END,
          CASE WHEN NEW."resolvedByName" IS NOT NULL THEN 'resolvedByName' END);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN v_col := 'projectId';
  ELSIF NEW."origin" IS DISTINCT FROM OLD."origin" THEN v_col := 'origin';
  ELSIF NEW."revisionId" IS DISTINCT FROM OLD."revisionId" THEN v_col := 'revisionId';
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % is evidence — its % is decided when the request is opened and may not be rewritten. Re-labelling a request''s origin or re-pointing its disposed revision changes what the record says happened.',
      OLD."id", v_col;
  END IF;

  -- THE BIRTH SET AND THE RESOLVER SET ARE NOT THE SAME RULE (#582's review round 8, finding 5).
  -- The first form of this freeze guarded every column with `OLD.<col> IS NOT NULL`, which admits
  -- NULL -> value on all six. For the resolver set that IS the legitimate transition: a request
  -- opens unresolved and gains its closing receipt and actor pair when it closes. For the BIRTH
  -- set it is a forgery route: `sourceCommandId` and the requester pair describe who OPENED the
  -- request, which is settled at INSERT and cannot be learned later. During the drain a direct
  -- UPDATE of a legacy request could set `requestedByRole = 'architect'` alone, or attach an
  -- unrelated unused historical receipt, and the very same freeze would then make the fabricated
  -- value permanent. So the birth set is frozen against ANY update — value, NULL, or blank alike:
  -- a legacy row keeps its NULLs, and a row that owes provenance supplies it at INSERT where the
  -- seals can judge it.
  --
  -- AND THE SET INCLUDES THE PERSON IT IS ABOUT (#582's review round 24, finding 4). The three
  -- columns below are the ones this unit ADDED, and `requestedById` — the DELIVERED column naming
  -- the requester the frozen pair describes — was in neither this set nor the resolver set below.
  -- A freeze over the evidence and not over its subject is not a freeze: a direct update swaps
  -- `requestedById` to somebody else while the immutable role and name still describe the original
  -- requester, and the row then permanently names one person and vouches for another. The
  -- delivered `ChangeRequest_t4b2_seal` freezes `decisionId` alone, so nothing else was holding
  -- it. (A legacy row's NULL stays NULL by the same rule that governs the rest of this set.)
  --
  -- AND THE SET INCLUDES WHAT THE REQUEST ACTUALLY SAID (#582's review round 26, finding 1).
  -- The freeze above is stated over `origin` with the reason "re-labelling a request's origin
  -- changes what the record says happened". `reason`, `costImpact` and `timeImpactDays` ARE what
  -- the record says happened — the ask itself, the money and the time it claimed — and all three
  -- were writable for the life of the row. A PMC closes a request for a 2-day, no-cost change;
  -- afterwards any direct writer rewrites it to a 40-day, 900k change, and the frozen requester
  -- pair above now vouches for an ask that was never made. `createdAt` is the same: when the
  -- request was raised is not a detail of presentation, it is what puts the ask before or after
  -- the approval it contests. Not one writer in the service updates any of the four — the only
  -- two `changeRequest.update*` sites are both CLOSURES — so freezing them against every update
  -- refuses nothing the serving release does, which is what makes it drain-safe rather than
  -- merely correct.
  IF NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId" THEN v_col := 'sourceCommandId';
  ELSIF NEW."requestedById" IS DISTINCT FROM OLD."requestedById" THEN v_col := 'requestedById';
  ELSIF NEW."requestedByRole" IS DISTINCT FROM OLD."requestedByRole" THEN v_col := 'requestedByRole';
  ELSIF NEW."requestedByName" IS DISTINCT FROM OLD."requestedByName" THEN v_col := 'requestedByName';
  ELSIF NEW."reason" IS DISTINCT FROM OLD."reason" THEN v_col := 'reason';
  ELSIF NEW."costImpact" IS DISTINCT FROM OLD."costImpact" THEN v_col := 'costImpact';
  ELSIF NEW."timeImpactDays" IS DISTINCT FROM OLD."timeImpactDays" THEN v_col := 'timeImpactDays';
  ELSIF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN v_col := 'createdAt';
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % records % at its BIRTH and it may not be written, replaced or cleared afterwards — who opened a request is settled when it is opened, and a value filled in later is a claim about an act this row never witnessed.',
      OLD."id", v_col;
  END IF;

  -- The resolver set closes ONCE: NULL -> value is the closure, and value -> anything else
  -- (value -> NULL included) is a rewrite of who closed it.
  --
  -- `resolvedById` IS IN THE SET (#582's review round 24, finding 4) — the same omission as the
  -- birth side, one act later, and the one Codex named. Everything a closure freezes is evidence
  -- ABOUT the resolver: the receipt that was run by them, the role they held, the name they went
  -- by. The column saying WHO is the delivered one, and it was the only part still writable. So
  -- after a valid closure attributing the act to A, a direct update set `resolvedById` to B and
  -- touched nothing else: the three clauses here saw no change, the closure binding fires only on
  -- `resolvedByCommandId` going NULL -> value, and the delivered t4b seal freezes `decisionId`.
  -- The row commits permanently self-contradicting, and no later seal re-examines a closed request.
  -- One-way, exactly like the rest of the set, so the drain shape — a previous-release closure
  -- writing `resolvedById` alone onto an open request — stays admitted.
  --
  -- AND WHEN IT CLOSED, AND WHAT IT CLOSED AS (#582's review round 26, finding 1). Round 24 put
  -- `resolvedById` in this set beside the pair that describes them. `resolvedAt` and `resolution`
  -- were left out, and they are the other two things a closure records: the moment of the act and
  -- its outcome. After a valid withdrawal attributed to A at 09:00, a direct update moved
  -- `resolvedAt` to a week later and `resolution` from `withdrawn` to `reapproved`; every actor
  -- column stayed put and agreed with itself, and the row committed saying a different thing
  -- happened at a different time, by the person who did the original act. The deployed release
  -- writes both in the SAME statement that sets `resolvedById`, NULL -> value, so the one-way
  -- shape the rest of this set already uses admits the real closure untouched and refuses only
  -- the rewrite afterwards.
  IF OLD."resolvedByCommandId" IS NOT NULL AND NEW."resolvedByCommandId" IS DISTINCT FROM OLD."resolvedByCommandId" THEN v_col := 'resolvedByCommandId';
  ELSIF OLD."resolvedById" IS NOT NULL AND NEW."resolvedById" IS DISTINCT FROM OLD."resolvedById" THEN v_col := 'resolvedById';
  ELSIF OLD."resolvedByRole" IS NOT NULL AND NEW."resolvedByRole" IS DISTINCT FROM OLD."resolvedByRole" THEN v_col := 'resolvedByRole';
  ELSIF OLD."resolvedByName" IS NOT NULL AND NEW."resolvedByName" IS DISTINCT FROM OLD."resolvedByName" THEN v_col := 'resolvedByName';
  ELSIF OLD."resolvedAt" IS NOT NULL AND NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" THEN v_col := 'resolvedAt';
  ELSIF OLD."resolution" IS NOT NULL AND NEW."resolution" IS DISTINCT FROM OLD."resolution" THEN v_col := 'resolution';
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % already records % as provenance and it may not be replaced or cleared — the receipt and the frozen actor pair are written ONCE, by the command that performed the act they describe.',
      OLD."id", v_col;
  END IF;

  -- AND "WRITTEN ONCE" IS NOT "WRITTEN ON THE CLOSURE" (#582's review round 16, finding 4).
  -- One-way is a rule about the SECOND write. It says nothing about WHEN the first may happen,
  -- and the arm above admitted each resolver column independently, on any update, with the
  -- request still `open`. So a direct writer prefills a forged `resolvedByRole`/`resolvedByName`
  -- on an open standard request; a still-serving previous-release `withdrawChange` then closes it
  -- by setting the genuine `resolvedById` and leaves the forged pair untouched; nothing compares
  -- the two, the arm above makes the pair immutable from that moment, and 4d-iii's closure trigger
  -- sees no future transition to judge. Permanent false attribution, assembled from two writes
  -- that are each legal on their own.
  --
  -- The resolver set is therefore admitted ONLY on the act it describes: the request LEAVING
  -- `open`, in the same statement, with the pair TRUE of the resolver. The drain shape is
  -- untouched — a previous-release closure writes `resolvedById` and leaves these three NULL,
  -- which stays admitted; 4d-iii is what makes them required.
  -- ONE SET, TWO QUESTIONS (#582's review round 27, finding 1). The block above asks "may this
  -- column be REWRITTEN?" and this one asks "may it be FILLED, here, now?", and until this round
  -- they were asked over DIFFERENT column lists: the rewrite question covered six columns and the
  -- fill question covered three. `resolvedById` was in the first and not the second from round 24;
  -- `resolvedAt` and `resolution` joined the first in round 26 and were not added here either —
  -- three lines apart, in the same function, in the very fold that exists to stop a rule being
  -- implemented over a subset of its own inventory.
  --
  -- What the gap costs: a direct writer puts any valid user id on an OPEN request. Nothing here
  -- sees it, because the fill question never asked about `resolvedById`. The rewrite arm above
  -- then makes it PERMANENT. When the genuine closure arrives — a still-serving previous-release
  -- `withdrawChange` run by somebody else — it is refused for trying to replace the id, and the
  -- request can never be closed by anyone. The same shape prefills a closing MOMENT or an OUTCOME
  -- onto an open request and freezes that.
  --
  -- The two lists are now identical and written in the same order, so the next column added to
  -- one is visibly owed to the other. The drain is untouched: the deployed release writes
  -- `resolvedById`, `resolvedAt`, `resolution` and `status` in ONE statement whose WHERE is
  -- `status = 'open'` (decisions.service.ts, both `changeRequest.updateMany` sites), so the
  -- transition below holds for every real closure it performs.
  IF (OLD."resolvedByCommandId" IS NULL AND NEW."resolvedByCommandId" IS NOT NULL)
     OR (OLD."resolvedById" IS NULL AND NEW."resolvedById" IS NOT NULL)
     OR (OLD."resolvedByRole" IS NULL AND NEW."resolvedByRole" IS NOT NULL)
     OR (OLD."resolvedByName" IS NULL AND NEW."resolvedByName" IS NOT NULL)
     OR (OLD."resolvedAt" IS NULL AND NEW."resolvedAt" IS NOT NULL)
     OR (OLD."resolution" IS NULL AND NEW."resolution" IS NOT NULL) THEN
    IF NOT (OLD."status" = 'open' AND NEW."status" <> 'open') THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % gains resolver provenance on an update that does not CLOSE it (`%` -> `%`) — the receipt and the frozen pair describe the act of closing, and a value written at any other moment is a claim about an act this update did not perform.',
        OLD."id", OLD."status", NEW."status";
    END IF;
    IF NEW."resolvedById" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % records resolver provenance with no `resolvedById` — a role and a name with nobody to be true of is not attribution.',
        OLD."id";
    END IF;
    -- the pair is EVIDENCE, so it is judged exactly as every other frozen pair in this unit is:
    -- the role must be one the resolver holds, and the name must be the register's.
    IF NEW."resolvedByRole" IS NOT NULL THEN
      PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."resolvedById", NEW."resolvedByRole",
                                     NEW."resolvedByName", 'ChangeRequest ' || NEW."id");
    END IF;

  END IF;

  -- ── THE REQUEST'S LIFECYCLE, GOVERNED ONCE (#582's review round 31) ───────────────────────
  --
  -- Round 30 put two rules about WHAT a closure says INSIDE the branch that governs WHEN its
  -- values may be written, and Codex found three holes in that placement within one round:
  --
  --   · a later status-only update touches no resolver column, so the outer branch is false and
  --     neither rule ran — `resolved`/`reapproved` could become `withdrawn`, or `open`, with the
  --     outcome frozen and now contradicting it, and a reopened request STRANDED because its
  --     frozen resolver fields can never take part in another closure;
  --   · the agreement rule was guarded by `NEW."resolution" IS NOT NULL`, so a closure that simply
  --     OMITS the outcome skipped it — and that row cannot be repaired afterwards, because filling
  --     the outcome later is refused once the row has left `open`;
  --   · the moment was bounded below by the request's own birth rather than by this transaction,
  --     so a request opened in January and closed in September could be stamped August.
  --
  -- Three holes, one cause: a rule about WHAT, written inside a branch scoped to WHEN. That is
  -- round 27's defect exactly, committed inside the fix for it. So this is no longer a clause
  -- bolted to the freeze — the request has three states and two legal moves, and this section
  -- states the whole machine at function level where every UPDATE reaches it.
  --
  --   open → resolved   (outcome `reapproved`)   `decisions.service.ts:496`
  --   open → withdrawn  (outcome `withdrawn`)    `decisions.service.ts:930`
  --   anything else                              refused
  --
  -- A LEGACY row already closed with NULLs keeps them: the completeness demand is made of the
  -- CLOSURE, not of the row, so a historical row that never had an outcome is untouched unless
  -- something tries to move it.
  IF OLD."status" = 'open' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    -- (a) THE MOVE ITSELF must be one the system performs, outcome and status together.
    -- `IS NOT DISTINCT FROM`, not `=`: a NULL outcome makes `= 'reapproved'` evaluate to NULL,
    -- the disjunction NULL, and `NOT NULL` NULL — so the plain comparison SILENTLY ADMITS the
    -- closure that names no outcome at all, which is the very row finding 3 is about. Three-valued
    -- logic turns a refusal into a pass wherever the value under test may be absent.
    IF NOT ((NEW."status" = 'resolved'  AND NEW."resolution" IS NOT DISTINCT FROM 'reapproved')
         OR (NEW."status" = 'withdrawn' AND NEW."resolution" IS NOT DISTINCT FROM 'withdrawn')) THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % closes as `%` with outcome `%`, which is not a closure this system performs — a request is either RESOLVED by a reapproval or WITHDRAWN, and a status that disagrees with its own recorded outcome (or names none at all) is a permanent record of an act nobody carried out.',
        OLD."id", NEW."status", COALESCE(NEW."resolution", '<none>');
    END IF;

    -- (b) THE CORE SET IS COMPLETE. Both serving writers supply the outcome, the moment and the
    -- resolver in the same statement, so requiring them refuses nothing the product does — and a
    -- closure missing one is UNREPAIRABLE, because the one-way arms above refuse to fill it once
    -- the row has left `open`. The frozen role/name PAIR is deliberately not required here: it
    -- stays optional through the drain and 4d-iii is what makes it owed.
    IF NEW."resolvedAt" IS NULL OR NEW."resolvedById" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % closes without recording % — a closure that does not say WHEN it happened or WHO performed it cannot be completed later, because this row may never leave `%` again.',
        OLD."id",
        CASE WHEN NEW."resolvedAt" IS NULL AND NEW."resolvedById" IS NULL THEN 'when it closed or who closed it'
             WHEN NEW."resolvedAt" IS NULL THEN 'when it closed' ELSE 'who closed it' END,
        NEW."status";
    END IF;

    -- (c) THE MOMENT IS THIS STATEMENT'S. Round 30 bounded it below by `createdAt`, which admits
    -- any fabricated point in a request's whole open life — a September closure stamped August is
    -- neither before creation nor in the future, and the freeze then makes it evidence. The bound
    -- is the closing WRITE in both directions, widened only by the skew a real writer has: the
    -- serving release computes `new Date()` in the API process and commits milliseconds later.
    --
    -- AND THE CLOCK IS `statement_timestamp()`, NOT `now()` (#582's review round 32, finding 4).
    -- `now()` / `CURRENT_TIMESTAMP` is fixed at the FIRST statement of the transaction and never
    -- moves again, so round 30's bound was never "this closing write" — it was "whenever this
    -- transaction began". In anything but a single-statement transaction the two are different
    -- times, and the error runs both ways: a maintenance or batch transaction open for ten minutes
    -- freezes its start as the only admissible closure moment, so an honest `new Date()` taken at
    -- the real write is REFUSED as nine minutes in the future; and a closure stamped with that
    -- stale start time — a moment that has already passed — is ACCEPTED as current. A seal that
    -- judges when an act happened has to read a clock that advances with the act.
    -- `statement_timestamp()` is that clock: it is the moment this UPDATE began, whatever came
    -- before it in the transaction.
    --
    -- And the product is not outside this. Both serving closures run inside `executeCommand`,
    -- which reserves its receipt, writes the fact and then closes the request — several statements,
    -- so `now()` was already the wrong clock for them and they passed only because those
    -- transactions are short. The seal was measuring how long the enclosing command had been
    -- running, in a rule about when a person closed a request. Under `statement_timestamp()` the
    -- short transaction behaves exactly as before and the long one is judged correctly.
    IF NEW."resolvedAt" < statement_timestamp() - interval '1 minute'
       OR NEW."resolvedAt" > statement_timestamp() + interval '1 minute' THEN
      RAISE EXCEPTION
        'phase6 4d-i: change request % records its closure at %, but this closing statement is running at % — a closure happens when it happens, and a moment outside the writer''s own clock skew is evidence of an act that did not occur then.',
        OLD."id", NEW."resolvedAt", statement_timestamp();
    END IF;

  ELSIF OLD."status" <> 'open' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    -- (d) CLOSED IS TERMINAL. Nothing in this unit froze `status` itself, so a closed request could
    -- be moved again — to the other outcome, contradicting the frozen `resolution`, or back to
    -- `open`, which strands it permanently: its resolver columns are one-way and can never take
    -- part in another closure.
    RAISE EXCEPTION
      'phase6 4d-i: change request % is already closed as `%` and may not become `%` — a closure is the end of a request''s life, and its recorded outcome, moment and resolver are immutable evidence of that one act.',
      OLD."id", OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_evidence_frozen" ON "ChangeRequest";
-- BEFORE INSERT OR UPDATE from round 35: one seal over a request's whole life, rather than a
-- lifecycle stated over transitions with the birth left unjudged.
CREATE TRIGGER "ChangeRequest_t4d_evidence_frozen" BEFORE INSERT OR UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_evidence_frozen();

-- #582's review round 26, finding 3 — the fourth member of the identity inventory. The seal is
-- the shared `phase6_t4d_identity_frozen` installed by the registers half; the trigger lives here
-- because this is where `ChangeRequest`'s other seals are created.
DROP TRIGGER IF EXISTS "ChangeRequest_t4d_identity" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_identity" BEFORE UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_identity_frozen();
-- ── and the CLOSURE receipt is judged too (#582's review round 22, finding 2) ────────────────
-- THE SIBLING ROUND 20's FINDING 1 LEFT STANDING. That round found `ChangeRequest.sourceCommandId`
-- frozen and never judged, and bound it: round 8 had made it immutable on landing and round 17 had
-- bound the requester PAIR to its actor, and between them nothing asked what the receipt IS. The
-- fix was applied to the BIRTH receipt and stopped there. `resolvedByCommandId` is the same column
-- one act later — a receipt, frozen one-way by the arm above, with a composite FK and a one-use
-- UNIQUE index and nothing that reads its command type, its actor or its transaction.
--
-- So the same forgery, at the closure: a direct writer supplies a TRUTHFUL resolver pair (round
-- 16's arm is satisfied), cites any unused same-project `CommandExecution` (the FK is satisfied,
-- the unique index is satisfied), closes the request and performs an otherwise-valid restoration.
-- The one-way freeze then makes that false provenance permanent, and 4d-iii's seals judge future
-- writes only — there is no later moment at which an already-closed row is re-examined.
--
-- THE COMMAND SET IS DERIVED, not listed from memory. §A.3 obligation 6 states it as a rule about
-- the ACT: `resolvedByCommandId` is owed by EVERY command that writes `resolvedById`, which the
-- delivered service says is `decisions.withdrawChange` and `decisions.approve`'s re-approval
-- closure (#572's review rounds 5 and 6 — round 5 named `withdrawChange` alone and round 6 found
-- that an ordinary re-approval from `change` would roll back for it). Naming one of the two here
-- would refuse an ordinary re-approval the moment 4d-ii populates the column.
--
-- AND THE RESULT DIFFERS BY COMMAND, which is why this is its own function rather than a branch of
-- `phase6_t4d_provenance_bound`: a `withdrawChange` receipt's result is the REQUEST it closed, and
-- an `approve` receipt's result is the DECISION it moved — the closure is a consequence of that
-- approval, not its result. One token meaning two things is the defect rounds 3 and 5 corrected in
-- the contract oracle; the two shapes are spelled separately here for the same reason.
--
-- DEFERRED, so 4d-ii may write the receipt and the command's completion in either order within
-- its transaction, exactly as every other provenance binding in this unit is deferred.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_closure_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  SELECT "status", "resultRef", "commandType", "actorId",
         "xmin" = txid_current()::text::xid AS "receiptThisTx"
    INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."resolvedByCommandId";

  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % cites a closure receipt that did not succeed in this transaction — the receipt must be COMPLETED by the command that closed the request',
      NEW."id";
  END IF;
  IF NOT COALESCE(c."receiptThisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % cites closure receipt %, which was completed by an EARLIER transaction — a receipt lying around from a past withdrawal or approval cannot back a closure performed now, and the freeze above makes the claim permanent',
      NEW."id", NEW."resolvedByCommandId";
  END IF;
  IF c."commandType" NOT IN ('decisions.withdrawChange', 'decisions.approve') THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % cites a `%` closure receipt, which is not a command that closes a request (expected `decisions.withdrawChange` or `decisions.approve`) — provenance names the act, and a receipt borrowed from an unrelated command proves nothing about this one',
      NEW."id", c."commandType";
  END IF;
  IF c."actorId" IS DISTINCT FROM NEW."resolvedById" THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % attributes its closure to %, but its receipt was run by % — the closure and the receipt are one act seen twice, and a truthful resolver pair naming someone who ran no command is exactly the forgery the frozen pair exists to prevent',
      NEW."id", COALESCE(NEW."resolvedById", '<null>'), COALESCE(c."actorId", '<null>');
  END IF;

  -- the RESULT, AND IT IS THE SAME SHAPE FOR BOTH WRITERS (#582's review round 23, finding 2).
  --
  -- Round 22 split this by command and demanded, of a withdrawal, a `resultRef` naming the REQUEST
  -- — reasoning, in its own message, that "a withdrawal's result IS the request it closed". §D had
  -- already settled the question the other way, and settled it about this exact pair of writers:
  -- the admitted closure shape is "a `resultRef` naming the closed row's `decisionId`, which is
  -- what both writers already return", and re-pointing `withdrawChange`'s receipt at the
  -- `ChangeRequest` is listed there under "Deliberately NOT done" — a command whose subject is the
  -- decision does not get its receipt moved so that a seal can recognise it.
  --
  -- So round 22's arm was not a strengthening but a REGRESSION against a ruling, and one that
  -- breaks rather than over-refuses: `decisions.service.ts` completes `decisions.withdrawChange`
  -- with `resultRef: decisionId`, so from the moment 4d-ii writes `resolvedByCommandId` every
  -- ordinary withdrawal would reach commit carrying the correct same-transaction receipt and roll
  -- back here. The rule a seal enforces is the plan's, not the one the seal's author finds
  -- persuasive while writing it.
  --
  -- One check, not two: the closure's receipt names THIS row's decision. The commandType gate
  -- above still says WHICH commands may close a request; this says what their result must be.
  --
  -- THE WHOLE `resultRef` INVENTORY, since the defect was a shape invented where the plan had
  -- ruled, and the question is therefore "where else does this unit assert a result shape". Three
  -- sites, all now agreeing with §D: the generic `phase6_t4d_provenance_bound` above admits the
  -- row itself or the bundle's PRIMARY fact (§D's two shapes); `phase6_t4d_membership_transition_bound`
  -- in the register half admits the membership id, which is what §D says all three member commands
  -- return; and this one, §D's third shape, for a CLOSURE. No fourth site asserts one.
  IF c."resultRef" IS DISTINCT FROM NEW."decisionId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % cites a `%` closure receipt whose result names %, not this request''s decision % — a closure''s receipt belongs to the command that MOVED the decision, so its result is that decision and a receipt for another result cannot be borrowed',
      NEW."id", c."commandType", COALESCE(c."resultRef", '<null>'), NEW."decisionId";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_closure_bound" ON "ChangeRequest";
CREATE CONSTRAINT TRIGGER "ChangeRequest_t4d_closure_bound"
  AFTER UPDATE ON "ChangeRequest" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."resolvedByCommandId" IS NOT NULL AND OLD."resolvedByCommandId" IS NULL)
  EXECUTE FUNCTION phase6_t4d_change_request_closure_bound();


-- ── and the BIRTH pair is JUDGED, not merely shaped and then frozen ──────────────────────────
-- #582's review round 17, the class-3 sweep — the SIBLING COLUMN SET of round 16's finding 4, in
-- the very trigger that fix was written into.
--
-- Round 16 gave the RESOLVER pair its correspondence: admitted only on the closure, naming a
-- resolver, with the pair judged by `phase6_t4d_actor_bound`. The BIRTH pair sitting three arms
-- above it got the other half of round 16's answer — frozen against ANY update, so it cannot be
-- filled in later — and nothing ever asked whether the value it is born with is TRUE. Its whole
-- protection is the CHECK: both halves or neither, each nonblank. Both are rules about SHAPE.
--
-- So a writer that opens a request legitimately — a real `requestedById`, a real project — may
-- freeze `requestedByRole = 'architect'` and any name it likes against it, and the freeze this
-- unit added then makes that permanent evidence. That is the same sentence round 16 wrote about
-- the consultation pair and about the resolver pair, at the third of the three tables, left
-- standing because the sweep of that round ran along the tables the findings NAMED.
--
-- Two consequences, not one: the pair is what `DecisionLogScreen` and the reapproval notice
-- render as the requester's byline, and §A.3 obligation 7 compares it against the envelope of
-- the event that records the same act — so a forged birth pair also decides what the
-- correspondence between fact and event is measured against.
--
-- A SEPARATE TRIGGER rather than an arm inside `phase6_t4d_change_request_project`: that seal's
-- rule is the drain shim for `projectId` and nothing else, and a seal whose name states one rule
-- while its body judges two is the exact defect this PR's round 1 produced an oracle for.
--
-- The drain shape is untouched: the previous release's `requestChange` writes neither half, the
-- CHECK admits the all-null pair, and this returns before judging anything. 4d-iii is what makes
-- the pair required.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_birth_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- SHAPE IS THE CHECK'S, AND THIS TRIGGER MAY NOT ANSWER FOR IT. A row constraint is evaluated
  -- AFTER every BEFORE trigger has run, so a half or blank pair reaching here is a row the CHECK
  -- is about to refuse by name — and judging it first would replace
  -- `ChangeRequest_requested_pair_check` in the error an operator sees, and in the probe that
  -- proves the CHECK exists. (Measured: it did exactly that when this seal was first written.)
  -- One object, one rule: the CHECK owns both-or-neither and nonblank, this owns correspondence.
  IF NEW."requestedByRole" IS NULL OR NEW."requestedByName" IS NULL
     OR btrim(NEW."requestedByRole", E' \t\n\x0B\f\r') = ''
     OR btrim(NEW."requestedByName", E' \t\n\x0B\f\r') = '' THEN
    RETURN NEW;                       -- the legacy / drain shape, or a row the CHECK will refuse
  END IF;
  IF NEW."requestedById" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % is born with the requester pair (`%`, `%`) and no `requestedById` — a role and a name with nobody to be true of is not attribution.',
      NEW."id", NEW."requestedByRole", NEW."requestedByName";
  END IF;
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."requestedById", NEW."requestedByRole",
                                 NEW."requestedByName", 'ChangeRequest ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_birth_pair" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_birth_pair" BEFORE INSERT ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_birth_pair();

-- The change request joins the same binding, CONDITIONALLY (#582 round 20, finding 1). The three
-- facts above always carry a receipt; a change request may not — the currently deployed
-- `requestChange` writes none, and 4d-iii is what makes it required — so the drain's all-null
-- shape must stay admitted. A `WHEN` clause is the right instrument rather than an early RETURN in
-- the body: the trigger does not fire at all for a legacy row, so nothing about the previous
-- release's writes changes, and the rule reads off the trigger definition instead of off a branch
-- inside a function shared with three tables that do not need it.
DROP TRIGGER IF EXISTS "ChangeRequest_t4d_source_bound" ON "ChangeRequest";
CREATE CONSTRAINT TRIGGER "ChangeRequest_t4d_source_bound"
  AFTER INSERT ON "ChangeRequest"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."sourceCommandId" IS NOT NULL)
  EXECUTE FUNCTION phase6_t4d_provenance_bound();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3f — THE DELIVERED SEALS, WIDENED
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Everything above ADDS. This part CHANGES delivered behaviour, so each edit states what it
-- opens and why the opening cannot be used for anything else.

-- ── the holder freeze gains exactly ONE opening ──────────────────────────────────────────────
-- `decision_t4b_attribution_seal` is the trigger that ACTUALLY freezes the holder — its
-- published-or-attributed arm refuses any change to `deciderKind` or `deciderMembershipId`. Not
-- `phase6_t4b2_decision_seal`, whose arms are the role arms; naming the wrong one is how a
-- previous round's fix reached the wrong object.
--
-- THREE changes, in ONE `CREATE OR REPLACE`, and nothing else moves:
--
--   (1) THE FORWARD DOOR. The holder freeze admits a change accompanied by a same-transaction
--       `DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns, whose
--       `toDesignation` EQUALS the NEW ones, and whose two designations DIFFER. Mere row
--       presence is forgeable — a hostile transaction could insert a forward naming unrelated
--       designations and re-home the holder to a third member — so the seal compares the
--       transition to its evidence FIELD-FOR-FIELD, and the forward's own INSERT seal compares
--       `from` against the decision's CURRENT holder. Together they force the order: the
--       forward is written FIRST, the holder moves second, and neither is valid without the
--       other.
--
--   (2) THE TUPLE-WRITE ARM admits `→ awaiting_countersign` beside `→ approved`. Under a chain
--       the approval is PROVISIONAL: the tuple is written by the provisional act exactly as the
--       finalizing act wrote it, and the delivered arm — which admits the tuple's first write
--       only on `pending`/`change → approved` — would abort that transition before any 4d
--       pairing seal ran (#567's review round 2, finding 3).
--
--   (3) THE STANDING ARM admits `change → awaiting_countersign` beside `change → approved`, and
--       ONLY from `change`. The chain reapproval leaves `change` provisionally; an `approved`
--       decision never returns to awaiting, so that direction stays refused.
--
-- The INSERT clause is KEPT unchanged: a tuple belongs only to an approved decision, because a
-- decision is never BORN awaiting — the approved-entry seal's INSERT arm below refuses that
-- outright, and the seed plants no such row.
CREATE OR REPLACE FUNCTION decision_t4b_attribution_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_writes_tuple BOOLEAN;
  v_forwarded    BOOLEAN;
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

    -- Phase 6 unit 4d-i, change (1): the ONE opening in the holder freeze. Evaluated only when
    -- the holder actually moves, so an ordinary update pays nothing for it.
    v_forwarded := FALSE;
    IF (NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
        OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId") THEN
      -- IN THIS TRANSACTION (Codex round 1, finding 8). Without the `xmin` predicate this door
      -- accepted ANY historical forward fact: after legitimate moves A→B and B→A, a third direct
      -- update A→B reuses the FIRST append-only fact, passes, and moves the holder with no new
      -- fact, no command receipt, no event, no audit row and no notice. The refusal message below
      -- already said "a same-transaction row"; now the query says it too.
      v_forwarded := EXISTS (
        SELECT 1 FROM "DecisionForward" f
         WHERE f."projectId" = OLD."projectId" AND f."decisionId" = OLD."id"
           AND f."fromDesignationKind" = OLD."deciderKind"::text
           AND f."fromDesignationMembershipId" IS NOT DISTINCT FROM OLD."deciderMembershipId"
           AND f."toDesignationKind" = NEW."deciderKind"::text
           AND f."toDesignationMembershipId" IS NOT DISTINCT FROM NEW."deciderMembershipId"
           AND f."xmin" = txid_current()::text::xid
      );
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
    ) AND NOT v_forwarded THEN
      RAISE EXCEPTION 'phase6-4b: a published or attributed decision keeps its holder — the decider tuple is frozen (%). Phase 6 unit 4d opens exactly one door: a same-transaction "DecisionForward" row recording THIS hand-off, from the holder the decision actually carries to the one it is moving to.', OLD."id";
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
    --
    -- Phase 6 unit 4d-i, change (3): `change → awaiting_countersign` joins the permitted
    -- destinations, and ONLY from `change` — the chain reapproval leaves `change`
    -- provisionally, while an `approved` decision never returns to awaiting.
    IF OLD."status"::text IN ('approved', 'change')
       AND NEW."status"::text NOT IN ('approved', 'change')
       AND NOT (OLD."status"::text = 'change' AND NEW."status"::text = 'awaiting_countersign') THEN
      RAISE EXCEPTION 'phase6-4b: an approval-bearing decision cannot leave approved/change standing (%).', OLD."id";
    END IF;

    v_writes_tuple := OLD."approvedDeciderKind" IS NULL
      AND NEW."approvedDeciderKind" IS NOT NULL;
    -- Phase 6 unit 4d-i, change (2): a PROVISIONAL approval writes the tuple exactly as the
    -- finalizing act would, so `→ awaiting_countersign` joins `→ approved` here.
    IF v_writes_tuple AND NOT (
      OLD."status"::text IN ('pending', 'change')
      AND NEW."status"::text IN ('approved', 'awaiting_countersign')
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

-- ── the approved-entry seal ──────────────────────────────────────────────────────────────────
-- Every entry into `awaiting_countersign` is sealed FROM THE DECISION SIDE: legal only FROM
-- `pending`/`change`, and only under an ACTIVE chain. Its INSERT arm refuses a decision BORN
-- awaiting outright (#567's review round 2, finding 2): after 4d-iii drops
-- `Decision_t4d_awaiting_reserved`, a direct INSERT of a published row already carrying the
-- status would pass the delivered 4b INSERT seal — which judges publication and holder standing
-- — and commit with no provisional revision, receipt, demand event, audit row or notice. That is
-- a head the countersign and the stranded resolution could never finalize. The state is ENTERED
-- through the sealed transition, never born.
CREATE OR REPLACE FUNCTION phase6_t4d_approved_entry_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text = 'awaiting_countersign' THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % may not be BORN `awaiting_countersign` — the state is entered by the sealed provisional-approval transition, and a row inserted straight into it carries no provisional revision, no receipt and no demand event, so nothing could ever finalize it',
        NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status"::text = 'awaiting_countersign' AND OLD."status"::text <> 'awaiting_countersign' THEN
    IF OLD."status"::text NOT IN ('pending', 'change') THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % may not enter `awaiting_countersign` from `%` — a provisional approval is made from an OPEN decision',
        OLD."id", OLD."status";
    END IF;
    -- THE STANDING READ IS FENCED (#582 round 11, finding 4). The delivered 4b lifecycle trigger
    -- takes the project readiness key for publication and for `approved → change`, and for
    -- neither of the two transitions judged here. Without it the count below is read outside the
    -- fence that serialises standing changes against decision writes: this transaction reads ONE
    -- architect and pauses; the last architect's removal takes the key, sees only the
    -- still-committed open decision, decrements the count to zero and commits; this transaction
    -- then commits a decision awaiting a countersigner who no longer exists — stranded from
    -- birth, which is the exact state the arm below exists to prevent. Taking the key first makes
    -- the two orderings the only two outcomes: one lands a direct approval, the other lands an
    -- awaiting transition with an architect still present.
    --
    -- `phase6_try_readiness` rather than a wait, for the reason the revision birth seal gives:
    -- a trigger that blocks on a lock held elsewhere turns a refusal into a hang.
    IF NOT phase6_try_readiness(OLD."projectId") THEN
      RAISE EXCEPTION
        'phase6 4d-i: the project readiness key is held elsewhere — decision %''s entry into `awaiting_countersign` is refused rather than judged against an architect count another transaction is moving',
        OLD."id";
    END IF;
    IF platform_role_standing(OLD."projectId", 'architect') = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i: project % holds no ACTIVE architect, so decision % cannot enter `awaiting_countersign` — with the chain off an approval lands `approved` directly, and a decision left awaiting a countersigner who does not exist is stranded from birth',
        OLD."projectId", OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- NAMED so it sorts AFTER both `Decision_t4d_architect_reserved` and
-- `Decision_t4d_awaiting_reserved`. PostgreSQL fires same-kind triggers in NAME order, and while
-- the reservation stands the DOOR must be the thing that refuses — its message names the drain
-- directive an operator can act on, where this seal would report "no active architect", which is
-- true but sends the reader somewhere else. `entry` sorts after `architect`/`awaiting`;
-- `approved_entry` would have sorted before both.
DROP TRIGGER IF EXISTS "Decision_t4d_approved_entry" ON "Decision";
DROP TRIGGER IF EXISTS "Decision_t4d_entry_seal" ON "Decision";
CREATE TRIGGER "Decision_t4d_entry_seal" BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_approved_entry_seal();

-- ── the LAST reservation door ────────────────────────────────────────────────────────────────
-- `DecisionForward` is reserved with the other four (§A.2). Forwarding needs no architect, so
-- without this door 4d-ii's `decisions.forward` would emit `decision.forwarded` while an
-- ALREADY-RUNNING previous-release push worker — fenced by the consumer version bump only when
-- it RESTARTS — could still claim that delivery, know no `forward` family, and take the
-- unguarded send path. Dropped by the same single 4d-iii statement as the other four.
DO $$
DECLARE tg pg_trigger;
BEGIN
  IF phase6_t4d_retired_at_start() THEN RETURN; END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'DecisionForward_t4d_reserved'
     AND tgrelid = '"DecisionForward"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "DecisionForward_t4d_reserved" BEFORE INSERT ON "DecisionForward"
      FOR EACH ROW EXECUTE FUNCTION phase6_t4d_reserved('DecisionForward');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 7 THEN               -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4)
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward_t4d_reserved exists but does not reserve the table (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- -- the two 4c consultation seals, open set widened ------------------------------------------
-- These CANNOT be widened by a second trigger: the delivered seals REFUSE an
-- `awaiting_countersign` decision, and no other trigger can un-refuse what one has raised on. So
-- both functions are reproduced here VERBATIM with exactly ONE token changed in each -- the open
-- set gains `awaiting_countersign` -- and nothing else moves.
--
-- In particular the REQUESTER ARM stays on `phase6_user_decision_authority`, byte-identical.
-- That is the WINDOW RULE of A.2 (#566's review round 2, finding 1): through the drain a
-- membership-less org owner/admin has no fanned-out `pmc` row, so re-pointing the arm onto the
-- register here would refuse exactly the requester the delivered access path authorizes.
-- 4d-iii re-points it after the fenced re-projection, when the register can answer.
--
-- The bodies are PINNED before they are replaced. `CREATE OR REPLACE` on a function whose
-- delivered body has changed since would silently revert that change, so the migration asserts
-- the body it is about to overwrite is the one it was written against and ABORTS otherwise --
-- the same claim the repository's `t3c seals` preflight makes about function-BODY identity.
--
-- BOTH THE PIN AND THE REPLACEMENT ARE MARKER-AWARE (#582 round 13, finding 2). Round 2's finding
-- 10 established this rule for the correspondence trigger and I applied it there and nowhere else
-- — the same one-site habit round 12 named. On the supported P3005 replay of a MATURE database,
-- `RolloutRetirement` already carries phase6-4d and 4d-iii has already replaced this seal with its
-- post-retirement body; an unconditional `CREATE OR REPLACE` here overwrites that body with the
-- window body, whose requester check calls `phase6_user_decision_authority` — a predicate that
-- refuses an explicit `architect` membership, while the post-retirement service admits architects
-- through the platform standing register. Every architect consultation request would fail from
-- this migration's commit until 4d-iii is replayed, and indefinitely if that replay fails.
--
-- The pin moves with the replacement: its fragment describes the WINDOW body, so asserting it
-- against a retired database would abort a replay that is behaving correctly.
DO $pin$
DECLARE v_body TEXT; v_name TEXT;
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the 4c consultation seals keep their POST-RETIREMENT bodies (this is a replay over a retired database)';
    RETURN;
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'phase6_t4c_consultation_request_seal', 'phase6_t4c_consultation_response_seal'
  ] LOOP
    SELECT prosrc INTO v_body FROM pg_proc WHERE proname = v_name;
    IF v_body IS NULL THEN
      RAISE EXCEPTION 'phase6 4d-i: % does not exist -- 4d-i widens the 4c consultation open set and cannot do so over a database that never installed it', v_name;
    END IF;
    -- Nested dollar quoting, so the searched fragment carries its own single quotes
    -- literally and no doubling has to be got right by eye.
    IF strpos(v_body, $frag$'pending', 'change'$frag$) = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i ABORT: the body of % no longer carries the delivered open set this migration was written to widen. Replacing it now would silently revert whatever changed it. Re-derive the widening against the current body before deploying. See docs/RUNBOOK.md P6T4D.',
        v_name;
    END IF;
  END LOOP;
END $pin$;

-- MARKER-AWARE (#582 round 13, finding 2): on a replay over a database 4d-iii has already
-- retired, these two seals already carry their POST-retirement bodies and must keep them.
DO $t4c_widen$ BEGIN
IF phase6_t4d_retired_at_start() THEN RETURN; END IF;
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
  IF d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
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
  IF NOT FOUND OR d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
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
END $t4c_widen$;

-- ── the architect arms: SEPARATE triggers, the delivered arms untouched ──────────────────────
-- §D asks for "SEPARATE architect arms over `platform_role_standing`, the delivered `client`/`pmc`
-- arms untouched" (#565's review round 1, finding 1). Separate TRIGGERS, not a rewritten
-- function: `phase6_t4b2_decision_seal` and `phase6_t4b2_membership_guard` are large delivered
-- objects, and reproducing either to add one arm risks reverting a change made since. A second
-- trigger adds refusals without touching a byte of the first, and `t4d` sorts after `t4b2`, so
-- the delivered arms still refuse first for every role they already judge.
--
-- WHY THE ARCHITECT ARM READS A DIFFERENT PRIMITIVE: `phase6_effective_role_standing` answers
-- for `client`/`pmc` and knows nothing of `architect` — it is the delivered orgs derivation, and
-- teaching it the new role would put the chain's meaning in the wrong module. The architect
-- count lives in the platform register, so the architect arm reads `platform_role_standing`.

CREATE OR REPLACE FUNCTION phase6_t4d_holder_standing_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deciderKind"::text <> 'architect' THEN RETURN NEW; END IF;

  -- A row born ALREADY PUBLISHED, and the publication boundary, and the reopen — the same three
  -- boundaries the delivered seal judges for `client`/`pmc`, asked of the architect role.
  IF (TG_OP = 'INSERT' AND NEW."publishedAt" IS NOT NULL
      AND NEW."status"::text IN ('pending', 'change'))
     OR (TG_OP = 'UPDATE' AND OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND OLD."status"::text = 'approved' AND NEW."status"::text = 'change') THEN
    IF platform_role_standing(NEW."projectId", 'architect') = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i: this project has no active architect — a decision designated to the architect role would be born with nobody able to decide it (decision %)',
        NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_holder_standing" ON "Decision";
CREATE TRIGGER "Decision_t4d_holder_standing" BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_holder_standing_seal();

-- ── the membership guard's widened open set, and its ONE named exemption ─────────────────────
-- P39 states the rule exactly, and it is two claims, not one:
--
--   * THE OPEN SET WIDENS. An `awaiting_countersign` decision is OPEN, so removing or re-roling
--     its NAMED holder, or the last active member of its ROLE designation, is refused — at the
--     command through `holdsOpenDecisions` (4d-ii) and here at the database.
--
--   * THE ONE EXEMPTION. Removing the LAST ARCHITECT is NOT refused, even when that architect is
--     the named holder of an awaiting decision or the last member of the architect ROLE
--     designation it names. That departure DEACTIVATES the chain and STRANDS the decision, which
--     is a defined state with a named command to resolve it
--     (`decisions.resolveStrandedCountersign`); refusing it would instead trap the project —
--     the architect could never leave while any decision awaited their countersign.
--
--   The exemption is narrow in both directions, and both are probed:
--     · a named holder who IS an architect but NOT the last is REFUSED, naming the pending
--       countersign — the chain survives their departure, so the decision is not stranded and
--       has no defined resolution;
--     · a `pending`/`change` decision designated to the architect ROLE still REFUSES removing
--       its last architect — that decision is not awaiting a countersign, it is waiting for a
--       DECISION, and stranding has nothing to say about it.
--
-- The delivered `phase6_decisions_hold_role` / `phase6_decisions_name_membership` are LEFT
-- ALONE. Widening them would make the DELIVERED guard — which has no exemption — refuse the last
-- architect's departure, which is the one thing this rule exists to permit. So the widened open
-- set lives in this trigger's own predicates.
--
-- AFTER ROW, like the guard it sits beside, and the count it reads is therefore the POST-write
-- one: `Membership_t4d_role_standing` is a BEFORE trigger and has already applied its delta.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_project    TEXT := COALESCE(NEW."projectId", OLD."projectId");
  v_lost_role  TEXT;
  v_membership TEXT;
  v_architects INT;
BEGIN
  -- Only a write that can REDUCE holder-relevant standing is judged; a pure display or limit
  -- update passes untouched, exactly as the delivered guard decides it.
  IF TG_OP = 'UPDATE'
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF OLD."status" <> 'active' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'active' AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;

  v_lost_role  := OLD."role";
  v_membership := OLD."id";
  v_architects := platform_role_standing(v_project, 'architect');

  IF NOT phase6_try_readiness(v_project) THEN
    RAISE EXCEPTION 'phase6 4d-i: the project readiness key is contended — retry this membership change (project %)', v_project;
  END IF;

  -- (a) the NAMED holder of an AWAITING decision
  IF EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = v_project AND d."deciderMembershipId" = v_membership
       AND d."publishedAt" IS NOT NULL AND d."status"::text = 'awaiting_countersign'
  ) AND NOT (v_lost_role = 'architect' AND v_architects = 0) THEN
    RAISE EXCEPTION
      'phase6 4d-i: membership % is the named holder of a decision awaiting countersign — resolve or forward it before removing them (project %). The one exception is the LAST architect leaving, which deactivates the chain and strands the decision for `decisions.resolveStrandedCountersign`; this project still holds % active architect(s).',
      v_membership, v_project, v_architects;
  END IF;

  -- (b) the last active member of a ROLE designation
  IF v_lost_role = 'architect' AND v_architects = 0 THEN
    -- The exemption covers AWAITING decisions only. A `pending`/`change` decision designated to
    -- the architect role is waiting for a DECISION, not for a countersign, and stranding has
    -- nothing to say about it.
    IF EXISTS (
      SELECT 1 FROM "Decision" d
       WHERE d."projectId" = v_project AND d."deciderKind"::text = 'architect'
         AND d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change')
    ) THEN
      RAISE EXCEPTION
        'phase6 4d-i: this change leaves NO active architect while a published OPEN decision is designated to that role (project %) — such a decision is waiting to be DECIDED, not countersigned, so no stranded resolution covers it; forward it or restore standing first',
        v_project;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = v_project AND d."deciderKind"::text = v_lost_role
       AND d."publishedAt" IS NOT NULL AND d."status"::text = 'awaiting_countersign'
  ) AND (
    (v_lost_role = 'architect' AND v_architects = 0)
    OR (v_lost_role <> 'architect' AND phase6_effective_role_standing(v_project, v_lost_role) = 0)
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: this change leaves NO effective % holder while a decision awaiting countersign is designated to that role (project %) — cover it first',
      v_lost_role, v_project;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_holder_guard" ON "Membership";
CREATE TRIGGER "Membership_t4d_holder_guard"
  AFTER UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_guard();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3e (cont.) — THE APPROVAL REGISTER'S FINALITY KEY
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- THE DELIVERED SEAL IS REPLACED, NEVER STACKED UNDER. The register carries
-- `DecisionApprovalRevision_append_only` (`phase3_immutable_row()`), which rejects EVERY UPDATE
-- — so the countersign's `finalized` false→true flip would abort before the pairing trigger
-- judged it. 4d-i therefore DROPS that trigger in the same transaction that installs the
-- register's own replacement. The old trigger ABSENT and the replacement PRESENT by name are
-- both asserted below, and join `upgrade-proof.sh`.
--
-- The replacement is STRICTLY NARROWER than what it replaces in every direction but one: every
-- DELETE is still refused, every other column is still frozen, and the ONE thing it newly admits
-- is the `finalized` false→true flip — paired, by the deferred trigger of §B.4, to the fact that
-- performed it.
DROP TRIGGER IF EXISTS "DecisionApprovalRevision_append_only" ON "DecisionApprovalRevision";

CREATE OR REPLACE FUNCTION phase6_t4d_revision_one_flip() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'DecisionApprovalRevision is append-only: DELETE is forbidden (revision %)', OLD."id";
  END IF;

  -- Every column but `finalized` compared OLD to NEW. Enumerated rather than "everything except
  -- the one" so a column ADDED later is frozen by default: an unlisted column would otherwise be
  -- silently rewritable the day it appears, which is the failure shape a seal exists to prevent.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."optionKey" IS DISTINCT FROM OLD."optionKey"
     OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
     OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
     OR NEW."onBehalfOf" IS DISTINCT FROM OLD."onBehalfOf"
     OR NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId"
     OR NEW."approvedFrom" IS DISTINCT FROM OLD."approvedFrom"
     OR NEW."approvedByName" IS DISTINCT FROM OLD."approvedByName"
     OR NEW."approvedByRole" IS DISTINCT FROM OLD."approvedByRole" THEN
    RAISE EXCEPTION
      'DecisionApprovalRevision is append-only apart from ONE transition: revision % may only have `finalized` flipped false → true, and every other column is immutable evidence of the approval act',
      OLD."id";
  END IF;

  -- The ONE permitted transition, in ONE direction. A true→false write would un-finalize a
  -- countersigned approval; a true→true write is a no-op that would let a writer touch the row
  -- without changing it, which is not something any command needs to do.
  IF NOT (OLD."finalized" = FALSE AND NEW."finalized" = TRUE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision %''s finality may only move false → true (saw % → %) — un-finalizing a countersigned approval would present a settled decision as provisional',
      OLD."id", OLD."finalized", NEW."finalized";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_one_flip" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4d_one_flip"
  BEFORE UPDATE OR DELETE ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_one_flip();

-- ── the BIRTH value is sealed too ────────────────────────────────────────────────────────────
-- A revision is BORN `false` under an active chain and `true` without one. Left unsealed, a
-- forged birth is the cheapest attack on the whole mechanism: a revision inserted `true` under a
-- chain is a final approval no architect ever countersigned, and one inserted `false` with no
-- chain can never be finalized, because neither finalizer exists.
CREATE OR REPLACE FUNCTION phase6_t4d_revision_birth() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_chain BOOLEAN; v_prev INT;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6 4d-i: the project readiness key is held elsewhere — this direct approval-revision write is refused rather than waiting inside a trigger (revision %)', NEW."id";
  END IF;
  v_chain := platform_role_standing(NEW."projectId", 'architect') > 0;

  -- A BIRTH IS THE NEXT HEAD, and nothing here had ever said so (#582 round 13, finding 5).
  -- Rounds 10 to 12 bound the birth's VALUE, its PAIRING and its COUNT, and left its POSITION
  -- free. `phase6_t4d_provisional_head` resolves the head by version, so a revision inserted at
  -- version 0 under an existing finalized version 1 satisfies every one of those seals — it is
  -- the only unfinalized row, born under a chain, correctly paired — while the head the
  -- finalizers resolve stays the finalized version 1. The decision parks in
  -- `awaiting_countersign` and neither countersign nor stranded resolution can ever reach it.
  --
  -- STRICTLY ABOVE the maximum, and NOT `previous + 1`. The first version of this arm demanded
  -- the successor and argued that "a gap is the same defect one step further out". That reasoning
  -- was wrong and the integration suite proved it within the hour: `phase6_t4d_provisional_head`
  -- resolves the head by ORDER BY version DESC, so a gap hides nothing — only a version at or
  -- below the maximum does. Meanwhile gaps are LEGITIMATE and shipped: a legacy decision whose
  -- earlier approvals were never written as revisions reapproves as version 2 with no version 1
  -- present (`phase3-requirements`, "with or without a backfilled register row"), and the
  -- successor rule refused that correct write.
  --
  -- The invariant the finding actually names is "is it the head", and that is what is asserted.
  SELECT COALESCE(max(r."version"), 0) INTO v_prev
    FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
     AND r."id" IS DISTINCT FROM NEW."id";
  IF NEW."version" <= v_prev THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % is born at version % on a decision whose highest existing version is % — a birth becomes the HEAD or it is not a birth at all, and a revision at or below the maximum is invisible to `phase6_t4d_provisional_head`, so the approval it represents can never be finalized by either finalizer',
      NEW."id", NEW."version", v_prev;
  END IF;

  IF NEW."finalized" <> (NOT v_chain) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % is born finalized=% on a project whose architect chain is %, and the birth value is NOT the writer''s to choose — under a chain an approval is PROVISIONAL until countersigned, without one it is final at the act',
      NEW."id", NEW."finalized", CASE WHEN v_chain THEN 'ACTIVE' ELSE 'inactive' END;
  END IF;

  -- A revision born PROVISIONAL owes the pair its finalizer will emit from: without
  -- `approvedFrom` the countersign cannot know whether to emit `decision.approved` or
  -- `decision.reapproved`, and without the frozen pair the fact seals have nothing to compare.
  -- Legacy and drain-window rows are all born `true` and are untouched by this arm.
  IF NEW."finalized" = FALSE AND (
       NEW."approvedFrom" IS NULL OR NEW."approvedByName" IS NULL OR NEW."approvedByRole" IS NULL
     ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % is born PROVISIONAL and must record the act its finalizer will emit from — `approvedFrom`, `approvedByName` and `approvedByRole` are all required on a revision born unfinalized',
      NEW."id";
  END IF;

  -- THE APPROVAL PAIR IS A FROZEN PAIR, AND THE RULE FOR ONE HAS THREE PARTS (#582 round 11
  -- finding 2's sibling site, completed by round 12 finding 2).
  --
  -- Round 11 applied ONE of the three — nonblank — and stopped, which is the same shape as every
  -- other miss this unit has made: the rule was swept along the dimension the finding named and
  -- no other. A frozen role/name pair is trustworthy only when it is (a) BOTH halves or neither,
  -- (b) each half nonblank, and (c) TRUE of the actor it names. Every other frozen pair in this
  -- file goes through `phase6_t4d_actor_bound` for (c); this one went through nothing, so a
  -- hand-run provisional approval could cite a legitimate approver and store any nonblank role
  -- and name it liked — and the finalized notice then renders that name, permanently.
  --
  -- (a) also closes the hole round 11 left open in the other direction: keying the check on
  -- `approvedByRole IS NOT NULL` meant a row carrying only `approvedByName` skipped it entirely.
  IF (NEW."approvedByRole" IS NULL) <> (NEW."approvedByName" IS NULL) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % carries half an approval pair (role %, name %) — the pair is written together or not at all, and a half pair is a name with no standing behind it or a standing with nobody in it',
      NEW."id", COALESCE(NEW."approvedByRole", '<null>'), COALESCE(NEW."approvedByName", '<null>');
  END IF;
  IF NEW."approvedByRole" IS NOT NULL THEN
    IF btrim(NEW."approvedByRole", E' \t\n\x0B\f\r') = ''
       OR btrim(NEW."approvedByName", E' \t\n\x0B\f\r') = '' THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % carries a BLANK approval pair (role `%`, name `%`) — the pair is frozen at the act and read by its finalizer, and a blank half attributes nothing while looking attributed',
        NEW."id", NEW."approvedByRole", NEW."approvedByName";
    END IF;
    -- and it must be TRUE of the approver. `approvedById` is the account; the pair is what the
    -- finalizing event and the notice will say about them, so it is checked against the register
    -- under the identity lock exactly as every decision fact's pair is.
    IF NEW."approvedById" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % carries an approval pair but names no approver — a frozen pair is evidence ABOUT somebody, and there is nobody here for it to be true of',
        NEW."id";
    END IF;
    PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."approvedById",
                                   NEW."approvedByRole", NEW."approvedByName",
                                   'DecisionApprovalRevision ' || NEW."id");
  END IF;

  -- AND CORRESPONDENCE IS NOT AUTHORITY — a real gap, and NOT 4d-i's to close
  -- (#582's review round 19, finding 3; measured, then backed out).
  --
  -- The finding is right about this seal: everything above proves the frozen pair is TRUE of
  -- `approvedById` and nothing asks whether that actor may approve THIS decision, so an actor with
  -- a genuine receipt and a truthful pair can record an approval of a decision they do not hold.
  --
  -- THE BINDING WAS WRITTEN, INSTALLED AND MEASURED, and it is not dark. With
  -- `phase6_t4d_approver_authorized` wired here, the api integration suite went from 1585 passing
  -- to **30 failures across ten files**, every one of them this rule — 29 `does not hold its
  -- `client` designation` and one `member`. Those are the DELIVERED `decisions.approve` paths
  -- exercised by suites that pass today. Whether the service is genuinely approving without holder
  -- authority, or the register does not yet carry the standing this predicate reads, the
  -- consequence is the same and it is disqualifying HERE: 4d-i is a DARK migration, and a seal that
  -- refuses thirty currently-legal service writes is not dark. Shipping it would break the running
  -- release at the moment the migration commits, which is the one thing this unit may not do — the
  -- same line round 18 drew around `DecisionEvent.actorRole`, for the same reason.
  --
  -- SO IT IS OWED BY 4d-ii, where the writer itself moves onto the register and the question can be
  -- answered by changing the writer and the seal together. The plan's §D carries it as an
  -- obligation of that unit, with this measurement, so it is a scheduled correction rather than a
  -- silence. `phase6_t4d_approver_authorized` is NOT installed by this file: a function defined
  -- with the right rule in its comment and left unwired is the defect rounds 1 and 2 both found.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_birth" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4d_birth"
  BEFORE INSERT ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_birth();

-- ── and a BIRTH is ONE act, PAIRED with the transition it was made by ────────────────────────
-- #582 round 10, finding 5 — the third site of this round's single rule, and the seal above
-- cannot carry it: `phase6_t4d_revision_birth` is BEFORE INSERT and per row, so it sees one
-- revision at a time and no row written after it. Everything below is a COMMIT question.
--
-- (1) EXACTLY ONE BIRTH PER DECISION PER TRANSACTION. `DecisionApprovalRevision` is keyed by
--     `(projectId, decisionId, version)`, so the index does not bound births — it bounds births
--     PER VERSION, and consecutive versions are exactly how the duplicate presents. After 4d-iii
--     a direct bundle can reserve two `decisions.approve` receipts, insert versions n and n+1 as
--     PROVISIONAL revisions around a single `pending → awaiting_countersign` transition, and both
--     satisfy the birth seal above independently. Only the higher-version head is ever reachable
--     by a finalizer, so the lower one is a permanent, immutable, unfinalizable approval sitting
--     in the register 4c reads as cycle evidence: the cycle count moves past open consultations
--     that were never answered, which is precisely the forgery `sourceCommandId` was added to
--     stop. Two acts cannot make one approval.
--
--     Counted over ALL births, not the provisional ones alone, because the no-chain direct
--     approve writes exactly one revision too and a duplicate there inflates the same count. A
--     historical import that plants several revisions of one decision in ONE transaction must
--     declare itself by name the way `plantLegacyApprovalRevision` already declares itself for
--     the 4c provenance seal — the sanctioned bypass is the visible path, and no unnamed writer
--     gets it by accident.
--
-- (2) A PROVISIONAL BIRTH RIDES A TRANSITION. `finalized = false` is unreachable before 4d-iii
--     (the chain is reserved) and is written only by the provisional approve, whose transaction
--     moves the decision — so a provisional revision inserted beside an UNTOUCHED decision is an
--     approval no act performed. Scoped to the provisional birth on purpose: legacy rows and
--     every drain-window approval are born `true` (the column's default is `true` for exactly
--     that reason), and demanding a transition of those would refuse the imports the register is
--     required to keep admitting. The demand is that the decision was WRITTEN here, not that it
--     ended at a particular status — the status question is already asked from the decision side
--     by `Decision_t4d_entry_seal`, and pinning a final status here would repeat round 8's
--     mistake of judging a transition by the state it left behind.
-- ── the APPROVAL TRANSITION register (#582's review round 22, finding 3) ─────────────────────
-- Round 19's finding 2 asked the finalized birth to ride its transition, and round 19's own first
-- answer — `xmin` alone — was too weak because a NO-OP UPDATE satisfies it. The strengthening
-- added the END STATE, and round 22 says that is the SAME defect one step along: a no-op UPDATE
-- against a decision that is ALREADY `approved` supplies the `xmin` and leaves the status at
-- `approved`, so both clauses pass with no transition at all. A direct receipt-backed bundle can
-- then insert a higher-version finalized revision beside an untouched approved decision, and the
-- fabricated revision becomes the head that 4c reads as a consultation cycle.
--
-- A STATE IS NOT AN ACT, and no predicate over the decision's final row can tell them apart —
-- the row looks identical whether this transaction moved it or found it that way. The act has to
-- be recorded WHERE IT IS VISIBLE, which is the update itself, with OLD in hand. So the
-- transition registers itself: a BEFORE UPDATE trigger on `Decision` appends the decision's id to
-- a TRANSACTION-LOCAL set when, and only when, this update performs `pending`/`change` ->
-- `approved`. The deferred birth seal then asks whether its decision is in that set.
--
-- The admitted entries are the DELIVERED `Decision_t4b_attribution_seal`'s: it states that the
-- approval tuple may first be written only by `pending`/`change` -> `approved` (this unit widens
-- its target to `approved`/`awaiting_countersign`, and not its SOURCE), and this register must say
-- the same thing or the two seals disagree about what an approval is. If a later unit adds a third
-- entry transition it moves this set with the seal that states it.
--
-- A jsonb ARRAY, not a delimited string, for round 20 finding 2's reason: `Decision.id` is
-- unconstrained TEXT, so any delimiter can appear INSIDE an id and a containment test on a
-- concatenated string answers TRUE for a decision the transaction never touched. `?` on a jsonb
-- array has no delimiter to smuggle.
-- AND THE SOURCE IS PART OF THE MOVE (#582's review round 23, finding 1).
--
-- Round 22 wrote this recorder with a comment saying "which moves are legal is
-- `Decision_t4d_entry_seal`'s question and is not re-decided here", and recorded EVERY change into
-- `approved`. Both halves of that sentence were wrong. `Decision_t4d_entry_seal` judges entry into
-- `awaiting_countersign` and nothing else — it never asks about `approved` at all — so deferring
-- to it left the approved side with no source rule anywhere. And the rule was not being
-- "re-decided": the exception this register feeds says `pending`/`change` -> `approved` in those
-- words, and the paragraph above says it too, so the recorder was the ONE place that disagreed.
--
-- What the omission admits arrives with 4d-iii: `awaiting_countersign` -> `approved` is the
-- STRANDED COMPLETION, which finishes an approval already made and writes no new one. A bundle
-- performing a valid one can carry a genuine `decisions.approve` receipt and a higher-version
-- FINALIZED revision beside it; the birth seal below then sees a register entry, an `approved` end
-- state and one new revision, and the fabricated approval becomes the immutable head that 4c
-- counts as a consultation cycle. `DecisionApprovalRevision.approvedFrom` carries a CHECK over
-- exactly `('pending', 'change')` for the same reason — a revision cannot even NAME a third
-- source, so a register that admitted one would be recording an act the fact table cannot express.
CREATE OR REPLACE FUNCTION phase6_t4d_decision_approved_here() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- A MOVE, stated as a move: FROM an open decision, and INTO this state. Which transitions are
  -- otherwise legal stays with the seals that own them; what this records is the ENTRY pair the
  -- delivered attribution seal names, because that pair is what the birth seals below mean by an
  -- approval and a third source would not be one.
  IF OLD."status"::text IN ('pending', 'change')
     AND NEW."status"::text IS DISTINCT FROM OLD."status"::text THEN
    IF NEW."status"::text = 'approved' THEN
      PERFORM set_config('phase6.t4d_decision_approved',
        (COALESCE(NULLIF(current_setting('phase6.t4d_decision_approved', true), ''), '[]')::jsonb
          || to_jsonb(NEW."id"))::text, true);
    ELSIF NEW."status"::text = 'awaiting_countersign' THEN
      PERFORM set_config('phase6.t4d_decision_awaiting',
        (COALESCE(NULLIF(current_setting('phase6.t4d_decision_awaiting', true), ''), '[]')::jsonb
          || to_jsonb(NEW."id"))::text, true);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_approval_transition" ON "Decision";
CREATE TRIGGER "Decision_t4d_approval_transition" BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_decision_approved_here();

CREATE OR REPLACE FUNCTION phase6_t4d_decision_approved_in_tx(p_decision TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('phase6.t4d_decision_approved', true), ''), '[]')::jsonb
         ? p_decision;
$$;

CREATE OR REPLACE FUNCTION phase6_t4d_decision_awaiting_in_tx(p_decision TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('phase6.t4d_decision_awaiting', true), ''), '[]')::jsonb
         ? p_decision;
$$;

CREATE OR REPLACE FUNCTION phase6_t4d_revision_birth_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_births BIGINT; v_moved BOOLEAN; v_open BIGINT;
BEGIN
  SELECT count(*) INTO v_births FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
     AND r."xmin" = txid_current()::text::xid;
  IF v_births <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % carries % DecisionApprovalRevision rows BORN in this transaction (including version %) — an approval is ONE act with ONE revision, and sibling births citing different receipts leave every revision below the head permanently unfinalizable while the register''s COUNT reports approval cycles that never happened',
      NEW."decisionId", v_births, NEW."version";
  END IF;

  IF NEW."finalized" = FALSE THEN
    -- (2a) THE DECISION ENDS WHERE A PROVISIONAL APPROVAL PUTS IT (#582 round 11, finding 3).
    --
    -- Round 10 asked only whether this transaction WROTE the decision, and wrote down why:
    -- "pinning a final status here would repeat round 8's mistake of judging a transition by the
    -- state it left behind". That reasoning was wrong, and wrong in a way I could have tested. A
    -- no-op `UPDATE` satisfies `xmin` — it is a write that changes nothing — so a bundle could
    -- touch an already-`awaiting_countersign` decision and insert a second provisional revision
    -- beside the first. Round 8's mistake was reading a state INSTEAD of the transition where the
    -- transition was the rule; here the state IS the rule, because a provisional approval is
    -- defined by where it leaves its decision, and `Decision_t4d_entry_seal` already owns the
    -- question of which transitions may reach that state.
    -- AND THE SIBLING OF ROUND 22's FINDING 3 IS HERE (#582 round 22, the class sweep). The
    -- paragraph above names the no-op hazard exactly — "a bundle could touch an already-
    -- `awaiting_countersign` decision and insert a second provisional revision beside the first" —
    -- and then answers it with the END STATE, which that same no-op also satisfies. It is the
    -- finalized arm's defect verbatim, written one screen higher, and the argument that "here the
    -- state IS the rule" does not rescue it: the hazard the paragraph names is a SECOND revision
    -- beside a decision already parked, and the status is true of exactly that case.
    --
    -- The transition register answers both arms, and it records a MOVE rather than a state:
    -- `Decision_t4d_approval_transition` appends the decision to this set when the status CHANGES
    -- INTO `awaiting_countersign`. The end state is kept beside it so a later statement in the
    -- same transaction cannot park the decision, plant the revision and then move it away.
    -- (2b) AND A DECISION HOLDS AT MOST ONE OPEN APPROVAL, which is the invariant the attack
    -- actually breaks and the one this file has been ASSUMING all along:
    -- `phase6_t4d_provisional_head` resolves "the" provisional head as the highest-version
    -- unfinalized revision, which is only well defined when there is one. Two of them strand
    -- every revision below the head — no finalizer can ever reach it, because both the
    -- countersign and the `completed` resolution are sealed onto the head — while the register's
    -- COUNT, which 4c reads as cycle evidence, reports approvals that never happened.
    --
    -- Asked over the decision's WHOLE history rather than this transaction's rows, because a
    -- second provisional revision is equally corrupt whenever it arrives.
    SELECT count(*) INTO v_open FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
       AND r."finalized" = FALSE;
    IF v_open > 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % would hold % unfinalized approval revisions at commit (this one is version %) — a decision has at most ONE open approval, the head its finalizer acts on, and every revision below it is stranded beyond the reach of any countersign or resolution',
        NEW."decisionId", v_open, NEW."version";
    END IF;

    -- THE ORDER OF (2b) AND (2c) IS LOAD-BEARING (#582 round 22, the class sweep). Both refuse a
    -- SECOND provisional revision beside an already-parked decision, and (2b) is the rule that
    -- shape actually breaks — round 11's finding 3 drives exactly it and names this message. Put
    -- the move-demand first and that arm would start passing because something else said no,
    -- which is the abbreviation this PR's round 1 wrote an oracle for. The move-demand is the
    -- GENERAL rule and answers what (2b) cannot see: a FIRST provisional revision with no
    -- transition behind it at all.
    IF NOT phase6_t4d_decision_awaiting_in_tx(NEW."decisionId") THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born PROVISIONAL, but no move of decision % INTO `awaiting_countersign` was performed in this transaction — a provisional approval IS the act that parks a decision for its countersigner, and a write that leaves an already-parked decision parked performs no such act while a second immutable revision claims it did',
        NEW."id", NEW."decisionId";
    END IF;
    SELECT TRUE INTO v_moved FROM "Decision" d
     WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId"
       AND d."status"::text = 'awaiting_countersign';
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born PROVISIONAL and decision % was parked in this transaction, but it does not END the transaction as an `awaiting_countersign` row — a parking that is walked back by a later statement leaves an immutable provisional revision recording a wait nobody is holding',
        NEW."id", NEW."decisionId";
    END IF;

  ELSE
    -- (3) AND A FINALIZED BIRTH RIDES ONE TOO (#582's review round 19, finding 2).
    --
    -- (2) sat inside `IF NEW."finalized" = FALSE`, and its comment explains why: a provisional
    -- birth is unreachable before 4d-iii, so it looked like the interesting one. What that missed
    -- is that `finalized = true` is not only the LEGACY shape — it is also what the live no-chain
    -- `decisions.approve` writes, on every approval this release performs. Scoping the transition
    -- demand to the provisional branch therefore left the ORDINARY approval with none at all.
    --
    -- What that admits: reserve and complete a genuine `decisions.approve` receipt, insert a
    -- revision one version above the head for a decision still sitting at `pending`, and commit.
    -- The decision is never written, no `decision.approved` event is emitted, no audit row is
    -- appended — and every seal passes, because each was asking about something else. The row is
    -- then immutable, it advances the approval COUNT that 4c reads as the consultation cycle, and
    -- it stands as the finalized provenance a later requirement cites. An approval that never
    -- happened, permanently.
    --
    -- The demand is (2a)'s shape without its status: the decision was WRITTEN in this transaction.
    -- Which status an approval may leave it in is already the delivered attribution seal's
    -- question, and re-deciding it here would be round 8's mistake of judging a transition by the
    -- state it left behind.
    --
    -- THE HISTORICAL IMPORT KEEPS ITS DOOR, by the same visible path it already uses: a legacy
    -- revision is born finalized beside a decision nobody is touching, which is exactly this
    -- shape, so `plantLegacyApprovalRevision` disables THIS trigger by name alongside the 4c
    -- provenance seal it already disables. An unnamed writer gets nothing by accident.
    -- AND IT IS THE STATUS, NOT MERELY A WRITE. `xmin` alone is satisfied by a NO-OP UPDATE — a
    -- write that changes nothing — so "this transaction wrote the decision" costs an attacker one
    -- extra statement and nothing else: the decision stays `pending`, every seal that judges the
    -- decision row permits a non-transition, and the forged revision lands anyway. That is round
    -- 11's finding 3 exactly, which strengthened the PROVISIONAL arm above for the same reason and
    -- left this branch unwritten. A finalized approval is DEFINED by where it leaves its decision,
    -- and the delivered `decision_t4b_attribution_seal` says where that is: the approval tuple may
    -- first be written only by `pending`/`change` -> `approved`.
    -- AND IT IS THE TRANSITION, NOT THE END STATE (#582's review round 22, finding 3). The
    -- paragraph above is right that `xmin` alone is a no-op's to supply, and the answer it gave —
    -- add the final status — has the SAME hole one step along: a no-op UPDATE against a decision
    -- that is ALREADY `approved` writes the row (satisfying `xmin`) and leaves it `approved`
    -- (satisfying the status), with nothing transitioned. Only the update itself can tell an act
    -- from a state, because only it holds OLD — so `Decision_t4d_approval_transition` records the
    -- `pending`/`change` -> `approved` move in a transaction-local set as it happens, and this is
    -- the reader. The end state is still required beside it: the transition must also still STAND
    -- at commit, or a later statement in the same transaction could move the decision back out of
    -- the approved family and leave the finalized revision behind.
    IF NOT phase6_t4d_decision_approved_in_tx(NEW."decisionId") THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born FINALIZED, but no `pending`/`change` -> `approved` transition of decision % was performed in this transaction — a finalized approval IS the act that moves its decision into the approved family, and a write that leaves an already-approved decision approved performs no such act while the register counts the revision as a cycle that happened. A historical import declares itself by disabling `DecisionApprovalRevision_t4d_birth_paired` by name, the way the 4c provenance seal is already declared.',
        NEW."id", NEW."decisionId";
    END IF;
    SELECT TRUE INTO v_moved FROM "Decision" d
     WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId"
       AND d."status"::text = 'approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born FINALIZED and decision % was moved into `approved` in this transaction, but it does not END the transaction there — an approval that is walked back by a later statement leaves an immutable finalized revision recording a cycle the register no longer agrees happened.',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_birth_paired" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4d_birth_paired"
  AFTER INSERT ON "DecisionApprovalRevision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_birth_paired();

-- ── the FLIP is PAIRED, in both directions (§B.4) — with EXACTLY ONE finalizer ───────────────
-- A finalized-only flip with NEITHER pairing fact is unrepresentable. The two legal finalizers
-- are the `DecisionCountersign` row (the chain path) and the `DecisionStrandedResolution` row
-- with outcome `completed` (the only other one) — so the seal names both and nothing else.
--
-- ONE, not "at least one" (Codex round 1, finding 16). The first version refused only the
-- ABSENCE of both, which admits their PRESENCE together: for a stranded decision, one
-- transaction can insert the `completed` resolution while the architect count is zero, activate
-- an architect, insert a countersign for the same revision, and flip. Both facts are immutable
-- and both claim to have ended the same provisional approval — a permanent contradiction in the
-- register whose whole purpose is to say, unambiguously, which act made an approval final. The
-- count is taken ACROSS the two tables because that is the question: not "did this table supply
-- a finalizer" but "how many finalizers does this revision have".
CREATE OR REPLACE FUNCTION phase6_t4d_revision_flip_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_finalizers BIGINT;
BEGIN
  IF OLD."finalized" = TRUE OR NEW."finalized" = FALSE THEN RETURN NULL; END IF;

  SELECT (
    SELECT count(*) FROM "DecisionCountersign" c
     WHERE c."projectId" = NEW."projectId" AND c."revisionId" = NEW."id"
  ) + (
    SELECT count(*) FROM "DecisionStrandedResolution" s
     WHERE s."projectId" = NEW."projectId" AND s."revisionId" = NEW."id"
       AND s."outcome" = 'completed'
  ) INTO v_finalizers;

  IF v_finalizers = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % was finalized in this transaction with neither a DecisionCountersign nor a `completed` DecisionStrandedResolution naming it — a provisional approval becomes final by an ACT, and a flip with no act behind it is exactly the forgery the register exists to make impossible',
      NEW."id";
  END IF;
  IF v_finalizers > 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % carries % finalizers — a countersign AND a `completed` stranded resolution, or two of one kind, each immutable and each claiming to have ended the same provisional approval. A finalized approval was made final by exactly ONE act, and the register may not record two.',
      NEW."id", v_finalizers;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_flip_paired" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4d_flip_paired"
  AFTER UPDATE ON "DecisionApprovalRevision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_flip_paired();

-- The replacement is VERIFIED, not assumed: a `CREATE OR REPLACE` that silently did nothing, or
-- a `DROP TRIGGER IF EXISTS` over a name that had already moved, would leave the register either
-- unsealed or still blanket-immutable, and both are discovered far too late.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'DecisionApprovalRevision_append_only'
                AND tgrelid = '"DecisionApprovalRevision"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: the delivered blanket append-only trigger is still present on "DecisionApprovalRevision" — the finality flip would abort before its pairing trigger judged it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'DecisionApprovalRevision_t4d_one_flip'
                    AND tgrelid = '"DecisionApprovalRevision"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: the replacement one-flip seal is missing from "DecisionApprovalRevision" — the register would be left rewritable.';
  END IF;
END $$;

-- ── the audit register's 4d-only KINDS are RESERVED, like the states they record ─────────────
-- #582's review round 15, finding 2.
--
-- The reservation was applied to STATES (`Decision.status`, `Decision.deciderKind`), to ROLES
-- (`Membership.role`, `User.role`) and to a TABLE (`DecisionForward`), and never to the audit
-- register's KINDS — so four kinds recording acts that have no writer until 4d-ii were writable
-- through the whole dark window.
--
-- THE HOLE, concretely. A no-chain direct approval is legal in the window: it commits `approved`
-- and emits one `decision.approved`. The weak correspondence's table admits a `countersigned`
-- audit row on an `approved` decision against `decision.approved` OR `decision.reapproved` —
-- because after 4d-iii that IS the countersign's event — so the approval's own event answers it.
-- `v_events` is 1, the per-type audit count is 1, and nothing in the WEAK body demands a
-- `DecisionCountersign` fact, which is 4d-iii's full converse. The row commits, the append-only
-- seal makes it permanent, and 4d-iii's stronger INSERT trigger judges only NEW rows, so it can
-- never invalidate the one already there. `stranded_resolved` on an `approved` decision has the
-- identical shape, and `forwarded` and `countersign_renotified` are the same class one step out.
--
-- THE FIX IS THE RESERVATION, not a widening of the weak body. These four kinds record acts whose
-- COMMANDS do not exist until 4d-ii; a kind with no sanctioned writer is reserved exactly as a
-- status with no installed seals is. Widening the weak correspondence to demand the fact would be
-- the wrong instrument twice over: it would duplicate 4d-iii's converse in this file (two
-- definitions of one rule, drifting), and it would still admit the kind, when the honest answer
-- for the window is that the act cannot have happened.
--
-- Through the SAME `phase6_t4d_reserved` function and the same WHEN-clause shape as the other
-- five doors, so 4d-iii drops SIX doors in one statement rather than five and a special case.
DO $$
DECLARE tg pg_trigger;
BEGIN
  IF phase6_t4d_retired_at_start() THEN RETURN; END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'DecisionEvent_t4d_kind_reserved'
     AND tgrelid = '"DecisionEvent"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "DecisionEvent_t4d_kind_reserved" BEFORE INSERT ON "DecisionEvent"
      FOR EACH ROW WHEN (NEW."type" IN ('countersigned', 'stranded_resolved', 'forwarded', 'countersign_renotified'))
      EXECUTE FUNCTION phase6_t4d_reserved('DecisionEvent.type = a 4d-only kind');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 7 THEN            -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4)
    RAISE EXCEPTION
      'phase6 4d-i: DecisionEvent_t4d_kind_reserved exists but does not reserve the 4d-only audit kinds (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- ── the DecisionEvent audit register: append-only, and CORRESPONDING ─────────────────────────
-- The delivered `DecisionEvent_no_withdrawn_approval` refuses the DELETE of an approval row.
-- 4d-i widens that to the whole register: an audit row is the attributable record that an act
-- happened, and a writer who can rewrite or delete one can make a past act say something else.
-- The sanctioned reset disables it BY NAME alongside the delivered seal — that is §A.3's "one
-- new name", and `wipeDecisionEvents` gains it in the same unit.
CREATE OR REPLACE FUNCTION phase6_t4d_decision_event_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "DecisionEvent" is the attributable audit register and is append-only — % is refused (row %). The sanctioned reset (test/integration/fixtures.ts wipeDecisionEvents, prisma/seed.ts) disables this trigger BY NAME.',
    TG_OP, COALESCE(OLD."id", '<unknown>');
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4d_append_only" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4d_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionEvent"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_decision_event_append_only();

-- AND ROW-LEVEL IMMUTABILITY THAT A WHOLE-TABLE STATEMENT WALKS PAST IS NOT IMMUTABILITY
-- (#582's review round 24, finding 2).
--
-- The trigger above is a ROW trigger, and TRUNCATE fires no row triggers. The only truncate seal
-- this table carried was the DELIVERED `DecisionEvent_t4a_no_truncate`, which refuses while an
-- `approved` or `reapproved` row exists and permits the wipe otherwise — a rule about APPROVAL
-- evidence, written before this register carried any other kind. 4d-i fills it with kinds that
-- are evidence in exactly the same sense: `change_requested`, `change_withdrawn`, `forwarded`,
-- `countersigned`, `stranded_resolved`, `countersign_renotified`. A database holding those and no
-- approval could be erased whole, taking with it the correspondence, claim and actor bindings
-- this unit spends its length installing.
--
-- UNCONDITIONAL, because the condition is what failed: a seal that asks what the table contains
-- before refusing is a seal whose coverage depends on the attack's timing. `ProjectEventStream`,
-- `ChangeRequest`, `Notification` and the three decision facts all carry the unconditional shape
-- already; this is the register they all point at, and it was the one left conditional.
--
-- Its own message rather than `phase6_t4d_fact_no_truncate`'s, because this table is not one of
-- the unit's fact tables — it is the DELIVERED audit register, with a delivered seal beside it
-- and a sanctioned reset that has always truncated it. That reset keeps working the way §A.3 says
-- it must: by name, through `TRUNCATE_SEALS` in `prisma/sanctioned-reset.ts`, alongside the
-- delivered t4a seal it must already disable.
CREATE OR REPLACE FUNCTION phase6_t4d_decision_event_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "DecisionEvent" is the attributable audit register and is never truncated — the append-only seal is a ROW trigger and does not fire for TRUNCATE, so a wipe would erase exactly the evidence it protects, whether or not an approval row is present. The sanctioned reset (prisma/sanctioned-reset.ts TRUNCATE_SEALS) disables this trigger BY NAME.';
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4d_no_truncate" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4d_no_truncate" BEFORE TRUNCATE ON "DecisionEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_decision_event_no_truncate();

-- ── the re-notification's CLAIM ──────────────────────────────────────────────────────────────
-- §A.3 obligation 7 needs exactly ONE claimant per pairing-required event, and the plan names
-- this branch's claimant as the `countersign_renotified` AUDIT ROW itself (#572's review round
-- 19; #582's round 5, finding 7). Every other sealed branch has a FACT TABLE to claim from —
-- a forward, a countersign, a stranded resolution, a transition. The re-notification has none:
-- it re-emits `decision.awaiting_countersign` for a crossing, and the only durable row the act
-- writes is its audit entry. Without a claimant here, the moment 4d-i-b sets `pairingRequired` on
-- that key (the pairing switch-on unit §D carves out of this one) the legitimate
-- `decisions.effects` transaction writes its event and its audit row,
-- creates no claim, and `DomainEvent_t4d_pairing_claimed` aborts it AT COMMIT — the seal killing
-- the act it was built to witness.
--
-- NARROW BY CONSTRUCTION. The `WHEN` clause admits one audit kind, so no other insert on this
-- register reaches the claim; the event is resolved through the kernel's own same-transaction
-- primitive rather than by a lookup this module invents; and a missing event is left to
-- `DecisionEvent_t4d_correspondence`, which is the seal that owes that message. Claiming is all
-- this does — the pairing's converse stays where it belongs, on the kernel's deferred seal.
CREATE OR REPLACE FUNCTION phase6_t4d_renotified_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_project TEXT; v_event TEXT;
BEGIN
  SELECT d."projectId" INTO v_project FROM "Decision" d WHERE d."id" = NEW."decisionId";
  IF v_project IS NULL THEN RETURN NULL; END IF;

  v_event := platform_tx_event(v_project, 'Decision', NEW."decisionId",
                               ARRAY['decision.awaiting_countersign']);
  IF v_event IS NULL THEN RETURN NULL; END IF;

  PERFORM platform_claim_event_pairing(v_project, v_event, 'DecisionEvent', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4d_renotified_claim" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4d_renotified_claim"
  AFTER INSERT ON "DecisionEvent"
  FOR EACH ROW WHEN (NEW."type" = 'countersign_renotified')
  EXECUTE FUNCTION phase6_t4d_renotified_claims_event();

-- ── the WEAK converse: the (kind, committed status) table §A.3 closes ────────────────────────
-- An audit row says an act happened. The correspondence says the same transaction must carry the
-- EVENT that act owes, so an audit trail and a delivery stream cannot disagree about what the
-- system did.
--
-- WHY A TABLE AND NOT A FUNCTION OF THE KIND (round 23, finding 1, replacing round 21's kind →
-- type function): `approved` and `reapproved` map to DIFFERENT events depending on where the
-- decision LANDED. The same `approved` audit row means `decision.approved` when the decision
-- committed `approved`, and `decision.awaiting_countersign` when a chain made that approval
-- PROVISIONAL. A function of the kind alone cannot tell them apart, and would demand the wrong
-- event for one of the two.
--
-- DEFERRED, because the delivered writers insert the audit row BEFORE they emit
-- (`decisions.service.ts`), so an immediate check would judge a transaction that is still
-- correct and merely unfinished. Judged at COMMIT, when the whole transaction is visible.
--
-- WEAK, because this is the 4d-i body: it derives the required event from the TRANSITION alone.
-- 4d-iii replaces it with the FULL converse, which also demands the FACT. A `DecisionEvent`
-- written for a transition this table does not list — the delivered `issued`, `drafted`,
-- `draft_updated`, and `withdrawn` — is untouched: the seal judges only what it admits.
CREATE OR REPLACE FUNCTION phase6_t4d_event_correspondence_weak() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approver TEXT;                       -- #582 round 19, finding 4 — the act's own actor
  v_actor_hi TEXT;                       -- #582 round 23, finding 3 — and it is ONE actor, not any
  v_row      TEXT;
  v_from     TEXT; v_from_hi TEXT;       -- #582 round 25, finding 1 — the approval FAMILY
  v_fam      BIGINT;
  v_status   TEXT;
  v_project  TEXT;
  v_required TEXT[];
  v_events   BIGINT; v_audits BIGINT;
BEGIN
  SELECT d."status"::text, d."projectId" INTO v_status, v_project
    FROM "Decision" d WHERE d."id" = NEW."decisionId";
  IF v_status IS NULL THEN RETURN NULL; END IF;

  -- THE TABLE. Each row is (audit kind, the status the decision COMMITTED in) → the event types
  -- that kind owes there. A disjunction where the pair genuinely admits two: a countersign emits
  -- `decision.approved` or `decision.reapproved` by the revision's own `approvedFrom`, and which
  -- one is the finalizer's business, not this seal's.
  v_required := CASE
    WHEN NEW."type" = 'approved'    AND v_status = 'approved'              THEN ARRAY['decision.approved']
    WHEN NEW."type" = 'approved'    AND v_status = 'awaiting_countersign'  THEN ARRAY['decision.awaiting_countersign']
    WHEN NEW."type" = 'reapproved'  AND v_status = 'approved'              THEN ARRAY['decision.reapproved']
    WHEN NEW."type" = 'reapproved'  AND v_status = 'awaiting_countersign'  THEN ARRAY['decision.awaiting_countersign']
    WHEN NEW."type" = 'countersigned'      AND v_status = 'approved'       THEN ARRAY['decision.approved', 'decision.reapproved']
    WHEN NEW."type" = 'stranded_resolved'  AND v_status = 'approved'       THEN ARRAY['decision.approved', 'decision.reapproved']
    WHEN NEW."type" = 'stranded_resolved'  AND v_status = 'change'         THEN ARRAY['decision.change_requested']
    WHEN NEW."type" = 'change_requested'   AND v_status = 'change'         THEN ARRAY['decision.change_requested']
    WHEN NEW."type" = 'change_withdrawn'   AND v_status = 'approved'       THEN ARRAY['decision.change_withdrawn']
    WHEN NEW."type" = 'forwarded'                                          THEN ARRAY['decision.forwarded']
    WHEN NEW."type" = 'countersign_renotified'                             THEN ARRAY['decision.awaiting_countersign']
    ELSE NULL
  END;

  -- AN UNLISTED PAIR IS NOT AN UNGOVERNED ONE (#582's review round 24, finding 1).
  --
  -- `ELSE NULL` followed by `RETURN NULL` read as "this pair is outside the correspondence", and
  -- for the previous-release kinds that is true — `issued`, `withdrawn`, `recorded` and
  -- `draft_updated` record acts 4d states no obligation for, and a seal that refused them would
  -- refuse the shipped writers. For the kinds this unit DOES govern it was a hole with the table's
  -- own shape: every pair the table lists is checked, and every pair it does not list is waved
  -- through. Round 15 reserved the four 4d-ONLY kinds, which closed it for those and left the
  -- ordinary ones — `approved`, `reapproved`, `change_requested`, `change_withdrawn` — reachable
  -- in any status the table happens not to pair them with.
  --
  -- What that admits: a standalone `approved` audit row beside a `pending` decision. No
  -- transition, no event, no revision; every count above is skipped because `v_required` is NULL;
  -- `DecisionEvent_t4d_append_only` then makes the row permanent, and the next REAL approval
  -- counts it in `priorApprovals` and stamps the immutable revision with an inflated version.
  --
  -- So the governed kinds are named, and an unlisted pair among them is REFUSED rather than
  -- skipped. This is the shape `phase6_t4d_provenance_bound` already uses for its own undeclared
  -- table — "a fact whose expected provenance nobody stated is a fact nothing is checking" — said
  -- here about a pair rather than a table.
  --
  -- THE WHOLE ESCAPE INVENTORY, since the defect is "a branch that RETURNS where it should
  -- REFUSE". Five other early exits exist in this unit and each was read: the two `ELSE NULL`
  -- arms in `phase6_t4d_provenance_bound` (both already followed by an explicit RAISE — the
  -- pattern this one was missing); the re-notification claim's two (`v_project`, `v_event`), which
  -- DELEGATE in writing to `DecisionEvent_t4d_correspondence` and the seal that owes the message;
  -- and the consultation pair's `v_role IS NULL`, which is the legacy all-null shape its CHECK
  -- admits. The `v_status IS NULL` guard above is unreachable rather than permissive — a
  -- `DecisionEvent` row cannot name a decision that does not exist, its foreign key says so — and
  -- is kept as a defensive read, not as a rule.
  IF v_required IS NULL THEN
    IF NEW."type" IN ('approved', 'reapproved', 'countersigned', 'stranded_resolved',
                      'change_requested', 'change_withdrawn', 'forwarded',
                      'countersign_renotified') THEN
      RAISE EXCEPTION
        'phase6 4d-i: the `%` audit row for decision % commits with the decision `%`, and this unit states no correspondence rule for that pair — a governed audit kind in a state its own table does not admit records an act that cannot have happened, and the append-only seal is about to make it permanent. A HISTORICAL import declares itself by name, the way `plantLegacyDecisionAudit` already declares itself for the correspondence: pre-4b history really does hold `approved` rows on decisions since reopened, and this trigger judges only rows written NOW, which no delivered writer produces in a state this table does not list.',
        NEW."type", NEW."decisionId", v_status;
    END IF;
    RETURN NULL;
  END IF;

  -- Through the KERNEL PRIMITIVE, which is what makes "in this transaction" true of the query and
  -- not only of the message (Codex round 1, finding 2). An unscoped existence check let an
  -- approved decision's HISTORICAL `decision.approved` event answer every later `approved` audit
  -- insert, so a direct writer could append a second fabricated row with no emission at all —
  -- and `DecisionEvent_t4d_append_only` then made that false evidence permanent.
  -- EXACTLY ONE, WHICH IS A COUNT AND NOT AN EXISTENCE (#582's review round 7, finding 4).
  -- §A.3 says the audit row and the event record the SAME act; `platform_tx_event_count` was
  -- written for precisely this and its own doc comment says so — "two events for one act are as
  -- wrong as none" — and then nothing called it, which is the THIRD time in this unit a kernel
  -- primitive has been defined with the right rule in its comment and left unwired (round 1's
  -- `platform_tx_event`, round 2's `platform_claim_event_pairing`, this).
  --
  -- The hole an existence check leaves is not theoretical: a hand-run no-chain approval can take
  -- two valid allocator increments, insert two catalog-valid `decision.approved` events at the
  -- two positions it allocated, and append ONE `approved` audit row. Every envelope and
  -- allocation seal passes — each event is well-formed and correctly positioned — and this seal
  -- accepted whichever one `platform_tx_event` returned. The decision is then announced twice
  -- from one act, with two immutable deliveries and one audit row that cannot say which is real.
  v_events := platform_tx_event_count(v_project, 'Decision', NEW."decisionId", v_required);
  IF v_events = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: the `%` audit row for decision % (committed `%`) has no matching % event in this transaction — the audit register and the delivery stream record the SAME act, and one without the other is a system that cannot say what it did',
      NEW."type", NEW."decisionId", v_status, array_to_string(v_required, ' or ');
  END IF;
  IF v_events > 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: the `%` audit row for decision % (committed `%`) is accompanied by % matching % events in this transaction — one act emits ONE event, and a second announces the same decision twice with nothing to say which is real',
      NEW."type", NEW."decisionId", v_status, v_events, array_to_string(v_required, ' or ');
  END IF;

  -- AND THE COUNT RUNS BOTH WAYS (#582's review round 9, finding 5). Round 7 replaced an
  -- existence check with a count and stopped there, which left exactness ONE-SIDED: every audit
  -- row demands exactly one event, and nothing demands exactly one audit row. The converse hole
  -- is the same shape as the one round 7 closed — a hand-run no-chain approval performs ONE valid
  -- transition, emits ONE `decision.approved`, and appends TWO `approved` rows. This trigger fires
  -- once per row, each invocation sees `v_events = 1`, both pass, and the register carries two
  -- immutable claims for one act with nothing to say which is real. Counting the rows is the same
  -- question asked from the other end.
  SELECT count(*) INTO v_audits
    FROM "DecisionEvent" d
   WHERE d."decisionId" = NEW."decisionId" AND d."type" = NEW."type"
     AND d."xmin" = txid_current()::text::xid;
  IF v_audits > 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % carries % `%` audit rows written by this transaction — one act appends ONE row, and a second is a duplicate claim the append-only seal would make permanent',
      NEW."decisionId", v_audits, NEW."type";
  END IF;

  -- AND EXACTLY ONE OF WHAT IS NOT THE SAME AS ONE OF THE RIGHT THING
  -- (#582's review round 19, finding 4).
  --
  -- Rounds 7 and 9 made this correspondence EXACT in both directions and left it ANONYMOUS. Every
  -- count above is over type and kind; not one of them looks at WHO. So a bundle can carry an
  -- otherwise-valid approval revision attributed to holder A while emitting the
  -- `decision.approved` event and appending this audit row as user B: one event, one audit row,
  -- one revision, every count satisfied — and three immutable records that disagree about who
  -- approved. The push then announces B, because the consumer renders the event's envelope.
  --
  -- So the act's records are bound to the act's ROW. The approval revision written in this
  -- transaction is the authority — it is what this file judges hardest, through the frozen pair,
  -- the holder designation (round 19, finding 3) and the transition (finding 2) — and the event
  -- and the audit row must name the same actor.
  --
  -- THE DRAIN KEEPS ITS EXCEPTION, and it is a NULL actor rather than a missing rule: a
  -- previous-release audit row may carry no `actorId` at all, and no released code writes the
  -- event envelope until 4d-ii. So each side is compared only when it names somebody. 4d-iii is
  -- where both become required and this becomes total.
  -- AND ONE ACT HAS ONE APPROVAL FAMILY (#582's review round 25, finding 1).
  --
  -- Every count above is PER TYPE. Round 7 made the event count exact for the types THIS row
  -- requires; round 9 made the audit count exact for THIS row's own type; round 24 refused the
  -- (kind, status) pairs the table does not list. Not one of them looks ACROSS the two types that
  -- describe a single approval. So a no-chain `pending` -> `approved` bundle carrying ONE valid
  -- revision could append an `approved`/`decision.approved` pair AND a
  -- `reapproved`/`decision.reapproved` pair: each trigger invocation counts one event and one
  -- audit row of its own type, round 23's actor binding resolves both to the same revision, and
  -- the whole thing commits. The register then holds two immutable approval rows for one act —
  -- `priorApprovals` in `decisions.service.ts` counts both and stamps the next revision a version
  -- too high — and the stream carries a second announcement the consumer will dispatch.
  --
  -- TWO RULES, because the bundle breaks two things. (1) At most ONE approval-family audit row and
  -- ONE approval-family event per decision per transaction — unconditional, and the half that
  -- refuses the attack whatever else is true. (2) WHICH family is the revision's to say: §A.3 and
  -- P31 both put the finalizing event under the revision's recorded `approvedFrom`, so when that
  -- discriminator is present the family is determined and the other one is a misannouncement, not
  -- a choice. It is NULL through the drain (the column is dark until 4d-ii), so rule 2 is
  -- conditional on it exactly as the drain's other discriminators are — and rule 1 is not.
  --
  -- This also retires an abdication of the same shape as rounds 23 and 24: the table above gives
  -- `countersigned` and `stranded_resolved` a DISJUNCTION of the two families, with a comment
  -- saying which one applies is "the finalizer's business, not this seal's". `approvedFrom` is
  -- exactly where the finalizer's business is recorded, so when it is present this seal can and
  -- does read it rather than admitting either.
  IF NEW."type" IN ('approved', 'reapproved')
     OR 'decision.approved' = ANY (v_required) OR 'decision.reapproved' = ANY (v_required) THEN
    SELECT count(*) INTO v_fam FROM "DecisionEvent" d
     WHERE d."decisionId" = NEW."decisionId"
       AND d."type" IN ('approved', 'reapproved')
       AND d."xmin" = txid_current()::text::xid;
    IF v_fam > 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % gains % approval-family audit rows in this transaction (`approved` and `reapproved` together) — an approval is ONE act announced ONE way, and a second family is an immutable duplicate the approval COUNT reads as another cycle',
        NEW."decisionId", v_fam;
    END IF;
    SELECT count(*) INTO v_fam FROM "DomainEvent" e
     WHERE e."projectId" = v_project AND e."entityType" = 'Decision'
       AND e."entityId" = NEW."decisionId"
       AND e."eventType" IN ('decision.approved', 'decision.reapproved')
       AND e."xmin" = txid_current()::text::xid;
    IF v_fam > 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % emits % approval-family events in this transaction — one act announces once, and the consumer dispatches every one of them, so a second is a delivery of an approval that did not happen',
        NEW."decisionId", v_fam;
    END IF;

    -- AND THE REVISION SAYS WHICH FAMILY. min/max for round 23's reason: two revisions disagreeing
    -- about their source is an ambiguity to refuse, not one to resolve by picking a row.
    SELECT min(r."approvedFrom"), max(r."approvedFrom") INTO v_from, v_from_hi
      FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = v_project AND r."decisionId" = NEW."decisionId"
       AND r."xmin" = txid_current()::text::xid;
    IF v_from IS NOT NULL AND v_from IS NOT DISTINCT FROM v_from_hi THEN
      IF (v_from = 'pending' AND NEW."type" = 'reapproved')
         OR (v_from = 'change' AND NEW."type" = 'approved') THEN
        RAISE EXCEPTION
          'phase6 4d-i: the `%` audit row for decision % sits beside a revision recording `approvedFrom = %` — a decision approved from `%` is announced as %, and the other family names an act with a different history',
          NEW."type", NEW."decisionId", v_from, v_from,
          CASE v_from WHEN 'pending' THEN '`approved`' ELSE '`reapproved`' END;
      END IF;
      IF EXISTS (
        SELECT 1 FROM "DomainEvent" e
         WHERE e."projectId" = v_project AND e."entityType" = 'Decision'
           AND e."entityId" = NEW."decisionId"
           AND e."eventType" = CASE v_from WHEN 'pending' THEN 'decision.reapproved' ELSE 'decision.approved' END
           AND e."xmin" = txid_current()::text::xid) THEN
        RAISE EXCEPTION
          'phase6 4d-i: decision % emits the % event beside a revision recording `approvedFrom = %` — the delivery stream is what the push renders, and announcing the wrong family tells every recipient this decision has a history it does not have',
          CASE v_from WHEN 'pending' THEN '`decision.reapproved`' ELSE '`decision.approved`' END,
          NEW."decisionId", v_from;
      END IF;
    END IF;
  END IF;

  -- AND THE BINDING IS PER-BRANCH, BECAUSE THE ACT'S ROW IS (#582's review round 23, finding 3).
  --
  -- Round 19 wrote the rule correctly — "the act's records are bound to the act's ROW" — and then
  -- gated the whole block on `decision.approved`/`decision.reapproved`, which is one branch of the
  -- nine this seal answers for. Every other branch has an act row of its own, written in the same
  -- transaction and already judged hard by this file, and not one of them was asked: a standard
  -- request recorded against requester A could append its `change_requested` audit row and emit its
  -- event as B, a closure attributed and receipt-bound to resolver C could append both
  -- `change_withdrawn` effects as B, and the type and kind counts above pass either way. The rows
  -- are then immutable and 4d-iii's full converse cannot revisit them.
  --
  -- It also ran the binding for two branches whose authority is SOMEONE ELSE. `countersigned` and
  -- `stranded_resolved` carry `decision.approved`/`decision.reapproved` in `v_required` — they
  -- announce the approval they finalize — so the gate was true for them, and the revision they
  -- touch matches `xmin` because the countersign FLIPS `finalized` on it and this unit is what made
  -- that UPDATE legal. The seal therefore demanded that the countersigner BE the approver, which is
  -- the one thing a countersign never is: from 4d-ii every valid countersign would have rolled back
  -- here. `xmin` means "written here" and stopped meaning "born here" the moment the append-only
  -- seal was replaced by `DecisionApprovalRevision_t4d_one_flip`, and only this branch table
  -- noticed. THE OTHER TWO READERS OF THAT ROW'S `xmin` WERE CHECKED and neither is exposed:
  -- `phase6_t4d_awaiting_paired` filters `finalized = FALSE`, which a flipped row can never
  -- satisfy, and the birth seal's own count is reached only from an INSERT and already refuses a
  -- second matching row whatever wrote it. This was the only one.
  --
  -- So the authority is resolved BY BRANCH, from the fact that records the act:
  --
  --   approved / reapproved   → DecisionApprovalRevision."approvedById"     (the approval)
  --   countersigned           → DecisionCountersign."countersignedById"     (the finalizer)
  --   stranded_resolved       → DecisionStrandedResolution."resolvedById"   (the resolver)
  --   change_requested        → ChangeRequest."requestedById"               (the request opened here)
  --   change_withdrawn        → ChangeRequest."resolvedById"                (the request closed here)
  --   forwarded               → DecisionForward."forwardedById"             (the displacing actor)
  --   countersign_renotified  → none: the re-notification writes no fact row, and §A.3 makes this
  --                             audit row itself the branch's primary — there is nothing behind it
  --                             to disagree with, which is a silence this comment states rather
  --                             than leaves.
  --
  -- min/max rather than a bare `SELECT INTO`, which takes an arbitrary row in silence: if two act
  -- rows of one branch name different people the binding must refuse rather than pick one. The
  -- per-fact count seals elsewhere in this file already make that unreachable on every path they
  -- cover; this says so where the value is read, so a branch they do not cover cannot pass by luck.
  -- Both aggregates SKIP NULLs, so the question they answer is "everyone this branch's act rows
  -- name is the same person" — a row that names nobody is the drain's own shape and is left to the
  -- columns' own NOT NULL rules rather than invented here.
  --
  -- THE DRAIN KEEPS ITS EXCEPTION on both sides, unchanged: a NULL authority (no fact row yet) and
  -- a NULL actor (a previous-release audit row, or an envelope no released code writes until
  -- 4d-ii) are each compared only when they name somebody.
  v_approver := NULL; v_actor_hi := NULL; v_row := NULL;
  IF NEW."type" IN ('approved', 'reapproved') THEN
    -- No born-versus-flipped filter is needed HERE, and the min/max in this branch is why: if a
    -- bundle both births a revision and flips another in one transaction, the two `approvedById`
    -- values either agree — in which case there is nothing to pick between — or differ, and the
    -- ambiguity arm below refuses rather than choosing one in silence.
    v_row := 'the approval revision this transaction wrote';
    SELECT min(r."approvedById"), max(r."approvedById") INTO v_approver, v_actor_hi
      FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = v_project AND r."decisionId" = NEW."decisionId"
       AND r."xmin" = txid_current()::text::xid;
  ELSIF NEW."type" = 'countersigned' THEN
    v_row := 'the countersign this transaction wrote';
    SELECT min(c."countersignedById"), max(c."countersignedById") INTO v_approver, v_actor_hi
      FROM "DecisionCountersign" c
     WHERE c."projectId" = v_project AND c."decisionId" = NEW."decisionId"
       AND c."xmin" = txid_current()::text::xid;
  ELSIF NEW."type" = 'stranded_resolved' THEN
    v_row := 'the stranded resolution this transaction wrote';
    SELECT min(r."resolvedById"), max(r."resolvedById") INTO v_approver, v_actor_hi
      FROM "DecisionStrandedResolution" r
     WHERE r."projectId" = v_project AND r."decisionId" = NEW."decisionId"
       AND r."xmin" = txid_current()::text::xid;
  ELSIF NEW."type" = 'forwarded' THEN
    v_row := 'the forward this transaction wrote';
    SELECT min(f."forwardedById"), max(f."forwardedById") INTO v_approver, v_actor_hi
      FROM "DecisionForward" f
     WHERE f."projectId" = v_project AND f."decisionId" = NEW."decisionId"
       AND f."xmin" = txid_current()::text::xid;
  ELSIF NEW."type" = 'change_requested' THEN
    -- OPEN, which is what a request BORN here is. `ChangeRequest` is written twice in its life, so
    -- `xmin` alone would also match the row this transaction CLOSED; the status separates them
    -- exactly, and each side reads the column its own act wrote.
    v_row := 'the change request this transaction opened';
    SELECT min(cr."requestedById"), max(cr."requestedById") INTO v_approver, v_actor_hi
      FROM "ChangeRequest" cr
     WHERE cr."projectId" = v_project AND cr."decisionId" = NEW."decisionId"
       AND cr."status" = 'open'
       AND cr."xmin" = txid_current()::text::xid;
  ELSIF NEW."type" = 'change_withdrawn' THEN
    v_row := 'the change request this transaction closed';
    SELECT min(cr."resolvedById"), max(cr."resolvedById") INTO v_approver, v_actor_hi
      FROM "ChangeRequest" cr
     WHERE cr."projectId" = v_project AND cr."decisionId" = NEW."decisionId"
       AND cr."status" <> 'open'
       AND cr."xmin" = txid_current()::text::xid;
  END IF;

  IF v_approver IS NOT NULL THEN
    IF v_approver IS DISTINCT FROM v_actor_hi THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % carries SEVERAL % rows written by this transaction naming different actors (% and %) — the `%` audit row cannot be bound to an act whose own records disagree about who performed it',
        NEW."decisionId", v_row, v_approver, v_actor_hi, NEW."type";
    END IF;
    IF NEW."actorId" IS NOT NULL AND NEW."actorId" <> v_approver THEN
      RAISE EXCEPTION
        'phase6 4d-i: the `%` audit row for decision % is attributed to %, but % records % as the actor — one act has one actor, and two immutable records naming different people leave a register that cannot say who decided',
        NEW."type", NEW."decisionId", NEW."actorId", v_row, v_approver;
    END IF;
    IF EXISTS (
      SELECT 1 FROM "DomainEvent" e
       WHERE e."projectId" = v_project AND e."entityType" = 'Decision'
         AND e."entityId" = NEW."decisionId" AND e."eventType" = ANY (v_required)
         AND e."xmin" = txid_current()::text::xid
         AND e."actorId" IS NOT NULL AND e."actorId" <> v_approver) THEN
      RAISE EXCEPTION
        'phase6 4d-i: the % event announcing decision % names an actor other than %, which % records — the delivery stream is what the push renders, so a mismatch announces the act under the wrong name and no later write can correct it',
        array_to_string(v_required, ' or '), NEW."decisionId", v_approver, v_row;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- MARKER-AWARE (§D; #572's review round 23, finding 2). On a fresh install or an ordinary
-- upgrade this weak body is correct and is installed. On a P3005 BASELINE REPLAY of a MATURE
-- database — one where `RolloutRetirement` already carries `phase6-4d` — 4d-iii has already
-- replaced this trigger with the FULL converse, and re-pointing it here would DOWNGRADE a live
-- seal while waiting for a stage that has already run.
--
-- The guard is therefore "leave it alone", not "install 4d-iii's body". Carrying a copy of a
-- later unit's body in this file would mean two definitions of one seal drifting apart, and the
-- outcome the plan asks for — the mature database keeps the full body — is exactly what NOT
-- touching it produces.
DO $$
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — DecisionEvent_t4d_correspondence is left as 4d-iii installed it (this is a replay over a retired database; re-pointing it here would downgrade the live seal to the weak body)';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS "DecisionEvent_t4d_correspondence" ON "DecisionEvent";
  CREATE CONSTRAINT TRIGGER "DecisionEvent_t4d_correspondence"
    AFTER INSERT ON "DecisionEvent" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION phase6_t4d_event_correspondence_weak();
END $$;

-- ── the spec tables' finality CARRIER ────────────────────────────────────────────────────────
-- A requirement spec's provenance is an approval that REALLY happened — the delivered FK already
-- says that. 4d adds a second claim: it must be an approval that is FINAL. Under a chain an
-- approval is provisional until countersigned, and a material or labour demand derived from one
-- would be a commitment made on a decision nobody has finished making.
--
-- The mechanism is an FK, not a trigger. `revisionFinalized` exists to CARRY the referenced
-- value: the provenance FK is re-targeted at a widened candidate key that includes the
-- register's `finalized`, so a spec whose carrier says `true` can only bind a revision that IS
-- finalized, judged by the database on every write with no rule for anyone to remember.
--
-- DEFAULT `true` and KEPT: every existing spec references a finalized revision, because before
-- 4d every revision was born final. The CHECK states the rule in the table itself, where a
-- reader meets it — the FK enforces it, and the two agree by construction.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionApprovalRevision_finalized_provenance_key"
  ON "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized");

ALTER TABLE "MaterialRequirementSpec"
  ADD COLUMN IF NOT EXISTS "revisionFinalized" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "LabourRequirementSpec"
  ADD COLUMN IF NOT EXISTS "revisionFinalized" BOOLEAN NOT NULL DEFAULT TRUE;

DO $$ BEGIN
  ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_revisionFinalized_check"
    CHECK ("decisionId" IS NULL OR "revisionFinalized" = TRUE);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_revisionFinalized_check"
    CHECK ("decisionId" IS NULL OR "revisionFinalized" = TRUE);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The RE-TARGET. The old FK is dropped and the widened one added in the same transaction, so no
-- window exists in which a spec's provenance is unconstrained.
ALTER TABLE "MaterialRequirementSpec" DROP CONSTRAINT IF EXISTS "MaterialRequirementSpec_provenance_fkey";
DO $$ BEGIN
  ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_provenance_fkey"
    FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey", "revisionFinalized")
    REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "LabourRequirementSpec" DROP CONSTRAINT IF EXISTS "LabourRequirementSpec_provenance_fkey";
DO $$ BEGIN
  ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_provenance_fkey"
    FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey", "revisionFinalized")
    REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the four consultation attribution columns ────────────────────────────────────────────────
-- §A.3 obligation 3 applies to the 4c facts too, and #562's review round 2, finding 4 records
-- the inventory naming ONE of the four. All four, nullable for legacy and drain-window rows,
-- frozen once written by the seal below; 4d-ii writes them and 4d-iii requires them.
ALTER TABLE "DecisionConsultation" ADD COLUMN IF NOT EXISTS "requestedByRole" TEXT;
ALTER TABLE "DecisionConsultation" ADD COLUMN IF NOT EXISTS "requestedByName" TEXT;
ALTER TABLE "DecisionConsultationResponse" ADD COLUMN IF NOT EXISTS "respondedByRole" TEXT;
ALTER TABLE "DecisionConsultationResponse" ADD COLUMN IF NOT EXISTS "respondedByName" TEXT;

CREATE OR REPLACE FUNCTION phase6_t4d_consultation_attribution_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_old_role TEXT; v_old_name TEXT; v_new_role TEXT; v_new_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    v_old_role := OLD."requestedByRole"; v_old_name := OLD."requestedByName";
    v_new_role := NEW."requestedByRole"; v_new_name := NEW."requestedByName";
  ELSE
    v_old_role := OLD."respondedByRole"; v_old_name := OLD."respondedByName";
    v_new_role := NEW."respondedByRole"; v_new_name := NEW."respondedByName";
  END IF;

  IF (v_old_role IS NOT NULL AND v_new_role IS DISTINCT FROM v_old_role)
     OR (v_old_name IS NOT NULL AND v_new_name IS DISTINCT FROM v_old_name) THEN
    RAISE EXCEPTION
      'phase6 4d-i: the frozen attribution pair on %.% is evidence of WHO acted and may not be rewritten (% / % → % / %)',
      TG_TABLE_NAME, NEW."id",
      COALESCE(v_old_role, '<null>'), COALESCE(v_old_name, '<null>'),
      COALESCE(v_new_role, '<null>'), COALESCE(v_new_name, '<null>');
  END IF;

  -- AND ONE-WAY GOVERNS THE SECOND WRITE, WHICH SAYS NOTHING ABOUT THE FIRST — a rule this unit
  -- owes, and one that is CURRENTLY UNREACHABLE HERE. Both halves of that are measured, and both
  -- are stated, because the second half is what round 17's sweep got wrong.
  --
  -- THE RULE. The arm above keys on `OLD IS NOT NULL`, so NULL -> value passes it by
  -- construction, and every rule this pair has — nonblank, and since round 16 the
  -- `phase6_t4d_actor_bound` correspondence — lives in
  -- `phase6_t4d_consultation_attribution_present`, which is BEFORE **INSERT**. On the face of it
  -- an all-null legacy row could therefore be handed a pair by a later UPDATE with nothing asked
  -- of it. Unlike the change request's RESOLVER set this pair has no later act to be written on:
  -- a consultation's requester and a response's responder are settled at the instant the row is
  -- written, exactly like the change request's BIRTH set. So the rule is the birth set's rule.
  --
  -- WHY IT CANNOT FIRE TODAY, and this is the correction. The DELIVERED 4c seal
  -- `phase6_t4c_consultation_append_only` is installed on BOTH tables as
  -- `<table>_t4c_append_only`, BEFORE UPDATE OR DELETE, and PostgreSQL fires row triggers in NAME
  -- order: `_t4c_` sorts before `_t4d_`, so it answers first and refuses EVERY update to either
  -- table. The whole of `phase6_t4d_consultation_attribution_frozen` — this arm and the freeze
  -- above it — is therefore unreachable, which is also why the harness declares that trigger
  -- covered by its class rather than stripping it.
  --
  -- Round 17 reported this as a live hole and it is not one. It is written anyway, and the
  -- statement of the rule is the reason: this seal's completeness may not DEPEND on another
  -- unit's seal continuing to exist. 4d-iii replaces seals by name, and a rule left half-stated
  -- here is one that becomes a hole the moment the object in front of it moves. The harness
  -- proves the unreachability rather than asserting it, so if that ever changes the arm goes red
  -- instead of this comment going quietly stale.
  IF (v_old_role IS NULL AND v_new_role IS NOT NULL)
     OR (v_old_name IS NULL AND v_new_name IS NOT NULL) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% is being given an attribution pair (`%`, `%`) it was not born with — who asked for advice and who gave it is settled when the row is written, and a pair supplied afterwards is a claim about an act this update did not perform. The INSERT seal is where the pair is judged against the actor; there is nothing here to judge it against.',
      TG_TABLE_NAME, NEW."id",
      COALESCE(v_new_role, '<null>'), COALESCE(v_new_name, '<null>');
  END IF;
  RETURN NEW;
END $$;

-- THE PAIR IS WRITTEN AS A PAIR (#582 round 6, finding 5). The freeze above governs UPDATE only,
-- so through the 4d-i → 4d-iii window a direct INSERT could supply a role with no name, or a name
-- with no role — and the DELIVERED append-only seal then makes that half-attribution PERMANENT.
-- 4d-iii's "future inserts must carry the pair" cannot repair a row already committed, and the
-- consequence is not merely untidy: 4d-ii builds the response push audience from a request's
-- frozen `requestedByRole`, so a fabricated role with no name to contradict it steers who gets
-- told. A CHECK is the right instrument because it binds every writer at every moment, including
-- the ones this unit cannot see; the all-null legacy shape stays admitted, which is what keeps
-- the drain window open for the previous release.
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_t4d_attribution_pair_check"
    CHECK (("requestedByRole" IS NULL) = ("requestedByName" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_t4d_attribution_pair_check"
    CHECK (("respondedByRole" IS NULL) = ("respondedByName" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- and a pair that IS present is judged at INSERT, not only frozen afterwards: a blank role or a
-- blank name satisfies the CHECK above (neither is null) while attributing nothing at all.
CREATE OR REPLACE FUNCTION phase6_t4d_consultation_attribution_present() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_role TEXT; v_name TEXT; v_actor TEXT;
BEGIN
  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    v_role := NEW."requestedByRole"; v_name := NEW."requestedByName"; v_actor := NEW."requestedById";
  ELSE
    v_role := NEW."respondedByRole"; v_name := NEW."respondedByName"; v_actor := NEW."respondedById";
  END IF;
  IF v_role IS NULL THEN RETURN NEW; END IF;   -- the legacy all-null shape, admitted by the CHECK
  IF btrim(v_role, E' \t\n\x0B\f\r') = '' OR btrim(v_name, E' \t\n\x0B\f\r') = '' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% carries a blank attribution pair (role `%`, name `%`) — the pair is evidence of WHO acted, it is frozen the moment it lands, and a blank half attributes nothing while looking attributed',
      TG_TABLE_NAME, NEW."id", COALESCE(v_role, '<null>'), COALESCE(v_name, '<null>');
  END IF;

  -- AND NONBLANK IS NOT TRUE (#582's review round 16, finding 6). Round 6 gave this pair the
  -- coherence rule (both or neither) and round 6's own follow-up gave it the nonblank rule, and
  -- BOTH are rules about the pair's SHAPE. Neither asks whether it is true of anybody. The
  -- delivered 4c request seal validates `requestedById` and stops there, so a direct write could
  -- name a legitimately authorized requester and attach any nonblank role and name it liked — and
  -- the freeze above makes that permanent. It is not only a false byline: the response emitter
  -- reads the FROZEN request-time role to choose its push audience, so a forged `architect` there
  -- misdirects the announcement as well as the attribution.
  --
  -- So it goes through `phase6_t4d_actor_bound`, like every other frozen pair in this unit: the
  -- role must be one the actor holds on this project, and the name must be the register's.
  PERFORM phase6_t4d_actor_bound(NEW."projectId", v_actor, v_role, v_name,
                                 TG_TABLE_NAME || ' ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_attribution" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_attribution" BEFORE UPDATE ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_attribution" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_attribution" BEFORE UPDATE ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();
DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_attribution_present" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_attribution_present" BEFORE INSERT ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_present();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_attribution_present" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_attribution_present" BEFORE INSERT ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_present();

-- ── one re-notification per crossing ─────────────────────────────────────────────────────────
-- When the architect set changes while a decision awaits countersign, the new holder is notified
-- ONCE per crossing (§A.2, and #572's review round 19 puts `countersign_renotified` among the
-- audit kinds the correspondence judges). The audit row names the crossing event, and the
-- PARTIAL unique makes a second row for the same crossing unrepresentable rather than merely
-- refused by whichever writer happens to check.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionEvent_countersign_renotified_key"
  ON "DecisionEvent"("decisionId", (("payload" ->> 'crossingEventId')))
  WHERE "type" = 'countersign_renotified';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- THE DARK FACT TABLES MUST BE EMPTY WHEN THIS UNIT SEALS THEM
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- #582's review round 9, finding 1, and it is round 8's register rule applied where round 8
-- stopped. Round 8 audited the four adopted REGISTERS against their sources and left the FACT
-- tables alone, on no stated reason — the same "fixed at the site, not for the class" habit this
-- unit has now been corrected for three rounds running.
--
-- The exposure is the same and the remedy is stronger. On the supported db-push/P3005 path
-- `schema.prisma` can create these tables before any of their INSERT-time eligibility, pairing and
-- provenance triggers exist, so a constraint-valid row can be sitting in one: a `DecisionForward`
-- citing a historical receipt for a hand-off that never moved its decision, say. The FKs and
-- triggers this file adds validate NEITHER that row nor its provenance, the append-only seal then
-- makes it permanent, and 4d-ii consumes it as decision history.
--
-- "Prove each row against its transition" is the weaker answer. These tables are DARK: 4d-i
-- creates them and 4d-ii is their first writer, so before retirement there is no sanctioned
-- producer and the only correct population is NONE. Emptiness is the whole invariant, so that is
-- what is asserted.
--
-- GATED ON THE RETIREMENT SNAPSHOT, because after 4d-iii these tables legitimately hold the
-- history 4d-ii wrote, and an `ALWAYS_EXECUTE` replay over such a database must abort nothing —
-- exactly the defect round 6's finding 1 corrected in the zero-count audit, not repeated here.
DO $dark_tables$
DECLARE v_table TEXT; v_rows BIGINT; v_found TEXT := '';
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the dark-fact emptiness audit is SKIPPED (4d-ii has legitimately written these tables; this is a replay over a retired database)';
  ELSE
    -- THE TABLES THIS FILE CREATES. `MembershipTransition`, `DomainEventPairingClaim` and
    -- `ReleaseLease` are the registers half's, and it audits its own — a file cannot be said to
    -- stand alone while another one checks its tables for it.
    FOREACH v_table IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign',
                                   'DecisionStrandedResolution'] LOOP
      EXECUTE format('SELECT count(*) FROM %I', v_table) INTO v_rows;
      IF v_rows > 0 THEN
        v_found := v_found || format('%s%s (%s row(s))', CASE WHEN v_found = '' THEN '' ELSE ', ' END, v_table, v_rows);
      END IF;
    END LOOP;
    IF v_found <> '' THEN
      RAISE EXCEPTION
        'phase6 4d-i ABORT: dark fact table(s) already hold rows before this unit seals them — %. These tables have no sanctioned writer until 4d-ii, so a row present now was validated by none of the eligibility, pairing or provenance triggers this file installs, and the append-only seal would make it permanent evidence of an act nobody performed. Remove the rows (or, on a database that has genuinely run 4d-iii, restore its RolloutRetirement marker) before this migration adopts them.',
        v_found;
    END IF;
  END IF;
END $dark_tables$;

-- ── and the 4d-only SHAPE of the tables that ALREADY EXISTED ─────────────────────────────────
-- #582 round 11, finding 1, and the class it belongs to. The audit above asks whether the tables
-- this unit CREATES are empty. It never asked the same question of the columns this unit ADDS to
-- tables that were already there — and on the supported `db push` / P3005 baseline path those
-- columns can exist, populated, before a single raw 4d trigger does. Everything this unit
-- installs is then an INSERT-time or UPDATE-time seal, so a row already sitting in a 4d shape is
-- validated by nothing and frozen by the next write.
--
-- THE SWEEP, not the reported site. Round 11 named `ChangeRequest`, and fixing that alone is the
-- habit rounds 8, 9 and 10 were each caught in. Every table gaining a 4d-only column is listed
-- here, and each is required to be in its LEGACY shape before retirement:
--
--   · `ChangeRequest`      — a `countersign_rejection` row produced by no disagreement
--                            transition, whose evidence freeze makes its 4d columns immutable on
--                            the spot, whose INSERT-only pairing seal can never judge it, and
--                            which occupies the one-open-request slot so the real rejection
--                            cannot be raised. (The reported finding.)
--   · `DecisionApprovalRevision` — a `finalized = false` row is an OPEN approval under no chain,
--                            and the one-flip seal makes it permanently unfinalizable.
--   · the two consultation tables — the same frozen pair, with the same freeze.
--
--   · `DomainEvent` and `Notification` were HERE and MOVED to the registers half in round 19
--     (finding 1). Their columns and the seals that judge them are that file's, so an abort here
--     reported them AFTER those seals were committed and the repair it named was impossible. Each
--     half audits what it creates.
--
-- Each abort names the rows, because "some table is wrong" is not a repair an operator can make.
-- A blank pre-baseline pair may instead be refused earlier, by the CHECK that adds the nonblank
-- rule to the column; both refuse, and this one explains.
--
-- GATED ON THE RETIREMENT SNAPSHOT for the same reason the audit above is: after 4d-iii every one
-- of these shapes is the ordinary product of 4d-ii, and an `ALWAYS_EXECUTE` replay must abort on
-- none of them.
DO $legacy_shape$
DECLARE spec RECORD; v_rows BIGINT; v_sample TEXT; v_found TEXT := '';
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the legacy-shape audit is SKIPPED (4d-ii has legitimately written these columns; this is a replay over a retired database)';
  ELSE
    FOR spec IN SELECT * FROM (VALUES
      -- AND THE COLUMNS THIS FILE FREEZES, NOT THE ONES IT ADDED (#582's review round 35,
      -- finding 3). The predicate below listed the 4d columns, because those are the ones this
      -- unit created — and from this migration the PRE-EXISTING `status`, `resolvedById`,
      -- `resolvedAt` and `resolution` are lifecycle evidence too: frozen one-way, and read by the
      -- closure seal as the record of an act. A db-push/P3005 baseline can hold shapes no serving
      -- writer produces, and adopting them is not cosmetic:
      --
      --   · an OPEN request with a pre-filled `resolvedById` or `resolvedAt` is frozen with a
      --     resolver for a closure that never happened — and worse, its next LEGITIMATE closure is
      --     then refused, because the fill arms admit `NULL -> value` only. The request becomes
      --     permanently uncloseable.
      --   · a CLOSED request whose `status` contradicts its `resolution` is frozen as a permanent
      --     record saying both that the change was accepted and that it was abandoned.
      --
      -- What it refuses is exactly those two harms: resolver evidence on a row that is not closed,
      -- and a `resolution` that contradicts the `status` beside it. It asserts nothing about the
      -- status vocabulary and does not require a legacy closure to carry a resolver at all.
      ('ChangeRequest', 'id',
       '"origin" <> ''standard'' OR "revisionId" IS NOT NULL OR "sourceCommandId" IS NOT NULL'
       || ' OR "requestedByRole" IS NOT NULL OR "requestedByName" IS NOT NULL'
       || ' OR "resolvedByCommandId" IS NOT NULL OR "resolvedByRole" IS NOT NULL OR "resolvedByName" IS NOT NULL'       -- The two shapes that are INCOHERENT AS EVIDENCE, and only those. A legacy database
       -- legitimately holds statuses this unit does not write (`pending` predates `open`) and
       -- closed rows whose `resolution` is NULL — `schema.prisma` says so in as many words:
       -- "null on backfilled legacy rows". Demanding the CURRENT lifecycle's full shape of a
       -- legacy row would abort the apply on databases that are simply old, which is not a
       -- defect this audit exists to find.
       || ' OR (("resolvedAt" IS NOT NULL OR "resolvedById" IS NOT NULL)'
       || '     AND "status" NOT IN (''resolved'', ''withdrawn''))'
       || ' OR ("resolution" = ''reapproved'' AND "status" <> ''resolved'')'
       || ' OR ("resolution" = ''withdrawn''  AND "status" <> ''withdrawn'')'
       || ' OR ("resolution" IS NOT NULL AND "resolution" NOT IN (''reapproved'', ''withdrawn''))'),
      ('DecisionApprovalRevision', 'id',
       '"finalized" = FALSE OR "approvedFrom" IS NOT NULL OR "approvedByName" IS NOT NULL OR "approvedByRole" IS NOT NULL'),
      ('DecisionConsultation', 'id', '"requestedByRole" IS NOT NULL OR "requestedByName" IS NOT NULL'),
      ('DecisionConsultationResponse', 'id', '"respondedByRole" IS NOT NULL OR "respondedByName" IS NOT NULL')
    ) AS v(tbl, idcol, pred) LOOP
      EXECUTE format(
        'SELECT count(*), COALESCE(left(string_agg(%I, '', '' ORDER BY %I), 100), '''') FROM %I WHERE %s',
        spec.idcol, spec.idcol, spec.tbl, spec.pred) INTO v_rows, v_sample;
      IF v_rows > 0 THEN
        v_found := v_found || format('%s%s (%s row(s): %s)',
          CASE WHEN v_found = '' THEN '' ELSE '; ' END, spec.tbl, v_rows, v_sample);
      END IF;
    END LOOP;
    IF v_found <> '' THEN
      RAISE EXCEPTION
        'phase6 4d-i ABORT: row(s) already carry this unit''s 4d-only columns before it seals them — %. These columns have no sanctioned writer until 4d-ii, so a value present now was judged by none of the eligibility, pairing, provenance or attribution triggers this file installs, and the freezes it installs would make each one permanent. Reset the named rows to their legacy shape (a `standard` request with no 4d evidence, a finalized revision, an unattributed consultation) before this migration adopts them. The consultation tables are append-only at the DELIVERED layer, so that reset needs the transactional repair in docs/RUNBOOK.md §P6T4D, which disables each blocking trigger by name and re-enables it in the same transaction.',
        v_found;
    END IF;
  END IF;
END $legacy_shape$;


COMMIT;
