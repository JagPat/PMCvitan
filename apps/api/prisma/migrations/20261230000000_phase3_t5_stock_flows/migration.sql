-- ============================================================================
-- Phase 3 Task 5 — the store-to-site §C flows + the §E reconciliation records.
--
-- FORWARD-ONLY. Additive in effect: two NEW tables (MaterialIssue, MismatchResolution),
-- three NEW nullable columns on the ledger, one new unique on SiteMaterial (its (projectId,
-- id) pair is already unique — id is the PK — so adding the composite index cannot fail),
-- and the three §C conservation CHECKs REPLACED by widened versions. Every pre-existing
-- ledger row satisfies the widened CHECKs by construction: the Task-4 arms are retained
-- verbatim, extended only with `activityId/issueId/toStoreLocation IS NULL` — exactly the
-- value every existing row holds for a column that did not exist. No row is read, moved or
-- rewritten, so there is no backfill and no diagnostic phase.
--
-- Design (plan §§C/E):
--   • `MaterialIssue` — the §E-CANONICAL record of what LEFT THE STORE for an activity
--     ("an issue is not a delivery"). Immutable; corrections reverse ledger rows (§C rule
--     iii), so a daily-log reference to an issue id can never be orphaned.
--   • `MismatchResolution` — closes EXACTLY ONE `matched: false` observation
--     (`(projectId, siteMaterialId)` UNIQUE); the observation row is never edited.
--   • Ledger: `reservation`/`reservation_release` claim/release part of acceptedOnHand for
--     a NAMED activity ((outside) ↔ `reserved`); `issue` is the only movement that takes
--     on-hand stock out of the store for work (`acceptedOnHand → issuedToActivity`);
--     `consumption`/`site_return`/`wastage` are recorded AGAINST a MaterialIssue and move
--     ONLY `issuedToActivity` (the double-count guard is structural: their CHECK arms
--     cannot name a store bucket); `transfer` moves acceptedOnHand between two store
--     locations of the SAME lot in ONE row (`toStoreLocation` = destination key).
--   • The reversal-inverse trigger is extended: a reversal copies its target's
--     activity/issue scope verbatim, and a TRANSFER reverses by moving the same quantity
--     back (source/destination swapped, buckets unchanged).
-- ============================================================================

-- AlterTable — the ledger's Task-5 scope columns (nullable; CHECK-pinned per type below)
ALTER TABLE "StockTransaction" ADD COLUMN     "activityId" TEXT,
ADD COLUMN     "issueId" TEXT,
ADD COLUMN     "toStoreLocation" TEXT;

-- CreateTable
CREATE TABLE "MaterialIssue" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "storeLocation" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "qty" DECIMAL(18,6) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT NOT NULL,

    CONSTRAINT "MaterialIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MismatchResolution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteMaterialId" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT NOT NULL,

    CONSTRAINT "MismatchResolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialIssue_projectId_activityId_idx" ON "MaterialIssue"("projectId", "activityId");
CREATE INDEX "MaterialIssue_projectId_lotId_idx" ON "MaterialIssue"("projectId", "lotId");
CREATE UNIQUE INDEX "MaterialIssue_projectId_id_key" ON "MaterialIssue"("projectId", "id");
-- §E: a resolution closes EXACTLY ONE observation — a second resolution is unrepresentable
CREATE UNIQUE INDEX "MismatchResolution_projectId_siteMaterialId_key" ON "MismatchResolution"("projectId", "siteMaterialId");
CREATE UNIQUE INDEX "MismatchResolution_projectId_id_key" ON "MismatchResolution"("projectId", "id");
-- the resolution FK's referenced identity (id is the PK, so this pair is already unique)
CREATE UNIQUE INDEX "SiteMaterial_projectId_id_key" ON "SiteMaterial"("projectId", "id");
CREATE INDEX "StockTransaction_projectId_activityId_idx" ON "StockTransaction"("projectId", "activityId");
CREATE INDEX "StockTransaction_projectId_issueId_idx" ON "StockTransaction"("projectId", "issueId");

