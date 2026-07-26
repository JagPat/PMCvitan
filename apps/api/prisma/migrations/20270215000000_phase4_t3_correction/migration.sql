-- Phase 4 Task 3 CORRECTION — the four independent-review findings, sealed in PostgreSQL.
--
-- The merged Task-3 migration `20270210000000` is left BYTE-FOR-BYTE UNCHANGED; this migration is
-- purely additive and DIAGNOSTIC-FIRST: every pre-existing row that would violate a new seal is
-- reported (with a bounded sample) and the migration ABORTS rather than editing or inventing data.
-- The labour pilot is row-free on every legacy database, so a legacy upgrade is a no-op; the
-- diagnostics exist so an operator is never surprised, not because data is expected.
--
--   F1  an allocation could name an activity that does NOT own its requirement (the activity FK
--       and the requirement FK were unrelated, so PostgreSQL accepted the incoherent pairing)
--   F2  attendance was accepted with NO trusted evidence, and `evidenceMediaId` had no FK at all
--   F3  the §F bound-3 trigger COUNTED without serializing, so two concurrent transactions each
--       saw zero and both committed against a quantity-1 commitment
--   F4  a CANCELLED requirement head still accepted new allocations

-- ── diagnostics (abort before any structural change) ──────────────────────────────────────────
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  -- F1 — an allocation whose (requirement, revision) is owned by a DIFFERENT activity
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT a."id" FROM "WorkerAllocation" a
     WHERE NOT EXISTS (
       SELECT 1 FROM "ActivityRequirement" r
        WHERE r."projectId" = a."projectId" AND r."requirementId" = a."requirementId"
          AND r."revision" = a."originRevision" AND r."activityId" = a."activityId")
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase4-t3-correction F1: % WorkerAllocation row(s) name an activity that does not own their requirement revision (sample: %). Release/re-create them against the owning activity, then redeploy.', bad, sample;
  END IF;

  -- F2 — attendance with neither a device nor a manual exception, or citing a missing/foreign photo
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT "id" FROM "LabourAttendance" WHERE "deviceId" IS NULL LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase4-t3-correction F2: % LabourAttendance row(s) carry no trusted evidence (sample: %). Revoke them and re-record with the worker''s bound device, or stamp an explicit manualReason, then redeploy.', bad, sample;
  END IF;
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT a."id" FROM "LabourAttendance" a
     WHERE a."evidenceMediaId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "Media" m WHERE m."projectId" = a."projectId" AND m."id" = a."evidenceMediaId")
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase4-t3-correction F2: % LabourAttendance row(s) cite a media id absent from their project (sample: %). Clear the citation or restore the photo, then redeploy.', bad, sample;
  END IF;

  -- F3 — a commitment already over-drawn (only reachable through the un-serialized trigger)
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT c."id" FROM "CapacityCommitment" c
     WHERE (SELECT count(*) FROM "WorkerAllocation" a
             WHERE a."projectId" = c."projectId" AND a."capacityCommitmentId" = c."id" AND a."status" = 'active') > c."personShiftQty"
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase4-t3-correction F3: % CapacityCommitment(s) hold more ACTIVE allocations than person-shifts committed (sample: %). Release the excess allocations, then redeploy.', bad, sample;
  END IF;

  -- F4 — a live allocation against a CANCELLED requirement head
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT a."id" FROM "WorkerAllocation" a
     WHERE a."status" = 'active' AND EXISTS (
       SELECT 1 FROM "ActivityRequirement" r
        WHERE r."projectId" = a."projectId" AND r."requirementId" = a."requirementId" AND r."status" = 'cancelled'
          AND r."revision" = (SELECT max(r2."revision") FROM "ActivityRequirement" r2
                               WHERE r2."projectId" = a."projectId" AND r2."requirementId" = a."requirementId"))
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase4-t3-correction F4: % ACTIVE allocation(s) are held against a CANCELLED requirement head (sample: %). Release them, then redeploy.', bad, sample;
  END IF;
END $$;

