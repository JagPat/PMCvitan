-- Phase 5 Task 5B — certification, its frozen consumption sets, §G bound 3, and the §I
-- segregation-of-duties exception.
--
-- ADDITIVE ONLY. Four new tables; not one byte of an earlier migration is touched. Every table is
-- append-only, because each row is EVIDENCE for money: a certificate authorises payment, a
-- consumption row records WHICH acceptance or measurement the certificate consumed and HOW MUCH of
-- each, and an SoD exception is the authority that made an otherwise-forbidden certification valid.
-- A row that can be edited afterwards is indistinguishable from no evidence at all.
--
-- §H's deduction ledger and §G bound 4's NET_PAYABLE floor are Task 5C's and are NOT here. Bound 3
-- stands alone and is complete without them: `CERTIFIED(bill) <= BILLED_AMOUNT(bill)`.
--
-- **There is no `supersededByCertificateId` column.** An earlier draft carried one whose only
-- writer set it to the superseding certificate's OWN id — a column every value of which was wrong.
-- Lineage is the ordered certificate chain on the bill, which needs no column to be true.

CREATE TABLE IF NOT EXISTS "BillCertificate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "certifiedAmount" DECIMAL(18,2) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,
    "certifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "certifiedById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "BillCertificate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CertifiedAcceptanceConsumption" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "stockTransactionId" TEXT NOT NULL,
    "consumedQty" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "CertifiedAcceptanceConsumption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CertifiedMeasurementConsumption" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "measurementId" TEXT NOT NULL,
    "consumedQty" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "CertifiedMeasurementConsumption_pkey" PRIMARY KEY ("id")
);



CREATE TABLE IF NOT EXISTS "SodException" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "certificateId" TEXT,
    "rule" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "SodException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillCertificate_projectId_id_key" ON "BillCertificate"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "BillCertificate_projectId_id_billId_key" ON "BillCertificate"("projectId", "id", "billId");
