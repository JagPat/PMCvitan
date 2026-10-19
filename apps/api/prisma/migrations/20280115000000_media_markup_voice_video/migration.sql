-- Stage 1 media (Jagrut, 19 Oct 2026: "yes to all" on the plan for photo markup, voice notes and video, in that order,
-- site visits first). This is the plan's one database change, and it ships alone, before any server or screen uses it.
--
-- WHAT. Three nullable columns on "Media", the table every stored file already lives in:
--   "sourceMediaId"    a marked-up copy's original. Markup never edits a photo: the person's arrows and circles are
--                      saved as a NEW file that points at the one it was drawn on, so the original keeps its bytes,
--                      camera time and place.
--   "durationSec"      a voice note's or a video clip's length in whole seconds, for the play bar.
--   "posterStorageKey" a video's still frame in file storage, shown with a play button before the clip loads.
-- No new table and no event: the upload keeps its own `media.uploaded` event, so the sealed effect catalog does not
-- move and no operator reseal is needed at deploy. One row trigger guards the link (K4).
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   K1  Same project. The original is linked by a composite (projectId, sourceMediaId) foreign key, the shape every
--       project-owned link uses, so a copy cannot point at another project's file.
--   K2  The original outlives nothing it should not. Removing an original clears the copy's link through the key's own
--       `ON DELETE SET NULL ("sourceMediaId")` and leaves the copy (and its "projectId") in place. Whether an original
--       with copies may be removed at all is the media module's rule, not this file's.
--   K3  Shapes (CHECK "Media_av_shape_check"): a copy is an image and never its own original; a length belongs only to
--       audio (1 to 120 seconds, the plan's 2-minute voice note) or video (1 to 60 seconds, Jagrut's cap); a still
--       frame belongs only to a video and is never blank. Every existing row is an image with none of the three, so
--       the CHECK holds on the rows already stored.
--   K4  The link is provenance, so it is written once (round-1 review). Trigger "Media_markup_source":
--       - a copy's original must itself be an image already stored in its project (the CHECK sees only the copy's own
--         row, and the key does not check the type);
--       - the link is set only when the copy is created, never added, moved or cleared later, except that it clears
--         once its original is gone, which is K2's `SET NULL` (the original's row is checked to be absent, not trusted
--         from the trigger depth);
--       - an original that has copies stays an image.
--
-- WIDER FILE TYPES. Which types an upload accepts (today PNG, JPEG, WebP, GIF and HEIC) is the server's upload rule;
-- "Media"."mime" has no CHECK, so audio and video need no database change here.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the columns but not the CHECK,
-- the column-list foreign key action or the trigger. Every statement is guarded or replaces itself.

DO $media_av$
BEGIN
  ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "sourceMediaId" TEXT;
  ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "durationSec" INTEGER;
  ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "posterStorageKey" TEXT;
  CREATE INDEX IF NOT EXISTS "Media_projectId_sourceMediaId_idx" ON "Media"("projectId", "sourceMediaId");
  -- K2: a `db push` baseline creates this key as NO ACTION, since Prisma cannot express the column-list form; the key
  -- is judged by its delete action and replaced when that is not SET NULL of the link column alone (as SV2 does).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Media_projectId_sourceMediaId_fkey'
                AND NOT (confdeltype = 'n' AND confdelsetcols IS NOT NULL)) THEN
    ALTER TABLE "Media" DROP CONSTRAINT "Media_projectId_sourceMediaId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Media_projectId_sourceMediaId_fkey') THEN
    ALTER TABLE "Media" ADD CONSTRAINT "Media_projectId_sourceMediaId_fkey"
      FOREIGN KEY ("projectId", "sourceMediaId") REFERENCES "Media"("projectId", "id")
      ON DELETE SET NULL ("sourceMediaId") ON UPDATE NO ACTION;
  END IF;
  -- K3, with the whitespace set the SV1-a shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Media_av_shape_check') THEN
    ALTER TABLE "Media" ADD CONSTRAINT "Media_av_shape_check" CHECK (
      ("sourceMediaId" IS NULL OR ("sourceMediaId" <> "id" AND "mime" LIKE 'image/%'))
      AND ("durationSec" IS NULL
           OR ("mime" LIKE 'audio/%' AND "durationSec" BETWEEN 1 AND 120)
           OR ("mime" LIKE 'video/%' AND "durationSec" BETWEEN 1 AND 60))
      AND ("posterStorageKey" IS NULL
           OR ("mime" LIKE 'video/%' AND btrim("posterStorageKey", E' \t\n\x0B\f\r') <> ''))
    );
  END IF;
END $media_av$;

-- K4
CREATE OR REPLACE FUNCTION media_markup_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_mime TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- its own original is the CHECK's to refuse. Any other original must already be stored in the copy's project: one
    -- this row cannot see yet (a missing one, another project's, or one later in the same multi-row INSERT, round-2
    -- review) is refused here rather than left to the key, which checks existence but not the type.
    IF NEW."sourceMediaId" IS NOT NULL AND NEW."sourceMediaId" <> NEW."id" THEN
      SELECT "mime" INTO v_mime FROM "Media"
        WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceMediaId" FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'media: the file % is marked up from %, which is not a stored photo in its project', NEW."id", NEW."sourceMediaId"
          USING ERRCODE = 'check_violation';
      ELSIF v_mime NOT LIKE 'image/%' THEN
        RAISE EXCEPTION 'media: the file % is marked up from %, which is not a photo', NEW."id", NEW."sourceMediaId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."sourceMediaId" IS DISTINCT FROM OLD."sourceMediaId" THEN
    IF NOT (OLD."sourceMediaId" IS NOT NULL AND NEW."sourceMediaId" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "Media" WHERE "id" = OLD."sourceMediaId")) THEN
      RAISE EXCEPTION 'media: the file % keeps the original it was marked up from; the link is set only when the copy is made', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."mime" IS DISTINCT FROM OLD."mime" AND NEW."mime" NOT LIKE 'image/%'
     AND EXISTS (SELECT 1 FROM "Media" WHERE "projectId" = OLD."projectId" AND "sourceMediaId" = OLD."id") THEN
    RAISE EXCEPTION 'media: the file % has marked-up copies and stays a photo', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Media_markup_source" ON "Media";
CREATE TRIGGER "Media_markup_source"
  BEFORE INSERT OR UPDATE OF "sourceMediaId", "mime" ON "Media"
  FOR EACH ROW EXECUTE FUNCTION media_markup_source();
