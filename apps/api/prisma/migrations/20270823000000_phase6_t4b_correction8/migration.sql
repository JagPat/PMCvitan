-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 8, the DATABASE half
--
--   R8-1 (P1) — "Constrain the restoration exemption to change withdrawals." Round 7 opened an
--   exemption for `withdrawChange` and wrote it as "arriving at `approved` without changing the
--   evidence". That is wider than a withdrawal: it admits `pending → approved`, so a direct writer
--   could publish a pending row with the approval columns already planted, flip only the status,
--   and reach a permanently unattributed approval THROUGH THE EXEMPTION — the exact state round 6
--   added the rule to prevent.
--
--   Round 7 fixed round 6's over-reach by widening; the widening was itself too wide. That is this
--   audit's class in its most compact form, and it is recorded rather than smoothed over.
--
-- `20270815000000` … `20270822000000` are byte-for-byte unchanged, and every statement here is a
-- `CREATE OR REPLACE`, so a re-run is a no-op. It NARROWS an exemption, so no row that was legal
-- before this migration becomes illegal — only writes that were never legitimate lose their door.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
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

  -- R6-1, as R7-1 restates it: the ACT, not the columns — and not every arrival at `approved` is
  -- an act. `withdrawChange` returns a decision to the approval it ALREADY HAD by moving
  -- `change → approved` and touching nothing else; a pre-`20270815000000` row carries no tuple by
  -- design, so round 6 met that restoration with the completeness demand and refused to let a
  -- change request be withdrawn at all. Fabricating a tuple for those rows is not a repair, it is
  -- the forgery the whole seal exists to prevent.
  --
  -- A RESTORATION is identifiable without guessing at the caller: the row already carries approval
  -- evidence (`approvedById`), and this statement changes none of it. Nothing new is recorded, so
  -- there is no new act to attribute. Everything else that reaches `approved` — a first approval,
  -- a re-approval that names a different option or approver, a direct writer inventing one — is an
  -- act and answers for itself.
  -- R8-1 (round 8): round 7 wrote the exemption as "arriving at approved without changing the
  -- evidence", which admits `pending → approved` — so a direct writer could publish a pending row
  -- with `approvedById` and `approvedOption` already planted, flip the status, satisfy every
  -- equality, and record a permanently unattributed approval through the exemption itself.
  --
  -- A restoration is narrower than that in three ways, and all three are checkable here:
  --   1. it comes from `change` — the only status `withdrawChange` restores from;
  --   2. it changes no approval evidence (round 7's condition, kept); and
  --   3. an approval ACTUALLY HAPPENED — `approve()` has written an `approved`/`reapproved`
  --      `DecisionEvent` since Phase 1, so every genuinely approved row (legacy ones included)
  --      carries that evidence, and a planted `approvedById` on a never-approved row does not.
  -- Condition 3 is what makes this an exemption for history rather than a door into it.
  SELECT COUNT(*) INTO v_events FROM "DecisionEvent"
   WHERE "decisionId" = OLD.id AND "type" IN ('approved', 'reapproved');
  v_restores := OLD.status::text = 'change' AND NEW.status::text = 'approved'
    AND v_events > 0
    AND OLD."approvedById" IS NOT NULL
    AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
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
  -- something that already happened. A restoration writes no tuple column by definition, so it
  -- reaches this branch and passes it — which is the honest outcome, not an exemption.
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
