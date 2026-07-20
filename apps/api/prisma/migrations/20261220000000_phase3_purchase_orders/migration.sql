-- Phase 3 Task 3 — purchase orders + delivery commitments (§F). Purely ADDITIVE except one
-- CHECK widening: RequisitionLine.status gains 'ordered' (a line fully allocated to live
-- POs). PO lifecycle lives on immutable-versioned rows: amendment ISSUES a new version and
-- retains the prior frozen snapshot verbatim — enforced at PostgreSQL by column-frozen
-- triggers, not convention. Delivery promises are an append-only dated history.

-- §F: 'ordered' joins the requisition-line vocabulary (open|ordered|cancelled).
ALTER TABLE "RequisitionLine" DROP CONSTRAINT "RequisitionLine_status_check";
ALTER TABLE "RequisitionLine" ADD CONSTRAINT "RequisitionLine_status_check"
  CHECK ("status" IN ('open','ordered','cancelled'));

-- ── PurchaseOrder (immutable root) ────────────────────────────────────────────────────────
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrder_projectId_id_key" ON "PurchaseOrder"("projectId", "id");
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- §H: the vendor is reached ONLY through the project binding.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_projectId_vendorId_fkey"
  FOREIGN KEY ("projectId", "vendorId") REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_projectId_requisitionId_fkey"
  FOREIGN KEY ("projectId", "requisitionId") REFERENCES "Requisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── PurchaseOrderVersion ──────────────────────────────────────────────────────────────────
CREATE TABLE "PurchaseOrderVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "supersedesVersion" INTEGER,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "amendedAt" TIMESTAMP(3),
    "amendReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "closedShortAt" TIMESTAMP(3),
    "closeShortReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "PurchaseOrderVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderVersion_status_check"
      CHECK ("status" IN ('draft','issued','partially_received','completed','amended','cancelled','closed_short')),
    -- lifecycle completeness: every post-issue state carries issuance attribution; the two
    -- reasoned closures DEMAND their reason (§F: never a silent cancel/close-short).
    CONSTRAINT "PurchaseOrderVersion_issued_attribution_check"
      CHECK ("status" NOT IN ('issued','partially_received','completed','amended','closed_short')
             OR ("issuedById" IS NOT NULL AND "issuedAt" IS NOT NULL)),
    CONSTRAINT "PurchaseOrderVersion_cancel_reason_check"
      CHECK ("status" <> 'cancelled' OR "cancelReason" IS NOT NULL),
    CONSTRAINT "PurchaseOrderVersion_close_short_reason_check"
      CHECK ("status" <> 'closed_short' OR "closeShortReason" IS NOT NULL),
    CONSTRAINT "PurchaseOrderVersion_amend_reason_check"
      CHECK ("status" <> 'amended' OR "amendReason" IS NOT NULL),
    CONSTRAINT "PurchaseOrderVersion_version_check" CHECK ("version" >= 1),
    CONSTRAINT "PurchaseOrderVersion_supersedes_check"
      CHECK ("supersedesVersion" IS NULL OR "supersedesVersion" = "version" - 1)
);
CREATE UNIQUE INDEX "PurchaseOrderVersion_poId_version_key" ON "PurchaseOrderVersion"("poId", "version");
CREATE UNIQUE INDEX "PurchaseOrderVersion_projectId_id_key" ON "PurchaseOrderVersion"("projectId", "id");
ALTER TABLE "PurchaseOrderVersion" ADD CONSTRAINT "PurchaseOrderVersion_projectId_poId_fkey"
  FOREIGN KEY ("projectId", "poId") REFERENCES "PurchaseOrder"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrderVersion" ADD CONSTRAINT "PurchaseOrderVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── PurchaseOrderLine (frozen commercial snapshot) ────────────────────────────────────────
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poVersionId" TEXT NOT NULL,
    "requisitionLineId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "specFingerprint" TEXT,
    "quotedMake" TEXT,
    "uom" TEXT NOT NULL,
    "uomConversion" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "qty" DECIMAL(18,6) NOT NULL,
    "rate" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "freightAmount" DECIMAL(18,2) NOT NULL,
    "landedAmount" DECIMAL(18,2) NOT NULL,
    "committedAmountBase" DECIMAL(18,2) NOT NULL,
    "approvedOverage" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "overageReason" TEXT,
    "receivedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderLine_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "PurchaseOrderLine_uom_conversion_check" CHECK ("uomConversion" > 0),
    CONSTRAINT "PurchaseOrderLine_amounts_check"
      CHECK ("rate" >= 0 AND "taxAmount" >= 0 AND "freightAmount" >= 0 AND "landedAmount" >= 0 AND "committedAmountBase" >= 0),
    -- §F: overage is BOUNDED headroom, never negative, and never unexplained.
    CONSTRAINT "PurchaseOrderLine_overage_check" CHECK ("approvedOverage" >= 0),
    CONSTRAINT "PurchaseOrderLine_overage_reason_check" CHECK ("approvedOverage" = 0 OR "overageReason" IS NOT NULL),
    CONSTRAINT "PurchaseOrderLine_received_check" CHECK ("receivedQty" >= 0)
);
CREATE UNIQUE INDEX "PurchaseOrderLine_projectId_id_key" ON "PurchaseOrderLine"("projectId", "id");
CREATE INDEX "PurchaseOrderLine_projectId_requisitionLineId_idx" ON "PurchaseOrderLine"("projectId", "requisitionLineId");
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_projectId_poVersionId_fkey"
  FOREIGN KEY ("projectId", "poVersionId") REFERENCES "PurchaseOrderVersion"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_projectId_requisitionLineId_fkey"
  FOREIGN KEY ("projectId", "requisitionLineId") REFERENCES "RequisitionLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── DeliveryCommitment + append-only DeliveryPromise ──────────────────────────────────────
