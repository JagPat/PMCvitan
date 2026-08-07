-- Phase 5 Task 6B unit ii (§0/§F/§H) — CASH COMING BACK.
--
-- 6B-i made the payment status a FUNCTION of three folds instead of a value a writer chooses. It
-- shipped with `PAID(bill)` as `Σ Payment` exactly, and said so plainly rather than claiming a
-- subtraction it could not carry: §0 defines the fold as Σ payments MINUS Σ payment reversals, and
-- the reversal term needs the table this migration creates.
--
-- Why a distinct row TYPE rather than a signed amount. Every append-only money row in this phase is
-- strictly positive with the type carrying direction (§H). A positive ₹50 "reversing payment" reads
-- ₹150 paid on a ₹100 bill; a negative one is refused by `Payment_amount_positive`. Neither is a
-- reversal, so the reversal is its own fact with its own authority and its own reason.
--
-- What this unlocks, and it is the point rather than a side effect: §0's correction ORDERING. A
-- certificate carrying cash may not be superseded — Task 6A's `BillCertificate_paid_bound_sealed`
-- refuses it, because supersession drops `APPROVED` to 0 while `PAID` stands. Until now that
-- refusal had no escape: the bill was correct and uncorrectable. The legal sequence §0 states is
-- reverse the cash IN FULL → supersede → re-approve the reduced amount, and this migration supplies
-- its first step.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- EVERY SQL TWIN OF `PAID` IS WIDENED HERE, TOGETHER
-- ══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `docs/reviews/pr-289-convergence.md`, root A: four findings in one unit were the same mistake —
-- the code wrote down the members instead of deriving them from what the fold reads, and each fix
-- that stopped at the instance named let the next member through. The instance THIS unit could
-- repeat is exact: three PL/pgSQL functions compute `Σ Payment`, and a reversal that lowers the
-- fold at two of them and not the third does not make the database inconsistent in some abstract
-- way — it makes the ₹100 reversal fail to unlock the supersession it exists for, because bound 5
-- would still read ₹100 paid.
--
--   1. `phase5_t6a_paid_bound_check`     — §G bound 5, bill-scoped
--   2. `phase5_t6a_approval_paid_check`  — §G bound 5, approval-scoped (6A round 3)
--   3. `phase5_t6b_derive_bill_status`   — §F's truth table, the SQL mirror
--
-- All three are replaced below, and `commercial.contract.test.ts` now DERIVES that set from the
-- migration text rather than trusting this comment: a function that folds `"Payment"` without
-- subtracting `"PaymentReversal"` fails at the desk. Root A's idiom applied to the SQL twins, which
-- is where 6C's `advance-recovery` will next be tempted to write a fourth one.

-- ── the table ────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PaymentReversal" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "paymentId"       TEXT NOT NULL,
  "billId"          TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "reason"          TEXT NOT NULL,
  "reversedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedById"    TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "PaymentReversal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentReversal_projectId_id_key" ON "PaymentReversal"("projectId", "id");
CREATE INDEX IF NOT EXISTS "PaymentReversal_projectId_billId_idx" ON "PaymentReversal"("projectId", "billId");
CREATE INDEX IF NOT EXISTS "PaymentReversal_projectId_paymentId_idx" ON "PaymentReversal"("projectId", "paymentId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_projectId_fkey') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the THREE-column FK: the payment reversed must be a payment OF THIS BILL. That is what makes
  -- the denormalised `billId` safe — the bill-scoped fold and the §F derivation seal both read it,
  -- and it cannot disagree with the payment's own bill.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_payment_fkey') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_payment_fkey" FOREIGN KEY ("projectId", "paymentId", "billId")
    REFERENCES "Payment"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_bill_fkey') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_bill_fkey" FOREIGN KEY ("projectId", "billId")
    REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_reversedById_fkey') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_command_fkey') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- §H sign discipline: STRICTLY positive. A zero reversal moves no money and would still be a row
  -- claiming an act happened; a negative one is a payment wearing the wrong type.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_amount_positive') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReversal_reason_nonblank') THEN
    ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_reason_nonblank"
    CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
END $$;

