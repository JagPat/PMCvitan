-- Phase 2 Task 10 (Module 3) correction — make the inspections.inbox projection sourced ONLY from
-- inspection-owned facts. The serializer formerly read Activity.name (a live cross-module read) and Media
-- evidence rows (another module's table); neither could be observed by the inspection projection when the
-- foreign row changed, so a caught-up generation could report stale slices. This migration adds the two
-- inspection-owned facts the serializer will read instead, and backfills them from the current canonical
-- state. Additive, forward-only. The legacy Media linkage columns and the Activity relation are RETAINED.

-- ── 1) The inspection-owned activity label ────────────────────────────────────────────────────────────
ALTER TABLE "Inspection" ADD COLUMN "activityName" TEXT;

-- Backfill from the linked Activity — exactly the value the serializer read live before this correction,
-- so the baked slice is byte-identical the instant the column exists.
UPDATE "Inspection" i
SET "activityName" = a."name"
FROM "Activity" a
WHERE i."activityId" = a."id" AND i."projectId" = a."projectId";

-- ── 2) The inspection-owned evidence link ─────────────────────────────────────────────────────────────
CREATE TABLE "InspectionEvidence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "inspectionItemId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionEvidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InspectionEvidence_inspectionItemId_mediaId_key" ON "InspectionEvidence"("inspectionItemId", "mediaId");
CREATE INDEX "InspectionEvidence_projectId_idx" ON "InspectionEvidence"("projectId");
CREATE INDEX "InspectionEvidence_mediaId_idx" ON "InspectionEvidence"("mediaId");
CREATE INDEX "InspectionEvidence_inspectionId_idx" ON "InspectionEvidence"("inspectionId");

-- DIAGNOSTIC ABORT (do not guess or discard data): item-level evidence with NO inspection is un-linkable
-- legacy containment — a Media row carrying an inspectionItemId but a NULL inspectionId. The composite
-- (inspectionId, inspectionItemId) FK on Media does NOT constrain this (a NULL member disables MATCH
-- SIMPLE), so such a row could pre-exist the app-level guard. Refuse the migration and name the count; an
-- operator repairs the offending rows (set the inspectionId, or clear the orphan item link) and redeploys.
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM "Media" m
  WHERE m."inspectionItemId" IS NOT NULL AND m."inspectionId" IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'InspectionEvidence backfill aborted: % media evidence row(s) carry an inspectionItemId with a NULL inspectionId (un-linkable legacy containment). Repair these rows and redeploy.', bad;
  END IF;
END $$;

-- Backfill the link from existing item-level linked Media (both inspectionId and inspectionItemId set —
-- exactly the rows the serializer counted as an item's evidence). Idempotent on redeploy via ON CONFLICT.
INSERT INTO "InspectionEvidence" ("id", "projectId", "inspectionId", "inspectionItemId", "mediaId", "createdAt")
SELECT gen_random_uuid(), m."projectId", m."inspectionId", m."inspectionItemId", m."id", m."createdAt"
FROM "Media" m
WHERE m."inspectionId" IS NOT NULL AND m."inspectionItemId" IS NOT NULL
ON CONFLICT ("inspectionItemId", "mediaId") DO NOTHING;

-- FK backstops (the inspections participant maintains these rows in-transaction; the constraints are the
-- database safety net). All CASCADE so deleting any parent cleans its links; the participant still emits
-- the inspection event on the normal media-remove / inspection-change paths.
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_project_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_inspection_fkey"
  FOREIGN KEY ("projectId", "inspectionId") REFERENCES "Inspection"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_item_fkey"
  FOREIGN KEY ("inspectionId", "inspectionItemId") REFERENCES "InspectionItem"("inspectionId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_media_fkey"
  FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
