-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 unit 4b-i — the ROUND-3 correction, database half (Codex, four of seven findings on
-- head 2ef9d68)
--
--   R3-1 (P1) the act tuple's guard validated WHEN it was written, never WHAT it recorded — so a
--             direct pending → approved transition could stamp a client-held decision with
--             `approvedDeciderKind = 'pmc'` and any label at all, and round 2's write-once arms
--             then preserved the forgery permanently.
--   R3-3 (P1) the identity freeze read `OLD."publishedAt" IS NOT NULL`, so a DRAFT could be
--             re-keyed and published in ONE statement. The FK cascades carry options and events
--             along, but `DomainEvent.entityId` and the command receipt's `resultRef` keep the old
--             id — the published decision is split from its own audit and replay trail, which is
--             the exact outcome the surrounding comment says must not happen.
--   R3-4 (P1) the reopen seal covered `approved → change` only. A member holder may legally be
--             soft-removed while their decision is CLOSED, so a direct `approved → pending`
--             re-opens a published decision whose named holder is already inactive — the
--             holderless state, reached through the door nobody sealed.
--   R3-6 (P2) the org-membership arm judged EVERY deletion, whatever the deleted row's role and
--             whether it supplied any effective pmc standing at all. Deleting an unrelated plain
--             org `member`, or moving someone owner ↔ admin, was refused on a project whose holder
--             never changed. A seal that refuses what it does not govern is not strict, it is wrong.
--
-- `20270815000000`, `20270816000000` and `20270817000000` are all left byte-for-byte unchanged;
-- every function here is CREATE OR REPLACE, so a re-run is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

