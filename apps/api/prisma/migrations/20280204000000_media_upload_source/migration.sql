-- #904 follow-up #1283 (step 1 of 2): a site-visit copy's replay names its original by "Media"."sourceMediaId", and that
-- link is cleared (ON DELETE SET NULL) when the original is removed. A row whose link was cleared then looks like a
-- plain upload, so a plain upload key sent again as a copy of the removed original, with the same bytes, could be handed
-- back. This file adds the column that keeps, for good, which file a copy was made from; step 2 writes it with each new
-- upload and compares it on replay. Nothing else changes here.
--
-- WHAT. One nullable column, "Media"."uploadSourceMediaId": the id of the file this row was uploaded as a copy of, as
-- the request named it, or NULL for a plain upload. No foreign key: unlike "sourceMediaId" it must outlive the
-- original's removal, so nothing clears it. A row stored before step 2 has NULL; its replay keeps today's rule (#1283's
-- stated residual, with its end).
--
-- FIXED AT THE INSERT. The value is a fact of the upload request, so it is taken only when the row is made: a BEFORE
-- UPDATE trigger refuses any change to it, NULL to a value included, on every writer, raw SQL too. A later write could
-- otherwise give a row a source it was never uploaded with. Writing the same value again is no change. This is stricter
-- than the digest (20280202000000), which takes NULL to a digest because a digest is a fact of the bytes, not of the
-- request.
--
-- AND ONLY A COPY CARRIES ONE (Stage 1's gap-check). A row may be made with a value only as a copy of that very file:
-- on INSERT the same trigger refuses a non-NULL value unless "sourceMediaId" names the same file. A plain row made
-- with a source would otherwise answer a copy-of-that-file resend, which is the hole #1283 closes. The previous
-- release's inserts leave the column NULL and pass.
-- It is the rule "sourceMediaId" already has (20280115000000: the link is set only when the copy is made), kept
-- for a column that nothing clears.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the column: its Prisma client neither selects nor
-- writes it, its inserts leave it NULL (which the insert check takes), and none of its updates touch it.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN with no default is a catalog change under a brief ACCESS EXCLUSIVE lock; no row is
-- read or rewritten. The trigger is a catalog change too. No lock is waited for longer than 15 s (lock_timeout, this
-- transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the column but not its trigger). IF NOT EXISTS, the function replaced and the trigger dropped and re-made.
-- Schema-qualified, with a fixed search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

ALTER TABLE public."Media" ADD COLUMN IF NOT EXISTS "uploadSourceMediaId" TEXT;

CREATE OR REPLACE FUNCTION public.media_upload_source_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."uploadSourceMediaId" IS NOT NULL AND NEW."uploadSourceMediaId" IS DISTINCT FROM NEW."sourceMediaId" THEN
      RAISE EXCEPTION 'media: the file % names an upload source only as a copy of that file', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."uploadSourceMediaId" IS DISTINCT FROM OLD."uploadSourceMediaId" THEN
    RAISE EXCEPTION 'media: the file % keeps the source it was uploaded with', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Media_upload_source_fixed" ON public."Media";
CREATE TRIGGER "Media_upload_source_fixed"
  BEFORE INSERT OR UPDATE OF "uploadSourceMediaId" ON public."Media"
  FOR EACH ROW EXECUTE FUNCTION public.media_upload_source_fixed();

COMMIT;
