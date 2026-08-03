-- Phase 5 Task 4 — the §F VENDOR BILL and the §G conservation bounds 1–2.
--
-- Two halves, in this order, because the second depends on the first:
--
--  A. VENDOR PINNING on both PO-line snapshots (§F). `PurchaseOrderLine` and
--     `LabourPurchaseOrderLine` carry no `vendorId` — the vendor lives on the PO ROOT — and
--     PostgreSQL cannot express a transitive join as a foreign key, so "bind the bill line to
--     the vendor" is unimplementable until the line itself carries it. Both tables are already
--     deployed and projects may hold lines predating this migration, so copying at issuance
--     populates FUTURE rows only: making the keys NOT NULL would then fail the migration, and
--     leaving them nullable would leave old lines un-pinned so their first commercial bill is
--     either unrepresentable or not PG-bound to the vendor. This half therefore BACKFILLS every
--     existing line from the version→root chain it already references, ABORTS diagnostically on
--     any line it cannot resolve (it never invents a vendor), and only then adds the FKs and the
--     non-null seal — the diagnostic-first shape every Phase-3/4 correction migration used.
--
--  B. The three new commercial tables, their CHECKs, their append-only/freeze triggers and the
--     §G bound-1/bound-2 seal.
--
-- ADDITIVE: no existing column is dropped or re-typed and no deployed migration byte changes.
-- The two new PO-line columns are the only change to an existing table, and they are a COPY of
-- a chain those rows already reference, FK-sealed back to it.
--
-- RETRY-SAFE: every statement is guarded, so a crash between a statement and Prisma recording
-- the migration leaves a rerunnable migration.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- A. VENDOR PINNING (§F) — diagnostic-first backfill, then the seals
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "PurchaseOrderLine"       ADD COLUMN IF NOT EXISTS "purchaseOrderId" TEXT;
ALTER TABLE "PurchaseOrderLine"       ADD COLUMN IF NOT EXISTS "vendorId"        TEXT;
ALTER TABLE "LabourPurchaseOrderLine" ADD COLUMN IF NOT EXISTS "purchaseOrderId" TEXT;
ALTER TABLE "LabourPurchaseOrderLine" ADD COLUMN IF NOT EXISTS "vendorId"        TEXT;

-- The BACKFILL. Every value comes from the row's OWN version→root chain; nothing is invented.
-- The frozen-snapshot triggers reject an ordinary UPDATE, so they are disabled by NAME for the
-- two statements that populate the columns they will go on to protect — the narrow, named
-- disable the cleared Phase-3 `20261222`/`20261224` migrations already use on these same rows.
ALTER TABLE "PurchaseOrderLine" DISABLE TRIGGER "PurchaseOrderLine_frozen";
UPDATE "PurchaseOrderLine" l
   SET "purchaseOrderId" = v."poId", "vendorId" = p."vendorId"
  FROM "PurchaseOrderVersion" v
  JOIN "PurchaseOrder" p ON p."projectId" = v."projectId" AND p."id" = v."poId"
 WHERE v."projectId" = l."projectId" AND v."id" = l."poVersionId"
   AND (l."purchaseOrderId" IS NULL OR l."vendorId" IS NULL);
ALTER TABLE "PurchaseOrderLine" ENABLE TRIGGER "PurchaseOrderLine_frozen";

ALTER TABLE "LabourPurchaseOrderLine" DISABLE TRIGGER "LabourPurchaseOrderLine_frozen";
UPDATE "LabourPurchaseOrderLine" l
   SET "purchaseOrderId" = v."poId", "vendorId" = p."vendorId"
  FROM "LabourPurchaseOrderVersion" v
  JOIN "LabourPurchaseOrder" p ON p."projectId" = v."projectId" AND p."id" = v."poId"
 WHERE v."projectId" = l."projectId" AND v."id" = l."poVersionId"
   AND (l."purchaseOrderId" IS NULL OR l."vendorId" IS NULL);
ALTER TABLE "LabourPurchaseOrderLine" ENABLE TRIGGER "LabourPurchaseOrderLine_frozen";

-- DIAGNOSTIC-FIRST: abort naming what could not be resolved rather than inventing a vendor or
-- silently leaving a line un-pinned. A line whose version or root is missing is a broken chain,
-- not a business state — the operator repairs the chain and re-runs (docs/RUNBOOK.md §P5T4).
DO $$
DECLARE m_bad bigint; l_bad bigint; sample text;
BEGIN
  SELECT count(*) INTO m_bad FROM "PurchaseOrderLine"
   WHERE "purchaseOrderId" IS NULL OR "vendorId" IS NULL;
  SELECT count(*) INTO l_bad FROM "LabourPurchaseOrderLine"
   WHERE "purchaseOrderId" IS NULL OR "vendorId" IS NULL;
  IF m_bad > 0 OR l_bad > 0 THEN
    SELECT string_agg(x, ', ') INTO sample FROM (
      (SELECT 'material ' || "projectId" || '/' || "id" AS x FROM "PurchaseOrderLine"
        WHERE "purchaseOrderId" IS NULL OR "vendorId" IS NULL ORDER BY "id" LIMIT 5)
      UNION ALL
      (SELECT 'labour ' || "projectId" || '/' || "id" FROM "LabourPurchaseOrderLine"
        WHERE "purchaseOrderId" IS NULL OR "vendorId" IS NULL ORDER BY "id" LIMIT 5)
    ) s;
    RAISE EXCEPTION 'Phase 5 Task 4 vendor pinning ABORTED: % material and % labour purchase-order line(s) cannot be resolved to a purchase order and vendor from their own version/root chain (sample: %). Repair the chain and re-run; this migration never invents a vendor. See docs/RUNBOOK.md §P5T4.', m_bad, l_bad, COALESCE(sample, 'none');
  END IF;
