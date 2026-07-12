-- Phase 0 Task 6: real civil dates. Additive nullable columns, then a
-- deterministic backfill from the legacy display strings / day-offsets.
-- The migration ABORTS on any unparseable non-empty value — it never
-- substitutes today's date or silently skips a row.

-- ── Columns (all nullable/additive; legacy fields stay for compatibility)
ALTER TABLE "Project"    ADD COLUMN "scheduleStartDate" DATE,
                         ADD COLUMN "scheduleEndDate"   DATE,
                         ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE "Activity"   ADD COLUMN "plannedStartDate" DATE,
                         ADD COLUMN "plannedEndDate"   DATE,
                         ADD COLUMN "actualStartDate"  DATE,
                         ADD COLUMN "actualEndDate"    DATE;
ALTER TABLE "Phase"      ADD COLUMN "plannedStartDate" DATE,
                         ADD COLUMN "plannedEndDate"   DATE;
ALTER TABLE "DailyLog"   ADD COLUMN "logDate" DATE;
ALTER TABLE "Inspection" ADD COLUMN "inspectionDate" DATE;

-- ── Diagnostics: every non-empty display date must be parseable 'DD Mon YYYY'.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "Project" WHERE "projStart" <> '' AND "projStart" !~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
  IF n > 0 THEN RAISE EXCEPTION 'phase0_real_dates: % Project.projStart value(s) unparseable — fix by hand before migrating', n; END IF;
  SELECT count(*) INTO n FROM "Project" WHERE "projEnd" <> '' AND "projEnd" !~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
  IF n > 0 THEN RAISE EXCEPTION 'phase0_real_dates: % Project.projEnd value(s) unparseable', n; END IF;
  SELECT count(*) INTO n FROM "DailyLog" WHERE "date" <> '' AND "date" !~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
  IF n > 0 THEN RAISE EXCEPTION 'phase0_real_dates: % DailyLog.date value(s) unparseable', n; END IF;
  -- Inspection display dates are looser in the demo ("12 Jun" without a year is
  -- possible in old seeds) — only strict 'DD Mon YYYY' values are backfilled;
  -- anything else stays NULL-dated (display string remains) rather than guessed.
END $$;

-- ── Backfill: Project schedule window from the display strings.
UPDATE "Project" SET "scheduleStartDate" = to_date("projStart", 'DD Mon YYYY')
  WHERE "projStart" ~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
UPDATE "Project" SET "scheduleEndDate" = to_date("projEnd", 'DD Mon YYYY')
  WHERE "projEnd" ~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';

-- The SEEDED demo project's schedule anchor is NOT its projStart: every legacy
-- day-offset is anchored at the prototype's DAY0 = 1 Jun 2026 (characterization:
-- dayLabel(0) === '1 Jun', dayLabel(32) === '3 Jul' — see format.test.ts).
-- Backfilling offsets against projStart (12 Jan 2026) would move every seeded
-- activity ~140 days and contradict every displayed label. scheduleStartDate is
-- defined as THE SCHEDULE ANCHOR (the day offset 0 refers to), so for the demo
-- project it is corrected to DAY0. New projects set it at creation.
UPDATE "Project" SET "scheduleStartDate" = DATE '2026-06-01' WHERE "id" = 'ambli';

-- ── Backfill: Activity/Phase civil dates = project schedule anchor + legacy offset
-- (offset 0 IS the anchor day — pinned by the characterization test).
UPDATE "Activity" a SET
  "plannedStartDate" = p."scheduleStartDate" + a."plannedStart",
  "plannedEndDate"   = p."scheduleStartDate" + a."plannedEnd",
  "actualStartDate"  = CASE WHEN a."actualStart" IS NULL THEN NULL ELSE p."scheduleStartDate" + a."actualStart" END,
  "actualEndDate"    = CASE WHEN a."actualEnd"   IS NULL THEN NULL ELSE p."scheduleStartDate" + a."actualEnd"   END
FROM "Project" p
WHERE p."id" = a."projectId" AND p."scheduleStartDate" IS NOT NULL;

UPDATE "Phase" ph SET
  "plannedStartDate" = p."scheduleStartDate" + ph."plannedStart",
  "plannedEndDate"   = p."scheduleStartDate" + ph."plannedEnd"
FROM "Project" p
WHERE p."id" = ph."projectId" AND p."scheduleStartDate" IS NOT NULL;

-- ── Backfill: DailyLog.logDate from its display date (strictly parseable rows
-- were verified above); createdAt (PR #78) stays the immutable creation instant
-- and is only the tie-breaker after logDate.
UPDATE "DailyLog" SET "logDate" = to_date("date", 'DD Mon YYYY')
  WHERE "date" ~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';

-- ── Backfill: Inspection.inspectionDate for strictly-parseable display dates.
UPDATE "Inspection" SET "inspectionDate" = to_date("date", 'DD Mon YYYY')
  WHERE "date" ~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
