-- Phase 6 task 4d unit 4d-ii-a / A4a — the consultation cycle counts FINALIZED approvals, in the
-- two consultation seals as in the service.
--
-- THE RULE (§A.2's cycle trace). A consultation is frozen to the approval cycle it was asked in
-- (`openCycle`), and an approval ends that cycle. Under the chain an approval is PROVISIONAL until the
-- architect countersigns it: its revision is born `finalized = false` and the countersign flips it.
-- Counting every revision breaks the cycle both ways — a question asked while `pending` would die the
-- moment the provisional revision lands, though the decision is still open to advice; one asked while
-- awaiting countersign would survive the countersign (which adds no revision) into a reopen. Counting
-- FINALIZED revisions is right in all four orders, and every producer and reader must use it together.
--
-- WHY THE SEALS MOVE HERE. §A.2's trace names the service and reader sites. These two seals re-count
-- the cycle under the decision lock to judge the request's frozen `openCycle` and the response's
-- standing, so they are enforcement sites of the same rule: with the service on the finalized count
-- and a seal on the total, a question asked beside a provisional approval would be refused by the
-- database as a stale cycle the service had just judged current. They move in the same unit.
--
-- NOTHING CHANGES BEFORE THE CHAIN. Every revision written today is born `finalized = true`, and
-- 4d-i's backfill left every earlier one `true`, so on every existing decision the two counts are
-- equal and every `openCycle` keeps the meaning it was written with. A `finalized = false` row
-- cannot exist until the provisional approve (A8a) and the chain's activation (4d-iii).
--
-- THE BODIES are 4d-i's (`20271221000000_phase6_t4d_i_decision_facts`, which widened the open set to
-- `awaiting_countersign`) character for character, except the two cycle counts, which gain
-- `AND r."finalized"`.
--
-- RE-RUNNABLE AND MARKER-AWARE (it is on `ALWAYS_EXECUTE`). `CREATE OR REPLACE FUNCTION` only, and it
-- sorts after 4d-i, which `ALWAYS_EXECUTE` also re-runs, so on every deploy this is the definition
-- that stands. On a database 4d-iii has already retired, these seals carry 4d-iii's bodies (its
-- requester arm re-pointed) and this migration leaves them alone, exactly as 4d-i's own widening
-- does; 4d-iii's bodies therefore owe the same finalized count (recorded in the staging document).

DO $a4a_cycle$ BEGIN
IF phase6_t4d_retired_at_start() THEN RETURN; END IF;
CREATE OR REPLACE FUNCTION phase6_t4c_consultation_request_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  -- §B.1 try-acquire-or-refuse: reentrant on the service path (the command already holds the
  -- key), acquired and held to commit on a free direct write, REFUSED when contended — a seal
  -- never waits inside a trigger, so no lock-order inversion can exist.
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct consultation write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no consultation may be recorded against it', NEW."projectId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", NEW."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is not ACTIVE on this project — a request for a removed member would become answerable if they were ever restored (%)', NEW."id";
  END IF;
  -- the WRONG-AUDIENCE forgery: `consulteeUserId` is the projection's REBUILDABLE audience, so an
  -- arbitrary user there would mint a projected slice — and a widened view — for a stranger.
  IF NEW."consulteeUserId" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: the recorded audience is not the user this membership resolves to — the canonical audience may not be forged (%)', NEW."id";
  END IF;
  -- the contract's actor-standing obligation, applied to this fact's RECORDED actor
  IF NOT phase6_user_decision_authority(NEW."projectId", NEW."requestedById") THEN
    RAISE EXCEPTION 'phase6-4c: the recorded requester holds no active authority to ask for advice on this project (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: decision % is not in this project', NEW."decisionId";
  END IF;
  -- eligibility: PUBLISHED (status alone admits an author-private draft whose status is
  -- `pending`) and still OPEN. Never `withdrawn` (whose title and reason are pmc-only — a
  -- consultation there leaks exactly what 4a hides), `approved` or `recorded` (nothing to inform).
  IF d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION 'phase6-4c: a consultation belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- the INITIAL cycle is SEALED, not merely compared later: a command bug storing `current + 1`
  -- would mint a consultation unanswerable now that becomes answerable after ONE approve-and-
  -- reopen — the exact revival this column exists to prevent, arriving through a legitimate writer.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId" AND r."finalized";
  IF NEW."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: the frozen open cycle % is not the decision''s current approval count % — a consultation is born in the cycle it was asked in', NEW."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.request', NEW."requestedById", NEW."id");
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4c_consultation_response_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct response write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no advice may be recorded against it', NEW."projectId";
  END IF;

  SELECT "consulteeMembershipId", "openCycle", "decisionId" INTO c FROM "DecisionConsultation"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."consultationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: no consultation % in this project', NEW."consultationId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", c."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is no longer ACTIVE — a removed member cannot append immutable advice (%)', NEW."id";
  END IF;
  -- without a recorded actor compared against the named consultee, a raw writer could forge advice
  -- presented forever as the member's own
  IF NEW."respondedById" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: only the named consultee may be recorded as the responder (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND OR d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION 'phase6-4c: advice belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- eligibility is not a STATUS test alone. Approve then `requestChange` returns the decision to
  -- an open status while the append-only consultation row remains by design; a status-only guard
  -- would REVIVE a consultation the approval already closed and mix two decision cycles in one
  -- immutable thread. Asking again in the new cycle means a NEW consultation.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId" AND r."finalized";
  IF c."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: this consultation belongs to cycle %, and the decision is now in cycle % — an approval permanently closes the consultations of the cycle it ended', c."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.respond', NEW."respondedById", NEW."id");
  RETURN NEW;
END $$;
END $a4a_cycle$;