END $$;

ALTER TABLE "PurchaseOrderLine"       ALTER COLUMN "purchaseOrderId" SET NOT NULL;
ALTER TABLE "PurchaseOrderLine"       ALTER COLUMN "vendorId"        SET NOT NULL;
ALTER TABLE "LabourPurchaseOrderLine" ALTER COLUMN "purchaseOrderId" SET NOT NULL;
ALTER TABLE "LabourPurchaseOrderLine" ALTER COLUMN "vendorId"        SET NOT NULL;

-- The widened unique keys. Each is unique because `(projectId,"id")` already is: widening a
-- unique key adds an FK TARGET, it never constrains what may be stored.
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_projectId_id_vendorId_key"              ON "PurchaseOrder"("projectId", "id", "vendorId");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrderVersion_projectId_id_poId_key"           ON "PurchaseOrderVersion"("projectId", "id", "poId");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrderLine_projectId_id_vendorId_key"          ON "PurchaseOrderLine"("projectId", "id", "vendorId");
CREATE UNIQUE INDEX IF NOT EXISTS "LabourPurchaseOrder_projectId_id_vendorId_key"        ON "LabourPurchaseOrder"("projectId", "id", "vendorId");
CREATE UNIQUE INDEX IF NOT EXISTS "LabourPurchaseOrderVersion_projectId_id_poId_key"     ON "LabourPurchaseOrderVersion"("projectId", "id", "poId");
CREATE UNIQUE INDEX IF NOT EXISTS "LabourPurchaseOrderLine_projectId_id_vendorId_key"    ON "LabourPurchaseOrderLine"("projectId", "id", "vendorId");

