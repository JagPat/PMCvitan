-- Site Visits #792 SV2, the database half of "media on a visit" (Jagrut, 19 Oct 2026: a visit should hold photos,
-- sketches, video and other files, not only times). It ships alone, before any server or screen uses it.
--
-- WHAT. One new table, "SiteVisitMedia": a file added on a visit, with an optional note (at most 500 characters, never
-- blank), an optional rating of what it shows ("SiteVisitRating": fine, concern, action_needed), the place it showed
-- when it was added, who added it and when. One row per file ("mediaId" is the key), so a file belongs to at most one
-- visit. Every link is a composite (projectId, x) foreign key, the shape every project-owned link uses, so no writer
-- can put another project's file on a visit, a file on another project's visit, or another project's place on a row.
--
-- WHY A LINK TABLE ON AN EXISTING FILE. "Media" already carries the file, its uploader, its camera time and location,
-- and its offline idempotency key, and the Stage 1 media plan (marked-up copies, voice notes, video) extends "Media".
-- Pointing at a "Media" row lets each of those attach to a visit the same way with no further change here. "Media"
-- itself is not altered, and the upload keeps its own `media.uploaded` event, so the sealed effect catalog does not
-- move and no operator reseal is needed at deploy.
--
-- THE ROW IS A RECORD (round-1 review). What the database guarantees for every writer, raw SQL included:
--   M1  Stamped. "addedAt" is the database's receipt time, whatever the writer sent.
--   M2  Placed at the visit. "nodeId" and "placeName" are copied, at insert, from the file's own place under a share
--       lock on the file and the place: a published place gives both, no place or an unpublished draft gives neither.
--       A later refile or unfile of the file ("Media"."nodeId") does not move the visit's record of where it was.
--   M3  Frozen. Nothing in a row changes after it is written, with one exception: removing the place clears "nodeId"
--       through its own foreign key's `ON DELETE SET NULL ("nodeId")` action, and "placeName" keeps the name it had.
--   M4  Never blank. A note, when there is one, holds a non-whitespace character; a row names a place only with a name.
--
-- DELETES. Removing the file removes its visit row (ON DELETE CASCADE on the media link), so the existing photo delete
-- keeps working. A visit is never deleted outside a project cascade, which takes its rows with it.
--
-- WHAT THIS FILE DOES NOT DO. Who may add a file to a visit (Jagrut, 19 Oct: the visitor and anyone recorded as present
-- on it, while the visit is not closed) is the server unit's rule: the site-visits module writes the row as the media
-- upload's participant, under the visit's row lock, the way an inspection writes its evidence link.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table but not the
-- triggers, the CHECK or the column-list foreign key action. Every statement is guarded.

DO $sv2_media$
BEGIN
  -- `to_regtype`, schema-qualified, as 20270920000000_decision_option_kinds does: a same-named type in another schema
  -- must not satisfy the guard.
  IF to_regtype('public."SiteVisitRating"') IS NULL THEN
    CREATE TYPE public."SiteVisitRating" AS ENUM ('fine', 'concern', 'action_needed');
  END IF;
  CREATE TABLE IF NOT EXISTS "SiteVisitMedia" (
    "projectId" TEXT NOT NULL,
    "visitId"   TEXT NOT NULL,
    "mediaId"   TEXT NOT NULL,
    "note"      VARCHAR(500),
    "rating"    public."SiteVisitRating",
    "nodeId"    TEXT,
    "placeName" TEXT NOT NULL DEFAULT '',
    "addedById" TEXT NOT NULL,
    "addedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteVisitMedia_pkey" PRIMARY KEY ("mediaId")
  );
  CREATE INDEX IF NOT EXISTS "SiteVisitMedia_projectId_visitId_idx" ON "SiteVisitMedia"("projectId", "visitId");
  CREATE INDEX IF NOT EXISTS "SiteVisitMedia_nodeId_idx" ON "SiteVisitMedia"("nodeId");
  CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitMedia_projectId_mediaId_key" ON "SiteVisitMedia"("projectId", "mediaId");
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_visitId_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES "SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_mediaId_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES "Media"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  -- M3: a `db push` baseline creates this key as NO ACTION, since Prisma cannot express the column-list form; the key
  -- is judged by its delete action and replaced when that is not SET NULL of the place column alone (as SV1-a does).
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_nodeId_fkey'
                AND NOT (confdeltype = 'n' AND confdelsetcols IS NOT NULL)) THEN
    ALTER TABLE "SiteVisitMedia" DROP CONSTRAINT "SiteVisitMedia_projectId_nodeId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_nodeId_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_projectId_nodeId_fkey"
      FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id")
      ON DELETE SET NULL ("nodeId") ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_addedById_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  -- M4, with the whitespace set the SV1-a shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_shape_check') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_shape_check" CHECK (
      ("note" IS NULL OR btrim("note", E' \t\n\x0B\f\r') <> '')
      AND ("placeName" = '' OR btrim("placeName", E' \t\n\x0B\f\r') <> '')
      AND ("nodeId" IS NULL OR "placeName" <> '')
    );
  END IF;
END $sv2_media$;

-- M1 + M2: the receipt stamp and the visit-time place, set on every insert whatever the writer sent. The file row is
-- share-locked first, then its place, so a concurrent refile or unfile waits for this row or is seen by it.
CREATE OR REPLACE FUNCTION site_visits_media_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_node TEXT; v_name TEXT; v_published TIMESTAMP(3);
BEGIN
  SELECT "nodeId" INTO v_node FROM "Media" WHERE "projectId" = NEW."projectId" AND "id" = NEW."mediaId" FOR SHARE;
  NEW."nodeId" := NULL;
  NEW."placeName" := '';
  IF v_node IS NOT NULL THEN
    SELECT "name", "publishedAt" INTO v_name, v_published
      FROM "ProjectNode" WHERE "projectId" = NEW."projectId" AND "id" = v_node FOR SHARE;
    IF FOUND AND v_published IS NOT NULL AND btrim(v_name, E' \t\n\x0B\f\r') <> '' THEN
      NEW."nodeId" := v_node;
      NEW."placeName" := v_name;
    END IF;
  END IF;
  NEW."addedAt" := site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMedia_insert" ON "SiteVisitMedia";
CREATE TRIGGER "SiteVisitMedia_insert"
  BEFORE INSERT ON "SiteVisitMedia"
  FOR EACH ROW EXECUTE FUNCTION site_visits_media_insert();

-- M3: frozen, except the place foreign key's own SET NULL action (below trigger depth 1) clearing "nodeId" alone.
CREATE OR REPLACE FUNCTION site_visits_media_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND OLD."nodeId" IS NOT NULL AND NEW."nodeId" IS NULL
     AND to_jsonb(NEW) = (to_jsonb(OLD) || jsonb_build_object('nodeId', NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'site-visits: the file % on visit % is a record and is not changed', OLD."mediaId", OLD."visitId";
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMedia_update" ON "SiteVisitMedia";
CREATE TRIGGER "SiteVisitMedia_update"
  BEFORE UPDATE ON "SiteVisitMedia"
  FOR EACH ROW EXECUTE FUNCTION site_visits_media_update();
