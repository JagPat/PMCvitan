-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 5, the DATABASE half
--
-- Two findings land here. Both are the convergence audit's Face B — an invariant re-stated away
-- from the thing that determines it — and both are fixed by MOVING the statement rather than by
-- adding a fifth guard beside it.
--
--   R5-3 (P1) — "Validate the complete approval tuple on transitions." Rounds 2/3/4 bound the
--   tuple's KIND and MEMBERSHIP to the designated holder and left the LABEL unbound: a transition
--   carrying the right kind and a null, whitespace-only or fabricated label passed, and the
--   write-once arms then froze it forever. The label is not decoration — it is the identity the
--   register renders for an act nobody can re-attribute afterwards.
--
--   R5-6 (P2) — "Preserve org-admin PMC standing after membership removal." The seal computed
--   post-write standing as `orgs_effective_role_standing(...) - 1`. That subtraction is a
--   RE-STATEMENT of the primitive, and it is wrong for the one shape the primitive is subtle
--   about: an active project membership SUPPRESSES its holder's org-derived pmc standing, so
--   removing the sole project pmc who is also an org owner/admin leaves standing at 1, not 0.
--   The seal (and the service guard in front of it) refused a removal that strands nothing.
--
-- Nothing else in the round-2/3/4 seal network changes; `20270815000000`, `20270816000000`,
-- `20270817000000`, `20270818000000` and `20270819000000` are byte-for-byte untouched.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R5-6 — post-write standing is ASKED, never re-derived by arithmetic
--
-- `orgs_effective_role_standing` is not a plain sum: its pmc arm counts a membership-less org
-- owner/admin, and an ACTIVE project membership suppresses that contribution. Subtracting one from
-- its answer therefore models a write that only ever REMOVES standing — and a removal that lifts
-- the suppression ADDS some back through the same user.
--
-- So the hypothetical is stated where the rule lives: one primitive that computes standing over the
-- membership set AS IT WILL STAND after the write. The current-standing question is the same
-- question with nothing hypothesised, so `orgs_effective_role_standing` is redefined in terms of it
-- and there is exactly one body to keep correct. Its signature, semantics and existing callers are
-- unchanged — `orgs_effective_role_standing_after(p, r, '', NULL, FALSE)` matches no membership id,
-- so the `after` set is the live set.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION orgs_effective_role_standing_after(
  p_project_id    TEXT,
  p_role          TEXT,
  p_membership_id TEXT,     -- the membership this write is about ('' = no hypothetical)
  p_after_role    TEXT,     -- the role it will carry afterwards (NULL = it is gone)
  p_after_active  BOOLEAN   -- whether it will still be ACTIVE afterwards
) RETURNS INT LANGUAGE sql STABLE AS $$
  WITH after AS (
    -- every OTHER membership, exactly as it stands…
    SELECT m."userId" AS user_id, m.role AS role, m.status AS status
      FROM "Membership" m
     WHERE m."projectId" = p_project_id AND m.id <> p_membership_id
    UNION ALL
    -- …plus the subject of the write, as the write will leave it (absent when it ends inactive
    -- or is deleted — either way it supplies nothing, and either way it stops suppressing the
    -- org arm for its user)
    SELECT m."userId", p_after_role, 'active'
      FROM "Membership" m
     WHERE m."projectId" = p_project_id AND m.id = p_membership_id
       AND p_after_active AND p_after_role IS NOT NULL
  )
  SELECT (
    SELECT COUNT(*) FROM after a WHERE a.role = p_role AND a.status = 'active'
  )::int
  + CASE WHEN p_role = 'pmc' THEN (
      SELECT COUNT(*) FROM "OrgMembership" om
      JOIN "Project" p ON p."orgId" = om."orgId"
      WHERE p.id = p_project_id
        AND om.role IN ('owner', 'admin')
        -- the SAME precedence rule, judged over the SAME hypothetical set
        AND NOT EXISTS (
          SELECT 1 FROM after a2 WHERE a2.user_id = om."userId" AND a2.status = 'active'
        )
    )::int ELSE 0 END;
$$;

