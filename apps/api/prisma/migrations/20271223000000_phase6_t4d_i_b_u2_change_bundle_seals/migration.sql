-- Phase 6 task 4d, unit 4d-i-b — U2: THE CHANGE-REQUEST BUNDLE SEALS AND THE TRANSITION RECORDERS
-- (docs/superpowers/plans/2026-09-21-4d-i-b-additive-units.md, the U1/U2/U3 additive redesign the
-- owner directed at issue #482 comment 5757145200; #590 comment 5680116372).
--
-- U1 (20271222000000) installed the bound-event/actor primitive and the dormant DomainEvent actor
-- rule. THIS UNIT installs the change lifecycle's structural half of §D's (a): the two transition
-- RECORDERS, the transaction-scoped AUDIT COUNT, and the two deferred BUNDLE SEALS
-- (`ChangeRequest_t4d_paired`, `Decision_t4d_change_paired`) that judge the opening, the closure
-- and the reapproval bundle in BOTH write orders. It JUDGES bundle completeness; it CLAIMS nothing
-- (the claimants — the immediate `ChangeRequest_t4d_claim`, the conditional `countersign_rejection`
-- claim, and every other per-branch claimant — are U3, together with the catalog flip).
--
-- DARK UNTIL THE FLIP. In the delivered switch-on these seals fired unconditionally, because that
-- unit ALSO seeded the flagged coverage generation in the same migration. Split out, no generation
-- carries `pairingRequired = true` for the change/approval keys until U3's flip, so the two bundle
-- seals gate on `phase6_t4d_change_pairing_active()` and RETURN NULL while no such flag exists:
-- pre-flip they refuse nothing a release produces, exactly as U1's actor rule is dormant over the
-- two live generations. Once U3 flips the six decision types the gate is TRUE and the seals judge
-- every change-request bundle — behaviour identical to the reviewed switch-on. The RECORDERS and the
-- readers and the audit count refuse nothing at any time (they only record and count), so they are
-- installed ungated; only the two RAISE-ing seals carry the gate.
--
-- RE-RUNNABLE (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`, `ON CONFLICT DO NOTHING`). Nothing is
-- seeded, retired or back-filled. 4d-iii replaces by name what it replaces and pins it; this file is
-- skipped on a retired database by the same guard family the other 4d units use at the ledger head.

BEGIN;

-- ── THE DEPLOYMENT WINDOW, ALL-OR-NOTHING, BEFORE ANYTHING ELSE ─────────────────────────────
-- The shape both 4d-i halves and U1 take (#582 rounds 8, 36, 37): every pre-existing table this
-- file adds a trigger to, in ONE `NOWAIT` acquisition inside a subtransaction, so a partial set is
-- released by the exception rollback, retried, and after the cap the migration FAILS CLOSED. This
-- transaction is then never a waiting party on these tables, so it cannot be one side of a deadlock
-- with a serving command. U2 adds triggers to exactly two tables — `ChangeRequest` and `Decision`;
-- the audit count reads `DecisionEvent` and the gate reads `ExternalEffectCatalog`, neither of which
-- gains a trigger here, so neither is locked (the round-36/37 census oracle reads `pg_locks`).
DO $t4dib_u2_window$
DECLARE attempts INT := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "ChangeRequest",
                 "Decision"
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 600 THEN
        RAISE EXCEPTION 'phase6 4d-i-b U2: could not obtain the deployment window on "ChangeRequest" and "Decision" after % attempts — retry the deploy when writer traffic quiets. Nothing has been changed. See docs/RUNBOOK.md §P6T4D.', attempts;
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
END $t4dib_u2_window$;

-- ── THE PREREQUISITES ARE 4d-i's AND U1's, AND THEY ARE VERIFIED, NOT ASSUMED ───────────────
-- A plpgsql body is not validated at CREATE time, so a seal calling a primitive that is not there
-- would fail on the first real change request in production rather than here. The set is the
-- external primitives the bodies below CALL — `platform_tx_event_count` (4d-i) and
-- `phase6_t4d_tx_actor_event_count` (U1) — plus the two tables these bodies read that this file
-- does not lock and no verified function creates: 4d-i's transition carrier `_t4d_tx_transition`
-- and the compiled `ExternalEffectCatalog` the gate reads. UNGATED: the dependency holds at every
-- stage, and on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES the 4d-i halves and
-- U1 from ALWAYS_EXECUTE before this file for exactly this reason.
DO $t4dib_u2_prereq$
DECLARE v_fn TEXT; v_missing TEXT := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['platform_tx_event_count', 'phase6_t4d_tx_actor_event_count'] LOOP
    IF to_regproc(v_fn) IS NULL THEN
      v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || v_fn || '()';
    END IF;
  END LOOP;
  IF to_regclass('"_t4d_tx_transition"') IS NULL THEN
    v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || '"_t4d_tx_transition"';
  END IF;
  IF to_regclass('"ExternalEffectCatalog"') IS NULL THEN
    v_missing := v_missing || CASE WHEN v_missing = '' THEN '' ELSE ', ' END || '"ExternalEffectCatalog"';
  END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'phase6 4d-i-b U2 ABORT: this unit judges bundles a mechanism 4d-i and U1 install, and this database holds none of: %. Both 4d-i halves (20271220000000 and 20271221000000) and U1 (20271222000000) apply before this file. Apply them first. See docs/RUNBOOK.md §P6T4D.',
      v_missing;
  END IF;
END $t4dib_u2_prereq$;

-- ── THE DARKNESS GATE: is the change/approval pairing switched on yet? ───────────────────────
-- TRUE once a coverage generation carries `pairingRequired = true` for any of the change/approval
-- keys this unit's bundle seals judge — which no generation does until U3's flip. The two RAISE-ing
-- seals below consult it and RETURN NULL while it is FALSE, so U2 is dark exactly as U1's actor rule
-- is: it refuses nothing a release produces until the flip makes the demand real. Keyed on the four
-- change/approval keys (not the consultation pair, whose bundles are other seals') so a flip of some
-- unrelated family never wakes the change seals. STABLE: within one statement the catalog is fixed.
CREATE OR REPLACE FUNCTION phase6_t4d_change_pairing_active() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "ExternalEffectCatalog"
     WHERE "pairingRequired" = TRUE
       AND "effectKey" = ANY (ARRAY[
         'decision.change_requested', 'decision.change_withdrawn',
         'decision.approved', 'decision.reapproved'
       ])
  );
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE TRANSITION RECORDERS (a state is not a transition; only the UPDATE holds OLD)
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── the DECISION's change-lifecycle moves, recorded into 4d-i's trigger-only carrier ────────
-- `xmin` is a WRITE, not a transition: a no-op UPDATE supplies `xmin` and leaves the status, and
-- only the update itself holds OLD. The change lifecycle's pairings are stated over FOUR moves —
-- `approved → change` (the standard opening), `change → approved` (the withdrawal's restoration and
-- the no-chain reapproval's landing), `change → awaiting_countersign` (the chain reapproval's
-- landing, 4d-ii) and `awaiting_countersign → change` (the disagreement's reopening) — so this
-- recorder writes those four, by the same idiom 4d-i's recorder uses: a nested INSERT from inside a
-- trigger, at depth the `_t4d_tx_transition_trigger_only` seal admits and a client statement is
-- refused for. Records, refuses nothing; the readers are the seals.
CREATE OR REPLACE FUNCTION phase6_t4d_decision_change_here() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_kind TEXT;
BEGIN
  IF NEW."status"::text IS NOT DISTINCT FROM OLD."status"::text THEN RETURN NEW; END IF;
  v_kind := CASE
    WHEN OLD."status"::text = 'approved'             AND NEW."status"::text = 'change'                THEN 'change_from_approved'
    WHEN OLD."status"::text = 'change'               AND NEW."status"::text = 'approved'              THEN 'approved_from_change'
    WHEN OLD."status"::text = 'change'               AND NEW."status"::text = 'awaiting_countersign'  THEN 'awaiting_from_change'
    WHEN OLD."status"::text = 'awaiting_countersign' AND NEW."status"::text = 'change'                THEN 'change_from_awaiting'
    ELSE NULL END;
  IF v_kind IS NULL THEN RETURN NEW; END IF;
  -- this decision's rows from EARLIER transactions are cleared so the carrier holds at most one
  -- row per (decision, kind) at rest — the same housekeeping 4d-i's recorder performs.
  DELETE FROM "_t4d_tx_transition"
   WHERE "decisionId" = NEW."id" AND "kind" = v_kind AND "txid" <> txid_current();
  INSERT INTO "_t4d_tx_transition" ("txid", "decisionId", "kind")
  VALUES (txid_current(), NEW."id", v_kind)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_change_transition" ON "Decision";
CREATE TRIGGER "Decision_t4d_change_transition" BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_decision_change_here();

CREATE OR REPLACE FUNCTION phase6_t4d_decision_moved_in_tx(p_decision TEXT, p_kind TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "_t4d_tx_transition"
                  WHERE "txid" = txid_current() AND "decisionId" = p_decision AND "kind" = p_kind);
$$;

-- ── the REQUEST's own moves, recorded the same way ──────────────────────────────────────────
-- The decision side below counts the requests "born" or "closed" in this transaction — and a
-- current `xmin` is a WRITE, not a transition (a no-op UPDATE of a request withdrawn last month
-- supplies one). Only the request's own BEFORE trigger holds OLD and can say a row LEFT `open` here
-- or was BORN here, so it records exactly that into 4d-i's carrier, keyed by the decision and naming
-- the request inside the kind — `request_opened:<id>`, `request_withdrawn:<id>`,
-- `request_resolved:<id>` — so one row exists per (request, move) per transaction and a COUNT of
-- moves is still a count. What counts as a birth or a closure is `ChangeRequest_t4d_evidence_frozen`'s
-- rule (4d-i); this recorder writes for the shapes that rule admits and refuses nothing.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_here() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_move TEXT;
BEGIN
  v_move := CASE
    WHEN TG_OP = 'INSERT' AND NEW."status"::text = 'open'                                       THEN 'request_opened'
    WHEN TG_OP = 'UPDATE' AND OLD."status"::text = 'open' AND NEW."status"::text = 'withdrawn'  THEN 'request_withdrawn'
    WHEN TG_OP = 'UPDATE' AND OLD."status"::text = 'open' AND NEW."status"::text = 'resolved'   THEN 'request_resolved'
    ELSE NULL END;
  IF v_move IS NULL THEN RETURN NEW; END IF;
  DELETE FROM "_t4d_tx_transition"
   WHERE "decisionId" = NEW."decisionId" AND "kind" LIKE 'request\_%' AND "txid" <> txid_current();
  INSERT INTO "_t4d_tx_transition" ("txid", "decisionId", "kind")
  VALUES (txid_current(), NEW."decisionId", v_move || ':' || NEW."id")
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_lifecycle_transition" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_lifecycle_transition" BEFORE INSERT OR UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_here();

-- How many requests of this decision performed one of the named moves in THIS transaction and still
-- STAND in the state the move reached at commit (a move walked back by a later statement is not a
-- move that stood). Optionally narrowed to one origin — the standard opening's count.
CREATE OR REPLACE FUNCTION phase6_t4d_requests_moved_in_tx(
  p_project TEXT, p_decision TEXT, p_moves TEXT[], p_origin TEXT DEFAULT NULL
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT count(*)
    FROM "_t4d_tx_transition" t
    JOIN "ChangeRequest" cr
      ON cr."projectId" = p_project AND cr."decisionId" = p_decision
     AND cr."id" = substr(t."kind", position(':' IN t."kind") + 1)
   WHERE t."txid" = txid_current() AND t."decisionId" = p_decision
     AND split_part(t."kind", ':', 1) = ANY (p_moves)
     AND cr."status"::text = CASE split_part(t."kind", ':', 1)
                               WHEN 'request_opened'    THEN 'open'
                               WHEN 'request_withdrawn' THEN 'withdrawn'
                               WHEN 'request_resolved'  THEN 'resolved' END
     AND (p_origin IS NULL OR cr."origin"::text = p_origin);
$$;

-- ── the audit register, counted in THIS transaction ─────────────────────────────────────────
-- `DecisionEvent_t4d_correspondence` (4d-i) fires on the AUDIT row and demands its event and its
-- fact — so a bundle that writes its fact and its event and NO audit row is never judged by it. The
-- fact's own seal must ask the converse: that the audit row for the act it records was appended
-- here. Counted, by `xmin`: two audit rows for one act are as wrong as none. `DecisionEvent` is
-- append-only under 4d-i, so a current `xmin` on an audit row IS its birth.
CREATE OR REPLACE FUNCTION phase6_t4d_tx_audit_count(p_decision TEXT, p_types TEXT[]) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM "DecisionEvent" a
   WHERE a."decisionId" = p_decision AND a."type" = ANY (p_types)
     AND a."xmin" = txid_current()::text::xid;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — (a) THE CHANGE-REQUEST BUNDLE SEALS, IN BOTH DIRECTIONS — JUDGE, DO NOT CLAIM
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── the REQUEST side: `ChangeRequest_t4d_paired` ────────────────────────────────────────────
-- A `ChangeRequest` row is written by TWO acts in its life — the REQUEST that opens it and the
-- CLOSURE that takes it out of `open` — and each act is a BUNDLE with the decision's transition, the
-- audit row that registers it and the event that announces it. This seal JUDGES the request's side
-- of both bundles at COMMIT, when the whole transaction is visible. It makes NO claim: the claimants
-- the request owns (the immediate `ChangeRequest_t4d_claim` and the conditional
-- `countersign_rejection` claim) are U3, with the catalog flip. DEFERRED, because within one
-- transaction the request may be written before or after its transition, its audit row and its
-- event, and every delivered writer writes the event LAST. Dark until U3 flips a generation.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  d RECORD;
  v_events BIGINT;
  v_audits BIGINT;
  v_births BIGINT;
BEGIN
  IF NOT phase6_t4d_change_pairing_active() THEN RETURN NULL; END IF;   -- dark until U3's flip

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'open' THEN RETURN NULL; END IF;   -- the evidence freeze's refusal

    SELECT "status"::text AS status, "xmin" = txid_current()::text::xid AS here
      INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";
    IF NOT FOUND OR d.status IS DISTINCT FROM 'change' OR NOT COALESCE(d.here, FALSE) THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was opened in this transaction, but decision % is `%` at commit and was % — the OPENING is one bundle in both directions: the request and the decision''s move into `change` commit together or neither does. A request beside an untouched decision occupies the one-open-request slot and strands the decision where it stands',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>'),
        CASE WHEN COALESCE(d.here, FALSE) THEN 'written here' ELSE 'NOT written in this transaction' END;
    END IF;
    IF NEW."origin" = 'standard' THEN
      IF NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'change_from_approved') THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % was opened in this transaction, but no `approved → change` move of decision % was performed in it — the standard request pairs with EXACTLY that transition (the delivered `requestChange` performs the CAS and the insert together), and a decision written into `change` from any other state carries a request no act opened',
          NEW."id", NEW."decisionId";
      END IF;
      v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['change_requested']);
      IF v_audits <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % was opened in this transaction with % `change_requested` audit row(s) for decision % — the delivered `requestChange` appends the audit row beside the request and the event, and the register, the fact and the stream record the SAME act: a request with no audit row is an opening the decision log cannot show, and one with two is an act registered twice',
          NEW."id", v_audits, NEW."decisionId";
      END IF;
    ELSIF NEW."origin" = 'countersign_rejection' THEN
      IF NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'change_from_awaiting') THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % was opened in this transaction, but no `awaiting_countersign → change` move of decision % was performed in it — the rejection request pairs with EXACTLY the disagreement''s transition (`Decision_t4d_disagreement_paired` demands the request when that move happens; this is its converse), and a decision that merely sits in `change` at commit, its `xmin` supplied by a no-op UPDATE, has not been disagreed with here',
          NEW."id", NEW."decisionId";
      END IF;
      -- ONE act, ONE actor (#590 round 4). No audit row is declared for this branch, so 4d-i's
      -- `DecisionEvent_t4d_correspondence` never compares the event's envelope with the request:
      -- the request does it, through U1's actor-narrowed primitive.
      v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                   ARRAY['decision.change_requested'], NEW."requestedById");
      IF NEW."requestedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % of decision % names % as its requester, and this transaction carries % `decision.change_requested` event(s) attributed to that person (`actorId`) — the disagreement is ONE act with ONE actor: the request records who disagreed and the event announces who did, no `DecisionEvent` audit row is declared for this branch for 4d-i''s correspondence to bind them through, and two immutable records that disagree about who reopened the decision leave a register that cannot say',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedById", '<nobody>'), v_events;
      END IF;
    END IF;

    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.change_requested']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was opened in this transaction with % `decision.change_requested` event(s) for decision % — the act that opens a request announces it exactly ONCE, in the same transaction; a request with no event is an act nobody can see, and one with two is an act recorded twice',
        NEW."id", v_events, NEW."decisionId";
    END IF;
    -- U2 JUDGES the opening bundle; it CLAIMS nothing. The event's claim — unconditional for the
    -- standard opening, conditional (not a `returned` resolution) for the countersign_rejection — is
    -- U3's, together with the flip. Nothing more to verify here.
    RETURN NULL;
  END IF;

  -- UPDATE: only the CLOSURE — the row LEAVING `open` — is a pairing question.
  IF OLD."status" IS DISTINCT FROM 'open' OR NEW."status" IS NOT DISTINCT FROM 'open' THEN
    RETURN NULL;
  END IF;

  SELECT "status"::text AS status, "xmin" = txid_current()::text::xid AS here
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF NEW."status" = 'withdrawn' THEN
    IF NOT COALESCE(d.here, FALSE) OR d.status IS DISTINCT FROM 'approved'
       OR NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change') THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was WITHDRAWN in this transaction, but decision % is `%` at commit and its `change → approved` restoration was % — the closure and the restoration are ONE bundle in both directions (#558 round 1, finding 2): a withdrawn request beside a decision still in `change` leaves it stranded with nothing to withdraw and no state to approve from',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>'),
        CASE WHEN phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change')
             THEN 'performed here' ELSE 'NOT performed in this transaction' END;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['change_withdrawn']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was withdrawn in this transaction with % `change_withdrawn` audit row(s) for decision % — the delivered `withdrawChange` appends the audit row beside the closure and the event, and a withdrawal the decision log cannot show is a closure nobody registered',
        NEW."id", v_audits, NEW."decisionId";
    END IF;
    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.change_withdrawn']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was withdrawn in this transaction with % `decision.change_withdrawn` event(s) for decision % — a withdrawal announces itself exactly ONCE in the same transaction',
        NEW."id", v_events, NEW."decisionId";
    END IF;
    -- U2 JUDGES the withdrawal bundle; the closure's claim of its `decision.change_withdrawn` event
    -- is U3's. Nothing more to verify here.
    RETURN NULL;
  END IF;

  IF NEW."status" = 'resolved' THEN
    IF NOT COALESCE(d.here, FALSE)
       OR NOT (   (d.status = 'approved'             AND phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'approved_from_change'))
               OR (d.status = 'awaiting_countersign' AND phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'awaiting_from_change'))) THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was RESOLVED in this transaction, but decision % is `%` at commit and did not leave `change` for `approved` (no chain) or `awaiting_countersign` (chain) here — a resolution is the reapproval''s closure and pairs with the reapproval''s own transition (#558 round 2, finding 6); a request resolved beside a decision that stays in `change` records an approval nobody made',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
    END IF;
    SELECT count(*) INTO v_births FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
       AND r."xmin" = txid_current()::text::xid;
    IF v_births <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was resolved by a reapproval of decision % that wrote % approval revision(s) in this transaction — the reapproval IS the act that closes the request, and its revision is that act''s immutable record and the claimant of its event; a closure with no head behind it is a request closed by nobody',
        NEW."id", NEW."decisionId", v_births;
    END IF;
    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.approved', 'decision.reapproved', 'decision.awaiting_countersign']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was resolved in this transaction with % approval-family event(s) for decision % — the reapproval that closes a request announces itself exactly ONCE (claimed by its revision, never by this closure)',
        NEW."id", v_events, NEW."decisionId";
    END IF;
    RETURN NULL;
  END IF;

  -- any other way out of `open` is refused by the evidence freeze; nothing to pair.
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_paired" ON "ChangeRequest";
CREATE CONSTRAINT TRIGGER "ChangeRequest_t4d_paired"
  AFTER INSERT OR UPDATE ON "ChangeRequest" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_paired();

-- ── the DECISION side: `Decision_t4d_change_paired` ─────────────────────────────────────────
-- The converse, without which "both directions" is one direction: a transition performed with NO
-- request. Over the recorder's moves:
--   `approved → change`             ⇒ exactly ONE `standard` request BORN open in this transaction
--   `change → approved`             ⇒ exactly ONE request that LEFT `open` here (`withdrawn`/`resolved`)
--   `change → awaiting_countersign` ⇒ exactly ONE request that left `open` for `resolved` here
--   `awaiting_countersign → change` ⇒ exactly ONE `countersign_rejection` request BORN open here
-- and the move must still STAND at commit. Counted, not found: two requests born beside one opening
-- are two immutable requesters for one act. BORN and LEFT are read from the request recorder, not
-- from `xmin`. The delivered `requestChange`, `withdrawChange` and `approve` each satisfy this in one
-- transaction; the previous release's writers are the same code. JUDGES, claims nothing. Dark until
-- U3's flip.
CREATE OR REPLACE FUNCTION phase6_t4d_change_transition_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT;
BEGIN
  IF NOT phase6_t4d_change_pairing_active() THEN RETURN NULL; END IF;   -- dark until U3's flip

  IF phase6_t4d_decision_moved_in_tx(NEW."id", 'change_from_approved') THEN
    IF NEW."status"::text <> 'change' THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `approved → change` in this transaction and does not END it in `change` (it is `%`) — a reopening walked back by a later statement leaves its request recording a move that did not stand',
        NEW."id", NEW."status";
    END IF;
    v_n := phase6_t4d_requests_moved_in_tx(NEW."projectId", NEW."id", ARRAY['request_opened'], 'standard');
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `approved → change` in this transaction with % open `standard` change request(s) born here — the OPENING is one bundle in both directions (#568 round 1, finding 3): the transition without its request leaves a decision in `change` whose reason no reader can see and which neither approve nor withdrawChange can close',
        NEW."id", v_n;
    END IF;
  END IF;

  IF phase6_t4d_decision_moved_in_tx(NEW."id", 'approved_from_change') THEN
    IF NEW."status"::text <> 'approved' THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `change → approved` in this transaction and does not END it in `approved` (it is `%`) — a restoration walked back by a later statement leaves its closure recording a move that did not stand',
        NEW."id", NEW."status";
    END IF;
    v_n := phase6_t4d_requests_moved_in_tx(NEW."projectId", NEW."id", ARRAY['request_withdrawn', 'request_resolved']);
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `change → approved` in this transaction with % change request(s) closed here — the closure and the restoration are ONE bundle in both directions (#558 round 1, finding 2; round 2, finding 6): a decision restored with its request left open occupies the one-open-request slot forever, one restored with two closures records two acts for one, and a historical closure re-written without leaving `open` is not a closure performed here',
        NEW."id", v_n;
    END IF;
  END IF;

  IF phase6_t4d_decision_moved_in_tx(NEW."id", 'change_from_awaiting') THEN
    IF NEW."status"::text <> 'change' THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `awaiting_countersign → change` in this transaction and does not END it in `change` (it is `%`) — a disagreement walked back by a later statement leaves its request recording a move that did not stand',
        NEW."id", NEW."status";
    END IF;
    v_n := phase6_t4d_requests_moved_in_tx(NEW."projectId", NEW."id", ARRAY['request_opened'], 'countersign_rejection');
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `awaiting_countersign → change` in this transaction with % open `countersign_rejection` change request(s) born here — the disagreement (reject-back, forward-on or the `returned` resolution) is one bundle in both directions: a rejection request planted earlier and touched again is a write, not the request this move owes',
        NEW."id", v_n;
    END IF;
  END IF;

  IF phase6_t4d_decision_moved_in_tx(NEW."id", 'awaiting_from_change') THEN
    IF NEW."status"::text <> 'awaiting_countersign' THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `change → awaiting_countersign` in this transaction and does not END it there (it is `%`) — a provisional reapproval walked back by a later statement leaves its closure recording a move that did not stand',
        NEW."id", NEW."status";
    END IF;
    v_n := phase6_t4d_requests_moved_in_tx(NEW."projectId", NEW."id", ARRAY['request_resolved']);
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: decision % moved `change → awaiting_countersign` in this transaction with % change request(s) resolved here — the chain reapproval carries the closure of the request it reapproves from (§A.3, the `open → resolved` pairing): a provisional reapproval that leaves its request open parks a decision whose reopening was never answered',
        NEW."id", v_n;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_change_paired" ON "Decision";
CREATE CONSTRAINT TRIGGER "Decision_t4d_change_paired"
  AFTER UPDATE ON "Decision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_transition_paired();

COMMIT;
