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
  -- …and the same discipline on the OPTIONAL reference. Absent is a legitimate answer (not every
  -- method has one); whitespace is not. The row is append-only, so a present-but-useless bank
  -- reference is permanent, and the API contract already treats a blank one as absent — a database
  -- that stores it anyway leaves the two disagreeing about the same payment.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_reference_nonblank') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reference_nonblank"
    CHECK ("reference" IS NULL OR btrim("reference", E' \t\n\x0B\f\r') <> '');
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

-- …and the APPROVAL-scoped half of the same bound.
--
-- Codex round 3 (P2). §G states bound 5 over the BILL, and that is right for what it measures — a
-- second approval genuinely raises the claim's ceiling. It is not the whole rule, because a
-- `Payment` is nested UNDER one approval: approve A1=40 and A2=40, then pay 40 against A1 twice,
-- and the bill fold sees 80 approved against 40 paid and admits it. The bill total is conserved
-- and the ATTRIBUTION is a lie — A1 reports paying 80 on an authority of 40 while A2 sits unused.
-- §C's rule is that every unit of money answers to exactly one authority, and a fold that only
-- ever asks about the sum cannot notice when one of them is overdrawn.
--
-- Same lock order as its bill-scoped sibling: the approval's own row, which the FK guarantees
-- exists, taken before the count.
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

  SELECT COALESCE(SUM(p."amount"), 0) INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."approvalId" = p_approval;

  IF v_paid > v_authorised THEN
    RAISE EXCEPTION 'Payments of % rest on approval %, which authorises only % — another approval on the same claim raises the CLAIM''S ceiling, not this one''s, and money answers to the authority it is nested under', v_paid, p_approval, v_authorised;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6a_payment_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6a_paid_bound_check(NEW."projectId", NEW."billId");
  PERFORM phase5_t6a_approval_paid_check(NEW."projectId", NEW."approvalId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Payment_bound_sealed" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_bound_sealed"
  AFTER INSERT ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_bound_sealed();

-- ── a money row's OWN authority must be LIVE, not merely the bill's total ────────────────────
--
-- Codex round 2 (P1). The bound above is bill-scoped, and that is right for what it measures — a
-- second approval genuinely raises the ceiling. But it is the WRONG question to ask of one payment:
-- approve ₹40 on C1, supersede C1, certify C2 and approve ₹40 there, then insert a `Payment`
-- against the OLD C1 approval. `v_approved` counts C2's live ₹40, `v_paid` counts the stale ₹40,
-- `40 <= 40` passes — and the cash evidence is nested under an authority that is not in
-- `APPROVED(bill)` at all.
--
-- So the row-level question is asked at the row: this row's certification still stands.
--
-- BOTH rows, not just the one the finding named. `PaymentApproval` has the identical hole — its
-- three-column FK proves the certificate belongs to this bill and says nothing about it being live,
-- and `phase5_t6a_approved_bound_check` deliberately excludes superseded certificates, so a direct
-- writer's approval against dead certification passes every constraint by being invisible to all of
-- them. It is inert money (no payment can now draw on it) and it is still a false authority sitting
-- in an append-only register. This PR's audit names "the fix lands on the instance a finding named
-- and the sibling survives" as a recurring root; the sibling is sealed here, in the same head.
--
-- BEFORE INSERT rather than deferred: it is a property of the row itself, nothing later in the
-- transaction can make a superseded certificate live again, and failing at the offending statement
-- names the row.
CREATE OR REPLACE FUNCTION phase5_t6a_assert_certificate_live(
  p_project text, p_bill text, p_certificate text, p_what text, p_row text
) RETURNS void AS $$
DECLARE
  v_superseded timestamp(3);
  v_lock       text;
BEGIN
  -- the BILL first, always — the one lock order this file uses, so a direct writer that reaches
  -- this trigger and a service transaction that already holds the bill can never deadlock
  SELECT b."id" INTO v_lock FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill
     FOR UPDATE;

  SELECT c."supersededAt" INTO v_superseded FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate;

  IF v_superseded IS NOT NULL THEN
    RAISE EXCEPTION '% % rests on a certification superseded at % — a superseded certificate is retained history, not the authority money moves against; act on the certificate that stands', p_what, p_row, v_superseded;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6a_approval_authority_live() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6a_assert_certificate_live(
    NEW."projectId", NEW."billId", NEW."certificateId", 'Payment approval', NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentApproval_authority_live" ON "PaymentApproval";
CREATE TRIGGER "PaymentApproval_authority_live" BEFORE INSERT ON "PaymentApproval"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_authority_live();

CREATE OR REPLACE FUNCTION phase5_t6a_payment_authority_live() RETURNS trigger AS $$
DECLARE v_certificate text;
BEGIN
  SELECT a."certificateId" INTO v_certificate FROM "PaymentApproval" a
   WHERE a."projectId" = NEW."projectId" AND a."id" = NEW."approvalId";
  PERFORM phase5_t6a_assert_certificate_live(
    NEW."projectId", NEW."billId", v_certificate, 'Payment', NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Payment_authority_live" ON "Payment";
CREATE TRIGGER "Payment_authority_live" BEFORE INSERT ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_authority_live();


CREATE OR REPLACE FUNCTION phase5_t6a_certificate_paid_bound_sealed() RETURNS trigger AS $$
BEGIN
  IF NEW."supersededAt" IS NULL OR OLD."supersededAt" IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM phase5_t6a_paid_bound_check(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── §I — the payment half of the SoD record ──────────────────────────────────────────────────
--
-- `SodException` already exists from Task 5 with a nullable `certificateId` and a comment reserving
-- this half. An exception is authority for ONE act, never a standing waiver a later override can
-- point at, so a row names exactly one fact.
ALTER TABLE "SodException" ADD COLUMN IF NOT EXISTS "approvalId" TEXT;
-- …and the GRANT the override rests on is consumed by exactly one act, of exactly one KIND. Task 5
-- shipped `consumedByCertificateId`; the payment half needs its own target, because a grant that
-- could point at either would make "which act spent this authority?" unanswerable.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "consumedByApprovalId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_approval_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_approval_fkey" FOREIGN KEY ("projectId", "approvalId")
    REFERENCES "PaymentApproval"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_approval_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_approval_fkey" FOREIGN KEY ("projectId", "consumedByApprovalId")
    REFERENCES "PaymentApproval"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- Task 5B shipped this NAME as `CHECK ("certificateId" IS NOT NULL)`, so an `IF NOT EXISTS`
  -- guard silently skips the replacement and the approval side stays UNREACHABLE — the column
  -- exists, the FK exists, and every insert with a null `certificateId` is refused by a constraint
  -- written before there was a second fact to name. Dropping by name first is the only way to widen
  -- a CHECK, and it is safe here because the new one is strictly narrower on the certificate side.
  ALTER TABLE "SodException" DROP CONSTRAINT IF EXISTS "SodException_names_one_fact";
  ALTER TABLE "SodException" ADD CONSTRAINT "SodException_names_one_fact"
  CHECK (("certificateId" IS NOT NULL AND "approvalId" IS NULL)
      OR ("certificateId" IS NULL AND "approvalId" IS NOT NULL));
  -- the same widening on the grant's consumption, and for the same reason: 5B's CHECK named the
  -- certificate alone, so with a second target it would forbid every payment-side consume. Both
  -- halves still move together, and exactly ONE target is named — an authority is exercised once.
  ALTER TABLE "SodGrant" DROP CONSTRAINT IF EXISTS "SodGrant_consumed_together";
  ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together"
  CHECK (("consumedAt" IS NULL AND "consumedByCertificateId" IS NULL AND "consumedByApprovalId" IS NULL)
      OR ("consumedAt" IS NOT NULL
          AND (("consumedByCertificateId" IS NOT NULL)::int + ("consumedByApprovalId" IS NOT NULL)::int) = 1));
END $$;
CREATE INDEX IF NOT EXISTS "SodException_projectId_approvalId_idx" ON "SodException"("projectId", "approvalId");
-- ONE override per approval per rule, mirroring `SodException_certificate_rule_key`. A second row
-- would make "the authority that excused this" ambiguous, and ambiguity in an authority record is
-- the same as not having one.
CREATE UNIQUE INDEX IF NOT EXISTS "SodException_approval_rule_key"
  ON "SodException"("projectId", "approvalId", "rule") WHERE "approvalId" IS NOT NULL;


-- ── §I sealed at PostgreSQL — the certifier may not approve ──────────────────────────────────
--
-- The service refuses this, and until now that was the ONLY thing refusing it. A bypass writer can
-- mint a succeeded `commercial.payment.approve` command for the actor who certified and insert a
-- within-net approval: every other constraint here passes, and the append-only authority row is
-- forged. The rule this whole task exists for was the one rule not sealed.
--
-- The exception path is honoured rather than banned — §I is explicit that a two-person practice
-- must still be able to operate — but an override is only an override if the AUTHORITY ACTUALLY
-- ACTED. That predicate is `phase5_t6a_approval_override_valid`, below, and it is defined ONCE:
-- this trigger and the exception's own seal both call it, so "what makes an override real" cannot
-- be answered two ways by the two rows that answer it.
CREATE OR REPLACE FUNCTION phase5_t6a_approval_override_valid(p_project text, p_approval text)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "SodException" s
      JOIN "PaymentApproval" a  ON a."projectId"  = s."projectId" AND a."id"  = s."approvalId"
      JOIN "BillCertificate" c  ON c."projectId"  = a."projectId" AND c."id"  = a."certificateId"
      JOIN "CommandExecution" ace ON ace."projectId" = a."projectId" AND ace."id" = a."sourceCommandId"
      JOIN "SodGrant" g         ON g."projectId"  = s."projectId" AND g."id"  = s."grantId"
      JOIN "CommandExecution" gce ON gce."projectId" = g."projectId" AND gce."id" = g."sourceCommandId"
     WHERE s."projectId" = p_project AND s."approvalId" = p_approval
       -- the override names THIS rule. A grant issued so a store user could CERTIFY is not
       -- permission for anyone to approve that claim's payment; §I has two halves and one row
       -- must not silently satisfy the other.
       AND s."rule" = 'certifier-may-not-approve'
       -- the actor the rule would have refused IS the approver of the row being excused
       AND s."actorId" = a."approvedById"
       AND s."approverId" <> s."actorId"
       -- …produced by the SAME command as the act it excuses, proven by that command's RECEIPT
       -- rather than by two rows copying one id: `executeCommand` writes status and `resultRef`
       -- inside the act's own transaction, so at COMMIT the receipt either says it produced THIS
       -- approval or the override is not this act's.
       AND s."sourceCommandId" = a."sourceCommandId"
       AND ace."commandType" = 'commercial.payment.approve'
       AND ace."status" = 'succeeded'
       AND ace."resultRef" = a."id"
       AND ace."actorId" = a."approvedById"
       -- …and it rests on a GRANT, which is the whole point. Codex round 2 (P1): the earlier seal
       -- tested `EXISTS` on the exception, so a direct writer could insert the forbidden approval
       -- plus an exception naming any colleague as `approverId` and reusing the approval's own
       -- command id. "A different id" is not a stronger authority; it is a name typed into a
       -- field. Task 5's certification half already learned this (its rounds 7 and 8), and the
       -- correction did not travel to the sibling created for the payment half.
       AND g."approverId" = s."approverId"
       AND g."actorId"    = s."actorId"
       AND g."rule"       = s."rule"
       AND g."billId"     = a."billId"
       -- version-pinned: an amendment is a different claim, and permission to release money
       -- against the one the approver looked at must not survive it
       AND g."versionId"  = c."versionId"
       -- the REASON is the approver's, not the excused actor's — the read surface reports the
       -- exception's reason as the authorisation, so leaving it free lets the person being
       -- excused write the one sentence a reviewer trusts
       AND g."reason"     = s."reason"
       -- SINGLE-USE, and consumed by THIS approval
       AND g."consumedByApprovalId" = a."id"
       -- …and the grant itself is the approver's own authenticated act, by its receipt
       AND gce."commandType" = 'commercial.sod.grant'
       AND gce."status" = 'succeeded'
       AND gce."actorId" = g."approverId"
       AND gce."resultRef" = g."id"
  );
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION phase5_t6a_approver_not_certifier() RETURNS trigger AS $$
DECLARE v_certifier text;
BEGIN
  SELECT c."certifiedById" INTO v_certifier FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."certificateId";

  IF v_certifier IS DISTINCT FROM NEW."approvedById" THEN RETURN NULL; END IF;

  IF phase5_t6a_approval_override_valid(NEW."projectId", NEW."id") THEN
    RETURN NULL;  -- an attributable override resting on the approver's own act, which §I requires
  END IF;

  RAISE EXCEPTION 'Approval % is made by %, who certified this claim — certification says what is owed and approval releases it, and one person doing both is the separation §I exists to keep; a different approver, or an override resting on a `certifier-may-not-approve` grant a pmc with standing issued and this act consumed, is required', NEW."id", NEW."approvedById";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentApproval_approver_not_certifier" ON "PaymentApproval";
CREATE CONSTRAINT TRIGGER "PaymentApproval_approver_not_certifier"
  AFTER INSERT ON "PaymentApproval" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approver_not_certifier();

-- ── §G bound 5 also fires when a CERTIFICATE is superseded ───────────────────────────────────
--
-- The paid fold deliberately excludes approvals on superseded certificates, and that exclusion is
-- what makes the bound meaningful. But it also means supersession itself can BREAK the bound with
-- no `Payment` insert to notice: approve ₹100, pay ₹100, then supersede — the approval drops out of
-- `APPROVED` while the payment stays in `PAID`, leaving ₹100 paid against ₹0 approved.
--
-- That is reachable on the ORDINARY service path, not by a bypass writer, which makes it the more
-- important half. A rule enforced on one write and not on the write that invalidates it has not
-- been enforced — the same shape as the deduction-after-approval seal above. Same rule, every site.
DROP TRIGGER IF EXISTS "BillCertificate_paid_bound_sealed" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_paid_bound_sealed"
  AFTER UPDATE ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_certificate_paid_bound_sealed();

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

-- ── §I — the APPROVAL side of the exception carries the same evidence seals ──────────────────
--
-- Task 5B's `phase5_t5_sod_exception_sealed` returns early when `certificateId IS NULL`, which is
-- every approval-side row: adding the column alone would have given this half of the authority
-- table an immutability trigger and NO insert-side validation at all. §I is explicit that an
-- exception IS the thing making an otherwise-forbidden act valid, so an unvalidated one is
-- indistinguishable from no override.
--
-- What it must prove: the approval exists in THIS project (the FK), the exception is written in the
-- same transaction as the act it authorises (the approval must be visible), the reason is real, and
-- the rule names the payment rule rather than borrowing the certification one.
CREATE OR REPLACE FUNCTION phase5_t6a_sod_exception_approval_sealed() RETURNS trigger AS $$
DECLARE
  v_approver  text;
  v_certifier text;
BEGIN
  IF NEW."approvalId" IS NULL THEN RETURN NULL; END IF;

  SELECT a."approvedById", c."certifiedById" INTO v_approver, v_certifier
    FROM "PaymentApproval" a
    JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
   WHERE a."projectId" = NEW."projectId" AND a."id" = NEW."approvalId";
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'SoD exception % names approval %, which does not exist in this project — an override is authority for ONE act and must be written with it', NEW."id", NEW."approvalId";
  END IF;

  -- the actor the rule would have refused IS the approver of the row being excused; an exception
  -- naming somebody else excuses nobody and leaves the real act unauthorised
  IF NEW."actorId" IS DISTINCT FROM v_approver THEN
    RAISE EXCEPTION 'SoD exception % excuses % but approval % was made by % — an override names the actor it authorises', NEW."id", NEW."actorId", NEW."approvalId", v_approver;
  END IF;
  -- and it may not excuse itself: the stronger authority is a DIFFERENT person
  IF NEW."approverId" = NEW."actorId" THEN
    RAISE EXCEPTION 'SoD exception % is authorised by the same person it excuses — an override needs a stronger authority, not the same one twice', NEW."id";
  END IF;
  IF NEW."rule" <> 'certifier-may-not-approve' THEN
    RAISE EXCEPTION 'SoD exception % names rule "%" on an approval — the payment-side rule is `certifier-may-not-approve`, and an override that names the wrong rule documents an act nobody reviewed', NEW."id", NEW."rule";
  END IF;

  -- §I is a BICONDITIONAL, and the certificate half has enforced both directions since Task 5. An
  -- override on an approval the rule would never have refused authorises nothing, and a trail that
  -- carries one reports a conflict that did not happen.
  IF v_certifier IS DISTINCT FROM v_approver THEN
    RAISE EXCEPTION 'SoD exception % excuses approval %, which was made by % while % certified the claim — the rule permits that act outright, and an override for a conflict that does not exist records an authorisation nobody needed', NEW."id", NEW."approvalId", v_approver, COALESCE(v_certifier, '(nobody)');
  END IF;

  -- …and the whole of what makes it REAL, asked of the one predicate that states it. Codex round 2
  -- (P1): the earlier seal validated the exception's SHAPE and never proved the approver acted, so
  -- a direct writer could name any colleague and reuse the approval's own command id. The grant is
  -- the signature; `phase5_t6a_approval_override_valid` is where that is stated, once, for both
  -- this row and the approval that leans on it.
  IF NOT phase5_t6a_approval_override_valid(NEW."projectId", NEW."approvalId") THEN
    RAISE EXCEPTION 'SoD exception % does not rest on a `certifier-may-not-approve` grant this approval consumed — an override is legitimate because a stronger authority ACTED, and a name in a field is not that act; a pmc with standing must issue the grant with `commercial.sod.grant` and this approval must consume it', NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodException_approval_sealed" ON "SodException";
CREATE CONSTRAINT TRIGGER "SodException_approval_sealed"
  AFTER INSERT ON "SodException" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_sod_exception_approval_sealed();

-- ── …and the GRANT's own consume transition, for the target this task added ───────────────────
--
-- Codex round 3 (P2). Task 5's `phase5_t5_grant_sealed` validates a consumed grant against the
-- certificate that spent it — and its clause is guarded by `consumedByCertificateId IS NOT NULL`,
-- so an approval-side consume skips it ENTIRELY. Adding `consumedByApprovalId` therefore put a new
-- evidence target under an existing append-only path with nothing checking it: a direct writer
-- could stamp `consumedAt` plus any approval id, satisfying the widened CHECK and the FK, and
-- permanently burn an approver's authority against an act it never excused.
--
-- This is a SEPARATE trigger rather than a `CREATE OR REPLACE` of 5B's function, deliberately.
-- Replacing it would mean copying its two cleared clauses forward, and a seal that judges a copy
-- as an original is the root this PR's audit already names twice. 5B's function is untouched; this
-- one answers only for the arm 6A created, and the two compose because both are constraint
-- triggers on the same table firing at COMMIT.
CREATE OR REPLACE FUNCTION phase5_t6a_grant_approval_consume_sealed() RETURNS trigger AS $$
BEGIN
  IF NEW."consumedByApprovalId" IS NULL THEN RETURN NULL; END IF;

  -- the mirror of 5B clause (c): a consumed grant names an act that actually rests on it, matched
  -- on the WHOLE scope — rule, actor, approver, bill and claim version — not merely on existence
  IF NOT EXISTS (
    SELECT 1 FROM "SodException" s
      JOIN "PaymentApproval" a ON a."projectId" = s."projectId" AND a."id" = s."approvalId"
      JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
     WHERE s."projectId" = NEW."projectId" AND s."grantId" = NEW."id"
       AND s."approvalId" = NEW."consumedByApprovalId"
       AND s."rule" = NEW."rule" AND s."actorId" = NEW."actorId" AND s."approverId" = NEW."approverId"
       AND a."billId" = NEW."billId" AND c."versionId" = NEW."versionId"
  ) THEN
    RAISE EXCEPTION 'Grant % was stamped consumed by approval %, which carries no matching override — an authority is spent BY the act it excuses, on the same rule, actor, approver, bill and claim version', NEW."id", NEW."consumedByApprovalId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodGrant_approval_consume_sealed" ON "SodGrant";
CREATE CONSTRAINT TRIGGER "SodGrant_approval_consume_sealed"
  AFTER INSERT OR UPDATE ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_grant_approval_consume_sealed();

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

-- ── §B — an APPROVAL is a headroom mover, and `raisedBy` must be able to say so ──────────────
--
-- Codex round 2 (P2). §J defines `certified-payable` as `NET_PAYABLE − APPROVED`, so this task
-- taught the budget fold a new subtraction — and a write that moves a fold input must raise or
-- clear the over-budget exception in its own transaction. `raisedBy` is the durable explanation a
-- human reads months later, so the approval gets its OWN label rather than borrowing `claim`: an
-- approval-cleared exception labelled `claim` sends a PMC hunting for a vendor claim that never
-- changed. Same widening shape every prior task used for the same CHECK.
ALTER TABLE "BudgetException" DROP CONSTRAINT IF EXISTS "BudgetException_raisedBy_check";
ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check"
  CHECK ("raisedBy" IN ('commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress', 'measurement', 'claim', 'deduction', 'deduction_release', 'payment_approval'));

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