-- the live question is the hypothetical question with nothing hypothesised
CREATE OR REPLACE FUNCTION orgs_effective_role_standing(p_project_id TEXT, p_role TEXT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT orgs_effective_role_standing_after(p_project_id, p_role, '', NULL, FALSE);
$$;

CREATE OR REPLACE FUNCTION membership_t4b_holder_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_role_after      TEXT;
  v_standing_left   INT;
  v_departing       TEXT;
  v_displaced       TEXT;
  v_named_removed   BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" <> OLD."userId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its user (%) — a new person is a NEW membership.', OLD.id;
    END IF;
    IF NEW."projectId" <> OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: a membership is born bound to its project (%) — a move is a removal plus an addition.', OLD.id;
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.status = 'active')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status <> 'active') THEN
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

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R5-3 — the approval label is BOUND to the holder it claims to render
--
-- Rounds 2/3/4 closed WHEN the tuple may be written (only by an approval transition) and WHAT two
-- thirds of it must say (the designated kind, the designated membership). The third column was
-- never asked about, so a transition could freeze a null, a blank, or a name belonging to nobody —
-- and the write-once arms made that permanent. "An approval is never re-attributed" is only true
-- if what it is attributed TO is checked once, at the moment it becomes unchangeable.
--
-- The label rule is stated ONCE, in SQL, as `decisions_t4b_holder_label`. The service does not keep
-- a second copy: `DecisionsService.approve` now derives the label by CALLING this function inside
-- its own locked transaction, so the value the seal recomputes and the value the service writes
-- cannot differ — not because they are kept in agreement, but because there is one of them. (The
-- alternative, two implementations pinned by a correspondence probe, is what `phase5_t5_pmc_standing`
-- had to settle for because a trigger cannot call TypeScript; here the direction reverses freely,
-- so it does not have to settle.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- identity is orgs-owned, so the identity half is an orgs-owned function: the display name the
-- register renders for a named membership, or NULL when it names nobody on this project.
CREATE OR REPLACE FUNCTION orgs_membership_display_name(p_project_id TEXT, p_membership_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT u."name"
    FROM "Membership" m
    JOIN "User" u ON u."id" = m."userId"
   WHERE m."projectId" = p_project_id AND m.id = p_membership_id;
$$;

-- …and the composition is decisions-owned, because WHICH identity a holder kind renders as is a
-- statement about the decision register. `client`/`pmc` render as the role, mirroring the shared
-- `ROLE_LABEL`; `member` renders as the person. `none` holds no approval and therefore no label.
CREATE OR REPLACE FUNCTION decisions_t4b_holder_label(
  p_project_id    TEXT,
  p_kind          TEXT,
  p_membership_id TEXT
) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT CASE p_kind
           WHEN 'member' THEN orgs_membership_display_name(p_project_id, p_membership_id)
           WHEN 'pmc'    THEN 'PMC'
           WHEN 'client' THEN 'Client'
           ELSE NULL
         END;
$$;

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
  v_label     TEXT;
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
      -- R5-3: complete, and non-blank. A null label can never be filled afterwards (the write-once
      -- arm forbids it) and a blank one renders as nothing — both are a permanent hole where the
      -- attribution should be.
      IF NEW."approvedDeciderKind" IS NULL OR NEW."approvedDeciderLabel" IS NULL
         OR btrim(NEW."approvedDeciderLabel") = '' THEN
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
  -- R2-1: the TRANSITION, not the destination. A row that is ALREADY approved has had its act;
  -- filling its tuple now would be inventing evidence for something that happened before.
  IF (OLD."approvedDeciderKind" IS NULL AND NEW."approvedDeciderKind" IS NOT NULL)
     OR (OLD."approvedDeciderMembershipId" IS NULL AND NEW."approvedDeciderMembershipId" IS NOT NULL)
     OR (OLD."approvedDeciderLabel" IS NULL AND NEW."approvedDeciderLabel" IS NOT NULL) THEN
    IF NOT (OLD.status::text <> 'approved' AND NEW.status::text = 'approved') THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple may only be written by an approval (%) — never onto a row that is already approved.', OLD.id;
    END IF;
    -- R5-3: a tuple the act writes is COMPLETE and non-blank — the same rule the INSERT door
    -- applies, because the two doors reach the same permanent state.
    IF NEW."approvedDeciderKind" IS NULL OR NEW."approvedDeciderLabel" IS NULL
       OR btrim(NEW."approvedDeciderLabel") = '' THEN
      RAISE EXCEPTION 'phase6-4b: an approval of % writes the WHOLE holder tuple or none of it — a missing or blank label can never be filled afterwards.', OLD.id;
    END IF;
    -- R3-1: …and it records THIS decision's holder. The right moment is not the right party.
    IF NEW."approvedDeciderKind"::text IS DISTINCT FROM NEW."deciderKind"::text THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple must record the decider of % (designated %, tuple says %) — an approval is attributed to whoever held the decision, not to whoever wrote the row.', OLD.id, NEW."deciderKind"::text, COALESCE(NEW."approvedDeciderKind"::text, '<null>');
    END IF;
    IF NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple must name the decider''s own membership on % — a member-held approval belongs to the member it was designated to.', OLD.id;
    END IF;
    -- R5-3: …and the LABEL renders that same holder, from the one statement of the rule.
    v_label := decisions_t4b_holder_label(NEW."projectId", NEW."deciderKind"::text, NEW."deciderMembershipId");
    IF NEW."approvedDeciderLabel" IS DISTINCT FROM v_label THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder label on % must render the designated holder (expected %, tuple says %) — a frozen attribution is only worth freezing if it is true.', OLD.id, COALESCE(v_label, '<none>'), NEW."approvedDeciderLabel";
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

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Diagnostic — REPORTED, deliberately not an abort
--
-- The new label rule governs WRITES: it fires on an approval transition and on an approved INSERT.
-- No pre-existing row is asked about, because a row that is already approved never transitions into
-- approved again, and a re-approval writes onto columns that are already non-null (so the
-- newly-written branch is not entered). Nothing already in the table can therefore be stranded by
-- this migration, which is why it does not abort.
--
-- It still counts, because the count is worth knowing: a legacy approved row whose tuple disagrees
-- with its designated holder is frozen history under the round-4 write-once arms and cannot be
-- edited by this migration or by anyone — inventing a correction would be fabricating the very
-- attribution the seal exists to protect. An operator seeing a non-zero count knows those rows
-- render from evidence the current rule would not have accepted, and 4d's forwarding work is where
-- a truthful re-attribution path (a new act, not an edit) would belong.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad
    FROM "Decision" d
   WHERE d.status::text = 'approved'
     AND d."approvedDeciderKind" IS NOT NULL
     AND (d."approvedDeciderLabel" IS NULL
       OR btrim(d."approvedDeciderLabel") = ''
       OR d."approvedDeciderLabel" IS DISTINCT FROM
          decisions_t4b_holder_label(d."projectId", d."deciderKind"::text, d."deciderMembershipId"));
  IF v_bad > 0 THEN
    RAISE NOTICE 'phase6-4b R5-3: % existing approved decision(s) carry an approval label that the new binding would not have accepted. They are frozen history and are left exactly as they stand.', v_bad;
  END IF;
END $$;
