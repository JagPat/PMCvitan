-- Phase 3 Task 6 correction (F2) — one ACTIVE substitution per material pair.
--
-- An `ApprovedSubstitution` widens a requirement's acceptable fingerprints while it is active
-- (`revokedAt IS NULL`). The merged Task 6 allowed a SECOND active row for the identical
-- (projectId, requirementId, fromFingerprint, toFingerprint), so a concurrent duplicate approval
-- created two authorizations and revoking one left the other in force. This partial unique index
-- makes a second ACTIVE row for the same pair unrepresentable at PostgreSQL; a revoked row
-- (revokedAt set) is excluded, so it survives as history AND re-approval after revocation is
-- allowed. `ApprovedSubstitution` is a Task-6, pilot-only table, so a real database holds no rows
-- here — but stay diagnostic-first: abort with a clear message if any pre-existing duplicate active
-- pair would violate the index (never silently drop data).

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1
    FROM "ApprovedSubstitution"
    WHERE "revokedAt" IS NULL
    GROUP BY "projectId", "requirementId", "fromFingerprint", "toFingerprint"
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Phase 3 T6 correction: % duplicate ACTIVE substitution pair(s) exist — revoke the extras before applying the unique index (never guessed here)', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "ApprovedSubstitution_active_pair_key"
  ON "ApprovedSubstitution" ("projectId", "requirementId", "fromFingerprint", "toFingerprint")
  WHERE "revokedAt" IS NULL;
