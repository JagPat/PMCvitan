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

-- ══ FINDING 1 — the operator repair is non-destructive, and provably so ═══════════════════════
-- `docs/RUNBOOK.md §P4T3C2` used to tell the operator to disable `LabourAttendance_append_only` and
-- DELETE every blank-`manualReason` muster. That erases the original observation, its recorder, its
-- timestamps and its correction chain — while the trigger being disabled says in as many words that
-- attendance rows are never deleted. The sanctioned repair now MARKS and REVOKES instead (see
-- `src/labour/t3c/`), and the seals below are what make that repair honest rather than merely
-- documented.
--
-- The FUNCTION is created first and alone: creating it references nothing and enforces nothing, so
-- it is safe outside the sealed block below.
--
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

-- ══ DIAGNOSE AND SEAL — ONE STATEMENT, ONE TRANSACTION ════════════════════════════════════════
-- This migration has NO transaction wrapper: Prisma runs the file statement by statement, so every
-- statement boundary is a commit. Diagnosing in one statement and installing the guard in the next
-- therefore leaves a real window — after the diagnostic has passed and before the marker prefix is
-- reserved — in which a concurrent direct writer can insert a PRE-REVOKED marked row. The CHECK
-- added later accepts it (it is revoked), no diagnostic runs again, and the migration succeeds over
-- forged repair provenance: exactly the state this correction exists to make unreachable.
--
-- A single DO block is a single statement and therefore a single transaction. The ACCESS EXCLUSIVE
-- lock is taken FIRST, so the diagnostic reads a table no one else can be mid-write on, and it is
-- held until the seals are committed with it. There is no interval in which the check has passed
-- and the guard is not yet in place.
--
-- BOTH tables are locked, not just `LabourAttendance`. The finding-1 diagnostic READS
-- `T3CRepairAction`, so locking only the attendance table left the evidence free to change under it:
-- a concurrent DELETE committing after this statement's snapshot but before the evidence seal was
-- installed would leave the migration sealing a now-empty table and succeeding with a marked
-- attendance row whose before-image is gone. Evidence that can disappear between being checked and
-- being sealed was never checked.
DO $$
DECLARE bad BIGINT; sample TEXT; have_evidence BOOLEAN; tg pg_trigger%ROWTYPE; con pg_constraint%ROWTYPE;
BEGIN
  LOCK TABLE "LabourAttendance" IN ACCESS EXCLUSIVE MODE;
  have_evidence := to_regclass('"T3CRepairAction"') IS NOT NULL;
  IF have_evidence THEN
    LOCK TABLE "T3CRepairAction" IN ACCESS EXCLUSIVE MODE;
  END IF;

  -- Finding 1 — every pre-existing row carrying the RESERVED invalid-legacy marker must be a REAL
  -- audited repair: revoked, AND backed by a matching `T3CRepairAction` before-image.
  --
  -- Revocation alone is not enough. Until the reserving trigger below exists, a direct writer can
  -- insert a marked row with the revocation triple already populated; a revoked-only test would let
  -- it through, and from then on it would look permanently like an audited operator repair while no
  -- record of the "original bytes" it claims to preserve has ever existed. The marker's whole value
  -- is that it points at evidence, so the diagnostic demands the evidence.
  --
  -- `T3CRepairAction` is created BY the repair transaction, so its absence is decisive rather than
  -- inconvenient: no repair has ever run here, therefore no legitimate marker can exist.
  --
  -- There is no automatic repair for a row that fails this: only the operator repair
  -- (`pnpm --filter api t3c:repair`) may write this marker. A row in this state was forged, or a
  -- repair was interrupted outside its transaction. Either way a human must look at it.
  -- See docs/RUNBOOK.md §P4T3C3.
  -- The evidence must be for THAT row and THAT repair: every marker embeds `repair=<uuid>` right
  -- after the prefix (see `t3cInvalidLegacyMarker` / `T3C_MARKER_REPAIR_ID_REGEX`), and the matching
  -- `T3CRepairAction` row must name the same repair id. Without the id, "some repair once touched
  -- this row" would be all that could be established, and a forger holding one legitimate evidence
  -- row could mint any number of markers pointing at it.
  --
  -- And the before-image must be COMPLETE and CORRESPOND, not merely carry the right id. A
  -- two-field `{"id": …, "manualReason": " "}` records none of the observation it claims to
  -- preserve, so every immutable LabourAttendance column must be present AND equal to the marked
  -- row. Correspondence is meaningful because `phase4_t3_attendance_append_only` freezes exactly
  -- those columns: they cannot have drifted, so a mismatch means the evidence is about something
  -- else. `manualReason` is excluded from the equality — rewriting it is what the repair does — but
  -- its shape is checked per op, which is what tells a retirement's before-image from a
  -- quarantine's.
  IF have_evidence THEN
    SELECT COUNT(*), COALESCE(STRING_AGG(id, ', ' ORDER BY id), '')
      INTO bad, sample
      FROM (SELECT a."id" FROM "LabourAttendance" a
             WHERE a."manualReason" LIKE '[invalid-legacy:blank-manual-reason]%'
               AND (a."revokedAt" IS NULL
                    OR NOT EXISTS (SELECT 1 FROM "T3CRepairAction" r
                                    WHERE r."rowId" = a."id"
                                      AND r."table" = 'LabourAttendance'
                                      AND r."repairId" = substring(a."manualReason" from 'repair=([0-9a-fA-F-]{36})')
                                      -- the attribution must name someone and state something
                                      AND btrim(r."operator", E' \t\n\x0B\f\r') <> ''
                                      AND btrim(r."reason",   E' \t\n\x0B\f\r') <> ''
                                      -- the before-image must be COMPLETE …
                                      AND jsonb_exists(r."beforeImage", 'id')
                                      AND jsonb_exists(r."beforeImage", 'projectId')
                                      AND jsonb_exists(r."beforeImage", 'workerId')
                                      AND jsonb_exists(r."beforeImage", 'civilDate')
                                      AND jsonb_exists(r."beforeImage", 'shift')
                                      AND jsonb_exists(r."beforeImage", 'deviceId')
                                      AND jsonb_exists(r."beforeImage", 'evidenceMediaId')
                                      AND jsonb_exists(r."beforeImage", 'recordedAt')
                                      AND jsonb_exists(r."beforeImage", 'recordedById')
                                      AND jsonb_exists(r."beforeImage", 'sourceCommandId')
                                      -- … and CORRESPOND to the row it claims to be about
                                      AND r."beforeImage"->>'id'              = a."id"
                                      AND r."beforeImage"->>'projectId'       = a."projectId"
                                      AND r."beforeImage"->>'workerId'        = a."workerId"
                                      AND (r."beforeImage"->>'civilDate')::date = a."civilDate"
                                      AND r."beforeImage"->>'shift'           = a."shift"
                                      AND r."beforeImage"->>'deviceId'        IS NOT DISTINCT FROM a."deviceId"
                                      AND r."beforeImage"->>'evidenceMediaId' IS NOT DISTINCT FROM a."evidenceMediaId"
                                      AND (r."beforeImage"->>'recordedAt')::timestamptz = a."recordedAt"
                                      AND r."beforeImage"->>'recordedById'    = a."recordedById"
                                      AND r."beforeImage"->>'sourceCommandId' = a."sourceCommandId"
                                      AND (
                                        -- the before-image is the BLANK pre-repair row. It may
                                        -- already have been revoked: a legacy muster whose blank
                                        -- reason was revoked before correction 2 shipped is still a
                                        -- blank row the repair must be able to retire.
                                        (r."op" = 'f1-mark-invalid-legacy'
                                          AND r."beforeImage"->>'manualReason' IS NOT NULL
                                          AND btrim(r."beforeImage"->>'manualReason', E' \t\n\x0B\f\r') = '')
                                        OR
                                        (r."op" = 'f1-quarantine-forged-marker'
                                          AND r."beforeImage"->>'manualReason' LIKE '[invalid-legacy:blank-manual-reason]%')
                                      )))
             LIMIT 20) s;
  ELSE
    -- No evidence table ⇒ no repair has ever run here ⇒ no legitimate marker can exist.
    SELECT COUNT(*), COALESCE(STRING_AGG(id, ', ' ORDER BY id), '')
      INTO bad, sample
      FROM (SELECT a."id" FROM "LabourAttendance" a
             WHERE a."manualReason" LIKE '[invalid-legacy:blank-manual-reason]%'
             LIMIT 20) s;
  END IF;

  IF bad > 0 THEN
    RAISE EXCEPTION
      'phase4 t3 correction3 finding 1: % LabourAttendance row(s) carry the reserved invalid-legacy marker without being a real audited repair — not revoked, or with no matching T3CRepairAction before-image for the embedded repair id (sample: %). See docs/RUNBOOK.md §P4T3C3.', bad, sample;
  END IF;

  -- ── the tables are clean AND still locked; install the seals before anyone can write again ────
  --
  -- Objects are created ONLY IF ABSENT — never dropped and recreated. On a RETRY after a partial
  -- apply a DROP…CREATE pair would reopen the very window this block exists to close.
  --
  -- But "absent" is decided by VALIDITY, not by name. A same-named trigger that is DISABLED
  -- (`tgenabled <> 'O'`) or bound to some other function is a decoy: a name-only guard skips
  -- creation, Prisma records the migration applied, and the reserved marker is unprotected forever.
  -- An invalid same-named object is therefore an ABORT, not something to silently replace —
  -- replacing it would erase the evidence that someone put it there.
  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'LabourAttendance_reserved_marker'
     AND tgrelid = '"LabourAttendance"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "LabourAttendance_reserved_marker" BEFORE INSERT ON "LabourAttendance"
      FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_attendance_reserved_marker();
  ELSIF tg.tgenabled <> 'O' OR tg.tgfoid::regproc::text <> 'phase4_t3c3_attendance_reserved_marker' THEN
    RAISE EXCEPTION
      'phase4 t3 correction3: a trigger named LabourAttendance_reserved_manual already exists but does not enforce the reserved marker (enabled=%, function=%) — refusing to record this migration as applied over an unprotected table. See docs/RUNBOOK.md §P4T3C3.',
      tg.tgenabled, tg.tgfoid::regproc::text;
  END IF;

  -- (b) A MARKED ROW IS ALWAYS REVOKED. The repair sets the marker and the revocation triple in ONE
  --     statement, so this CHECK can never be transiently false for it; what the CHECK forbids is
  --     any other path leaving a marked row live (including a future edit that clears the
  --     revocation). Combined with the live partial unique on (project, worker, civilDate, shift),
  --     a genuine replacement muster is necessarily a SEPARATE, separately-attributable row.
  --     `convalidated` matters as much as existence: a CHECK added NOT VALID does not constrain the
  --     rows already present, so a table carrying it unvalidated is not sealed.
  SELECT * INTO con FROM pg_constraint
   WHERE conname = 'LabourAttendance_marker_is_revoked'
     AND conrelid = '"LabourAttendance"'::regclass;
  IF NOT FOUND THEN
    ALTER TABLE "LabourAttendance"
      ADD CONSTRAINT "LabourAttendance_marker_is_revoked"
      CHECK ("manualReason" IS NULL
          OR "manualReason" NOT LIKE '[invalid-legacy:blank-manual-reason]%'
          OR "revokedAt" IS NOT NULL);
  ELSIF con.contype <> 'c' OR NOT con.convalidated
        OR pg_get_constraintdef(con.oid) NOT LIKE '%invalid-legacy:blank-manual-reason%'
        OR pg_get_constraintdef(con.oid) NOT LIKE '%revokedAt%' THEN
    RAISE EXCEPTION
      'phase4 t3 correction3: a constraint named LabourAttendance_marker_is_revoked already exists but is not the validated marker-is-revoked CHECK (%) — refusing to record this migration as applied over an unprotected table. See docs/RUNBOOK.md §P4T3C3.',
      pg_get_constraintdef(con.oid);
  END IF;

  -- (c) THE EVIDENCE IS APPEND-ONLY, sealed HERE — inside the same locked transaction that just
  --     validated it. Sealing in a later statement left the evidence free to change in between: a
  --     concurrent DELETE committing after the diagnostic's snapshot would leave this migration
  --     sealing an empty table and succeeding with a marked row whose before-image is gone.
  --     `T3CRepairService` creates the table AND these seals together, but a database repaired
  --     before the seals existed carries unsealed rows, so they are re-asserted. Guarded on the
  --     table's existence: it is created by the repair, not by any migration, so on a database that
  --     never needed one there is simply nothing to seal.
  IF NOT have_evidence THEN RETURN; END IF;

  CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_append_only() RETURNS trigger AS $fn$
  BEGIN
    RAISE EXCEPTION 'T3CRepairAction is append-only — repair evidence is never updated or deleted (attempted % on row %)', TG_OP, COALESCE(OLD."id"::text, '<none>');
  END;
  $fn$ LANGUAGE plpgsql;

  -- TRUNCATE does not fire a row-level BEFORE UPDATE OR DELETE trigger; it is a separate,
  -- STATEMENT-level event. Without this second trigger the role that owns the evidence table can
  -- erase every before-image in one statement while the marked attendance rows go on claiming their
  -- originals are preserved here.
  CREATE OR REPLACE FUNCTION phase4_t3c_repair_action_no_truncate() RETURNS trigger AS $fn$
  BEGIN
    RAISE EXCEPTION 'T3CRepairAction is append-only — repair evidence is never truncated';
  END;
  $fn$ LANGUAGE plpgsql;

  SELECT * INTO tg FROM pg_trigger WHERE tgname = 'T3CRepairAction_append_only'
     AND tgrelid = '"T3CRepairAction"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "T3CRepairAction_append_only" BEFORE UPDATE OR DELETE ON "T3CRepairAction"
      FOR EACH ROW EXECUTE FUNCTION phase4_t3c_repair_action_append_only();
  ELSIF tg.tgenabled <> 'O' OR tg.tgfoid::regproc::text <> 'phase4_t3c_repair_action_append_only' THEN
    RAISE EXCEPTION
      'phase4 t3 correction3: T3CRepairAction_append_only exists but does not enforce append-only (enabled=%, function=%). See docs/RUNBOOK.md §P4T3C3.',
      tg.tgenabled, tg.tgfoid::regproc::text;
  END IF;
  SELECT * INTO tg FROM pg_trigger WHERE tgname = 'T3CRepairAction_no_truncate'
     AND tgrelid = '"T3CRepairAction"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "T3CRepairAction_no_truncate" BEFORE TRUNCATE ON "T3CRepairAction"
      FOR EACH STATEMENT EXECUTE FUNCTION phase4_t3c_repair_action_no_truncate();
  ELSIF tg.tgenabled <> 'O' OR tg.tgfoid::regproc::text <> 'phase4_t3c_repair_action_no_truncate' THEN
    RAISE EXCEPTION
      'phase4 t3 correction3: T3CRepairAction_no_truncate exists but does not enforce the truncate seal (enabled=%, function=%). See docs/RUNBOOK.md §P4T3C3.',
      tg.tgenabled, tg.tgfoid::regproc::text;
  END IF;

  -- (d) THE ATTRIBUTION SAYS SOMETHING. `operator` and `reason` are NOT NULL, and NOT NULL is
  --     satisfied by a space. Because the seals above make this table append-only, whitespace-only
  --     attribution becomes PERMANENT — a marked attendance row pointing at evidence that names
  --     nobody.
  --
  --     This must NEVER abort. An earlier draft raised over pre-existing blank rows, which was a
  --     trap: the evidence is append-only so the row cannot be edited away, the quarantine appends
  --     good evidence but preserves the bad action, and an ORPHAN malformed action (one no marker
  --     cites) blocked every deploy without even producing an F1.marker to explain itself. The rule
  --     is therefore installed NOT VALID when such rows exist — every FUTURE insert is rejected, the
  --     legacy rows stay exactly as written (they are the record that they were written), and
  --     nothing is blocked. On a clean table it is VALIDATED, the stronger claim. Either way the
  --     diagnostic above treats blank-attributed evidence as invalid, so a marker relying on one is
  --     an F1.marker with the quarantine as its exit.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'T3CRepairAction_attribution_non_blank'
                    AND conrelid = '"T3CRepairAction"'::regclass) THEN
    SELECT COUNT(*) INTO bad FROM "T3CRepairAction"
     WHERE btrim("operator", E' \t\n\x0B\f\r') = '' OR btrim("reason", E' \t\n\x0B\f\r') = '';
    IF bad > 0 THEN
      RAISE WARNING
        'phase4 t3 correction3: % legacy T3CRepairAction row(s) carry a blank operator or reason; the non-blank rule is installed NOT VALID so new evidence is constrained and the existing rows are preserved. See docs/RUNBOOK.md §P4T3C3.', bad;
      ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank"
        CHECK (btrim("operator", E' \t\n\x0B\f\r') <> '' AND btrim("reason", E' \t\n\x0B\f\r') <> '') NOT VALID;
    ELSE
      ALTER TABLE "T3CRepairAction" ADD CONSTRAINT "T3CRepairAction_attribution_non_blank"
        CHECK (btrim("operator", E' \t\n\x0B\f\r') <> '' AND btrim("reason", E' \t\n\x0B\f\r') <> '');
    END IF;
  END IF;
