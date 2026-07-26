-- Phase 4 Task 3 — the §C TIME-CAPACITY fact families (plan §C/§H).
--
-- ADDITIVE and DIAGNOSTIC-FIRST. Every earlier migration is left byte-for-byte unchanged. The
-- labour pilot is ROW-FREE in production, so a legacy database upgrades with ZERO rows written.
--
-- Labour is EXPIRING capacity, so this is NOT a stock ledger — no current-quantity column, no
-- bucket. Four tables:
--   WorkerAllocation           1 person-shift   frozen-identity CAS (active -> released)
--   LabourAttendance           headcount (1)    append-only observation, revocable as a correction
--   LabourWorkFact             worked-minutes   append-only observation, bounded per row + per slice
--   ApprovedSkillSubstitution  (authorization)  pmc-authored, revocable §B widening
--
-- The conserved invariant is enforced at the WORKER (the atomic capacity source, round-2 finding 1):
-- a PARTIAL UNIQUE on (projectId, workerId, civilDate, shift) WHERE status='active' makes a second
-- live allocation of one worker for one date+shift UNREPRESENTABLE. A crew allocation expands into
-- one row per active member in the same transaction, so a worker double-booked directly, via two
-- crews, or directly-and-via-crew all collide on this ONE constraint.

-- ── tables ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "WorkerAllocation" (
  "id"                    TEXT PRIMARY KEY,
  "projectId"             TEXT NOT NULL,
  "workerId"              TEXT NOT NULL,
  "civilDate"             DATE NOT NULL,
  "shift"                 TEXT NOT NULL,
  "activityId"            TEXT NOT NULL,
  "requirementId"         TEXT NOT NULL,
  "originRevision"        INTEGER NOT NULL,
  "labourSpecFingerprint" TEXT NOT NULL,
  "crewId"                TEXT,
  "status"                TEXT NOT NULL DEFAULT 'active',
  "allocatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "allocatedById"         TEXT NOT NULL,
  "releasedAt"            TIMESTAMP(3),
  "releasedById"          TEXT,
  "releaseReason"         TEXT,
  "sourceCommandId"       TEXT NOT NULL,
  CONSTRAINT "WorkerAllocation_status_check" CHECK ("status" IN ('active','released')),
  CONSTRAINT "WorkerAllocation_shift_check" CHECK ("shift" IN ('day','night')),
  CONSTRAINT "WorkerAllocation_revision_check" CHECK ("originRevision" >= 1),
  -- a released allocation is fully attributed; an active one carries no release stamp
  CONSTRAINT "WorkerAllocation_release_attribution_check" CHECK (
    ("status" = 'active'   AND "releasedAt" IS NULL AND "releasedById" IS NULL)
 OR ("status" = 'released' AND "releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL)
  )
);

CREATE TABLE "LabourAttendance" (
  "id"              TEXT PRIMARY KEY,
  "projectId"       TEXT NOT NULL,
  "workerId"        TEXT NOT NULL,
  "civilDate"       DATE NOT NULL,
  "shift"           TEXT NOT NULL,
  "deviceId"        TEXT,
  "evidenceMediaId" TEXT,
  "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById"    TEXT NOT NULL,
  "revokedAt"       TIMESTAMP(3),
  "revokedById"     TEXT,
  "revokeReason"    TEXT,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "LabourAttendance_shift_check" CHECK ("shift" IN ('day','night')),
  -- a revocation is a CORRECTION and is fully attributed with its reason
  CONSTRAINT "LabourAttendance_revoke_attribution_check" CHECK (
    ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
 OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)
  )
);

CREATE TABLE "LabourWorkFact" (
  "id"              TEXT PRIMARY KEY,
  "projectId"       TEXT NOT NULL,
  "workerId"        TEXT NOT NULL,
  "allocationId"    TEXT NOT NULL,
  "activityId"      TEXT NOT NULL,
  "civilDate"       DATE NOT NULL,
  "shift"           TEXT NOT NULL,
  "workedMinutes"   INTEGER NOT NULL,
  "note"            TEXT,
  "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById"    TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "LabourWorkFact_shift_check" CHECK ("shift" IN ('day','night')),
  -- the PER-ROW bound (720 minutes = one 12h shift). The CUMULATIVE bound per
  -- (worker, civilDate, shift) is re-derived by the command under the worker FOR UPDATE
  -- (round-3 guardrail 2) — a per-row CHECK alone cannot stop rows summing past the shift.
  CONSTRAINT "LabourWorkFact_minutes_check" CHECK ("workedMinutes" > 0 AND "workedMinutes" <= 720)
);

