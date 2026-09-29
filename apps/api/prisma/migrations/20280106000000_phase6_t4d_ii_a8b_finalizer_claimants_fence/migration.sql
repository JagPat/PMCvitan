-- Phase 6 task 4d unit 4d-ii-a / A8b — THE FINALIZERS' CLAIMANTS, THE RETURNED REQUEST'S PROVENANCE,
-- AND THE SERVER-GENERATION FENCE RAISED (the staging document `2026-09-26-4d-ii-a-additive-units.md`:
-- the A8b row, "Every migration an A-unit ships", "The drain"; the plan's §A.2 "Countersign, and the
-- state that carries it", "The stranded decision, resolved by a NAMED command"; §A.3 obligation 7; §B.6).
--
-- WHAT THIS FILE DOES.
--
--   1. THE TWO FINALIZER CLAIMANTS. 4d-i's kernel pairing seal (`DomainEvent_t4d_pairing_claimed`) refuses
--      at commit every `pairingRequired` event no fact claims, and §A.3 says the claimant of a branch is
--      the fact present on EVERY instance of it. The countersign's branch (`decision.approved` /
--      `decision.reapproved` emitted by the FINALIZER, with no new revision born) had no claimant: the
--      revision claimant (U3, A7a, A7d) fires on the revision's INSERT and never on its finality flip. The
--      stranded resolution's two branches — `completed` announcing the same family, `returned` announcing
--      `decision.change_requested`, where 4d-i-b's request seals already DEFER to the resolution as the
--      claimant — had none either. So this file installs `phase6_t4d_countersign_claims_event` and
--      `phase6_t4d_stranded_claims_event` on the pattern of A7d's forward claimant (an immediate half
--      that claims when the event is already written, a DEFERRED half that demands exactly one event and
--      the finalizer's audit row at commit): the fact claims the same-transaction event of its decision
--      attributed to its own actor (`countersignedById` / `resolvedById`) and naming the fact and the
--      revision it disposed of (`payload.revisionId`, `payload.countersignId` / `payload.resolutionId`).
--      The family itself (`approved` vs `reapproved`) is judged against the revision's `approvedFrom` by
--      4d-i's correspondence seal; the finalizer's audit row (`countersigned` / `stranded_resolved`) is
--      bound to the fact by the same seal and demanded here.
--
--   2. THE RETURNED REQUEST'S PROVENANCE. 4d-i's `phase6_t4d_provenance_bound` admits a
--      `countersign_rejection` request only under a `decisions.disagree` receipt, while §B.6 gives the
--      request TWO producers and P33b admits the PMC's `returned` resolution's request under the
--      RESOLUTION's receipt (the resolution is that bundle's primary; the bundle arm of the same seal
--      already admits a request citing the receipt whose result names the resolution). The function is
--      re-issued with that one arm widened; every other clause is byte-identical.
--
--   2b. THE ONE-OPEN-APPROVAL INVARIANT, COUNTING UNDISPOSED REVISIONS. The plan (§A.2) states the head
--      the awaiting pairing demands as `finalized = false` … "and UNDISPOSED — named by no
--      `countersign_rejection` `ChangeRequest` and no `DecisionStrandedResolution` … so a rejected or
--      returned head can never be re-entered by a bare status flip while the real re-approval appends
--      a FRESH head that passes". 4d-i's `phase6_t4d_revision_birth_paired` (2b) counted EVERY
--      unfinalized revision of the decision's history as an open approval; a rejected head stays
--      unfinalized forever, so the fresh head the re-approval appends after a disagreement (or a
--      `returned` resolution under a chain re-seated since) was refused as a second open approval — the
--      rejected decision could never be approved again while the chain stood, which is the flow the
--      disagreement exists to demand. The function is re-issued with that one count excluding the
--      revisions a rejection request or a `returned` resolution names; every other clause is
--      byte-identical. The seals that act on the head are untouched: `phase6_t4d_provisional_head` takes
--      the highest version, and a finalizer citing a disposed one is refused there as superseded.
--
--   3. THE FENCE, RAISED. A6e installed the server-generation fence and set the persisted minimum to 1
--      (its own generation), so nothing running was refused. A8b is the last 4d-ii-a server unit — the
--      release the drain's minimum names — so this file raises the minimum to 2, A8b's compiled
--      generation: from here every A6-to-A8a build, an A7 image restarted after A8b included, is refused
--      at startup exactly as a stale `catalogVersion` is. The raise is A6e's block with this file's literal
--      and name; a replay after a later raise changes nothing (GREATEST, the evidence kept).
--
-- Re-runnable (CREATE OR REPLACE, DROP TRIGGER IF EXISTS, GREATEST), one transaction, verified at the
-- end; on `ALWAYS_EXECUTE` (the staging document): the claimants, the widened arm and the raised minimum
-- are raw SQL a db-push baseline never carries and a resolve-as-applied never installs.

