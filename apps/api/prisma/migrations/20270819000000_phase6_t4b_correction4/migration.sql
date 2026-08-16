-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 unit 4b-i — the ROUND-4 correction, database half (Codex, two of five findings on
-- head 87461e6)
--
--   R4-1 (P1) the conversion counts `DecisionApprovalRevision` on the way IN and nothing sealed
--             it on the way OUT. The revision's own insertion trigger refuses a `withdrawn`
--             parent only, and round 1's reverse trigger covers `DecisionEvent` only — so a
--             draft converted to `recorded` while the count was zero can be given a revision
--             afterwards, and the append-only trigger then makes that contradiction permanent.
--             This is the SAME missing-register shape as F2, in the other evidence table.
--   R4-2 (P1) the INSERT branch RETURNS before the actual-holder validation R3-1 added, so the
--             binding applies to the transition and not to birth. A row inserted unpublished as
--             `approved` with `deciderKind='client'` and `approvedDeciderKind='pmc'` — or with no
--             tuple at all — passes the pair CHECK and the publication seal, and write-once then
--             preserves approval evidence that contradicts the designated holder, or an approval
--             that names nobody and can never be repaired.
--
-- `20270815000000` … `20270818000000` are all left byte-for-byte unchanged; every function here
-- is CREATE OR REPLACE, so a re-run is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

LOCK TABLE "Decision", "DecisionApprovalRevision" IN SHARE ROW EXCLUSIVE MODE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R4-1 — a RECORD carries no approval evidence, in the register as well as the event log
--
-- The 4a seal already takes the parent row `FOR UPDATE` before reading its status, and that lock
-- is what makes this correct rather than merely stricter: a conversion holding the decision row
-- makes this insert wait and then see `recorded`; an insert holding it makes the conversion wait
-- and then count the committed revision. Exactly one side commits, in either order.
--
-- The `withdrawn` message is preserved verbatim — 4a's probes pin that sentence.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION phase6_t4a_no_approval_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
  IF dstatus = 'withdrawn' THEN
    RAISE EXCEPTION 'phase6-t4a: decision % is withdrawn — an approval revision can no longer be recorded', NEW."decisionId";
  END IF;
  IF dstatus = 'recorded' THEN
    RAISE EXCEPTION 'phase6-4b: % is a recorded issue — it has no approver, so it can carry no approval revision', NEW."decisionId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R4-2 — an approval is bound to its holder AT BIRTH as well as at the transition
--
-- R3-1 bound the tuple on the UPDATE that approves. A row can also be BORN approved, and that
-- door returned before the binding ran. The rule is the same rule, so it is stated once more at
-- the door it was missing from: an inserted `approved` row whose tuple is PRESENT carries a
-- complete one, and that tuple records the decision's own decider. A PARTIAL tuple is refused
-- too — half an attribution is an attribution.
--
-- NARROWER THAN THE REVIEW ASKED, deliberately and on the record. The finding says "require a
-- complete tuple AND bind it"; this requires the binding and does NOT require existence, because
-- an absent tuple is not a forgery — it is the shape EVERY decision approved before
-- `20270815000000` is in, and those rows persist in production. Three things decided it:
--
--   • the UPDATE door already permits a tupleless approval transition, and R2-1's own probe
--     depends on that shape; requiring one at birth would make being BORN approved stricter than
--     BECOMING approved, for a harm nobody has stated.
--   • the harm the finding describes — evidence that CONTRADICTS the designated holder — is fully
--     closed by the binding alone.
--   • measured rather than assumed: requiring existence failed 18 tests across 10 suites, every
--     one of them a fixture modelling a legacy approved row. Unlike round 1's fixture sweep,
--     where the fixtures modelled a state the product genuinely forbids (a published decision
--     with fewer than two options), these model a state that is real and permanent.
--
-- Refusing what carries no falsehood is the "stricter than the rule it fronts" defect this same
-- review raised twice already (R2-4, R3-6). If the reviewer still wants existence required, that
-- is a fixture sweep and a one-line change, and this comment is where the disagreement is stated.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
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
    -- decider. An absent tuple is the legacy shape and stays permitted (see the header).
    IF NEW.status::text = 'approved'
       AND (NEW."approvedDeciderKind" IS NOT NULL
         OR NEW."approvedDeciderMembershipId" IS NOT NULL
         OR NEW."approvedDeciderLabel" IS NOT NULL) THEN
      IF NEW."approvedDeciderKind" IS NULL OR NEW."approvedDeciderLabel" IS NULL THEN
        RAISE EXCEPTION 'phase6-4b: a decision born approved (%) carries the WHOLE approval holder tuple or none of it — half an attribution is an attribution.', NEW.id;
      END IF;
      IF NEW."approvedDeciderKind"::text IS DISTINCT FROM NEW."deciderKind"::text THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must record the decider of % (designated %, tuple says %) — an approval is attributed to whoever held the decision, not to whoever wrote the row.', NEW.id, NEW."deciderKind"::text, COALESCE(NEW."approvedDeciderKind"::text, '<null>');
      END IF;
      IF NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
        RAISE EXCEPTION 'phase6-4b: the approval holder tuple must name the decider''s own membership on % — a member-held approval belongs to the member it was designated to.', NEW.id;
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
  -- R2-1: the TRANSITION, not the destination. A row that is ALREADY approved has had its act;
  -- filling its tuple now would be inventing evidence for something that happened before.
  IF (OLD."approvedDeciderKind" IS NULL AND NEW."approvedDeciderKind" IS NOT NULL)
     OR (OLD."approvedDeciderMembershipId" IS NULL AND NEW."approvedDeciderMembershipId" IS NOT NULL)
     OR (OLD."approvedDeciderLabel" IS NULL AND NEW."approvedDeciderLabel" IS NOT NULL) THEN
    IF NOT (OLD.status::text <> 'approved' AND NEW.status::text = 'approved') THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple may only be written by an approval (%) — never onto a row that is already approved.', OLD.id;
    END IF;
    -- R3-1: …and it records THIS decision's holder. The right moment is not the right party.
    IF NEW."approvedDeciderKind"::text IS DISTINCT FROM NEW."deciderKind"::text THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple must record the decider of % (designated %, tuple says %) — an approval is attributed to whoever held the decision, not to whoever wrote the row.', OLD.id, NEW."deciderKind"::text, COALESCE(NEW."approvedDeciderKind"::text, '<null>');
    END IF;
    IF NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple must name the decider''s own membership on % — a member-held approval belongs to the member it was designated to.', OLD.id;
    END IF;
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
    -- the forward count; R4-1 adds its reverse, so neither ordering can leave a record holding
    -- approval evidence
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
