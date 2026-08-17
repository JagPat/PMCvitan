-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 10
--
--   R10-1: REMOVE the restoration exemption. Do not narrow it a fifth time.
--   R10-2: a draft something already depends on cannot be converted to a record.
--
-- ── R10-1 — WHY REMOVAL RATHER THAN A FIFTH PREDICATE ──────────────────────────────────────
-- One rule was re-cut in rounds 6, 7, 8 and 9, and every attempt was over-broad or forgeable:
--   r6  keyed the demand to a transition        -> broke `withdrawChange` on every legacy row
--   r7  exempted "arrives at approved"          -> admitted `pending -> approved`, a forgery door
--   r8  required an approval DecisionEvent      -> the event is plantable
--   r9  required that event to predate the open request -> BOTH inputs forgeable: close the
--       request so the COALESCE bound reads `infinity`, or rewrite the caller-supplied
--       `DecisionEvent."at"`.
-- The lesson is not that a fifth predicate would finally be tight. Every one of them asked a
-- question ABOUT ROWS A CALLER CAN WRITE, and a caller wins that argument every time. The only
-- evidence a later caller cannot manufacture is evidence written ONCE, by a migration, behind a
-- door that is then closed.
--
-- So the exemption's EVIDENCE is not narrowed — it is replaced by an enumerated set fixed at
-- upgrade time. `DecisionLegacyApproval` names exactly the rows that were already approved when
-- this migration ran, and the set can never grow: the table refuses every subsequent INSERT and
-- UPDATE.
--
-- Note what is NOT deleted. `v_restores` survives, carrying round 7's other two conditions — a
-- restoration comes FROM `change`, and it alters no approval evidence. Those were never the
-- problem: they are facts about the statement in front of the trigger, not questions about rows
-- someone else wrote, so no caller can lie to them. Only the "an approval actually happened"
-- clause — the one rounds 8 and 9 kept trying to prove from plantable rows — is replaced.
-- Dropping the other two along with it would let a stamped legacy row be silently re-approved
-- onto a DIFFERENT option with nobody named, which is a weakening R10-1 never asked for.
--
-- WHY STAMP EVERY LEGACY APPROVAL RATHER THAN BACKFILL THE DERIVABLE ONES. The first draft of
-- this migration backfilled the holder tuple wherever it looked recoverable and stamped only the
-- remainder. That was wrong twice over. Mechanically, it wrote `orgs_membership_display_name` into
-- `approvedDeciderLabel` for `client`-held rows, where the canonical label is the constant
-- `'Client'` that `decisions_t4b_holder_label` renders — so the "recovered" attribution would not
-- even have matched the one a fresh approval writes. Substantively, it was the same mistake as
-- rounds 6-9 in a new costume: `deciderKind` on a pre-Phase-6 row was itself DEFAULTED by
-- `20270815000000`, so materialising it as "who held this approval" asserts a fact the historical
-- record never captured. A pre-Phase-6 approval has no attribution. Saying so is the truth;
-- deriving one is fabrication, however plausible the derivation looks.
--
-- What the register therefore shows for a legacy row is no holder tuple — which is exactly what
-- happened. The safety property is not that these rows are attributed; it is that the set of
-- unattributed rows is FINITE, FROZEN and ENUMERABLE, and no act after this migration can add to
-- it.
--
-- ── R10-2 — THE REVERSE OF A RULE THAT WAS ONLY ENFORCED FORWARDS ──────────────────────────
-- `decisions.linkableInProject` refuses to LINK a `recorded` decision, because a record is
-- approvable by nobody and the dependent's gate would wait forever. The reverse direction was
-- open: link an ordinary draft, THEN convert that draft to a record, and the same dead gate
-- exists — reached by walking the two legal steps in the other order.
--
-- The conversion must therefore not be able to create a state the link rule would have refused.
-- It asks the OWNING modules, through predicates named for their owners, and reads no peer table
-- itself — the same channel `orgs_user_decision_authority` uses.
--
-- `20270815000000` … `20270826000000` are byte-for-byte unchanged.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── the one-time evidence ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DecisionLegacyApproval" (
  "decisionId" TEXT PRIMARY KEY REFERENCES "Decision"("id") ON DELETE CASCADE,
  "stampedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every approval standing at upgrade time with no holder tuple: marked as what it is, never given
