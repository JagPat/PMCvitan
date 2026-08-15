-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Phase 6 unit 4b-i — the round-1 correction (Codex, twelve findings on head ed72636)
--
-- The DATABASE half. `20270815000000` is left byte-for-byte unchanged; every fix here is
-- additive, and each function is CREATE OR REPLACE so a re-run is a no-op.
--
--   F5 (P1) the option-floor audit that should have run BEFORE the freeze
--   F1 (P1) a published recorded issue could be DELETED
--   F2 (P1) approval EVENTS were not counted at conversion, and not sealed after it
--   F4 (P1) the "frozen" approval-holder tuple was not frozen by anything
--   F6 (P1) the option guard read publication status unlocked
--   F7 (P1) the DB author predicate was WIDER than `ROLE_POLICY['decision.create']`
--   F11 (P2) an active role change was refused for a named holder that keeps its standing
--
-- SERIALIZATION: same protocol as 20270815 — the four-table SHARE ROW EXCLUSIVE lock, no
-- advisory key (its retention would invert lock order against an already-rolled 4b writer).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

LOCK TABLE "Decision", "DecisionOption", "DecisionEvent", "Membership" IN SHARE ROW EXCLUSIVE MODE;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F5 — THE AUDIT THAT SHOULD HAVE RUN FIRST (diagnostic-first, ABORTS)
--
-- 20270815 judged the two-option floor only on a FUTURE publication. An ALREADY-published
-- ordinary decision holding zero or one option therefore survived that migration untouched —
-- and then its published-option freeze made the missing option unaddable, permanently stranding
-- a decision nobody can approve and no ordinary write can repair.
--
-- This is the diagnostic the freeze needed in front of it. It names the rows rather than
-- inventing options for them: what the right second option SAYS is a question for the people who
-- asked it, never for a migration.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INT;
  v_sample TEXT;
BEGIN
  SELECT COUNT(*), COALESCE(string_agg(t.id, ', ' ORDER BY t.id), '')
    INTO v_count, v_sample
  FROM (
    SELECT d.id
    FROM "Decision" d
    WHERE d."publishedAt" IS NOT NULL
      AND d."deciderKind"::text <> 'none'
      AND (SELECT COUNT(*) FROM "DecisionOption" o WHERE o."decisionId" = d.id) < 2
    ORDER BY d.id
    LIMIT 20
  ) t;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'phase6-4b correction: % published ordinary decision(s) hold fewer than two options and cannot be approved by anyone (sample: %). The published-option freeze would make this unrepairable. Add the missing option(s) with the seal disabled by name, or withdraw the decision, then re-run this migration. See docs/RUNBOOK.md.',
      v_count, v_sample;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F7 — the DB author predicate matches the SHARED policy, not a wider guess
