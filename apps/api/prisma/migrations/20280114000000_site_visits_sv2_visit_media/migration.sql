-- Site Visits #792 SV2, the database half of "media on a visit" (Jagrut, 19 Oct 2026: a visit should hold photos,
-- sketches, video and other files, not only times). It ships alone, before any server or screen uses it.
--
-- WHAT. One new table, "SiteVisitMedia": a file the visitor added on a visit, with an optional note (at most 500
-- characters), an optional rating of what it shows ("SiteVisitRating": fine, concern, action_needed), who added it and
-- when. The item's place is the file's own "Media"."nodeId", so it is not stored twice. One row per file ("mediaId" is
-- the key), so a file belongs to at most one visit.
-- Both links are composite (projectId, x) foreign keys, the shape every project-owned link uses, so no writer can put
-- another project's file on a visit or a file on another project's visit.
--
-- WHY A LINK TABLE ON AN EXISTING FILE. A visit item is one stored file plus a note. "Media" already carries the file,
-- its place ("nodeId"), its uploader, its camera time and location, and its offline idempotency key, and the Stage 1
-- media plan (marked-up copies, voice notes, video) extends "Media". Pointing at a "Media" row lets each of those attach
-- to a visit the same way with no further change here. "Media" itself is not altered, and the upload keeps its own
-- `media.uploaded` event, so the sealed effect catalog does not move and no operator reseal is needed at deploy.
--
-- DELETES. Removing the file removes its visit row (ON DELETE CASCADE on the media link), so the existing photo delete
-- keeps working. A visit is never deleted outside a project cascade, which takes its rows with it.
--
-- WHAT THIS FILE DOES NOT DO. Who may add a file to a visit (the visit's own visitor, while the visit is not closed)
-- is the server's rule: the site-visits module writes the row as the media upload's participant, under the visit's
-- row lock, the way an inspection writes its evidence link. No raw
-- trigger, CHECK or seal is installed, so `prisma db push` reproduces all of this and the file needs no ALWAYS_EXECUTE
-- entry in scripts/migrate.sh.
--
-- Re-runnable: every statement is guarded. One DO block, so the file is a single statement (it runs all-or-nothing
-- under Prisma, under `psql -f`, and from a test's raw executor).

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
    "addedById" TEXT NOT NULL,
    "addedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteVisitMedia_pkey" PRIMARY KEY ("mediaId")
  );
  CREATE INDEX IF NOT EXISTS "SiteVisitMedia_projectId_visitId_idx" ON "SiteVisitMedia"("projectId", "visitId");
  CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitMedia_projectId_mediaId_key" ON "SiteVisitMedia"("projectId", "mediaId");
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_visitId_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES "SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_projectId_mediaId_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES "Media"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitMedia_addedById_fkey') THEN
    ALTER TABLE "SiteVisitMedia" ADD CONSTRAINT "SiteVisitMedia_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $sv2_media$;