-- ── F1: ONE coherent Activities-owned demand identity ─────────────────────────────────────────
-- The candidate key the allocation's demand-identity FK references. `(projectId, requirementId,
-- revision)` is already unique, so adding `activityId` is a strict widening of an existing key —
-- it cannot change which rows are permitted in `ActivityRequirement`, only what may reference it.
CREATE UNIQUE INDEX "ActivityRequirement_demand_identity_key"
  ON "ActivityRequirement"("projectId", "requirementId", "revision", "activityId");

-- The allocation now references the requirement revision AND its owning activity as ONE key, so a
-- mismatched pair is unrepresentable — the defect was that the two FKs were independent.
ALTER TABLE "WorkerAllocation"
  ADD CONSTRAINT "WorkerAllocation_demand_identity_fkey"
  FOREIGN KEY ("projectId", "requirementId", "originRevision", "activityId")
  REFERENCES "ActivityRequirement"("projectId", "requirementId", "revision", "activityId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── F4: a CANCELLED head accepts no new allocation ────────────────────────────────────────────
-- An allocation pins the revision it was made against, and a cancel APPENDS a new revision, so the
-- pinned row stays 'open' while the HEAD becomes 'cancelled'. The seal therefore looks at the head,
-- not at the pinned revision. Cancellation itself is blocked while live allocations remain (the
-- labour participant's disposition check), so the two rules together leave no stranded capacity.
CREATE OR REPLACE FUNCTION phase4_t3c_allocation_head_live() RETURNS trigger AS $$
DECLARE head_status TEXT;
BEGIN
  SELECT r."status" INTO head_status
    FROM "ActivityRequirement" r
   WHERE r."projectId" = NEW."projectId" AND r."requirementId" = NEW."requirementId"
   ORDER BY r."revision" DESC LIMIT 1;
  IF head_status = 'cancelled' THEN
    RAISE EXCEPTION 'requirement % is cancelled — its demand is dead and cannot be allocated against', NEW."requirementId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WorkerAllocation_head_live" BEFORE INSERT ON "WorkerAllocation"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3c_allocation_head_live();

-- ── F2: attendance carries TRUSTED evidence ───────────────────────────────────────────────────
ALTER TABLE "LabourAttendance" ADD COLUMN "manualReason" TEXT;

-- Presence is either device-evidenced or an EXPLICIT attributable exception. A bare claim — the
-- state the Team gate would have read as execution truth — is now unrepresentable.
ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_trusted_evidence"
  CHECK ("deviceId" IS NOT NULL OR "manualReason" IS NOT NULL);
-- and never both: a muster is one path or the other, so the evidence basis is unambiguous
ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_one_evidence_path"
  CHECK (NOT ("deviceId" IS NOT NULL AND "manualReason" IS NOT NULL));

-- the cited capture must be a photo IN THIS PROJECT (there was no FK at all, so a nonexistent or
-- cross-project id was accepted); deletion while cited is refused by the labour participant.
ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_evidence_media_fkey"
  FOREIGN KEY ("projectId", "evidenceMediaId") REFERENCES "Media"("projectId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "LabourAttendance_evidence_media_idx"
  ON "LabourAttendance"("projectId", "evidenceMediaId") WHERE "evidenceMediaId" IS NOT NULL;

-- ── F3: §F bound 3 becomes a REAL invariant under concurrency ─────────────────────────────────
-- The previous trigger COUNTED the existing draws. Under READ COMMITTED two concurrent
-- transactions each see the other's uncommitted row as absent, so both counted zero and both
-- committed — the service lock made the application path safe while the claimed DATABASE invariant
-- was not. Taking `FOR UPDATE` on the commitment row inside the trigger serializes every drawing
-- transaction against that commitment: the second waits for the first to commit, then re-counts
-- with the first row visible and is rejected. Exactly one may take the last person-shift, whoever
-- writes it and however they connect.
CREATE OR REPLACE FUNCTION phase4_t3_allocation_within_commitment() RETURNS trigger AS $$
DECLARE c RECORD; drawn BIGINT;
BEGIN
  IF NEW."capacityCommitmentId" IS NULL THEN RETURN NEW; END IF;
  -- SERIALIZE first, then read: the row lock is what makes the count below trustworthy.
  SELECT "personShiftQty", "status" INTO c
  FROM "CapacityCommitment"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."capacityCommitmentId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WorkerAllocation % references a CapacityCommitment absent from its project', NEW."id";
  END IF;
  IF c."status" <> 'committed' THEN
    RAISE EXCEPTION 'CapacityCommitment % is % — only committed capacity can be drawn down', NEW."capacityCommitmentId", c."status";
  END IF;
  SELECT count(*) INTO drawn FROM "WorkerAllocation"
   WHERE "projectId" = NEW."projectId" AND "capacityCommitmentId" = NEW."capacityCommitmentId"
     AND "status" = 'active' AND "id" <> NEW."id";
  IF drawn + 1 > c."personShiftQty" THEN
    RAISE EXCEPTION '§F bound 3: commitment % has % committed person-shift(s) for its slice; % are already allocated', NEW."capacityCommitmentId", c."personShiftQty", drawn;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
