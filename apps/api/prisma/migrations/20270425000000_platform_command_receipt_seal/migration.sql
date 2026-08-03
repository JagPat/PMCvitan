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
-- ── WHAT THIS CLOSES, AND WHAT IT DOES NOT ─────────────────────────────────────────────────────
--
-- Stated plainly, because the first head of this migration overclaimed and the review was right to
-- say so. **No database trigger can distinguish "the application ran" from "SQL that reproduced
-- what the application would have written."** An operator with write access to this table can
-- always perform the protocol by hand — reserve, then complete, in one transaction — and nothing
-- here prevents that. The same is true of every trigger-based seal in this repository; it is the
-- trust boundary those seals have always had, and it is written down here because this is the
-- table the others rest on.
--
-- What the seal DOES do is make the protocol's shape the ONLY representable shape:
--
--   * a receipt cannot be minted already terminal, with a chosen result and no reservation;
--   * a receipt's identity cannot be re-pointed at a different actor or command after the fact;
--   * a completed receipt cannot be re-pointed at a different result, re-opened, or backdated;
--   * a receipt cannot be completed by a LATER transaction than the one that reserved it;
--   * a SUCCEEDED receipt cannot record an empty result, and a FAILED one cannot record any.
--
-- Those are the shapes an application bug, a careless maintenance UPDATE, or a future path that
-- bypasses `executeCommand` actually produce, and each was a single statement away before. What
-- remains is a deliberate multi-statement forgery inside one transaction, and the answer to THAT
-- is not another trigger — it is that a maintenance role should not hold INSERT/UPDATE on this
-- table at all. That is a privilege-grant decision, recorded in `docs/RUNBOOK.md §CMDR`, not
-- something a trigger can assert.
--
-- **This enforces the protocol the code already follows, so no runtime change accompanies it.**
-- `executeCommand` has exactly two writers — the `reserved` insert and the completing update, both
-- inside one `$transaction` — and there is no raw SQL, no second creator and no delete path
-- anywhere in the API. A probe drives a real command end to end to prove that, rather than
-- asserting it in a comment.

-- ── legacy rows: DIAGNOSTIC FIRST, and this one ABORTS ─────────────────────────────────────────
--
-- Run BEFORE the trigger exists, so an operator's repair is not itself blocked by the seal.
--
-- The first head of this migration only raised a NOTICE here, on the reasoning that neither
-- incoherent shape could satisfy a provenance seal falsely. That reasoning was WRONG and the
-- review caught it: §E's join reads `status = 'succeeded'`, `commandType` and `resultRef` — it
-- does NOT read `completedAt`. So a pre-existing hand-written `succeeded` receipt with a chosen
-- `resultRef` and no completion time validates a hand-written verdict the moment this seal is
-- installed, and installing a seal that trusts rows it never checked is worse than installing
-- none: everything downstream then reads as verified provenance.
--
-- So it aborts. Neither shape can be repaired by inventing data — nobody knows when a receipt with
-- no completion time completed — so the repair is to make the row NON-AUTHORITATIVE by deleting
-- it. That is safe and self-diagnosing: DELETE is permitted on this table, and every citing row
-- holds an ON DELETE NO ACTION composite FK, so PostgreSQL removes a receipt nothing rests on and
-- REFUSES one a fact depends on — which tells the operator they have found a fact resting on a
-- receipt no command produced. `docs/RUNBOOK.md §CMDR` walks both outcomes.
DO $$
DECLARE v_no_completed bigint; v_failed_with_result bigint;
BEGIN
  SELECT COUNT(*) INTO v_no_completed
    FROM "CommandExecution" WHERE "status" <> 'reserved' AND "completedAt" IS NULL;
  SELECT COUNT(*) INTO v_failed_with_result
    FROM "CommandExecution" WHERE "status" = 'failed' AND "resultRef" IS NOT NULL;
  IF v_no_completed <> 0 OR v_failed_with_result <> 0 THEN
    RAISE EXCEPTION 'platform_command_receipt_seal: % terminal receipt(s) carry no completion time and % failed receipt(s) carry a result. `executeCommand` cannot produce either shape, so those rows were written by something else — and a `succeeded` row with a chosen `resultRef` satisfies every provenance join downstream. Resolve them before this seal is installed: see docs/RUNBOOK.md §CMDR.', v_no_completed, v_failed_with_result;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION platform_command_receipt_protocol() RETURNS trigger AS $$
DECLARE v_reserved_here boolean;
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
  -- …and the converse, which the first head left open (Codex round-2): a SUCCEEDED command
  -- produced something, and `resultRef` is what says what. `ExecuteResult.resultRef` is a required
  -- `string` in TypeScript and every one of the hundred-odd command sites returns an entity id, so
  -- this is the type system's rule restated where the database can enforce it. Left open, a
  -- succeeded receipt with no result SUPPRESSES the retry that would have produced the entity —
  -- the replay path returns `prior.resultRef ?? ''` — so the caller is told the command succeeded
  -- and handed nothing. Non-blank as well as non-null, under the same §0b whitespace rule every
  -- other identity column in this system uses.
  IF NEW."status" = 'succeeded' AND (NEW."resultRef" IS NULL OR btrim(NEW."resultRef") = '') THEN
    RAISE EXCEPTION 'A SUCCEEDED command recorded no result — a replay would report success and hand back nothing, and every provenance join reading `resultRef` would find no entity (%)', OLD."id";
  END IF;

  -- RESERVE AND COMPLETE ARE ONE TRANSACTION. Phase 2 states it as the protocol —
  -- "reserves→executes→commits its succeeded receipt in ONE transaction, so the effect happens
  -- exactly once" — and `executeCommand` does exactly that, so a completion arriving from a LATER
  -- transaction did not come from a command run. Enforcing it is what makes this seal a faithful
  -- description of the protocol rather than a partial one: without it, a receipt reserved at any
  -- point in the past can be adopted and completed later against a result chosen afterwards.
  --
  -- `xmin` is the transaction that inserted the row; `txid_current()::text::xid` truncates the
  -- 64-bit counter to the 32-bit xid the row carries, which is the standard comparison. It is read
  -- back rather than taken from OLD because system columns are not exposed on trigger records.
  SELECT c."xmin" = txid_current()::text::xid INTO v_reserved_here
    FROM "CommandExecution" c WHERE c."id" = OLD."id";
  IF NOT COALESCE(v_reserved_here, false) THEN
    RAISE EXCEPTION 'A command receipt is completed by the SAME transaction that reserved it — a completion arriving later did not come from a command run (%)', OLD."id";
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
-- `StockTransaction` and every other citing row holds an ON DELETE NO ACTION composite FK, so
-- PostgreSQL already refuses to delete a receipt something rests on. That refusal is also what
-- makes the §CMDR repair safe.
