-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 unit 4b-i — the ROUND-2 correction (Codex, four findings on head 067209bc)
--
-- Three of the four are follow-ons to round 1, and each went to the invariant where my fix
-- stopped at its surface:
--
--   R2-1 (P1) the act tuple's first write checked the DESTINATION status, not the TRANSITION,
--             so any pre-migration approved row could still be given a forged tuple — which my
--             own write-once checks would then protect.
--   R2-2 (P1) the narrowed author predicate is called only on an INSERT that is already
--             `recorded`; the draft → record CONVERSION door never invokes it at all.
--   R2-3 (P1) the ChangeRequest seal reads the parent's status unlocked, so a conversion and an
--             insert can each pass and both commit.
--
-- `20270815000000` and `20270816000000` are both left byte-for-byte unchanged; every function
-- here is CREATE OR REPLACE, so a re-run is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

LOCK TABLE "Decision", "ChangeRequest" IN SHARE ROW EXCLUSIVE MODE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R2-1 + R2-2 — the recorded seal: a TRANSITION writes the act tuple, and the conversion door
-- checks the author the INSERT door already checked
--
-- R2-1: `NEW.status = 'approved'` is a destination, not an event. Every row approved BEFORE this
-- migration carries a NULL tuple and an `approved` status, so the old guard let a direct writer
-- fill all three columns with anything at all — and the write-once rules added in the same round
-- then made the forgery permanent. A tuple that records an act may only be written BY that act:
-- `OLD.status <> 'approved' AND NEW.status = 'approved'`.
--
-- R2-2: the author predicate guarded the door I was looking at. A record can also be BORN as an
-- ordinary draft and converted — the round-13 conversion lifecycle the plan explicitly supports —
-- and that door never asked who the author was. A draft inserted with a contractor or null
-- author, then converted and published, is a permanent record attributed to someone the
-- application would never let create one. The conversion now asks the same question.
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
    RETURN NEW;
  END IF;

  -- ── the act tuple: write-once, and written only BY the act ──
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
      -- the round-1 sentence is kept verbatim ahead of the new clause: F4 pins that wording, and a
      -- narrowed guard is not a reason to move an existing probe's goalposts
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple may only be written by an approval (%) — never onto a row that is already approved.', OLD.id;
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
    -- R2-2: the CONVERSION door asks what the INSERT door asks. A record is permanent and
    -- attributed; how it got here does not change who is allowed to have filed it.
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
-- R2-3 — the ChangeRequest seal SERIALIZES against the conversion
--
-- The seal read the parent's status with a bare SELECT. Two transactions then pass in opposite
-- directions: A flips an unpublished `pending` decision to `recorded`, counting zero change
-- requests; B reads A's still-committed `pending` here and inserts one. The FK takes only a
-- KEY SHARE lock, which A's status-only UPDATE does not conflict with, so both commit — and the
-- record can be published carrying exactly the unclosable claim this seal exists to forbid.
--
-- `FOR UPDATE` on the parent makes them serialize: B either takes the row first (and A's
-- conversion then counts B's committed request and refuses) or waits for A and re-reads
-- `recorded` (and refuses here). Whichever order, one of the two is rejected.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION change_request_t4b_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."decisionId" <> OLD."decisionId" THEN
    RAISE EXCEPTION 'phase6-4b: a change request belongs to the decision it was raised on (%) — it is never re-pointed.', OLD.id;
  END IF;
  SELECT status::text INTO v_status FROM "Decision" WHERE id = NEW."decisionId" FOR UPDATE;
  IF v_status = 'recorded' THEN
    RAISE EXCEPTION 'phase6-4b: a recorded issue cannot carry a change request (%) — nobody can close it.', NEW."decisionId";
  END IF;
  RETURN NEW;
END $$;