BEGIN;

-- ── THE PREREQUISITES ARE 4d-i's AND A6e's, VERIFIED, NOT ASSUMED ─────────────────────────────
DO $t4dii_a8b_prereq$
BEGIN
  IF to_regclass('"DecisionCountersign"') IS NULL OR to_regclass('"DecisionStrandedResolution"') IS NULL
     OR to_regclass('"ServerGeneration"') IS NULL
     OR to_regproc('phase6_t4d_provenance_bound') IS NULL OR to_regproc('platform_claim_event_pairing_once') IS NULL
     OR to_regproc('phase6_t4d_revision_birth_paired') IS NULL
     OR to_regproc('phase6_t4d_tx_audit_count') IS NULL OR to_regproc('platform_t4d_server_generation_raised') IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b ABORT: this unit installs claimants on 4d-i''s two finalizer fact tables, re-issues 4d-i''s provenance seal and raises A6e''s server-generation minimum, and this database does not hold all of them. Those files apply before this one in the ledger; on the P3005 baseline path they are on ALWAYS_EXECUTE.';
  END IF;
END $t4dii_a8b_prereq$;

-- ── 1a. the `DecisionCountersign` fact claims the finalizing event ──────────────────────────────
CREATE OR REPLACE FUNCTION phase6_t4d_countersign_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT; v_event TEXT; v_audits BIGINT;
BEGIN
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
     AND e."eventType" IN ('decision.approved', 'decision.reapproved')
     AND e."actorId" = NEW."countersignedById"
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> jsonb_build_object('revisionId', NEW."revisionId", 'countersignId', NEW."id");
  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: countersign % of decision % was written in this transaction with % finalizing event(s) (`decision.approved` / `decision.reapproved`) that name it (`payload.countersignId`) and its revision (`payload.revisionId`) and are attributed to the countersigner (`actorId` = `countersignedById`) — a countersign announces the approval it finalized exactly ONCE, in the same transaction, in the architect''s name and for the revision it ended: a finalization with no such event is an approval the stream never carried, and one with two is an act announced twice',
        NEW."id", NEW."decisionId", v_n;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['countersigned']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: countersign % of decision % was written in this transaction with % `countersigned` audit row(s) — the finalizer appends its own row beside the `approved`/`reapproved` row the provisional act left (§A.3 obligation 7), and the register, the fact and the stream record the SAME act',
        NEW."id", NEW."decisionId", v_audits;
    END IF;
  END IF;
  IF v_n <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionCountersign', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_claim" ON "DecisionCountersign";
CREATE TRIGGER "DecisionCountersign_t4d_claim"
  AFTER INSERT ON "DecisionCountersign"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_claims_event();
DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_claim_deferred" ON "DecisionCountersign";
CREATE CONSTRAINT TRIGGER "DecisionCountersign_t4d_claim_deferred"
  AFTER INSERT ON "DecisionCountersign" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_claims_event();

