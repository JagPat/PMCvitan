-- Phase 5 Task 6A (§F/§G/§I) — PAYMENT AUTHORITY: approving money, and recording it leaving.
--
-- Certification says what a vendor is OWED. An approval is the separate authority saying it may be
-- PAID, and §I keeps the two apart on purpose: the actor who certified may not approve. A payment
-- is then a row against an approval, never a column on it — the same §C shape the deduction ledger
-- and the stock model use, so the paid total is a FOLD with no stored balance column.
--
-- What this migration deliberately does NOT do: it does not derive the §F payment status. Task 5C
-- deferred that derivation because §F reads THREE folds — `NET_PAYABLE`, `APPROVED`, `PAID` — and
-- two of them did not exist. This task creates those two, and the derivation lands in 6B beside the
-- reversal rows that make it correct. Until then the stored status stays `certified`, which is
-- strictly stricter than the finished rule: there is no transition to be wrong about, and no bill
-- can be stranded in a state no legal row can leave.

-- ── the two tables ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PaymentApproval" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "certificateId"   TEXT NOT NULL,
  "billId"          TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "approvedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById"    TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "PaymentApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Payment" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "approvalId"      TEXT NOT NULL,
  "billId"          TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "method"          TEXT NOT NULL,
  "reference"       TEXT,
  "paidAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidById"        TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentApproval_projectId_id_key" ON "PaymentApproval"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentApproval_projectId_id_billId_key" ON "PaymentApproval"("projectId", "id", "billId");
CREATE INDEX IF NOT EXISTS "PaymentApproval_projectId_billId_idx" ON "PaymentApproval"("projectId", "billId");
CREATE INDEX IF NOT EXISTS "PaymentApproval_projectId_certificateId_idx" ON "PaymentApproval"("projectId", "certificateId");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_projectId_id_key" ON "Payment"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_projectId_id_billId_key" ON "Payment"("projectId", "id", "billId");
CREATE INDEX IF NOT EXISTS "Payment_projectId_billId_idx" ON "Payment"("projectId", "billId");
CREATE INDEX IF NOT EXISTS "Payment_projectId_approvalId_idx" ON "Payment"("projectId", "approvalId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_projectId_fkey') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the THREE-column FK: the certificate must be a certificate OF THIS BILL, not of some other
  -- claim that happens to share a project. Same shape the deduction ledger uses.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_certificate_fkey') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_certificate_fkey" FOREIGN KEY ("projectId", "certificateId", "billId")
    REFERENCES "BillCertificate"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_bill_fkey') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_bill_fkey" FOREIGN KEY ("projectId", "billId")
    REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_approvedById_fkey') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_command_fkey') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_projectId_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_approval_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_approval_fkey" FOREIGN KEY ("projectId", "approvalId", "billId")
    REFERENCES "PaymentApproval"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_bill_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bill_fkey" FOREIGN KEY ("projectId", "billId")
    REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_paidById_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_command_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- §0b's sign constraint at its next two sites. Money that moves is strictly positive; direction is
-- carried by the ROW KIND (an approval, a payment, and in 6B a reversal), never by a negative
-- amount — a negative would encode direction twice and let one row undo another silently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentApproval_amount_positive') THEN
    ALTER TABLE "PaymentApproval" ADD CONSTRAINT "PaymentApproval_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_amount_positive') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);
  END IF;
  -- a payment that cannot say HOW the money moved cannot be reconciled against a bank statement,
  -- which is the only thing that makes it evidence rather than an assertion
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_method_nonblank') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_method_nonblank" CHECK (btrim("method", E' \t\n\x0B\f\r') <> '');
  END IF;
END $$;

-- ── append-only: money that moved is not editable ────────────────────────────────────────────
--
-- The same discipline as the certificate and the deduction ledger. An approval that can be raised
-- after the fact is not an authority, and a payment that can be edited never proved anything about
-- what left the account. 6B adds REVERSAL rows — the only way to undo either — because a
-- correction has to be an attributable act, not an UPDATE nobody can see.

CREATE OR REPLACE FUNCTION phase5_t6a_approval_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payment approval % is append-only — an authority that can be edited after the fact is not an authority; reverse it with an attributable row instead', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentApproval_append_only" ON "PaymentApproval";
CREATE TRIGGER "PaymentApproval_append_only" BEFORE DELETE OR UPDATE ON "PaymentApproval"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_append_only();

CREATE OR REPLACE FUNCTION phase5_t6a_payment_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payment % is append-only — money that left the account is a fact, not a field; reverse it with an attributable row instead', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Payment_append_only" ON "Payment";
CREATE TRIGGER "Payment_append_only" BEFORE DELETE OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_append_only();

