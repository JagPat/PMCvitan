-- #1177 VT1c, voice note to text. A transcript's creation time is the database clock's UTC time, read after the note is
-- locked. VT1a (20280126000000) stamped "createdAt" with LOCALTIMESTAMP: the time its transaction BEGAN, in the session's
-- time zone, so a session ahead of UTC stored a time in the future and a long transaction one before the row existed.
-- VT1b's gap-check found it (F1); VT1b stamps its corrections this way already. Nothing writes the table yet (VT2 is the
-- first writer), so no stored row has the old stamp to mend.
--
-- WHAT. One function body replaced: public.media_voice_transcript_insert(), the "VoiceTranscript_insert" trigger's. It is
-- VT1a's body with one change: "createdAt" is date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'), as
-- `site_visits_now()` gives, set after the note's "Media" row is share-locked, and never earlier than the moment its
-- transaction began (in UTC), even if the server's clock stepped back meanwhile (Codex #1221, 4404642570). The rules it
-- holds (a bare claim, a voice note only, read under a share lock) are unchanged, word for word.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never inserts a transcript; the trigger, its name and its
-- messages are unchanged.
--
-- LOCKS WHILE IT RUNS. CREATE OR REPLACE FUNCTION takes no table lock; lock_timeout 15 s as the other files.
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE after VT1a's file, so this
-- body is the one that stands after any replay. Schema-qualified, search_path pg_catalog, public, pg_temp.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE OR REPLACE FUNCTION public.media_voice_transcript_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_mime TEXT;
BEGIN
  -- every row starts as a claim; the provider's work reaches it only by update, under V4
  IF NEW."status" <> 'pending' OR NEW."providerJobId" IS NOT NULL OR NEW."text" IS NOT NULL OR NEW."languageCode" IS NOT NULL
     OR NEW."attempts" <> 0 OR NEW."retried" OR NEW."lastError" IS NOT NULL OR NEW."leaseToken" IS NOT NULL THEN
    RAISE EXCEPTION 'media: the transcript of voice note % starts as a bare claim (pending, nothing heard yet)', NEW."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT m."mime" INTO v_mime FROM public."Media" m
   WHERE m."projectId" = NEW."projectId" AND m."id" = NEW."mediaId" FOR SHARE;
  -- the creation time is the database clock's, in UTC, read after the lock, whatever the writer sent or the session's
  -- time zone (#1177 VT1c); never before its transaction began, even after the server's clock steps back
  NEW."createdAt" := GREATEST(date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'),
                              date_trunc('milliseconds', pg_catalog.now() AT TIME ZONE 'UTC'))::TIMESTAMP(3);
  IF NOT FOUND THEN
    RETURN NEW; -- no such file in the project: the composite foreign key refuses the row with its own error
  END IF;
  IF v_mime IS NULL OR v_mime NOT LIKE 'audio/%' THEN
    RAISE EXCEPTION 'media: a transcript is written only for a voice note, and file % is %', NEW."mediaId", v_mime
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
