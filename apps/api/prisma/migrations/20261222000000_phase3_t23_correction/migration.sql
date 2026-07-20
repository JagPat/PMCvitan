-- Phase 3 Tasks 2-3 correction (review findings F2/F4/F5/F6) — forward-only, diagnostic
-- FIRST: every backfill/constraint refuses ambiguous existing data with sampled row ids
-- rather than guessing. F1/F3/F7 are command-surface corrections (service layer) backed
-- here by the sealed comparison, the match-only fingerprint NOT NULL, and the provenance
-- FK chain.

-- ── F5 — at most ONE 'recorded' quote per (projectId, rfqId, vendorId) ────────────────────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(k, ', ') INTO bad FROM (
    SELECT ("projectId" || '/' || "rfqId" || '/' || "vendorId") AS k
    FROM "VendorQuote" WHERE "status" = 'recorded'
    GROUP BY "projectId", "rfqId", "vendorId" HAVING COUNT(*) > 1 LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: multiple RECORDED quotes for the same rfq/vendor — operator must supersede duplicates before upgrading. Sample keys: %', bad;
  END IF;
END $$;
CREATE UNIQUE INDEX "VendorQuote_one_recorded_per_rfq_vendor"
  ON "VendorQuote"("projectId", "rfqId", "vendorId") WHERE "status" = 'recorded';

-- ── F6 — exactly ONE delivery commitment per PO line (revisions append to it) ─────────────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("poLineId", ', ') INTO bad FROM (
    SELECT "poLineId" FROM "DeliveryCommitment"
    GROUP BY "projectId", "poLineId" HAVING COUNT(*) > 1 LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: multiple delivery commitments on one PO line — operator must resolve before upgrading. Sample poLineIds: %', bad;
  END IF;
END $$;
CREATE UNIQUE INDEX "DeliveryCommitment_projectId_poLineId_key"
  ON "DeliveryCommitment"("projectId", "poLineId");

-- ── F4 — backing candidate keys for the provenance chain ──────────────────────────────────
CREATE UNIQUE INDEX "Rfq_projectId_id_requisitionId_key" ON "Rfq"("projectId", "id", "requisitionId");
CREATE UNIQUE INDEX "VendorQuote_projectId_rfqId_vendorId_id_key" ON "VendorQuote"("projectId", "rfqId", "vendorId", "id");
CREATE UNIQUE INDEX "RequisitionLine_projectId_id_requirementId_revision_key"
  ON "RequisitionLine"("projectId", "id", "requirementId", "revision");

-- ── F4 — QuoteComparison.requisitionId: denormalized provenance, backfilled + FK-sealed ───
ALTER TABLE "QuoteComparison" ADD COLUMN "requisitionId" TEXT;
UPDATE "QuoteComparison" c SET "requisitionId" = r."requisitionId"
  FROM "Rfq" r WHERE r."projectId" = c."projectId" AND r."id" = c."rfqId";
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT "id" FROM "QuoteComparison" WHERE "requisitionId" IS NULL LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: comparison rows whose RFQ could not be resolved. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "QuoteComparison" ALTER COLUMN "requisitionId" SET NOT NULL;
ALTER TABLE "QuoteComparison" ADD CONSTRAINT "QuoteComparison_projectId_rfqId_requisitionId_fkey"
  FOREIGN KEY ("projectId", "rfqId", "requisitionId") REFERENCES "Rfq"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "QuoteComparison_provenance_key"
  ON "QuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId");

-- The SELECTION is sealed to a quote of the SAME rfq, and selectedVendorId to that quote's
-- REAL vendor (MATCH SIMPLE: enforced once the approval fills the columns).
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(c."id", ', ') INTO bad FROM (
    SELECT c."id" FROM "QuoteComparison" c
    WHERE c."selectedQuoteId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "VendorQuote" q
        WHERE q."projectId" = c."projectId" AND q."rfqId" = c."rfqId"
          AND q."vendorId" = c."selectedVendorId" AND q."id" = c."selectedQuoteId")
    LIMIT 5
  ) c;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED PROVENANCE: comparison selections naming a quote outside their rfq/vendor. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "QuoteComparison" DROP CONSTRAINT "QuoteComparison_projectId_selectedQuoteId_fkey";