--
-- `ROLE_POLICY['decision.create']` is `['pmc']`. The predicate admitted `engineer` too, so a
-- direct INSERT could file a PERMANENT recorded issue attributed to someone every authenticated
-- request path refuses. A hostile-write seal that is weaker than application authorization is
-- not a seal. The org owner/admin arm stays: that path operates the project AS pmc, exactly as
-- `ProjectAccessService.authorize` grants it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION orgs_user_decision_authority(p_project_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_org_id   TEXT;
  v_archived TIMESTAMP(3);
  v_role     TEXT;
  v_org_role TEXT;
BEGIN
  IF p_user_id IS NULL THEN RETURN FALSE; END IF;

  SELECT "orgId", "archivedAt" INTO v_org_id, v_archived
  FROM "Project" WHERE id = p_project_id FOR SHARE;
  IF NOT FOUND OR v_archived IS NOT NULL THEN RETURN FALSE; END IF;

  -- an explicit ACTIVE membership WINS (round 15), and only `pmc` carries decision authority
  SELECT role INTO v_role FROM "Membership"
  WHERE "projectId" = p_project_id AND "userId" = p_user_id AND status = 'active';
  IF FOUND THEN
    RETURN v_role = 'pmc';
  END IF;

  IF v_org_id IS NOT NULL THEN
    SELECT role INTO v_org_role FROM "OrgMembership"
    WHERE "orgId" = v_org_id AND "userId" = p_user_id;
    IF FOUND AND v_org_role IN ('owner', 'admin') THEN RETURN TRUE; END IF;
  END IF;

  RETURN FALSE;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F2 (half one) — approval EVIDENCE is both registers, at conversion
-- F1           — a published recorded issue cannot be DELETED
-- F4           — the approval-holder tuple is frozen for real
--
-- F2: the conversion counted `DecisionApprovalRevision` only. `DecisionEvent` rows of type
-- `approved`/`reapproved` are the OTHER approval register — 4a's own entry seal counts them
-- exactly this way — so a draft carrying one could become a terminal record that this migration
-- claims cannot carry approval evidence. Counted here; the reverse arm is below.
--
-- F1: the seal fired BEFORE INSERT OR UPDATE. `DELETE FROM "Decision" WHERE status='recorded'`
-- reached no rejecting trigger at all: 4a's `Decision_t4a_d_no_delete` covers only `withdrawn`.
-- A permanent register entry that can be deleted is not permanent. The DELETE arm is added here
-- rather than by widening the 4a trigger, so the merged 4a migration stays untouched.
--
-- F4: `approvedDeciderKind` / `approvedDeciderMembershipId` / `approvedDeciderLabel` were
-- DESCRIBED as the act's frozen tuple and frozen by nothing. Direct SQL could reattribute a
-- committed approval, or plant the tuple on a pending row and withdraw it, leaving contradictory
-- immutable history. Write-once from the moment they are set.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_t4b_recorded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_approvals INT;
  v_events    INT;
  v_changes   INT;
BEGIN
  -- ── F1: a published record is permanent in DELETE as well as in transition ──
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
    -- F4: the act tuple is evidence of an approval; an INSERT carrying it has no act to evidence
    IF NEW.status::text <> 'approved' AND (
         NEW."approvedDeciderKind" IS NOT NULL
      OR NEW."approvedDeciderMembershipId" IS NOT NULL
      OR NEW."approvedDeciderLabel" IS NOT NULL) THEN
      RAISE EXCEPTION 'phase6-4b: the approval holder tuple belongs to an APPROVAL (%) — it cannot be planted on a row that carries none.', NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  -- ── F4: write-once from the moment the act records them ──
  IF OLD."approvedDeciderKind" IS NOT NULL AND NEW."approvedDeciderKind" IS DISTINCT FROM OLD."approvedDeciderKind" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderKind is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;
  IF OLD."approvedDeciderMembershipId" IS NOT NULL AND NEW."approvedDeciderMembershipId" IS DISTINCT FROM OLD."approvedDeciderMembershipId" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderMembershipId is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;
  IF OLD."approvedDeciderLabel" IS NOT NULL AND NEW."approvedDeciderLabel" IS DISTINCT FROM OLD."approvedDeciderLabel" THEN
    RAISE EXCEPTION 'phase6-4b: approvedDeciderLabel is the frozen act (%) — an approval is never reattributed.', OLD.id;
  END IF;
  -- ...and it may only APPEAR on the transition that records it
  IF OLD."approvedDeciderKind" IS NULL AND NEW."approvedDeciderKind" IS NOT NULL
     AND NEW.status::text <> 'approved' THEN
    RAISE EXCEPTION 'phase6-4b: the approval holder tuple may only be written by an approval (%).', OLD.id;
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
    SELECT COUNT(*) INTO v_approvals FROM "DecisionApprovalRevision" WHERE "decisionId" = OLD.id;
    IF v_approvals > 0 THEN
      RAISE EXCEPTION 'phase6-4b: a draft carrying approval evidence cannot become a record (%).', OLD.id;
    END IF;
    -- F2: DecisionEvent is the OTHER approval register — 4a's entry seal counts it the same way
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

  -- the PUBLISHED record's evidence freeze
  IF OLD.status::text = 'recorded' AND OLD."publishedAt" IS NOT NULL THEN
    IF NEW.title <> OLD.title OR NEW.room <> OLD.room
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
       OR NEW."photoSwatch" <> OLD."photoSwatch" THEN
      RAISE EXCEPTION 'phase6-4b: the content of a published record is frozen (%).', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_recorded_seal" ON "Decision";
CREATE TRIGGER "Decision_t4b_recorded_seal"
  BEFORE INSERT OR UPDATE OR DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_recorded_seal();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F2 (half two) — the REVERSE arm: no approval event may land on a record
--
-- Counting at conversion closes one door. The other is an approval event INSERTed (or
-- re-pointed) AFTER the record exists. 4a's `DecisionEvent_no_withdrawn_approval` rejects
-- approval evidence only when the parent is `withdrawn`, so `recorded` needs its own arm —
-- added as a separate trigger so the merged 4a artifact stays untouched.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_event_t4b_no_recorded_approval() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  IF NEW."type" NOT IN ('approved', 'reapproved') THEN RETURN NEW; END IF;
  SELECT status::text INTO v_status FROM "Decision" WHERE id = NEW."decisionId" FOR SHARE;
  IF v_status = 'recorded' THEN
    RAISE EXCEPTION 'phase6-4b: decision % is a recorded issue — it has no approver, so approval evidence can never be recorded against it.', NEW."decisionId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4b_no_recorded_approval" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4b_no_recorded_approval"
  BEFORE INSERT OR UPDATE ON "DecisionEvent"
  FOR EACH ROW EXECUTE FUNCTION decision_event_t4b_no_recorded_approval();

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F6 — the option guard SERIALIZES with publication
--
-- The guard read `publishedAt` with a plain SELECT. The interleaving that defeats it: a
-- publisher counts two options in its BEFORE UPDATE trigger; a concurrent DELETE reads the
-- still-committed `publishedAt = NULL` through this unlocked read and succeeds; the delete
-- commits, then the publisher commits — leaving a published ordinary decision with one option,
-- with BOTH seals having passed. `FOR SHARE` on the head row makes the two orders serialize:
-- the option write now waits on any publisher holding the row, and re-reads the truth.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decision_option_t4b_published_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_published TIMESTAMP(3);
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "publishedAt" INTO v_published FROM "Decision" WHERE id = NEW."decisionId" FOR SHARE;
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: the options of a published decision are frozen (%).', NEW."decisionId";
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "publishedAt" INTO v_published FROM "Decision" WHERE id = OLD."decisionId" FOR SHARE;
    IF v_published IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-4b: the options of a published decision are frozen (%).', OLD."decisionId";
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- F11 — an ACTIVE role change does not displace a NAMED holder
--
-- The removal branch passed `OLD.id` unconditionally, so `decisions_open_decision_names_holder`
-- answered true for ANY named-member decision — including a role change that leaves the same
-- membership active and still its holder. Promoting a named contractor holder to engineer was
-- refused until the decision closed, which is not the rule: the named holder is the MEMBERSHIP,
-- and a membership that stays active stays the holder whatever its role.
--
-- The membership id is now passed only when the write actually removes that membership's active
-- standing (a DELETE, or a status leaving `active`). The ROLE-standing arm is unchanged: a role
-- change still removes standing from the departing ROLE, and is still refused when it strands a
-- role-held decision.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

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
      SELECT orgs_effective_role_standing(OLD."projectId", OLD.role)
             - CASE WHEN v_departing IS NOT NULL THEN 1 ELSE 0 END
        INTO v_standing_left;
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
