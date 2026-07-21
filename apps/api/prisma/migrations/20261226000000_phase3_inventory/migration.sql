-- ============================================================================
-- Phase 3 Task 4 — the inventory module: StockLot + the append-only §C stock ledger.
--
-- FORWARD-ONLY and PURELY ADDITIVE: two NEW tables, their FKs, CHECKs and triggers.
-- No existing table, column, constraint or row is touched, so there is no backfill and
-- no diagnostic phase — a pre-Task-4 database upgrades with zero data movement.
--
-- Design (plan §C):
--   • The lot is ONE immutable received batch carrying its full §B MaterialSpecificationRef
--     (technical identity + decision provenance) and the receipt provenance (PO line +
--     delivery commitment + the PO line's frozen requirement pin, FK-sealed).
--   • Physical truth lives ONLY in the ledger: every row moves qty (base UOM, > 0) from
--     `fromBucket` to `toBucket` (NULL = outside the store), so buckets derive by ONE
--     generic fold per stock key (projectId, storeLocation, stockLotId). NO current-quantity
--     column exists anywhere.
--   • Database CHECKs pin the per-type movement (§C equations) — a receipt row that fills
--     anything but quarantine is UNREPRESENTABLE, an acceptance without quality result +
--     evidence is unrepresentable, an unreasoned adjustment is unrepresentable.
--   • BEFORE UPDATE OR DELETE triggers make both tables append-only (§C rule iii);
--     TRUNCATE (sanctioned test/seed resets) fires no row triggers.
--   • A BEFORE INSERT trigger proves every `reversal` row is the EXACT inverse of the row
--     it references (same lot + location + qty, buckets swapped, reversed row not itself a
--     reversal), and the partial unique index lets each row be reversed AT MOST once.
-- ============================================================================

-- CreateTable
CREATE TABLE "StockLot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "materialCategory" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "normalizedAttributes" TEXT NOT NULL,
    "baseUom" TEXT NOT NULL,
    "specFingerprint" TEXT NOT NULL,
    "decisionId" TEXT,
    "decisionVersion" INTEGER,
    "optionKey" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT NOT NULL,

    CONSTRAINT "StockLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "storeLocation" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "qty" DECIMAL(18,6) NOT NULL,
    "fromBucket" TEXT,
    "toBucket" TEXT,
    "poLineId" TEXT,
    "commitmentId" TEXT,
    "reversedTxId" TEXT,
    "qualityResult" TEXT,
    "evidenceMediaId" TEXT,
    "reason" TEXT,
    "sourceCommandId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,

    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockLot_projectId_specFingerprint_idx" ON "StockLot"("projectId", "specFingerprint");
CREATE INDEX "StockLot_projectId_poLineId_idx" ON "StockLot"("projectId", "poLineId");
CREATE UNIQUE INDEX "StockLot_projectId_id_key" ON "StockLot"("projectId", "id");
CREATE INDEX "StockTransaction_projectId_lotId_storeLocation_idx" ON "StockTransaction"("projectId", "lotId", "storeLocation");
CREATE INDEX "StockTransaction_projectId_poLineId_idx" ON "StockTransaction"("projectId", "poLineId");
CREATE UNIQUE INDEX "StockTransaction_projectId_id_key" ON "StockTransaction"("projectId", "id");

-- §C rule iii backstop: each ledger row is reversible AT MOST once (partial unique — the
-- column is NULL on every non-reversal row).
CREATE UNIQUE INDEX "StockTransaction_reversedTx_once_key"
  ON "StockTransaction"("projectId", "reversedTxId")
  WHERE "reversedTxId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_projectId_poLineId_fkey" FOREIGN KEY ("projectId", "poLineId") REFERENCES "PurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_projectId_commitmentId_fkey" FOREIGN KEY ("projectId", "commitmentId") REFERENCES "DeliveryCommitment"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_projectId_requirementId_revision_fkey" FOREIGN KEY ("projectId", "requirementId", "revision") REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockLot" ADD CONSTRAINT "StockLot_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_lotId_fkey" FOREIGN KEY ("projectId", "lotId") REFERENCES "StockLot"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_poLineId_fkey" FOREIGN KEY ("projectId", "poLineId") REFERENCES "PurchaseOrderLine"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_commitmentId_fkey" FOREIGN KEY ("projectId", "commitmentId") REFERENCES "DeliveryCommitment"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_reversedTxId_fkey" FOREIGN KEY ("projectId", "reversedTxId") REFERENCES "StockTransaction"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_evidenceMediaId_fkey" FOREIGN KEY ("projectId", "evidenceMediaId") REFERENCES "Media"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_sourceCommandId_fkey" FOREIGN KEY ("sourceCommandId") REFERENCES "CommandExecution"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- §C conservation CHECKs — the per-type movement equations, database-enforced.
-- ============================================================================

-- Every movement is strictly positive; direction lives in (fromBucket, toBucket).
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_qty_positive_check"
  CHECK ("qty" > 0);

-- The Task-4 transaction vocabulary (Task 5 extends this constraint additively).
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_type_check"
  CHECK ("type" IN ('receipt', 'acceptance', 'rejection', 'vendor_return', 'adjustment', 'reversal'));

-- The Task-4 bucket domain (Task 5 adds reserved/issuedToActivity movements).
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_bucket_domain_check"
  CHECK (
    ("fromBucket" IS NULL OR "fromBucket" IN ('quarantine', 'acceptedOnHand', 'rejected'))
    AND ("toBucket" IS NULL OR "toBucket" IN ('quarantine', 'acceptedOnHand', 'rejected'))
  );

-- The §C equations: each type's movement + required facts are pinned, so a mis-shaped row
-- is unrepresentable no matter what code inserts it:
--   receipt        (outside) → quarantine     + PO line + commitment provenance
--   acceptance     quarantine → acceptedOnHand + quality result + evidence
--   rejection      quarantine → rejected       + evidence
--   vendor_return  rejected → (vendor)
--   adjustment     any → any (at least one side in the store, not a no-op) + reason
--   reversal       inverse of the referenced row (trigger-verified below) + reason
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_type_shape_check"
  CHECK (
    ("type" = 'receipt' AND "fromBucket" IS NULL AND "toBucket" = 'quarantine'
      AND "poLineId" IS NOT NULL AND "commitmentId" IS NOT NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'acceptance' AND "fromBucket" = 'quarantine' AND "toBucket" = 'acceptedOnHand'
      AND "qualityResult" IS NOT NULL AND "evidenceMediaId" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'rejection' AND "fromBucket" = 'quarantine' AND "toBucket" = 'rejected'
      AND "evidenceMediaId" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'vendor_return' AND "fromBucket" = 'rejected' AND "toBucket" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'adjustment' AND ("fromBucket" IS NOT NULL OR "toBucket" IS NOT NULL)
      AND "fromBucket" IS DISTINCT FROM "toBucket" AND "reason" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'reversal' AND "reversedTxId" IS NOT NULL AND "reason" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL)
  );

-- ============================================================================
-- Append-only triggers (§C rule iii) — both tables are database-immutable.
-- phase3_immutable_row() already exists (20261212000000_phase3_approval_provenance);
-- re-created here so this migration also stands alone on a fresh database.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_immutable_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockLot_append_only"
  BEFORE UPDATE OR DELETE ON "StockLot"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

CREATE TRIGGER "StockTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "StockTransaction"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- ============================================================================
-- Reversal integrity (§C rule iii): a reversal row must be the EXACT inverse of the row it
-- references — same project, lot, store location and quantity, with the buckets swapped —
-- and a reversal row can never itself be reversed (append a fresh correction instead).
-- The type_shape CHECK already guarantees reversedTxId + reason are present.
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_stock_reversal_inverse() RETURNS trigger AS $$
DECLARE
  reversed "StockTransaction"%ROWTYPE;
BEGIN
  SELECT * INTO reversed FROM "StockTransaction"
    WHERE "projectId" = NEW."projectId" AND "id" = NEW."reversedTxId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal references no transaction in this project';
  END IF;
  IF reversed."type" = 'reversal' THEN
    RAISE EXCEPTION 'a reversal cannot be reversed — append a new correcting transaction';
  END IF;
  IF reversed."lotId" <> NEW."lotId" OR reversed."storeLocation" <> NEW."storeLocation" THEN
    RAISE EXCEPTION 'a reversal must target the reversed row''s stock key';
  END IF;
  IF NEW."qty" <> reversed."qty" THEN
    RAISE EXCEPTION 'a reversal restores the reversed row in full (qty must match)';
  END IF;
  IF NEW."fromBucket" IS DISTINCT FROM reversed."toBucket"
     OR NEW."toBucket" IS DISTINCT FROM reversed."fromBucket" THEN
    RAISE EXCEPTION 'a reversal must move the exact inverse of the reversed row';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockTransaction_reversal_inverse"
  BEFORE INSERT ON "StockTransaction"
  FOR EACH ROW WHEN (NEW."type" = 'reversal')
  EXECUTE FUNCTION phase3_stock_reversal_inverse();
