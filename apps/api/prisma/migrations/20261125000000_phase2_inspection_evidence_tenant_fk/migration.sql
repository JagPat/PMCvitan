-- Phase 2 Task 10 (Module 3) correction round 2, F1 — tenant-contain the InspectionEvidence→Media
-- reference. The original backstop (20261120000000, checksum untouched) was a single-column FK
-- InspectionEvidence(mediaId) → Media(id), which permits a link whose projectId is project A while its
-- mediaId belongs to project B. Replace it with the composite tenant FK the other Media referrers use
-- (GateOverride precedent): (projectId, mediaId) → Media(projectId, id), backed by the existing
-- "Media_projectId_id_key" unique identity. Additive, forward-only.

-- DIAGNOSTIC ABORT (do not guess or discard data): a pre-existing link whose projectId disagrees with its
-- media's projectId is cross-tenant garbage the old FK could not catch. Refuse the migration and name the
-- count + affected ids; an operator repairs the offending rows (delete the forged link, or correct its
-- reference) and redeploys.
DO $$
DECLARE bad INT;
DECLARE ids TEXT;
BEGIN
  SELECT COUNT(*), string_agg(ie."id", ', ' ORDER BY ie."id")
    INTO bad, ids
  FROM "InspectionEvidence" ie
  JOIN "Media" m ON m."id" = ie."mediaId"
  WHERE ie."projectId" <> m."projectId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'InspectionEvidence tenant-FK migration aborted: % link(s) reference media of ANOTHER project (InspectionEvidence ids: %). Repair these rows and redeploy.', bad, ids;
  END IF;
END $$;

-- Replace the id-only backstop with the tenant-containing composite FK. Same delete behaviour (CASCADE —
-- the participant still unlinks + emits `inspection.evidence_removed` on the normal media-remove path;
-- the FK stays the database safety net).
ALTER TABLE "InspectionEvidence" DROP CONSTRAINT "InspectionEvidence_media_fkey";
ALTER TABLE "InspectionEvidence" ADD CONSTRAINT "InspectionEvidence_media_fkey"
  FOREIGN KEY ("projectId", "mediaId") REFERENCES "Media"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