CREATE TABLE "ApprovedSkillSubstitution" (
  "id"              TEXT PRIMARY KEY,
  "projectId"       TEXT NOT NULL,
  "requirementId"   TEXT NOT NULL,
  "fromFingerprint" TEXT NOT NULL,
  "toFingerprint"   TEXT NOT NULL,
  "reason"          TEXT NOT NULL,
  "approvedById"    TEXT NOT NULL,
  "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"       TIMESTAMP(3),
  "revokedById"     TEXT,
  "revokeReason"    TEXT,
  "sourceCommandId" TEXT NOT NULL,
  -- a substitution never admits its own fingerprint (that is not a substitution)
  CONSTRAINT "ApprovedSkillSubstitution_distinct_check" CHECK ("fromFingerprint" <> "toFingerprint"),
  CONSTRAINT "ApprovedSkillSubstitution_revoke_attribution_check" CHECK (
    ("revokedAt" IS NULL     AND "revokedById" IS NULL     AND "revokeReason" IS NULL)
 OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokeReason" IS NOT NULL)
  )
);

-- ── candidate keys + lookup indexes ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "WorkerAllocation_projectId_id_key"          ON "WorkerAllocation"("projectId", "id");
CREATE INDEX "WorkerAllocation_worker_slice_idx"                 ON "WorkerAllocation"("projectId", "workerId", "civilDate", "shift");
CREATE INDEX "WorkerAllocation_activity_slice_idx"               ON "WorkerAllocation"("projectId", "activityId", "civilDate", "shift");
CREATE INDEX "WorkerAllocation_requirement_idx"                  ON "WorkerAllocation"("projectId", "requirementId", "originRevision");
CREATE UNIQUE INDEX "LabourAttendance_projectId_id_key"          ON "LabourAttendance"("projectId", "id");
CREATE INDEX "LabourAttendance_worker_slice_idx"                 ON "LabourAttendance"("projectId", "workerId", "civilDate", "shift");
CREATE INDEX "LabourAttendance_slice_idx"                        ON "LabourAttendance"("projectId", "civilDate", "shift");
CREATE UNIQUE INDEX "LabourWorkFact_projectId_id_key"            ON "LabourWorkFact"("projectId", "id");
CREATE INDEX "LabourWorkFact_worker_slice_idx"                   ON "LabourWorkFact"("projectId", "workerId", "civilDate", "shift");
CREATE INDEX "LabourWorkFact_activity_slice_idx"                 ON "LabourWorkFact"("projectId", "activityId", "civilDate", "shift");
CREATE UNIQUE INDEX "ApprovedSkillSubstitution_projectId_id_key" ON "ApprovedSkillSubstitution"("projectId", "id");
CREATE INDEX "ApprovedSkillSubstitution_requirement_idx"         ON "ApprovedSkillSubstitution"("projectId", "requirementId");
CREATE INDEX "ApprovedSkillSubstitution_to_idx"                  ON "ApprovedSkillSubstitution"("projectId", "toFingerprint");

-- ── THE conserved invariant (§C.2, round-2 finding 1) ─────────────────────────────────────────
-- ONE live allocation per (project, worker, civilDate, shift). Because the atomic source is always
-- the Worker — a crew allocation EXPANDS into per-member rows — the worker-vs-crew and
-- overlapping-crews double-booking shapes collide here too. Prisma cannot express a partial unique.
CREATE UNIQUE INDEX "WorkerAllocation_live_slice_key"
  ON "WorkerAllocation"("projectId", "workerId", "civilDate", "shift") WHERE "status" = 'active';

-- ONE live attendance per (project, worker, civilDate, shift) (§C.3, round-2 finding 5). A revoked
-- row is excluded, so history survives and a corrected re-record is allowed.
CREATE UNIQUE INDEX "LabourAttendance_live_slice_key"
  ON "LabourAttendance"("projectId", "workerId", "civilDate", "shift") WHERE "revokedAt" IS NULL;

-- ONE active substitution per (requirement, from, to) — the Phase-3 T6-F2 rule verbatim.
CREATE UNIQUE INDEX "ApprovedSkillSubstitution_active_key"
  ON "ApprovedSkillSubstitution"("projectId", "requirementId", "fromFingerprint", "toFingerprint")
  WHERE "revokedAt" IS NULL;

