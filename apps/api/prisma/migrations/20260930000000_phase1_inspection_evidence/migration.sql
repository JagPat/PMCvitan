-- Phase 1 Task 4 — inspection evidence + linked reinspections (additive,
-- diagnostic-first). Timestamped AFTER the gate-remediation migrations
-- (20260920/20260925) per the re-review instruction; the plan's original
-- 20260920 slot was taken by the change-control diagnostic.
--
-- Adds the explicit Activity requirement edge, the reinspection linkage
-- (predecessor + assignee + due date), submit/decide attribution, and the
-- Media evidence containment CHAIN: (projectId, inspectionId) proves the
-- inspection belongs to the project, (inspectionId, inspectionItemId) proves
-- the item belongs to THAT inspection, and the CHECK closes PostgreSQL's
-- MATCH SIMPLE escape (a non-null item beside a NULL inspection would bypass
-- the composite FK entirely). clientKey gives PROJECT-scoped upload idempotency.
--
-- DIAGNOSTICS FIRST — the migration ABORTS (never guesses) on containment
-- violations in legacy data; informational counts are RAISE NOTICE only.

DO $$
DECLARE
  orphan_items integer;
  stray_closers integer;
BEGIN
  -- containment: every InspectionItem must have its parent inspection
  SELECT count(*) INTO orphan_items
  FROM "InspectionItem" it LEFT JOIN "Inspection" i ON i."id" = it."inspectionId"
  WHERE i."id" IS NULL;
  IF orphan_items > 0 THEN
    RAISE EXCEPTION 'phase1_inspection_evidence: % inspection item(s) have no parent inspection — resolve by hand before migrating', orphan_items;
  END IF;

  -- informational (used by Task 5): legacy closing inspections whose id names no activity
  SELECT count(*) INTO stray_closers
  FROM "Inspection" i
  WHERE i."id" LIKE 'INSP-%-close'
    AND NOT EXISTS (
      SELECT 1 FROM "Activity" a
      WHERE a."projectId" = i."projectId"
        AND i."id" = 'INSP-' || a."id" || '-close'
    );
  IF stray_closers > 0 THEN
    RAISE NOTICE 'phase1_inspection_evidence: % legacy INSP-*-close id(s) match no activity (informational; Task 5 resolves)', stray_closers;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "activityId" TEXT,
ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decidedByName" TEXT,
ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "reinspectionOfId" TEXT,
ADD COLUMN     "submittedById" TEXT,
ADD COLUMN     "submittedByName" TEXT;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "clientKey" TEXT,
ADD COLUMN     "inspectionId" TEXT,
ADD COLUMN     "inspectionItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_projectId_id_key" ON "Inspection"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionItem_inspectionId_id_key" ON "InspectionItem"("inspectionId", "id");

-- CreateIndex
CREATE INDEX "Media_inspectionId_idx" ON "Media"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Media_projectId_id_key" ON "Media"("projectId", "id");

-- (projectId, clientKey) pre-collisions: none can exist (the column was just added,
-- all values NULL) — kept as a template invariant per the plan; it guards the unique
-- index below and would ABORT if a future re-run ever found duplicates.
DO $$
DECLARE key_collisions integer;
BEGIN
  SELECT count(*) INTO key_collisions FROM (
    SELECT "projectId", "clientKey" FROM "Media"
    WHERE "clientKey" IS NOT NULL
    GROUP BY "projectId", "clientKey" HAVING count(*) > 1
  ) dup;
  IF key_collisions > 0 THEN
    RAISE EXCEPTION 'phase1_inspection_evidence: % (projectId, clientKey) collision(s) — resolve by hand before migrating', key_collisions;
  END IF;
END $$;

-- CreateIndex: PROJECT-scoped idempotency — never a global unique
CREATE UNIQUE INDEX "Media_projectId_clientKey_key" ON "Media"("projectId", "clientKey");

-- AddForeignKey: the evidence containment chain
ALTER TABLE "Media" ADD CONSTRAINT "Media_projectId_inspectionId_fkey" FOREIGN KEY ("projectId", "inspectionId") REFERENCES "Inspection"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Media" ADD CONSTRAINT "Media_inspectionId_inspectionItemId_fkey" FOREIGN KEY ("inspectionId", "inspectionItemId") REFERENCES "InspectionItem"("inspectionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The MATCH SIMPLE escape: under PostgreSQL's default composite-FK semantics a row
-- with a non-null itemId and a NULL inspectionId would bypass the
-- (inspectionId, inspectionItemId) FK entirely — forbid the partial reference outright.
ALTER TABLE "Media" ADD CONSTRAINT "Media_item_requires_inspection"
  CHECK ("inspectionItemId" IS NULL OR "inspectionId" IS NOT NULL);

-- AddForeignKey: the requirement edge
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: a reinspection names its predecessor — same project by construction
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_reinspectionOfId_fkey" FOREIGN KEY ("projectId", "reinspectionOfId") REFERENCES "Inspection"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: the assignee must hold a membership on the project (soft-removed, never deleted)
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_assigneeId_fkey" FOREIGN KEY ("projectId", "assigneeId") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ONE direct reinspection child per rejected inspection — the DB backstop for the
-- CAS decide transition (two racing rejects cannot both create a child)
CREATE UNIQUE INDEX "Inspection_one_reinspection_child" ON "Inspection" ("reinspectionOfId") WHERE "reinspectionOfId" IS NOT NULL;
