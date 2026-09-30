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
--   2c. THE REJECTION'S AUDIT ROW, DEMANDED (#673's review round 1). 4d-i-b's `phase6_t4d_change_request_paired`
--      demanded the `change_requested` audit row for the `standard` origin alone and declared the
--      `countersign_rejection` branch audit-less, while the plan's correspondence table gives both producers
--      of that origin an audit row (`change_requested`; `stranded_resolved` + `change_requested`) and the
--      delivered writers append it. A receipt-backed hand-run bundle could therefore insert a rejection
--      request with its correctly claimed event and no audit row. The function is re-issued with that one
--      arm demanding exactly one `change_requested` audit row, as the `standard` arm does; every other
--      clause is byte-identical.
--
--   2d. THE FEED ROW AND THE DISCRIMINATOR, DEMANDED (#673's review round 2). The claimants demanded
--      the event and the audit row and never the kinded notice the plan's correspondence table owes each
--      A8b outcome, nor the payload discriminator the kinded renderer reads (`finalization`: countersign /
--      stranded_completed; `outcome`: returned; the rejection's `origin` and `requestId`), nor the
--      envelope's frozen pair beside the actor id (P31). A receipt-backed hand-run bundle could finalize,
--      return or reject with the correctly claimed event and audit row and no feed row, or with an event
--      the renderer reads as an ordinary approval. The two claimants and the request arm now demand the
--      bound notice of the event's kind (`platform_tx_notification`, the kernel read 4d-i installed for
--      this), the discriminator in the payload containment, and the envelope equal to the fact's pair.
--
--   2e. THE CONTENT THE RENDERER READS, BOUND; THE RESOLVE RECEIPT'S PRIMARY, NAMED (#673's review round 3).
--      Round 2 bound the payload's IDENTITY (the fact, the revision, the discriminator) and never its
--      CONTENT: the kinded renderer renders the finalizers' green notice from `payload.title` and
--      `payload.deciderKind`, and the change-request notice from `payload.title` and `payload.reason`,
--      so a receipt-backed hand-run bundle could commit an event the renderer renders as nothing (a field
--      absent) or as another decision's act (a field forged) while every identity clause held. The two
--      claimants now demand `title` equal to the decision's and (the approval family) `deciderKind` equal
--      to the decision's; the request arm demands `title` equal to the decision's and `reason` equal to
--      the request's, both non-blank. And the provenance seal's receipt arm admitted ANY fact table as a
--      receipt's primary (`resultRef = NEW.id` returned unconditionally), so a `countersign_rejection`
--      request (or a forward) could be the primary result of a `decisions.resolveStrandedCountersign`
--      receipt with NO `DecisionStrandedResolution` written — the PMC's return performed without the
--      resolution fact, its inactive-chain and frozen-head judgements bypassed. The receipt arm now names
--      the ONE primary table of each command (`decisions.disagree` → the request; the resolve → the
--      resolution; the forward, the countersign, the standard request → their own facts), and the bundle
--      arm is per command: under a disagreement receipt a forward pairs with the rejection request the
--      receipt names; under a resolve receipt a request or a forward pairs with the `returned` resolution
--      the receipt names — and the request must name the SAME revision the resolution disposed of.
--
--   2f. THE REASON, ONE ACROSS THE BUNDLE; THE BLANK GUARD, ALL OF ASCII WHITESPACE (#673's review round 4).
--      The per-command bundle arm paired the returned request with its resolution by receipt, decision,
--      outcome and revision, never by REASON, so a hand-run bundle could commit a resolution recording
--      reason A beside a request, an event and a notice recording reason B — two immutable records of one
--      act disagreeing about why the PMC returned the approval (the same held for the re-homing forward,
--      and for the forward-on's forward beside its request). The bundle arm now demands the secondary's
--      `reason` equal to the primary's (the request's and the forward's to the resolution's; the forward's
--      to the request's). And the non-blank guards used `btrim`'s default set (the space alone), so a
--      tab-only or newline-only reason or title passed them; they now strip the whole ASCII whitespace set.
--
--   2g. THE APPROVER PAIR BOUND TO THE REVISION; THE PRODUCER'S AUTHORITY AND THE FROZEN PAIR BOUND TO THE
--      RECEIPT AND THE ENVELOPE (#673's review round 5). The finalizing event carries the provisional
--      revision's frozen approver pair (`approverName`/`approverRole`) and the family origin it recorded
--      (`approvedFrom`) — the payload the finalizer freezes — and neither claimant compared them to the
--      revision, so a hand-run bundle could commit immutable event evidence attributing the approval to
--      another person than the revision records. Both claimants now demand the three equal to the named
--      revision's columns, and refuse a revision that carries none. And the rejection request's arm bound
--      the event's `actorId` to `requestedById` and nothing else, so a receipt-backed `decisions.disagree`
--      bundle run by an active CLIENT with a truthful `client` pair could reopen an awaiting decision with
--      no architect. The arm now demands the request's receipt (a rejection has no receipt-less producer),
--      the producer's role — `architect` under `decisions.disagree`, `pmc` under
--      `decisions.resolveStrandedCountersign` — as the request's frozen role, a non-null frozen pair, and
--      exactly one event whose envelope (`actorId`, `actorRole`, `actorName`) equals that pair (4d-i's
--      envelope-truth seal judges the envelope against the actor's real standing, so the chain closes).
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
     OR to_regproc('phase6_t4d_revision_birth_paired') IS NULL OR to_regproc('phase6_t4d_change_request_paired') IS NULL
     OR to_regproc('phase6_t4d_tx_audit_count') IS NULL OR to_regproc('platform_t4d_server_generation_raised') IS NULL
     OR to_regprocedure('platform_tx_notification(text, text)') IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b ABORT: this unit installs claimants on 4d-i''s two finalizer fact tables, re-issues 4d-i''s provenance seal and raises A6e''s server-generation minimum, and this database does not hold all of them. Those files apply before this one in the ledger; on the P3005 baseline path they are on ALWAYS_EXECUTE.';
  END IF;
END $t4dii_a8b_prereq$;

-- ── 1a. the `DecisionCountersign` fact claims the finalizing event ──────────────────────────────
CREATE OR REPLACE FUNCTION phase6_t4d_countersign_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT; v_event TEXT; v_audits BIGINT; v_notices BIGINT; v_title TEXT; v_kind TEXT; v_appr_name TEXT; v_appr_role TEXT; v_from TEXT;
BEGIN
  -- THE CONTENT THE RENDERER READS (#673 round 3): the kinded renderer renders the finalizers' green notice
  -- from `payload.title` and `payload.deciderKind` beside the revision the payload names, so an event carrying
  -- no title or another decision's is one the log renders as nothing or as another act. Both are bound to
  -- the DECISION the fact names (its title non-blank), not to the payload's own word for them.
  SELECT d."title", d."deciderKind"::text INTO v_title, v_kind FROM "Decision" d
   WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId";
  IF btrim(coalesce(v_title, ''), E' \t\n\r\v\f') = '' THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b: countersign % names decision %, whose title is blank or which does not exist — the finalizing event''s notice renders the decision''s title, and a finalization of a decision the log cannot name is refused',
      NEW."id", NEW."decisionId";
  END IF;
  -- THE APPROVER PAIR (#673 round 5): the finalizing event freezes the provisional revision's approver pair
  -- and the family origin it recorded, so an event naming another approver than the revision records is
  -- immutable evidence that misattributes the approval. Bound to the REVISION the fact names, which must
  -- carry them (a head with no frozen approver cannot be finalized: the renderer would render nothing).
  SELECT r."approvedByName", r."approvedByRole", r."approvedFrom" INTO v_appr_name, v_appr_role, v_from
    FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId" AND r."id" = NEW."revisionId";
  IF v_appr_name IS NULL OR v_appr_role IS NULL OR v_from IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b: countersign % names revision % of decision %, which carries no frozen approver pair or no `approvedFrom` — the finalizing event freezes the approver the revision records, and a revision that records none cannot be finalized',
      NEW."id", NEW."revisionId", NEW."decisionId";
  END IF;
  -- the finalizing event: the family, the fact and the revision it names, the DISCRIMINATOR the kinded
  -- renderer reads (`payload.finalization = 'countersign'` — #673 round 2: an event naming the fact but
  -- carrying no or another finalization renders an ordinary approval or the wrong act), the CONTENT it
  -- renders (`title`, `deciderKind` — round 3), and the actor's frozen ENVELOPE equal to the fact's frozen
  -- pair (P31: an envelope carrying a role or name other than the fact's is refused)
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
     AND e."eventType" IN ('decision.approved', 'decision.reapproved')
     AND e."actorId" = NEW."countersignedById"
     AND e."actorRole" = NEW."countersignedByRole" AND e."actorName" = NEW."countersignedByName"
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> jsonb_build_object('revisionId', NEW."revisionId", 'countersignId', NEW."id", 'finalization', 'countersign',
                                           'title', v_title, 'deciderKind', v_kind,
                                           'approverName', v_appr_name, 'approverRole', v_appr_role, 'approvedFrom', v_from);
  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: countersign % of decision % was written in this transaction with % finalizing event(s) (`decision.approved` / `decision.reapproved`) that name it (`payload.countersignId`), its revision (`payload.revisionId`), its finalization (`payload.finalization` = countersign), the decision as the log renders it (`payload.title` and `payload.deciderKind` equal to the decision''s) and the revision''s frozen approver and origin (`payload.approverName`, `payload.approverRole`, `payload.approvedFrom` equal to the revision''s), and are attributed to the countersigner (`actorId` = `countersignedById`, the envelope''s role and name the fact''s frozen pair) — a countersign announces the approval it finalized exactly ONCE, in the same transaction, in the architect''s name and for the revision it ended: a finalization with no such event is an approval the stream never carried, one with two is an act announced twice, and one whose event names another finalization, another person or another decision''s title is an act misreported',
        NEW."id", NEW."decisionId", v_n;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['countersigned']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: countersign % of decision % was written in this transaction with % `countersigned` audit row(s) — the finalizer appends its own row beside the `approved`/`reapproved` row the provisional act left (§A.3 obligation 7), and the register, the fact and the stream record the SAME act',
        NEW."id", NEW."decisionId", v_audits;
    END IF;
    -- THE FEED ROW (#673 round 2; P31: a countersign bundle WITHOUT its feed row is refused): the green
    -- notice bound to the finalizing event, of the event''s own kind, written here
    SELECT count(*) INTO v_notices FROM "Notification" n
     WHERE n."projectId" = NEW."projectId" AND n."eventId" = v_event AND n."decisionId" = NEW."decisionId"
       AND n."kind" IN ('decision.approved', 'decision.reapproved')
       AND n."xmin" = txid_current()::text::xid;
    IF platform_tx_notification(NEW."projectId", v_event) IS NULL OR v_notices <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: countersign % of decision % was written in this transaction with % bound notice(s) of the approval family on its finalizing event — the finalization owes the Decision Log its green notice (the plan''s correspondence table; `Notification.eventId`/`kind` bound to the event, written in the same transaction), and an act with no feed row is one the log cannot show',
        NEW."id", NEW."decisionId", v_notices;
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
DECLARE v_n BIGINT; v_event TEXT; v_audits BIGINT; v_notices BIGINT; v_types TEXT[]; v_named JSONB; v_title TEXT; v_kind TEXT; v_appr_name TEXT; v_appr_role TEXT; v_from TEXT;
BEGIN
  v_types := CASE NEW."outcome"
    WHEN 'completed' THEN ARRAY['decision.approved', 'decision.reapproved']
    ELSE ARRAY['decision.change_requested'] END;
  -- THE CONTENT THE RENDERER READS (#673 round 3): the green notice renders `payload.title` and
  -- `payload.deciderKind`, the change-request notice `payload.title` (and the reason the request arm binds
  -- to the request), so both are bound to the DECISION the fact names (its title non-blank)
  SELECT d."title", d."deciderKind"::text INTO v_title, v_kind FROM "Decision" d
   WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."decisionId";
  IF btrim(coalesce(v_title, ''), E' \t\n\r\v\f') = '' THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b: stranded resolution % names decision %, whose title is blank or which does not exist — the outcome''s notice renders the decision''s title, and a resolution of a decision the log cannot name is refused',
      NEW."id", NEW."decisionId";
  END IF;
  -- THE APPROVER PAIR (#673 round 5): `completed` announces the approval the REVISION records (its frozen
  -- approver pair and `approvedFrom`), never another person's — bound to the revision the fact names
  SELECT r."approvedByName", r."approvedByRole", r."approvedFrom" INTO v_appr_name, v_appr_role, v_from
    FROM "DecisionApprovalRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."decisionId" = NEW."decisionId" AND r."id" = NEW."revisionId";
  IF NEW."outcome" = 'completed' AND (v_appr_name IS NULL OR v_appr_role IS NULL OR v_from IS NULL) THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8b: stranded resolution % completes revision % of decision %, which carries no frozen approver pair or no `approvedFrom` — the finalizing event freezes the approver the revision records, and a revision that records none cannot be finalized',
      NEW."id", NEW."revisionId", NEW."decisionId";
  END IF;
  -- the DISCRIMINATOR the kinded renderer reads (#673 round 2): `completed` announces
  -- `finalization = stranded_completed` (the green notice names the PMC as the finalizer, never as the
  -- approver); `returned` announces `outcome = returned` beside the request it opens — and (round 3) the
  -- CONTENT it renders
  v_named := CASE NEW."outcome"
    WHEN 'completed' THEN jsonb_build_object('revisionId', NEW."revisionId", 'resolutionId', NEW."id", 'finalization', 'stranded_completed',
                                             'title', v_title, 'deciderKind', v_kind,
                                             'approverName', v_appr_name, 'approverRole', v_appr_role, 'approvedFrom', v_from)
    ELSE jsonb_build_object('revisionId', NEW."revisionId", 'resolutionId', NEW."id", 'outcome', 'returned', 'title', v_title) END;
  SELECT count(*), max(e."eventId") INTO v_n, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
     AND e."eventType" = ANY (v_types)
     AND e."actorId" = NEW."resolvedById"
     AND e."actorRole" = NEW."resolvedByRole" AND e."actorName" = NEW."resolvedByName"
     AND e."xmin" = txid_current()::text::xid
     AND e."payload" @> v_named;
  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: stranded resolution % (`%`) of decision % was written in this transaction with % event(s) of its outcome''s family (%) that name it (`payload.resolutionId`), its revision (`payload.revisionId`), its outcome (`payload.finalization` = stranded_completed, or `payload.outcome` = returned) and the decision as the log renders it (`payload.title` equal to the decision''s; `completed`: `payload.deciderKind` too, and the revision''s frozen approver and origin — `payload.approverName`, `payload.approverRole`, `payload.approvedFrom`) and are attributed to the resolving PMC (`actorId` = `resolvedById`, the envelope''s role and name the fact''s frozen pair) — a resolution announces its outcome exactly ONCE, in the same transaction, in the resolver''s name and for the revision it disposed of, and an event naming another outcome, another person or another decision''s title is an act misreported',
        NEW."id", NEW."outcome", NEW."decisionId", v_n, array_to_string(v_types, ' or ');
    END IF;
    -- THE FEED ROW (#673 round 2): the outcome''s notice bound to its event — the green notice for
    -- `completed`, the change-request notice for `returned` — written here
    SELECT count(*) INTO v_notices FROM "Notification" n
     WHERE n."projectId" = NEW."projectId" AND n."eventId" = v_event AND n."decisionId" = NEW."decisionId"
       AND n."kind" = ANY (v_types)
       AND n."xmin" = txid_current()::text::xid;
    IF platform_tx_notification(NEW."projectId", v_event) IS NULL OR v_notices <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: stranded resolution % (`%`) of decision % was written in this transaction with % bound notice(s) of its outcome''s family on its event — the resolution owes the Decision Log its notice (the plan''s correspondence table; `Notification.eventId`/`kind` bound to the event, written in the same transaction), and an act with no feed row is one the log cannot show',
        NEW."id", NEW."outcome", NEW."decisionId", v_notices;
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
-- 4d-i's body, byte-identical but for the one `ChangeRequest` arm, the receipt arm's PRIMARY TABLE and
-- the bundle arm PER COMMAND (#673 round 3; its four triggers stand as installed and are not touched here).
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
  v_primary_table TEXT;
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

  -- 4d-ii-a / A8b (#673 round 3) — THE RECEIPT'S PRIMARY IS ONE TABLE, NAMED PER COMMAND. The delivered
  -- arm returned for ANY row the receipt named as its result, so a `countersign_rejection` request (or a
  -- forward) could be the primary result of a `decisions.resolveStrandedCountersign` receipt with no
  -- `DecisionStrandedResolution` written at all — the PMC's return performed without the fact whose seal
  -- judges the inactive chain and the frozen head, and with no resolution in the register. Each command
  -- writes exactly one primary fact (§A.3: the fact present on EVERY instance of the branch), and a row of
  -- another table citing that receipt is the bundle's SECONDARY, judged by the bundle arm below.
  v_primary_table := CASE c."commandType"
    WHEN 'decisions.forward' THEN 'DecisionForward'
    WHEN 'decisions.countersign' THEN 'DecisionCountersign'
    WHEN 'decisions.resolveStrandedCountersign' THEN 'DecisionStrandedResolution'
    WHEN 'decisions.disagree' THEN 'ChangeRequest'
    WHEN 'decisions.requestChange' THEN 'ChangeRequest'
    ELSE NULL
  END;
  IF c."resultRef" = NEW."id" THEN
    IF v_primary_table IS DISTINCT FROM TG_TABLE_NAME THEN
      RAISE EXCEPTION
        'phase6 4d-ii-a A8b: %.% is named as the PRIMARY result of its `%` receipt, but that command''s primary fact is a % row — a `decisions.resolveStrandedCountersign` receipt names the resolution and a `decisions.disagree` receipt names the request; a request or a forward standing in as the resolve''s result is a return performed with no resolution written, its chain and head never judged',
        TG_TABLE_NAME, NEW."id", c."commandType", COALESCE(v_primary_table, '<none>');
    END IF;
    RETURN NULL;
  END IF;

  -- The bundle arm. The primary is looked up by the SHARED receipt, which is what makes this a
  -- bundle rather than two unrelated rows: a row citing a receipt whose result names some other
  -- command's fact finds nothing here and is refused. PER COMMAND (#673 round 3): under a disagreement
  -- receipt the forward-on's `DecisionForward` pairs with the `countersign_rejection` request the receipt
  -- names; under a resolve receipt the `returned` bundle's request and re-homing forward pair with the
  -- `returned` resolution the receipt names — and the request must name the SAME revision the resolution
  -- disposed of (a request naming an earlier revision beside a resolution disposing of the current head
  -- is two immutable records of one act that disagree about which approval it ended). And the secondary's
  -- REASON must equal the primary's (#673 round 4): the request's and the forward's to the resolution's, the
  -- forward-on's forward's to the request's — one act states one reason, and a resolution recording reason
  -- A beside a request and a notice recording reason B is a register that cannot say why.
  v_primary_ok := CASE c."commandType"
    WHEN 'decisions.disagree' THEN EXISTS (
      SELECT 1 FROM "ChangeRequest" cr
       WHERE cr."projectId" = NEW."projectId" AND cr."id" = c."resultRef"
         AND cr."sourceCommandId" = NEW."sourceCommandId"
         AND cr."decisionId" = NEW."decisionId"
         AND cr."origin" = 'countersign_rejection'
         AND cr."reason" = (to_jsonb(NEW) ->> 'reason'))
    WHEN 'decisions.resolveStrandedCountersign' THEN EXISTS (
      SELECT 1 FROM "DecisionStrandedResolution" sr
       WHERE sr."projectId" = NEW."projectId" AND sr."id" = c."resultRef"
         AND sr."sourceCommandId" = NEW."sourceCommandId"
         AND sr."decisionId" = NEW."decisionId"
         AND sr."outcome" = 'returned'
         AND sr."reason" = (to_jsonb(NEW) ->> 'reason')
         AND (TG_TABLE_NAME <> 'ChangeRequest' OR sr."revisionId" = (to_jsonb(NEW) ->> 'revisionId')))
    ELSE FALSE
  END;

  IF NOT v_primary_ok THEN
    RAISE EXCEPTION
      'phase6 4d-i: the receipt cited by %.% names result %, which is neither this row nor the PRIMARY fact of its `%` bundle citing the same receipt for the same decision and stating the SAME reason (a disagreement''s `countersign_rejection` request; a resolve''s `returned` resolution — naming, for a request, the SAME revision the request cites) — a receipt for another result cannot be borrowed',
      TG_TABLE_NAME, NEW."id", COALESCE(c."resultRef", '<null>'), c."commandType";
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

-- ── 2c. the request pairing, re-issued to demand the rejection's audit row (#673 round 1) ──────
-- 4d-i-b's body, byte-identical but for the `countersign_rejection` arm's audit-row demand and the two
-- comments it retires (the four `ChangeRequest_t4d_paired` triggers stand as installed and are not
-- touched here).
CREATE OR REPLACE FUNCTION public.phase6_t4d_change_request_paired()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  d RECORD;
  v_event  TEXT;
  v_events BIGINT;
  v_audits BIGINT;
  v_births BIGINT;
  v_title  TEXT;
  v_cmd    TEXT;
  v_role   TEXT;
BEGIN
  IF NOT phase6_t4d_change_pairing_active() THEN RETURN NULL; END IF;   -- active once U3's flip flags the change keys (the gate U2 installed; the flip below makes it TRUE)

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
      -- ONE act, ONE actor (#590 round 4; Codex U3 round 1). A `standard` request carries a
      -- `change_requested` audit row, but 4d-i's `DecisionEvent_t4d_correspondence` binds the
      -- event's actor to the request's `requestedById` only when it is non-null (it SKIPS NULL,
      -- made total at 4d-iii), so a request opened with a NULL requester and a human-attributed
      -- event would commit with the opening bound to nobody. The request binds its own actor here,
      -- exactly as the `countersign_rejection` arm below does: exactly ONE same-transaction
      -- `decision.change_requested` attributed to `requestedById`, and that requester present.
      v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                   ARRAY['decision.change_requested'], NEW."requestedById");
      IF NEW."requestedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: standard change request % of decision % names % as its requester, and this transaction carries % `decision.change_requested` event(s) attributed to that person (`actorId`) — the opening is ONE act with ONE actor: the request records who asked and the event announces who did, and a request that names no requester, or whose event is attributed to someone else, is an opening the register cannot pin to a person',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedById", '<nobody>'), v_events;
      END IF;
    ELSIF NEW."origin" = 'countersign_rejection' THEN
      IF NOT phase6_t4d_decision_moved_in_tx(NEW."decisionId", 'change_from_awaiting') THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % was opened in this transaction, but no `awaiting_countersign → change` move of decision % was performed in it — the rejection request pairs with EXACTLY the disagreement''s transition (`Decision_t4d_disagreement_paired` demands the request when that move happens; this is its converse), and a decision that merely sits in `change` at commit, its `xmin` supplied by a no-op UPDATE, has not been disagreed with here',
          NEW."id", NEW."decisionId";
      END IF;
      -- 4d-ii-a / A8b (#673 round 1) — THE AUDIT ROW, as the plan's correspondence table states it
      -- for both producers (`awaiting_countersign → change` by disagreement: `change_requested`; by
      -- the `returned` resolution: `stranded_resolved` + `change_requested`): the delivered writers
      -- append it beside the request and the event, and a receipt-backed hand-run bundle that
      -- inserts a rejection request with its correctly claimed event and NO audit row would commit
      -- immutable evidence the decision log cannot show. Exactly one, as the `standard` arm demands.
      v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['change_requested']);
      IF v_audits <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % was opened in this transaction with % `change_requested` audit row(s) for decision % — the disagreement (reject-back, forward-on) and the `returned` resolution append the audit row beside the request and the event, and the register, the fact and the stream record the SAME act: a rejection with no audit row is a reopening the decision log cannot show, and one with two is an act registered twice',
          NEW."id", v_audits, NEW."decisionId";
      END IF;
      -- 4d-ii-a / A8b (#673 round 2) — THE EVENT NAMES THIS REQUEST AND ITS ORIGIN, AND THE FEED ROW IS
      -- BOUND TO IT: the kinded renderer renders the change-request notice from `payload.origin`
      -- (`countersign_rejection`), the title and the reason, so an event carrying no origin or another
      -- request's id leaves a notice the log cannot render; and the reopening owes the Decision Log
      -- its notice (the plan's correspondence table gives it to this origin alone).
      -- (#673 round 3) — AND THE CONTENT IT RENDERS: `payload.title` equal to the DECISION's title and
      -- `payload.reason` equal to THIS request's reason, both non-blank — the renderer renders solely from
      -- those two fields, so an absent one is a committed notice the log shows as nothing and a forged
      -- one is a reason shown in place of the immutable request's.
      SELECT dd."title" INTO v_title FROM "Decision" dd WHERE dd."projectId" = NEW."projectId" AND dd."id" = NEW."decisionId";
      IF btrim(coalesce(v_title, ''), E' \t\n\r\v\f') = '' OR btrim(coalesce(NEW."reason", ''), E' \t\n\r\v\f') = '' THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % carries a blank reason, or names a decision whose title is blank — the change-request notice renders the decision''s title and the request''s reason, and a reopening the log cannot state is refused',
          NEW."id", NEW."decisionId";
      END IF;
      SELECT count(*), max(e."eventId") INTO v_events, v_event FROM "DomainEvent" e
       WHERE e."projectId" = NEW."projectId" AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
         AND e."eventType" = 'decision.change_requested' AND e."xmin" = txid_current()::text::xid
         AND e."payload" @> jsonb_build_object('origin', 'countersign_rejection', 'requestId', NEW."id", 'title', v_title, 'reason', NEW."reason");
      IF v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % was opened in this transaction with % `decision.change_requested` event(s) naming it (`payload.requestId`), its origin (`payload.origin` = countersign_rejection), the decision''s title (`payload.title`) and its own reason (`payload.reason`) — the reopening announces THIS request exactly ONCE, and an event naming no origin, another request, another title or another reason is one the Decision Log renders as nothing or as words the request never carried',
          NEW."id", NEW."decisionId", v_events;
      END IF;
      IF platform_tx_notification(NEW."projectId", v_event) IS NULL OR NOT EXISTS (
           SELECT 1 FROM "Notification" n
            WHERE n."projectId" = NEW."projectId" AND n."eventId" = v_event AND n."decisionId" = NEW."decisionId"
              AND n."kind" = 'decision.change_requested' AND n."xmin" = txid_current()::text::xid) THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % was opened in this transaction with 0 bound notice(s) of kind `decision.change_requested` on its event — the rejection (reject-back, forward-on, the `returned` resolution) owes the Decision Log its change-request notice (`Notification.eventId`/`kind` bound to the event, written in the same transaction), and a reopening with no feed row is one the log cannot show',
          NEW."id", NEW."decisionId";
      END IF;
      -- ONE act, ONE actor (#590 round 4). The request binds its own actor (and does it for the
      -- `returned` resolution's request too: the PMC who returned the decision is the requester that
      -- request records); with A8b's audit row 4d-i's `DecisionEvent_t4d_correspondence` binds the
      -- same pair through the register as well.
      v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                   ARRAY['decision.change_requested'], NEW."requestedById");
      IF NEW."requestedById" IS NULL OR v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % of decision % names % as its requester, and this transaction carries % `decision.change_requested` event(s) attributed to that person (`actorId`) — the disagreement is ONE act with ONE actor: the request records who disagreed and the event announces who did, and two immutable records that disagree about who reopened the decision leave a register that cannot say',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedById", '<nobody>'), v_events;
      END IF;
      -- 4d-ii-a / A8b (#673 round 5) — THE PRODUCER'S AUTHORITY AND THE FROZEN PAIR. The arm above binds
      -- the event to the requester's ID and nothing else, so a receipt-backed `decisions.disagree` bundle
      -- run by an active CLIENT with a truthful `client` pair could reopen an awaiting decision with no
      -- architect. A rejection request has exactly two producers and no receipt-less one: it cites its
      -- receipt; its frozen role is the producer's — `architect` under the disagreement, `pmc` under the
      -- stranded resolution; its frozen pair is present; and exactly one event carries that pair as its
      -- envelope beside the actor id (4d-i's envelope-truth seal judges the envelope against the actor's
      -- real standing, so a request whose pair the actor does not hold is refused there).
      SELECT ce."commandType" INTO v_cmd FROM "CommandExecution" ce
       WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId";
      IF NEW."sourceCommandId" IS NULL OR v_cmd IS NULL OR v_cmd NOT IN ('decisions.disagree', 'decisions.resolveStrandedCountersign') THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % cites no receipt of one of its two producers (found `%`) — the rejection is opened by the architect''s `decisions.disagree` or the PMC''s `decisions.resolveStrandedCountersign` and by nothing else, and a request with no receipt is a reopening nobody performed',
          NEW."id", NEW."decisionId", COALESCE(v_cmd, '<none>');
      END IF;
      v_role := CASE v_cmd WHEN 'decisions.disagree' THEN 'architect' ELSE 'pmc' END;
      IF NEW."requestedByRole" IS DISTINCT FROM v_role OR NEW."requestedByName" IS NULL THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % freezes the requester as `%` / `%` under a `%` receipt, whose producer acts as `%` — a `decisions.disagree` receipt is the architect''s and a `decisions.resolveStrandedCountersign` receipt is the PMC''s; a rejection frozen under another role, or under none, is a reopening by someone the plan gives no such act',
          NEW."id", NEW."decisionId", COALESCE(NEW."requestedByRole", '<null>'), COALESCE(NEW."requestedByName", '<null>'), v_cmd, v_role;
      END IF;
      SELECT count(*) INTO v_events FROM "DomainEvent" e
       WHERE e."projectId" = NEW."projectId" AND e."entityType" = 'Decision' AND e."entityId" = NEW."decisionId"
         AND e."eventType" = 'decision.change_requested' AND e."xmin" = txid_current()::text::xid
         AND e."actorId" = NEW."requestedById"
         AND e."actorRole" = NEW."requestedByRole" AND e."actorName" = NEW."requestedByName";
      IF v_events <> 1 THEN
        RAISE EXCEPTION
          'phase6 4d-ii-a A8b: countersign_rejection request % of decision % freezes its requester as % / `%`, and this transaction carries % `decision.change_requested` event(s) whose envelope (`actorId`, `actorRole`, `actorName`) is that pair — the request''s frozen pair and the event''s envelope are one attribution seen twice, and an envelope naming another role or name than the request froze is a reopening misattributed',
          NEW."id", NEW."decisionId", NEW."requestedByName", NEW."requestedByRole", v_events;
      END IF;
    END IF;

    v_events := platform_tx_event_count(NEW."projectId", 'Decision', NEW."decisionId",
                                        ARRAY['decision.change_requested']);
    IF v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: change request % was opened in this transaction with % `decision.change_requested` event(s) for decision % — the act that opens a request announces it exactly ONCE, in the same transaction; a request with no event is an act nobody can see, and one with two is an act recorded twice',
        NEW."id", v_events, NEW."decisionId";
    END IF;

    -- the `returned` stranded resolution's bundle: the resolution is the primary fact and the
    -- claimant; this request verifies only. Decided at commit, where the whole bundle is visible.
    -- The immediate half claims a rejection request's event when no resolution is visible yet, so
    -- the one order it cannot judge — event, request, THEN resolution — arrives here with the
    -- request holding a claim the resolution owns, and is refused by name (#590 round 3): the
    -- returned bundle writes its resolution before its request, or its event after both.
    IF NEW."origin" = 'countersign_rejection' AND EXISTS (
         SELECT 1 FROM "DecisionStrandedResolution" s
          WHERE s."projectId" = NEW."projectId" AND s."decisionId" = NEW."decisionId"
            AND s."outcome" = 'returned' AND s."xmin" = txid_current()::text::xid) THEN
      IF EXISTS (SELECT 1 FROM "DomainEventPairingClaim" k
                  WHERE k."projectId" = NEW."projectId" AND k."claimedBy" = 'ChangeRequest' AND k."claimedById" = NEW."id") THEN
        RAISE EXCEPTION
          'phase6 4d-i-b: countersign_rejection request % of decision % claimed its `decision.change_requested` event, but this transaction also carries a `returned` DecisionStrandedResolution for the decision — in the returned bundle the RESOLUTION is the branch''s primary fact and its claimant (§A.3), and the request verifies only. The request claimed because the event was already written when it was inserted and no resolution was visible yet: write the resolution before the request, or the event after both',
          NEW."id", NEW."decisionId";
      END IF;
      RETURN NULL;
    END IF;

    v_event := platform_tx_event(NEW."projectId", 'Decision', NEW."decisionId",
                                 ARRAY['decision.change_requested']);
    PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'ChangeRequest', NEW."id");
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
    v_event := platform_tx_event(NEW."projectId", 'Decision', NEW."decisionId",
                                 ARRAY['decision.change_withdrawn']);
    PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'ChangeRequest', NEW."id");
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
     OR position('receiptThisTx' in v_src) = 0
     OR position('v_primary_table IS DISTINCT FROM TG_TABLE_NAME' in v_src) = 0
     OR position('WHEN ''decisions.resolveStrandedCountersign'' THEN ''DecisionStrandedResolution''' in v_src) = 0
     OR position('sr."outcome" = ''returned''' in v_src) = 0
     OR position('sr."revisionId" = (to_jsonb(NEW) ->> ''revisionId'')' in v_src) = 0
     OR position('sr."reason" = (to_jsonb(NEW) ->> ''reason'')' in v_src) = 0
     OR position('cr."reason" = (to_jsonb(NEW) ->> ''reason'')' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the provenance seal does not carry the returned request''s second producer, the receipt''s primary table and the per-command bundle arm beside 4d-i''s own clauses after this file ran. The deploy is refused.';
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
  SELECT count(*) INTO n FROM pg_proc p
   WHERE p.proname IN ('phase6_t4d_countersign_claims_event', 'phase6_t4d_stranded_claims_event', 'phase6_t4d_change_request_paired')
     AND position('platform_tx_notification' in p.prosrc) > 0;
  IF n <> 3 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the two claimants and the request arm do not demand the bound notice (found % of 3). The deploy is refused.', n;
  END IF;
  SELECT count(*) INTO n FROM pg_proc p
   WHERE (p.proname = 'phase6_t4d_countersign_claims_event' AND position('''finalization'', ''countersign''' in p.prosrc) > 0)
      OR (p.proname = 'phase6_t4d_stranded_claims_event' AND position('''finalization'', ''stranded_completed''' in p.prosrc) > 0 AND position('''outcome'', ''returned''' in p.prosrc) > 0);
  IF n <> 2 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the finalizer claimants do not bind the payload discriminator to the fact (found % of 2). The deploy is refused.', n;
  END IF;
  SELECT count(*) INTO n FROM pg_proc p
   WHERE (p.proname IN ('phase6_t4d_countersign_claims_event', 'phase6_t4d_stranded_claims_event')
            AND position('''title'', v_title, ''deciderKind'', v_kind' in p.prosrc) > 0 AND position('d."deciderKind"::text' in p.prosrc) > 0
            AND position('btrim(coalesce(v_title, ''''), E'' \t\n\r\v\f'')' in p.prosrc) > 0
            AND position('''approverName'', v_appr_name, ''approverRole'', v_appr_role, ''approvedFrom'', v_from' in p.prosrc) > 0)
      OR (p.proname = 'phase6_t4d_change_request_paired'
            AND position('''title'', v_title, ''reason'', NEW."reason"' in p.prosrc) > 0 AND position('btrim(coalesce(NEW."reason", ''''), E'' \t\n\r\v\f'')' in p.prosrc) > 0
            AND position('WHEN ''decisions.disagree'' THEN ''architect'' ELSE ''pmc''' in p.prosrc) > 0
            AND position('e."actorRole" = NEW."requestedByRole" AND e."actorName" = NEW."requestedByName"' in p.prosrc) > 0);
  IF n <> 3 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the two claimants and the request arm do not bind the content the renderer reads, the revision''s approver pair and the producer''s authority to the rows (found % of 3). The deploy is refused.', n;
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'phase6_t4d_change_request_paired';
  IF v_src IS NULL OR position('countersign_rejection request % was opened in this transaction with % `change_requested` audit row(s)' in v_src) = 0
     OR position('change_from_awaiting' in v_src) = 0 OR position('platform_claim_event_pairing_once' in v_src) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the request pairing does not demand the rejection''s audit row beside 4d-i-b''s own clauses after this file ran. The deploy is refused.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND p.proname = 'phase6_t4d_change_request_paired'
     AND c.relname = 'ChangeRequest' AND t.tgname = 'ChangeRequest_t4d_paired' AND t.tgdeferrable AND t.tginitdeferred;
  IF n <> 1 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8b: the request pairing trigger is not standing deferred on the re-issued body (found %). The deploy is refused.', n;
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
