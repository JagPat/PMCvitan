-- Phase 6 unit 4c-ii — the approval register becomes PROVABLE
-- (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md §A, review rounds 27–29).
--
-- 4c makes `DecisionApprovalRevision`'s COUNT trusted cycle evidence: a consultation freezes the
-- count at request time, and both the respond command and the response INSERT seal require the
-- decision's CURRENT count to still equal it. The delivered
-- `DecisionApprovalRevision_no_withdrawn` trigger asserts only that the decision is not withdrawn
-- — no approval transition, no matching event, no correspondence to a status change. So a direct
-- writer could insert a syntactically valid revision against a live `pending` decision, advance
-- the count past every open consultation, and thereby DENY a fact the workflow promises to keep
-- answerable: those responses 409 permanently and their `consultation_requested` deliveries
-- cancel themselves at the claim predicate. Reached without touching a consultation table.
--
-- WHY THIS LANDS HERE AND NOT IN 4c-i. 4c-i is the DARK migration the still-serving previous
-- release must keep running against, and that release's `approve` writes no receipt: installing
-- this requirement there would have rejected every approval a 4b instance performed — a live
-- workflow broken by a migration whose whole premise is that nothing else changes. 4c-ii runs
-- AFTER the drain-first cutover (§A: the external-effect reseal requires ZERO old instances), at
-- the one moment the plan already guarantees no old writer exists.
--
-- WHY THE CHECK IS AT COMMIT AND NOT AT INSERT (round 29). The obvious test — "the receipt exists
-- and is reserved" — is not enough, and the gap is in the delivered receipt protocol's own shape:
-- it permits a `reserved` INSERT and validates completion only if an UPDATE occurs. So an
-- alternate writer could insert a reserved `decisions.approve` receipt and a revision citing it
-- in ONE transaction and commit — never approving the decision, never completing the receipt —
-- and the count would advance anyway. A DEFERRABLE INITIALLY DEFERRED constraint trigger closes
-- it because the completion must exist AT COMMIT, which is exactly when `executeCommand` writes
-- its succeeded receipt.
--
-- WHY NOT AN `xmin` TEST ON THE DECISION ROW (round 28, correcting round 27's own remedy). That
-- proves only that the row was UPDATED in this transaction, which is a different claim: against
-- an ALREADY-approved decision a direct writer can issue a NO-OP `UPDATE`, giving the tuple the
-- current transaction's `xmin`, and then insert an arbitrary revision — status check passes,
-- same-transaction check passes, and the forged revision is exactly what downstream provenance
-- would trust. The correspondence has to be to the TRANSITION, which only the approval command
-- performs.
--
-- WHAT REMAINS, stated so it is checkable rather than implied: forging a revision now requires
-- forging a COMPLETED command receipt naming this decision. That is the command ledger's own
-- discipline — `20270425000000_platform_command_receipt_seal` refuses a receipt minted already
-- terminal, freezes `actorId`/`commandType`/`idempotencyKey`/`requestHash`/`createdAt`/`id` and
-- the scope columns, makes a completed receipt immutable in outcome and result, and requires the
-- completing UPDATE to come from the SAME transaction that inserted the row. What its own header
-- documents as remaining, and 4c neither widens nor re-litigates, is a deliberate multi-statement
-- forgery inside ONE transaction by a role holding INSERT/UPDATE on the ledger, whose answer is a
-- privilege grant (`docs/RUNBOOK.md §CMDR`) rather than another trigger.
--
-- NO BACKFILL AND NO ABORT. Legacy revisions carry a NULL `sourceCommandId` by design — 4c-i
-- staged the column nullable precisely so they could — and this is a BEFORE-INSERT-scoped
-- constraint trigger, so it judges only rows written from here on. Inventing provenance for a
-- historical approval would be a forgery of exactly the kind this seal exists to refuse.
--
-- Every statement is retry-safe (the 20271015/20271101 discipline).

CREATE OR REPLACE FUNCTION phase6_t4c_approval_revision_provenance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  IF NEW."sourceCommandId" IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % carries no source command — a revision is the product of an approval COMMAND, and its count is the cycle every open consultation is bound to', NEW."id";
  END IF;

  SELECT "projectId", "commandType", "status", "resultRef" INTO c
    FROM "CommandExecution" WHERE "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."projectId" IS DISTINCT FROM NEW."projectId" THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % cites command %, which is not a receipt of this project', NEW."id", NEW."sourceCommandId";
  END IF;
  IF c."commandType" <> 'decisions.approve' THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % cites a % receipt — only an approval command produces an approval revision', NEW."id", c."commandType";
  END IF;
  -- the arm an INSERT-time check cannot reach: the receipt must have SUCCEEDED by commit
  IF c."status" <> 'succeeded' THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % cites command %, which is % at commit — a revision whose command never completed records an approval that never happened', NEW."id", NEW."sourceCommandId", c."status";
  END IF;
  -- …and its result must be THIS decision, so a receipt for some other command cannot be borrowed
  IF c."resultRef" IS DISTINCT FROM NEW."decisionId" THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % cites command %, whose result is % — not the decision % it claims to have approved', NEW."id", NEW."sourceCommandId", COALESCE(c."resultRef", '<null>'), NEW."decisionId";
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4c_provenance" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4c_provenance"
  AFTER INSERT ON "DecisionApprovalRevision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_approval_revision_provenance();
