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

-- ── §E — the CONSUMED ROW must be evidence THIS claim actually rests on ────────────────────────
--
-- Codex round-1 P2, both sides. The composite FKs prove a consumption row names a real
-- `StockTransaction`/`Measurement` in the project, and that is all they prove. They do NOT prove
-- the stock row is an `acceptance` rather than a receipt or a reversal, nor that its lot hangs off
-- a purchase-order line this certificate's bill actually claims; and on the labour side they do
-- not prove the measurement is an ORIGINAL rather than a correction row, nor that its labour PO
-- line is one this bill claims. Left there, a direct SQL path or a later writer could freeze a
-- reversal, or another bill's acceptance, as the evidence behind a payable certificate — and
-- `readCertificate` and both withdrawal guards would then audit rows the bill never consumed.
--
-- ONE function, two callers. §E states the rule once ("certification freezes the rows it consumed")
-- and it applies identically to both fact families, so a second implementation would be the drift
-- §0 exists to name — and the two copies would disagree the first time either changed.
CREATE OR REPLACE FUNCTION phase5_t5_consumption_evidence_check(
  p_project text, p_certificate text, p_kind text, p_row text
) RETURNS void AS $$
DECLARE
  v_bill      text;
  v_ok        boolean;
  v_available numeric;
  v_frozen    numeric;