DO $$ BEGIN
  -- The copy is sealed BACK to the chain it came from, in two links, so it can never disagree
  -- with its source: the line's order IS its version's order, and the line's vendor IS that
  -- order's vendor. Without these a maintenance UPDATE could re-point a line at another
  -- vendor's order and the bill-line FK below would then happily bind a cross-vendor claim.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderLine_version_order_fkey') THEN
    ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_version_order_fkey"
      FOREIGN KEY ("projectId", "poVersionId", "purchaseOrderId")
      REFERENCES "PurchaseOrderVersion"("projectId", "id", "poId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderLine_order_vendor_fkey') THEN
    ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_order_vendor_fkey"
      FOREIGN KEY ("projectId", "purchaseOrderId", "vendorId")
      REFERENCES "PurchaseOrder"("projectId", "id", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourPurchaseOrderLine_version_order_fkey') THEN
    ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_version_order_fkey"
      FOREIGN KEY ("projectId", "poVersionId", "purchaseOrderId")
      REFERENCES "LabourPurchaseOrderVersion"("projectId", "id", "poId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LabourPurchaseOrderLine_order_vendor_fkey') THEN
    ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_order_vendor_fkey"
      FOREIGN KEY ("projectId", "purchaseOrderId", "vendorId")
      REFERENCES "LabourPurchaseOrder"("projectId", "id", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- The two new columns join the FROZEN snapshot. A key that binds a payable claim to a
-- counterparty is exactly the kind of column §0b freezes: an editable one would let a claim be
-- re-pointed at another vendor's order after the bounds were checked against the first.
CREATE OR REPLACE FUNCTION phase3_po_line_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrderLine rows are never deleted (frozen snapshot, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poVersionId" <> OLD."poVersionId"
     OR NEW."requisitionLineId" <> OLD."requisitionLineId"
     OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."requirementId" <> OLD."requirementId" OR NEW."revision" <> OLD."revision"
     OR NEW."specFingerprint" <> OLD."specFingerprint"
     OR NEW."quotedMake" IS DISTINCT FROM OLD."quotedMake"
     OR NEW."uom" <> OLD."uom" OR NEW."purchaseUom" <> OLD."purchaseUom"
     OR NEW."purchaseQty" <> OLD."purchaseQty" OR NEW."conversionToBase" <> OLD."conversionToBase"
     OR NEW."qty" <> OLD."qty" OR NEW."rate" <> OLD."rate"
     OR NEW."taxAmount" <> OLD."taxAmount" OR NEW."freightAmount" <> OLD."freightAmount"
     OR NEW."landedAmount" <> OLD."landedAmount" OR NEW."committedAmountBase" <> OLD."committedAmountBase"
     -- Phase 5 Task 4 (§F vendor pinning)
     OR NEW."purchaseOrderId" IS DISTINCT FROM OLD."purchaseOrderId"
     OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId" THEN
    RAISE EXCEPTION 'PurchaseOrderLine commercial snapshot is FROZEN — only receivedQty and issuance-time approvedOverage may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase4_lp_po_line_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourPurchaseOrderLine rows are never deleted (frozen snapshot, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poVersionId" <> OLD."poVersionId"
     OR NEW."requisitionLineId" <> OLD."requisitionLineId" OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."requirementId" <> OLD."requirementId" OR NEW."revision" <> OLD."revision"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."labourSpecFingerprint" <> OLD."labourSpecFingerprint" OR NEW."personShiftQty" <> OLD."personShiftQty"
     OR NEW."ratePerPersonShift" <> OLD."ratePerPersonShift" OR NEW."shiftPremium" <> OLD."shiftPremium"
     OR NEW."committedAmountBase" <> OLD."committedAmountBase"
     OR NEW."comparisonId" <> OLD."comparisonId" OR NEW."selectedQuoteId" <> OLD."selectedQuoteId"
     OR NEW."selectedQuoteLineId" <> OLD."selectedQuoteLineId"
     -- Phase 5 Task 4 (§F vendor pinning)
     OR NEW."purchaseOrderId" IS DISTINCT FROM OLD."purchaseOrderId"
     OR NEW."vendorId" IS DISTINCT FROM OLD."vendorId" THEN
    RAISE EXCEPTION 'LabourPurchaseOrderLine commercial snapshot is FROZEN — only committedQty may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- B. THE VENDOR BILL (§F) and the §G bounds
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "VendorBill" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorBillNumber" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "VendorBill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VendorBillVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "vendorIdPin" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedesVersion" INTEGER,
    "claimedAmount" DECIMAL(18,2) NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,

    CONSTRAINT "VendorBillVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VendorBillLine" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "poLineId" TEXT,
    "labourPoLineId" TEXT,
    "quantity" DECIMAL(18,6) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "freightAmount" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "VendorBillLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VendorBill_projectId_id_key"                 ON "VendorBill"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBill_projectId_id_vendorId_key"        ON "VendorBill"("projectId", "id", "vendorId");
CREATE INDEX        IF NOT EXISTS "VendorBill_projectId_vendorId_idx"           ON "VendorBill"("projectId", "vendorId");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_projectId_id_key"          ON "VendorBillVersion"("projectId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_bill_version_key"          ON "VendorBillVersion"("projectId", "billId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_line_target_key"           ON "VendorBillVersion"("projectId", "id", "billId", "vendorIdPin");
CREATE INDEX        IF NOT EXISTS "VendorBillVersion_projectId_billId_idx"      ON "VendorBillVersion"("projectId", "billId");
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillLine_projectId_id_key"             ON "VendorBillLine"("projectId", "id");
CREATE INDEX        IF NOT EXISTS "VendorBillLine_projectId_versionId_idx"      ON "VendorBillLine"("projectId", "versionId");
CREATE INDEX        IF NOT EXISTS "VendorBillLine_projectId_poLineId_idx"       ON "VendorBillLine"("projectId", "poLineId");
CREATE INDEX        IF NOT EXISTS "VendorBillLine_projectId_labourPoLineId_idx" ON "VendorBillLine"("projectId", "labourPoLineId");

-- §F, probe 5bj — the DUPLICATE-DOCUMENT key, released by the lifecycle's OWN terminal states
-- and by nothing else. A vendor may re-submit `V-1` after the first was REJECTED or after a
-- dispute was RESOLVED (both are settled), but a second `V-1` while one is `submitted`,
-- `under-verification`, `verified`, `certified` or `disputed` is a duplicate claim and refused.
-- A predicate naming a state §F does not define (`WHERE NOT cancelled`) would never release.
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBill_live_document_key"
  ON "VendorBill"("projectId", "vendorId", "vendorBillNumber")
  WHERE "status" NOT IN ('rejected', 'resolved');

-- §F — exactly one CURRENT version per bill. Without it an amendment could leave two live
-- versions and `BILLED_AMOUNT` would fold a retained claim alongside its own correction.
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_one_current_key"
  ON "VendorBillVersion"("projectId", "billId") WHERE "supersededAt" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_projectId_fkey') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the counterparty must be BOUND to this project (the Phase-3 §H tenancy shape)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_binding_fkey') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_binding_fkey" FOREIGN KEY ("projectId", "vendorId") REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_createdById_fkey') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_sourceCommand_fkey') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_projectId_fkey') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the version carries its bill's vendor, FK-sealed to the root: the denormalized pin cannot
  -- disagree with the bill it belongs to, which is what lets a LINE be vendor-sealed in turn
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_bill_fkey') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_bill_fkey" FOREIGN KEY ("projectId", "billId", "vendorIdPin") REFERENCES "VendorBill"("projectId", "id", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_createdById_fkey') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_supersededById_fkey') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_projectId_fkey') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- the line belongs to a version OF ITS OWN BILL, carrying THAT bill's vendor
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_version_fkey') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_version_fkey" FOREIGN KEY ("projectId", "versionId", "billId", "vendorId") REFERENCES "VendorBillVersion"("projectId", "id", "billId", "vendorIdPin") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- §F/probes 5f/5ao — VENDOR PINNING is enforced by PostgreSQL, not by the service: Vendor A's
  -- bill line naming Vendor B's PO line IN THE SAME PROJECT is rejected here. A same-project FK
  -- alone only stops a cross-PROJECT line; both PO roots carry their own vendor, so within one
  -- project the claim would pass the ordered and accepted checks and attribute a payable amount
  -- to the wrong counterparty.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_poLine_fkey') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_poLine_fkey" FOREIGN KEY ("projectId", "poLineId", "vendorId") REFERENCES "PurchaseOrderLine"("projectId", "id", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_labourPoLine_fkey') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_labourPoLine_fkey" FOREIGN KEY ("projectId", "labourPoLineId", "vendorId") REFERENCES "LabourPurchaseOrderLine"("projectId", "id", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  -- §0b non-blank text discipline, with the COMPLETE ASCII set. The bill number is the site of
  -- this rule that matters most: probe 5bg makes it the duplicate-claim key, so a whitespace-only
  -- number would group every blank-numbered claim from a vendor into one bucket — or none,
  -- depending on the comparison — and duplicate detection would stop resting on immutable
  -- vendor evidence.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_number_nonblank') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_number_nonblank" CHECK (btrim("vendorBillNumber", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_reason_nonblank') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_reason_nonblank" CHECK ("statusReason" IS NULL OR btrim("statusReason", E' \t\n\x0B\f\r') <> '');
  END IF;
  -- the lifecycle's own vocabulary. Task 4 can only REACH the first six; `verified` and
  -- everything past it belong to the task that produces their evidence (§E, Task 5). They are
  -- named here because §0's LIVE rule is defined over the WHOLE set and the billed folds must
  -- keep meaning the same thing when Task 5 adds the transitions into them.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_status_check') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_status_check" CHECK ("status" IN (
      'draft', 'submitted', 'under-verification', 'verified', 'disputed', 'resolved', 'rejected',
      'certified', 'approved-for-payment', 'part-paid', 'paid'
    ));
  END IF;
  -- leaving the live set is never unexplained: a dispute records that the claim's EVIDENCE
  -- moved, a rejection records a JUDGEMENT about the claim. Different facts, both attributable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBill_exit_reasoned') THEN
    ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_exit_reasoned" CHECK (
      "status" NOT IN ('disputed', 'rejected') OR ("statusReason" IS NOT NULL AND btrim("statusReason", E' \t\n\x0B\f\r') <> '')
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_version_positive') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_version_positive" CHECK ("version" >= 1);
  END IF;
  -- an amendment retains the prior version verbatim and points at it; v1 supersedes nothing
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_lineage_check') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_lineage_check" CHECK (
      ("version" = 1 AND "supersedesVersion" IS NULL) OR ("version" > 1 AND "supersedesVersion" IS NOT NULL AND "supersedesVersion" < "version")
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_amount_positive') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_amount_positive" CHECK ("claimedAmount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillVersion_supersede_reasoned') THEN
    ALTER TABLE "VendorBillVersion" ADD CONSTRAINT "VendorBillVersion_supersede_reasoned" CHECK (
      "supersededAt" IS NULL
      OR ("supersededById" IS NOT NULL AND "supersedeReason" IS NOT NULL AND btrim("supersedeReason", E' \t\n\x0B\f\r') <> '')
    );
  END IF;

  -- §F/probe 5bf — EXACTLY ONE PO-line target, and the `type` discriminator must AGREE with it.
  -- An FK on each nullable column constrains only the reference that is PRESENT, so both
  -- degenerate shapes would otherwise be representable and both defeat §G: NEITHER reference
  -- carries money into `BILLED_AMOUNT` while bounds 1–2 never run (they are folds over a PO line
  -- and there is none), and BOTH leaves the fold owner ambiguous so the same money draws down
  -- two ordered quantities — or, depending on which side a fold reads, neither.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_one_target') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_one_target" CHECK (("poLineId" IS NULL) <> ("labourPoLineId" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_type_correspondence') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_type_correspondence" CHECK (
      ("type" = 'material' AND "poLineId" IS NOT NULL) OR ("type" = 'labour' AND "labourPoLineId" IS NOT NULL)
    );
  END IF;
  -- §0b sign discipline, PER COLUMN. A claim QUANTITY is strictly positive: a credit is a
  -- separate document with its own semantics, not a negative line inside a conservation fold,
  -- and Phase 5 has no credit note — a live −100-unit claim beside a 200-unit bill would leave
  -- cumulative `BILLED_QTY` at 100 and pass bounds 1–2 against 100 accepted. Tax and freight are
  -- NON-negative, not strictly positive, because `PurchaseOrderLine`'s own CHECK is
  -- `taxAmount >= 0 AND freightAmount >= 0`: a zero-tax / zero-freight PO is legitimate and a
  -- strictly-positive claim check would refuse a bill matching the ordered evidence EXACTLY.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_sign_check') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_sign_check" CHECK (
      "quantity" > 0 AND "rate" >= 0 AND "taxAmount" >= 0 AND "freightAmount" >= 0
    );
  END IF;
  -- probe 5au — a LABOUR line's tax and freight are pinned to zero, because the
  -- `LabourPurchaseOrderLine` snapshot freezes no ordered tax or freight to verify them against.
  -- A material line's prorated tax/freight is unaffected.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_labour_no_tax') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_labour_no_tax" CHECK (
      "type" <> 'labour' OR ("taxAmount" = 0 AND "freightAmount" = 0)
    );
  END IF;
  -- §A — the money a fold reads is always the money the line's own components make. Half-up at
  -- 2 decimals, applied only where the value is PERSISTED, never mid-computation.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VendorBillLine_amount_derived') THEN
    ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_amount_derived" CHECK (
      "amount" = round("rate" * "quantity", 2) + "taxAmount" + "freightAmount"
    );
  END IF;
