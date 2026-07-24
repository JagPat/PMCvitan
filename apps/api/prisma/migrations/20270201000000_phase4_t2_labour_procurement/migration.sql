-- Phase 4 Task 2 — the LABOUR COMMERCIAL chain (plan §F).
--
-- Additive + diagnostic-first. These are BRAND-NEW labour-owned tables (no backfill of any existing
-- table, so there is no ambiguous legacy data to migrate) — a legacy database upgrades ROW-FREE: the
-- tables and their seals exist but hold zero rows until a pilot uses them. The material-procurement
-- corrections (rename/backfill windows) are FOLDED into these greenfield CREATE TABLEs, so no
-- disable/backfill/re-enable dance is needed. Every §F bound (requirement→requisition,
-- requisition→PO) is enforced in the SERVICE layer under FOR UPDATE — like material — not by a DB
-- trigger; the DB seals here are the CAS/frozen-snapshot/append-only/provenance invariants.

-- Diagnostic-first guard: these tables must not already exist with rows (a re-application over a
-- partially-migrated DB). On a clean legacy DB this is a no-op.
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public."LabourRequisition"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "LabourRequisition"' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'AMBIGUOUS STATE: "LabourRequisition" already holds % row(s) before the Phase-4 Task-2 migration — operator must reconcile before upgrading.', n;
    END IF;
  END IF;
END $$;

-- ── VendorLabourProfile (org-scoped, org-admin authority) ────────────────────────────────────
CREATE TABLE "VendorLabourProfile" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "trades" TEXT[] NOT NULL,
  "skills" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "VendorLabourProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorLabourProfile_orgId_vendorId_key" ON "VendorLabourProfile"("orgId", "vendorId");
CREATE UNIQUE INDEX "VendorLabourProfile_orgId_id_key" ON "VendorLabourProfile"("orgId", "id");

-- ── LabourRequisition ────────────────────────────────────────────────────────────────────────
CREATE TABLE "LabourRequisition" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "submittedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectedReason" TEXT,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "LabourRequisition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourRequisition_status_check" CHECK ("status" IN ('draft','submitted','approved','rejected','closed'))
);
CREATE UNIQUE INDEX "LabourRequisition_projectId_id_key" ON "LabourRequisition"("projectId", "id");

-- ── LabourRequisitionLine (one demand slice; §F bound-1 allocation unit) ───────────────────────
CREATE TABLE "LabourRequisitionLine" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "civilDate" DATE NOT NULL,
  "shift" TEXT NOT NULL,
  "labourSpecFingerprint" TEXT NOT NULL,
  "personShiftQty" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" TEXT,
  CONSTRAINT "LabourRequisitionLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourRequisitionLine_status_check" CHECK ("status" IN ('open','ordered','cancelled')),
  CONSTRAINT "LabourRequisitionLine_qty_check" CHECK ("personShiftQty" > 0),
  CONSTRAINT "LabourRequisitionLine_shift_check" CHECK ("shift" IN ('day','night'))
);
CREATE UNIQUE INDEX "LabourRequisitionLine_projectId_id_key" ON "LabourRequisitionLine"("projectId", "id");
CREATE UNIQUE INDEX "LabourRequisitionLine_projectId_id_requirementId_revision_key" ON "LabourRequisitionLine"("projectId", "id", "requirementId", "revision");
CREATE UNIQUE INDEX "LabourRequisitionLine_projectId_requisitionId_id_key" ON "LabourRequisitionLine"("projectId", "requisitionId", "id");
CREATE INDEX "LabourRequisitionLine_projectId_requirementId_revision_idx" ON "LabourRequisitionLine"("projectId", "requirementId", "revision");

-- ── LabourRfq ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "LabourRfq" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedById" TEXT NOT NULL,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "LabourRfq_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourRfq_status_check" CHECK ("status" IN ('issued','closed'))
);
CREATE UNIQUE INDEX "LabourRfq_projectId_id_key" ON "LabourRfq"("projectId", "id");
CREATE UNIQUE INDEX "LabourRfq_projectId_id_requisitionId_key" ON "LabourRfq"("projectId", "id", "requisitionId");

