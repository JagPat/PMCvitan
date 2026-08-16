-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 6, the DATABASE half
--
--   R6-1 (P1) — "Require the holder tuple on every approval transition." Round 5 keyed the
--   completeness and binding checks to *a tuple column becoming non-null*, which means a direct
--   `pending → approved` update writing NOTHING skips every one of them — and R2-1's write-once
--   arm then makes the hole permanent, because the tuple may only be written BY an approval and
--   this row's approval has already happened. Round 5's own probe accepted that shape and called
--   it precision; the reviewer is right that it is a gap.
--
--   R6-3 (P1) — "Reject the complete ASCII whitespace set." PostgreSQL's one-argument `btrim`
--   strips SPACES only, and `addMemberSchema` admits a user name of tabs or newlines. That name
--   becomes a member-held decision's expected label, so it satisfies both the non-blank check and
--   the equality check and freezes an attribution that renders as nothing. The repository already
--   has the discipline for this (`ExternalParty_name_not_blank`, and the Phase-4 Task-5 CHECKs
--   that found `btrim` alone letting whitespace through); this migration adopts it.
--
-- `20270815000000` … `20270820000000` are byte-for-byte unchanged. Every statement here is a
-- `CREATE OR REPLACE`, so a re-run is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R6-3 — one statement of what "blank" means, in the medium the seal is written in
--
-- Round 5 put the LABEL RULE in one place and then wrote its emptiness test inline, in two arms
-- and a diagnostic — which is the same re-statement defect one level down. `decisions_t4b_blank`
-- is the one statement, and the three sites ask it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decisions_t4b_blank(p_text TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  -- the full ASCII whitespace set: space, tab, LF, VT, FF, CR. `btrim(x)` strips spaces alone,
  -- and a label of tabs is exactly as unreadable as a label of spaces.
  SELECT p_text IS NULL OR btrim(p_text, E' \t\n\x0B\f\r') = '';
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R6-1 — the APPROVAL TRANSITION is what the attribution rule turns on
--
-- Rounds 2–5 built the rule up one clause at a time and each clause was keyed to the write:
-- "if a tuple column is being filled, then…". That reads naturally and is the wrong discriminator,
-- for the reason this audit has recorded three times now — the invariant belongs to the ACT, not
-- to the columns the act happens to touch. Stated over the act, the rule is one sentence:
--
--     an approval carries a complete, non-blank attribution naming the decision's own holder.
--
-- Two clauses survive the restatement rather than being folded into it, and both are deliberate:
--
--   • the BINDING (kind/membership/label must equal the designated holder) applies only when this
--     act is WRITING the tuple. A re-approval carries the FROZEN tuple forward — R2-1's write-once
--     arm requires `NEW = OLD` — and that label is the identity as it stood at the FIRST act. Re-
--     binding it to the holder's CURRENT name would refuse an ordinary re-approval after a rename,
--     and would do it by demanding a change the write-once arm forbids. History renders as it
--     stood; that is the whole point of freezing it.
--
--   • a tuple column written OUTSIDE an approval transition stays refused, unchanged (R2-1).
--
-- The INSERT door keeps round 4's documented narrowing (a tuple that is PRESENT must be complete
-- and bound; an ABSENT one is the legacy shape). That asymmetry is now the honest one: rows that
-- already exist are reached by UPDATE and never by INSERT, so requiring the tuple on the
-- TRANSITION reaches every live approval without touching a single historical row.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
  v_label     TEXT;
  v_writing   BOOLEAN;
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
    -- R4-2: born approved ⇒ a tuple that is PRESENT is complete, and records this decision's own
    -- decider. An absent tuple is the legacy shape and stays permitted (see 20270819's header).
    IF NEW.status::text = 'approved'
       AND (NEW."approvedDeciderKind" IS NOT NULL
         OR NEW."approvedDeciderMembershipId" IS NOT NULL
         OR NEW."approvedDeciderLabel" IS NOT NULL) THEN
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

  -- R6-1: the ACT, not the columns. Every transition INTO `approved` carries its attribution.
  IF OLD.status::text <> 'approved' AND NEW.status::text = 'approved' THEN
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
  -- something that already happened.
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

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Diagnostic — still REPORTED, still deliberately not an abort, and now honest about R6-1 too
--
-- R6-1 widens the rule from "a written tuple is complete" to "an approval carries one", and the
-- widened rule still governs WRITES only: a row already `approved` never transitions into
-- `approved` again, so nothing already in the table is asked about. What the count now includes is
-- the population that rule would have caught — approved rows with NO attribution at all, which is
-- every approval taken before `20270815000000` — reported separately so an operator is not misled
-- into reading a large legacy number as a defect.
--
-- Neither number is repaired here. Round 4's write-once arms make these rows unchangeable, and
-- inventing an attribution is fabricating the very evidence the seal exists to protect. A truthful
-- re-attribution is a NEW act, and that belongs to 4d's forwarding work.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_wrong  INT;
  v_absent INT;
BEGIN
  SELECT COUNT(*) INTO v_wrong
    FROM "Decision" d
   WHERE d.status::text = 'approved'
     AND d."approvedDeciderKind" IS NOT NULL
     AND (decisions_t4b_blank(d."approvedDeciderLabel")
       OR d."approvedDeciderLabel" IS DISTINCT FROM
          decisions_t4b_holder_label(d."projectId", d."deciderKind"::text, d."deciderMembershipId"));
  SELECT COUNT(*) INTO v_absent
    FROM "Decision" d
   WHERE d.status::text = 'approved' AND d."approvedDeciderKind" IS NULL;
  IF v_wrong > 0 THEN
    RAISE NOTICE 'phase6-4b R5-3/R6-3: % existing approved decision(s) carry an approval label the binding would not have accepted. They are frozen history and are left exactly as they stand.', v_wrong;
  END IF;
  IF v_absent > 0 THEN
    RAISE NOTICE 'phase6-4b R6-1: % existing approved decision(s) carry NO approval attribution — every approval taken before 20270815000000 is in this shape. The new rule governs transitions, so these are untouched; a truthful re-attribution is a new act (4d forwarding), never an edit.', v_absent;
  END IF;
END $$;