-- ── containment: every reference is same-project, so a cross-project fact is unrepresentable ───
-- The allocation pins the §B identity it satisfies, so it must reference the spec's WHOLE frozen
-- identity — not just (requirement, revision). Extend the spec's existing unique key with the
-- fingerprint so the four-column FK below has a matching candidate key (the base
-- (projectId, requirementId, revision) unique already exists; adding the fingerprint keeps it
-- unique because there is exactly one spec per revision).
CREATE UNIQUE INDEX "LabourRequirementSpec_allocation_identity_key"
  ON "LabourRequirementSpec"("projectId", "requirementId", "revision", "labourSpecFingerprint");

-- The attendance fact cites the device that evidenced the muster through a SAME-PROJECT composite
-- FK, so a device can never evidence presence in another project. `WorkerDevice.id` is already the
-- primary key; this adds the (projectId, id) candidate key that composite FK requires. Purely
-- additive — it constrains nothing that was not already unique.
CREATE UNIQUE INDEX "WorkerDevice_projectId_id_key" ON "WorkerDevice"("projectId", "id");

ALTER TABLE "WorkerAllocation"
  ADD CONSTRAINT "WorkerAllocation_project_fkey"   FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_worker_fkey"    FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_activity_fkey"  FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_spec_fkey"      FOREIGN KEY ("projectId", "requirementId", "originRevision", "labourSpecFingerprint")
    REFERENCES "LabourRequirementSpec"("projectId", "requirementId", "revision", "labourSpecFingerprint") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_crew_fkey"      FOREIGN KEY ("projectId", "crewId") REFERENCES "Crew"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_command_fkey"   FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_allocatedBy_fkey" FOREIGN KEY ("allocatedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "WorkerAllocation_releasedBy_fkey"  FOREIGN KEY ("releasedById")  REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_project_fkey"    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourAttendance_worker_fkey"     FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourAttendance_device_fkey"     FOREIGN KEY ("projectId", "deviceId") REFERENCES "WorkerDevice"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourAttendance_command_fkey"    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourAttendance_recordedBy_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourAttendance_revokedBy_fkey"  FOREIGN KEY ("revokedById")  REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "LabourWorkFact"
  ADD CONSTRAINT "LabourWorkFact_project_fkey"    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourWorkFact_worker_fkey"     FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourWorkFact_allocation_fkey" FOREIGN KEY ("projectId", "allocationId") REFERENCES "WorkerAllocation"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourWorkFact_activity_fkey"   FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourWorkFact_command_fkey"    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "LabourWorkFact_recordedBy_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "ApprovedSkillSubstitution"
  ADD CONSTRAINT "ApprovedSkillSubstitution_project_fkey"    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ApprovedSkillSubstitution_root_fkey"       FOREIGN KEY ("projectId", "requirementId") REFERENCES "ActivityRequirementRoot"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ApprovedSkillSubstitution_command_fkey"    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ApprovedSkillSubstitution_approvedBy_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ApprovedSkillSubstitution_revokedBy_fkey"  FOREIGN KEY ("revokedById")  REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── §C seals: frozen identity (allocation) + append-only (the observations) ────────────────────
