-- #482 site photos (board, 14 Oct 2026): the day's photo count is every member's progress photos filed on that log
-- (Media.dailyLogId), including ones added after the log is sent. A sent log's photos from before photos were filed
-- on their log are not Media rows filed on it, so the count also needs the number of those: `legacyPhotos`.
--
-- Backfill, once, for SENT logs only: their stored `progress` is the count the sender saw, so what it holds beyond the
-- progress photos filed on the log BY THAT SEND is legacy: GREATEST(0, progress - filed before the send). "Before" is
-- the project's event order (streamPosition, never occurredAt): a photo whose `media.uploaded` event comes after the
-- log's latest `dailylog.submitted` (the send whose `progress` is stored) was added after it and is not subtracted. A
-- photo or a log with no such event keeps the plain rule (subtracted), so the count can fall short but never doubles.
-- The app's outbox replays a log's queued photos before its queued send (one FIFO queue that stops at the first
-- transient failure), and an online photo joins `progress` only once its upload has returned, so every photo in a
-- sender's count was filed before the send's event. An open log has not been sent, so its
-- `progress` is no sender's count; it stays 0. Nothing writes the column after this backfill: the day's count (the next
-- unit) is max(progress, legacyPhotos + filed), so a log a previous-release app sends later, with log-less photos,
-- still counts them through its `progress`.
--
-- Frozen: after insert the column never changes (evidence integrity). The trigger compares only the row's own
-- column. Inserts are initialization (0 by default; fixtures and seeds set it there).
--
-- Atomic and re-runnable: the function is created first (it is inert until a trigger names it); everything else is
-- ONE statement, so no writer passes between the backfill and the freeze. The backfill is guarded on the CHECK it
-- adds, so a `prisma db push` baseline (the column without the CHECK) gets it once and a replay never recomputes a
-- value. On migrate.sh's ALWAYS_EXECUTE list.
CREATE OR REPLACE FUNCTION daily_log_legacy_photos_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $frozen$
BEGIN
  IF NEW."legacyPhotos" IS DISTINCT FROM OLD."legacyPhotos" THEN
    RAISE EXCEPTION
      'DailyLog.legacyPhotos is frozen: % cannot become % (daily log %). It is set when the log is created, or by its migration''s backfill.',
      OLD."legacyPhotos", NEW."legacyPhotos", OLD."id";
  END IF;
  RETURN NEW;
END;
$frozen$;

DO $$
BEGIN
  LOCK TABLE "DailyLog" IN SHARE ROW EXCLUSIVE MODE;
  ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "legacyPhotos" INTEGER NOT NULL DEFAULT 0;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"DailyLog"'::regclass AND conname = 'DailyLog_legacyPhotos_nonnegative'
  ) THEN
    -- the freeze is (re)installed below, after the backfill, in this same statement
    DROP TRIGGER IF EXISTS "DailyLog_legacyPhotos_frozen" ON "DailyLog";
    -- every log to 0, then sent logs to their unfiled count; the photos filed before each log's latest send are
    -- counted once per log and joined
    UPDATE "DailyLog" SET "legacyPhotos" = 0 WHERE "legacyPhotos" <> 0;
    UPDATE "DailyLog" d
    SET "legacyPhotos" = GREATEST(0, d."progress" - COALESCE(f.n, 0))
    FROM "DailyLog" s
    LEFT JOIN (
      SELECT m."projectId", m."dailyLogId", count(DISTINCT m."id")::int AS n
      FROM "Media" m
      LEFT JOIN (
        SELECT "projectId", "entityId", max("streamPosition") AS p FROM "DomainEvent"
        WHERE "eventType" = 'dailylog.submitted' AND "entityType" = 'DailyLog'
        GROUP BY "projectId", "entityId"
      ) sent ON sent."projectId" = m."projectId" AND sent."entityId" = m."dailyLogId"
      LEFT JOIN "DomainEvent" up
        ON up."projectId" = m."projectId" AND up."eventType" = 'media.uploaded' AND up."entityType" = 'Media'
       AND up."entityId" = m."id"
      WHERE m."kind" = 'progress' AND m."dailyLogId" IS NOT NULL
        AND (sent.p IS NULL OR up."streamPosition" IS NULL OR up."streamPosition" < sent.p)
      GROUP BY m."projectId", m."dailyLogId"
    ) f ON f."projectId" = s."projectId" AND f."dailyLogId" = s."id"
    WHERE s."id" = d."id" AND d."submitted" AND d."progress" > 0;
    ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_legacyPhotos_nonnegative" CHECK ("legacyPhotos" >= 0);
  END IF;
  DROP TRIGGER IF EXISTS "DailyLog_legacyPhotos_frozen" ON "DailyLog";
  CREATE TRIGGER "DailyLog_legacyPhotos_frozen"
    BEFORE UPDATE ON "DailyLog"
    FOR EACH ROW EXECUTE FUNCTION daily_log_legacy_photos_frozen();
END $$;
