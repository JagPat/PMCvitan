-- Stage 1 media (Jagrut, 19 Oct 2026: "yes to all" on the plan for photo markup, voice notes and video, in that order,
-- site visits first). This is the plan's one database change, and it ships alone, before any server or screen uses it.
--
-- WHAT. Three nullable columns on "Media", the table every stored file already lives in:
--   "sourceMediaId"    a marked-up copy's original. Markup never edits a photo: the person's arrows and circles are
--                      saved as a NEW file that points at the one it was drawn on, so the original keeps its bytes,
--                      camera time and place.
--   "durationSec"      a voice note's or a video clip's length in whole seconds, for the play bar.
--   "posterStorageKey" a video's still frame in file storage, shown with a play button before the clip loads.
-- No new table, no trigger and no event: the upload keeps its own `media.uploaded` event, so the sealed effect catalog
-- does not move and no operator reseal is needed at deploy.
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
--
-- WIDER FILE TYPES. Which types an upload accepts (today PNG, JPEG, WebP, GIF and HEIC) is the server's upload rule;
-- "Media"."mime" has no CHECK, so audio and video need no database change here.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the columns but not the CHECK
-- or the column-list foreign key action. Every statement is guarded.

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
