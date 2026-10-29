-- #1177 VT1d, voice note to text. When a transcript's current job began, so the server (VT2) can give a job that never
-- finishes an end. VT2's review (Codex #1226 round 2) found a job the provider leaves 'running' forever is checked
-- forever and never fails, and that a busy provider's refusals (429) to a job already made need a bound that is not a
-- count of tries (a refusal before any job is made still spends a try). Both need a time the job began that no writer
-- can move; the table has none ("createdAt" is when the note was first asked for, and a "Try again" keeps it).
--
-- WHAT. One nullable column, "VoiceTranscript"."runningSince", and one trigger that sets it on every insert and update,
-- whatever the writer sent:
--   - no job ("providerJobId" NULL: a bare claim, or the fresh claim of a "Try again"): NULL;
--   - a job just stored (the old row had none): the database clock's UTC time, read now, never before its transaction
--     began, as VT1c stamps "createdAt";
--   - otherwise: unchanged from the old row.
-- VT1a's update trigger already lets a job id be set only as a pending row starts running and cleared only by the fresh
-- claim, so the stamp is the start of that try's job and goes with it. A CHECK holds the pairing for every row, those a
-- writer in replica mode (which skips triggers) writes included: a start exactly when there is a job.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never writes this table (VT2, its first writer, is not merged),
-- and its Prisma client neither reads nor writes the new column. No stored row has a job, so none needs a stamp; were
-- one to, the CHECK refuses to stand and the file changes nothing, rather than leave a job with no start.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN of a nullable column with no default, the CHECK and CREATE TRIGGER take
-- AccessExclusiveLock / ShareRowExclusiveLock on "VoiceTranscript" only, until the file commits. Meanwhile reads of the
-- table wait, and so does a delete of any "Media" row (its cascade locks this table). The table is empty in production
-- and the file commits in milliseconds; no lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline models
-- the column but not the trigger). Every statement is guarded or replaces itself. Schema-qualified, search_path
-- pg_catalog, public, pg_temp.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

ALTER TABLE public."VoiceTranscript" ADD COLUMN IF NOT EXISTS "runningSince" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION public.media_voice_transcript_running_since() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."providerJobId" IS NULL THEN
    NEW."runningSince" := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD."providerJobId" IS NULL THEN
    -- the job was stored just now: its start is the database clock's, in UTC, never before this transaction began
    NEW."runningSince" := GREATEST(date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'),
                                   date_trunc('milliseconds', pg_catalog.now() AT TIME ZONE 'UTC'))::TIMESTAMP(3);
  ELSE
    NEW."runningSince" := OLD."runningSince";
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_running_since_check') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_running_since_check"
      CHECK (("runningSince" IS NULL) = ("providerJobId" IS NULL) AND ("runningSince" IS NULL OR isfinite("runningSince")));
  END IF;
END $$;

-- named to fire after "VoiceTranscript_insert" and "VoiceTranscript_keys_fixed" (BEFORE triggers fire by name), so VT1a's
-- rules judge the row as the writer sent it, and this stamp is the last word on the column
DROP TRIGGER IF EXISTS "VoiceTranscript_running_since" ON public."VoiceTranscript";
CREATE TRIGGER "VoiceTranscript_running_since"
  BEFORE INSERT OR UPDATE ON public."VoiceTranscript"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_running_since();

COMMIT;
