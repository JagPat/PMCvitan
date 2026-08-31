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
-- NO BACKFILL. Legacy revisions carry a NULL `sourceCommandId` by design — 4c-i staged the column
-- nullable precisely so they could — and this is an INSERT-scoped constraint trigger, so it judges
-- only rows written from here on. Inventing provenance for a historical approval would be a
-- forgery of exactly the kind this seal exists to refuse. (The ONE-USE section below does abort,
-- diagnostically, on a state no database can currently be in; it never edits or fabricates a row.)
--
-- Every statement is retry-safe (the 20271015/20271101 discipline).

-- ---------------------------------------------------------------------------
-- THE SEAL WATERMARK: every approval receipt that already existed is already SPENT.
--
-- Review finding (round 31). The one-use index below is PARTIAL on `"sourceCommandId" IS NOT NULL`,
-- because legacy revisions carry NULL by design and a total unique would make every existing
-- database unmigratable. The consequence, which the partiality hides: a keyed approval completed
-- BEFORE this seal has a `succeeded` `decisions.approve` receipt whose `resultRef` names its
-- decision, while its own revision carries NULL — so that receipt has never consumed its
-- uniqueness slot. Every predicate the trigger tests still passes for it. A direct writer could
-- therefore spend a HISTORICAL receipt once on a new revision, advance the frozen cycle, and deny
-- an open consultation permanently: precisely the denial this seal exists to refuse, reached
-- through the seal's own backward-compatibility allowance.
--
-- The fix is NOT to backfill `sourceCommandId` onto legacy revisions. Choosing which historical
-- receipt "belongs" to which legacy revision is inventing provenance, which is the forgery this
-- file refuses to commit on a writer's behalf and must equally refuse to commit on its own.
--
-- Instead the install instant is RECORDED, and a receipt created at or before it is not available
-- to back a new revision — because it already backed an approval that happened. That is a
-- statement about the past which is simply true, and needs no guess about which approval.
--
-- `ON CONFLICT DO NOTHING` keeps the ORIGINAL instant across a re-run: a retry must not move the
-- watermark forward and thereby release receipts minted between the two attempts.
CREATE TABLE IF NOT EXISTS "Phase6ApprovalSealWatermark" (
  "id"       BOOLEAN PRIMARY KEY DEFAULT TRUE,
  "sealedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "Phase6ApprovalSealWatermark_singleton" CHECK ("id")
);
INSERT INTO "Phase6ApprovalSealWatermark" ("id", "sealedAt") VALUES (TRUE, now())
ON CONFLICT ("id") DO NOTHING;

CREATE OR REPLACE FUNCTION phase6_t4c_approval_revision_provenance() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; wm TIMESTAMPTZ;
BEGIN
  IF NEW."sourceCommandId" IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % carries no source command — a revision is the product of an approval COMMAND, and its count is the cycle every open consultation is bound to', NEW."id";
  END IF;

  SELECT "projectId", "commandType", "status", "resultRef", "createdAt" INTO c
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
  -- …and it must post-date this seal. A receipt that already existed when the seal was installed
  -- backed an approval that has already happened; the one-use index cannot see that, because the
  -- revision it backed carries the NULL provenance legacy rows are entitled to.
  SELECT "sealedAt" INTO wm FROM "Phase6ApprovalSealWatermark" WHERE "id";
  IF wm IS NOT NULL AND c."createdAt" <= wm THEN
    RAISE EXCEPTION 'phase6-4c: approval revision % cites command %, a receipt that already existed when this seal was installed — it backed an approval that has already happened, and a receipt records exactly ONE approval', NEW."id", NEW."sourceCommandId";
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4c_provenance" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4c_provenance"
  AFTER INSERT ON "DecisionApprovalRevision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_approval_revision_provenance();

-- ---------------------------------------------------------------------------
-- ONE-USE: a completed approval receipt backs AT MOST ONE revision.
--
-- Review finding F1 on head d117f140. The trigger above proves that the cited receipt exists,
-- belongs to this project, is a SUCCEEDED `decisions.approve`, and names THIS decision — and every
-- one of those predicates stays true no matter how many times the same receipt is cited. So a
-- direct writer holding one genuine approval receipt could mint arbitrarily many revisions from
-- it, advancing the count exactly as the forged-revision path this migration exists to close does:
-- open consultations bound to the frozen cycle 409 permanently, and their deliveries cancel
-- themselves at the claim predicate. The receipt has to be SPENT, not merely valid.
--
-- The two consultation facts already carry precisely this shape
-- (`DecisionConsultation_source_command_key`, `DecisionConsultationResponse_source_command_key` in
-- 20271101000000) — the approval register is the one provenance seal of the unit that lacked it.
--
-- PARTIAL, on `"sourceCommandId" IS NOT NULL`. PostgreSQL treats NULLs as distinct in a unique
-- index, so a plain UNIQUE would already admit every legacy revision; the predicate says that in
-- the index definition rather than relying on the reader knowing it, and keeps the index off the
-- historical rows entirely. Legacy provenance is still NEVER invented — 4c-i staged the column
-- nullable so approvals performed by a pre-4c release keep their honest NULL.
--
-- Diagnostic-first: a bare `CREATE UNIQUE INDEX` over pre-existing duplicates fails with
-- PostgreSQL's own opaque "could not create unique index" (the §F3.1 defect the platform t45
-- correction was raised for), so the offending receipts are NAMED first. No database can be in
-- that state today — nothing has ever written a non-NULL `sourceCommandId`, because 4c-i is dark
-- and this unit's `approve` is the first writer — but the abort is what makes that claim
-- CHECKED rather than asserted, and it is what an operator would need if it were ever false.
DO $$
DECLARE n BIGINT; sample TEXT;
BEGIN
  -- the count is over EVERY offending receipt; the sample is bounded separately, so an operator
  -- is told the true scale and shown the first twenty rather than being told there are twenty
  WITH offenders AS (
    SELECT "projectId" || '/' || "sourceCommandId" AS pair
      FROM "DecisionApprovalRevision"
     WHERE "sourceCommandId" IS NOT NULL
     GROUP BY "projectId", "sourceCommandId"
    HAVING COUNT(*) > 1
  )
  SELECT (SELECT COUNT(*) FROM offenders),
         (SELECT string_agg(pair, ', ' ORDER BY pair) FROM (SELECT pair FROM offenders ORDER BY pair LIMIT 20) s)
    INTO n, sample;
  IF COALESCE(n, 0) > 0 THEN
    RAISE EXCEPTION 'phase6-4c F1: % approval command receipt(s) already back more than one revision (first 20 — project/command: %). A receipt records ONE approval; repair the register before deploying — see docs/RUNBOOK.md §P6-4C.', n, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "DecisionApprovalRevision_source_command_key"
  ON "DecisionApprovalRevision"("projectId", "sourceCommandId")
  WHERE "sourceCommandId" IS NOT NULL;