END $$;

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
-- Same rule as the attendance seals: a matching NAME is not enough. A disabled or decoy trigger here
-- would leave raw allocation batches deadlock-prone while Prisma recorded the migration applied.
DO $$
DECLARE tg pg_trigger%ROWTYPE;
BEGIN
  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'WorkerAllocation_00_project_lock'
     AND tgrelid = '"WorkerAllocation"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "WorkerAllocation_00_project_lock" BEFORE INSERT ON "WorkerAllocation"
      FOR EACH ROW EXECUTE FUNCTION phase4_t3c3_allocation_project_lock();
  ELSIF tg.tgenabled <> 'O' OR tg.tgfoid::regproc::text <> 'phase4_t3c3_allocation_project_lock' THEN
    RAISE EXCEPTION
      'phase4 t3 correction3: WorkerAllocation_00_project_lock exists but does not take the project readiness lock (enabled=%, function=%) — refusing to record this migration as applied. See docs/RUNBOOK.md §P4T3C3.',
      tg.tgenabled, tg.tgfoid::regproc::text;
  END IF;
END $$;

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
-- Every seal this migration is responsible for must be present AND ENFORCING before Prisma is
-- allowed to record it applied. The create-if-absent guards above already refuse to run past an
-- invalid same-named object; this is the independent restatement, so a future edit that loses one of
-- those guards fails the deploy loudly rather than silently shipping an unprotected database. It is
-- the same predicate `t3c seals` uses, which is what makes that command's answer trustworthy.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgname = 'LabourAttendance_reserved_marker' AND NOT t.tgisinternal
     AND t.tgrelid = '"LabourAttendance"'::regclass
     AND t.tgenabled = 'O' AND t.tgfoid::regproc::text = 'phase4_t3c3_attendance_reserved_marker';
  IF n <> 1 THEN
    RAISE EXCEPTION 'P4T3C3 ABORT: the reserved-marker trigger is not installed and enabled on LabourAttendance';
  END IF;

  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgname = 'WorkerAllocation_00_project_lock' AND NOT t.tgisinternal
     AND t.tgrelid = '"WorkerAllocation"'::regclass
     AND t.tgenabled = 'O' AND t.tgfoid::regproc::text = 'phase4_t3c3_allocation_project_lock';
  IF n <> 1 THEN
    RAISE EXCEPTION 'P4T3C3 ABORT: the allocation project-lock trigger is not installed and enabled on WorkerAllocation';
  END IF;

  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conname = 'LabourAttendance_marker_is_revoked'
     AND c.conrelid = '"LabourAttendance"'::regclass AND c.contype = 'c' AND c.convalidated;
  IF n <> 1 THEN
    RAISE EXCEPTION 'P4T3C3 ABORT: the marker-is-revoked CHECK is not installed and validated on LabourAttendance';
  END IF;
END $$;

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
