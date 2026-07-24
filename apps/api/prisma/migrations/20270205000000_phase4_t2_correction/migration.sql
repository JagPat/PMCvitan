-- Phase 4 Task 2 CORRECTION — labour commercial INTEGRITY (independent-review findings F1..F5).
--
-- Additive + diagnostic-first. Migration 20270201000000 is left BYTE-FOR-BYTE unchanged; this
-- forward migration only ADDS bounds/constraints/FKs/triggers and (F4) three provenance columns.
-- Every finding requires the DATABASE to enforce a physical-truth invariant the service already
-- means to hold:
--   F2  a LabourRequisitionLine's frozen identity (its (requirement,revision) fingerprint/shift +
--       civil-date slice) is DB-bound to the canonical Labour tables and immutable after insert.
--   F3  a CapacityCommitment's slice identity is DB-bound to its PO line (not merely copied).
--   F4  a LabourPurchaseOrderLine's rate/premium are provenance-bound to the comparison-selected
--       quote line (new columns + a composite-FK chain proving it).
--   F5  0 <= committedQty <= personShiftQty.
-- (F1 — the single transactional commitment+PO+version lifecycle so a committed slice is never
--  double-ordered — is a SERVICE correction; this migration only adds the F5 bound its accounting
--  relies on. No DB trigger drives version status: like material, the lifecycle lives in the service
--  under FOR UPDATE + the readiness lock.)
--
-- The labour pilot is ROW-FREE in production, so every backfill below is a no-op there; where a
-- table COULD hold rows we PROVE the invariant first and ABORT with a sampled diagnostic (operator
-- repair: docs/RUNBOOK.md §P4T2C) rather than inventing provenance or silently dropping a seal.

-- ── F5 — committedQty may never exceed the ordered personShiftQty ──────────────────────────────
DO $$
DECLARE n BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg("id", ', ') FILTER (WHERE true)
    INTO n, sample
  FROM (SELECT "id" FROM "LabourPurchaseOrderLine" WHERE "committedQty" > "personShiftQty" LIMIT 20) s;
  IF n > 0 THEN
    RAISE EXCEPTION 'F5 ABORT: % LabourPurchaseOrderLine row(s) have committedQty > personShiftQty (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
END $$;
ALTER TABLE "LabourPurchaseOrderLine"
  ADD CONSTRAINT "LabourPurchaseOrderLine_committed_le_person_check" CHECK ("committedQty" <= "personShiftQty");

-- ── F3 — a CapacityCommitment's slice identity is BOUND to its PO line ─────────────────────────
DO $$
DECLARE n BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg(c."id", ', ')
    INTO n, sample
  FROM (
    SELECT c."id"
    FROM "CapacityCommitment" c JOIN "LabourPurchaseOrderLine" l
      ON l."projectId" = c."projectId" AND l."id" = c."poLineId"
    WHERE c."labourSpecFingerprint" <> l."labourSpecFingerprint" OR c."civilDate" <> l."civilDate"
       OR c."shift" <> l."shift" OR c."personShiftQty" <> l."personShiftQty"
    LIMIT 20
  ) c;
  IF n > 0 THEN
    RAISE EXCEPTION 'F3 ABORT: % CapacityCommitment row(s) carry a slice identity that differs from their PO line (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
END $$;
-- the PO line's (projectId,id) is already unique; extend it with the copied slice columns so a
-- commitment can reference the WHOLE identity, not just the id.
CREATE UNIQUE INDEX "LabourPurchaseOrderLine_slice_identity_key"
  ON "LabourPurchaseOrderLine" ("projectId", "id", "labourSpecFingerprint", "civilDate", "shift", "personShiftQty");
ALTER TABLE "CapacityCommitment"
  ADD CONSTRAINT "CapacityCommitment_poLine_identity_fkey"
  FOREIGN KEY ("projectId", "poLineId", "labourSpecFingerprint", "civilDate", "shift", "personShiftQty")
  REFERENCES "LabourPurchaseOrderLine" ("projectId", "id", "labourSpecFingerprint", "civilDate", "shift", "personShiftQty")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F2 — a LabourRequisitionLine's identity is DB-bound + frozen ───────────────────────────────