LOCK TABLE "Decision", "OrgMembership" IN SHARE ROW EXCLUSIVE MODE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R3-3 — the decision's IDENTITY is frozen FROM BIRTH, not from publication
--
-- `authorId` and `projectId` immediately below were already frozen from birth; `id` was not, and
-- the comment above them claimed otherwise. A draft is editable, but its NAME is what every other
-- table and every emitted event refers to it by, and those references do not cascade: they are
-- caller-authored strings in `DomainEvent.entityId` and `CommandExecution.resultRef`. Nothing in
-- the product re-keys a decision — the id is supplied at creation and never rewritten — so the
-- freeze costs nothing and closes the split.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_publication_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_publishing  BOOLEAN;
  v_options     INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_publishing := NEW."publishedAt" IS NOT NULL;
  ELSE
    -- identity + publication freezes (publication-scoped, except identity which binds at birth)
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot return to draft (%).', OLD.id;
    END IF;
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" <> OLD."publishedAt" THEN
      RAISE EXCEPTION 'phase6-4b: publishedAt is write-once (%).', OLD.id;
    END IF;
    -- R3-3: FROM BIRTH. The old guard fired only once `publishedAt` was already set, which left
    -- the one statement that re-keys AND publishes together entirely unrefused.
    IF NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'phase6-4b: a decision keeps the identity it was filed under (%) — events and command receipts name it by that id and do not cascade.', OLD.id;
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

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R3-1 — the act tuple must record the HOLDER, not merely be written at the right moment
--
-- Round 2 keyed the first write to the TRANSITION. That is necessary and not sufficient: the
-- transition is the right MOMENT, and the tuple is still free to name the wrong PARTY. A
-- client-held decision flipped straight to `approved` could carry `approvedDeciderKind = 'pmc'`
-- with an arbitrary label — the transition test passes, the kind⟺membership pair CHECK passes
-- (`pmc` legitimately carries no membership id), and write-once then makes it permanent.
--
-- So the tuple is checked against the designation the same row carries: its kind must BE the
-- decider's kind, and a member-held approval must name the decider's own membership. The LABEL is
-- deliberately not machine-validated — it is the display identity as the register rendered it at
-- the act, and a person's name legitimately changes afterwards; what must not vary is WHO.
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
      -- the round-1 sentence is kept verbatim ahead of the new clause: F4 pins that wording, and a
      -- narrowed guard is not a reason to move an existing probe's goalposts
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
-- R3-4 — EVERY transition back into an OPEN status re-validates the holder
--
-- The seal was written for the reopen the product performs (`approved → change`, alongside a new
-- ChangeRequest), and so it read as a rule about reopening. It is not: it is a rule about a
-- published decision becoming OPEN again, and `approved → pending` reaches that same state through
-- a door the arm never covered. The holder-removal guard cannot see an `approved` decision, so a
-- member holder may legally leave while it is closed — which makes this transition precisely the
-- one that can birth an openly holderless published decision.
--
-- The condition is therefore stated over what changes rather than over one named pair: NEW status
-- is open, OLD status is not, and the row is published. The publication path is untouched (its
-- status does not move, and the publication seal validates the holder there).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_reopen_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text IN ('pending', 'change')
     AND OLD.status::text NOT IN ('pending', 'change')
     AND NEW."publishedAt" IS NOT NULL THEN
    PERFORM t4b_require_readiness_key(NEW."projectId", 'reopening a closed decision');
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

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- R3-6 — the org arm judges only the standing the WRITTEN ROW actually supplies
--
-- `orgs_effective_role_standing` counts an org owner/admin as a project pmc ONLY when that user
-- holds no active `Membership` on the project. The seal ignored both halves of that rule: it ran
-- for every DELETE regardless of role, and its role-change arm fired for owner ↔ admin, where
-- standing is unchanged. On a project with one explicit pmc and an open pmc-held decision,
-- `standing <= 1` is true by construction, so deleting an unrelated plain `member` was refused for
-- a holder it could not possibly affect.
--
-- The arm now asks the question the primitive asks: did THIS row supply effective pmc standing on
-- THIS project before the write, and does it stop supplying it after? Only then is the last-holder
-- check meaningful, and only then is the readiness key taken — a plain-member delete no longer
-- contends for the key of every project in the org either.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION org_membership_t4b_holder_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  r          RECORD;
  v_membered BOOLEAN;
  v_was      BOOLEAN;
  v_now      BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."userId" <> OLD."userId" THEN
      RAISE EXCEPTION 'phase6-4b: an org membership is born bound to its user (%).', OLD.id;
    END IF;
    IF NEW."orgId" <> OLD."orgId" THEN
      RAISE EXCEPTION 'phase6-4b: an org membership is born bound to its org (%) — a move is a removal plus an addition.', OLD.id;
    END IF;
  END IF;

  -- Only a row that CURRENTLY carries owner/admin can be supplying pmc standing anywhere, and only
  -- a DELETE or a role change can take it away. This outer gate reads no other table, so narrowing
  -- here cannot race anything.
  IF OLD.role IN ('owner', 'admin')
     AND (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.role <> OLD.role)) THEN
    -- judged PER AFFECTED PROJECT, in stable ascending id order (round 13 — two concurrent org
    -- role changes locking P1/P2 in opposite orders would deadlock on the blocking service path)
    FOR r IN
      SELECT p.id AS project_id FROM "Project" p WHERE p."orgId" = OLD."orgId" ORDER BY p.id
    LOOP
      PERFORM t4b_require_readiness_key(r.project_id, 'changing org membership');
      -- the primitive's own precedence rule: an explicit ACTIVE membership WINS, so an org
      -- owner/admin who is also on the project supplies nothing through the org
      SELECT EXISTS (
        SELECT 1 FROM "Membership" m
        WHERE m."projectId" = r.project_id AND m."userId" = OLD."userId" AND m.status = 'active'
      ) INTO v_membered;
      v_was := NOT v_membered;
      v_now := (TG_OP = 'UPDATE') AND NEW.role IN ('owner', 'admin') AND NOT v_membered;
      IF v_was AND NOT v_now THEN
        IF orgs_effective_role_standing(r.project_id, 'pmc') <= 1
           AND decisions_open_decision_names_holder(r.project_id, NULL, 'pmc') THEN
          RAISE EXCEPTION 'phase6-4b: this org write would remove the last effective pmc from a published open decision on % — cover the decision first.', r.project_id;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;
