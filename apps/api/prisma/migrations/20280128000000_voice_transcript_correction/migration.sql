-- #1177 VT1b, voice note to text (AI item 1, Jagrut 27 Oct 2026: "Go ahead and implement it"). A person's corrections
-- to what the speech provider heard, shipped alone, before any server or screen code reads or writes them. Nothing is
-- backfilled. In #1182 a correction was a set of editable columns on the transcript row, and each review round found
-- another way to rewrite or clear it without a trace (Codex #1182, 4398744235). Here each correction is its own row,
-- added and never changed, so the record of who corrected what, and when, cannot be rewritten.
--
-- WHY. The provider mishears site words, names and numbers. A member who knows what was said types the right words; the
-- server unit (VT2) shows the newest correction in place of the heard words, and the heard words stay as heard in
-- "VoiceTranscript" (VT1a). Going back to the heard words is itself a correction, with no text.
--
-- WHAT. One new table, "VoiceTranscriptCorrection": any number of rows per transcript, each with
--   "seq"            its place in the transcript's corrections, 1, 2, 3 ..., set by the database; the newest is the
--                    highest;
--   "text"           the words the person gave, or NULL for "back to what was heard";
--   "correctedById"  the person;
--   "createdAt"      the database's time when the row was added.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   C1  Keys. A correction names its transcript by the composite (projectId, mediaId) key to "VoiceTranscript", so no
--       row names another project's note, and it goes with its transcript (ON DELETE CASCADE), which goes with its
--       note. The person is a "User" (ON DELETE RESTRICT: a person who corrected a note is not deleted out from under
--       the record).
--   C2  Only of heard words. A row is added only while its transcript is done; until then there is nothing to correct.
--   C3  In order, stamped by the database. The insert trigger locks the transcript row (FOR NO KEY UPDATE) and sets
--       "seq" to one past the transcript's highest, so two people correcting at once are put one after the other and
--       the newest is never in doubt. After that lock it sets "createdAt" to the database clock's UTC time at that
--       moment (as `site_visits_now()` does), whatever the writer sent and whatever the session's time zone or start
--       time, so a correction's time is finite (Codex #1182, 4398744254). It is never earlier than the one before it,
--       even after the server's clock steps back: it is then the earlier correction's time (Codex #1213 round 2). The count is read anew only at READ COMMITTED, so an insert at a fixed snapshot is refused
--       (as the "Media" type guard of VT1a refuses one); the unique key on (projectId, mediaId, seq) backs this.
--   C4  Well formed. A text, when given, is not blank and is at most the provider's 20,000 characters; "seq" from 1.
--   C5  Added, never changed. An UPDATE is refused, so a correction keeps its words, its person and its time. Clearing
--       a correction is a new row with no text, attributed and timed like any other (Codex #1182, 4398744235).
--   C6  Goes only with its transcript. A DELETE is refused while its transcript row still stands, however deep the
--       trigger that runs it, so only the transcript's own cascade takes the rows (by then the transcript is gone). A
--       TRUNCATE is refused by a statement seal, which the sanctioned reset lifts by name. The transcript's own guard
--       is held to the same rule (Codex #1213, 4401865953): VT1a refused a direct delete of a transcript only at trigger
--       depth 1, so a writer's own trigger could delete it and its cascade would take every correction. This file
--       replaces that guard: a transcript is deleted only once its "Media" row is gone, that is, only by its note's
--       cascade. It keeps VT1a's trigger and message; only the test changes.
--
-- WHAT THIS FILE DOES NOT DO. Who may correct a note (a member of its project, under its switch) is the server unit's
-- rule (#1177 H5), as is what the screens show.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The table is new and the previous release never reads or writes it.
-- "VoiceTranscript" and "User" gain only incoming keys; no trigger is added to either. The transcript's delete guard
-- (replaced here) refuses only what VT1a already refused at depth 1, plus the same delete run from a writer's trigger;
-- the previous release deletes no transcript, and a note's delete still takes its transcript.
--
-- LOCKS WHILE IT RUNS. Adding the two keys takes ShareRowExclusiveLock on "VoiceTranscript" and "User" until the file
-- commits, so writes there wait for that moment; reads do not. No lock is waited for longer than 15 s (lock_timeout,
-- this transaction only): the file gets its locks or changes nothing.
--
-- ONE TRANSACTION, RE-RUNNABLE. The file is BEGIN ... COMMIT itself. It is on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a
-- `db push` baseline models the table, its keys and its indexes, but not the check or the triggers. Every statement is
-- guarded or replaces itself. Functions are schema-qualified with search_path pg_catalog, public, pg_temp.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."VoiceTranscriptCorrection" (
  "id"            TEXT NOT NULL,
  "projectId"     TEXT NOT NULL,
  "mediaId"       TEXT NOT NULL,
  "seq"           INTEGER NOT NULL DEFAULT 0,
  "text"          TEXT,
  "correctedById" TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoiceTranscriptCorrection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VoiceTranscriptCorrection_projectId_mediaId_seq_key"
  ON public."VoiceTranscriptCorrection"("projectId", "mediaId", "seq");
CREATE INDEX IF NOT EXISTS "VoiceTranscriptCorrection_correctedById_idx"
  ON public."VoiceTranscriptCorrection"("correctedById");

DO $vt1b_keys$
BEGIN
  -- C1. Guarded by name, as the other migrations guard: a `db push` baseline makes each key with this name and
  -- definition, so only a missing one is added.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscriptCorrection"'::regclass AND conname = 'VoiceTranscriptCorrection_projectId_mediaId_fkey') THEN
    ALTER TABLE public."VoiceTranscriptCorrection" ADD CONSTRAINT "VoiceTranscriptCorrection_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES public."VoiceTranscript"("projectId", "mediaId") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscriptCorrection"'::regclass AND conname = 'VoiceTranscriptCorrection_correctedById_fkey') THEN
    ALTER TABLE public."VoiceTranscriptCorrection" ADD CONSTRAINT "VoiceTranscriptCorrection_correctedById_fkey"
      FOREIGN KEY ("correctedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  -- C4, with the whitespace set the other shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscriptCorrection"'::regclass AND conname = 'VoiceTranscriptCorrection_shape_check') THEN
    ALTER TABLE public."VoiceTranscriptCorrection" ADD CONSTRAINT "VoiceTranscriptCorrection_shape_check" CHECK (
      "seq" >= 1
      AND ("text" IS NULL OR (btrim("text", E' \t\n\x0B\f\r') <> '' AND char_length("text") <= 20000))
      AND isfinite("createdAt")
    );
  END IF;
END $vt1b_keys$;

-- C2 and C3, on insert: only of a done transcript, one after the other, stamped with the database's own time. The
-- transcript row is locked first, so a second correction waits for the first to commit and then counts it, and a
-- delete of the note waits for this insert to commit (and then takes the row with it).
CREATE OR REPLACE FUNCTION public.media_voice_transcript_correction_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status TEXT; v_seq INT; v_last TIMESTAMP(3);
BEGIN
  -- the count below must see a correction committed while this insert waited for the lock; only READ COMMITTED reads
  -- anew per statement, so a fixed-snapshot writer is refused here rather than given a place it cannot check
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'media: a voice note is corrected only at READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation') USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."status" INTO v_status FROM public."VoiceTranscript" v
   WHERE v."projectId" = NEW."projectId" AND v."mediaId" = NEW."mediaId" FOR NO KEY UPDATE;
  -- the place and the time are the database's, whatever the writer sent: the time is read after the lock, in UTC,
  -- whenever this transaction began and whatever its session's time zone
  NEW."createdAt" := date_trunc('milliseconds', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
  IF NOT FOUND THEN
    NEW."seq" := 1;
    RETURN NEW; -- no such transcript in the project: the composite foreign key refuses the row with its own error
  END IF;
  IF v_status <> 'done' THEN
    RAISE EXCEPTION 'media: voice note % is corrected only once its words are heard, and it is %', NEW."mediaId", v_status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(c."seq"), max(c."createdAt") INTO v_seq, v_last FROM public."VoiceTranscriptCorrection" c
   WHERE c."projectId" = NEW."projectId" AND c."mediaId" = NEW."mediaId";
  NEW."seq" := 1 + COALESCE(v_seq, 0);
  -- never earlier than a correction before it, even when the server's clock has stepped back since (an NTP or manual
  -- correction): the lock orders the rows, and the time follows that order
  NEW."createdAt" := GREATEST(NEW."createdAt", v_last);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscriptCorrection_insert" ON public."VoiceTranscriptCorrection";
CREATE TRIGGER "VoiceTranscriptCorrection_insert"
  BEFORE INSERT ON public."VoiceTranscriptCorrection"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_correction_insert();

-- C5, on update: a correction is added, never changed.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_correction_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'media: a correction of voice note % is kept as made; a later one is a new correction', OLD."mediaId"
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscriptCorrection_frozen" ON public."VoiceTranscriptCorrection";
CREATE TRIGGER "VoiceTranscriptCorrection_frozen"
  BEFORE UPDATE ON public."VoiceTranscriptCorrection"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_correction_frozen();

-- C6, on delete: a correction goes only with its transcript (and so with its note or that note's project). That is the
-- transcript's foreign-key cascade, which runs once the transcript row is gone; any other DELETE finds the transcript
-- still standing and is refused. Trigger depth is not the test: a writer's own trigger can run a DELETE below depth 1.
-- `project:remove` switches this trigger off with the others on the tables it clears.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_correction_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."VoiceTranscript" v WHERE v."projectId" = OLD."projectId" AND v."mediaId" = OLD."mediaId") THEN
    RAISE EXCEPTION 'media: a correction of voice note % goes only with that note', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscriptCorrection_no_delete" ON public."VoiceTranscriptCorrection";
CREATE TRIGGER "VoiceTranscriptCorrection_no_delete"
  BEFORE DELETE ON public."VoiceTranscriptCorrection"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_correction_no_delete();

-- C6, held at the transcript too (Codex #1213, 4401865953): VT1a's "VoiceTranscript_no_delete" trigger keeps its name
-- and its message, and now refuses a delete while the note's "Media" row still stands, whatever the trigger depth, so
-- only the note's own cascade (by then the note is gone) takes a transcript and, through it, its corrections.
-- `project:remove` switches this trigger off with the others on the tables it clears. This file runs after VT1a's
-- (also on ALWAYS_EXECUTE, in timestamp order), so this body is the one that stands.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Media" m WHERE m."projectId" = OLD."projectId" AND m."id" = OLD."mediaId") THEN
    RAISE EXCEPTION 'media: the transcript of voice note % goes only with that note', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

-- A TRUNCATE fires no row trigger, so it is refused by its own statement seal; the sanctioned reset lifts it by name.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_correction_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'media: voice-note corrections are never truncated; they go with their notes'
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscriptCorrection_no_truncate" ON public."VoiceTranscriptCorrection";
CREATE TRIGGER "VoiceTranscriptCorrection_no_truncate"
  BEFORE TRUNCATE ON public."VoiceTranscriptCorrection"
  FOR EACH STATEMENT EXECUTE FUNCTION public.media_voice_transcript_correction_no_truncate();

COMMIT;
