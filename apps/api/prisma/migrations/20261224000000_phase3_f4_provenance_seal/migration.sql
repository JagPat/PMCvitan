-- Phase 3 Tasks 2-3 correction round 2 — F4 completion (the two remaining P1 gaps).
-- Forward-only, diagnostic FIRST: every backfill/constraint refuses ambiguous or forged
-- existing data with sampled ids. Backfills of NEW columns on trigger-guarded tables use the
-- sanctioned in-the-open disable/re-enable window (the round-1 pattern).
--
--   P1-a: comparison STATUS joins the PO provenance FK — a purchase order referencing a
--         DRAFT comparison becomes unrepresentable (the service check gains a DB seal).
--   P1-b: requisition CONTAINMENT is sealed through quote lines AND PO lines via immutable
--         denormalized requisitionId columns + composite FKs — a quote for requisition A
--         can never hold a line of requisition B, and neither can a PO.

-- ── containment FK targets ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "RequisitionLine_projectId_requisitionId_id_key"
  ON "RequisitionLine"("projectId", "requisitionId", "id");

-- ── VendorQuote.requisitionId (denormalized from its RFQ, immutable) ──────────────────────
ALTER TABLE "VendorQuote" ADD COLUMN "requisitionId" TEXT;
ALTER TABLE "VendorQuote" DISABLE TRIGGER "VendorQuote_lifecycle_only";
UPDATE "VendorQuote" q SET "requisitionId" = r."requisitionId"
  FROM "Rfq" r WHERE r."projectId" = q."projectId" AND r."id" = q."rfqId";
ALTER TABLE "VendorQuote" ENABLE TRIGGER "VendorQuote_lifecycle_only";
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (SELECT "id" FROM "VendorQuote" WHERE "requisitionId" IS NULL LIMIT 5) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: quotes whose RFQ could not be resolved. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "VendorQuote" ALTER COLUMN "requisitionId" SET NOT NULL;
ALTER TABLE "VendorQuote" ADD CONSTRAINT "VendorQuote_projectId_rfqId_requisitionId_fkey"
  FOREIGN KEY ("projectId", "rfqId", "requisitionId") REFERENCES "Rfq"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "VendorQuote_projectId_id_requisitionId_key" ON "VendorQuote"("projectId", "id", "requisitionId");

-- ── VendorQuoteLine.requisitionId — containment sealed BOTH ways ──────────────────────────
ALTER TABLE "VendorQuoteLine" ADD COLUMN "requisitionId" TEXT;
-- FORGED-CONTAINMENT diagnostic BEFORE backfilling: a line whose requisition line belongs to
-- a DIFFERENT requisition than its quote's RFQ is evidence corruption — abort for operator
-- repair, never guess which side is right.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT l."id" FROM "VendorQuoteLine" l
    JOIN "VendorQuote" q ON q."projectId" = l."projectId" AND q."id" = l."quoteId"
    JOIN "RequisitionLine" rl ON rl."projectId" = l."projectId" AND rl."id" = l."requisitionLineId"
    WHERE rl."requisitionId" <> q."requisitionId"
    LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED CONTAINMENT: quote lines referencing a DIFFERENT requisition than their quote''s RFQ. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "VendorQuoteLine" DISABLE TRIGGER "VendorQuoteLine_append_only";
UPDATE "VendorQuoteLine" l SET "requisitionId" = rl."requisitionId"
  FROM "RequisitionLine" rl WHERE rl."projectId" = l."projectId" AND rl."id" = l."requisitionLineId";
