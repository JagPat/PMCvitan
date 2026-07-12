-- DailyLog.createdAt: a real creation instant so "latest log" never relies on a
-- lexical sort of the display-string date ("03 Jul 2026" < "28 Jun 2026").
ALTER TABLE "DailyLog" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows from their display date (all app-written rows are
-- "DD Mon YYYY"), so pre-existing logs keep their true relative order instead of
-- collapsing onto the migration instant. Rows in any other shape keep the default.
UPDATE "DailyLog"
SET "createdAt" = to_timestamp("date", 'DD Mon YYYY')
WHERE "date" ~ '^[0-9]{2} [A-Za-z]{3} [0-9]{4}$';
