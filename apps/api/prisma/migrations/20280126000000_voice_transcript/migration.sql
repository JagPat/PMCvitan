-- #1177 VT1a, voice note to text (AI item 1, Jagrut 27 Oct 2026: "Go ahead and implement it"). The transcripts table,
-- shipped alone, before any server or screen code reads or writes it. Nothing is backfilled. It replaces #1182, whose
-- review stopped at its third P1 head: there a person's correction was a set of editable columns on this row, and each
-- review round found another way to rewrite it. Here the row holds only what the provider heard; corrections become
-- their own append-only rows in the next unit (VT1b), so no correction is ever written over or erased.
--
-- WHY. A voice note on a site visit is spoken on site, often in Gujarati or Hindi. The server unit (VT2) sends a note's
-- audio to the speech provider when someone views it on a project where the `voice-text` switch is on, and keeps the
-- words here, so everyone reads and searches what was said. The row is the durable truth of that work: the provider's
-- job id, how far it got, and the text (#1177 H2, H3).
--
-- WHAT. One new table, "VoiceTranscript": at most one row per voice note ("mediaId" is the key), with
--   "status"         'pending' (claimed, no job yet), 'running' (the provider holds a job, "providerJobId"), 'done'
--                    (the provider's words are in "text") or 'failed' (the provider refused or the tries ran out);
--   "text"           the provider's words, exactly when done ('' when the note held no speech);
--   "languageCode"   the language the provider heard, a BCP-47 code such as 'gu-IN', when it said one;
--   "attempts", "retried", "lastError"  the bounded tries (#1177 H6);
--   "leaseToken", "leaseUntil"           the short claim one request holds while it calls the provider outside any
--                                        transaction; the write-back matches the token (#1177 H3).
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   V1  Keys. One row per voice note. The note is named by the composite (projectId, mediaId) key to "Media", the shape
--       every project-owned link uses, so no row names another project's file. The row goes with its note (ON DELETE
--       CASCADE): a deleted note's text goes too, and a late write-back after the delete matches no row (#1177 H4).
--   V2  A voice note only. A row is inserted only for a "Media" row whose type is audio at that moment, and while a
--       transcript exists its "Media" row stays audio. Its keys ("projectId", "mediaId") and "createdAt" never change,
--       so a transcript is never moved onto another file. A row starts as a bare claim: 'pending', no job, no text, no
--       tries, no error, no lease.
--   V3  Well formed. A status from the list; "text" set exactly when done, and a language only then; a running row
--       names its job; a lease token and its expiry together or neither; a job id, when set, never blank; "attempts" from 0 to 10; texts bounded
--       (the provider's 20,000 characters, an error's 500); a language code shaped like 'gu-IN' or 'en'; every time
--       finite.
--   V4  What the provider heard stays as heard, from the job that heard it. A row moves only forward: pending to
--       running, failed or done; running to failed or done; and failed back only to a fresh claim for another try
--       (Codex #1208, 4399524540: not failed back to running). That fresh claim is exactly a bare claim marked
--       "retried": no job, tries, error or lease (Codex #1208, 4399950031). Each column of the working row has its one
--       way to change (the root of #1208's findings, checked as a whole): the job id is set once per try, as a pending
--       row starts running, and cleared only by the fresh claim (Codex #1182, 4398744242); "attempts" only rises
--       within a try and goes back to 0 only by the fresh claim; "retried" is set only by the fresh claim and never
--       cleared (Codex #1208, 4399950036); the error and the lease are a try's working notes. Once a row is done
--       nothing in it changes but its update time, so a late provider answer cannot overwrite it (#1177 H7).
--       What the database cannot tell apart: a done row with no job after a reset is either a short note sent whole
--       on its retry or a long one whose job a writer chose to abandon; both pass through a recorded failure and
--       retry.
--   V5  A transcript goes only with its note: a direct DELETE or TRUNCATE is refused.
--
-- WHAT THIS FILE DOES NOT DO. Who may read or start a transcript is the server unit's rule (#1177 H5). Until a row is
-- done it is working state, which changes as the job moves. Corrections are VT1b's own table.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The table is new and the previous release never reads or writes it. "Media" gains
-- only the new foreign key pointing at it and one trigger that acts only when an audio file's type leaves audio, which
-- no release does.
--
-- LOCKS WHILE IT RUNS. Adding the key and the trigger takes ShareRowExclusiveLock on "Media" until the file commits, so
-- inserts, updates and deletes on it wait for that moment; reads do not. No lock is waited for longer than 15 s
-- (lock_timeout, this transaction only): the file gets its locks or changes nothing.
--
-- ONE TRANSACTION, RE-RUNNABLE. The file is BEGIN ... COMMIT itself. It is on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a
-- `db push` baseline models the table, its keys and its unique index, but not the checks or the triggers. Every
-- statement is guarded or replaces itself. Functions are schema-qualified with search_path pg_catalog, public, pg_temp.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."VoiceTranscript" (
  "projectId"     TEXT NOT NULL,
  "mediaId"       TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "providerJobId" TEXT,
  "languageCode"  TEXT,
  "text"          TEXT,
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "retried"       BOOLEAN NOT NULL DEFAULT false,
  "lastError"     TEXT,
  "leaseToken"    TEXT,
  "leaseUntil"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceTranscript_pkey" PRIMARY KEY ("mediaId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "VoiceTranscript_projectId_mediaId_key" ON public."VoiceTranscript"("projectId", "mediaId");

DO $vt1_keys$
BEGIN
  -- V1. Guarded by name, as the other migrations guard: a `db push` baseline makes the key with this name and
  -- definition, so only a missing one is added.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_projectId_mediaId_fkey') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES public."Media"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  -- V3, with the whitespace set the other shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_shape_check') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_shape_check" CHECK (
      "status" IN ('pending', 'running', 'done', 'failed')
      AND (("status" = 'done') = ("text" IS NOT NULL))
      AND ("status" <> 'running' OR "providerJobId" IS NOT NULL)
      AND ("text" IS NULL OR char_length("text") <= 20000)
      AND (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
      AND ("leaseToken" IS NULL OR btrim("leaseToken", E' \t\n\x0B\f\r') <> '')
      AND ("providerJobId" IS NULL OR (btrim("providerJobId", E' \t\n\x0B\f\r') <> '' AND char_length("providerJobId") <= 200))
      AND ("languageCode" IS NULL OR ("status" = 'done' AND "languageCode" ~ '^[a-z]{2,3}(-[A-Z]{2})?$'))
      AND "attempts" BETWEEN 0 AND 10
      AND ("lastError" IS NULL OR char_length("lastError") <= 500)
      AND isfinite("createdAt") AND isfinite("updatedAt") AND ("leaseUntil" IS NULL OR isfinite("leaseUntil"))
    );
  END IF;
END $vt1_keys$;

-- V2, on insert: a bare claim on a voice note, stamped with the database's own time. Read under a share lock, so a delete of the file waits for this insert to
-- commit (and then takes the row with it) rather than slipping between the check and the insert.
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
  -- the creation time is the database's, as the column default would give, whatever the writer sent
  NEW."createdAt" := LOCALTIMESTAMP;
  SELECT m."mime" INTO v_mime FROM public."Media" m
   WHERE m."projectId" = NEW."projectId" AND m."id" = NEW."mediaId" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- no such file in the project: the composite foreign key refuses the row with its own error
  END IF;
  IF v_mime IS NULL OR v_mime NOT LIKE 'audio/%' THEN
    RAISE EXCEPTION 'media: a transcript is written only for a voice note, and file % is %', NEW."mediaId", v_mime
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscript_insert" ON public."VoiceTranscript";
CREATE TRIGGER "VoiceTranscript_insert"
  BEFORE INSERT ON public."VoiceTranscript"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_insert();

-- V2 and V4, on update: the keys and the creation time never move; a done row changes no more; a row moves only
-- forward, or from failed to a fresh claim; each working column changes only in its own way.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_keys_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  -- the one way a failed try starts over: a fresh claim, marked retried, carrying nothing of the try before
  v_fresh BOOLEAN := OLD."status" = 'failed' AND NEW."status" = 'pending';
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."mediaId" IS DISTINCT FROM OLD."mediaId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'media: the transcript of voice note % stays with that note', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- a done row is settled: nothing but the row's update time changes, so the status, the words and their language,
  -- the job, the tries and the lease stay as they were when it was done
  IF OLD."status" = 'done' AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'media: the words heard in voice note % are kept as heard', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- the words come from the job that was asked (Codex #1182, 4398744242). A job id is set once, as a pending row
  -- starts running; it is cleared only by the reset of a failed row to a fresh, retried claim; nothing else changes it
  IF NEW."providerJobId" IS DISTINCT FROM OLD."providerJobId"
     AND NOT (OLD."providerJobId" IS NULL AND OLD."status" = 'pending' AND NEW."status" = 'running')
     AND NOT (NEW."providerJobId" IS NULL AND v_fresh AND NEW."retried") THEN
    RAISE EXCEPTION 'media: the job of voice note % is set once per try', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- the whole path, not only the step into done (Codex #1208, 4399524540): a failed try is never taken back up; it
  -- starts over only as a fresh claim, so no text is published for a job already recorded as failed
  -- (a word outside the list is the shape check's to refuse, with its own name)
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('pending', 'running', 'failed', 'done') AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('running', 'failed', 'done'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('failed', 'done'))
    OR v_fresh) THEN
    RAISE EXCEPTION 'media: voice note % moves from % to % only forward, or from failed to a fresh retried claim',
      OLD."mediaId", OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- the fresh claim carries nothing of the failed try: no job, tries, error or lease (and, by the shape check, no
  -- words or language), and it is marked retried (Codex #1208, 4399950031)
  IF v_fresh AND NOT (NEW."retried" AND NEW."providerJobId" IS NULL AND NEW."attempts" = 0
                      AND NEW."lastError" IS NULL AND NEW."leaseToken" IS NULL) THEN
    RAISE EXCEPTION 'media: voice note % starts over only as a fresh retried claim, with nothing of the failed try', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- the retry mark is set by the fresh claim and never cleared, so a done row keeps its history (Codex #1208,
  -- 4399950036); the tries only rise within a try
  IF NEW."retried" IS DISTINCT FROM OLD."retried" AND NOT (v_fresh AND NEW."retried") THEN
    RAISE EXCEPTION 'media: voice note % is marked retried only by its fresh claim, and keeps the mark', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" AND NOT v_fresh THEN
    RAISE EXCEPTION 'media: the tries of voice note % only rise, until a fresh claim', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscript_keys_fixed" ON public."VoiceTranscript";
CREATE TRIGGER "VoiceTranscript_keys_fixed"
  BEFORE UPDATE ON public."VoiceTranscript"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_keys_fixed();

-- V5, on delete: a transcript goes only with its voice note (or that note's project). Those are foreign-key cascades,
-- which run below trigger depth 1; a direct DELETE is depth 1 and is refused, so heard words are never erased and then
-- written again with other words (Codex #1182, 4397618560). `project:remove` switches this
-- trigger off with the others on the tables it clears.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'media: the transcript of voice note % goes only with that note', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscript_no_delete" ON public."VoiceTranscript";
CREATE TRIGGER "VoiceTranscript_no_delete"
  BEFORE DELETE ON public."VoiceTranscript"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_no_delete();

-- A TRUNCATE fires no row trigger, so it is refused by its own statement seal; the sanctioned reset lifts it by name.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'media: voice-note transcripts are never truncated; they go with their notes'
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS "VoiceTranscript_no_truncate" ON public."VoiceTranscript";
CREATE TRIGGER "VoiceTranscript_no_truncate"
  BEFORE TRUNCATE ON public."VoiceTranscript"
  FOR EACH STATEMENT EXECUTE FUNCTION public.media_voice_transcript_no_truncate();

-- V2 kept, on the note: while a transcript exists, its "Media" row stays a voice note. A file's type is set at upload and
-- no code changes it, but a raw writer could; this holds V2 after the insert as well as at it (Codex #1182,
-- 4397687017). The transcript's insert share-locks the note, so the two serialize, and each statement here reads anew.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_note_kept() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- only a voice note can hold a transcript (V2), and only its leaving audio matters
  IF OLD."mime" IS NULL OR OLD."mime" NOT LIKE 'audio/%' OR NEW."mime" LIKE 'audio/%' THEN
    RETURN NEW;
  END IF;
  -- the lookup below must see a transcript committed while this write waited for the row; only READ COMMITTED reads
  -- anew per statement, so a fixed-snapshot writer is refused here (Codex #1182, 4398170733)
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'media: a voice note''s type changes only at READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation') USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public."VoiceTranscript" v WHERE v."projectId" = OLD."projectId" AND v."mediaId" = OLD."id") THEN
    RAISE EXCEPTION 'media: file % has a transcript, so it stays a voice note', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Media_voice_transcript_note_kept" ON public."Media";
CREATE TRIGGER "Media_voice_transcript_note_kept"
  BEFORE UPDATE OF "mime" ON public."Media"
  FOR EACH ROW EXECUTE FUNCTION public.media_voice_transcript_note_kept();

COMMIT;