-- (a) the fingerprint + shift must be the pinned spec's; the civil date must name a real slice.
DO $$
DECLARE n BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg(l."id", ', ')
    INTO n, sample
  FROM (
    SELECT l."id"
    FROM "LabourRequisitionLine" l
    LEFT JOIN "LabourRequirementSpec" s
      ON s."projectId" = l."projectId" AND s."requirementId" = l."requirementId" AND s."revision" = l."revision"
         AND s."labourSpecFingerprint" = l."labourSpecFingerprint" AND s."shift" = l."shift"
    WHERE s."id" IS NULL
    LIMIT 20
  ) l;
  IF n > 0 THEN
    RAISE EXCEPTION 'F2 ABORT: % LabourRequisitionLine row(s) carry a fingerprint/shift that is not the pinned spec''s (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
  SELECT count(*), string_agg(l."id", ', ')
    INTO n, sample
  FROM (
    SELECT l."id"
    FROM "LabourRequisitionLine" l
    LEFT JOIN "LabourDemandSlice" d
      ON d."projectId" = l."projectId" AND d."requirementId" = l."requirementId" AND d."revision" = l."revision" AND d."civilDate" = l."civilDate"
    WHERE d."id" IS NULL
    LIMIT 20
  ) l;
  IF n > 0 THEN
    RAISE EXCEPTION 'F2 ABORT: % LabourRequisitionLine row(s) name a civil date with no demand slice (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
END $$;
-- extend the spec's (projectId,requirementId,revision) unique key with fingerprint+shift so the
-- requisition line can FK the WHOLE frozen identity (the base key is already unique).
CREATE UNIQUE INDEX "LabourRequirementSpec_identity_key"
  ON "LabourRequirementSpec" ("projectId", "requirementId", "revision", "labourSpecFingerprint", "shift");
ALTER TABLE "LabourRequisitionLine"
  ADD CONSTRAINT "LabourRequisitionLine_spec_identity_fkey"
  FOREIGN KEY ("projectId", "requirementId", "revision", "labourSpecFingerprint", "shift")
  REFERENCES "LabourRequirementSpec" ("projectId", "requirementId", "revision", "labourSpecFingerprint", "shift")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourRequisitionLine"
  ADD CONSTRAINT "LabourRequisitionLine_slice_fkey"
  FOREIGN KEY ("projectId", "requirementId", "revision", "civilDate")
  REFERENCES "LabourDemandSlice" ("projectId", "requirementId", "revision", "civilDate")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
