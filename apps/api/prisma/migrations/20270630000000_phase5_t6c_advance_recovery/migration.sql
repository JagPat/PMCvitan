-- Phase 5 Task 6C (§H) — the ADVANCE, and the recovery that draws it down.
--
-- Task 5C shipped `retention`, `penalty` and `other` and left `advance-recovery` out ON PURPOSE,
-- with the reason in its own comment: the type "folds against an `advance` row created when the
-- advance is PAID, so the enum member arrives in Task 6 with the row that caps it. §0b's 'every
-- declared member is in the fold' then holds at BOTH stages rather than being briefly false."
--
-- This is that arrival. The member and the row it folds against land together, in one migration,
-- because either alone is a rule with nothing behind it: the type without the advance is a
-- withholding bounded by nothing, and the advance without the type is cash with no way home.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY AN ADVANCE IS NOT A `Payment`
-- ══════════════════════════════════════════════════════════════════════════════════════════════
--
-- A `Payment` is nested under a `PaymentApproval` on a `BillCertificate`. That nesting is what
-- makes §G bound 5 askable at all — `PAID(bill) ≤ APPROVED(bill)` compares two folds scoped to the
-- same claim. An advance has neither parent: it is paid against the commercial relationship before
-- any claim certifies, and forcing it into `Payment` would need a fabricated approval on a
-- certificate nobody has issued.
--
-- The consequence to state plainly, because it is the thing a reader will want checked: a
-- `VendorAdvance` row must NEVER enter `PAID(bill)`. It does not, and cannot — `paidFor` folds
-- `"Payment"` and `"PaymentReversal"` by `billId`, and this table has no `billId` to be folded by.
-- The advance reaches a bill only through an `advance-recovery` DEDUCTION, which lowers
-- `NET_PAYABLE` (money the vendor no longer receives) rather than raising `PAID` (money the vendor
-- received). Those are different facts and §H keeps them apart.
--
-- The recovery is a `BillDeduction` TYPE and not a new table, for the same reason: it withholds
-- from a certified payable exactly as a retention does, so §H's `NET_PAYABLE` floor, the
-- append-only seal, the release path and the §F re-derivation already govern it. What is new is
-- the CEILING — a retention is bounded by the certificate, and a recovery is bounded by cash that
-- actually went out.

-- ── the paid-advance fact ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "VendorAdvance" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "vendorId"        TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "reason"          TEXT NOT NULL,
  "method"          TEXT NOT NULL,
  "reference"       TEXT,
  "paidAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidById"        TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "VendorAdvance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VendorAdvance_projectId_id_key" ON "VendorAdvance"("projectId", "id");