ALTER TABLE "VendorQuoteLine" ENABLE TRIGGER "VendorQuoteLine_append_only";
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (SELECT "id" FROM "VendorQuoteLine" WHERE "requisitionId" IS NULL LIMIT 5) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: quote lines whose requisition line could not be resolved. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "VendorQuoteLine" ALTER COLUMN "requisitionId" SET NOT NULL;
ALTER TABLE "VendorQuoteLine" ADD CONSTRAINT "VendorQuoteLine_quote_containment_fkey"
  FOREIGN KEY ("projectId", "quoteId", "requisitionId") REFERENCES "VendorQuote"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "VendorQuoteLine" ADD CONSTRAINT "VendorQuoteLine_line_containment_fkey"
  FOREIGN KEY ("projectId", "requisitionId", "requisitionLineId") REFERENCES "RequisitionLine"("projectId", "requisitionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── PurchaseOrderVersion.requisitionId (denormalized from its root, immutable) ────────────
CREATE UNIQUE INDEX "PurchaseOrder_projectId_id_requisitionId_key" ON "PurchaseOrder"("projectId", "id", "requisitionId");
ALTER TABLE "PurchaseOrderVersion" ADD COLUMN "requisitionId" TEXT;
ALTER TABLE "PurchaseOrderVersion" DISABLE TRIGGER "PurchaseOrderVersion_lifecycle_only";
UPDATE "PurchaseOrderVersion" v SET "requisitionId" = p."requisitionId"
  FROM "PurchaseOrder" p WHERE p."projectId" = v."projectId" AND p."id" = v."poId";
ALTER TABLE "PurchaseOrderVersion" ENABLE TRIGGER "PurchaseOrderVersion_lifecycle_only";
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (SELECT "id" FROM "PurchaseOrderVersion" WHERE "requisitionId" IS NULL LIMIT 5) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: PO versions whose root could not be resolved. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrderVersion" ALTER COLUMN "requisitionId" SET NOT NULL;
ALTER TABLE "PurchaseOrderVersion" ADD CONSTRAINT "PurchaseOrderVersion_root_containment_fkey"
  FOREIGN KEY ("projectId", "poId", "requisitionId") REFERENCES "PurchaseOrder"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "PurchaseOrderVersion_projectId_id_requisitionId_key" ON "PurchaseOrderVersion"("projectId", "id", "requisitionId");

-- ── PurchaseOrderLine.requisitionId — containment sealed BOTH ways ────────────────────────
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "requisitionId" TEXT;
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT l."id" FROM "PurchaseOrderLine" l
    JOIN "PurchaseOrderVersion" v ON v."projectId" = l."projectId" AND v."id" = l."poVersionId"
    JOIN "RequisitionLine" rl ON rl."projectId" = l."projectId" AND rl."id" = l."requisitionLineId"
    WHERE rl."requisitionId" <> v."requisitionId"
    LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED CONTAINMENT: PO lines referencing a DIFFERENT requisition than their purchase order. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrderLine" DISABLE TRIGGER "PurchaseOrderLine_frozen";
UPDATE "PurchaseOrderLine" l SET "requisitionId" = rl."requisitionId"
  FROM "RequisitionLine" rl WHERE rl."projectId" = l."projectId" AND rl."id" = l."requisitionLineId";
ALTER TABLE "PurchaseOrderLine" ENABLE TRIGGER "PurchaseOrderLine_frozen";
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (SELECT "id" FROM "PurchaseOrderLine" WHERE "requisitionId" IS NULL LIMIT 5) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'AMBIGUOUS DATA: PO lines whose requisition line could not be resolved. Sample ids: %', bad;
  END IF;
END $$;
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "requisitionId" SET NOT NULL;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_version_containment_fkey"
  FOREIGN KEY ("projectId", "poVersionId", "requisitionId") REFERENCES "PurchaseOrderVersion"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_line_containment_fkey"
  FOREIGN KEY ("projectId", "requisitionId", "requisitionLineId") REFERENCES "RequisitionLine"("projectId", "requisitionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── PurchaseOrder.comparisonStatus — 'approved' joins the provenance FK ───────────────────
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg("id", ', ') INTO bad FROM (
    SELECT p."id" FROM "PurchaseOrder" p
    JOIN "QuoteComparison" c ON c."projectId" = p."projectId" AND c."id" = p."comparisonId"
    WHERE c."status" <> 'approved'
    LIMIT 5
  ) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FORGED PROVENANCE: purchase orders referencing a NON-APPROVED comparison. Sample ids: %', bad;
  END IF;
END $$;
-- ADD COLUMN ... DEFAULT fills existing rows without firing row triggers (the root stays
-- append-only); the CHECK pins every present and future row to 'approved'.
ALTER TABLE "PurchaseOrder" ADD COLUMN "comparisonStatus" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_comparison_status_check" CHECK ("comparisonStatus" = 'approved');
CREATE UNIQUE INDEX "QuoteComparison_provenance_status_key"
  ON "QuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId", "status");
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT "PurchaseOrder_comparison_provenance_fkey";
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_comparison_provenance_fkey"
  FOREIGN KEY ("projectId", "comparisonId", "vendorId", "requisitionId", "comparisonStatus")
  REFERENCES "QuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId", "status") ON DELETE NO ACTION ON UPDATE NO ACTION;
DROP INDEX "QuoteComparison_provenance_key";

-- ── the guarding triggers learn the new provenance columns ────────────────────────────────
CREATE OR REPLACE FUNCTION phase3_quote_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VendorQuote rows are never deleted (append-only commercial evidence, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."rfqId" <> OLD."rfqId"
     OR NEW."requisitionId" <> OLD."requisitionId"
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

CREATE OR REPLACE FUNCTION phase3_po_version_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrderVersion rows are never deleted (versioned history, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poId" <> OLD."poId"
     OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."version" <> OLD."version"
     OR NEW."supersedesVersion" IS DISTINCT FROM OLD."supersedesVersion"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'PurchaseOrderVersion identity/lineage is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
     OR NEW."landedAmount" <> OLD."landedAmount" OR NEW."committedAmountBase" <> OLD."committedAmountBase" THEN
    RAISE EXCEPTION 'PurchaseOrderLine commercial snapshot is FROZEN — only receivedQty and issuance-time approvedOverage may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