-- (b) freeze the identity after insert — only the lifecycle columns (status + cancel attribution)
-- may change (open -> ordered progress; open -> cancelled disposition).
CREATE OR REPLACE FUNCTION phase4_lp_requisition_line_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourRequisitionLine rows are never deleted (cancel the line instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."requisitionId" <> OLD."requisitionId"
     OR NEW."requirementId" <> OLD."requirementId" OR NEW."revision" <> OLD."revision"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."labourSpecFingerprint" <> OLD."labourSpecFingerprint" OR NEW."personShiftQty" <> OLD."personShiftQty" THEN
    RAISE EXCEPTION 'LabourRequisitionLine identity is FROZEN — only status/cancellation may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourRequisitionLine_frozen" BEFORE UPDATE OR DELETE ON "LabourRequisitionLine"
  FOR EACH ROW EXECUTE FUNCTION phase4_lp_requisition_line_frozen();
-- (c) a PO line's COPIED slice identity (civilDate/shift/fingerprint) is DB-bound to its requisition
-- line — a PO line can never quote a different slice than the requisition line it executes. The
-- ordered personShiftQty may be LESS than the line's (a partial/split order), so qty is NOT bound.
CREATE UNIQUE INDEX "LabourRequisitionLine_slice_identity_key"
  ON "LabourRequisitionLine" ("projectId", "id", "civilDate", "shift", "labourSpecFingerprint");
ALTER TABLE "LabourPurchaseOrderLine"
  ADD CONSTRAINT "LabourPurchaseOrderLine_reqline_slice_fkey"
  FOREIGN KEY ("projectId", "requisitionLineId", "civilDate", "shift", "labourSpecFingerprint")
  REFERENCES "LabourRequisitionLine" ("projectId", "id", "civilDate", "shift", "labourSpecFingerprint")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F4 — a PO line's rate/premium are provenance-bound to the comparison-selected quote line ───
-- new denormalised provenance columns (nullable first, backfilled from the chain, then NOT NULL).
ALTER TABLE "LabourPurchaseOrderVersion" ADD COLUMN "comparisonId" TEXT;
ALTER TABLE "LabourPurchaseOrderLine"    ADD COLUMN "comparisonId" TEXT;
ALTER TABLE "LabourPurchaseOrderLine"    ADD COLUMN "selectedQuoteId" TEXT;
ALTER TABLE "LabourPurchaseOrderLine"    ADD COLUMN "selectedQuoteLineId" TEXT;

-- backfill the version's comparisonId from its PO root (row-free in prod).
UPDATE "LabourPurchaseOrderVersion" v
  SET "comparisonId" = po."comparisonId"
  FROM "LabourPurchaseOrder" po
  WHERE po."projectId" = v."projectId" AND po."id" = v."poId";

-- backfill each PO line's comparisonId + selectedQuoteId (from its PO's approved comparison) and
-- selectedQuoteLineId (the selected quote's line for this requisition line whose rate/premium EQUAL
-- the frozen PO-line terms). A line that cannot be matched stays NULL and aborts the migration below.
UPDATE "LabourPurchaseOrderLine" l
  SET "comparisonId" = src."comparisonId",
      "selectedQuoteId" = src."selectedQuoteId",
      "selectedQuoteLineId" = src."selectedQuoteLineId"
  FROM (
    SELECT v."projectId", v."id" AS "poVersionId", cmp."id" AS "comparisonId",
           cmp."selectedQuoteId" AS "selectedQuoteId", ql."id" AS "selectedQuoteLineId",
           ql."requisitionLineId", ql."ratePerPersonShift", ql."shiftPremium"
    FROM "LabourPurchaseOrderVersion" v
    JOIN "LabourPurchaseOrder" po ON po."projectId" = v."projectId" AND po."id" = v."poId"
    JOIN "LabourQuoteComparison" cmp ON cmp."projectId" = po."projectId" AND cmp."id" = po."comparisonId"
    JOIN "SupplierLabourQuoteLine" ql ON ql."projectId" = cmp."projectId" AND ql."quoteId" = cmp."selectedQuoteId"
  ) src
  WHERE src."projectId" = l."projectId" AND src."poVersionId" = l."poVersionId"
    AND src."requisitionLineId" = l."requisitionLineId"
    AND src."ratePerPersonShift" = l."ratePerPersonShift" AND src."shiftPremium" = l."shiftPremium";

DO $$
DECLARE n BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg("id", ', ') INTO n, sample
  FROM (SELECT "id" FROM "LabourPurchaseOrderVersion" WHERE "comparisonId" IS NULL LIMIT 20) s;
  IF n > 0 THEN
    RAISE EXCEPTION 'F4 ABORT: % LabourPurchaseOrderVersion row(s) have no resolvable comparison (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
  SELECT count(*), string_agg("id", ', ') INTO n, sample
  FROM (SELECT "id" FROM "LabourPurchaseOrderLine" WHERE "comparisonId" IS NULL OR "selectedQuoteId" IS NULL OR "selectedQuoteLineId" IS NULL LIMIT 20) s;
  IF n > 0 THEN
    RAISE EXCEPTION 'F4 ABORT: % LabourPurchaseOrderLine row(s) have rate/premium not traceable to the comparison-selected quote line (sample: %) — see RUNBOOK §P4T2C', n, sample;
  END IF;
END $$;

ALTER TABLE "LabourPurchaseOrderVersion" ALTER COLUMN "comparisonId" SET NOT NULL;
ALTER TABLE "LabourPurchaseOrderLine"    ALTER COLUMN "comparisonId" SET NOT NULL;
ALTER TABLE "LabourPurchaseOrderLine"    ALTER COLUMN "selectedQuoteId" SET NOT NULL;
ALTER TABLE "LabourPurchaseOrderLine"    ALTER COLUMN "selectedQuoteLineId" SET NOT NULL;

