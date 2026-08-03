-- Platform kernel — SEAL THE COMMAND RECEIPT PROTOCOL.
--
-- `src/platform/commands.ts` documents the protocol in its opening comment: a command RESERVES a
-- ledger row, runs, and flips that row to `succeeded` with its `resultRef` — all in ONE
-- transaction. Phase 2 gave the table its tenancy FKs, its scope truth table, its status
-- vocabulary CHECK and its scope-specific partial unique indexes. What it never gave the table is
-- the PROTOCOL: nothing stopped a row being INSERTED already `succeeded`, or a completed receipt
-- being rewritten to point at a different result.
--
-- That was invisible while the ledger was only an idempotency record — a forged receipt would at
-- worst suppress a replay. It stopped being invisible the moment receipts became PROVENANCE.
-- Fifteen `sourceCommandId` columns now reference this table to answer "which command produced
-- this fact": the Phase-3 stock ledger (§C rule ii), the Phase-4 labour facts, and the Phase-5
-- commercial documents. Every one of those seals is exactly as strong as the receipt behind it.
--
-- The finding that surfaced it is Phase 5 Task 5A's: `verified` on a vendor bill requires a
-- MATCHED §E verdict whose `sourceCommandId` names a SUCCEEDED `commercial.bill.verify` execution
-- with `resultRef` equal to that verdict. Sound — until you notice that a maintenance path could
-- simply INSERT such a receipt, already succeeded, already pointing at a hand-written verdict.
-- The seal rested on a table that sealed nothing. Sealing it there would have been the same
-- mistake one level up, so it is sealed HERE, once, for every fact that cites a command.
--
-- **This enforces the protocol the code already follows, so no runtime change accompanies it.**
-- `executeCommand` has exactly two writers — the `reserved` insert and the completing update —
-- and there is no raw SQL, no second creator and no delete path anywhere in the API. A probe
-- drives a real command end to end to prove that, rather than asserting it in a comment.

CREATE OR REPLACE FUNCTION platform_command_receipt_protocol() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A receipt is a record that a command RAN. Minting one already terminal records a command
    -- that never did, which is the whole forgery: a `succeeded` row with a chosen `resultRef` is
    -- provenance for anything the forger likes.
    IF NEW."status" <> 'reserved' THEN
      RAISE EXCEPTION 'A command receipt is INSERTED as `reserved` and becomes terminal only by COMPLETING — inserting a `%` receipt records a command that never ran, and every fact citing it would inherit that lie (%)', NEW."status", NEW."id";
    END IF;
    IF NEW."resultRef" IS NOT NULL OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A command receipt carries no result and no completion time before it has run (%)', NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  -- Identity is WHO did WHAT, under WHICH key, over WHICH request. The replay lookup and every
  -- provenance join read these columns, so a rewritable identity would let a receipt be
  -- re-pointed at a different actor or command type after the fact.
  IF NEW."id" <> OLD."id"
     OR NEW."scopeKind" <> OLD."scopeKind"
     OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."actorId" <> OLD."actorId"
     OR NEW."commandType" <> OLD."commandType"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A command receipt''s identity is FROZEN — who acted, which command, under which idempotency key, over which request (%)', OLD."id";
  END IF;

  IF OLD."status" <> 'reserved' THEN
    -- Terminal is terminal. A `succeeded` receipt whose `resultRef` can be re-pointed is a
    -- provenance chain that can be re-pointed, which is the same defect as forging the row.
    IF NEW."status" <> OLD."status"
       OR NEW."resultRef" IS DISTINCT FROM OLD."resultRef"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
      RAISE EXCEPTION 'A COMPLETED command receipt is immutable — its outcome and its result are what the facts citing it rest on (%)', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- `reserved` completes exactly once, in one direction. `failed` is in the Phase-2 status
  -- vocabulary and no code path writes it today; the arrow stays open because the vocabulary is
  -- a cleared decision and a rollback records a real outcome, but a failed command PRODUCED
  -- nothing, so it may not carry a result.
  IF NEW."status" NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'A reserved command receipt completes as `succeeded` or `failed` — it never returns to `%` (%)', NEW."status", OLD."id";
  END IF;
  IF NEW."completedAt" IS NULL THEN
    RAISE EXCEPTION 'A completing command receipt records WHEN it completed (%)', OLD."id";
  END IF;
  IF NEW."status" = 'failed' AND NEW."resultRef" IS NOT NULL THEN
    RAISE EXCEPTION 'A FAILED command produced no result — a result reference on it would be provenance for something that did not happen (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CommandExecution_receipt_protocol" ON "CommandExecution";
CREATE TRIGGER "CommandExecution_receipt_protocol"
  BEFORE INSERT OR UPDATE ON "CommandExecution"
  FOR EACH ROW EXECUTE FUNCTION platform_command_receipt_protocol();

-- ── what is deliberately NOT sealed, and why ───────────────────────────────────────────────────
--
-- DELETE stays permitted. Phase 2 decided in as many words that receipts are "disposable
-- idempotency records, not an immutable audit trail", and gave both tenant FKs ON DELETE CASCADE
-- so a hard org or project delete takes its receipts with it. Banning DELETE here would
-- contradict a cleared decision and break that cascade. It also would not buy anything: deleting
-- a receipt cannot forge provenance, it can only remove it, and every provenance join then finds
-- nothing and FAILS CLOSED. Where a fact must outlive its receipt the fact says so itself — a
-- `BillVerification`, a `StockTransaction` and every other citing row holds an ON DELETE NO
-- ACTION composite FK, so PostgreSQL already refuses to delete a receipt something rests on.
--
-- ── legacy rows ────────────────────────────────────────────────────────────────────────────────
--
-- This migration is additive and constrains TRANSITIONS and INSERTS from now on; it neither reads
-- nor rewrites an existing row, so a legacy database upgrades untouched. Two incoherent shapes
-- would nevertheless be worth an operator's attention, because `executeCommand` cannot produce
-- either and their presence means something else wrote the ledger. They are REPORTED rather than
-- aborted on, deliberately: the new invariant is about what happens next, and neither shape can
-- satisfy a provenance seal falsely (§E's join requires `status = 'succeeded'` AND a `resultRef`
-- that equals the citing row's id). Aborting an upgrade over data no seal depends on would be
-- strictness for its own sake.
DO $$
DECLARE v_no_completed bigint; v_failed_with_result bigint;
BEGIN
  SELECT COUNT(*) INTO v_no_completed
    FROM "CommandExecution" WHERE "status" <> 'reserved' AND "completedAt" IS NULL;
  SELECT COUNT(*) INTO v_failed_with_result
    FROM "CommandExecution" WHERE "status" = 'failed' AND "resultRef" IS NOT NULL;
  IF v_no_completed <> 0 OR v_failed_with_result <> 0 THEN
    RAISE NOTICE 'platform_command_receipt_seal: % terminal receipt(s) with no completion time and % failed receipt(s) carrying a result predate this seal. They are left exactly as they are — no provenance seal can rest on either — but they were not written by executeCommand.', v_no_completed, v_failed_with_result;
  END IF;
END $$;
