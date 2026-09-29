-- Phase 6 task 4d unit 4d-ii-a / A7a — THE GREEN EVENT NAMES ITS REVISION (#665's review round 1,
-- the P1 finding "Bind approval revisions to the event's decision").
--
-- A7a stamps the decisions notice writers: every notice is bound to the event that announced its
-- act, and the green approved notice is RENDERED from the event's frozen actor envelope and the
-- revision the event names in `payload.revisionId` — the exact revision the act wrote, never the
-- head (the plan's §A.3 P2 correction: "every 4d-ii emitter of `decision.approved`/`reapproved`
-- carries the EXACT finalized `revisionId` in the payload; the correspondence binds it to the paired
-- fact's revision"). 4d-i-b U3's claimant (`phase6_t4d_revision_claims_approval`) binds the
-- approval-family event to a same-transaction finalized head of the same decision by type, entity
-- and actor — and never read the payload. So a receipt-backed direct bundle could write a valid
-- head, audit row and event whose `revisionId` named ANOTHER decision's revision in the project, or
-- an older revision of this decision, and the feed would render that revision's option and on-behalf
-- fact under this decision's title.
--
-- WHAT THIS FILE INSTALLS: the claimant's body RE-ISSUED (CREATE OR REPLACE, the same two triggers
-- `DecisionApprovalRevision_t4d_claim` / `_claim_deferred` unchanged) with one more arm: the event
-- the head claims must, when its payload names a revision, name THIS head. Absent, it is admitted
-- (the drain: a still-serving previous-release process emits the family without `revisionId`; the
-- reader renders no green notice from it, so nothing is forged, and 4d-iii is where the field
-- becomes required). Idempotent and re-runnable (on `ALWAYS_EXECUTE`): a replay of U3's file
-- re-issues the older body, and this later file re-issues this one, so the ledger order is what
-- stands — the A4a precedent (`20271227000000`), pinned by `upgrade-proof.sh`'s ledger-lost replay.
-- No table, column, trigger or index changes; no data moves.

