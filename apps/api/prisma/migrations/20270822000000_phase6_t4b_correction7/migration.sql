-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 7, the DATABASE half
--
--   R7-1 (P1) — "Exempt withdrawn changes from the approval-act check." Round 6 restated the
--   attribution rule over the ACT and then keyed it to a transition, which is not the same thing:
--   `withdrawChange` reaches `change → approved` to RESTORE an approval that already happened.
--   Every decision approved before `20270815000000` carries a null tuple by design, so on those
--   rows round 6 made a change request impossible to withdraw — a raw PostgreSQL error on an
--   ordinary product path, caused by the very correction that was meant to remove those.
--
--   This is round 6's own defect and it is the class this audit keeps naming: a guard STRICTER
--   than the rule it fronts (R2-4, R3-6, and now this). The cure is the same — say what the rule
--   actually is. An approval records something; a restoration records nothing.
--
--   R7-3 (P2) — "Check whether activation actually displaces PMC standing." Codex names the round-6
--   SERVICE guard, and investigating it found the SEAL has the same defect from a different cause:
--   Prisma's `upsert` compiles to `INSERT ... ON CONFLICT DO UPDATE`, and PostgreSQL fires the
--   BEFORE **INSERT** trigger with `TG_OP = 'INSERT'` even when the conflict is taken. Restricting
--   only the service guard would therefore have converted a false 409 into a raw 500. Both now ask
--   the question `TG_OP` was standing in for: was this (project, user) already ACTIVE?
--
-- `20270815000000` … `20270821000000` are byte-for-byte unchanged, and every statement here is a
-- `CREATE OR REPLACE`, so a re-run is a no-op.
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
  v_restores := OLD.status::text <> 'approved' AND NEW.status::text = 'approved'
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

CREATE OR REPLACE FUNCTION membership_t4b_holder_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_role_after      TEXT;
  v_standing_left   INT;
  v_departing       TEXT;
  v_displaced       TEXT;
  v_named_removed   BOOLEAN;
  v_was_active      BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" <> OLD."userId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its user (%) — a new person is a NEW membership.', OLD.id;
    END IF;
    IF NEW."projectId" <> OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its project (%) — a move is a removal plus an addition.', OLD.id;
    END IF;
  END IF;

  -- R7-3 (round 7): what makes an ACTIVATION is not `TG_OP`. Prisma's `upsert` compiles to
  -- `INSERT ... ON CONFLICT DO UPDATE`, and PostgreSQL fires the BEFORE **INSERT** trigger for it
  -- with `TG_OP = 'INSERT'` even when the conflicting row exists and the UPDATE path is taken. So
  -- `members.add` re-roling an ALREADY ACTIVE member reached this arm as though it were an
  -- activation, and a member who had been suppressing their own org-derived pmc standing all along
  -- was refused a role change that displaces nobody.
  --
  -- Codex's finding names the SERVICE guard, and restricting only the guard would have turned a
  -- false 409 into a raw 500 — the seal would still have refused. Both ask the real question
  -- instead: was this (project, user) ALREADY active before this statement?
  v_was_active := CASE
    WHEN TG_OP = 'UPDATE' THEN OLD.status = 'active'
    ELSE EXISTS (
      SELECT 1 FROM "Membership" m
       WHERE m."projectId" = NEW."projectId" AND m."userId" = NEW."userId" AND m.status = 'active'
    )
  END;

  IF NEW.status = 'active' AND NOT v_was_active THEN
    PERFORM t4b_require_readiness_key(NEW."projectId", 'activating a membership');
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

  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW.status <> 'active' OR NEW.role <> OLD.role)) THEN
    IF (TG_OP = 'DELETE' AND OLD.status = 'active') OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
      PERFORM t4b_require_readiness_key(OLD."projectId", 'removing or re-roling a membership');
      v_role_after := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.role END;
      v_departing := CASE WHEN v_role_after IS DISTINCT FROM OLD.role OR TG_OP = 'DELETE'
                          OR (TG_OP = 'UPDATE' AND NEW.status <> 'active')
                     THEN OLD.role ELSE NULL END;
      -- F11: does THIS write end the membership's active standing? Only then is a NAMED holder
      -- displaced. A role change that stays active keeps the membership, and keeps the holder.
      v_named_removed := (TG_OP = 'DELETE') OR (TG_OP = 'UPDATE' AND NEW.status <> 'active');
      -- R5-6: ASK the primitive what standing will be, rather than subtracting one from what it
      -- is. A departing pmc who is also an org owner/admin stops suppressing their own org-derived
      -- standing, so the answer is not `count - 1` and the subtraction refused a covered removal.
      v_standing_left := orgs_effective_role_standing_after(
        OLD."projectId",
        OLD.role,
        OLD.id,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.role END,
        CASE WHEN TG_OP = 'DELETE' THEN FALSE ELSE (NEW.status = 'active') END
      );
      IF decisions_open_decision_names_holder(
           OLD."projectId",
           CASE WHEN v_named_removed THEN OLD.id ELSE NULL END,
           CASE WHEN v_standing_left <= 0 THEN v_departing ELSE NULL END
         ) THEN
        RAISE EXCEPTION 'phase6-4b: this membership holds a published open decision on % — withdraw-and-reissue it first (re-homing arrives with 4d forwarding).', OLD."projectId";
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;