CREATE INDEX IF NOT EXISTS "BillCertificate_projectId_billId_idx" ON "BillCertificate"("projectId", "billId");
CREATE UNIQUE INDEX IF NOT EXISTS "CertifiedAcceptanceConsumption_projectId_id_key" ON "CertifiedAcceptanceConsumption"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CertifiedAcceptanceConsumption_cert_row_key" ON "CertifiedAcceptanceConsumption"("projectId", "certificateId", "stockTransactionId");
CREATE INDEX IF NOT EXISTS "CertifiedAcceptanceConsumption_projectId_stockTransactionId_idx" ON "CertifiedAcceptanceConsumption"("projectId", "stockTransactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "CertifiedMeasurementConsumption_projectId_id_key" ON "CertifiedMeasurementConsumption"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CertifiedMeasurementConsumption_cert_row_key" ON "CertifiedMeasurementConsumption"("projectId", "certificateId", "measurementId");
CREATE INDEX IF NOT EXISTS "CertifiedMeasurementConsumption_projectId_measurementId_idx" ON "CertifiedMeasurementConsumption"("projectId", "measurementId");
CREATE UNIQUE INDEX IF NOT EXISTS "SodException_projectId_id_key" ON "SodException"("projectId", "id");
CREATE INDEX IF NOT EXISTS "SodException_projectId_certificateId_idx" ON "SodException"("projectId", "certificateId");

-- §F/§G — EXACTLY ONE LIVE CERTIFICATE PER BILL. Bounds 3–5 read the live certificate only:
-- summing a superseded one reads a corrected ₹100 certification as ₹200, which either blocks the
-- correction or overstates the forecast.
CREATE UNIQUE INDEX IF NOT EXISTS "BillCertificate_one_live_key"
  ON "BillCertificate"("projectId", "billId") WHERE "supersededAt" IS NULL;

-- The FK below proves a certificate's version belongs to THE BILL IT NAMES, and that needs a
-- candidate key `VendorBillVersion` does not yet carry: its Task-4 key is
-- `(projectId, id, billId, vendorIdPin)`, which a certificate has no business restating. Adding
-- the narrower key is additive and keeps the proof; dropping `billId` from the FK would have kept
-- the migration running while letting a certificate name another bill's version.
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_projectId_id_billId_key"
  ON "VendorBillVersion"("projectId", "id", "billId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_projectId_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_bill_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_bill_fkey" FOREIGN KEY ("projectId", "billId") REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- the certificate names the exact claim VERSION it was computed against, and that version must
  -- belong to THIS bill: a certificate pointing at another bill's version would be certified
  -- against money it never read (composite FK, not a bare reference)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_version_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_version_fkey" FOREIGN KEY ("projectId", "versionId", "billId") REFERENCES "VendorBillVersion"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_certifiedById_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_certifiedById_fkey" FOREIGN KEY ("certifiedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_supersededById_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_sourceCommand_fkey') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedAcceptanceConsumption_projectId_fkey') THEN
    ALTER TABLE "CertifiedAcceptanceConsumption" ADD CONSTRAINT "CertifiedAcceptanceConsumption_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedAcceptanceConsumption_certificate_fkey') THEN
    ALTER TABLE "CertifiedAcceptanceConsumption" ADD CONSTRAINT "CertifiedAcceptanceConsumption_certificate_fkey" FOREIGN KEY ("projectId", "certificateId") REFERENCES "BillCertificate"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- the consumed row is a REAL acceptance in THIS project — the composite FK is the authority,
  -- exactly as the cleared attendance-evidence precedent has it
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedAcceptanceConsumption_tx_fkey') THEN
    ALTER TABLE "CertifiedAcceptanceConsumption" ADD CONSTRAINT "CertifiedAcceptanceConsumption_tx_fkey" FOREIGN KEY ("projectId", "stockTransactionId") REFERENCES "StockTransaction"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedMeasurementConsumption_projectId_fkey') THEN
    ALTER TABLE "CertifiedMeasurementConsumption" ADD CONSTRAINT "CertifiedMeasurementConsumption_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedMeasurementConsumption_certificate_fkey') THEN
    ALTER TABLE "CertifiedMeasurementConsumption" ADD CONSTRAINT "CertifiedMeasurementConsumption_certificate_fkey" FOREIGN KEY ("projectId", "certificateId") REFERENCES "BillCertificate"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedMeasurementConsumption_measurement_fkey') THEN
    ALTER TABLE "CertifiedMeasurementConsumption" ADD CONSTRAINT "CertifiedMeasurementConsumption_measurement_fkey" FOREIGN KEY ("projectId", "measurementId") REFERENCES "Measurement"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;



  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_projectId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- §I — bound BY COMPOSITE FK to the exact fact it authorizes. An exception is authority for ONE
  -- certificate, never a standing waiver a later override can point at.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_certificate_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_certificate_fkey" FOREIGN KEY ("projectId", "certificateId") REFERENCES "BillCertificate"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_actorId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_approverId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_sourceCommand_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- §A — money is strictly positive where a zero row would be a fact that says nothing
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_amount_positive') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_amount_positive" CHECK ("certifiedAmount" > 0);
  END IF;
  -- the supersession stamp is all-or-nothing: a half-stamped certificate is unattributable
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillCertificate_supersede_complete') THEN
    ALTER TABLE "BillCertificate" ADD CONSTRAINT "BillCertificate_supersede_complete" CHECK (
      ("supersededAt" IS NULL AND "supersededById" IS NULL AND "supersedeReason" IS NULL)
      OR ("supersededAt" IS NOT NULL AND "supersededById" IS NOT NULL AND "supersedeReason" IS NOT NULL AND btrim("supersedeReason", E' \t\n\x0B\f\r') <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedAcceptanceConsumption_qty_positive') THEN
    ALTER TABLE "CertifiedAcceptanceConsumption" ADD CONSTRAINT "CertifiedAcceptanceConsumption_qty_positive" CHECK ("consumedQty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CertifiedMeasurementConsumption_qty_positive') THEN
    ALTER TABLE "CertifiedMeasurementConsumption" ADD CONSTRAINT "CertifiedMeasurementConsumption_qty_positive" CHECK ("consumedQty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_reason_nonblank') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_reason_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_rule_nonblank') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_rule_nonblank" CHECK (btrim("rule", E' \t\n\x0B\f\r') <> '');
  END IF;
  -- §I — an exception names EXACTLY ONE fact. Task 6 adds the approval-side reference beside this
  -- one; a row naming neither is a standing waiver, which is the thing this record must never be.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_names_one_fact') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_names_one_fact" CHECK ("certificateId" IS NOT NULL);
  END IF;
  -- §I — an exception is authority for someone OTHER than the approver. A row where the actor
  -- approves their own override is not a segregation control, it is a signature on a mirror.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_actor_is_not_approver') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_actor_is_not_approver" CHECK ("actorId" <> "approverId");
  END IF;
END $$;

-- ── APPEND-ONLY, six tables ────────────────────────────────────────────────────────────────────
--
-- A certificate authorises payment, a consumption row records the evidence it drew on, a deduction
-- withholds cash and an SoD exception IS the authority that made an otherwise-forbidden
-- certification valid. Every one of them is evidence for money, so every one is append-only. The
-- certificate has exactly ONE permitted transition — the supersession stamp — and nothing else.

CREATE OR REPLACE FUNCTION phase5_t5_certificate_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A certificate is never deleted — it authorised money, and the correction path is a superseding certificate (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."billId" <> OLD."billId"
     OR NEW."versionId" <> OLD."versionId" OR NEW."certifiedAmount" <> OLD."certifiedAmount"
     OR NEW."certifiedAt" <> OLD."certifiedAt" OR NEW."certifiedById" <> OLD."certifiedById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A certificate is IMMUTABLE — the amount it authorised and who authorised it are the evidence a payment rests on (%)', OLD."id";
  END IF;
  -- the ONE permitted transition, and it is one-way: a superseded certificate never returns
  IF OLD."supersededAt" IS NOT NULL
     AND (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"
          OR NEW."supersededById" IS DISTINCT FROM OLD."supersededById"
          OR NEW."supersedeReason" IS DISTINCT FROM OLD."supersedeReason") THEN
    RAISE EXCEPTION 'A superseded certificate is history — its supersession stamp is not rewritable (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillCertificate_append_only" ON "BillCertificate";
CREATE TRIGGER "BillCertificate_append_only" BEFORE UPDATE OR DELETE ON "BillCertificate"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_certificate_append_only();

CREATE OR REPLACE FUNCTION phase5_t5_row_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are append-only — this row is evidence a payable fact rests on (%)', TG_TABLE_NAME, OLD."id";
  END IF;
  RAISE EXCEPTION '% rows are IMMUTABLE — a correction is a new row, never an edit (%)', TG_TABLE_NAME, OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CertifiedAcceptanceConsumption_append_only" ON "CertifiedAcceptanceConsumption";
CREATE TRIGGER "CertifiedAcceptanceConsumption_append_only" BEFORE UPDATE OR DELETE ON "CertifiedAcceptanceConsumption"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_row_immutable();
DROP TRIGGER IF EXISTS "CertifiedMeasurementConsumption_append_only" ON "CertifiedMeasurementConsumption";
CREATE TRIGGER "CertifiedMeasurementConsumption_append_only" BEFORE UPDATE OR DELETE ON "CertifiedMeasurementConsumption"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_row_immutable();
DROP TRIGGER IF EXISTS "SodException_append_only" ON "SodException";
CREATE TRIGGER "SodException_append_only" BEFORE UPDATE OR DELETE ON "SodException"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_row_immutable();


CREATE OR REPLACE FUNCTION phase5_t5_certified_bound_check(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_certified numeric;
  v_billed numeric;
  v_cert text;
BEGIN
  PERFORM 1 FROM "VendorBill" WHERE "projectId" = p_project AND "id" = p_bill FOR UPDATE;

  -- the LIVE certificate only (§G): a superseded one is retained history, and summing it reads a
  -- corrected ₹100 certification as ₹200
  SELECT c."id", c."certifiedAmount" INTO v_cert, v_certified
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;
  IF v_cert IS NULL THEN RETURN; END IF;

  -- §0 `BILLED_AMOUNT(bill)` — the BILL-scoped set: the live version's lines of a live bill
  SELECT COALESCE(SUM(l."amount"), 0) INTO v_billed
    FROM "VendorBillLine" l
    JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
    JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
   WHERE l."projectId" = p_project AND v."billId" = p_bill
     AND v."supersededAt" IS NULL
     AND b."status" NOT IN ('draft', 'rejected', 'disputed', 'resolved');

  -- §G bound 3
  IF v_certified > v_billed THEN
    RAISE EXCEPTION 'Bound 3 breached on bill %: the live certificate is % against a claimed %', p_bill, v_certified, v_billed;
  END IF;

END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_certificate_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_certified_bound_check(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;



-- Deferred to COMMIT, for the reason Task 4 established: a certificate's bill-scoped bound reads
-- rows written later in the same transaction, and a BEFORE trigger would fire before they exist.
DROP TRIGGER IF EXISTS "BillCertificate_bound_sealed" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_bound_sealed"
  AFTER INSERT OR UPDATE ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_certificate_sealed();



-- A bill's claim lines moving (an amendment) changes `BILLED_AMOUNT(bill)`, so bound 3 is
-- re-checked from the CLAIM side too — the §0b rule that a bound is checked by every writer of
-- either side, not only the side the task happens to be building.
CREATE OR REPLACE FUNCTION phase5_t5_bill_certified_recheck() RETURNS trigger AS $$
DECLARE v_bill text;
BEGIN
  SELECT v."billId" INTO v_bill FROM "VendorBillVersion" v
   WHERE v."projectId" = NEW."projectId" AND v."id" = NEW."versionId";
  IF v_bill IS NOT NULL THEN PERFORM phase5_t5_certified_bound_check(NEW."projectId", v_bill); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBillLine_certified_sealed" ON "VendorBillLine";
CREATE CONSTRAINT TRIGGER "VendorBillLine_certified_sealed"
  AFTER INSERT ON "VendorBillLine" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_bill_certified_recheck();

-- The migration is ADDITIVE and these tables are NEW, so a legacy database upgrades ROW-FREE.
-- Asserted rather than assumed, the Phase-4 discipline: if any row exists here the migration is
-- being applied to a database it was not written for, and it stops rather than guessing.
DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT (SELECT COUNT(*) FROM "BillCertificate")
       + (SELECT COUNT(*) FROM "CertifiedAcceptanceConsumption")
       + (SELECT COUNT(*) FROM "CertifiedMeasurementConsumption")
       + (SELECT COUNT(*) FROM "SodException") INTO v_rows;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t5: expected the six new tables to upgrade row-free, found % row(s)', v_rows;
  END IF;
END $$;

-- ── §F — the arrows Task 4 deliberately withheld ───────────────────────────────────────────────
--
-- Task 4 stopped the transition graph at `under-verification` and said so in as many words: "the
-- STATUSES stay in the CHECK vocabulary because §0's LIVE rule is defined over the whole set;
-- Task 5 adds these arrows WITH the evidence that makes them safe". That evidence now exists —
-- the §E verdict for `verified`, and a `BillCertificate` for `certified` — so the arrows open,
-- and none opens further than its evidence reaches. `approved-for-payment`, `part-paid` and
-- `paid` stay closed: their evidence is Task 6's.
CREATE OR REPLACE FUNCTION phase5_t4_bill_lifecycle() RETURNS trigger AS $$
DECLARE v_cert bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VendorBill rows are never deleted — a claim that was made is history (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."vendorId" <> OLD."vendorId"
     OR NEW."vendorBillNumber" <> OLD."vendorBillNumber" OR NEW."documentDate" <> OLD."documentDate"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A vendor bill''s identity is FROZEN — the document number and date are the duplicate-claim key (%)', OLD."id";
  END IF;
  IF NEW."statusReason" IS DISTINCT FROM OLD."statusReason"
     AND (NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" NOT IN ('disputed', 'rejected')) THEN
    RAISE EXCEPTION 'A vendor bill''s exit reason is FROZEN — it explains the transition that set it, and a rewritable justification is no justification (%)', OLD."id";
  END IF;
  IF NEW."statusChangedAt" IS DISTINCT FROM OLD."statusChangedAt"
     AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A vendor bill''s status timestamp is FROZEN outside its transition — it records WHEN the claim moved (%)', OLD."id";
  END IF;
  IF NEW."status" = 'disputed' AND OLD."status" IS DISTINCT FROM 'disputed' THEN
    NEW."disputedAtVersion" := (
      SELECT v."version" FROM "VendorBillVersion" v
       WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id" AND v."supersededAt" IS NULL
    );
    NEW."disputeReason" := NEW."statusReason";
  ELSE
    NEW."disputedAtVersion" := OLD."disputedAtVersion";
    NEW."disputeReason" := OLD."disputeReason";
  END IF;
  IF NEW."status" = 'resolved' AND OLD."status" IS DISTINCT FROM 'resolved' THEN
    IF OLD."disputedAtVersion" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "VendorBillVersion" v
       WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id"
         AND v."supersededAt" IS NULL AND v."supersedesVersion" = OLD."disputedAtVersion"
    ) THEN
      RAISE EXCEPTION 'A disputed claim is resolved by AMENDING it — version % must be superseded by a corrected version, and a resolution with no correction behind it would release the document number for a claim nobody fixed (%)', COALESCE(OLD."disputedAtVersion"::text, '?'), OLD."id";
    END IF;
    PERFORM phase5_t4_resolution_bound_check(NEW."projectId", NEW."id");
  END IF;
  -- Task 5 — `certified` is not a status a writer may simply assert: it is the SHADOW of a
  -- certificate row. Without this, maintenance SQL could mark a bill certified with no certificate
  -- behind it, and §G bounds 3–5 would all read a payable of zero while the status says money is
  -- authorised. The certificate is the fact; the status is its projection.
  IF NEW."status" = 'certified' AND OLD."status" IS DISTINCT FROM 'certified' THEN
    SELECT COUNT(*) INTO v_cert FROM "BillCertificate" c
     WHERE c."projectId" = NEW."projectId" AND c."billId" = NEW."id" AND c."supersededAt" IS NULL;
    IF v_cert <> 1 THEN
      RAISE EXCEPTION 'A bill is `certified` because a LIVE certificate exists for it, not because a status says so — found % (%)', v_cert, OLD."id";
    END IF;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'draft'              AND NEW."status" IN ('submitted', 'disputed', 'rejected'))
      OR (OLD."status" = 'submitted'          AND NEW."status" IN ('under-verification', 'disputed', 'rejected'))
      -- Task 5 — the §E verdict makes this arrow safe
      OR (OLD."status" = 'under-verification' AND NEW."status" IN ('verified', 'disputed', 'rejected'))
      -- Task 5 — a certificate makes this one safe. `verified -> disputed` is §E's withdrawal
      -- arrow, which exists precisely because a claim is live from the moment it is submitted.
      OR (OLD."status" = 'verified'           AND NEW."status" IN ('certified', 'disputed', 'rejected'))
      -- a certified bill returns to `verified` when its certificate is SUPERSEDED, which is §F's
      -- correction path. It never goes further back: rejection stops at `verified`, because §0
      -- drops a rejected bill from every billed set and that would free accepted quantity a
      -- certificate still stands on.
      OR (OLD."status" = 'certified'          AND NEW."status" = 'verified')
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal, a disputed one is corrected by a NEW version, and the arrows past `certified` belong to the task that produces their evidence (%)', OLD."status", NEW."status", OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