-- an invented one. On a fresh database this stamps nothing, and the exemption below is unreachable
-- by construction.
--
-- ROUND 11 (R11-1): `change` is in the set, and leaving it out was a real upgrade bug. A
-- pre-Phase-6 approval can be sitting in `change` on the day of the deploy — someone raised an
-- ordinary change request against it last week — and `requestChange` is the ONLY way the product
-- reaches that status, so such a row is exactly as much a legacy approval as an `approved` one.
-- Stamping only `approved` left it out of the set, and its perfectly ordinary `withdrawChange()`
-- would then fail forever: the restoration it performs is an evidence-preserving
-- `change → approved`, which is precisely what the exemption exists to permit.
--
-- These are the only two statuses that matter: `v_restores` requires `OLD.status = 'change'`, so a
-- tupleless `pending` row could never use the exemption anyway and is deliberately not stamped.
-- The migration reads the database's state at upgrade time as history — the same premise the
-- `approved` arm already rests on, now stated once for both.
--
-- ROUND 11 (R11-4): the stamp is ONE-SHOT, and the guard is the seal's own existence.
--
-- Two things had to be true at once, and only this shape gives both.
--
-- RE-RUNNABLE: `ON CONFLICT DO NOTHING` cannot do it, because PostgreSQL fires a BEFORE INSERT
-- trigger BEFORE it resolves the conflict — the seal would raise on a row the conflict clause was
-- about to discard, aborting a migration this repository requires to be retryable.
--
-- STILL A SET FIXED AT UPGRADE TIME, which is the stronger requirement, and the one a per-row
-- "skip what is already stamped" guard silently breaks. Because `change` is in the predicate, a
-- second run days later would stamp every row that entered `change` SINCE the upgrade — handing
-- the exemption to precisely the rows the seals exist to refuse. That is measured, not imagined:
-- with the per-row guard, `upgrade-proof.sh`'s re-run tried to stamp the round-10 forgery target,
-- which sits in `change` because a probe put it there after the upgrade.
--
-- So the question asked is not "is this row already stamped?" but "has this migration already
-- run?", and the seal below is the answer: it exists only after a completed first run, and
-- creating it is the last thing this section does. First run — absent, so the stamp proceeds.
-- Every run after — present, so the predicate is empty and the migration is a true no-op.
-- Re-opening the stamp means dropping that trigger, which needs table ownership: the same
-- privilege as every other sanctioned bypass in this schema, and no less visible.

