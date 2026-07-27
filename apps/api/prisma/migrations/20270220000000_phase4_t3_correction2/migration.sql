-- Phase 4 Task 3 CORRECTION 2 — the narrow re-review findings 1 and 3.
--
-- ADDITIVE and DIAGNOSTIC-FIRST. Both earlier migrations (`20270210000000_phase4_t3_time_capacity`
-- and `20270215000000_phase4_t3_correction`) are deployed and are left byte-for-byte unchanged; this
-- migration only tightens two seals they installed. It ABORTS on any pre-existing row that violates
-- the new rules rather than editing, blanking, or inventing data — the labour pilot has no rows, so
-- a legacy database upgrades cleanly; a dirty one stops with a named, bounded diagnostic.

-- ══ DIAGNOSTICS ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  -- Finding 1 — a whitespace-only manual reason satisfies IS NOT NULL while saying nothing. There
  -- is no correct automatic repair: only the person who recorded the muster knows why there was no
  -- device, so an operator must revoke the row (a correction, never a delete) and re-record it.
  SELECT COUNT(*), COALESCE(STRING_AGG(id, ', ' ORDER BY id), '')
    INTO bad, sample
    FROM (SELECT "id" FROM "LabourAttendance"
           WHERE "manualReason" IS NOT NULL AND btrim("manualReason", E' \t\n\x0B\f\r') = '' LIMIT 20) s;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'phase4 t3 correction2 finding 1: % LabourAttendance row(s) carry a blank manualReason (sample: %). A blank reason is not a reason — revoke and re-record each muster with its real justification, then redeploy. See docs/RUNBOOK.md §P4T3C2.', bad, sample;
  END IF;
END $$;

-- ══ FINDING 1 — the manual muster's justification is part of the observation ═══════════════════
-- `manualReason` was added by 20270215000000 as the EXPLICIT, attributable alternative to device
-- evidence. Two holes remained: (a) the append-only trigger installed by 20270210000000 freezes an
-- explicit column list written before the column existed, so the one field carrying the entire
-- justification for an unevidenced presence claim was freely rewritable after the fact; and (b)
-- nothing rejected a blank string, which satisfies `LabourAttendance_trusted_evidence` while
-- asserting nothing. Both make an unsupported claim invisible again — the exact condition the
-- correction exists to prevent.

-- NOTE on the trim set: PostgreSQL's single-argument `btrim(text)` strips SPACES ONLY, so a reason
-- of one tab or one newline would satisfy `btrim(x) <> ''` and pass. That is the same empty claim
-- wearing different bytes, so the character set is given explicitly. This is deliberately stricter
-- than "btrim(manualReason) = ''" read literally, and it is the rule the finding actually asks for.
-- The set is the COMPLETE ASCII whitespace class — space, tab, newline, VERTICAL TAB, FORM FEED,
-- carriage return. Vertical tab and form feed are easy to omit (an earlier draft did, and a review
-- caught it): they are rare from a keyboard but perfectly reachable through an import or a raw
-- write, which is exactly the path this constraint exists to police.
ALTER TABLE "LabourAttendance"
  ADD CONSTRAINT "LabourAttendance_manual_reason_non_blank"
  CHECK ("manualReason" IS NULL OR btrim("manualReason", E' \t\n\x0B\f\r') <> '');

-- Same function name, same trigger: `manualReason` joins the frozen identity/evidence set. The ONE
-- permitted mutation is unchanged — a single revocation stamp (revokedAt/revokedBy/revokeReason) on
-- a not-yet-revoked row. A revoked muster stays terminal, and the original reason survives verbatim
-- because history without its justification is not history.
CREATE OR REPLACE FUNCTION phase4_t3_attendance_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourAttendance rows are never deleted (revoke the attendance instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."workerId" <> OLD."workerId"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."deviceId" IS DISTINCT FROM OLD."deviceId"
     OR NEW."manualReason" IS DISTINCT FROM OLD."manualReason"
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

-- ══ FINDING 3 — cancellation and allocation serialize on the SAME row ═════════════════════════
-- `RequirementsService.revise/cancel` serialize on the `ActivityRequirementRoot` row (`lockRootHead`
-- takes it FOR UPDATE). The allocation guard installed by 20270215000000 read the current head with
-- a PLAIN SELECT and took no lock at all, so the two writers were mutually blind: under READ
-- COMMITTED a cancel could not see an uncommitted allocation and the allocation could not see an
-- uncommitted cancellation, and BOTH committed — leaving a cancelled requirement carrying an active
-- allocation, which is exactly the incoherent state Task 4 would read as Team-gate truth.
--
-- Taking the SAME root lock inside the trigger makes the two paths serialize on one row, wherever
-- the write comes from: a raw INSERT that bypasses the service still cannot skip its own trigger.
-- Whoever reaches the root first wins; the second blocks, then re-reads a head it can actually
-- trust. Lock BEFORE read — the row lock is what makes the status below authoritative rather than a
-- snapshot that may already be stale.
CREATE OR REPLACE FUNCTION phase4_t3c_allocation_head_live() RETURNS trigger AS $$
DECLARE head_status TEXT; root_id TEXT;
BEGIN
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
