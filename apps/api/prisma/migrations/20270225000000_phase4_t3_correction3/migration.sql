-- Phase 4 Task 3 CORRECTION 3 — the post-merge review findings 1 and 3.
--
-- ADDITIVE and DIAGNOSTIC-FIRST. Every earlier migration is deployed and is left byte-for-byte
-- unchanged (`20270210000000_phase4_t3_time_capacity`, `20270215000000_phase4_t3_correction`,
-- `20270220000000_phase4_t3_correction2`); this migration only adds seals they did not have. It
-- ABORTS on any pre-existing row that violates the new rules rather than editing, blanking or
-- inventing data — the labour pilot has no rows, so a legacy database upgrades cleanly and a dirty
-- one stops with a named, bounded diagnostic.
--
-- Finding 2 (Labour reading an Activities-owned table directly) is a SOURCE boundary defect: it is
-- fixed by moving the `ActivityRequirementRoot` lock into `ActivityParticipant.labourRequirementHead`
-- and is enforced by the boundary analyzer's new raw-SQL read detection. No SQL is required for it,
-- and none is invented here.

-- ══ DIAGNOSTICS ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  -- Finding 1 — a muster carrying the RESERVED invalid-legacy marker must ALSO be revoked. The
  -- marker means "an operator retired this record because its original justification was blank";
  -- a marked row that is still live would be exactly the unevidenced presence claim the whole
  -- correction exists to prevent, now wearing a marker that LOOKS like an explanation.
  --
  -- There is no automatic repair, because there is nothing to repair FROM: only the operator repair
  -- (`pnpm --filter api t3c:repair`) may write this marker, and it always writes the revocation in
  -- the same statement. A row in this state means the marker was forged or a repair was interrupted
  -- outside its transaction; either way an operator must look at it. See docs/RUNBOOK.md §P4T3C3.
  SELECT COUNT(*), COALESCE(STRING_AGG(id, ', ' ORDER BY id), '')
    INTO bad, sample
    FROM (SELECT "id" FROM "LabourAttendance"
           WHERE "manualReason" LIKE '[invalid-legacy:blank-manual-reason]%'
             AND "revokedAt" IS NULL LIMIT 20) s;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'phase4 t3 correction3 finding 1: % LabourAttendance row(s) carry the reserved invalid-legacy marker but are NOT revoked (sample: %). A repaired muster must never contribute active presence. See docs/RUNBOOK.md §P4T3C3.', bad, sample;
  END IF;
END $$;

-- ══ FINDING 1 — the operator repair is non-destructive, and provably so ═══════════════════════
-- `docs/RUNBOOK.md §P4T3C2` used to tell the operator to disable `LabourAttendance_append_only` and
-- DELETE every blank-`manualReason` muster. That erases the original observation, its recorder, its
-- timestamps and its correction chain — while the trigger being disabled says in as many words that
-- attendance rows are never deleted. The sanctioned repair now MARKS and REVOKES instead (see
-- `src/labour/t3c/`), and these two seals are what make that repair honest rather than merely
-- documented.

-- (a) THE MARKER IS RESERVED. Only the repair may write it, and the repair only ever UPDATEs an
--     existing row. An ordinary INSERT — a pmc recording a manual muster through the API, or any
--     direct write — can never claim to be a repaired legacy record. Without this, a caller could
--     type the marker into `manualReason` and manufacture something that reads like operator
--     provenance. A BEFORE INSERT trigger (not a CHECK) is used deliberately: a CHECK would also
--     fire on the repair's own UPDATE and make the repair impossible.
CREATE OR REPLACE FUNCTION phase4_t3c3_attendance_reserved_marker() RETURNS trigger AS $$
BEGIN
  IF NEW."manualReason" IS NOT NULL AND NEW."manualReason" LIKE '[invalid-legacy:blank-manual-reason]%' THEN
    RAISE EXCEPTION 'the invalid-legacy marker is RESERVED for the audited operator repair (t3c:repair) and can never be a recorded manual reason (%)', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourAttendance_reserved_marker" BEFORE INSERT ON "LabourAttendance"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_attendance_reserved_marker();

-- (b) A MARKED ROW IS ALWAYS REVOKED. The repair sets the marker and the revocation triple in ONE
--     statement, so this CHECK can never be transiently false for it; what the CHECK forbids is any
--     other path leaving a marked row live (including a future edit that clears the revocation).
--     Combined with the live partial unique on (project, worker, civilDate, shift), a genuine
--     replacement muster is necessarily a SEPARATE, separately-attributable row.
ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
  CHECK ("manualReason" IS NULL
      OR "manualReason" NOT LIKE '[invalid-legacy:blank-manual-reason]%'
      OR "revokedAt" IS NOT NULL);