-- ── 1b. the `DecisionStrandedResolution` fact claims its outcome's event ────────────────────────
-- `completed` announces the finalized approval (the family the revision's `approvedFrom` chooses);
-- `returned` announces the reopening (`decision.change_requested`) — the request the bundle opens
-- verifies and never claims (4d-i-b's `ChangeRequest_t4d_claim` / `_paired` defer to the resolution).
CREATE OR REPLACE FUNCTION phase6_t4d_stranded_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT; v_event TEXT; v_audits BIGINT; v_types TEXT[];
BEGIN
  v_types := CASE NEW."outcome"
    WHEN 'completed' THEN ARRAY['decision.approved', 'decision.reapproved']
    ELSE ARRAY['decision.change_requested'] END;
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
     AND e."eventType" = ANY (v_types)
     AND e."actorId" = NEW."resolvedById"
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> jsonb_build_object('revisionId', NEW."revisionId", 'resolutionId', NEW."id");
  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: stranded resolution % (`%`) of decision % was written in this transaction with % event(s) of its outcome''s family (%) that name it (`payload.resolutionId`) and its revision (`payload.revisionId`) and are attributed to the resolving PMC (`actorId` = `resolvedById`) — a resolution announces its outcome exactly ONCE, in the same transaction, in the resolver''s name and for the revision it disposed of',
        NEW."id", NEW."outcome", NEW."decisionId", v_n, array_to_string(v_types, ' or ');
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['stranded_resolved']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: stranded resolution % of decision % was written in this transaction with % `stranded_resolved` audit row(s) — the resolver appends its own row (§A.3 obligation 7), and the register, the fact and the stream record the SAME act',
        NEW."id", NEW."decisionId", v_audits;
    END IF;
  END IF;
  IF v_n <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionStrandedResolution', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_claim" ON "DecisionStrandedResolution";
CREATE TRIGGER "DecisionStrandedResolution_t4d_claim"
  AFTER INSERT ON "DecisionStrandedResolution"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_claims_event();
DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_claim_deferred" ON "DecisionStrandedResolution";
CREATE CONSTRAINT TRIGGER "DecisionStrandedResolution_t4d_claim_deferred"
  AFTER INSERT ON "DecisionStrandedResolution" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_claims_event();

-- ── 2. the provenance seal, re-issued with the returned request's second producer ───────────────
-- 4d-i's body, byte-identical but for the one `ChangeRequest` arm (its four triggers stand as installed
-- and are not touched here).
CREATE OR REPLACE FUNCTION public.phase6_t4d_provenance_bound()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  c RECORD;
  v_primary_ok BOOLEAN := FALSE;
  v_types TEXT[];
  v_actor_column TEXT;
  v_actor TEXT;
BEGIN
  v_types := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN
      ARRAY['decisions.forward', 'decisions.disagree', 'decisions.resolveStrandedCountersign']
    WHEN 'DecisionCountersign' THEN ARRAY['decisions.countersign']
    WHEN 'DecisionStrandedResolution' THEN ARRAY['decisions.resolveStrandedCountersign']
    -- #582's review round 20, finding 1 — THE CHANGE REQUEST'S BIRTH RECEIPT IS PROVENANCE TOO,
    -- and it was FROZEN without ever being judged. Round 8 made `sourceCommandId` immutable from
    -- the moment it lands and round 17 bound the requester PAIR to its actor; between them nothing
    -- asked what the receipt IS. A direct standard-request bundle could therefore cite any unused
    -- historical same-project `CommandExecution` — the FK is satisfied, the unique index is
    -- satisfied — and the freeze then made that false provenance permanent, beyond anything
    -- 4d-iii's future-write seals can reach.
    --
    -- The kinds are the ones that OPEN a request, keyed to the discriminator the row already
    -- carries: a `standard` request is opened by `decisions.requestChange`, and a
    -- `countersign_rejection` by the architect's `decisions.disagree`. Naming them per origin
    -- rather than as one list is the round-7 rule (bind each command to the shape it performs):
    -- a disagreement receipt may not back a standard request, or the origin column would be a
    -- label with nothing behind it.
    WHEN 'ChangeRequest' THEN
      CASE to_jsonb(NEW) ->> 'origin'
        -- 4d-ii-a / A8b: the rejection request has TWO legal producers (§B.6, P33b) — the architect's
        -- disagreement, whose receipt names the request as its primary, and the PMC's `returned` stranded
        -- resolution, whose receipt names the RESOLUTION and which the bundle arm below admits for a
        -- request citing the same receipt. The delivered arm named the disagreement alone, so every
        -- `returned` bundle's request was refused at commit as citing a receipt of the wrong command.
        WHEN 'countersign_rejection' THEN ARRAY['decisions.disagree', 'decisions.resolveStrandedCountersign']
        ELSE ARRAY['decisions.requestChange']
      END
    ELSE NULL
  END;
  v_actor_column := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN 'forwardedById'
    WHEN 'DecisionCountersign' THEN 'countersignedById'
    WHEN 'DecisionStrandedResolution' THEN 'resolvedById'
    WHEN 'ChangeRequest' THEN 'requestedById'
    ELSE NULL
  END;
  IF v_types IS NULL OR v_actor_column IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% is bound by phase6_t4d_provenance_bound, but no command kind or actor column is declared for table % — a fact whose expected provenance nobody stated is a fact nothing is checking',
      TG_TABLE_NAME, NEW."id", TG_TABLE_NAME;
  END IF;
  v_actor := to_jsonb(NEW) ->> v_actor_column;

  -- THE RECEIPT IS THIS TRANSACTION'S (#582 round 4, finding 3). Round 3's finding 3 corrected
  -- exactly this shape on `phase6_t4d_membership_transition_bound` — a message that has said "in
  -- this transaction" since round 1 over a query with no transaction predicate — and the commit
  -- that carried it reasoned that the DECISION facts were safe because their commands are new.
  -- They are not: `decisions.forward`, `decisions.disagree`, `decisions.countersign` and
  -- `decisions.resolveStrandedCountersign` are all DELIVERED and ledgered today, so a mature
  -- database holds succeeded receipts for every one of them that no 4d fact has ever cited. A
  -- later direct transaction can write a forward, countersign or resolution citing one of those
  -- HISTORICAL receipts and satisfy every other clause here truthfully — right command kind, right
  -- actor, right result — presenting a new act as an old command's. `xmin` closes it, and it is
  -- read under an alias no other predicate in this body uses so the contract register can witness
  -- THIS clause rather than some other use of `txid_current`.
  SELECT "status", "resultRef", "commandType", "actorId",
         "xmin" = txid_current()::text::xid AS "receiptThisTx"
    INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the row',
      TG_TABLE_NAME, NEW."id";
  END IF;
  IF NOT COALESCE(c."receiptThisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites receipt %, which was completed by an EARLIER transaction — the fact and its receipt are one act seen twice, and a receipt lying around from a past forward, countersign or resolution cannot back an act performed now',
      TG_TABLE_NAME, NEW."id", NEW."sourceCommandId";
  END IF;

  IF NOT (c."commandType" = ANY (v_types)) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a `%` receipt, which is not a command that writes this fact (expected one of %) — provenance names the act, and a receipt borrowed from an unrelated command proves nothing about this one',
      TG_TABLE_NAME, NEW."id", c."commandType", array_to_string(v_types, ', ');
  END IF;

  IF c."actorId" IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% attributes the act to %, but its receipt was run by % — the fact and the receipt are one act seen twice, and a truthful attribution pair naming someone who ran no command is exactly the forgery the frozen pair exists to prevent',
      TG_TABLE_NAME, NEW."id", COALESCE(v_actor, '<null>'), COALESCE(c."actorId", '<null>');
  END IF;

  IF c."resultRef" = NEW."id" THEN RETURN NULL; END IF;

  -- The bundle arm. The primary is looked up by the SHARED receipt, which is what makes this a
  -- bundle rather than two unrelated rows: a row citing a receipt whose result names some other
  -- command's fact finds nothing here and is refused.
  SELECT EXISTS (
    SELECT 1 FROM "ChangeRequest" cr
     WHERE cr."projectId" = NEW."projectId" AND cr."id" = c."resultRef"
       AND cr."sourceCommandId" = NEW."sourceCommandId"
       AND cr."decisionId" = NEW."decisionId"
  ) OR EXISTS (
    SELECT 1 FROM "DecisionStrandedResolution" sr
     WHERE sr."projectId" = NEW."projectId" AND sr."id" = c."resultRef"
       AND sr."sourceCommandId" = NEW."sourceCommandId"
       AND sr."decisionId" = NEW."decisionId"
  ) INTO v_primary_ok;

  IF NOT v_primary_ok THEN
    RAISE EXCEPTION
      'phase6 4d-i: the receipt cited by %.% names result %, which is neither this row nor a PRIMARY fact of its bundle citing the same receipt for the same decision — a receipt for another result cannot be borrowed',
      TG_TABLE_NAME, NEW."id", COALESCE(c."resultRef", '<null>');
  END IF;
  RETURN NULL;
END $function$;

-- ── 2b. the one-open-approval invariant, re-issued to count UNDISPOSED revisions ────────────────
-- 4d-i's body, byte-identical but for the (2b) count and its message (the trigger
-- `DecisionApprovalRevision_t4d_birth_paired` stands as installed and is not touched here).
CREATE OR REPLACE FUNCTION public.phase6_t4d_revision_birth_paired()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_births BIGINT; v_moved BOOLEAN; v_open BIGINT;
BEGIN
  SELECT count(*) INTO v_births FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
     AND r."xmin" = txid_current()::text::xid;
  IF v_births <> 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % carries % DecisionApprovalRevision rows BORN in this transaction (including version %) — an approval is ONE act with ONE revision, and sibling births citing different receipts leave every revision below the head permanently unfinalizable while the register''s COUNT reports approval cycles that never happened',
      NEW."decisionId", v_births, NEW."version";
  END IF;

  IF NEW."finalized" = FALSE THEN
    -- (2a) THE DECISION ENDS WHERE A PROVISIONAL APPROVAL PUTS IT (#582 round 11, finding 3).
    --
    -- Round 10 asked only whether this transaction WROTE the decision, and wrote down why:
    -- "pinning a final status here would repeat round 8's mistake of judging a transition by the
    -- state it left behind". That reasoning was wrong, and wrong in a way I could have tested. A
    -- no-op `UPDATE` satisfies `xmin` — it is a write that changes nothing — so a bundle could
    -- touch an already-`awaiting_countersign` decision and insert a second provisional revision
    -- beside the first. Round 8's mistake was reading a state INSTEAD of the transition where the
    -- transition was the rule; here the state IS the rule, because a provisional approval is
    -- defined by where it leaves its decision, and `Decision_t4d_entry_seal` already owns the
    -- question of which transitions may reach that state.
    -- AND THE SIBLING OF ROUND 22's FINDING 3 IS HERE (#582 round 22, the class sweep). The
    -- paragraph above names the no-op hazard exactly — "a bundle could touch an already-
    -- `awaiting_countersign` decision and insert a second provisional revision beside the first" —
    -- and then answers it with the END STATE, which that same no-op also satisfies. It is the
    -- finalized arm's defect verbatim, written one screen higher, and the argument that "here the
    -- state IS the rule" does not rescue it: the hazard the paragraph names is a SECOND revision
    -- beside a decision already parked, and the status is true of exactly that case.
    --
    -- The transition register answers both arms, and it records a MOVE rather than a state:
    -- `Decision_t4d_approval_transition` appends the decision to this set when the status CHANGES
    -- INTO `awaiting_countersign`. The end state is kept beside it so a later statement in the
    -- same transaction cannot park the decision, plant the revision and then move it away.
    -- (2b) AND A DECISION HOLDS AT MOST ONE OPEN APPROVAL, which is the invariant the attack
    -- actually breaks and the one this file has been ASSUMING all along:
    -- `phase6_t4d_provisional_head` resolves "the" provisional head as the highest-version
    -- unfinalized revision, which is only well defined when there is one. Two of them strand
    -- every revision below the head — no finalizer can ever reach it, because both the
    -- countersign and the `completed` resolution are sealed onto the head — while the register's
    -- COUNT, which 4c reads as cycle evidence, reports approvals that never happened.
    --
    -- Asked over the decision's WHOLE history rather than this transaction's rows, because a
    -- second provisional revision is equally corrupt whenever it arrives.
    --
    -- 4d-ii-a / A8b — UNDISPOSED, as the plan states the head (§A.2 "Countersign, and the state that
    -- carries it": "`finalized = false` … and UNDISPOSED — named by no `countersign_rejection`
    -- `ChangeRequest` and no `DecisionStrandedResolution`, both of which record the exact `revisionId`
    -- they disposed of … so a rejected or returned head can never be re-entered by a bare status flip
    -- while the real re-approval appends a FRESH head that passes"). 4d-i's count read every
    -- unfinalized revision as OPEN, and a rejected head stays unfinalized forever (finality moves only
    -- by a finalizer's act, which a rejection is not): the re-approval the disagreement demands — the
    -- FRESH provisional head the chain runs again on — was refused as a second open approval, and the
    -- decision the architect rejected could never be approved again while the chain stood. A revision a
    -- rejection request or a `returned` resolution names is DISPOSED of: closed, never finalizable,
    -- never the head a finalizer acts on (`phase6_t4d_provisional_head` takes the highest version).
    SELECT count(*) INTO v_open FROM "DecisionApprovalRevision" r
     WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId"
       AND r."finalized" = FALSE
       AND NOT EXISTS (SELECT 1 FROM "ChangeRequest" c
                        WHERE c."projectId" = r."projectId" AND c."decisionId" = r."decisionId"
                          AND c."origin" = 'countersign_rejection' AND c."revisionId" = r."id")
       AND NOT EXISTS (SELECT 1 FROM "DecisionStrandedResolution" s
                        WHERE s."projectId" = r."projectId" AND s."decisionId" = r."decisionId"
                          AND s."outcome" = 'returned' AND s."revisionId" = r."id");
    IF v_open > 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % would hold % unfinalized, UNDISPOSED approval revisions at commit (this one is version %) — a decision has at most ONE open approval, the head its finalizer acts on, and every revision below it is stranded beyond the reach of any countersign or resolution (a revision a `countersign_rejection` request or a `returned` resolution names is disposed of, not open)',
        NEW."decisionId", v_open, NEW."version";
    END IF;

    -- THE ORDER OF (2b) AND (2c) IS LOAD-BEARING (#582 round 22, the class sweep). Both refuse a
    -- SECOND provisional revision beside an already-parked decision, and (2b) is the rule that
    -- shape actually breaks — round 11's finding 3 drives exactly it and names this message. Put
    -- the move-demand first and that arm would start passing because something else said no,
    -- which is the abbreviation this PR's round 1 wrote an oracle for. The move-demand is the
    -- GENERAL rule and answers what (2b) cannot see: a FIRST provisional revision with no
    -- transition behind it at all.
    IF NOT phase6_t4d_decision_awaiting_in_tx(NEW."decisionId") THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born PROVISIONAL, but no move of decision % INTO `awaiting_countersign` was performed in this transaction — a provisional approval IS the act that parks a decision for its countersigner, and a write that leaves an already-parked decision parked performs no such act while a second immutable revision claims it did',
        NEW."id", NEW."decisionId";
    END IF;
    SELECT TRUE INTO v_moved FROM "Decision" d
     WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId"
       AND d."status"::text = 'awaiting_countersign';
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born PROVISIONAL and decision % was parked in this transaction, but it does not END the transaction as an `awaiting_countersign` row — a parking that is walked back by a later statement leaves an immutable provisional revision recording a wait nobody is holding',
        NEW."id", NEW."decisionId";
    END IF;

  ELSE
    -- (3) AND A FINALIZED BIRTH RIDES ONE TOO (#582's review round 19, finding 2).
    --
    -- (2) sat inside `IF NEW."finalized" = FALSE`, and its comment explains why: a provisional
    -- birth is unreachable before 4d-iii, so it looked like the interesting one. What that missed
    -- is that `finalized = true` is not only the LEGACY shape — it is also what the live no-chain
    -- `decisions.approve` writes, on every approval this release performs. Scoping the transition
    -- demand to the provisional branch therefore left the ORDINARY approval with none at all.
    --
    -- What that admits: reserve and complete a genuine `decisions.approve` receipt, insert a
    -- revision one version above the head for a decision still sitting at `pending`, and commit.
    -- The decision is never written, no `decision.approved` event is emitted, no audit row is
    -- appended — and every seal passes, because each was asking about something else. The row is
    -- then immutable, it advances the approval COUNT that 4c reads as the consultation cycle, and
    -- it stands as the finalized provenance a later requirement cites. An approval that never
    -- happened, permanently.
    --
    -- The demand is (2a)'s shape without its status: the decision was WRITTEN in this transaction.
    -- Which status an approval may leave it in is already the delivered attribution seal's
    -- question, and re-deciding it here would be round 8's mistake of judging a transition by the
    -- state it left behind.
    --
    -- THE HISTORICAL IMPORT KEEPS ITS DOOR, by the same visible path it already uses: a legacy
    -- revision is born finalized beside a decision nobody is touching, which is exactly this
    -- shape, so `plantLegacyApprovalRevision` disables THIS trigger by name alongside the 4c
    -- provenance seal it already disables. An unnamed writer gets nothing by accident.
    -- AND IT IS THE STATUS, NOT MERELY A WRITE. `xmin` alone is satisfied by a NO-OP UPDATE — a
    -- write that changes nothing — so "this transaction wrote the decision" costs an attacker one
    -- extra statement and nothing else: the decision stays `pending`, every seal that judges the
    -- decision row permits a non-transition, and the forged revision lands anyway. That is round
    -- 11's finding 3 exactly, which strengthened the PROVISIONAL arm above for the same reason and
    -- left this branch unwritten. A finalized approval is DEFINED by where it leaves its decision,
    -- and the delivered `decision_t4b_attribution_seal` says where that is: the approval tuple may
    -- first be written only by `pending`/`change` -> `approved`.
    -- AND IT IS THE TRANSITION, NOT THE END STATE (#582's review round 22, finding 3). The
    -- paragraph above is right that `xmin` alone is a no-op's to supply, and the answer it gave —
    -- add the final status — has the SAME hole one step along: a no-op UPDATE against a decision
    -- that is ALREADY `approved` writes the row (satisfying `xmin`) and leaves it `approved`
    -- (satisfying the status), with nothing transitioned. Only the update itself can tell an act
    -- from a state, because only it holds OLD — so `Decision_t4d_approval_transition` records the
    -- `pending`/`change` -> `approved` move in a transaction-local set as it happens, and this is
    -- the reader. The end state is still required beside it: the transition must also still STAND
    -- at commit, or a later statement in the same transaction could move the decision back out of
    -- the approved family and leave the finalized revision behind.
    IF NOT phase6_t4d_decision_approved_in_tx(NEW."decisionId") THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born FINALIZED, but no `pending`/`change` -> `approved` transition of decision % was performed in this transaction — a finalized approval IS the act that moves its decision into the approved family, and a write that leaves an already-approved decision approved performs no such act while the register counts the revision as a cycle that happened. A historical import declares itself by disabling `DecisionApprovalRevision_t4d_birth_paired` by name, the way the 4c provenance seal is already declared.',
        NEW."id", NEW."decisionId";
    END IF;
    SELECT TRUE INTO v_moved FROM "Decision" d
     WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId"
       AND d."status"::text = 'approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: revision % is born FINALIZED and decision % was moved into `approved` in this transaction, but it does not END the transaction there — an approval that is walked back by a later statement leaves an immutable finalized revision recording a cycle the register no longer agrees happened.',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NULL;
END $function$;

-- ── 3. THE RAISE, inside the migration transition (A6e's block with this file's literal and name) ──
DO $$
BEGIN
  EXECUTE 'CREATE FUNCTION platform_t4d_server_generation_migration_open() RETURNS void LANGUAGE sql AS ''SELECT''';
  INSERT INTO "ServerGeneration" ("key", "minimumGeneration", "raisedBy", "raisedAt")
  VALUES ('singleton', 2, '20280106000000_phase6_t4d_ii_a8b_finalizer_claimants_fence', CURRENT_TIMESTAMP)
  ON CONFLICT ("key") DO UPDATE
    SET "minimumGeneration" = GREATEST("ServerGeneration"."minimumGeneration", EXCLUDED."minimumGeneration"),
        "raisedBy" = CASE WHEN EXCLUDED."minimumGeneration" > "ServerGeneration"."minimumGeneration"
                          THEN EXCLUDED."raisedBy" ELSE "ServerGeneration"."raisedBy" END,
        "raisedAt" = CASE WHEN EXCLUDED."minimumGeneration" > "ServerGeneration"."minimumGeneration"
                          THEN CURRENT_TIMESTAMP ELSE "ServerGeneration"."raisedAt" END;
  EXECUTE 'DROP FUNCTION platform_t4d_server_generation_migration_open()';
END $$;

-- ── 4. FAIL CLOSED ON ITS OWN INSTALLATION ───────────────────────────────────────────────────────
DO $t4dii_a8b_verify$
DECLARE n integer; v_src TEXT; v_min integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgqual IS NULL AND t.tgtype = 5
     AND ((c.relname = 'DecisionCountersign' AND p.proname = 'phase6_t4d_countersign_claims_event'
             AND ((t.tgname = 'DecisionCountersign_t4d_claim' AND NOT t.tgdeferrable)
               OR (t.tgname = 'DecisionCountersign_t4d_claim_deferred' AND t.tgdeferrable AND t.tginitdeferred)))
       OR (c.relname = 'DecisionStrandedResolution' AND p.proname = 'phase6_t4d_stranded_claims_event'
             AND ((t.tgname = 'DecisionStrandedResolution_t4d_claim' AND NOT t.tgdeferrable)
               OR (t.tgname = 'DecisionStrandedResolution_t4d_claim_deferred' AND t.tgdeferrable AND t.tginitdeferred))));
  IF n <> 4 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the two finalizer claimants are not standing as this file installs them (found % of the 4 required triggers). The deploy is refused.', n;
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'phase6_t4d_provenance_bound';
  IF v_src IS NULL OR position('ARRAY[''decisions.disagree'', ''decisions.resolveStrandedCountersign'']' in v_src) = 0
     OR position('receiptThisTx' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the provenance seal does not carry the returned request''s second producer beside 4d-i''s own clauses after this file ran. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.proname = 'phase6_t4d_provenance_bound'
     AND t.tgname IN ('DecisionForward_t4d_provenance_bound', 'DecisionCountersign_t4d_provenance_bound', 'DecisionStrandedResolution_t4d_provenance_bound', 'ChangeRequest_t4d_source_bound');
  IF n <> 4 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the four provenance triggers are not standing on the re-issued body (found %). The deploy is refused.', n;
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'phase6_t4d_revision_birth_paired';
  IF v_src IS NULL OR position('c."origin" = ''countersign_rejection'' AND c."revisionId" = r."id"' in v_src) = 0
     OR position('s."outcome" = ''returned'' AND s."revisionId" = r."id"' in v_src) = 0
     OR position('v_open > 1' in v_src) = 0 OR position('v_births <> 1' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the one-open-approval count does not exclude the disposed revisions beside 4d-i''s own clauses after this file ran. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.proname = 'phase6_t4d_revision_birth_paired'
     AND c.relname = 'DecisionApprovalRevision' AND t.tgname = 'DecisionApprovalRevision_t4d_birth_paired'
     AND t.tgdeferrable AND t.tginitdeferred;
  IF n <> 1 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the birth pairing trigger is not standing deferred on the re-issued body (found %). The deploy is refused.', n;
  END IF;
  SELECT "minimumGeneration" INTO v_min FROM "ServerGeneration" WHERE "key" = 'singleton';
  IF v_min IS NULL OR v_min < 2 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the persisted server-generation minimum is not at least this unit''s (found %). The deploy is refused: every fenced build reads this row at startup.', coalesce(v_min::text, '<no row>');
  END IF;
  IF to_regprocedure('platform_t4d_server_generation_migration_open()') IS NOT NULL THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the migration transition marker was left behind — the register would stay open to any writer in this transaction. The deploy is refused.';
  END IF;
END $t4dii_a8b_verify$;

COMMIT;
