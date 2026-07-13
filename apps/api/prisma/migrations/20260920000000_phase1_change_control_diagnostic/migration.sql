-- Phase 1 gate remediation (finding 1 + finding 6) — additive, diagnostic-first.
--
-- Finding 1: the deployed change-control migration diagnosed only decisions with
-- MORE than one would-be-open request, so a 'change' decision with ZERO open
-- requests survived and could be falsely "re-approved". This FORWARD migration
-- (the deployed one is history and is not edited) closes the gap: every decision
-- in 'change' must have EXACTLY ONE open request. Anything else is ambiguous
-- legacy state an operator must resolve by hand — the migration ABORTS, it never
-- guesses (reopen the request, withdraw the reopening, or resolve duplicates).
--
-- Finding 6: role-at-action columns. resolveActor computes the caller's role but
-- Task 2 discarded it; the approved plan requires actor id + display name + ROLE
-- on every new mutation. Historical rows stay null — a later membership lookup
-- cannot reconstruct the authority held at action time, so we never backfill.

DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT d."id"
    FROM "Decision" d
    LEFT JOIN "ChangeRequest" cr ON cr."decisionId" = d."id" AND cr."status" = 'open'
    WHERE d."status" = 'change'
    GROUP BY d."id"
    HAVING count(cr."id") <> 1
  ) inconsistent;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase1_change_control_diagnostic: % change decision(s) do not have exactly one open change request — resolve by hand before migrating', bad;
  END IF;
END $$;

-- AlterTable: role held at action time (never backfilled — see header)
ALTER TABLE "DecisionEvent" ADD COLUMN "actorRole" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "actorRole" TEXT;