-- ── §G bound 4 — APPROVED(bill) ≤ NET_PAYABLE(bill) ──────────────────────────────────────────
--
-- NET, not gross, and the plan is explicit about why: capping approval at the gross certificate
-- would let a ₹100 certification carrying a ₹10 retention approve and pay the full ₹100, which
-- makes the §H deduction ledger decorative — it would record a withholding that never withheld
-- anything.
--
-- The fold runs over EVERY declared deduction type minus its releases. A type that exists in the
-- enum and not in the fold is a withholding that withholds nothing, so this reads the ledger by
-- certificate rather than naming types — a member added to the CHECK in 6C is then in the fold the
-- moment it exists, instead of being silently informational until someone remembers.
--
-- LIVE certificate only (§0): a superseded certificate is retained history, and summing it would
-- read a corrected ₹100 certification as ₹200.
CREATE OR REPLACE FUNCTION phase5_t6a_net_payable(p_project text, p_bill text)
RETURNS numeric AS $$
DECLARE
  v_certified numeric;
  v_withheld  numeric;
BEGIN
  SELECT c."certifiedAmount" INTO v_certified
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;
  IF v_certified IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(d."amount"), 0) - COALESCE((
           SELECT SUM(r."amount") FROM "BillDeductionRelease" r
            JOIN "BillDeduction" d2 ON d2."projectId" = r."projectId" AND d2."id" = r."deductionId"
            JOIN "BillCertificate" c2 ON c2."projectId" = d2."projectId" AND c2."id" = d2."certificateId"
            WHERE d2."projectId" = p_project AND c2."billId" = p_bill AND c2."supersededAt" IS NULL
         ), 0)
    INTO v_withheld
    FROM "BillDeduction" d
    JOIN "BillCertificate" c3 ON c3."projectId" = d."projectId" AND c3."id" = d."certificateId"
   WHERE d."projectId" = p_project AND c3."billId" = p_bill AND c3."supersededAt" IS NULL;

  RETURN v_certified - v_withheld;
END;
$$ LANGUAGE plpgsql;

-- The bound itself. Re-derived under `FOR UPDATE` on the constraining row — the Phase-4 Task-3 F3
-- lesson, restated by 5C's rounds 1 and 8: a trigger that COUNTS without serializing is not an
-- invariant, because two direct writers each see only their own row and both commit.
--
-- The BILL is what scopes this fold and you cannot lock a fold, so the bill row is taken first.
-- `approvePayment` already holds it (`lockBill`), so this adds no new lock order — it only closes
-- the gap for a writer that never took it.
CREATE OR REPLACE FUNCTION phase5_t6a_approved_bound_check(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_net      numeric;
  v_approved numeric;
  v_lock     text;
BEGIN
  SELECT b."id" INTO v_lock FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill
     FOR UPDATE;

  v_net := phase5_t6a_net_payable(p_project, p_bill);
  -- no live certificate means nothing is payable at all; the approval's own FK to a live
  -- certificate is what refuses that case, and this fold has no bound to state
  IF v_net IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(a."amount"), 0) INTO v_approved
    FROM "PaymentApproval" a
    JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
   WHERE a."projectId" = p_project AND a."billId" = p_bill
     AND c."supersededAt" IS NULL;

  -- Only when something is actually approved. With no approvals the bound has nothing to say, and
  -- a NEGATIVE net payable is §H's floor to refuse, not this one: `0 > -10` is technically a breach
  -- of bound 4, but raising here would hijack the deduction floor's refusal and report the wrong
  -- rule for the wrong write. Each seal answers for its own invariant.
  IF v_approved > 0 AND v_approved > v_net THEN
    RAISE EXCEPTION 'Approvals of % exceed the % payable on this bill — a certification of % carrying unreleased withholdings cannot authorise more than it leaves payable; release the balance or correct the certification first (%)', v_approved, v_net, p_bill, p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Sealed at COMMIT, not at insert. What a transaction leaves BEHIND is what a seal has to be about:
