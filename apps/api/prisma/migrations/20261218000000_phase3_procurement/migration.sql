-- Phase 3 Task 2 — the procurement module (plan §§F/G/H). PURELY ADDITIVE: new tables only;
-- no existing table, column or row is touched. Tenancy is database-enforced end to end:
-- Vendor is org-scoped (§H — the one exception to the projectId rule), project reach is the
-- ProjectVendor binding whose composite FKs pin the SAME org to the vendor AND the project,
-- and every procurement row references the vendor THROUGH that binding — a cross-org or
-- cross-project reference is unrepresentable. Status vocabularies are CHECK-backed, and the
-- comparison approval invariant (an approved comparison names its selection + reason) is a
-- database CHECK, not a convention.

-- §H — the org-scoped vendor party record
CREATE TABLE "Vendor" (
    "id"          TEXT NOT NULL,
    "orgId"       TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "contact"     TEXT,
    "gstin"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Vendor_orgId_id_key" ON "Vendor"("orgId", "id");
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §H — the explicit project binding; ONE orgId column feeds BOTH composite FKs
CREATE TABLE "ProjectVendor" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orgId"     TEXT NOT NULL,
    "vendorId"  TEXT NOT NULL,
    "boundAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundById" TEXT NOT NULL,
    CONSTRAINT "ProjectVendor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectVendor_projectId_vendorId_key" ON "ProjectVendor"("projectId", "vendorId");
CREATE UNIQUE INDEX "ProjectVendor_projectId_id_key" ON "ProjectVendor"("projectId", "id");
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_vendorId_fkey"
  FOREIGN KEY ("orgId", "vendorId") REFERENCES "Vendor"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_boundById_fkey"
  FOREIGN KEY ("boundById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F — requisitions (CAS machine: draft → submitted → approved | rejected; approved → closed)
CREATE TABLE "Requisition" (
    "id"             TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "title"          TEXT NOT NULL,
    "notes"          TEXT,
    "status"         TEXT NOT NULL DEFAULT 'draft',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById"    TEXT NOT NULL,
    "submittedById"  TEXT,
    "submittedAt"    TIMESTAMP(3),
    "approvedById"   TEXT,
    "approvedAt"     TIMESTAMP(3),
    "rejectedReason" TEXT,
    "closedAt"       TIMESTAMP(3),
    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Requisition_status_check" CHECK ("status" IN ('draft','submitted','approved','rejected','closed'))
);
CREATE UNIQUE INDEX "Requisition_projectId_id_key" ON "Requisition"("projectId", "id");
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F bound 1 — allocations pin the Task-1 composite revision triple; qty is positive base-UOM
CREATE TABLE "RequisitionLine" (
    "id"            TEXT NOT NULL,
    "projectId"     TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision"      INTEGER NOT NULL,
    "qty"           DECIMAL(18,6) NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'open',
    "cancelledAt"   TIMESTAMP(3),
    "cancelledById" TEXT,
    CONSTRAINT "RequisitionLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RequisitionLine_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "RequisitionLine_status_check" CHECK ("status" IN ('open','cancelled'))
);
CREATE UNIQUE INDEX "RequisitionLine_projectId_id_key" ON "RequisitionLine"("projectId", "id");
CREATE INDEX "RequisitionLine_projectId_requirementId_revision_idx" ON "RequisitionLine"("projectId", "requirementId", "revision");
ALTER TABLE "RequisitionLine" ADD CONSTRAINT "RequisitionLine_projectId_requisitionId_fkey"
  FOREIGN KEY ("projectId", "requisitionId") REFERENCES "Requisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RequisitionLine" ADD CONSTRAINT "RequisitionLine_projectId_requirementId_revision_fkey"
  FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F — RFQs (issued → closed)
CREATE TABLE "Rfq" (
    "id"            TEXT NOT NULL,
    "projectId"     TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'issued',
    "issuedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById"    TEXT NOT NULL,
    "closedAt"      TIMESTAMP(3),
    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Rfq_status_check" CHECK ("status" IN ('issued','closed'))
);
CREATE UNIQUE INDEX "Rfq_projectId_id_key" ON "Rfq"("projectId", "id");
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_projectId_requisitionId_fkey"
  FOREIGN KEY ("projectId", "requisitionId") REFERENCES "Requisition"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F/§H — quotes reach the vendor ONLY through the ProjectVendor binding
CREATE TABLE "VendorQuote" (
    "id"              TEXT NOT NULL,
    "projectId"       TEXT NOT NULL,
    "rfqId"           TEXT NOT NULL,
    "vendorId"        TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'recorded',
    "validUntil"      DATE NOT NULL,
    "leadTimeDays"    INTEGER,
    "paymentTerms"    TEXT,
    "warrantyTerms"   TEXT,
    "historicalScore" DECIMAL(5,2),
    "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById"    TEXT NOT NULL,
    CONSTRAINT "VendorQuote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VendorQuote_status_check" CHECK ("status" IN ('recorded','superseded','expired'))
);
CREATE UNIQUE INDEX "VendorQuote_projectId_id_key" ON "VendorQuote"("projectId", "id");
CREATE INDEX "VendorQuote_projectId_rfqId_vendorId_idx" ON "VendorQuote"("projectId", "rfqId", "vendorId");
ALTER TABLE "VendorQuote" ADD CONSTRAINT "VendorQuote_projectId_rfqId_fkey"
  FOREIGN KEY ("projectId", "rfqId") REFERENCES "Rfq"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "VendorQuote" ADD CONSTRAINT "VendorQuote_projectId_vendorId_fkey"
  FOREIGN KEY ("projectId", "vendorId") REFERENCES "ProjectVendor"("projectId", "vendorId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "VendorQuote" ADD CONSTRAINT "VendorQuote_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F — quote normalization per requisition line (money DECIMAL, base currency INR)
CREATE TABLE "VendorQuoteLine" (
    "id"                   TEXT NOT NULL,
    "projectId"            TEXT NOT NULL,
    "quoteId"              TEXT NOT NULL,
    "requisitionLineId"    TEXT NOT NULL,
    "baseRate"             DECIMAL(18,2) NOT NULL,
    "taxAmount"            DECIMAL(18,2) NOT NULL,
    "freightAmount"        DECIMAL(18,2) NOT NULL,
    "landedCost"           DECIMAL(18,2) NOT NULL,
    "quotedMake"           TEXT NOT NULL,
    "matchesSpecification" BOOLEAN NOT NULL,
    "sampleCompliant"      BOOLEAN,
    "vendorStockQty"       DECIMAL(18,6),
    "deliveryPromise"      DATE,
    CONSTRAINT "VendorQuoteLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VendorQuoteLine_amounts_check" CHECK (
      "baseRate" >= 0 AND "taxAmount" >= 0 AND "freightAmount" >= 0 AND "landedCost" >= 0
    )
);
CREATE UNIQUE INDEX "VendorQuoteLine_quoteId_requisitionLineId_key" ON "VendorQuoteLine"("quoteId", "requisitionLineId");
CREATE UNIQUE INDEX "VendorQuoteLine_projectId_id_key" ON "VendorQuoteLine"("projectId", "id");
ALTER TABLE "VendorQuoteLine" ADD CONSTRAINT "VendorQuoteLine_projectId_quoteId_fkey"
  FOREIGN KEY ("projectId", "quoteId") REFERENCES "VendorQuote"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "VendorQuoteLine" ADD CONSTRAINT "VendorQuoteLine_projectId_requisitionLineId_fkey"
  FOREIGN KEY ("projectId", "requisitionLineId") REFERENCES "RequisitionLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §F — the comparison decision (draft → approved; authority + reason are DB-required at approval)
CREATE TABLE "QuoteComparison" (
    "id"               TEXT NOT NULL,
    "projectId"        TEXT NOT NULL,
    "rfqId"            TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'draft',
    "selectedQuoteId"  TEXT,
    "selectedVendorId" TEXT,
    "reason"           TEXT,
    "justification"    TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById"      TEXT NOT NULL,
    "approvedById"     TEXT,
    "approvedAt"       TIMESTAMP(3),
    CONSTRAINT "QuoteComparison_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuoteComparison_status_check" CHECK ("status" IN ('draft','approved')),
    -- an APPROVED comparison always names its selection, its authority and its reason
    CONSTRAINT "QuoteComparison_approval_check" CHECK (
      "status" <> 'approved' OR (
        "selectedQuoteId" IS NOT NULL AND "selectedVendorId" IS NOT NULL AND
        "reason" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
      )
    )
);
CREATE UNIQUE INDEX "QuoteComparison_projectId_rfqId_key" ON "QuoteComparison"("projectId", "rfqId");
CREATE UNIQUE INDEX "QuoteComparison_projectId_id_key" ON "QuoteComparison"("projectId", "id");
ALTER TABLE "QuoteComparison" ADD CONSTRAINT "QuoteComparison_projectId_rfqId_fkey"
  FOREIGN KEY ("projectId", "rfqId") REFERENCES "Rfq"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "QuoteComparison" ADD CONSTRAINT "QuoteComparison_projectId_selectedQuoteId_fkey"
  FOREIGN KEY ("projectId", "selectedQuoteId") REFERENCES "VendorQuote"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "QuoteComparison" ADD CONSTRAINT "QuoteComparison_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