BEGIN
  SELECT c."billId" INTO v_bill FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate;
  IF v_bill IS NULL THEN
    RAISE EXCEPTION 'Consumption row cites certificate % which does not exist in project %', p_certificate, p_project;
  END IF;

  IF p_kind = 'acceptance' THEN
    -- the row is an ACCEPTANCE, and its lot hangs off a purchase-order line the bill's LIVE claim
    -- names. `VendorBillLine.poLineId` is the material arm of the XOR Task 4 sealed.
    SELECT EXISTS (
      SELECT 1
        FROM "StockTransaction" t
        JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
        JOIN "VendorBillLine" bl ON bl."projectId" = lot."projectId" AND bl."poLineId" = lot."poLineId"
        JOIN "VendorBillVersion" v ON v."projectId" = bl."projectId" AND v."id" = bl."versionId"
       WHERE t."projectId" = p_project AND t."id" = p_row
         AND t."type" = 'acceptance'
         AND v."billId" = v_bill
         AND v."supersededAt" IS NULL
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Certificate % may only freeze an ACCEPTANCE row on a purchase-order line its own bill claims — % is not one', p_certificate, p_row;
    END IF;

    -- Codex round-2 P2 — identity is not QUANTITY. Proving the row is the right KIND of evidence
    -- says nothing about how much of it exists: a direct insert could freeze `consumedQty = 100`
    -- against a one-unit acceptance, and every other seal would pass while `readCertificate`
    -- reported evidence that never existed and the withdrawal guard blocked reversals on the
    -- strength of it. The bound is the §0 `ACCEPTED` arithmetic per row — the acceptance quantity
    -- less the reversals OF THAT ROW — and it is a SUM over every LIVE certificate, because two
    -- certificates may each rest on part of one acceptance but never on more of it than exists.
    SELECT a."qty" - COALESCE((
             SELECT SUM(r."qty") FROM "StockTransaction" r
              WHERE r."projectId" = a."projectId" AND r."reversedTxId" = a."id" AND r."type" = 'reversal'
           ), 0)
      INTO v_available
      FROM "StockTransaction" a
     WHERE a."projectId" = p_project AND a."id" = p_row;
    SELECT COALESCE(SUM(cc."consumedQty"), 0) INTO v_frozen
      FROM "CertifiedAcceptanceConsumption" cc
      JOIN "BillCertificate" c ON c."projectId" = cc."projectId" AND c."id" = cc."certificateId"
     WHERE cc."projectId" = p_project AND cc."stockTransactionId" = p_row
       AND c."supersededAt" IS NULL;
    IF v_frozen > v_available THEN
      RAISE EXCEPTION 'Live certificates freeze % base units of acceptance % but only % remain accepted on it — frozen evidence cannot exceed the evidence', v_frozen, p_row, v_available;
    END IF;
  ELSE
    -- the row is an ORIGINAL measurement (a correction is the amendment OF evidence, never
    -- evidence itself) on a labour purchase-order line the bill's LIVE claim names
    SELECT EXISTS (
      SELECT 1
        FROM "Measurement" m
        JOIN "VendorBillLine" bl ON bl."projectId" = m."projectId" AND bl."labourPoLineId" = m."labourPoLineId"
        JOIN "VendorBillVersion" v ON v."projectId" = bl."projectId" AND v."id" = bl."versionId"
       WHERE m."projectId" = p_project AND m."id" = p_row
         AND m."correctsId" IS NULL
         AND v."billId" = v_bill
         AND v."supersededAt" IS NULL
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Certificate % may only freeze an ORIGINAL measurement on a labour purchase-order line its own bill claims — % is not one', p_certificate, p_row;
    END IF;

    -- the labour twin of the same bound. The available quantity here is the row's NET — its own
    -- quantity plus every correction addressed to it — which is what `CommercialMeasurementQuery.netOf`
    -- folds in TypeScript. Same rule, two languages, stated once in each.
    SELECT COALESCE(SUM(m2."quantity"), 0) INTO v_available
      FROM "Measurement" m2
     WHERE m2."projectId" = p_project AND (m2."id" = p_row OR m2."correctsId" = p_row);
    SELECT COALESCE(SUM(mc."consumedQty"), 0) INTO v_frozen
      FROM "CertifiedMeasurementConsumption" mc
      JOIN "BillCertificate" c ON c."projectId" = mc."projectId" AND c."id" = mc."certificateId"
     WHERE mc."projectId" = p_project AND mc."measurementId" = p_row
       AND c."supersededAt" IS NULL;
    IF v_frozen > v_available THEN
      RAISE EXCEPTION 'Live certificates freeze % person-shifts of measurement % but only % stand on it — frozen evidence cannot exceed the evidence', v_frozen, p_row, v_available;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_acceptance_consumption_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_consumption_evidence_check(NEW."projectId", NEW."certificateId", 'acceptance', NEW."stockTransactionId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_measurement_consumption_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_consumption_evidence_check(NEW."projectId", NEW."certificateId", 'measurement', NEW."measurementId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRED, because the certificate and its consumption rows are written in ONE transaction and a
-- BEFORE trigger would fire before the certificate row it must read exists.
DROP TRIGGER IF EXISTS "CertifiedAcceptanceConsumption_evidence_sealed" ON "CertifiedAcceptanceConsumption";
CREATE CONSTRAINT TRIGGER "CertifiedAcceptanceConsumption_evidence_sealed"
  AFTER INSERT ON "CertifiedAcceptanceConsumption" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_acceptance_consumption_sealed();
DROP TRIGGER IF EXISTS "CertifiedMeasurementConsumption_evidence_sealed" ON "CertifiedMeasurementConsumption";
CREATE CONSTRAINT TRIGGER "CertifiedMeasurementConsumption_evidence_sealed"
  AFTER INSERT ON "CertifiedMeasurementConsumption" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_measurement_consumption_sealed();

-- ── §E/§I — the CERTIFICATE AS A WHOLE, asked once at COMMIT ──────────────────────────────────
--
-- Codex round 2, three findings with ONE root: every seal above validates a ROW AS IT LANDS, and
-- none of them ever asks whether the CERTIFICATE is coherent. A row-level validator cannot see an
-- ABSENCE. So a direct SQL path could:
--
--   * insert a certificate, move the bill to `certified`, and write NO consumption rows at all —
--     bound 3 and the projection seal both pass, `readCertificate` reports empty evidence arrays,
--     and the withdrawal guards then find no frozen rows and permit the very reversal the
--     certificate exists to block;
--   * do the same as the evidence RECORDER with no `SodException` — every trigger passes and §I's
--     attributable override is simply missing from the audit trail;
--   * point `versionId` at a SUPERSEDED version of its own bill, so the certificate is reported
--     against a claim that is no longer live while the bound checks read the live one.
--
-- This is root A at the database layer: the per-row seals fix the MEMBER, and the SET — the
-- certificate — had no seal of its own. One deferred function asks the whole question.
--
-- SUPERSEDED certificates return early and deliberately. A superseded certificate is HISTORY: the
-- claim may legitimately have moved on since, and re-validating it against today's world would
-- refuse the correction path §F requires. Only a LIVE certificate must be coherent with now.
CREATE OR REPLACE FUNCTION phase5_t5_certificate_complete_check(p_project text, p_certificate text)
RETURNS void AS $$
DECLARE
  v_bill         text;
  v_version      text;
  v_certifier    text;
  v_superseded   timestamp(3);
  v_live_version text;
  v_frozen       numeric;
  v_recorder     boolean;
  v_excepted     boolean;
  r              record;
BEGIN
  SELECT c."billId", c."versionId", c."certifiedById", c."supersededAt"
    INTO v_bill, v_version, v_certifier, v_superseded
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate;
  IF v_bill IS NULL OR v_superseded IS NOT NULL THEN RETURN; END IF;

  -- (a) the certificate names the bill's LIVE claim version, not merely a version of that bill
  SELECT v."id" INTO v_live_version FROM "VendorBillVersion" v
   WHERE v."projectId" = p_project AND v."billId" = v_bill AND v."supersededAt" IS NULL;
  IF v_version IS DISTINCT FROM v_live_version THEN
    RAISE EXCEPTION 'Certificate % names claim version % while the live version of bill % is % — a certificate reports the claim it certified, so it cannot outlive it', p_certificate, v_version, v_bill, COALESCE(v_live_version, '(none)');
  END IF;

  -- (b) every claimed line is COVERED by frozen evidence. `certify` refuses to write a certificate
  -- it cannot cover; this is that same refusal, stated where no writer can go around it.
  FOR r IN
    SELECT bl."poLineId" AS po_line, bl."labourPoLineId" AS labour_line, SUM(bl."quantity") AS claimed
      FROM "VendorBillLine" bl
     WHERE bl."projectId" = p_project AND bl."versionId" = v_version
     GROUP BY bl."poLineId", bl."labourPoLineId"
  LOOP
    IF r.po_line IS NOT NULL THEN
      SELECT COALESCE(SUM(cc."consumedQty"), 0) INTO v_frozen
        FROM "CertifiedAcceptanceConsumption" cc
        JOIN "StockTransaction" t ON t."projectId" = cc."projectId" AND t."id" = cc."stockTransactionId"
        JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
       WHERE cc."projectId" = p_project AND cc."certificateId" = p_certificate
         AND lot."poLineId" = r.po_line;
      IF v_frozen < r.claimed THEN
        RAISE EXCEPTION 'Certificate % claims % base units on purchase-order line % but freezes only % of accepted evidence — a certificate must name the evidence it rests on', p_certificate, r.claimed, r.po_line, v_frozen;
      END IF;
    ELSE
      SELECT COALESCE(SUM(mc."consumedQty"), 0) INTO v_frozen
        FROM "CertifiedMeasurementConsumption" mc
        JOIN "Measurement" m ON m."projectId" = mc."projectId" AND m."id" = mc."measurementId"
       WHERE mc."projectId" = p_project AND mc."certificateId" = p_certificate
         AND m."labourPoLineId" = r.labour_line;
      IF v_frozen < r.claimed THEN
        RAISE EXCEPTION 'Certificate % claims % person-shifts on labour purchase-order line % but freezes only % of measured evidence — a certificate must name the evidence it rests on', p_certificate, r.claimed, r.labour_line, v_frozen;
      END IF;
    END IF;
  END LOOP;

  -- (c) §I — if the certifier RECORDED any of the frozen evidence, an attributable exception for
  -- THIS certificate naming THAT actor must exist. The rule is evaluated against the frozen set,
  -- exactly as the service evaluates it against the draw: same question, same rows, two layers.
  SELECT EXISTS (
    SELECT 1
      FROM "CertifiedAcceptanceConsumption" cc
      JOIN "StockTransaction" t ON t."projectId" = cc."projectId" AND t."id" = cc."stockTransactionId"
     WHERE cc."projectId" = p_project AND cc."certificateId" = p_certificate
       AND t."recordedById" = v_certifier
    UNION ALL
    SELECT 1
      FROM "CertifiedMeasurementConsumption" mc
      JOIN "Measurement" m ON m."projectId" = mc."projectId" AND m."id" = mc."measurementId"
     WHERE mc."projectId" = p_project AND mc."certificateId" = p_certificate
       AND m."takenById" = v_certifier
  ) INTO v_recorder;
  IF v_recorder THEN
    SELECT EXISTS (
      SELECT 1 FROM "SodException" s
       WHERE s."projectId" = p_project AND s."certificateId" = p_certificate
         AND s."actorId" = v_certifier
    ) INTO v_excepted;
    IF NOT v_excepted THEN
      RAISE EXCEPTION 'Certificate % was certified by %, who recorded evidence it rests on, with no segregation-of-duties exception — §I permits the act only with an attributable override', p_certificate, v_certifier;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_certificate_complete_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_certificate_complete_check(NEW."projectId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The CLAIM side fires it too: a new live version supersedes the one a live certificate names, so
-- an amendment written around §F's arrows would strand the certificate on dead claim evidence.
-- One predicate, every writer of either side — the shape bound 3 already has.
CREATE OR REPLACE FUNCTION phase5_t5_version_certificate_recheck() RETURNS trigger AS $$
DECLARE v_cert text;
BEGIN
  SELECT c."id" INTO v_cert FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."billId" = NEW."billId" AND c."supersededAt" IS NULL;
  IF v_cert IS NOT NULL THEN PERFORM phase5_t5_certificate_complete_check(NEW."projectId", v_cert); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillCertificate_complete_sealed" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_complete_sealed"
  AFTER INSERT OR UPDATE ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_certificate_complete_sealed();
DROP TRIGGER IF EXISTS "VendorBillVersion_certificate_sealed" ON "VendorBillVersion";
CREATE CONSTRAINT TRIGGER "VendorBillVersion_certificate_sealed"
  AFTER INSERT OR UPDATE ON "VendorBillVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_version_certificate_recheck();

-- ── §F — the STATUS and the CERTIFICATE move together, or neither commits ──────────────────────
--
-- Codex round-1 P1. The `certified` shadow rule in the lifecycle trigger closes one direction: a
-- status cannot be asserted without a certificate. It says nothing about the other: a standalone
-- supersession of the live certificate commits happily while `VendorBill.status` stays `certified`,
-- leaving a bill that claims to be certified and a `readCertificate` that 404s — and from there the
-- bill can be amended as though its certification never happened, with no live certificate to
-- refuse the withdrawal of the evidence underneath it.
--
-- The invariant is a BICONDITIONAL, and §F makes it one: a live certificate exists for a bill IF
-- AND ONLY IF that bill is `certified`. `certify` writes both; `supersede` clears both. Anything
-- that moves one without the other is incoherent by construction.
--
-- It must be DEFERRED: `certify` inserts the certificate and then CASes the status, and `supersede`
-- stamps and then CASes, so both are transiently incoherent mid-transaction. COMMIT is the only
-- instant at which the question has an answer — which is root D from the 5A audit, at its next site.
CREATE OR REPLACE FUNCTION phase5_t5_certificate_projection_check(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_live   bigint;
  v_status text;
BEGIN
  SELECT b."status" INTO v_status FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill;
  -- the bill is gone: nothing to be coherent WITH, and `VendorBill` rows are never deleted anyway
  IF v_status IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_live FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;

  IF v_status = 'certified' AND v_live <> 1 THEN
    RAISE EXCEPTION 'Bill % is `certified` with % live certificate(s) — the status is the certificate''s projection and the two move together', p_bill, v_live;
  END IF;
  IF v_status <> 'certified' AND v_live <> 0 THEN
    RAISE EXCEPTION 'Bill % is `%` while a LIVE certificate still stands — superseding a certificate must return the claim to `verified` in the SAME transaction', p_bill, v_status;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_certificate_projection_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_certificate_projection_check(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_bill_projection_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5_certificate_projection_check(NEW."projectId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Fired from BOTH sides, because either side alone can break it: the certificate writer (a
-- supersession that leaves the status behind) and the bill writer (a status flip that leaves the
-- certificate behind). One predicate, two triggers — root H.
DROP TRIGGER IF EXISTS "BillCertificate_projection_sealed" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_projection_sealed"
  AFTER INSERT OR UPDATE ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_certificate_projection_sealed();
DROP TRIGGER IF EXISTS "VendorBill_certificate_projection_sealed" ON "VendorBill";
CREATE CONSTRAINT TRIGGER "VendorBill_certificate_projection_sealed"
  AFTER INSERT OR UPDATE ON "VendorBill" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_bill_projection_sealed();

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

-- ── §F — the ONE arrow this task adds, and the one it adds back ────────────────────────────────
--
-- **This function is `20270501000000`'s body VERBATIM plus a NAMED delta.** It is reproduced in
-- full because PostgreSQL has no way to add a clause to an existing function — `CREATE OR REPLACE`
-- takes a whole body — and the first draft of this migration paid for that: it pasted the body
-- from an older branch and silently DELETED 5A's `verified` provenance seal and its
-- `verified -> submitted` amendment guard, five correction rounds of cleared work, while the
-- migration applied green. `phase5-t5a-verification.test.ts` caught it.
--
-- The delta, in full, so the next task can diff rather than trust this sentence:
--   1. `DECLARE v_cert bigint;`
--   2. the `certified` shadow rule, immediately before the transition table
--   3. `certified` added to the `verified` arrow row, and `certified -> verified` added below it
--   4. the closing message names `certified` rather than `verified` as the frontier
-- Nothing else differs. A task that adds another arrow should copy the CURRENT body and state its
-- own delta the same way.

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
  -- Codex round-1 F2 — `verified` is the SHADOW of a verdict, not a status a writer may assert.
  -- The verdict must be a MATCH and must have been computed over the claim version that is live
  -- right now: a verdict over a superseded version says nothing about the claim being verified.
  IF NEW."status" = 'verified' AND OLD."status" IS DISTINCT FROM 'verified' THEN
    -- Codex round-3 — the verdict must be PROVABLY the service's, not merely present. The first
    -- head checked that some `matched` row existed, which a maintenance path could satisfy by
    -- inserting one: fake the verdict, then flip the status, and the §E check the arrow exists to
    -- enforce is bypassed with two statements.
    --
    -- The seal is PROVENANCE, not a re-derivation. Re-deriving the rate, tax, freight and duplicate
    -- checks here would restate §E in a second language, and §0 is explicit that restating a rule at
    -- a second site is the drift that produces findings — the two copies disagree the first time
    -- either changes. Instead the row must have been produced BY the command that computes the
    -- verdict, which is the four-FK provenance shape Task 2 established for proving a PO line's
    -- terms came from the approved comparison. `sourceCommandId` is already an FK to
    -- `CommandExecution`; this adds the requirement that the command be a SUCCEEDED
    -- `commercial.bill.verify` for this same project.
    IF NOT EXISTS (
      SELECT 1 FROM "BillVerification" bv
       JOIN "CommandExecution" ce
         ON ce."projectId" = bv."projectId" AND ce."id" = bv."sourceCommandId"
       WHERE bv."projectId" = NEW."projectId" AND bv."billId" = NEW."id"
         AND bv."verdict" = 'matched'
         -- NOT `ce."status" = 'succeeded'`, and NOT `ce."resultRef" = bv."id"`: this trigger fires
         -- DURING the verify command, while its own ledger row is still `reserved` and its result
         -- has not been written, so either clause is unsatisfiable HERE by construction — the
         -- first head of this seal carried the status clause and refused every honest
         -- verification. What can be checked at this instant is the command's TYPE. What cannot
         -- is checked at COMMIT instead, by `VendorBill_verified_provenance` below, which is where
         -- the ledger row is complete. The two halves are one rule split by WHEN it is knowable,
         -- not a weaker check and a stronger one.
         AND ce."commandType" = 'commercial.bill.verify'
         AND bv."versionId" = (
           SELECT v."id" FROM "VendorBillVersion" v
            WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id" AND v."supersededAt" IS NULL
         )
    ) THEN
      RAISE EXCEPTION 'A bill is `verified` because a MATCHED §E verdict produced by `commercial.bill.verify` stands over its CURRENT claim version, not because a status says so (%)', OLD."id";
    END IF;
  END IF;
  -- Codex round-4 — `verified -> submitted` is the AMENDMENT arrow, and round 1 opened it without
  -- requiring the amendment. `CommercialBillService.amend` supersedes the verified version and
  -- writes its replacement BEFORE the CAS, so the honest path satisfies this; a bare status flip
  -- does not, and that is the whole difference. Left unguarded, one UPDATE re-opens a verified
  -- claim for re-verification with no new claim behind it — the same "a status is not a fact"
  -- defect the `verified` arrow itself was found for, one arrow along.
  --
  -- The rule names the version the verdict was about, not merely "some superseded version": the
  -- live version must supersede the version whose MATCHED verdict made this bill `verified`.
  IF OLD."status" = 'verified' AND NEW."status" = 'submitted' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM "VendorBillVersion" live
        JOIN "VendorBillVersion" prev
          ON prev."projectId" = live."projectId" AND prev."billId" = live."billId"
         AND prev."version"   = live."supersedesVersion"
        JOIN "BillVerification" bv
          ON bv."projectId" = prev."projectId" AND bv."versionId" = prev."id"
       WHERE live."projectId" = NEW."projectId" AND live."billId" = NEW."id"
         AND live."supersededAt" IS NULL
         AND bv."verdict" = 'matched'
    ) THEN
      RAISE EXCEPTION 'A verified claim returns to `submitted` only by being AMENDED — the live version must supersede the version whose matched verdict made it `verified`, and a status flip with no replacement claim behind it re-opens verification over the claim that was already verified (%)', OLD."id";
    END IF;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'draft'              AND NEW."status" IN ('submitted', 'disputed', 'rejected'))
      OR (OLD."status" = 'submitted'          AND NEW."status" IN ('under-verification', 'disputed', 'rejected'))
      -- Task 5A — the §E verdict is the evidence that makes THIS arrow safe, and it is the only
      -- one this increment opens.
      OR (OLD."status" = 'under-verification' AND NEW."status" IN ('verified', 'disputed', 'rejected'))
      -- §E/§F — a claim is LIVE from the moment it is submitted, so evidence withdrawn under a
      -- VERIFIED claim must have somewhere to put it. Rejection stops at `verified` because §0
      -- drops a rejected bill from every billed set.
      -- Codex round-1 F3 — `CommercialBillService.amend` has ALWAYS admitted `verified` and CASes
      -- `verified -> submitted` so the replacement claim is re-checked from the start. That path was
      -- unreachable while `verified` was, and opening the state without opening the arrow the
      -- existing service already takes from it would fail every amendment of a verified claim at
      -- the trigger. The recheck is guarded by construction: `submitted` re-runs §G bounds 1–2 on
      -- submission and must be verified again before it can advance.
      -- Task 5B adds `certified` to this row and does NOT disturb the rest of it: `submitted` is
      -- round-1 F3's amendment arrow (guarded above) and `disputed` is §E's withdrawal arrow.
      OR (OLD."status" = 'verified'           AND NEW."status" IN ('submitted', 'certified', 'disputed', 'rejected'))
      -- …and back, on SUPERSESSION — §F's ONE correction path past certification. It never goes
      -- further back: rejection stops at `verified`, because §0 drops a rejected bill from every
      -- billed set and that would free accepted quantity a certificate still stands on.
      OR (OLD."status" = 'certified'          AND NEW."status" = 'verified')
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal, a disputed one is corrected by a NEW version, and the arrows past `certified` belong to the task that produces their evidence (%)', OLD."status", NEW."status", OLD."id";
    END IF;
  END IF;
  -- Task 5B — `certified` is the SHADOW of a CERTIFICATE, exactly as `verified` above is the
  -- shadow of a verdict. Without this, maintenance SQL could mark a bill certified with no
  -- certificate behind it, and §G bounds 3-5 would read a payable of zero while the status says
  -- money is authorised. The certificate is the fact; the status is its projection.
  --
  -- No provenance clause is needed beside it, and the asymmetry with `verified` is deliberate: a
  -- verdict is DERIVED, so a hand-written one is indistinguishable from a computed one unless the
  -- producing command is checked. A certificate is not derived — it IS the fact, sealed
  -- append-only with its own §G bound checked at COMMIT and its evidence frozen by composite FK.
  -- Requiring a command type here would check the weaker of the two things already checked.
  --
  -- It is checked AFTER the transition table, and the order is the point: an ILLEGAL arrow must be
  -- reported as an illegal arrow. `under-verification -> certified` is not a transition at all, and
  -- answering it with "no live certificate exists" would send a reader hunting for a certificate
  -- when the real answer is that the claim has not been verified yet. The coarser question is
  -- answered first — the same reasoning that puts the certificate refusal ahead of the dispute in
  -- the withdrawal guards.
  IF NEW."status" = 'certified' AND OLD."status" IS DISTINCT FROM 'certified' THEN
    SELECT COUNT(*) INTO v_cert FROM "BillCertificate" c
     WHERE c."projectId" = NEW."projectId" AND c."billId" = NEW."id" AND c."supersededAt" IS NULL;
    IF v_cert <> 1 THEN
      RAISE EXCEPTION 'A bill is `certified` because a LIVE certificate exists for it, not because a status says so — found % (%)', v_cert, OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
