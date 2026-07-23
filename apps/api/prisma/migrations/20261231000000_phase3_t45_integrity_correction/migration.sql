-- Phase 3 Tasks 4–5 integrity correction (base main @ b0edc5a) — forward-only, diagnostic-first.
--
-- Makes PostgreSQL enforce the SAME physical-truth invariants InventoryService and
-- DailyLogService already enforce in application code. Because these records are immutable and
-- feed future readiness calculations, application checks alone are insufficient — a forged raw
-- insert, a mis-ordered write, or a concurrent update could otherwise persist an incoherent
-- fact. Four findings:
--   F1  command provenance     — every §C ledger row cites a same-project CommandExecution.
--   F2  receipt provenance     — a lot's PO-line/commitment/requirement form ONE valid chain,
--                                its frozen §B spec copy matches the pinned spec + base UOM,
--                                and each receipt row's provenance matches its lot.
--   F3  issue provenance       — exactly one canonical `issue` movement per MaterialIssue, every
--                                MaterialIssue has it at commit, and every issue-scoped row
--                                matches its MaterialIssue lot/location/activity (+ issue qty).
--   F4  mismatch resolution    — a resolution requires a matched=false observation (serialized),
--                                and a resolved observation can never revert to matched=true.
--
-- Additive over a clean/pilot database. If legacy rows already violate an invariant the
-- migration ABORTS with an explicit per-finding diagnostic (it NEVER invents provenance);
-- operator repair is documented in docs/RUNBOOK.md §T45.

-- ============================================================================
-- 0. DIAGNOSTICS — report and ABORT on any pre-existing violation before adding constraints.
-- ============================================================================
DO $$
DECLARE
  n_null_src         bigint;
  n_foreign_src      bigint;
  n_chain            bigint;
  n_spec             bigint;
  n_receipt          bigint;
  n_orphan_issue     bigint;
  n_misscoped        bigint;
  n_matched_resolved bigint;
  problems text := '';
