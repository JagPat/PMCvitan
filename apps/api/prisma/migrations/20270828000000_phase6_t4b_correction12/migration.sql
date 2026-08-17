-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 task 4b-i — Codex round 12
--
--   R12-3: the publication-time authority revalidation skipped the `none` arm.
--
-- `20270815000000`'s header states that a record's author is revalidated when it becomes visible,
-- and two of the three doors did it: the INSERT-of-`recorded` door and the draft → record
-- CONVERSION door both call `orgs_user_decision_authority`. PUBLICATION did not. For a record the
-- publishing branch asked only that the option count be zero.
--
-- That gap is reachable without any forgery. A user with decision authority saves a record DRAFT —
-- legal, weightless, invisible to the team — and then loses that authority: their membership is
-- removed, their role changes, the project is archived. The draft stays legal. Any PMC, or a direct
-- writer, can then set `publishedAt`, and the register gains a PERMANENT, team-visible, undeletable
-- record attributed to someone who no longer has authority on the project. A record is the one
-- status with no transition out, so there is nothing to do about it afterwards.
--
-- The arm added below is the same question the other two doors ask, asked at the third. It is a
-- REVALIDATION, not a new rule: nothing that was legal to publish while its author still held
-- authority becomes illegal, and the service path already holds the readiness key this arm
-- try-acquires (round 4, R4-3), so the key is re-entrant exactly as it is for the other two arms.
--
-- Everything else in this function is `20270818000000`'s body carried forward VERBATIM.
-- `20270815000000` … `20270827000000` are byte-for-byte unchanged.
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
    -- ROUND 12 (R12-3): …and a RECORD is revalidated too. It has no holder to check — that is the
    -- whole point of `none` — but it has an AUTHOR, and publishing is the moment a record stops
    -- being a private draft and becomes a permanent register entry nobody can delete. The INSERT
    -- and CONVERSION doors already ask this; publication was the third door, and it never asked.
    ELSE
      PERFORM t4b_require_readiness_key(NEW."projectId", 'publishing a recorded issue');
      IF NOT orgs_user_decision_authority(NEW."projectId", NEW."authorId") THEN
        RAISE EXCEPTION 'phase6-4b: a recorded issue must be filed by a user with decision authority on an operable project (%) — the author''s authority is revalidated when the record becomes permanent, not only when the draft was saved.', NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;
