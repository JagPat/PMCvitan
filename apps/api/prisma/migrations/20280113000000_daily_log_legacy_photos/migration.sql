-- #482 site photos (board, 14 Oct 2026): the day's photo count is every member's progress photos filed on that log
-- (Media.dailyLogId), including ones added after the log is sent. A log's photos from before photos were filed on
-- their log are not Media rows filed on it, so the count also needs the number of those: `legacyPhotos`.
--
-- Backfill, once, in the same step as the column (so a re-run never recomputes it): the stored `progress` is the
-- count the sender saw (0 until the send), and the photos already filed on the log are counted live, so the rest
-- is legacy: GREATEST(0, progress - filed progress photos). Every new log starts at 0: its photos are filed on it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'DailyLog' AND column_name = 'legacyPhotos'
  ) THEN
    ALTER TABLE "DailyLog" ADD COLUMN "legacyPhotos" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_legacyPhotos_nonnegative" CHECK ("legacyPhotos" >= 0);
    UPDATE "DailyLog" d
    SET "legacyPhotos" = GREATEST(0, d."progress" - (
      SELECT count(*)::int FROM "Media" m
      WHERE m."projectId" = d."projectId" AND m."dailyLogId" = d."id" AND m."kind" = 'progress'
    ));
  END IF;
END $$;