BEGIN
  -- F1 — stock rows with no source command, or one in another project.
  SELECT count(*) INTO n_null_src FROM "StockTransaction" WHERE "sourceCommandId" IS NULL;
  SELECT count(*) INTO n_foreign_src FROM "StockTransaction" st
    WHERE st."sourceCommandId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "CommandExecution" ce
        WHERE ce."id" = st."sourceCommandId" AND ce."projectId" = st."projectId");

  -- F2.1 — a lot whose commitment is not on its PO line, or whose PO line's frozen requirement
  -- pin does not match the lot's own (requirementId, revision).
  SELECT count(*) INTO n_chain FROM "StockLot" sl
    WHERE NOT EXISTS (
            SELECT 1 FROM "DeliveryCommitment" dc
            WHERE dc."projectId" = sl."projectId" AND dc."id" = sl."commitmentId"
              AND dc."poLineId" = sl."poLineId")
       OR NOT EXISTS (
            SELECT 1 FROM "PurchaseOrderLine" pol
            WHERE pol."projectId" = sl."projectId" AND pol."id" = sl."poLineId"
              AND pol."requirementId" = sl."requirementId" AND pol."revision" = sl."revision");

  -- F2.2 — a lot whose copied §B fields differ from the pinned MaterialRequirementSpec, or whose
  -- baseUom differs from the requirement revision's single-source UOM, or that has no spec at all.
  SELECT count(*) INTO n_spec FROM "StockLot" sl
    LEFT JOIN "MaterialRequirementSpec" ms
      ON ms."projectId" = sl."projectId" AND ms."requirementId" = sl."requirementId" AND ms."revision" = sl."revision"
    LEFT JOIN "ActivityRequirement" ar
      ON ar."projectId" = sl."projectId" AND ar."requirementId" = sl."requirementId" AND ar."revision" = sl."revision"
    WHERE ms."requirementId" IS NULL OR ar."requirementId" IS NULL
       OR sl."materialCategory"     <> ms."materialCategory"
       OR sl."make"                 <> ms."make"
       OR sl."grade"                <> ms."grade"
       OR sl."normalizedAttributes" <> ms."normalizedAttributes"
       OR sl."specFingerprint"      <> ms."specFingerprint"
       OR sl."baseUom"              <> ar."baseUom"
       OR sl."decisionId"      IS DISTINCT FROM ms."decisionId"
       OR sl."decisionVersion" IS DISTINCT FROM ms."decisionVersion"
       OR sl."optionKey"       IS DISTINCT FROM ms."optionKey";

  -- F2.3 — a receipt row whose PO line / commitment differ from its lot's.
  SELECT count(*) INTO n_receipt FROM "StockTransaction" st
    JOIN "StockLot" sl ON sl."projectId" = st."projectId" AND sl."id" = st."lotId"
    WHERE st."type" = 'receipt'
      AND (st."poLineId" IS DISTINCT FROM sl."poLineId" OR st."commitmentId" IS DISTINCT FROM sl."commitmentId");

  -- F3.2 — a MaterialIssue with no canonical `issue` movement.
  SELECT count(*) INTO n_orphan_issue FROM "MaterialIssue" mi
    WHERE NOT EXISTS (
      SELECT 1 FROM "StockTransaction" st
      WHERE st."projectId" = mi."projectId" AND st."issueId" = mi."id" AND st."type" = 'issue');

  -- F3.3 — an issue-scoped row whose lot/location/activity (or, for the issue movement, quantity)
  -- disagrees with its MaterialIssue.
  SELECT count(*) INTO n_misscoped FROM "StockTransaction" st
    JOIN "MaterialIssue" mi ON mi."projectId" = st."projectId" AND mi."id" = st."issueId"
    WHERE st."issueId" IS NOT NULL
      AND (st."lotId" <> mi."lotId"
           OR st."storeLocation" <> mi."storeLocation"
           OR st."activityId" IS DISTINCT FROM mi."activityId"
           OR (st."type" = 'issue' AND st."qty" <> mi."qty"));

  -- F4 — a resolution attached to a matched=true observation.
  SELECT count(*) INTO n_matched_resolved FROM "MismatchResolution" mr
    JOIN "SiteMaterial" sm ON sm."projectId" = mr."projectId" AND sm."id" = mr."siteMaterialId"
    WHERE sm."matched" = TRUE;

  IF n_null_src > 0         THEN problems := problems || format(E'  F1: %s stock rows with a NULL sourceCommandId\n', n_null_src); END IF;
  IF n_foreign_src > 0      THEN problems := problems || format(E'  F1: %s stock rows whose sourceCommandId is in another project\n', n_foreign_src); END IF;
  IF n_chain > 0            THEN problems := problems || format(E'  F2.1: %s stock lots with a broken PO-line/commitment/requirement chain\n', n_chain); END IF;
  IF n_spec > 0             THEN problems := problems || format(E'  F2.2: %s stock lots whose frozen §B spec copy/base UOM does not match the pinned requirement revision\n', n_spec); END IF;
  IF n_receipt > 0          THEN problems := problems || format(E'  F2.3: %s receipt rows whose PO-line/commitment differs from their lot\n', n_receipt); END IF;
  IF n_orphan_issue > 0     THEN problems := problems || format(E'  F3.2: %s MaterialIssue rows with no canonical issue movement\n', n_orphan_issue); END IF;
  IF n_misscoped > 0        THEN problems := problems || format(E'  F3.3: %s issue-scoped rows mis-scoped against their MaterialIssue\n', n_misscoped); END IF;
  IF n_matched_resolved > 0 THEN problems := problems || format(E'  F4: %s resolutions attached to a matched=true observation\n', n_matched_resolved); END IF;

  IF problems <> '' THEN
    RAISE EXCEPTION E'Phase 3 Tasks 4–5 integrity correction ABORTED — legacy rows violate physical-truth invariants.\nRepair per docs/RUNBOOK.md §T45 before re-running (this migration never invents provenance):\n%', problems;
  END IF;
END $$;

-- ============================================================================
-- F1 — command provenance: every §C ledger row cites a SAME-PROJECT CommandExecution.
-- The project-contained composite FK makes a cross-project source command unrepresentable; the
-- NOT NULL makes a source-less row unrepresentable (a server one-shot command backs even an
-- unkeyed call — see platform/commands.ts `synthesizeKeyWhenAbsent`).
-- ============================================================================
CREATE UNIQUE INDEX "CommandExecution_projectId_id_key" ON "CommandExecution"("projectId", "id");