-- AddForeignKey
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_projectId_issueId_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "MaterialIssue"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_projectId_lotId_fkey" FOREIGN KEY ("projectId", "lotId") REFERENCES "StockLot"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MaterialIssue" ADD CONSTRAINT "MaterialIssue_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MismatchResolution" ADD CONSTRAINT "MismatchResolution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MismatchResolution" ADD CONSTRAINT "MismatchResolution_projectId_siteMaterialId_fkey" FOREIGN KEY ("projectId", "siteMaterialId") REFERENCES "SiteMaterial"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "MismatchResolution" ADD CONSTRAINT "MismatchResolution_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- §C conservation CHECKs — WIDENED (drop + re-add; PostgreSQL re-validates every existing
-- row on ADD, so the widening is proven safe at migration time, not assumed).
-- ============================================================================

ALTER TABLE "StockTransaction" DROP CONSTRAINT "StockTransaction_type_check";
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_type_check"
  CHECK ("type" IN (
    'receipt', 'acceptance', 'rejection', 'vendor_return', 'adjustment', 'reversal',
    'reservation', 'reservation_release', 'issue', 'consumption', 'site_return', 'wastage', 'transfer'
  ));

ALTER TABLE "StockTransaction" DROP CONSTRAINT "StockTransaction_bucket_domain_check";
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_bucket_domain_check"
  CHECK (
    ("fromBucket" IS NULL OR "fromBucket" IN ('quarantine', 'acceptedOnHand', 'rejected', 'reserved', 'issuedToActivity'))
    AND ("toBucket" IS NULL OR "toBucket" IN ('quarantine', 'acceptedOnHand', 'rejected', 'reserved', 'issuedToActivity'))
  );

