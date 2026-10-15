-- #482 site photos (board, 14 Oct 2026): the day's photo count is every member's progress photos filed on that log
-- (Media.dailyLogId), including ones added after the log is sent. A log's photos from before photos were filed on
-- their log are not Media rows filed on it, so the count also needs the number of those: `legacyPhotos`.
--
-- One rule sets it, at two moments: GREATEST(0, progress - progress photos filed on the log). The stored `progress`
-- is the count the sender saw, so what it holds beyond the filed photos is legacy.
--   1. The backfill, once, for every log already in the database.
--   2. The send (a log turning `submitted`), by the trigger below. A previous-release app still open with an
--      offline draft from before #927 replays its photo uploads without a log and then sends; `submit` writes only
--      `progress`, so without this its unfiled photos would drop out of the day's count. A current app's queued
--      uploads replay before its send (the outbox replays in order), so its photos are filed by then and add 0.
--
-- Frozen otherwise (evidence integrity): no writer may change a log's `legacyPhotos` except that send, and only while
-- it is still 0. Every new log starts at 0 (inserts are initialization).
--
-- Re-runnable, and on migrate.sh's ALWAYS_EXECUTE list: a `prisma db push` baseline has the column from
-- schema.prisma but neither the CHECK, the backfill nor the trigger. The backfill is guarded on the CHECK, which it
-- adds in the same step, so it runs exactly once on either path and a replay never recomputes a value.
ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "legacyPhotos" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"DailyLog"'::regclass AND conname = 'DailyLog_legacyPhotos_nonnegative'
  ) THEN
    -- Filed photos counted once per log, then joined (not a per-log scan of the project's photos).
    UPDATE "DailyLog" SET "legacyPhotos" = GREATEST(0, "progress") WHERE "legacyPhotos" <> GREATEST(0, "progress");
    UPDATE "DailyLog" d
    SET "legacyPhotos" = GREATEST(0, d."progress" - f.n)
    FROM (
      SELECT "projectId", "dailyLogId", count(*)::int AS n FROM "Media"
      WHERE "kind" = 'progress' AND "dailyLogId" IS NOT NULL
      GROUP BY "projectId", "dailyLogId"
    ) f
    WHERE f."projectId" = d."projectId" AND f."dailyLogId" = d."id" AND d."progress" > 0;
    ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_legacyPhotos_nonnegative" CHECK ("legacyPhotos" >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION daily_log_legacy_photos_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $frozen$
BEGIN
  IF NOT OLD."submitted" AND NEW."submitted" AND OLD."legacyPhotos" = 0 THEN
    NEW."legacyPhotos" := GREATEST(0, NEW."progress" - (
      SELECT count(*)::int FROM "Media" m
      WHERE m."projectId" = NEW."projectId" AND m."dailyLogId" = NEW."id" AND m."kind" = 'progress'
    ));
  ELSIF NEW."legacyPhotos" IS DISTINCT FROM OLD."legacyPhotos" THEN
    RAISE EXCEPTION
      'DailyLog.legacyPhotos is frozen: % cannot become % (daily log %). It is set only by the backfill and by the log''s send.',
      OLD."legacyPhotos", NEW."legacyPhotos", OLD."id";
  END IF;
  RETURN NEW;
END;
$frozen$;

DROP TRIGGER IF EXISTS "DailyLog_legacyPhotos_frozen" ON "DailyLog";
CREATE TRIGGER "DailyLog_legacyPhotos_frozen"
  BEFORE UPDATE ON "DailyLog"
  FOR EACH ROW EXECUTE FUNCTION daily_log_legacy_photos_frozen();