-- supporting candidate keys for the provenance-chain FKs (each base (projectId,id) is unique).
CREATE UNIQUE INDEX "LabourPurchaseOrder_comparison_key"        ON "LabourPurchaseOrder" ("projectId", "id", "comparisonId");
CREATE UNIQUE INDEX "LabourPurchaseOrderVersion_comparison_key" ON "LabourPurchaseOrderVersion" ("projectId", "id", "comparisonId");
CREATE UNIQUE INDEX "LabourQuoteComparison_selection_line_key"  ON "LabourQuoteComparison" ("projectId", "id", "selectedQuoteId", "requisitionId");
CREATE UNIQUE INDEX "SupplierLabourQuoteLine_terms_key"         ON "SupplierLabourQuoteLine" ("projectId", "id", "quoteId", "requisitionLineId", "ratePerPersonShift", "shiftPremium");

-- the chain: poLine.comparisonId == version.comparisonId == PO.comparisonId (already provenance-
-- bound to the APPROVED comparison), poLine.selectedQuoteId == comparison.selectedQuoteId, and the
-- named quote line belongs to selectedQuoteId, quotes this requisition line, and its rate/premium
-- EQUAL the frozen PO-line terms.
ALTER TABLE "LabourPurchaseOrderVersion"
  ADD CONSTRAINT "LabourPurchaseOrderVersion_comparison_fkey"
  FOREIGN KEY ("projectId", "poId", "comparisonId")
  REFERENCES "LabourPurchaseOrder" ("projectId", "id", "comparisonId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine"
  ADD CONSTRAINT "LabourPurchaseOrderLine_version_comparison_fkey"
  FOREIGN KEY ("projectId", "poVersionId", "comparisonId")
  REFERENCES "LabourPurchaseOrderVersion" ("projectId", "id", "comparisonId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine"
  ADD CONSTRAINT "LabourPurchaseOrderLine_comparison_selection_fkey"
  FOREIGN KEY ("projectId", "comparisonId", "selectedQuoteId", "requisitionId")
  REFERENCES "LabourQuoteComparison" ("projectId", "id", "selectedQuoteId", "requisitionId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "LabourPurchaseOrderLine"
  ADD CONSTRAINT "LabourPurchaseOrderLine_quote_provenance_fkey"
  FOREIGN KEY ("projectId", "selectedQuoteLineId", "selectedQuoteId", "requisitionLineId", "ratePerPersonShift", "shiftPremium")
  REFERENCES "SupplierLabourQuoteLine" ("projectId", "id", "quoteId", "requisitionLineId", "ratePerPersonShift", "shiftPremium") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- re-freeze the PO version + PO line so the new provenance columns are immutable too (only the
-- committedQty progress column stays mutable on a PO line; only lifecycle columns on a version).
CREATE OR REPLACE FUNCTION phase4_lp_po_version_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourPurchaseOrderVersion rows are never deleted (versioned history, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poId" <> OLD."poId"
     OR NEW."requisitionId" <> OLD."requisitionId" OR NEW."version" <> OLD."version"
     OR NEW."comparisonId" <> OLD."comparisonId"
     OR NEW."supersedesVersion" IS DISTINCT FROM OLD."supersedesVersion"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'LabourPurchaseOrderVersion identity/lineage is frozen — only lifecycle columns may change (%)', OLD."id";
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
     OR NEW."selectedQuoteLineId" <> OLD."selectedQuoteLineId" THEN
    RAISE EXCEPTION 'LabourPurchaseOrderLine commercial snapshot is FROZEN — only committedQty may change (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── F1 (documentation) — the PO-version status transition truth table the SERVICE now enforces ──
-- committedQty(line)  := the line's LIVE (committed|revised) CapacityCommitment personShiftQty, else 0.
-- recompute(version)  (only for issued|partially_committed|completed):
--     Σcommitted = 0                     -> issued
--     0 < Σcommitted < Σordered          -> partially_committed
--     Σcommitted = Σordered              -> completed
--   commit(line)   sets committedQty := commitment qty, then recompute(version).
--   default(line)  sets committedQty := 0,               then recompute(version) (terminal versions untouched).
--   closeShort     issued|partially_committed -> closed_short (committed lines KEEP committedQty; the
--                  uncommitted remainder is released — a completed version is refused: nothing is short).
--   amend/cancel   REFUSED while any line carries a live commitment (a live commitment is never orphaned).
-- §F bound-2 allocation counts a line's full personShiftQty on issued|partially_committed|completed,
-- and only committedQty on closed_short — so a committed slice is never re-ordered by a second PO.