-- ── SupplierLabourQuote ────────────────────────────────────────────────────────────────────────
CREATE TABLE "SupplierLabourQuote" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "rfqId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'recorded',
  "validUntil" DATE NOT NULL,
  "leadTimeDays" INTEGER,
  "notes" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" TEXT NOT NULL,
  CONSTRAINT "SupplierLabourQuote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierLabourQuote_status_check" CHECK ("status" IN ('recorded','superseded','expired'))
);
CREATE UNIQUE INDEX "SupplierLabourQuote_projectId_id_key" ON "SupplierLabourQuote"("projectId", "id");
CREATE UNIQUE INDEX "SupplierLabourQuote_projectId_rfqId_vendorId_id_key" ON "SupplierLabourQuote"("projectId", "rfqId", "vendorId", "id");
CREATE UNIQUE INDEX "SupplierLabourQuote_projectId_id_requisitionId_key" ON "SupplierLabourQuote"("projectId", "id", "requisitionId");
CREATE INDEX "SupplierLabourQuote_projectId_rfqId_vendorId_idx" ON "SupplierLabourQuote"("projectId", "rfqId", "vendorId");
-- one RECORDED quote per (project, rfq, vendor) — a new recording supersedes the prior
CREATE UNIQUE INDEX "SupplierLabourQuote_one_recorded_per_rfq_vendor" ON "SupplierLabourQuote"("projectId", "rfqId", "vendorId") WHERE "status" = 'recorded';

-- ── SupplierLabourQuoteLine ──────────────────────────────────────────────────────────────────
CREATE TABLE "SupplierLabourQuoteLine" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "requisitionLineId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "ratePerPersonShift" DECIMAL(18,2) NOT NULL,
  "shiftPremium" DECIMAL(18,2) NOT NULL,
  "landedPerPersonShift" DECIMAL(18,2) NOT NULL,
  "matchesSpecification" BOOLEAN NOT NULL,
  CONSTRAINT "SupplierLabourQuoteLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierLabourQuoteLine_amounts_check" CHECK ("ratePerPersonShift" >= 0 AND "shiftPremium" >= 0 AND "landedPerPersonShift" >= 0)
);
CREATE UNIQUE INDEX "SupplierLabourQuoteLine_quoteId_requisitionLineId_key" ON "SupplierLabourQuoteLine"("quoteId", "requisitionLineId");
CREATE UNIQUE INDEX "SupplierLabourQuoteLine_projectId_id_key" ON "SupplierLabourQuoteLine"("projectId", "id");

-- ── LabourQuoteComparison ────────────────────────────────────────────────────────────────────
CREATE TABLE "LabourQuoteComparison" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "rfqId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "selectedQuoteId" TEXT,
  "selectedVendorId" TEXT,
  "reason" TEXT,
  "justification" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  CONSTRAINT "LabourQuoteComparison_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourQuoteComparison_status_check" CHECK ("status" IN ('draft','approved')),
  CONSTRAINT "LabourQuoteComparison_approval_check" CHECK (
    "status" <> 'approved' OR (
      "selectedQuoteId" IS NOT NULL AND "selectedVendorId" IS NOT NULL AND
      "reason" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX "LabourQuoteComparison_projectId_rfqId_key" ON "LabourQuoteComparison"("projectId", "rfqId");
CREATE UNIQUE INDEX "LabourQuoteComparison_projectId_id_key" ON "LabourQuoteComparison"("projectId", "id");
CREATE UNIQUE INDEX "LabourQuoteComparison_provenance_status_key" ON "LabourQuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId", "status");

-- ── LabourPurchaseOrder (immutable root) ──────────────────────────────────────────────────────
CREATE TABLE "LabourPurchaseOrder" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "comparisonId" TEXT NOT NULL,
  "comparisonStatus" TEXT NOT NULL DEFAULT 'approved',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "LabourPurchaseOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourPurchaseOrder_comparison_status_check" CHECK ("comparisonStatus" = 'approved')
);
CREATE UNIQUE INDEX "LabourPurchaseOrder_projectId_id_key" ON "LabourPurchaseOrder"("projectId", "id");
CREATE UNIQUE INDEX "LabourPurchaseOrder_projectId_id_requisitionId_key" ON "LabourPurchaseOrder"("projectId", "id", "requisitionId");

