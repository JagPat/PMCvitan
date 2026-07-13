-- Phase 1 Task 5 — closing sign-off controls activity completion (additive,
-- diagnostic-first). Timestamped AFTER 20260930000000_phase1_inspection_evidence
-- per the gate re-review instruction; the plan's original 20260925 slot was
-- taken by the drawing-governing remediation migration.
--
-- Adds the completion CLAIM (who said the work was finished — an attributable,
-- membership-validated fact), the sign-off day (`doneAt`), the `awaiting_signoff`
-- status, and the UNAMBIGUOUS `closing` marker on inspections (the legacy
-- INSP-<activityId>-close id pattern is retired as a linkage mechanism).
--
-- DIAGNOSTICS FIRST — the migration ABORTS (never guesses) when the legacy id
-- pattern is ambiguous or crosses a project boundary. Legacy `done` activities
-- STAY `done`: this migration writes no Activity.status value at all.

DO $$
DECLARE
  foreign_closers integer;
  ambiguous_closers integer;
  conflicting_closers integer;
BEGIN
  -- STOP: an INSP-*-close id whose named activity lives in ANOTHER project —
  -- auto-linking would cross a tenant boundary; resolve by hand first.
  SELECT count(*) INTO foreign_closers
  FROM "Inspection" i
  JOIN "Activity" a ON i."id" = 'INSP-' || a."id" || '-close'
  WHERE a."projectId" <> i."projectId";
  IF foreign_closers > 0 THEN
    RAISE EXCEPTION 'phase1_closing_signoff: % legacy INSP-*-close id(s) name an activity in ANOTHER project — resolve by hand before migrating', foreign_closers;
  END IF;

  -- STOP: an INSP-*-close id matching MORE THAN ONE activity. Activity ids are
  -- primary keys, so this cannot happen under exact-id matching — asserted anyway
  -- so a future loosening of the match rule can never auto-link ambiguously.
  SELECT count(*) INTO ambiguous_closers
  FROM (
    SELECT i."id"
    FROM "Inspection" i
    JOIN "Activity" a ON i."id" = 'INSP-' || a."id" || '-close'
    GROUP BY i."id" HAVING count(*) > 1
  ) dup;
  IF ambiguous_closers > 0 THEN
    RAISE EXCEPTION 'phase1_closing_signoff: % legacy INSP-*-close id(s) match multiple activities — resolve by hand before migrating', ambiguous_closers;
  END IF;

  -- STOP: an INSP-*-close inspection that ALREADY carries a Task 4 activityId
  -- DISAGREEING with its id pattern — two conflicting linkage claims is ambiguity.
  SELECT count(*) INTO conflicting_closers
  FROM "Inspection" i
  JOIN "Activity" a ON i."id" = 'INSP-' || a."id" || '-close' AND a."projectId" = i."projectId"
  WHERE i."activityId" IS NOT NULL AND i."activityId" <> a."id";
  IF conflicting_closers > 0 THEN
    RAISE EXCEPTION 'phase1_closing_signoff: % legacy INSP-*-close row(s) already carry a DIFFERENT activityId than their id pattern names — resolve by hand before migrating', conflicting_closers;
  END IF;
END $$;

-- AlterEnum: the claim state between "engineer says finished" and "PMC accepts".
-- (Added, never used, in this migration — no row is moved into it here.)
ALTER TYPE "ActivityStatus" ADD VALUE 'awaiting_signoff';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "completionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "completionRequestedById" TEXT,
ADD COLUMN     "completionRequestedByName" TEXT,
ADD COLUMN     "doneAt" DATE;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "closing" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey: a completion claim must name a member of THIS project
-- (memberships are soft-removed, never deleted — NO ACTION is safe)
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_completionRequestedById_fkey" FOREIGN KEY ("projectId", "completionRequestedById") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Backfill: mark + link legacy closing inspections from the deterministic id
-- pattern, ONLY where exactly one same-project activity matches (the diagnostics
-- above have already aborted on every ambiguous or foreign case). Activity rows
-- are NOT touched — legacy `done` stays `done`, no retroactive reopening.
UPDATE "Inspection" i
SET "closing" = true, "activityId" = a."id"
FROM "Activity" a
WHERE i."id" = 'INSP-' || a."id" || '-close'
  AND a."projectId" = i."projectId";

-- Report what was linked and what was left alone (informational).
DO $$
DECLARE
  linked integer;
  unlinked integer;
BEGIN
  SELECT count(*) INTO linked FROM "Inspection" WHERE "closing" = true;
  SELECT count(*) INTO unlinked FROM "Inspection" i
  WHERE i."id" LIKE 'INSP-%-close' AND i."closing" = false;
  RAISE NOTICE 'phase1_closing_signoff: % legacy closing inspection(s) marked+linked; % INSP-*-close id(s) match no activity and were left unmarked (they cannot govern any activity)', linked, unlinked;
END $$;
