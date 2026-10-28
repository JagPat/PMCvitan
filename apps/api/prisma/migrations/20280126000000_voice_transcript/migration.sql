-- #1177 VT1, voice note to text (AI item 1, Jagrut 27 Oct 2026: "Go ahead and implement it"). The database half, shipped
-- alone, before any server or screen code reads or writes it. Nothing is backfilled.
--
-- WHY. A voice note on a site visit is spoken on site, often in Gujarati or Hindi. The server unit (VT2) sends a note's
-- audio to the speech provider when someone views it on a project where the `voice-text` switch is on, and keeps the
-- words here, so everyone reads and searches what was said and a person can correct the machine's draft. The row is the
-- durable truth of that work: the provider's job id, how far it got, and the text (#1177 H2, H3).
--
-- WHAT. One new table, "VoiceTranscript": at most one row per voice note ("mediaId" is the key), with
--   "status"         'pending' (claimed, no job yet), 'running' (the provider holds a job, "providerJobId"), 'done'
--                    (the provider's words are in "text") or 'failed' (the provider refused or the tries ran out);
--   "text"           the provider's words, exactly when done ('' when the note held no speech);
--   "languageCode"   the language the provider heard, a BCP-47 code such as 'gu-IN', when it said one;
--   "editedText"     a person's correction, with who ("editedById") and when ("editedAt"), only on a done row; the
--                    provider's "text" is kept beside it, never overwritten (#1177 H7);
--   "attempts", "retried", "lastError"  the bounded tries (#1177 H6);
--   "leaseToken", "leaseUntil"           the short claim one request holds while it calls the provider outside any
--                                        transaction; the write-back matches the token (#1177 H3).
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   V1  Keys. One row per voice note. The note is named by the composite (projectId, mediaId) key to "Media", the shape
--       every project-owned link uses, so no row names another project's file. The row goes with its note (ON DELETE
--       CASCADE): a deleted note's text goes too, and a late write-back after the delete matches no row (#1177 H4).
--       The corrector is a real account (RESTRICT, as "SiteVisitMedia"."addedById").
--   V2  A voice note only. A row is inserted only for a "Media" row whose type is audio at that moment (no code
--       changes a file's type afterwards). Its keys ("projectId", "mediaId") and "createdAt" never change, so a
--       transcript is never moved onto another file.
--   V3  Well formed. A status from the list; "text" set exactly when done; a running row names its job; a correction only on a done row, never
--       blank, with its corrector and time exactly when it is set; a lease token and its expiry together or neither; a
--       job id, when set, never blank; "attempts" from 0 to 10; texts bounded (the provider's 20,000 characters, a
--       correction's 5,000, an error's 500); a language code shaped like 'gu-IN' or 'en'.
--   V4  What the provider heard stays as heard, and a correction is attributed. Once a row is done, its status, "text"
--       and "languageCode" never change, so a late provider answer cannot overwrite them (#1177 H7). The corrector and
--       the time change only together with the correction itself, so "Corrected by X" always names who wrote the text
--       shown.
--
-- WHAT THIS FILE DOES NOT DO. Who may read, start or correct a transcript is the server unit's rule (#1177 H5); the
-- row is working state, not a sealed record, so it changes as the job moves and is corrected in place.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The table is new and the previous release never reads or writes it. Nothing on
-- "Media" or "User" changes except the two new foreign keys pointing at them.
--
-- LOCKS WHILE IT RUNS. Adding the two keys takes ShareRowExclusiveLock on "Media" and "User" until the file commits, so
-- inserts, updates and deletes on those two wait for that moment; reads do not. No lock is waited for longer than 15 s
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
  "editedText"    TEXT,
  "editedById"    TEXT,
  "editedAt"      TIMESTAMP(3),
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
  -- V1. Guarded by name, as the other migrations guard: a `db push` baseline makes both keys with these names and
  -- definitions, so only a missing one is added.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_projectId_mediaId_fkey') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES public."Media"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_editedById_fkey') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_editedById_fkey"
      FOREIGN KEY ("editedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  -- V3, with the whitespace set the other shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."VoiceTranscript"'::regclass AND conname = 'VoiceTranscript_shape_check') THEN
    ALTER TABLE public."VoiceTranscript" ADD CONSTRAINT "VoiceTranscript_shape_check" CHECK (
      "status" IN ('pending', 'running', 'done', 'failed')
      AND (("status" = 'done') = ("text" IS NOT NULL))
      AND ("status" <> 'running' OR "providerJobId" IS NOT NULL)
      AND ("text" IS NULL OR char_length("text") <= 20000)
      AND ("editedText" IS NULL OR ("status" = 'done'
            AND btrim("editedText", E' \t\n\x0B\f\r') <> '' AND char_length("editedText") <= 5000))
      AND (("editedText" IS NULL) = ("editedById" IS NULL) AND ("editedText" IS NULL) = ("editedAt" IS NULL))
      AND (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
      AND ("leaseToken" IS NULL OR btrim("leaseToken", E' \t\n\x0B\f\r') <> '')
      AND ("providerJobId" IS NULL OR (btrim("providerJobId", E' \t\n\x0B\f\r') <> '' AND char_length("providerJobId") <= 200))
      AND ("languageCode" IS NULL OR "languageCode" ~ '^[a-z]{2,3}(-[A-Z]{2})?$')
      AND "attempts" BETWEEN 0 AND 10
      AND ("lastError" IS NULL OR char_length("lastError") <= 500)
    );
  END IF;
END $vt1_keys$;

-- V2, on insert: the file is a voice note. Read under a share lock, so a delete of the file waits for this insert to
-- commit (and then takes the row with it) rather than slipping between the check and the insert.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_mime TEXT;
BEGIN
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

-- V2 and V4, on update: the keys and the creation time never move; a done row keeps what the provider heard (and all
-- else but its correction); the
-- corrector and time move only with the correction, and a changed correction carries a later time.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_keys_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."mediaId" IS DISTINCT FROM OLD."mediaId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'media: the transcript of voice note % stays with that note', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- a done row is settled: only its correction (and the row's update time) may change. The status, the words and
  -- their language, the job they came from, the tries and the lease all stay as they were when it was done
  -- (Codex round 3, 4397687020: the job id was not held).
  IF OLD."status" = 'done'
     AND (to_jsonb(NEW) - ARRAY['editedText', 'editedById', 'editedAt', 'updatedAt'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['editedText', 'editedById', 'editedAt', 'updatedAt']) THEN
    RAISE EXCEPTION 'media: the words heard in voice note % are kept as heard; a person corrects them beside', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."editedText" IS NOT DISTINCT FROM OLD."editedText"
     AND (NEW."editedById" IS DISTINCT FROM OLD."editedById" OR NEW."editedAt" IS DISTINCT FROM OLD."editedAt") THEN
    RAISE EXCEPTION 'media: the correction of voice note % keeps its author and time unless the correction changes', OLD."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  -- a changed correction is a new one: it carries a later time (and the writer names its author with it), so the
  -- previous corrector is never left standing beside words they did not write
  IF OLD."editedText" IS NOT NULL AND NEW."editedText" IS NOT NULL AND NEW."editedText" IS DISTINCT FROM OLD."editedText"
     AND NOT (NEW."editedAt" > OLD."editedAt") THEN
    RAISE EXCEPTION 'media: a new correction of voice note % carries its own author and a later time', OLD."mediaId"
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
-- written again with other words or another corrector (Codex round 2, 4397618560). `project:remove` switches this
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
-- no code changes it, but a raw writer could; this holds V2 after the insert as well as at it (Codex round 3,
-- 4397687017). The transcript's insert share-locks the note, so the two serialize, and each statement here reads anew.
CREATE OR REPLACE FUNCTION public.media_voice_transcript_note_kept() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- only a voice note can hold a transcript (V2), and only its leaving audio matters
  IF OLD."mime" IS NULL OR OLD."mime" NOT LIKE 'audio/%' OR NEW."mime" LIKE 'audio/%' THEN
    RETURN NEW;
  END IF;
  -- the lookup below must see a transcript committed while this write waited for the row; only READ COMMITTED reads
  -- anew per statement, so a fixed-snapshot writer is refused here (Codex round 4, 4398170733)
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