CREATE OR REPLACE FUNCTION phase6_t4d_revision_claims_approval() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event TEXT; v_events BIGINT; v_audits BIGINT; v_named TEXT;
BEGIN
  IF NEW."finalized" IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;
  IF TG_NAME LIKE '%\_deferred' THEN
    -- ONE act, ONE actor (#590 round 4; Codex U3 round 1). The finalized head carries a
    -- `DecisionEvent` audit row, but 4d-i's `DecisionEvent_t4d_correspondence` binds the event's
    -- actor to the fact ONLY when the fact names one — it SKIPS a NULL `approvedById` (made total
    -- only at 4d-iii) — so a finalized head born with a NULL approver and a human-attributed event
    -- would commit with the announcement bound to nobody. The claimant binds it here, as the
    -- consultation and countersign_rejection arms bind theirs: exactly ONE approval-family event
    -- attributed to the approver the head records (`approvedById`), and that approver present.
    v_events := phase6_t4d_tx_actor_event_count(NEW."projectId", NEW."decisionId",
                                                ARRAY['decision.approved', 'decision.reapproved'], NEW."approvedById");
    IF NEW."approvedById" IS NULL OR v_events <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: approval revision % of decision % was born finalized in this transaction naming % as its approver, and this transaction carries % approval-family event(s) (`decision.approved` / `decision.reapproved`) attributed to that person (`actorId`) — the finalized head IS the approval and announces itself exactly ONCE, in the same transaction, in the name of the approver it records: a head with no such event is an approval the stream never carried, one with two is an act announced twice, and one whose head names no approver (or whose event is attributed to someone else) is an approval the register cannot pin to a person',
        NEW."id", NEW."decisionId", COALESCE(NEW."approvedById", '<nobody>'), v_events;
    END IF;
    v_audits := phase6_t4d_tx_audit_count(NEW."decisionId", ARRAY['approved', 'reapproved']);
    IF v_audits <> 1 THEN
      RAISE EXCEPTION
        'phase6 4d-i-b: approval revision % of decision % was born finalized in this transaction with % `approved` / `reapproved` audit row(s) — the delivered `approve` appends the audit row beside the head and the event, and the register, the fact and the stream record the SAME act: a head with no audit row is an approval the decision log cannot show',
        NEW."id", NEW."decisionId", v_audits;
    END IF;
  END IF;
  v_event := phase6_t4d_tx_actor_event(NEW."projectId", NEW."decisionId",
                                       ARRAY['decision.approved', 'decision.reapproved'], NEW."approvedById");
  IF v_event IS NULL THEN RETURN NULL; END IF;   -- the immediate half, before the event (or a NULL approver): the deferred half decides
  -- 4d-ii-a / A7a — THE EVENT NAMES THIS REVISION (#665's review round 1, the P1 finding). From A7a
  -- the direct approve's `decision.approved` / `decision.reapproved` payload carries `revisionId`,
  -- the exact revision the act wrote, and the kinded green notice renders its approver facts (the
  -- option, the on-behalf fact) from the revision the event names. The claims above bind the event
  -- to a same-transaction finalized head of THIS decision by type, entity and actor, but the payload
  -- is a JSON field no seal read: a receipt-backed bundle could write a valid head, audit row and
  -- event whose `revisionId` named ANOTHER decision's revision (or an older one of this decision),
  -- and the feed would render that revision's option under this decision's title. So the named
  -- revision must be the head this transaction is claiming for. ABSENT, it is admitted: a
  -- still-serving previous-release process emits the family with no `revisionId` through the drain
  -- (the plan's fallback to the same-transaction head, made required at 4d-iii), and the reader
  -- renders no green notice from an event that names none — an omission, never a forged fact.
  SELECT e."payload" ->> 'revisionId' INTO v_named
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId" AND e."eventId" = v_event;
  IF v_named IS NOT NULL AND v_named IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A7a: approval event % of decision % names revision `%` as the one its act wrote, but the finalized head born in this transaction is % — the green notice renders the approver facts from the revision the event names, so an event naming any other revision (another decision''s, or an older one of this decision) announces facts this act did not produce',
      v_event, NEW."decisionId", v_named, NEW."id";
  END IF;
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, 'DecisionApprovalRevision', NEW."id");
  RETURN NULL;
END $$;

-- ── FAIL CLOSED ON ITS OWN INSTALLATION ─────────────────────────────────────────────────────────
-- A deploy that reported success with the older body still standing would leave the green notice
-- renderable from a revision the act never wrote. The body must carry the arm, and both halves of
-- the claimant must stand on it, enabled, unqualified.
DO $verify$
DECLARE n integer; v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'phase6_t4d_revision_claims_approval';
  IF v_src IS NULL OR position('names revision' in v_src) = 0 OR position('''revisionId''' in v_src) = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A7a: the revision claimant does not carry the revision-naming arm after this file ran. The deploy is refused rather than serving a green notice from a revision its act never wrote.';
  END IF;
  SELECT count(*) INTO n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE ns.nspname = 'public' AND c.relname = 'DecisionApprovalRevision'
     AND p.proname = 'phase6_t4d_revision_claims_approval'
     AND ((t.tgname = 'DecisionApprovalRevision_t4d_claim' AND t.tgtype = 5)                                      -- ROW(1) + AFTER + INSERT(4)
       OR (t.tgname = 'DecisionApprovalRevision_t4d_claim_deferred' AND t.tgtype = 5 AND t.tgdeferrable AND t.tginitdeferred))
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgqual IS NULL
     AND t.tgattr = ''::int2vector
     AND p.proconfig IS NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A7a: the revision claimant does not stand on both of its triggers (found % of 2). The deploy is refused.', n;
  END IF;
END
$verify$;