-- append-only, exactly as `Payment` is. Cash returning is evidence in the same sense cash leaving
-- is: an editable reversal is a fold anybody can rewrite after the fact.
CREATE OR REPLACE FUNCTION phase5_t6b_ii_reversal_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PaymentReversal rows are append-only — money that came back is evidence, and a correction is another attributable act, never an edit to this one';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentReversal_append_only" ON "PaymentReversal";
CREATE TRIGGER "PaymentReversal_append_only" BEFORE DELETE OR UPDATE ON "PaymentReversal"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_ii_reversal_append_only();

-- ── the bound: Σ reversals(payment) ≤ that payment's amount ───────────────────────────────────
--
-- Stated PER PAYMENT rather than per bill, and the bill-scoped statement §0 makes
-- (`Σ reversals ≤ Σ payments`) is its COROLLARY, not a second check: if every payment's reversals
-- are within that payment, summing over the bill gives the bill bound for free. Writing both would
-- be two enforcements of one rule, which is the drift this module keeps deleting.
--
-- Per-payment is also the STRONGER statement, and 6A learned exactly why the nested question is the
-- one that matters (round 3, P2): pay ₹40 against A1 and ₹40 against A2, then reverse ₹80 against
-- the first payment — the bill total is conserved and the attribution is a lie, with A1 reporting
-- more returned than it ever paid. §C's rule is that every unit of money answers to exactly one
-- authority, and a fold that only asks about the sum cannot notice when one of them is overdrawn.
--
-- Same lock shape as `phase5_t6a_approval_paid_check`: the parent row this bound is measured
-- against, taken before the count, so two concurrent reversals cannot each read the same balance.
-- The payment is a CHILD of the bill and every honest mover takes the bill first (§0b), so the
-- order stays bill → payment and is total.
CREATE OR REPLACE FUNCTION phase5_t6b_ii_reversal_bound_check(p_project text, p_payment text)
RETURNS void AS $$
DECLARE
  v_paid     numeric;
  v_reversed numeric;