-- ══ FINDING 3 — a raw allocation batch takes the PROJECT lock before any row lock ═════════════
-- `WorkerAllocation_head_live` locks the requirement root FOR UPDATE, per inserted row, in the order
-- the rows arrive. A CANONICAL allocation is safe: `LabourCapacityService.allocate` takes
-- `lockProjectReadiness` as the first statement of its transaction, so two canonical commands on one
-- project serialize before either touches a root. A RAW multi-row insert has no such preamble, so
-- two same-project batches ordered `(A,B)` and `(B,A)` each take one root and then wait for the
-- other — a genuine cycle PostgreSQL breaks by aborting one otherwise-valid transaction with 40P01.
--
-- The fix is to give the raw path the SAME preamble, from inside the database: acquire the per-project
-- readiness advisory transaction lock — the identical key `lockProjectReadiness` computes,
-- `hashtextextended('readiness:' || projectId, 0)` — BEFORE any requirement-root or commitment row
-- lock. Two same-project batches then serialize at the project lock: the second waits, the first
-- completes, and every non-conflicting row commits. `pg_advisory_xact_lock` is re-entrant, so a
-- canonical command that already holds it pays nothing and behaves exactly as before, and the lock
-- is released automatically at COMMIT/ROLLBACK.
--
-- SCOPE, stated honestly: this serializes same-PROJECT writers, which is what the readiness protocol
-- is and what the finding asks for. A single raw statement spanning TWO projects in opposite order
-- could still interleave its two advisory acquisitions — that is equally true of the canonical path
-- (one command is one project) and is out of scope here; no claim is made about it.
CREATE OR REPLACE FUNCTION phase4_t3c3_allocation_project_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('readiness:' || NEW."projectId", 0));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The name is chosen so PostgreSQL fires it FIRST: BEFORE-row triggers run in alphabetical order by
-- trigger name, and `WorkerAllocation_00_…` precedes `WorkerAllocation_head_live`,
-- `WorkerAllocation_within_commitment` and `WorkerAllocation_worker_active`. The DO block below
-- VERIFIES that in this database's own collation rather than trusting the assumption.
CREATE TRIGGER "WorkerAllocation_00_project_lock" BEFORE INSERT ON "WorkerAllocation"
  FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_allocation_project_lock();

-- Belt AND braces: the same acquisition opens `phase4_t3c_allocation_head_live`, the trigger that
-- takes the first ROW lock. Even if a future trigger were somehow ordered ahead of
-- `WorkerAllocation_00_project_lock`, the project lock is still held before the root is touched.
-- Everything below this line is `20270220000000`'s function verbatim; only the PERFORM is added.
CREATE OR REPLACE FUNCTION phase4_t3c_allocation_head_live() RETURNS trigger AS $$
DECLARE head_status TEXT; root_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('readiness:' || NEW."projectId", 0));
  SELECT r."id" INTO root_id
    FROM "ActivityRequirementRoot" r
   WHERE r."projectId" = NEW."projectId" AND r."id" = NEW."requirementId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WorkerAllocation % references a requirement absent from its project', NEW."id";
  END IF;
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

-- ══ POST-CONDITIONS ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE first_trigger TEXT;
BEGIN
  -- The project lock must be the FIRST BEFORE-INSERT trigger PostgreSQL fires on WorkerAllocation,
  -- evaluated in THIS database's collation (the same ordering the executor uses). If a future
  -- migration adds a trigger that sorts ahead of it, this fails the deploy loudly instead of
  -- silently re-opening the deadlock window.
  SELECT t.tgname INTO first_trigger
    FROM pg_trigger t
   WHERE t.tgrelid = '"WorkerAllocation"'::regclass
     AND NOT t.tgisinternal
     AND (t.tgtype & 4) <> 0   -- fires on INSERT
     AND (t.tgtype & 2) <> 0   -- BEFORE
   ORDER BY t.tgname
   LIMIT 1;
  IF first_trigger IS DISTINCT FROM 'WorkerAllocation_00_project_lock' THEN
    RAISE EXCEPTION 'P4T3C3 ABORT: the first BEFORE INSERT trigger on WorkerAllocation is % — the project readiness lock must fire before any row lock', COALESCE(first_trigger, '<none>');
  END IF;
END $$;