CREATE TABLE "DeliveryCommitment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'committed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "fulfilledAt" TIMESTAMP(3),
    "defaultedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryCommitment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryCommitment_status_check" CHECK ("status" IN ('committed','revised','fulfilled','defaulted'))
);
CREATE UNIQUE INDEX "DeliveryCommitment_projectId_id_key" ON "DeliveryCommitment"("projectId", "id");
ALTER TABLE "DeliveryCommitment" ADD CONSTRAINT "DeliveryCommitment_projectId_poLineId_fkey"
  FOREIGN KEY ("projectId", "poLineId") REFERENCES "PurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "DeliveryCommitment" ADD CONSTRAINT "DeliveryCommitment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "DeliveryPromise" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "promisedDate" DATE NOT NULL,
    "reason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,

    CONSTRAINT "DeliveryPromise_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeliveryPromise_seq_check" CHECK ("seq" >= 1),
    -- every REVISION explains itself; only the initial promise (seq 1) may omit the reason
    CONSTRAINT "DeliveryPromise_revision_reason_check" CHECK ("seq" = 1 OR "reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "DeliveryPromise_commitmentId_seq_key" ON "DeliveryPromise"("commitmentId", "seq");
CREATE UNIQUE INDEX "DeliveryPromise_projectId_id_key" ON "DeliveryPromise"("projectId", "id");
ALTER TABLE "DeliveryPromise" ADD CONSTRAINT "DeliveryPromise_projectId_commitmentId_fkey"
  FOREIGN KEY ("projectId", "commitmentId") REFERENCES "DeliveryCommitment"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "DeliveryPromise" ADD CONSTRAINT "DeliveryPromise_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── PostgreSQL-enforced immutability ──────────────────────────────────────────────────────
-- phase3_immutable_row() exists since 20261212000000_phase3_approval_provenance.
-- The PO root and every promise row are fully immutable.
CREATE TRIGGER "PurchaseOrder_append_only"
  BEFORE UPDATE OR DELETE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
CREATE TRIGGER "DeliveryPromise_append_only"
  BEFORE UPDATE OR DELETE ON "DeliveryPromise"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- A version row may change ONLY its lifecycle columns (status + transition attribution).
-- Identity, lineage and creation facts are frozen; rows are never deleted.
CREATE OR REPLACE FUNCTION phase3_po_version_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrderVersion rows are never deleted (versioned history, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poId" <> OLD."poId"
     OR NEW."version" <> OLD."version"
     OR NEW."supersedesVersion" IS DISTINCT FROM OLD."supersedesVersion"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'PurchaseOrderVersion identity/lineage is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PurchaseOrderVersion_lifecycle_only"
  BEFORE UPDATE OR DELETE ON "PurchaseOrderVersion"
  FOR EACH ROW EXECUTE FUNCTION phase3_po_version_lifecycle_only();

-- The FROZEN line snapshot (§F): after creation only receivedQty (Task-4 receipts through
-- the participant) and the issuance/amendment-time approvedOverage(+reason) may change —
-- every commercial fact is immutable at PostgreSQL. Rows are never deleted.
CREATE OR REPLACE FUNCTION phase3_po_line_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PurchaseOrderLine rows are never deleted (frozen snapshot, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poVersionId" <> OLD."poVersionId"
     OR NEW."requisitionLineId" <> OLD."requisitionLineId"
     OR NEW."requirementId" <> OLD."requirementId" OR NEW."revision" <> OLD."revision"
     OR NEW."specFingerprint" IS DISTINCT FROM OLD."specFingerprint"
     OR NEW."quotedMake" IS DISTINCT FROM OLD."quotedMake"
     OR NEW."uom" <> OLD."uom" OR NEW."uomConversion" <> OLD."uomConversion"
     OR NEW."qty" <> OLD."qty" OR NEW."rate" <> OLD."rate"
     OR NEW."taxAmount" <> OLD."taxAmount" OR NEW."freightAmount" <> OLD."freightAmount"
     OR NEW."landedAmount" <> OLD."landedAmount" OR NEW."committedAmountBase" <> OLD."committedAmountBase" THEN
    RAISE EXCEPTION 'PurchaseOrderLine commercial snapshot is FROZEN — only receivedQty and issuance-time approvedOverage may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PurchaseOrderLine_frozen"
  BEFORE UPDATE OR DELETE ON "PurchaseOrderLine"
  FOR EACH ROW EXECUTE FUNCTION phase3_po_line_frozen();

-- A commitment may change ONLY its lifecycle columns; rows are never deleted.
CREATE OR REPLACE FUNCTION phase3_commitment_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DeliveryCommitment rows are never deleted (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poLineId" <> OLD."poLineId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'DeliveryCommitment identity is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DeliveryCommitment_lifecycle_only"
  BEFORE UPDATE OR DELETE ON "DeliveryCommitment"
  FOR EACH ROW EXECUTE FUNCTION phase3_commitment_lifecycle_only();