END $$;

-- §F — the bill ROOT's identity is FROZEN and its lifecycle is a closed transition graph.
--
-- The freeze is §0b's "a key that groups facts is frozen after write": `vendorBillNumber` and
-- `documentDate` ARE the duplicate-claim key, so an editable number lets a vendor re-submit the
-- same claim under a new number after the first is verified.
--
-- The transition table is what makes probe 5av true at PostgreSQL rather than only in the
-- service: a `disputed` version NEVER returns to live. Moving a 120-unit claim back to
-- `under-verification` against 100 accepted would make `BILLED_QTY` live again BEFORE the
-- quantity changes, breaking bound 2 and blocking the corrected 100-unit claim the dispute
-- exists to enable. Resolution supersedes into a NEW version instead.
CREATE OR REPLACE FUNCTION phase5_t4_bill_lifecycle() RETURNS trigger AS $$
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
  -- Codex round-1 F2 — the reason a claim LEFT the live fold is EVIDENCE, and the first head only
  -- looked at this row when the status itself moved. An update that keeps a bill `disputed` or
  -- `rejected` could therefore replace the justification afterwards, so the record would say the
  -- claim was rejected for a reason nobody recorded at the time. It is writable only as part of the
  -- transition that sets it.
  -- Codex round-2 — and only a transition INTO a state that REQUIRES a reason may write one. The
  -- round-1 fix keyed on "the status changed", which still let `disputed -> resolved` overwrite a
  -- `qty-over-accepted` breach with an amendment note, losing the evidence for why the claim left
  -- the live fold at all. A resolution has its own place to live: the superseded version's
  -- `supersedeReason`.
  IF NEW."statusReason" IS DISTINCT FROM OLD."statusReason"
     AND (NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" NOT IN ('disputed', 'rejected')) THEN
    RAISE EXCEPTION 'A vendor bill''s exit reason is FROZEN — it explains the transition that set it, and a rewritable justification is no justification (%)', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      -- Codex round-2 — Task 4 stops SHORT of `verified`, and the ARROWS have to stop there too.
      -- The first head listed the whole §F graph, so after an ordinary `beginVerification` any
      -- maintenance SQL could mark a claim `verified` or `certified` and PostgreSQL would call it
      -- legal — in a tree with no three-way verdict and no certificate table to justify either.
      -- The STATUSES stay in the CHECK vocabulary because §0's LIVE rule is defined over the whole
      -- set and the billed folds must keep meaning the same thing; Task 5 adds these arrows WITH
      -- the evidence that makes them safe, which is the same reason `verified` is Task 5's at all.
      (OLD."status" = 'draft'              AND NEW."status" IN ('submitted', 'disputed', 'rejected'))
      OR (OLD."status" = 'submitted'          AND NEW."status" IN ('under-verification', 'disputed', 'rejected'))
      OR (OLD."status" = 'under-verification' AND NEW."status" IN ('disputed', 'rejected'))
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal and a disputed one is corrected by a NEW version, never revived (%)', OLD."status", NEW."status", OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBill_lifecycle" ON "VendorBill";
CREATE TRIGGER "VendorBill_lifecycle" BEFORE UPDATE OR DELETE ON "VendorBill"
  FOR EACH ROW EXECUTE FUNCTION phase5_t4_bill_lifecycle();

-- §F — a claim VERSION is immutable except the ONE supersession stamp, and a claim LINE is
-- fully immutable. The ordinary append-only shape this repository already uses.
CREATE OR REPLACE FUNCTION phase5_t4_bill_version_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VendorBillVersion rows are never deleted — an amendment RETAINS the prior version verbatim (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."billId" <> OLD."billId"
     OR NEW."vendorIdPin" <> OLD."vendorIdPin" OR NEW."version" <> OLD."version"
     OR NEW."supersedesVersion" IS DISTINCT FROM OLD."supersedesVersion"
     OR NEW."claimedAmount" <> OLD."claimedAmount"
     -- Codex round-2 — `lineCount` is the EVIDENCE that closes the line set (round-1 F4), so it
     -- has to be frozen with everything else it stands beside. Left mutable, the seal defeats
     -- itself: bump it 1 -> 2 and insert the extra zero-money line in the SAME transaction and the
     -- deferred check sees a count that matches. A seal whose own evidence is editable is not one.
     OR NEW."lineCount" <> OLD."lineCount"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A vendor bill version is IMMUTABLE — correct a claim by amending into a new version (%)', OLD."id";
  END IF;
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This bill version is already superseded — it is history and cannot be stamped twice (%)', OLD."id";
  END IF;
  -- Codex round-1 F3 — the supersession columns are the EVIDENCE for the one permitted transition,
  -- so they become writable only as part of it. The first head checked the immutable columns and
  -- then returned, which let maintenance SQL pre-fill `supersededById`/`supersedeReason` on a still
  -- CURRENT version and rewrite them freely until the amendment eventually landed.
  IF NEW."supersededAt" IS NULL
     AND (NEW."supersededById" IS DISTINCT FROM OLD."supersededById"
          OR NEW."supersedeReason" IS DISTINCT FROM OLD."supersedeReason") THEN
    RAISE EXCEPTION 'A bill version''s supersession evidence is writable only WITH the supersession itself — an amendment stamps all three together (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBillVersion_append_only" ON "VendorBillVersion";
CREATE TRIGGER "VendorBillVersion_append_only" BEFORE UPDATE OR DELETE ON "VendorBillVersion"
  FOR EACH ROW EXECUTE FUNCTION phase5_t4_bill_version_append_only();

CREATE OR REPLACE FUNCTION phase5_t4_bill_line_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A vendor bill LINE is immutable — the vendor''s claim is evidence, corrected by a new version, never edited (%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBillLine_append_only" ON "VendorBillLine";
CREATE TRIGGER "VendorBillLine_append_only" BEFORE UPDATE OR DELETE ON "VendorBillLine"
  FOR EACH ROW EXECUTE FUNCTION phase5_t4_bill_line_append_only();

-- ── §G bounds 1 and 2 — the DATABASE seal ────────────────────────────────────────────────────
--
-- §G: "Each is re-derived in-service under FOR UPDATE on the constraining row AND sealed by a
-- PostgreSQL constraint — the Phase-4 Task-3 F3 lesson: a trigger that counts without
-- serializing is not an invariant." So this function takes the PO-line lock BEFORE it counts.
--
-- The check runs at COMMIT, from a DEFERRABLE INITIALLY DEFERRED constraint trigger, and that
-- is load-bearing in BOTH directions:
--
--  • ADDING a claim. A bill is created at `draft` (its lines are not live), then `draft →
--    submitted` makes them live. A BEFORE INSERT check on the LINE would therefore pass on a
--    claim that only becomes live one statement later — the Phase-4 PR-#217 lesson, where a seal
--    durable only at initial insertion was not durable at all.
--  • WITHDRAWING the evidence. An acceptance reversal or a reducing measurement correction lowers
--    the right-hand side of bound 2, and the withdrawal guard DISPUTES enough live claims in the
--    same transaction to restore it (§E's disposition, probe 5an). A deferred check is exactly
--    the right shape for that: it passes when the guard did its job and aborts the transaction
--    when it did not. A BEFORE trigger could only refuse the reversal outright, which is the
--    behaviour §D/§E explicitly rejected — it blocks evidence repair on the strength of a bill
--    nobody has verified.
--
-- LIVE is §0's definition, stated once here and nowhere else in SQL: not superseded, and the
-- bill's status is neither `draft` nor `rejected` nor an unresolved `disputed` nor a terminal
-- `resolved`. The set is written as a NOT IN so it keeps meaning the same thing when Task 5 adds
-- the transitions into `verified` and beyond.
CREATE OR REPLACE FUNCTION phase5_t4_billed_bound_check(p_project text, p_material text, p_labour text)
RETURNS void AS $$
DECLARE
  v_billed numeric;
  v_ordered numeric;
  v_evidence numeric;
  v_version text;
BEGIN
  IF p_material IS NOT NULL THEN
    -- serialize on the constraining row FIRST: two sessions that each counted a fold nobody was
    -- holding would both pass and both commit (Phase-4 T3 F3).
    SELECT "qty" + "approvedOverage", "poVersionId" INTO v_ordered, v_version
      FROM "PurchaseOrderLine" WHERE "projectId" = p_project AND "id" = p_material FOR UPDATE;
    IF v_ordered IS NULL THEN RETURN; END IF;
    -- Codex round-1 F1 — a DEAD order authorises NOTHING, and the first head read the line''s
    -- frozen quantity without ever asking whether its version was still live. `pos.cancel`/amend
    -- moves the old version to `cancelled`/`amended` long after a claim was submitted, and the
    -- service only disputes `order-not-live` at SUBMISSION — so a claim submitted BEFORE the
    -- cancel stayed live against an order nobody owes. Ordered authority is the THIRD withdrawal
    -- path, alongside acceptance reversal and measurement correction (§0b: same rule, every site).
    SELECT CASE WHEN "status" IN ('issued','partially_received','completed','closed_short')
                THEN v_ordered ELSE 0 END INTO v_ordered
      FROM "PurchaseOrderVersion" WHERE "projectId" = p_project AND "id" = v_version;

    SELECT COALESCE(SUM(l."quantity"), 0) INTO v_billed
      FROM "VendorBillLine" l
      JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
      JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
     WHERE l."projectId" = p_project AND l."poLineId" = p_material
       AND v."supersededAt" IS NULL
       AND b."status" NOT IN ('draft', 'rejected', 'disputed', 'resolved');

    IF v_billed > v_ordered THEN
      RAISE EXCEPTION 'Bound 1 breached on purchase-order line %: live claims total % base units against an ordered authority of % (qty + approvedOverage, or ZERO once the version is no longer live)', p_material, v_billed, v_ordered;
    END IF;

    -- `ACCEPTED(poLine)` per §0: acceptance movements NET of reversals whose target is an
    -- acceptance. NOT `accepted − rejected` (disjoint arms understate an 80/20 split as 60), and
    -- NOT the `acceptedOnHand` balance (issuing empties it; a cycle-count adjustment fills it
    -- with no receipt behind it). Acceptance is an EVENT, not a balance.
    SELECT COALESCE(SUM(
             CASE WHEN t."type" = 'acceptance' THEN t."qty"
                  WHEN t."type" = 'reversal' AND target."type" = 'acceptance' THEN -t."qty"
                  ELSE 0 END), 0) INTO v_evidence
      FROM "StockTransaction" t
      JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
      LEFT JOIN "StockTransaction" target ON target."projectId" = t."projectId" AND target."id" = t."reversedTxId"
     WHERE t."projectId" = p_project AND lot."poLineId" = p_material;

    IF v_billed > v_evidence THEN
      RAISE EXCEPTION 'Bound 2 breached on purchase-order line %: live claims total % base units against % accepted', p_material, v_billed, v_evidence;
    END IF;
  END IF;

  IF p_labour IS NOT NULL THEN
    SELECT "personShiftQty", "poVersionId" INTO v_ordered, v_version
      FROM "LabourPurchaseOrderLine" WHERE "projectId" = p_project AND "id" = p_labour FOR UPDATE;
    IF v_ordered IS NULL THEN RETURN; END IF;
    -- the labour twin of the same rule (its live set names `partially_committed`, not
    -- `partially_received` — the two chains have their own version vocabularies)
    SELECT CASE WHEN "status" IN ('issued','partially_committed','completed','closed_short')
                THEN v_ordered ELSE 0 END INTO v_ordered
      FROM "LabourPurchaseOrderVersion" WHERE "projectId" = p_project AND "id" = v_version;

    SELECT COALESCE(SUM(l."quantity"), 0) INTO v_billed
      FROM "VendorBillLine" l
      JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
      JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
     WHERE l."projectId" = p_project AND l."labourPoLineId" = p_labour
       AND v."supersededAt" IS NULL
       AND b."status" NOT IN ('draft', 'rejected', 'disputed', 'resolved');

    -- a labour line has no overage column: §G's ordered authority for labour is `personShiftQty`
    IF v_billed > v_ordered THEN
      RAISE EXCEPTION 'Bound 1 breached on labour purchase-order line %: live claims total % person-shifts against an ordered % (ZERO once the version is no longer live)', p_labour, v_billed, v_ordered;
    END IF;

    -- `MEASURED(poLine)` per §0 — the signed fold, corrections included, never a stored total
    SELECT COALESCE(SUM("quantity"), 0) INTO v_evidence
      FROM "Measurement" WHERE "projectId" = p_project AND "labourPoLineId" = p_labour;

    IF v_billed > v_evidence THEN
      RAISE EXCEPTION 'Bound 2 breached on labour purchase-order line %: live claims total % person-shifts against % measured', p_labour, v_billed, v_evidence;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- A live version must state the money its own lines make, and must HAVE lines. Without the
-- first, `claimedAmount` and `BILLED_AMOUNT` are two truths about one claim and they diverge
-- under amendment; without the second, a live version claiming ₹100 with no line carries money
-- into the billed fold that no bound can ever check, because every bound folds over a PO line.
CREATE OR REPLACE FUNCTION phase5_t4_bill_version_check(p_project text, p_version text)
RETURNS void AS $$
DECLARE v_stated numeric; v_lines numeric; v_count bigint; v_declared int; v_bill text; v_current bigint;
BEGIN
  SELECT "claimedAmount", "lineCount", "billId" INTO v_stated, v_declared, v_bill
    FROM "VendorBillVersion" WHERE "projectId" = p_project AND "id" = p_version;
  IF v_stated IS NULL THEN RETURN; END IF;
  SELECT COUNT(*), COALESCE(SUM("amount"), 0) INTO v_count, v_lines
    FROM "VendorBillLine" WHERE "projectId" = p_project AND "versionId" = p_version;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Bill version % carries no claim line — a claim for nothing cannot be bounded against any purchase-order line', p_version;
  END IF;
  IF v_stated <> v_lines THEN
    RAISE EXCEPTION 'Bill version % states % but its lines total % — the claimed amount is DERIVED from the lines', p_version, v_stated, v_lines;
  END IF;
  -- Codex round-1 F4 — the LINE SET is closed once the version is recorded. The money check alone
  -- does not close it: a ZERO-money line (`rate = 0`, no tax or freight) leaves `claimedAmount`
  -- exactly equal to the line total while adding QUANTITY to `BILLED_QTY`, on a purchase-order line
  -- the original claim never named. `lineCount` is frozen at creation and re-derived here, so a
  -- later append breaks it in any LATER transaction while the service''s own
  -- create-version-then-insert-its-lines sequence — one transaction, one deferred check — is
  -- unaffected. It is deliberately a COUNT and not a quantity: a version can carry base units and
  -- person-shifts at once, and those do not sum to anything.
  IF v_count <> v_declared THEN
    RAISE EXCEPTION 'Bill version % was recorded with % claim line(s) and now has % — a recorded claim''s line set is closed, and a correction is a NEW version', p_version, v_declared, v_count;
  END IF;
  -- Codex round-1 F3 — a bill always has EXACTLY ONE current version. The partial unique forbids
  -- two; nothing forbade ZERO, so stamping the only version superseded with no replacement would
  -- drop a live bill''s whole claim out of the billed folds with the bill still standing.
  SELECT COUNT(*) INTO v_current FROM "VendorBillVersion"
   WHERE "projectId" = p_project AND "billId" = v_bill AND "supersededAt" IS NULL;
  IF v_current <> 1 THEN
    RAISE EXCEPTION 'Vendor bill % has % current version(s) — an amendment supersedes the prior version and issues its replacement in ONE transaction', v_bill, v_current;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t4_line_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t4_bill_version_check(NEW."projectId", NEW."versionId");
  PERFORM phase5_t4_billed_bound_check(NEW."projectId", NEW."poLineId", NEW."labourPoLineId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t4_version_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t4_bill_version_check(NEW."projectId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A status change moves a whole version in or out of the live fold, so it re-checks every PO
-- line the bill's current version touches.
CREATE OR REPLACE FUNCTION phase5_t4_bill_status_sealed() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT l."poLineId", l."labourPoLineId"
      FROM "VendorBillLine" l
      JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
     WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id" AND v."supersededAt" IS NULL
  LOOP
    PERFORM phase5_t4_billed_bound_check(NEW."projectId", r."poLineId", r."labourPoLineId");
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Withdrawing EVIDENCE is the other direction of the same bound. Narrow `WHEN` clauses keep the
-- two hot ledgers untouched except on the rows that can actually lower the right-hand side.
CREATE OR REPLACE FUNCTION phase5_t4_acceptance_withdrawn() RETURNS trigger AS $$
DECLARE v_po text;
BEGIN
  SELECT lot."poLineId" INTO v_po FROM "StockLot" lot
   WHERE lot."projectId" = NEW."projectId" AND lot."id" = NEW."lotId";
  IF v_po IS NOT NULL THEN
    PERFORM phase5_t4_billed_bound_check(NEW."projectId", v_po, NULL);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t4_measurement_withdrawn() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t4_billed_bound_check(NEW."projectId", NULL, NEW."labourPoLineId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBillLine_bound_sealed" ON "VendorBillLine";
CREATE CONSTRAINT TRIGGER "VendorBillLine_bound_sealed"
  AFTER INSERT ON "VendorBillLine" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t4_line_sealed();

-- Codex round-1 F3 — also on UPDATE. Stamping a version superseded changes which version is
-- CURRENT, so the "exactly one current version" rule has to be re-checked there; firing on INSERT
-- alone let the only version of a live bill be stamped with no replacement, dropping the whole
-- claim out of the billed folds while the bill still stood.
DROP TRIGGER IF EXISTS "VendorBillVersion_lines_sealed" ON "VendorBillVersion";
CREATE CONSTRAINT TRIGGER "VendorBillVersion_lines_sealed"
  AFTER INSERT OR UPDATE ON "VendorBillVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t4_version_sealed();

DROP TRIGGER IF EXISTS "VendorBill_bound_sealed" ON "VendorBill";
CREATE CONSTRAINT TRIGGER "VendorBill_bound_sealed"
  AFTER UPDATE ON "VendorBill" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION phase5_t4_bill_status_sealed();

DROP TRIGGER IF EXISTS "StockTransaction_billed_bound_sealed" ON "StockTransaction";
CREATE CONSTRAINT TRIGGER "StockTransaction_billed_bound_sealed"
  AFTER INSERT ON "StockTransaction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."type" = 'reversal')
  EXECUTE FUNCTION phase5_t4_acceptance_withdrawn();

-- Codex round-1 F1 — WITHDRAWING ORDERED AUTHORITY. `StockTransaction` and `Measurement` already
-- fire this check when they lower bound 2's right-hand side; a PO version leaving its live set
-- lowers bound 1's the same way, and nothing fired. Deferred like the others, so the amend/cancel
-- path can dispose of the affected claims in its own transaction and commit — and cannot skip it.
CREATE OR REPLACE FUNCTION phase5_t4_material_order_withdrawn() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT "id" FROM "PurchaseOrderLine"
            WHERE "projectId" = NEW."projectId" AND "poVersionId" = NEW."id" LOOP
    PERFORM phase5_t4_billed_bound_check(NEW."projectId", r."id", NULL);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t4_labour_order_withdrawn() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT "id" FROM "LabourPurchaseOrderLine"
            WHERE "projectId" = NEW."projectId" AND "poVersionId" = NEW."id" LOOP
    PERFORM phase5_t4_billed_bound_check(NEW."projectId", NULL, r."id");
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PurchaseOrderVersion_billed_bound_sealed" ON "PurchaseOrderVersion";
CREATE CONSTRAINT TRIGGER "PurchaseOrderVersion_billed_bound_sealed"
  AFTER UPDATE ON "PurchaseOrderVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION phase5_t4_material_order_withdrawn();

DROP TRIGGER IF EXISTS "LabourPurchaseOrderVersion_billed_bound_sealed" ON "LabourPurchaseOrderVersion";
CREATE CONSTRAINT TRIGGER "LabourPurchaseOrderVersion_billed_bound_sealed"
  AFTER UPDATE ON "LabourPurchaseOrderVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION phase5_t4_labour_order_withdrawn();

DROP TRIGGER IF EXISTS "Measurement_billed_bound_sealed" ON "Measurement";
CREATE CONSTRAINT TRIGGER "Measurement_billed_bound_sealed"
  AFTER INSERT ON "Measurement" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."quantity" < 0)
  EXECUTE FUNCTION phase5_t4_measurement_withdrawn();

-- A legacy database upgrades with the three new tables ROW-FREE. Nothing here creates a bill:
-- the vendor pinning above copies an existing chain onto existing lines, and a claim is always
-- an attributable command.
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "VendorBill") + (SELECT count(*) FROM "VendorBillVersion")
       + (SELECT count(*) FROM "VendorBillLine") INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Phase 5 Task 4 ABORTED: the vendor-bill tables are not row-free after an additive migration that creates no claim (% rows)', n;
  END IF;
END $$;