ALTER TABLE "StockTransaction" DROP CONSTRAINT IF EXISTS "StockTransaction_sourceCommandId_fkey";
ALTER TABLE "StockTransaction" ALTER COLUMN "sourceCommandId" SET NOT NULL;
ALTER TABLE "StockTransaction"
  ADD CONSTRAINT "StockTransaction_projectId_sourceCommandId_fkey"
  FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- F2.1 — receipt/lot procurement chain: bind the lot's commitment to its PO line, and the PO
-- line's frozen requirement pin to the lot's, via composite candidate keys + FKs (replacing the
-- three independent id-only FKs that let an incoherent chain persist).
-- ============================================================================
CREATE UNIQUE INDEX "DeliveryCommitment_projectId_id_poLineId_key"
  ON "DeliveryCommitment"("projectId", "id", "poLineId");
CREATE UNIQUE INDEX "PurchaseOrderLine_projectId_id_requirementId_revision_key"
  ON "PurchaseOrderLine"("projectId", "id", "requirementId", "revision");

ALTER TABLE "StockLot" DROP CONSTRAINT IF EXISTS "StockLot_projectId_commitmentId_fkey";
ALTER TABLE "StockLot" DROP CONSTRAINT IF EXISTS "StockLot_projectId_poLineId_fkey";
ALTER TABLE "StockLot"
  ADD CONSTRAINT "StockLot_projectId_commitmentId_poLineId_fkey"
  FOREIGN KEY ("projectId", "commitmentId", "poLineId")
  REFERENCES "DeliveryCommitment"("projectId", "id", "poLineId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockLot"
  ADD CONSTRAINT "StockLot_projectId_poLineId_requirementId_revision_fkey"
  FOREIGN KEY ("projectId", "poLineId", "requirementId", "revision")
  REFERENCES "PurchaseOrderLine"("projectId", "id", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- F2.3 — each receipt row is bound to the SAME lot/PO-line/commitment tuple as its StockLot.
-- Nullable provenance (only receipt rows carry poLineId + commitmentId) makes MATCH SIMPLE skip
-- non-receipt rows automatically; a receipt row must match a real lot tuple.
-- ============================================================================
CREATE UNIQUE INDEX "StockLot_projectId_id_poLineId_commitmentId_key"
  ON "StockLot"("projectId", "id", "poLineId", "commitmentId");
ALTER TABLE "StockTransaction"
  ADD CONSTRAINT "StockTransaction_receipt_lot_provenance_fkey"
  FOREIGN KEY ("projectId", "lotId", "poLineId", "commitmentId")
  REFERENCES "StockLot"("projectId", "id", "poLineId", "commitmentId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- F2.2 — the lot's frozen §B MaterialSpecificationRef copy must EXACTLY match the pinned
-- MaterialRequirementSpec (technical identity + decision provenance) and the requirement
-- revision's single-source base UOM. A focused BEFORE INSERT trigger: the nullable decision
-- provenance (all-null manual spec) makes a full composite FK impractical.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_stocklot_spec_fidelity() RETURNS trigger AS $$
DECLARE
  ms     "MaterialRequirementSpec"%ROWTYPE;
  ar_uom text;
BEGIN
  SELECT * INTO ms FROM "MaterialRequirementSpec"
    WHERE "projectId" = NEW."projectId" AND "requirementId" = NEW."requirementId" AND "revision" = NEW."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock lot references a requirement revision with no material spec (requirement %/%)', NEW."requirementId", NEW."revision";
  END IF;
  SELECT "baseUom" INTO ar_uom FROM "ActivityRequirement"
    WHERE "projectId" = NEW."projectId" AND "requirementId" = NEW."requirementId" AND "revision" = NEW."revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock lot references a non-existent requirement revision (requirement %/%)', NEW."requirementId", NEW."revision";
  END IF;
  IF NEW."materialCategory"     <> ms."materialCategory"
     OR NEW."make"                 <> ms."make"
     OR NEW."grade"                <> ms."grade"
     OR NEW."normalizedAttributes" <> ms."normalizedAttributes"
     OR NEW."specFingerprint"      <> ms."specFingerprint"
     OR NEW."baseUom"              <> ar_uom
     OR NEW."decisionId"      IS DISTINCT FROM ms."decisionId"
     OR NEW."decisionVersion" IS DISTINCT FROM ms."decisionVersion"
     OR NEW."optionKey"       IS DISTINCT FROM ms."optionKey" THEN
    RAISE EXCEPTION 'stock lot §B spec copy does not match the pinned requirement revision (spec/UOM tampering)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockLot_spec_fidelity"
  BEFORE INSERT ON "StockLot"
  FOR EACH ROW EXECUTE FUNCTION phase3_stocklot_spec_fidelity();

-- ============================================================================
-- F3 — issue canonicity.
--   F3.1  at most one type='issue' movement per MaterialIssue (partial unique).
--   F3.2  every MaterialIssue HAS that canonical movement at COMMIT (deferred constraint
--         trigger — orders within the issue command don't matter; an orphan is caught at commit).
--   F3.3  every issue-scoped row (the issue movement + consumption/site-return/wastage + their
--         reversals) matches its MaterialIssue's lot/location/activity; the canonical issue
--         movement's quantity must equal the MaterialIssue quantity. Partial consumption /
--         return / wastage keep their own (smaller) quantities — only the `issue` row is pinned.
-- ============================================================================
CREATE UNIQUE INDEX "StockTransaction_one_issue_movement_per_issue_key"
  ON "StockTransaction"("projectId", "issueId") WHERE "type" = 'issue';

CREATE OR REPLACE FUNCTION phase3_issue_scope_match() RETURNS trigger AS $$
DECLARE mi "MaterialIssue"%ROWTYPE;
BEGIN
  IF NEW."issueId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO mi FROM "MaterialIssue"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."issueId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue-scoped stock transaction references no MaterialIssue in this project';
  END IF;
  IF NEW."lotId" <> mi."lotId"
     OR NEW."storeLocation" <> mi."storeLocation"
     OR NEW."activityId" IS DISTINCT FROM mi."activityId" THEN
    RAISE EXCEPTION 'an issue-scoped transaction must match its MaterialIssue lot/location/activity';
  END IF;
  IF NEW."type" = 'issue' AND NEW."qty" <> mi."qty" THEN
    RAISE EXCEPTION 'the canonical issue movement quantity must equal the MaterialIssue quantity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockTransaction_issue_scope"
  BEFORE INSERT ON "StockTransaction"
  FOR EACH ROW EXECUTE FUNCTION phase3_issue_scope_match();

CREATE OR REPLACE FUNCTION phase3_issue_has_movement() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "StockTransaction"
    WHERE "projectId" = NEW."projectId" AND "issueId" = NEW."id" AND "type" = 'issue';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MaterialIssue % has no canonical issue movement at commit (§E orphan)', NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "MaterialIssue_requires_movement"
  AFTER INSERT ON "MaterialIssue"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase3_issue_has_movement();

-- ============================================================================
-- F4 — mismatch resolution.
--   F4.1  a resolution may be inserted ONLY while its observation is matched=false; the row is
--         SELECT … FOR UPDATE-locked, so a concurrent matched change serializes behind it.
--   F4.2  a resolved observation can never revert to matched=true (the resolution disposed of a
--         real dispute; re-matching would erase attributable history).
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_resolution_requires_mismatch() RETURNS trigger AS $$
DECLARE is_matched boolean;
BEGIN
  SELECT "matched" INTO is_matched FROM "SiteMaterial"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."siteMaterialId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mismatch resolution references no site material in this project';
  END IF;
  IF is_matched THEN
    RAISE EXCEPTION 'a mismatch resolution requires a matched=false observation (nothing to resolve)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MismatchResolution_requires_mismatch"
  BEFORE INSERT ON "MismatchResolution"
  FOR EACH ROW EXECUTE FUNCTION phase3_resolution_requires_mismatch();

CREATE OR REPLACE FUNCTION phase3_resolved_stays_mismatched() RETURNS trigger AS $$
BEGIN
  IF NEW."matched" = TRUE AND OLD."matched" = FALSE THEN
    PERFORM 1 FROM "MismatchResolution"
      WHERE "projectId" = NEW."projectId" AND "siteMaterialId" = NEW."id";
    IF FOUND THEN
      RAISE EXCEPTION 'a resolved mismatch observation cannot revert to matched=true';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SiteMaterial_resolved_stays_mismatched"
  BEFORE UPDATE ON "SiteMaterial"
  FOR EACH ROW EXECUTE FUNCTION phase3_resolved_stays_mismatched();