ALTER TABLE "QuoteComparison" ADD CONSTRAINT "QuoteComparison_selection_fkey"
  FOREIGN KEY ("projectId", "rfqId", "selectedVendorId", "selectedQuoteId")
  REFERENCES "VendorQuote"("projectId", "rfqId", "vendorId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F4 — PurchaseOrder provenance: comparisonId becomes a REAL, vendor+requisition-sealed FK
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(p."id", ', ') INTO bad FROM (
    SELECT p."id" FROM "PurchaseOrder" p
    WHERE NOT EXISTS (
      SELECT 1 FROM "QuoteComparison" c
      WHERE c."projectId" = p."projectId" AND c."id" = p."comparisonId"
        AND c."selectedVendorId" = p."vendorId" AND c."requisitionId" = p."requisitionId")
    LIMIT 5
  ) p;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED PROVENANCE: purchase orders whose comparison/vendor/requisition chain does not hold. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_comparison_provenance_fkey"
  FOREIGN KEY ("projectId", "comparisonId", "vendorId", "requisitionId")
  REFERENCES "QuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F4 — the PO line's frozen requirement pin is sealed to ITS requisition line's pin ─────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(l."id", ', ') INTO bad FROM (
    SELECT l."id" FROM "PurchaseOrderLine" l
    WHERE NOT EXISTS (
      SELECT 1 FROM "RequisitionLine" r
      WHERE r."projectId" = l."projectId" AND r."id" = l."requisitionLineId"
        AND r."requirementId" = l."requirementId" AND r."revision" = l."revision")
    LIMIT 5
  ) l;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED PIN: PO lines whose frozen (requirementId, revision) differs from their requisition line. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_requirement_pin_fkey"
  FOREIGN KEY ("projectId", "requisitionLineId", "requirementId", "revision")
  REFERENCES "RequisitionLine"("projectId", "id", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F4 — approved commercial evidence is database-immutable ───────────────────────────────
-- Quote lines: fully immutable (phase3_immutable_row exists since 20261212000000).
CREATE TRIGGER "VendorQuoteLine_append_only"
  BEFORE UPDATE OR DELETE ON "VendorQuoteLine"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
-- Quotes: lifecycle-only — ONLY the documented status transitions may be written.
CREATE OR REPLACE FUNCTION phase3_quote_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VendorQuote rows are never deleted (append-only commercial evidence, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."rfqId" <> OLD."rfqId"
     OR NEW."vendorId" <> OLD."vendorId" OR NEW."validUntil" <> OLD."validUntil"
     OR NEW."leadTimeDays" IS DISTINCT FROM OLD."leadTimeDays"
     OR NEW."paymentTerms" IS DISTINCT FROM OLD."paymentTerms"
     OR NEW."warrantyTerms" IS DISTINCT FROM OLD."warrantyTerms"
     OR NEW."historicalScore" IS DISTINCT FROM OLD."historicalScore"
     OR NEW."recordedAt" <> OLD."recordedAt" OR NEW."recordedById" <> OLD."recordedById" THEN
    RAISE EXCEPTION 'VendorQuote is frozen except its lifecycle status (%)', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'recorded' AND NEW."status" IN ('superseded', 'expired')) THEN
    RAISE EXCEPTION 'VendorQuote status may only move recorded -> superseded|expired (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "VendorQuote_lifecycle_only"
  BEFORE UPDATE OR DELETE ON "VendorQuote"
  FOR EACH ROW EXECUTE FUNCTION phase3_quote_lifecycle_only();
-- Comparisons: identity frozen; only the approval columns may be written; an APPROVED row
-- is fully sealed forever.
CREATE OR REPLACE FUNCTION phase3_comparison_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'QuoteComparison rows are never deleted (%)', OLD."id";
  END IF;
  IF OLD."status" = 'approved' THEN
    RAISE EXCEPTION 'An APPROVED comparison is sealed — no column may change (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."rfqId" <> OLD."rfqId"
     OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'QuoteComparison identity is frozen — only the approval columns may be written (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "QuoteComparison_lifecycle_only"
  BEFORE UPDATE OR DELETE ON "QuoteComparison"
  FOR EACH ROW EXECUTE FUNCTION phase3_comparison_lifecycle_only();

-- ── F2 — the explicit purchase-UOM triple; base qty becomes DERIVED ───────────────────────
ALTER TABLE "PurchaseOrderLine" RENAME COLUMN "uomConversion" TO "conversionToBase";
ALTER TABLE "PurchaseOrderLine" RENAME CONSTRAINT "PurchaseOrderLine_uom_conversion_check" TO "PurchaseOrderLine_conversion_check";
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "purchaseUom" TEXT;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "purchaseQty" DECIMAL(18,6);
-- Existing rows recorded qty as base with a conversion factor MULTIPLIED into cost — for
-- conversion = 1 the purchase semantics are unambiguous (purchase unit == base unit); any
-- other factor cannot be inverted safely and must abort for operator repair.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT "id" FROM "PurchaseOrderLine" WHERE "conversionToBase" <> 1 LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: PO lines with a non-1 UOM conversion predate the purchase-quantity model — operator must restate them. Sample ids: %', bad;
  END IF;
END $$;
-- The frozen-column trigger guards these columns from Task 3 on; a targeted backfill of the
-- NEW columns is the sanctioned, in-the-open exception (disable/re-enable, like the
-- upgrade-proof operator repair).
ALTER TABLE "PurchaseOrderLine" DISABLE TRIGGER "PurchaseOrderLine_frozen";
UPDATE "PurchaseOrderLine" SET "purchaseUom" = "uom", "purchaseQty" = "qty" WHERE "purchaseQty" IS NULL;
ALTER TABLE "PurchaseOrderLine" ENABLE TRIGGER "PurchaseOrderLine_frozen";
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "purchaseUom" SET NOT NULL;
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "purchaseQty" SET NOT NULL;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchase_qty_check" CHECK ("purchaseQty" > 0);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_base_qty_derivation_check"
  CHECK ("qty" = round("purchaseQty" * "conversionToBase", 6));

-- ── F1 — the demanded material identity is ALWAYS present (match-only pipeline) ───────────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT "id" FROM "PurchaseOrderLine" WHERE "specFingerprint" IS NULL LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: PO lines without a material fingerprint — operator must resolve their requirement identity. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "specFingerprint" SET NOT NULL;

-- ── the frozen-snapshot trigger learns the corrected column set ───────────────────────────
CREATE OR REPLACE FUNCTION phase3_po_line_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrderLine rows are never deleted (frozen snapshot, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poVersionId" <> OLD."poVersionId"
     OR NEW."requisitionLineId" <> OLD."requisitionLineId"
     OR NEW."requirementId" <> OLD."requirementId" OR NEW."revision" <> OLD."revision"
     OR NEW."specFingerprint" <> OLD."specFingerprint"
     OR NEW."quotedMake" IS DISTINCT FROM OLD."quotedMake"
     OR NEW."uom" <> OLD."uom" OR NEW."purchaseUom" <> OLD."purchaseUom"
     OR NEW."purchaseQty" <> OLD."purchaseQty" OR NEW."conversionToBase" <> OLD."conversionToBase"
     OR NEW."qty" <> OLD."qty" OR NEW."rate" <> OLD."rate"
     OR NEW."taxAmount" <> OLD."taxAmount" OR NEW."freightAmount" <> OLD."freightAmount"
     OR NEW."landedAmount" <> OLD."landedAmount" OR NEW."committedAmountBase" <> OLD."committedAmountBase" THEN
    RAISE EXCEPTION 'PurchaseOrderLine commercial snapshot is FROZEN — only receivedQty and issuance-time approvedOverage may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