-- ── LabourPurchaseOrderVersion ────────────────────────────────────────────────────────────────
CREATE TABLE "LabourPurchaseOrderVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "poId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "requisitionId" TEXT NOT NULL,
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
  CONSTRAINT "LabourPurchaseOrderVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourPurchaseOrderVersion_status_check" CHECK ("status" IN ('draft','issued','partially_committed','completed','amended','cancelled','closed_short')),
  CONSTRAINT "LabourPurchaseOrderVersion_issued_attribution_check" CHECK ("status" NOT IN ('issued','partially_committed','completed','amended','closed_short') OR ("issuedById" IS NOT NULL AND "issuedAt" IS NOT NULL)),
  CONSTRAINT "LabourPurchaseOrderVersion_cancel_reason_check" CHECK ("status" <> 'cancelled' OR "cancelReason" IS NOT NULL),
  CONSTRAINT "LabourPurchaseOrderVersion_close_short_reason_check" CHECK ("status" <> 'closed_short' OR "closeShortReason" IS NOT NULL),
  CONSTRAINT "LabourPurchaseOrderVersion_amend_reason_check" CHECK ("status" <> 'amended' OR "amendReason" IS NOT NULL),
  CONSTRAINT "LabourPurchaseOrderVersion_version_check" CHECK ("version" >= 1),
  CONSTRAINT "LabourPurchaseOrderVersion_supersedes_check" CHECK ("supersedesVersion" IS NULL OR "supersedesVersion" = "version" - 1)
);
CREATE UNIQUE INDEX "LabourPurchaseOrderVersion_poId_version_key" ON "LabourPurchaseOrderVersion"("poId", "version");
CREATE UNIQUE INDEX "LabourPurchaseOrderVersion_projectId_id_key" ON "LabourPurchaseOrderVersion"("projectId", "id");
CREATE UNIQUE INDEX "LabourPurchaseOrderVersion_projectId_id_requisitionId_key" ON "LabourPurchaseOrderVersion"("projectId", "id", "requisitionId");

-- ── LabourPurchaseOrderLine (FROZEN rate snapshot; committedQty is the ONE mutable column) ─────
CREATE TABLE "LabourPurchaseOrderLine" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "poVersionId" TEXT NOT NULL,
  "requisitionLineId" TEXT NOT NULL,
  "requisitionId" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "civilDate" DATE NOT NULL,
  "shift" TEXT NOT NULL,
  "labourSpecFingerprint" TEXT NOT NULL,
  "personShiftQty" INTEGER NOT NULL,
  "ratePerPersonShift" DECIMAL(18,2) NOT NULL,
  "shiftPremium" DECIMAL(18,2) NOT NULL,
  "committedAmountBase" DECIMAL(18,2) NOT NULL,
  "committedQty" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "LabourPurchaseOrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabourPurchaseOrderLine_qty_check" CHECK ("personShiftQty" > 0),
  CONSTRAINT "LabourPurchaseOrderLine_shift_check" CHECK ("shift" IN ('day','night')),
  CONSTRAINT "LabourPurchaseOrderLine_amounts_check" CHECK ("ratePerPersonShift" >= 0 AND "shiftPremium" >= 0 AND "committedAmountBase" >= 0),
  CONSTRAINT "LabourPurchaseOrderLine_committed_check" CHECK ("committedQty" >= 0),
  CONSTRAINT "LabourPurchaseOrderLine_committed_amount_check" CHECK ("committedAmountBase" = round(("ratePerPersonShift" + "shiftPremium") * "personShiftQty", 2))
);
CREATE UNIQUE INDEX "LabourPurchaseOrderLine_projectId_id_key" ON "LabourPurchaseOrderLine"("projectId", "id");
CREATE INDEX "LabourPurchaseOrderLine_projectId_requisitionLineId_idx" ON "LabourPurchaseOrderLine"("projectId", "requisitionLineId");

