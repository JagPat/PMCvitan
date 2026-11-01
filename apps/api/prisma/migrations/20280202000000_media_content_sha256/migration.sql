-- #904 / #1262 (Codex round 1, threads 4436515182 and 4436515187): an upload key's replay names a file by the type and
-- byte length it was stored with, and two different files can share both. A replay must instead be compared with the
-- bytes themselves. This file adds the column that holds them as a digest; #1262 writes it on every new upload and
-- compares it on replay. Nothing else changes here.
--
-- WHAT. One nullable column, "Media"."contentSha256": the SHA-256 of the file's decoded bytes as 64 lowercase hex
-- characters, written once with the row. A CHECK holds it to that shape or NULL. A row stored before #1262 has NULL, and
-- its replay keeps the byte-length comparison (that is #1262's stated residual, with its end).
--
-- WRITTEN ONCE (Codex 4437816190). A replay trusts the digest as the stored bytes' own, so once a row has one it keeps it
-- on every writer, raw SQL included: a BEFORE UPDATE trigger refuses any change to a non-NULL digest (another digest or
-- NULL). Only the first write is taken: NULL to a digest. Writing the same value again is no change.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the column: its Prisma client neither selects nor
-- writes it, and its inserts leave it NULL, which the CHECK takes.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN with no default is a catalog change; the CHECK reads "Media" once, under the same
-- ACCESS EXCLUSIVE lock, and every row is NULL. The trigger is a catalog change too. No lock is waited for longer than 15 s (lock_timeout, this transaction
-- only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the column but not its CHECK or trigger). IF NOT EXISTS, the CHECK added only when missing, the function
-- replaced and the trigger dropped and re-made. Schema-qualified, with a fixed search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

ALTER TABLE public."Media" ADD COLUMN IF NOT EXISTS "contentSha256" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."Media"'::regclass AND conname = 'Media_contentSha256_shape_check') THEN
    ALTER TABLE public."Media" ADD CONSTRAINT "Media_contentSha256_shape_check"
      CHECK ("contentSha256" IS NULL OR "contentSha256" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.media_content_sha256_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."contentSha256" IS NOT NULL AND NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256" THEN
    RAISE EXCEPTION 'media: the file % keeps the digest it was stored with', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Media_content_sha256_fixed" ON public."Media";
CREATE TRIGGER "Media_content_sha256_fixed"
  BEFORE UPDATE OF "contentSha256" ON public."Media"
  FOR EACH ROW EXECUTE FUNCTION public.media_content_sha256_fixed();

COMMIT;