-- The allocation is a FROZEN-IDENTITY CAS row (the PurchaseOrderVersion pattern), NOT append-only:
-- only `status` and the release attribution may ever change. Its slice/demand identity is frozen,
-- so a released row is still honest provenance and a live row can never be re-pointed.
CREATE OR REPLACE FUNCTION phase4_t3_allocation_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WorkerAllocation rows are never deleted (release the allocation instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."workerId" <> OLD."workerId"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."activityId" <> OLD."activityId" OR NEW."requirementId" <> OLD."requirementId"
     OR NEW."originRevision" <> OLD."originRevision"
     OR NEW."labourSpecFingerprint" <> OLD."labourSpecFingerprint"
     OR NEW."crewId" IS DISTINCT FROM OLD."crewId"
     OR NEW."allocatedAt" <> OLD."allocatedAt" OR NEW."allocatedById" <> OLD."allocatedById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'WorkerAllocation identity is FROZEN — only status/release attribution may change (%)', OLD."id";
  END IF;
  -- the lifecycle is one-way: active -> released, and a released row is terminal
  IF OLD."status" = 'released' AND NEW."status" <> 'released' THEN
    RAISE EXCEPTION 'a released WorkerAllocation can never be re-activated (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WorkerAllocation_frozen" BEFORE UPDATE OR DELETE ON "WorkerAllocation"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3_allocation_frozen();

-- Attendance is an APPEND-ONLY observation: the only permitted mutation is the revocation stamp
-- (a correction), and a revoked row is terminal. Nothing else — not the worker, slice, device or
-- evidence — may ever change, so presence history is immutable.
CREATE OR REPLACE FUNCTION phase4_t3_attendance_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourAttendance rows are never deleted (revoke the attendance instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."workerId" <> OLD."workerId"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."deviceId" IS DISTINCT FROM OLD."deviceId"
     OR NEW."evidenceMediaId" IS DISTINCT FROM OLD."evidenceMediaId"
     OR NEW."recordedAt" <> OLD."recordedAt" OR NEW."recordedById" <> OLD."recordedById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'LabourAttendance is an APPEND-ONLY observation — only the revocation stamp may change (%)', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked LabourAttendance is terminal (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourAttendance_append_only" BEFORE UPDATE OR DELETE ON "LabourAttendance"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3_attendance_append_only();

-- The effort observation is fully immutable — a correction is a new row, never an edit.
CREATE TRIGGER "LabourWorkFact_append_only" BEFORE UPDATE OR DELETE ON "LabourWorkFact"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();

-- The substitution mirrors ApprovedSubstitution: only the revocation stamp may change.
CREATE OR REPLACE FUNCTION phase4_t3_skill_substitution_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ApprovedSkillSubstitution rows are never deleted (revoke instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."requirementId" <> OLD."requirementId"
     OR NEW."fromFingerprint" <> OLD."fromFingerprint" OR NEW."toFingerprint" <> OLD."toFingerprint"
     OR NEW."reason" <> OLD."reason" OR NEW."approvedById" <> OLD."approvedById" OR NEW."at" <> OLD."at"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'ApprovedSkillSubstitution is append-only — only the revocation stamp may change (%)', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked ApprovedSkillSubstitution is terminal (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ApprovedSkillSubstitution_append_only" BEFORE UPDATE OR DELETE ON "ApprovedSkillSubstitution"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3_skill_substitution_append_only();

-- ── the effort fact's slice identity is BOUND to its allocation ────────────────────────────────
-- Effort can never name a worker/activity/slice different from the allocation it was performed
-- under (the §C "distinct facts, never a transfer" rule stays honest under a direct write).
CREATE OR REPLACE FUNCTION phase4_t3_work_matches_allocation() RETURNS trigger AS $$
DECLARE a RECORD;
BEGIN
  SELECT "workerId", "activityId", "civilDate", "shift" INTO a
  FROM "WorkerAllocation" WHERE "projectId" = NEW."projectId" AND "id" = NEW."allocationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LabourWorkFact % references a WorkerAllocation absent from its project', NEW."id";
  END IF;
  IF a."workerId" <> NEW."workerId" OR a."activityId" <> NEW."activityId"
     OR a."civilDate" <> NEW."civilDate" OR a."shift" <> NEW."shift" THEN
    RAISE EXCEPTION 'LabourWorkFact % must carry its allocation''s worker/activity/slice identity', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourWorkFact_matches_allocation" BEFORE INSERT ON "LabourWorkFact"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3_work_matches_allocation();

-- ── a worker is allocated ONLY inside its active window and while un-revoked (§H) ──────────────
CREATE OR REPLACE FUNCTION phase4_t3_allocation_worker_active() RETURNS trigger AS $$
DECLARE w RECORD;
BEGIN
  SELECT "activeFrom", "activeTo", "revokedAt" INTO w
  FROM "Worker" WHERE "projectId" = NEW."projectId" AND "id" = NEW."workerId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WorkerAllocation % references a Worker absent from its project', NEW."id";
  END IF;
  IF w."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'worker % is revoked and cannot be allocated', NEW."workerId";
  END IF;
  IF NEW."civilDate" < w."activeFrom" OR (w."activeTo" IS NOT NULL AND NEW."civilDate" > w."activeTo") THEN
    RAISE EXCEPTION 'worker % is not active on % (active % .. %)', NEW."workerId", NEW."civilDate", w."activeFrom", w."activeTo";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WorkerAllocation_worker_active" BEFORE INSERT ON "WorkerAllocation"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3_allocation_worker_active();

-- ── diagnostic-first close-out ────────────────────────────────────────────────────────────────
-- These tables are NEW, so a legacy database upgrades ROW-FREE by construction. Assert it rather
-- than assume it: a non-empty table here would mean the migration ran twice or over foreign data.
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM "WorkerAllocation")
       + (SELECT count(*) FROM "LabourAttendance")
       + (SELECT count(*) FROM "LabourWorkFact")
       + (SELECT count(*) FROM "ApprovedSkillSubstitution") INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'P4T3 ABORT: the §C time-capacity tables are newly created but hold % row(s) — refusing to seal over unexplained data', n;
  END IF;
END $$;