-- …and close the door behind the migration. This is the property the whole redesign rests on: the
-- exemption set is enumerated once and can never be added to.
CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_sealed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The one lawful reason a row leaves: its subject ceased to exist and the FK cascade is
    -- clearing up after it. PostgreSQL performs the parent DELETE before running the referential
    -- action, so by the time the cascade reaches here the `Decision` is already gone — which is
    -- precisely the test. A direct DELETE, with the decision still standing, is refused.
    --
    -- Deleting evidence could only ever REMOVE an exemption, never grant one, so this arm is not
    -- what stops a forger. It is here so the sentence "this table is one-time migration evidence"
    -- is true without a footnote.
    IF NOT EXISTS (SELECT 1 FROM "Decision" WHERE "id" = OLD."decisionId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'phase6-4b: "DecisionLegacyApproval" is one-time migration evidence — it cannot be deleted while decision % still exists.', OLD."decisionId";
  END IF;
  RAISE EXCEPTION 'phase6-4b: "DecisionLegacyApproval" is one-time migration evidence — it cannot be written after 20270827000000, which is the only reason it can be trusted.';
END $$;

-- ROUND 11 (R11-5): …and TRUNCATE, which fires NO row trigger. Elsewhere in this schema a truncate
-- is a sanctioned test/seed reset and is deliberately left uncovered; here it is not, because this
-- table is the ONLY proof that a legacy withdrawal is legitimate. Erasing it leaves every affected
-- decision standing while the evidence that lets it be withdrawn is gone — the exemption would fail
-- closed on real history, silently, with nothing to point at. A statement-level seal is the only
-- shape that can refuse this verb.
-- CONDITIONAL, exactly like `DecisionEvent_t4a_no_truncate` beside it, and for the same reason. A
-- blanket refusal is not the rule anyone wants: it would break the sanctioned destructive resets
-- this schema deliberately performs by TRUNCATE, and it was measured doing so — `event-catalog`'s
-- `TRUNCATE "Decision" … CASCADE` reaches this table through the cascade.
--
-- What must never happen is erasing evidence that is HOLDING SOMETHING UP. So the question is
-- whether there is any evidence at stake at all: an empty register has nothing to protect and a
-- reset may proceed, while a register with rows in it cannot be emptied by a verb the row seal
-- never sees. A legitimate full reset of a database that HAS stamped rows takes the same named
-- `ALTER TABLE … DISABLE TRIGGER` bypass `wipeDecisions` already uses for the other seals — a
-- privilege, and a visible one.
CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DecisionLegacyApproval") THEN
    RAISE EXCEPTION 'phase6-4b: "DecisionLegacyApproval" is one-time migration evidence — it cannot be truncated while it holds rows; the decisions it exempts would outlive their own proof.';
  END IF;
  RETURN NULL;
END $$;

-- (both triggers are created inside the atomic DO block above — see R13-2.)

-- ── R10-2: the reverse of the link rule, asked of the modules that own the dependents ────────
-- Named for their owners and defined here for the same reason `orgs_user_decision_authority` is:
-- the decisions trigger must not reach into a peer's table, so the peer states its own fact and
-- the trigger asks the question. Both are the exact write-path twins of the two
-- `decisions.linkableInProject` call sites — `activities.service` and `daily-log.service` — so
-- the two directions cannot drift into disagreeing about what a dependency is.
CREATE OR REPLACE FUNCTION activities_decision_has_dependents(p_project_id TEXT, p_decision_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Activity" a
     WHERE a."projectId" = p_project_id AND a."decisionId" = p_decision_id);
$$;

CREATE OR REPLACE FUNCTION daily_log_decision_has_dependents(p_project_id TEXT, p_decision_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "SiteMaterial" m
     WHERE m."projectId" = p_project_id AND m."decisionId" = p_decision_id);
$$;

-- ROUND 13 (R13-2): the stamp and its seal are ONE STATEMENT, so they commit together or not at
-- all. The guard alone is not enough. Applied non-transactionally — which is exactly how
-- `upgrade-proof.sh` applies migration files, with `psql -f` autocommitting each statement — an
-- interruption between the INSERT and the CREATE TRIGGER commits the rows and leaves no seal. The
-- retry then sees no seal, re-selects the same legacy rows, and dies on the primary key before it
-- can ever close the set: a state that cannot be resumed and cannot be re-run.
--
-- A per-row "skip what is stamped" guard would make that retry succeed and would reintroduce the
-- widening round 11 removed, because with no seal present it cannot tell a resumed apply from a
-- dropped seal. A DO block removes the question instead of answering it: PostgreSQL treats it as a
-- single statement, so the partially-applied state this finding describes cannot exist.
DO $do$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
          JOIN pg_class c ON c.oid = tg.tgrelid
         WHERE c.relname = 'DecisionLegacyApproval'
           AND tg.tgname = 'DecisionLegacyApproval_sealed') THEN

    INSERT INTO "DecisionLegacyApproval" ("decisionId")
    SELECT d."id" FROM "Decision" d
     WHERE d."status"::text IN ('approved', 'change')
       AND d."approvedDeciderKind" IS NULL;

    EXECUTE 'DROP TRIGGER IF EXISTS "DecisionLegacyApproval_no_truncate" ON "DecisionLegacyApproval"';
    EXECUTE 'CREATE TRIGGER "DecisionLegacyApproval_sealed"
               BEFORE INSERT OR UPDATE OR DELETE ON "DecisionLegacyApproval"
               FOR EACH ROW EXECUTE FUNCTION decision_t4b_legacy_evidence_sealed()';
    EXECUTE 'CREATE TRIGGER "DecisionLegacyApproval_no_truncate"
               BEFORE TRUNCATE ON "DecisionLegacyApproval"
               FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_legacy_evidence_no_truncate()';
  END IF;