-- The §C equations, one arm per type (Task-4 arms retained + pinned to NULL Task-5 scope):
--   reservation          (outside) → reserved         + activity (guard freeAvailable ≥ qty in-tx)
--   reservation_release  reserved → (outside)         + activity
--   issue                acceptedOnHand → issuedToActivity + activity + the §E MaterialIssue
--   consumption          issuedToActivity → (consumed)    + activity + issue — NEVER a store bucket
--   site_return          issuedToActivity → acceptedOnHand + activity + issue
--   wastage              issuedToActivity → (written off)  + activity + issue + reason + evidence
--   transfer             acceptedOnHand@source → acceptedOnHand@toStoreLocation (one row, two keys)
--   adjustment           STORE buckets only — activity/issue custody is corrected by
--                        REVERSING the row that created it (§C rule iii), never free-form
ALTER TABLE "StockTransaction" DROP CONSTRAINT "StockTransaction_type_shape_check";
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_type_shape_check"
  CHECK (
    ("type" = 'receipt' AND "fromBucket" IS NULL AND "toBucket" = 'quarantine'
      AND "poLineId" IS NOT NULL AND "commitmentId" IS NOT NULL AND "reversedTxId" IS NULL
      AND "activityId" IS NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL)
    OR ("type" = 'acceptance' AND "fromBucket" = 'quarantine' AND "toBucket" = 'acceptedOnHand'
      AND "qualityResult" IS NOT NULL AND "evidenceMediaId" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL
      AND "activityId" IS NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL)
    OR ("type" = 'rejection' AND "fromBucket" = 'quarantine' AND "toBucket" = 'rejected'
      AND "evidenceMediaId" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL
      AND "activityId" IS NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL)
    OR ("type" = 'vendor_return' AND "fromBucket" = 'rejected' AND "toBucket" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL
      AND "activityId" IS NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL)
    OR ("type" = 'adjustment' AND ("fromBucket" IS NOT NULL OR "toBucket" IS NOT NULL)
      AND "fromBucket" IS DISTINCT FROM "toBucket" AND "reason" IS NOT NULL
      AND ("fromBucket" IS NULL OR "fromBucket" IN ('quarantine', 'acceptedOnHand', 'rejected'))
      AND ("toBucket" IS NULL OR "toBucket" IN ('quarantine', 'acceptedOnHand', 'rejected'))
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL
      AND "activityId" IS NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL)
    OR ("type" = 'reversal' AND "reversedTxId" IS NOT NULL AND "reason" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL)
    OR ("type" = 'reservation' AND "fromBucket" IS NULL AND "toBucket" = 'reserved'
      AND "activityId" IS NOT NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'reservation_release' AND "fromBucket" = 'reserved' AND "toBucket" IS NULL
      AND "activityId" IS NOT NULL AND "issueId" IS NULL AND "toStoreLocation" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'issue' AND "fromBucket" = 'acceptedOnHand' AND "toBucket" = 'issuedToActivity'
      AND "activityId" IS NOT NULL AND "issueId" IS NOT NULL AND "toStoreLocation" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'consumption' AND "fromBucket" = 'issuedToActivity' AND "toBucket" IS NULL
      AND "activityId" IS NOT NULL AND "issueId" IS NOT NULL AND "toStoreLocation" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'site_return' AND "fromBucket" = 'issuedToActivity' AND "toBucket" = 'acceptedOnHand'
      AND "activityId" IS NOT NULL AND "issueId" IS NOT NULL AND "toStoreLocation" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'wastage' AND "fromBucket" = 'issuedToActivity' AND "toBucket" IS NULL
      AND "activityId" IS NOT NULL AND "issueId" IS NOT NULL AND "toStoreLocation" IS NULL
      AND "reason" IS NOT NULL AND "evidenceMediaId" IS NOT NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
    OR ("type" = 'transfer' AND "fromBucket" = 'acceptedOnHand' AND "toBucket" = 'acceptedOnHand'
      AND "toStoreLocation" IS NOT NULL AND "toStoreLocation" <> "storeLocation"
      AND "activityId" IS NULL AND "issueId" IS NULL
      AND "poLineId" IS NULL AND "commitmentId" IS NULL AND "reversedTxId" IS NULL)
  );

-- ============================================================================
-- Append-only triggers — the two §E records are database-immutable (§C rule iii /
-- §E "the original observation row is never edited" discipline).
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_immutable_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaterialIssue_append_only"
  BEFORE UPDATE OR DELETE ON "MaterialIssue"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

CREATE TRIGGER "MismatchResolution_append_only"
  BEFORE UPDATE OR DELETE ON "MismatchResolution"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- ============================================================================
-- Reversal integrity v2 (§C rule iii): unchanged for store movements; EXTENDED so a
-- reversal copies its target's activity/issue scope VERBATIM (per-activity and per-issue
-- custody folds see the correction), and a TRANSFER reverses by moving the same quantity
-- BACK — source/destination swapped, buckets unchanged. The existing BEFORE INSERT trigger
-- keeps firing this replaced function; no trigger re-creation is needed.
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
  IF reversed."lotId" <> NEW."lotId" THEN
    RAISE EXCEPTION 'a reversal must target the reversed row''s stock key';
  END IF;
  IF NEW."qty" <> reversed."qty" THEN
    RAISE EXCEPTION 'a reversal restores the reversed row in full (qty must match)';
  END IF;
  IF NEW."activityId" IS DISTINCT FROM reversed."activityId"
     OR NEW."issueId" IS DISTINCT FROM reversed."issueId" THEN
    RAISE EXCEPTION 'a reversal must carry the reversed row''s activity/issue scope verbatim';
  END IF;
  IF reversed."toStoreLocation" IS NOT NULL THEN
    -- a transfer reverses by moving BACK: locations swapped, buckets unchanged
    IF NEW."storeLocation" <> reversed."toStoreLocation"
       OR NEW."toStoreLocation" IS DISTINCT FROM reversed."storeLocation"
       OR NEW."fromBucket" IS DISTINCT FROM reversed."fromBucket"
       OR NEW."toBucket" IS DISTINCT FROM reversed."toBucket" THEN
      RAISE EXCEPTION 'a transfer reversal must move the same quantity back to the source location';
    END IF;
  ELSE
    IF NEW."storeLocation" <> reversed."storeLocation" OR NEW."toStoreLocation" IS NOT NULL THEN
      RAISE EXCEPTION 'a reversal must target the reversed row''s stock key';
    END IF;
    IF NEW."fromBucket" IS DISTINCT FROM reversed."toBucket"
       OR NEW."toBucket" IS DISTINCT FROM reversed."fromBucket" THEN
      RAISE EXCEPTION 'a reversal must move the exact inverse of the reversed row';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