BEGIN
  SELECT p."amount" INTO v_paid FROM "Payment" p
   WHERE p."projectId" = p_project AND p."id" = p_payment
     FOR UPDATE;
  IF v_paid IS NULL THEN RETURN; END IF;   -- the FK is what refuses a missing payment

  SELECT COALESCE(SUM(r."amount"), 0) INTO v_reversed
    FROM "PaymentReversal" r
   WHERE r."projectId" = p_project AND r."paymentId" = p_payment;

  IF v_reversed > v_paid THEN
    RAISE EXCEPTION 'Reversals of % stand against payment %, which moved only % — a reversal returns money that actually left, and cannot return more than its own payment carried', v_reversed, p_payment, v_paid;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6b_ii_reversal_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6b_ii_reversal_bound_check(NEW."projectId", NEW."paymentId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentReversal_bound_sealed" ON "PaymentReversal";
CREATE CONSTRAINT TRIGGER "PaymentReversal_bound_sealed"
  AFTER INSERT ON "PaymentReversal" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_ii_reversal_bound_sealed();

-- ── the three SQL twins of `PAID`, widened TOGETHER ──────────────────────────────────────────

-- 1. §G bound 5, bill-scoped. 6A's own comment on this function said it: *"Neither may be a raw `Σ`
--    over positive rows once 6B adds reversals: a corrected-down payment must lower the left side."*
--    Everything else is carried forward VERBATIM.
--
--    This is the function that makes the §0 correction ordering WORK rather than merely refuse:
--    reverse ₹100 and `v_paid` falls to 0, so the supersession that was correctly refused a moment
--    earlier now passes with both sides of the bound at 0. Leaving it un-widened would have left
--    the reversal row appended and the bill still uncorrectable.
CREATE OR REPLACE FUNCTION phase5_t6a_paid_bound_check(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_approved numeric;
  v_paid     numeric;
  v_lock     text;
BEGIN
  SELECT b."id" INTO v_lock FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill
     FOR UPDATE;

  SELECT COALESCE(SUM(a."amount"), 0) INTO v_approved
    FROM "PaymentApproval" a
    JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
   WHERE a."projectId" = p_project AND a."billId" = p_bill
     AND c."supersededAt" IS NULL;

  SELECT COALESCE(SUM(p."amount"), 0)
       - COALESCE((SELECT SUM(r."amount") FROM "PaymentReversal" r
                    WHERE r."projectId" = p_project AND r."billId" = p_bill), 0)
    INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."billId" = p_bill;

  IF v_paid > v_approved THEN
    RAISE EXCEPTION 'Payments of % exceed the % approved on this bill — money may only leave against an authority that covers it; approve the difference first (%)', v_paid, v_approved, p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 2. §G bound 5, approval-scoped (6A round 3). Reversing frees the authority's own headroom, which
--    is the honest reading: a payment that came back was not spent against that approval.
CREATE OR REPLACE FUNCTION phase5_t6a_approval_paid_check(p_project text, p_approval text)
RETURNS void AS $$
DECLARE
  v_authorised numeric;
  v_paid       numeric;
BEGIN
  SELECT a."amount" INTO v_authorised FROM "PaymentApproval" a
   WHERE a."projectId" = p_project AND a."id" = p_approval
     FOR UPDATE;
  IF v_authorised IS NULL THEN RETURN; END IF;   -- the FK is what refuses a missing approval

  SELECT COALESCE(SUM(p."amount"), 0)
       - COALESCE((SELECT SUM(r."amount")
                     FROM "PaymentReversal" r
                     JOIN "Payment" p2 ON p2."projectId" = r."projectId" AND p2."id" = r."paymentId"
                    WHERE r."projectId" = p_project AND p2."approvalId" = p_approval), 0)
    INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."approvalId" = p_approval;

  IF v_paid > v_authorised THEN
    RAISE EXCEPTION 'Payments of % rest on approval %, which authorises only % — another approval on the same claim raises the CLAIM''S ceiling, not this one''s, and money answers to the authority it is nested under', v_paid, p_approval, v_authorised;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 3. §F's truth table, the SQL mirror of `derivedBillStatus`. Carried forward from 6B-i arm for arm
--    and in the same first-match order; only `v_paid` changes, and it changes to the fold §0 always
--    defined. This is what makes a reversal MOVE the status rather than merely lower a number:
--    `paid` → `approved-for-payment` on a full reversal, `paid` → `part-paid` on a partial one.
CREATE OR REPLACE FUNCTION phase5_t6b_derive_bill_status(p_project text, p_bill text)
RETURNS text AS $$
DECLARE
  v_cert     text;
  v_net      numeric := 0;
  v_approved numeric := 0;
  v_paid     numeric := 0;
BEGIN
  SELECT c."id",
         c."certifiedAmount"
           - COALESCE((SELECT SUM(d."amount") FROM "BillDeduction" d
                        WHERE d."projectId" = c."projectId" AND d."certificateId" = c."id"), 0)
           + COALESCE((SELECT SUM(r."amount") FROM "BillDeductionRelease" r
                         JOIN "BillDeduction" d2
                           ON d2."projectId" = r."projectId" AND d2."id" = r."deductionId"
                        WHERE d2."projectId" = c."projectId" AND d2."certificateId" = c."id"), 0)
    INTO v_cert, v_net
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;
  -- no live certificate: nothing is payable, which is the value the first arm needs
  IF v_cert IS NULL THEN v_net := 0; END IF;

  SELECT COALESCE(SUM(a."amount"), 0) INTO v_approved
    FROM "PaymentApproval" a
    JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
   WHERE a."projectId" = p_project AND a."billId" = p_bill AND c."supersededAt" IS NULL;

  SELECT COALESCE(SUM(p."amount"), 0)
       - COALESCE((SELECT SUM(r."amount") FROM "PaymentReversal" r
                    WHERE r."projectId" = p_project AND r."billId" = p_bill), 0)
    INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."billId" = p_bill;

  -- first match wins, exactly as the TypeScript does
  IF v_net = v_paid THEN RETURN 'paid'; END IF;
  IF v_approved = 0 THEN RETURN 'certified'; END IF;
  IF v_paid = v_approved AND v_approved < v_net THEN RETURN 'certified'; END IF;
  IF v_paid = 0 THEN RETURN 'approved-for-payment'; END IF;
  RETURN 'part-paid';
END;
$$ LANGUAGE plpgsql STABLE;

-- ── the derivation seal, on the new fold input ───────────────────────────────────────────────
--
-- This is the trigger 6B-i's convergence closure was written to DEMAND. Its delegate extractor is
-- mutation-tested against `tx.paymentReversal` specifically: fed a simulated 6B-ii model set, it
-- must both SEE the delegate and REPORT it as unsealed. So until this statement existed, the
-- closure failed at the desk with no database and no reviewer involved — which is what a closure
-- for "the member was missed" is supposed to do at the moment the next member arrives.
--
-- The generic resolver suffices: `PaymentReversal` carries `projectId` and `billId`, and the
-- `NOWAIT` bill-first behaviour is inherited unchanged, so a reversal written without locking the
-- bill first still fails closed rather than waiting in the wrong order.
DROP TRIGGER IF EXISTS "PaymentReversal_t6b_status_sealed" ON "PaymentReversal";
CREATE CONSTRAINT TRIGGER "PaymentReversal_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "PaymentReversal" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_fold_status_sealed();

-- ── provenance: the command that PRODUCED the row ────────────────────────────────────────────
--
-- 6A's function, with its third arm. Replacing it rather than writing a sibling is deliberate:
-- `TG_TABLE_NAME` already carried the switch, and a second function would be the same rule at a
-- second site — the exact shape root A keeps producing. The two existing arms are byte-identical.
CREATE OR REPLACE FUNCTION phase5_t6a_command_succeeded() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_result text;
  v_actor  text;
  v_type   text;
  v_named  text;
  v_want   text;
BEGIN
  SELECT ce."status", ce."resultRef", ce."actorId", ce."commandType"
    INTO v_status, v_result, v_actor, v_type
    FROM "CommandExecution" ce
   WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId";

  v_want := CASE TG_TABLE_NAME
    WHEN 'PaymentApproval' THEN 'commercial.payment.approve'
    WHEN 'PaymentReversal' THEN 'commercial.payment.reverse'
    ELSE 'commercial.payment.record'
  END;
  IF v_type IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION '% row % cites command % of type % — a ledger row records the command that PRODUCED it, and this one did not', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_type, '(missing)');
  END IF;
  IF v_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION '% row % rests on command %, which is `%` — a row that outlives a failed act is money nobody moved', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_status, '(missing)');
  END IF;
  IF v_result IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION '% row % cites command %, which produced % — reusing a succeeded receipt attributes money to an act that did not move it', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_result, '(nothing)');
  END IF;

  v_named := CASE TG_TABLE_NAME
    WHEN 'PaymentApproval' THEN to_jsonb(NEW)->>'approvedById'
    WHEN 'PaymentReversal' THEN to_jsonb(NEW)->>'reversedById'
    ELSE to_jsonb(NEW)->>'paidById'
  END;
  IF v_actor IS DISTINCT FROM v_named THEN
    RAISE EXCEPTION '% row % is attributed to %, but the command it cites was run by % — money that moves names the human who moved it, and an append-only row carries that name for good', TG_TABLE_NAME, NEW."id", COALESCE(v_named, '(nobody)'), COALESCE(v_actor, '(nobody)');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentReversal_command_succeeded" ON "PaymentReversal";
CREATE CONSTRAINT TRIGGER "PaymentReversal_command_succeeded"
  AFTER INSERT ON "PaymentReversal" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_command_succeeded();

-- ── this migration ADDS a fact and INVENTS none ──────────────────────────────────────────────
--
-- The upgrade path here is genuinely quiet, and the assertion is what proves it rather than the
-- claim: a legacy database has no reversals, so the widened folds return exactly what they returned
-- before (`Σ Payment − 0`), no stored status moves, and no backfill is needed or performed. 6B-i
-- needed a serialized cutover because it INSTALLED a seal over states 6A had legitimately created;
-- this one seals a table that does not yet have a row.
--
-- If that is ever false the deploy stops here rather than reasoning about it: a row in a table this
-- migration is creating means the schema was reached by some path other than this file.
DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "PaymentReversal";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t6b_ii: "PaymentReversal" already holds % row(s) before its own migration completed — this table is created here, so a populated one means the schema was reached by a path this file does not describe. Stopping rather than sealing over data of unknown provenance', v_rows;
  END IF;
END $$;