END $do$;

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
  v_legacy    INT;
  v_label     TEXT;
  v_writing   BOOLEAN;
  v_restores  BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published recorded issue is a permanent register entry (%) — it cannot be deleted.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'recorded' THEN
      PERFORM t4b_require_readiness_key(NEW."projectId", 'filing a recorded issue');
      IF NOT orgs_user_decision_authority(NEW."projectId", NEW."authorId") THEN
        RAISE EXCEPTION 'phase6-4b: a recorded issue must be filed by a user with decision authority on an operable project (%).', NEW.id;
      END IF;
    END IF;
    IF NEW.status::text <> 'approved' AND (
         NEW."approvedDeciderKind" IS NOT NULL
      OR NEW."approvedDeciderMembershipId" IS NOT NULL
      OR NEW."approvedDeciderLabel" IS NOT NULL) THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple belongs to an APPROVAL (%) — it cannot be planted on a row that carries none.', NEW.id;
    END IF;
    -- R4-2 as round 11 (R11-3) closes it. R4-2 let a row be BORN `approved` with no tuple at all,
    -- because that was the shape legacy rows arrive in and nothing else could account for them.
    -- Round 10 removed that justification: legacy is now the FINITE SET this migration stamped,
    -- and every one of those rows already exists — none of them is ever inserted again. A row
    -- inserted from here on is by definition not legacy, so an absent tuple is no longer the
    -- legacy shape; it is simply an approval that names nobody, and R2-1 forbids repairing it
    -- afterwards, so it would be permanently unattributed.
    --
    -- The door mattered: a direct writer could insert an unpublished row already at `approved`
    -- with the tuple null, add its options, publish it, and the register would carry an
    -- unattributable approval created after the upgrade. No product path is affected —
    -- `decisions.create` only ever inserts `pending` or `recorded`, and every real approval is the
    -- UPDATE that `approve()` performs, which writes the tuple.
    IF NEW.status::text = 'approved' THEN
      IF NEW."approvedDeciderKind" IS NULL AND NEW."approvedDeciderMembershipId" IS NULL
         AND NEW."approvedDeciderLabel" IS NULL THEN
        RAISE EXCEPTION 'phase6-4b: a decision born approved (%) records WHO approved it — after 20270827000000 the legacy approvals are an enumerated set that already exists, so a NEW approval with no holder tuple is not history, it is an approval nobody can be held to.', NEW.id;
      END IF;
      -- R5-3 + R6-3: complete, and non-blank across the WHOLE ASCII whitespace set.
      IF NEW."approvedDeciderKind" IS NULL OR decisions_t4b_blank(NEW."approvedDeciderLabel") THEN
        RAISE EXCEPTION 'phase6-4b: a decision born approved (%) carries the WHOLE approval holder tuple or none of it — half an attribution is an attribution.', NEW.id;
      END IF;
      IF NEW."approvedDeciderKind"::text IS DISTINCT FROM NEW."deciderKind"::text THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must record the decider of % (designated %, tuple says %) — an approval is attributed to whoever held the decision, not to whoever wrote the row.', NEW.id, NEW."deciderKind"::text, COALESCE(NEW."approvedDeciderKind"::text, '<null>');
      END IF;
      IF NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must name the decider''s own membership on % — a member-held approval belongs to the member it was designated to.', NEW.id;
      END IF;
      -- R5-3: …and the LABEL renders that same holder. One statement of the rule, asked here.
      v_label := decisions_t4b_holder_label(NEW."projectId", NEW."deciderKind"::text, NEW."deciderMembershipId");
      IF NEW."approvedDeciderLabel" IS DISTINCT FROM v_label THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder label on % must render the designated holder (expected %, tuple says %) — a frozen attribution is only worth freezing if it is true.', NEW.id, COALESCE(v_label, '<none>'), NEW."approvedDeciderLabel";
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- ── the act tuple: write-once, written only BY the act, and recording the ACTUAL holder ──
  IF OLD."approvedDeciderKind" IS NOT NULL AND NEW."approvedDeciderKind" IS DISTINCT FROM OLD."approvedDeciderKind" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderKind is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;
  IF OLD."approvedDeciderMembershipId" IS NOT NULL AND NEW."approvedDeciderMembershipId" IS DISTINCT FROM OLD."approvedDeciderMembershipId" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderMembershipId is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;
  IF OLD."approvedDeciderLabel" IS NOT NULL AND NEW."approvedDeciderLabel" IS DISTINCT FROM OLD."approvedDeciderLabel" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderLabel is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;

  -- R10-1 — THE EXEMPTION'S EVIDENCE IS AN ENUMERATED SET, not a predicate.
  --
  -- What rounds 6-9 kept getting wrong was one specific clause: the proof that an approval had
  -- ACTUALLY HAPPENED. Round 8 read it off a `DecisionEvent` (plantable); round 9 read it off that
  -- event's ordering against the change request (both inputs forgeable). Only THAT clause is
  -- replaced here — by membership of the set `20270827000000` stamped, which was fixed before any
  -- caller could act on it and cannot be added to since.
  --
  -- Round 7's other two conditions are KEPT, because they were never the problem. They are facts
  -- about the statement in front of the trigger — where it comes from, and whether it changes the
  -- approval — not questions about rows someone else wrote, so no caller can lie to them:
  --   1. a restoration comes FROM `change`, the only status `withdrawChange` restores from; and
  --   2. it changes no approval evidence — arriving at `approved` while altering the approved
  --      option is a NEW act, and an act records who performed it (round 7's precision arm).
  -- Dropping them would let a stamped legacy row be silently re-approved onto a different option
  -- with nobody named, which is a weakening R10-1 never asked for.
  --
  -- Round 9's `OLD."approvedById" IS NOT NULL` is deliberately NOT kept: legacy approvals exist
  -- that never recorded an approver at all, and the stamp already says what that clause was
  -- reaching for — this row was approved before attribution existed.
  SELECT COUNT(*) INTO v_legacy FROM "DecisionLegacyApproval" WHERE "decisionId" = OLD.id;
  v_restores := v_legacy > 0
    AND OLD.status::text = 'change' AND NEW.status::text = 'approved'
    AND NEW."approvedById"   IS NOT DISTINCT FROM OLD."approvedById"
    AND NEW."approvedOption" IS NOT DISTINCT FROM OLD."approvedOption"
    AND NEW."approvedDeciderKind" IS NOT DISTINCT FROM OLD."approvedDeciderKind"
    AND NEW."approvedDeciderMembershipId" IS NOT DISTINCT FROM OLD."approvedDeciderMembershipId"
    AND NEW."approvedDeciderLabel" IS NOT DISTINCT FROM OLD."approvedDeciderLabel";

  IF OLD.status::text <> 'approved' AND NEW.status::text = 'approved' AND NOT v_restores THEN
    IF NEW."approvedDeciderKind" IS NULL OR decisions_t4b_blank(NEW."approvedDeciderLabel") THEN
      RAISE EXCEPTION 'phase6-4b: an approval of % records WHO approved it — the holder tuple is written by the act, and R2-1 forbids filling it afterwards, so an approval without one is permanently unattributed.', OLD.id;
    END IF;
    -- …and it records THIS decision's holder (R3-1) — but only when this act is WRITING the
    -- tuple. A re-approval carries the frozen one forward verbatim (the write-once arms above
    -- require it), and its label is the identity as it stood at the FIRST act.
    v_writing := OLD."approvedDeciderKind" IS NULL;
    IF v_writing THEN
      IF NEW."approvedDeciderKind"::text IS DISTINCT FROM NEW."deciderKind"::text THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must record the decider of % (designated %, tuple says %) — an approval is attributed to whoever held the decision, not to whoever wrote the row.', OLD.id, NEW."deciderKind"::text, COALESCE(NEW."approvedDeciderKind"::text, '<null>');
      END IF;
      IF NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must name the decider''s own membership on % — a member-held approval belongs to the member it was designated to.', OLD.id;
      END IF;
      v_label := decisions_t4b_holder_label(NEW."projectId", NEW."deciderKind"::text, NEW."deciderMembershipId");
      IF NEW."approvedDeciderLabel" IS DISTINCT FROM v_label THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder label on % must render the designated holder (expected %, tuple says %) — a frozen attribution is only worth freezing if it is true.', OLD.id, COALESCE(v_label, '<none>'), NEW."approvedDeciderLabel";
      END IF;
    END IF;
  -- R2-1: a tuple column filled OUTSIDE an approval transition is inventing evidence for
  -- something that already happened. A legacy restoration writes no tuple column by definition, so
  -- it reaches this branch and passes it — which is the honest outcome: the row stays as
  -- unattributed as it has always been.
  ELSIF (OLD."approvedDeciderKind" IS NULL AND NEW."approvedDeciderKind" IS NOT NULL)
     OR (OLD."approvedDeciderMembershipId" IS NULL AND NEW."approvedDeciderMembershipId" IS NOT NULL)
     OR (OLD."approvedDeciderLabel" IS NULL AND NEW."approvedDeciderLabel" IS NOT NULL) THEN
    RAISE EXCEPTION 'phase6-4b: the approval holder tuple may only be written by an approval (%) — never onto a row that is already approved.', OLD.id;
  END IF;

  -- EXIT from recorded
  IF OLD.status::text = 'recorded' AND NEW.status::text <> 'recorded' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published recorded issue is permanent (%) — it has no transition out.', OLD.id;
    END IF;
    IF NEW."deciderKind"::text = 'none' THEN
      RAISE EXCEPTION 'phase6-4b: converting a draft record must re-point its decider in the same update (%).', OLD.id;
    END IF;
  END IF;

  -- ENTRY into recorded
  IF OLD.status::text <> 'recorded' AND NEW.status::text = 'recorded' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot become a record (%) — a record is born, never converted.', OLD.id;
    END IF;
    PERFORM t4b_require_readiness_key(NEW."projectId", 'converting a draft to a recorded issue');
    IF NOT orgs_user_decision_authority(NEW."projectId", NEW."authorId") THEN
      RAISE EXCEPTION 'phase6-4b: a recorded issue must be filed by a user with decision authority on an operable project (%).', NEW.id;
    END IF;
    SELECT COUNT(*) INTO v_approvals FROM "DecisionApprovalRevision" WHERE "decisionId" = OLD.id;
    IF v_approvals > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying approval evidence cannot become a record (%).', OLD.id;
    END IF;
    SELECT COUNT(*) INTO v_events FROM "DecisionEvent"
    WHERE "decisionId" = OLD.id AND "type" IN ('approved', 'reapproved');
    IF v_events > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying an approval EVENT cannot become a record (%).', OLD.id;
    END IF;
    SELECT COUNT(*) INTO v_changes FROM "ChangeRequest" WHERE "decisionId" = OLD.id;
    IF v_changes > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying a change request cannot become a record (%) — the record would hold an unclosable claim.', OLD.id;
    END IF;
    -- R10-2: …and nothing may already be WAITING on it. `linkableInProject` refuses to link a
    -- record because its gate can never open; converting a draft that is already linked reaches
    -- the same dead gate by taking the two steps in the other order.
    IF activities_decision_has_dependents(NEW."projectId", OLD.id) THEN
      RAISE EXCEPTION 'phase6-4b: a draft an activity already depends on cannot become a record (%) — the gate would wait forever on an issue nobody can approve. Unlink the activity first, or leave this a decision.', OLD.id;
    END IF;
    IF daily_log_decision_has_dependents(NEW."projectId", OLD.id) THEN
      RAISE EXCEPTION 'phase6-4b: a draft a delivery is already matched to cannot become a record (%) — the link rule refuses a record, so the conversion must not create one behind it. Unmatch the delivery first, or leave this a decision.', OLD.id;
    END IF;
  END IF;

  IF OLD.status::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
    IF NEW.title <> OLD.title OR NEW.room <> OLD.room
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
       OR NEW."photoSwatch" <> OLD."photoSwatch" THEN
      RAISE EXCEPTION 'phase6-4b: the content of a published record is frozen (%).', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $$;