-- a deduction recorded in the same transaction as an approval must be visible to the bound, and an
-- insert-time check would pass before it existed.
CREATE OR REPLACE FUNCTION phase5_t6a_approval_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6a_approved_bound_check(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentApproval_bound_sealed" ON "PaymentApproval";
CREATE CONSTRAINT TRIGGER "PaymentApproval_bound_sealed"
  AFTER INSERT ON "PaymentApproval" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_bound_sealed();

-- A deduction recorded AFTER an approval must not silently put the bill in breach either. The
-- deduction ledger is append-only, so without this a practice could approve ₹100 and then withhold
-- ₹10 against the same certificate, leaving `APPROVED > NET_PAYABLE` with no write left to refuse.
-- Same rule, every site (§0b).
DROP TRIGGER IF EXISTS "BillDeduction_approved_bound_sealed" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_approved_bound_sealed"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_bound_sealed();

-- ── §G bound 5 — PAID(bill) ≤ APPROVED(bill) ─────────────────────────────────────────────────
--
-- Both sides are §0 sets. Neither may be a raw `Σ` over positive rows once 6B adds reversals: a
-- corrected-down payment must lower the left side and a superseded certificate's approvals must
-- lower the right, or the bound compares two overstated totals and passes a bill in breach. The
-- right side already excludes approvals on superseded certificates for exactly that reason.
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

  SELECT COALESCE(SUM(p."amount"), 0) INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."billId" = p_bill;

  IF v_paid > v_approved THEN
    RAISE EXCEPTION 'Payments of % exceed the % approved on this bill — money may only leave against an authority that covers it; approve the difference first (%)', v_paid, v_approved, p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6a_payment_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6a_paid_bound_check(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Payment_bound_sealed" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_bound_sealed"
  AFTER INSERT ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_bound_sealed();

-- ── provenance: the command that PRODUCED the row, not merely one of the right type ──────────
--
-- 5C's round-5 F3, at its next two sites. A type check is satisfied by EVERY prior command of that
-- type, so a direct writer could reuse one succeeded receipt to append a second approval or a
-- second payment. `resultRef` IS the row, and row ids are unique, so a reused receipt is
-- unrepresentable with no extra constraint propping it up.
--
-- The ACTOR is bound too (5C round 8): type, status and `resultRef` prove everything about the
-- cited act except WHO performed it, and these rows are append-only, so a misattribution is
-- permanent with no correcting row to make later.
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
    ELSE to_jsonb(NEW)->>'paidById'
  END;
  IF v_actor IS DISTINCT FROM v_named THEN
    RAISE EXCEPTION '% row % is attributed to %, but the command it cites was run by % — money that moves names the human who moved it, and an append-only row carries that name for good', TG_TABLE_NAME, NEW."id", COALESCE(v_named, '(nobody)'), COALESCE(v_actor, '(nobody)');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentApproval_command_succeeded" ON "PaymentApproval";
CREATE CONSTRAINT TRIGGER "PaymentApproval_command_succeeded"
  AFTER INSERT ON "PaymentApproval" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_command_succeeded();
DROP TRIGGER IF EXISTS "Payment_command_succeeded" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_command_succeeded"
  AFTER INSERT ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_command_succeeded();

-- ── §I — the payment half of the SoD record ──────────────────────────────────────────────────
--
-- `SodException` already exists from Task 5 with a nullable `certificateId` and a comment reserving
-- this half. An exception is authority for ONE act, never a standing waiver a later override can
-- point at, so a row names exactly one fact.
ALTER TABLE "SodException" ADD COLUMN IF NOT EXISTS "approvalId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_approval_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_approval_fkey" FOREIGN KEY ("projectId", "approvalId")
    REFERENCES "PaymentApproval"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_names_one_fact') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_names_one_fact"
    CHECK (("certificateId" IS NOT NULL AND "approvalId" IS NULL)
        OR ("certificateId" IS NULL AND "approvalId" IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "SodException_projectId_approvalId_idx" ON "SodException"("projectId", "approvalId");

-- ── diagnostic-first: this migration adds tables, and they must arrive EMPTY ──────────────────
--
-- A legacy database upgrades row-free. If either table already holds a row, something wrote money
-- movement outside this task's seals and the deploy stops rather than blessing it.
DO $$
DECLARE v_a bigint; v_p bigint;
BEGIN
  SELECT COUNT(*) INTO v_a FROM "PaymentApproval";
  SELECT COUNT(*) INTO v_p FROM "Payment";
  IF v_a > 0 OR v_p > 0 THEN
    RAISE EXCEPTION 'Phase 5 Task 6A expected to create its tables empty, found % approval(s) and % payment(s) — money movement exists that predates the seals this migration installs; investigate before deploying', v_a, v_p;
  END IF;
END $$;

-- §I — the approval CEILING, per membership. Applied to a claim's cumulative approved total, never
-- per row: a per-row check lets a ₹50 holder authorise ₹100 as two ₹50 rows, each within limit and
-- the ceiling defeated. NULL is "unlimited", which is what every existing membership is, so this
-- column changes no current behaviour; zero is a real ceiling that refuses everything, because
-- "may not approve" is a thing a practice may legitimately want to say about a role.
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "approvalLimit" DECIMAL(18,2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Membership_approvalLimit_nonnegative') THEN
    ALTER TABLE "Membership" ADD CONSTRAINT "Membership_approvalLimit_nonnegative" CHECK ("approvalLimit" IS NULL OR "approvalLimit" >= 0);
  END IF;
END $$;