-- ── CapacityCommitment (inbound forecast capacity; one per PO line) ────────────────────────────
CREATE TABLE "CapacityCommitment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "poLineId" TEXT NOT NULL,
  "labourSpecFingerprint" TEXT NOT NULL,
  "civilDate" DATE NOT NULL,
  "shift" TEXT NOT NULL,
  "personShiftQty" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'committed',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  "defaultedAt" TIMESTAMP(3),
  CONSTRAINT "CapacityCommitment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CapacityCommitment_status_check" CHECK ("status" IN ('committed','revised','defaulted')),
  CONSTRAINT "CapacityCommitment_qty_check" CHECK ("personShiftQty" > 0),
  CONSTRAINT "CapacityCommitment_shift_check" CHECK ("shift" IN ('day','night'))
);
CREATE UNIQUE INDEX "CapacityCommitment_projectId_id_key" ON "CapacityCommitment"("projectId", "id");
-- one commitment per PO line
CREATE UNIQUE INDEX "CapacityCommitment_projectId_poLineId_key" ON "CapacityCommitment"("projectId", "poLineId");

-- ── CapacityPromise (APPEND-ONLY dated register) ──────────────────────────────────────────────
CREATE TABLE "CapacityPromise" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "commitmentId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "promisedDate" DATE NOT NULL,
  "reason" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" TEXT NOT NULL,
  CONSTRAINT "CapacityPromise_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CapacityPromise_seq_check" CHECK ("seq" >= 1),
  -- every REVISION explains itself; only the initial promise (seq 1) may omit the reason
  CONSTRAINT "CapacityPromise_revision_reason_check" CHECK ("seq" = 1 OR "reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "CapacityPromise_commitmentId_seq_key" ON "CapacityPromise"("commitmentId", "seq");
CREATE UNIQUE INDEX "CapacityPromise_projectId_id_key" ON "CapacityPromise"("projectId", "id");

-- ── Foreign keys ──────────────────────────────────────────────────────────────────────────────
-- Tenancy + attribution to the EXISTING owners (Project / User / Vendor / ProjectVendor /
-- LabourRequirementSpec). Same-project / same-org composite FKs make every cross-project or
-- cross-org reference unrepresentable.
ALTER TABLE "VendorLabourProfile" ADD CONSTRAINT "VendorLabourProfile_vendor_fkey" FOREIGN KEY ("orgId", "vendorId") REFERENCES "Vendor"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "VendorLabourProfile" ADD CONSTRAINT "VendorLabourProfile_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourRequisition" ADD CONSTRAINT "LabourRequisition_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabourRequisition" ADD CONSTRAINT "LabourRequisition_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourRequisitionLine" ADD CONSTRAINT "LabourRequisitionLine_requisition_fkey" FOREIGN KEY ("projectId", "requisitionId") REFERENCES "LabourRequisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRequisitionLine" ADD CONSTRAINT "LabourRequisitionLine_spec_fkey" FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "LabourRequirementSpec"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourRfq" ADD CONSTRAINT "LabourRfq_requisition_fkey" FOREIGN KEY ("projectId", "requisitionId") REFERENCES "LabourRequisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRfq" ADD CONSTRAINT "LabourRfq_issuedBy_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "SupplierLabourQuote" ADD CONSTRAINT "SupplierLabourQuote_rfq_fkey" FOREIGN KEY ("projectId", "rfqId") REFERENCES "LabourRfq"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuote" ADD CONSTRAINT "SupplierLabourQuote_binding_fkey" FOREIGN KEY ("projectId", "vendorId") REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuote" ADD CONSTRAINT "SupplierLabourQuote_containment_fkey" FOREIGN KEY ("projectId", "rfqId", "requisitionId") REFERENCES "LabourRfq"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuote" ADD CONSTRAINT "SupplierLabourQuote_recordedBy_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "SupplierLabourQuoteLine" ADD CONSTRAINT "SupplierLabourQuoteLine_quote_fkey" FOREIGN KEY ("projectId", "quoteId") REFERENCES "SupplierLabourQuote"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuoteLine" ADD CONSTRAINT "SupplierLabourQuoteLine_line_fkey" FOREIGN KEY ("projectId", "requisitionLineId") REFERENCES "LabourRequisitionLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuoteLine" ADD CONSTRAINT "SupplierLabourQuoteLine_quote_containment_fkey" FOREIGN KEY ("projectId", "quoteId", "requisitionId") REFERENCES "SupplierLabourQuote"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SupplierLabourQuoteLine" ADD CONSTRAINT "SupplierLabourQuoteLine_line_containment_fkey" FOREIGN KEY ("projectId", "requisitionId", "requisitionLineId") REFERENCES "LabourRequisitionLine"("projectId", "requisitionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourQuoteComparison" ADD CONSTRAINT "LabourQuoteComparison_rfq_fkey" FOREIGN KEY ("projectId", "rfqId") REFERENCES "LabourRfq"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourQuoteComparison" ADD CONSTRAINT "LabourQuoteComparison_containment_fkey" FOREIGN KEY ("projectId", "rfqId", "requisitionId") REFERENCES "LabourRfq"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourQuoteComparison" ADD CONSTRAINT "LabourQuoteComparison_selection_fkey" FOREIGN KEY ("projectId", "rfqId", "selectedVendorId", "selectedQuoteId") REFERENCES "SupplierLabourQuote"("projectId", "rfqId", "vendorId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourQuoteComparison" ADD CONSTRAINT "LabourQuoteComparison_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourPurchaseOrder" ADD CONSTRAINT "LabourPurchaseOrder_binding_fkey" FOREIGN KEY ("projectId", "vendorId") REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrder" ADD CONSTRAINT "LabourPurchaseOrder_requisition_fkey" FOREIGN KEY ("projectId", "requisitionId") REFERENCES "LabourRequisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrder" ADD CONSTRAINT "LabourPurchaseOrder_comparison_provenance_fkey" FOREIGN KEY ("projectId", "comparisonId", "vendorId", "requisitionId", "comparisonStatus") REFERENCES "LabourQuoteComparison"("projectId", "id", "selectedVendorId", "requisitionId", "status") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrder" ADD CONSTRAINT "LabourPurchaseOrder_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourPurchaseOrderVersion" ADD CONSTRAINT "LabourPurchaseOrderVersion_po_fkey" FOREIGN KEY ("projectId", "poId") REFERENCES "LabourPurchaseOrder"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderVersion" ADD CONSTRAINT "LabourPurchaseOrderVersion_root_containment_fkey" FOREIGN KEY ("projectId", "poId", "requisitionId") REFERENCES "LabourPurchaseOrder"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderVersion" ADD CONSTRAINT "LabourPurchaseOrderVersion_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_version_fkey" FOREIGN KEY ("projectId", "poVersionId") REFERENCES "LabourPurchaseOrderVersion"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_line_fkey" FOREIGN KEY ("projectId", "requisitionLineId") REFERENCES "LabourRequisitionLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_requirement_pin_fkey" FOREIGN KEY ("projectId", "requisitionLineId", "requirementId", "revision") REFERENCES "LabourRequisitionLine"("projectId", "id", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_version_containment_fkey" FOREIGN KEY ("projectId", "poVersionId", "requisitionId") REFERENCES "LabourPurchaseOrderVersion"("projectId", "id", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine" ADD CONSTRAINT "LabourPurchaseOrderLine_line_containment_fkey" FOREIGN KEY ("projectId", "requisitionId", "requisitionLineId") REFERENCES "LabourRequisitionLine"("projectId", "requisitionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "CapacityCommitment" ADD CONSTRAINT "CapacityCommitment_poLine_fkey" FOREIGN KEY ("projectId", "poLineId") REFERENCES "LabourPurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "CapacityCommitment" ADD CONSTRAINT "CapacityCommitment_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "CapacityPromise" ADD CONSTRAINT "CapacityPromise_commitment_fkey" FOREIGN KEY ("projectId", "commitmentId") REFERENCES "CapacityCommitment"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "CapacityPromise" ADD CONSTRAINT "CapacityPromise_recordedBy_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── Immutability / frozen-snapshot / append-only triggers ─────────────────────────────────────
-- Append-only (root PO, promise register, quote lines) reuse the generic phase3_immutable_row().
CREATE TRIGGER "LabourPurchaseOrder_append_only" BEFORE UPDATE OR DELETE ON "LabourPurchaseOrder" FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
CREATE TRIGGER "CapacityPromise_append_only" BEFORE UPDATE OR DELETE ON "CapacityPromise" FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
CREATE TRIGGER "SupplierLabourQuoteLine_append_only" BEFORE UPDATE OR DELETE ON "SupplierLabourQuoteLine" FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- A supplier labour quote is frozen except its lifecycle status (recorded → superseded|expired).
CREATE OR REPLACE FUNCTION phase4_lp_quote_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SupplierLabourQuote rows are never deleted (append-only commercial evidence, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."rfqId" <> OLD."rfqId"
     OR NEW."requisitionId" <> OLD."requisitionId" OR NEW."vendorId" <> OLD."vendorId"
     OR NEW."validUntil" <> OLD."validUntil" OR NEW."leadTimeDays" IS DISTINCT FROM OLD."leadTimeDays"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."recordedAt" <> OLD."recordedAt" OR NEW."recordedById" <> OLD."recordedById" THEN
    RAISE EXCEPTION 'SupplierLabourQuote is frozen except its lifecycle status (%)', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'recorded' AND NEW."status" IN ('superseded', 'expired')) THEN
    RAISE EXCEPTION 'SupplierLabourQuote status may only move recorded -> superseded|expired (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SupplierLabourQuote_lifecycle_only" BEFORE UPDATE OR DELETE ON "SupplierLabourQuote" FOR EACH ROW EXECUTE FUNCTION phase4_lp_quote_lifecycle_only();

-- An APPROVED comparison is fully sealed; a draft may only gain its approval columns.
CREATE OR REPLACE FUNCTION phase4_lp_comparison_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourQuoteComparison rows are never deleted (%)', OLD."id";
  END IF;
  IF OLD."status" = 'approved' THEN
    RAISE EXCEPTION 'An APPROVED labour comparison is sealed — no column may change (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."rfqId" <> OLD."rfqId"
     OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'LabourQuoteComparison identity is frozen — only the approval columns may be written (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourQuoteComparison_lifecycle_only" BEFORE UPDATE OR DELETE ON "LabourQuoteComparison" FOR EACH ROW EXECUTE FUNCTION phase4_lp_comparison_lifecycle_only();

-- A PO version's identity + lineage are frozen; only lifecycle columns change.
CREATE OR REPLACE FUNCTION phase4_lp_po_version_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourPurchaseOrderVersion rows are never deleted (versioned history, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poId" <> OLD."poId"
     OR NEW."requisitionId" <> OLD."requisitionId" OR NEW."version" <> OLD."version"
     OR NEW."supersedesVersion" IS DISTINCT FROM OLD."supersedesVersion"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'LabourPurchaseOrderVersion identity/lineage is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourPurchaseOrderVersion_lifecycle_only" BEFORE UPDATE OR DELETE ON "LabourPurchaseOrderVersion" FOR EACH ROW EXECUTE FUNCTION phase4_lp_po_version_lifecycle_only();

-- A PO line's commercial snapshot is FROZEN — only committedQty (progress) may change.
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
     OR NEW."committedAmountBase" <> OLD."committedAmountBase" THEN
    RAISE EXCEPTION 'LabourPurchaseOrderLine commercial snapshot is FROZEN — only committedQty may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourPurchaseOrderLine_frozen" BEFORE UPDATE OR DELETE ON "LabourPurchaseOrderLine" FOR EACH ROW EXECUTE FUNCTION phase4_lp_po_line_frozen();

-- A capacity commitment's identity + slice are frozen; only lifecycle columns change.
CREATE OR REPLACE FUNCTION phase4_lp_commitment_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CapacityCommitment rows are never deleted (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poLineId" <> OLD."poLineId"
     OR NEW."labourSpecFingerprint" <> OLD."labourSpecFingerprint" OR NEW."civilDate" <> OLD."civilDate"
     OR NEW."shift" <> OLD."shift" OR NEW."personShiftQty" <> OLD."personShiftQty"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'CapacityCommitment identity/slice is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CapacityCommitment_lifecycle_only" BEFORE UPDATE OR DELETE ON "CapacityCommitment" FOR EACH ROW EXECUTE FUNCTION phase4_lp_commitment_lifecycle_only();
