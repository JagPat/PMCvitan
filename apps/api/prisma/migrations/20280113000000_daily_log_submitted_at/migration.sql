-- Site photos (#482, Board decision 2026-10-14) — the instant a daily log was sent, stamped by the database.
--
-- A log's photo count is the photos taken while it was the open log: from the moment the previous log was sent
-- to the moment this one is. Today nothing records when a log was sent, so a read can only count from the start
-- of the log's civil day: a second log on the same day, or today's log after an overdue one was sent this
-- morning, then counts the photos the earlier log already holds (#920 review). This column is that boundary.
--
-- THE DATABASE OWNS IT, so no command, alternate writer or raw SQL can set it to another instant: a BEFORE trigger
-- stamps it when a row becomes sent (inserted sent, or "submitted" turning true), keeps the first stamp while the
-- row stays sent, and clears it if the row is ever un-sent. The stamp is UTC at the columns' millisecond
-- precision, the convention `site_visits_now()` follows.
--
-- Additive and previous-release safe: an old release neither reads nor writes the column, and its submit still
-- gets a stamp from the trigger. Every log sent before this migration carries none; a read falls back to the
-- civil-day start for those.
ALTER TABLE "DailyLog" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION daily_log_stamp_submitted() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW."submitted" THEN
    NEW."submittedAt" := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD."submitted" THEN
    NEW."submittedAt" := OLD."submittedAt";
  ELSE
    NEW."submittedAt" := date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daily_log_stamp_submitted ON "DailyLog";
CREATE TRIGGER daily_log_stamp_submitted BEFORE INSERT OR UPDATE ON "DailyLog"
  FOR EACH ROW EXECUTE FUNCTION daily_log_stamp_submitted();