CREATE INDEX IF NOT EXISTS "VendorAdvance_projectId_vendorId_idx" ON "VendorAdvance"("projectId", "vendorId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_projectId_fkey') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the SAME `ProjectVendor` binding a bill uses (§H tenancy). An advance paid to one counterparty
  -- is unrepresentable against another's claim, and unrepresentable against a vendor this project
  -- never bound.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_binding_fkey') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_binding_fkey" FOREIGN KEY ("projectId", "vendorId")
    REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_paidById_fkey') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_command_fkey') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_amount_positive') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_amount_positive" CHECK ("amount" > 0);
  END IF;
  -- presence is not justification (Phase-4 Task 5, after `btrim` alone let whitespace through)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_reason_nonblank') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_reason_nonblank"
    CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_method_nonblank') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_method_nonblank"
    CHECK (btrim("method", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorAdvance_reference_nonblank') THEN
    ALTER TABLE "VendorAdvance" ADD CONSTRAINT "VendorAdvance_reference_nonblank"
    CHECK ("reference" IS NULL OR btrim("reference", E' \t\n\x0B\f\r') <> '');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION phase5_t6c_advance_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VendorAdvance rows are append-only — cash that left is evidence, and recovering it is a deduction against a certified claim, never an edit to this row';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorAdvance_append_only" ON "VendorAdvance";
CREATE TRIGGER "VendorAdvance_append_only" BEFORE DELETE OR UPDATE ON "VendorAdvance"
  FOR EACH ROW EXECUTE FUNCTION phase5_t6c_advance_append_only();

-- ── the enum member, arriving WITH the row that caps it ──────────────────────────────────────
--
-- 5C's CHECK is REPLACED rather than dropped-and-recreated blind: the new one is strictly wider,
-- so every row it admitted is still admissible and the widening cannot fail on existing data.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_type_known') THEN
    ALTER TABLE "BillDeduction" DROP CONSTRAINT "BillDeduction_type_known";
  END IF;
  ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_type_known"
  CHECK ("type" IN ('retention', 'advance-recovery', 'penalty', 'other'));
END $$;

-- ── the CEILING: a recovery cannot recover more cash than went out ────────────────────────────
--
-- `RECOVERABLE(vendor) = Σ VendorAdvance − Σ advance-recovery`, over ONE counterparty, with no
-- stored balance anywhere. Probe 5bp is explicit that this is the fold and that a cumulative
-- overshoot is refused naming the balance.
--
-- **Why the bound is VENDOR-scoped and not per-advance.** 6B-ii bounded a reversal by its OWN
-- payment, because a payment is nested under one authority and an aggregate can be conserved while
-- the attribution is a lie. An advance is not an authority — it is a POOL. A vendor holding a ₹100
-- mobilisation advance and a ₹50 materials advance recovers ₹120 from the next bill without any
-- fact of the matter about which row it came from, and forcing a choice would put an `advanceId`
-- column on `BillDeduction` that no other type uses and that the practice would have to invent an
-- answer for. What DOES have a fact of the matter is the counterparty, and that is what the fold
-- and this seal are scoped by.
--
-- **The serialization point is the `ProjectVendor` row, and it has to be.** §0b takes the BILL
-- first, and that is enough when a bound is bill-scoped — but this one is not. Two recoveries on
-- two DIFFERENT bills of the same vendor take two different bill locks and never meet, so under
-- READ COMMITTED both read the same ₹100 recoverable, both pass, and both commit: ₹200 recovered
-- against ₹100 that went out, with every row append-only. The vendor binding is the one row both
-- transactions must touch, so it is the lock, taken AFTER the bill so the order stays total
-- (bill → vendor) and no honest transaction can be waiting on it in the other direction.
CREATE OR REPLACE FUNCTION phase5_t6c_recoverable_check(p_project text, p_vendor text)
RETURNS void AS $$
DECLARE
  v_lock      text;
  v_advanced  numeric;
  v_recovered numeric;
BEGIN
  SELECT pv."id" INTO v_lock FROM "ProjectVendor" pv
   WHERE pv."projectId" = p_project AND pv."vendorId" = p_vendor
     FOR UPDATE;
  IF v_lock IS NULL THEN RETURN; END IF;   -- the FK is what refuses an unbound vendor

  SELECT COALESCE(SUM(a."amount"), 0) INTO v_advanced
    FROM "VendorAdvance" a
   WHERE a."projectId" = p_project AND a."vendorId" = p_vendor;

  -- every advance-recovery on ANY of this counterparty's claims, live certificate or superseded.
  -- A superseded certificate's deductions leave `NET_PAYABLE` (§H) but the cash they recovered did
  -- not come back — supersession never refunds an advance — so scoping this to live certificates
  -- would free the recovered balance for a second recovery of the same money.
  SELECT COALESCE(SUM(d."amount"), 0) INTO v_recovered
    FROM "BillDeduction" d
    JOIN "VendorBill" b ON b."projectId" = d."projectId" AND b."id" = d."billId"
   WHERE d."projectId" = p_project AND b."vendorId" = p_vendor
     AND d."type" = 'advance-recovery';

  IF v_recovered > v_advanced THEN
    RAISE EXCEPTION 'Advance recoveries of % stand against % actually advanced to this counterparty — a recovery takes back money that went out, and there is no more of it to take (%)', v_recovered, v_advanced, p_vendor;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6c_recovery_bound_sealed() RETURNS trigger AS $$
DECLARE v_vendor text;
BEGIN
  IF NEW."type" IS DISTINCT FROM 'advance-recovery' THEN RETURN NULL; END IF;
  SELECT b."vendorId" INTO v_vendor FROM "VendorBill" b
   WHERE b."projectId" = NEW."projectId" AND b."id" = NEW."billId";
  IF v_vendor IS NOT NULL THEN PERFORM phase5_t6c_recoverable_check(NEW."projectId", v_vendor); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Named to fire FIRST among this table's deferred seals. PostgreSQL runs same-event AFTER triggers
-- in name order, and `BillDeduction_advance_bound_sealed` sorts before
-- `BillDeduction_approved_bound_sealed` and `BillDeduction_t6b_status_sealed`. That ordering is not
-- decorative: this one takes the vendor row, and 6B-i's status seal then takes the bill `NOWAIT`.
-- A writer that skipped the service holds neither, so it acquires the vendor and then fails closed
-- on the bill rather than waiting for it in the wrong order.
DROP TRIGGER IF EXISTS "BillDeduction_advance_bound_sealed" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_advance_bound_sealed"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6c_recovery_bound_sealed();

-- ── provenance: the command that PRODUCED the row ────────────────────────────────────────────
--
-- 6A's function, with its fourth arm. Replaced rather than duplicated: `TG_TABLE_NAME` already
-- carried the switch, and a sibling function would be the same rule at a second site — the exact
-- shape `docs/reviews/pr-289-convergence.md` calls root A. The three existing arms are
-- byte-identical to what 6B-ii left.
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
    WHEN 'VendorAdvance'   THEN 'commercial.advance.pay'
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

DROP TRIGGER IF EXISTS "VendorAdvance_command_succeeded" ON "VendorAdvance";
CREATE CONSTRAINT TRIGGER "VendorAdvance_command_succeeded"
  AFTER INSERT ON "VendorAdvance" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6a_command_succeeded();

-- ── this migration ADDS a fact and INVENTS none ──────────────────────────────────────────────
--
-- A legacy database has no advances and no `advance-recovery` rows — the type was not admissible
-- until the CHECK above widened — so the new fold reads zero on both sides, no bound changes for
-- any existing row, and no backfill is needed or performed. The assertion is what proves that
-- rather than the claim.
DO $$
DECLARE v_rows bigint; v_recoveries bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "VendorAdvance";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t6c: "VendorAdvance" already holds % row(s) before its own migration completed — this table is created here, so a populated one means the schema was reached by a path this file does not describe', v_rows;
  END IF;
  -- …and the widened member must arrive with nothing already claiming it. A pre-existing
  -- `advance-recovery` row would be a withholding that was never bounded by cash, which is exactly
  -- the state this task exists to make unrepresentable.
  SELECT COUNT(*) INTO v_recoveries FROM "BillDeduction" WHERE "type" = 'advance-recovery';
  IF v_recoveries <> 0 THEN
    RAISE EXCEPTION 'phase5_t6c: % advance-recovery deduction(s) exist before the advance that caps them — 5C''s CHECK made the type inadmissible, so these were written by a path that bypassed it and their ceiling cannot be reconstructed', v_recoveries;
  END IF;
END $$;
