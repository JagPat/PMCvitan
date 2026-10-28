-- Site Visits #1179 R1, the database half of "remove a mistaken or misused visit file" (Jagrut, 27 Oct 2026: the person
-- who added a voice note, video or photo on a visit may remove it within an hour; the project's PMC may remove any, with
-- a reason, and the visit keeps a line saying who removed what and why). It ships alone, before any server or screen
-- uses it.
--
-- WHAT. One new table, "SiteVisitFileRemoval": one row per file taken off a visit, holding what kind of file it was, who
-- added it and when (copied from the file's link), who removed it, in which role, under which name, when, and the
-- reason when one was given. Its key is the file ("mediaId"), so a file is removed at most once. Its visit is a
-- composite (projectId, visitId) foreign key, ON DELETE CASCADE, so the record goes with its visit's project and nothing
-- else. There is no key to "Media": the record outlives the file it describes.
--
-- THE ROW IS A RECORD. What the database guarantees for every writer, raw SQL included:
--   R1  Copied from the link. "visitId", "addedById", "addedByRole", "addedByName" and "addedAt" are taken from the
--       file's live "SiteVisitMedia" row, share-locked under its visit's row lock and the file's own row lock, whatever
--       the writer sent; a file not on a visit is refused.
--   R2  The kind is the file's. "fileKind" is read from the media module's contract, `media_mime_of`: photo, voice,
--       video, or file for anything else, whatever the writer sent.
--   R3  Who removed it, as they stood. The writer names the role the remover acts in; the insert checks that they hold
--       it on the project (archived projects refuse) and copies their account name, through SV1-a's
--       `site_visits_standing_name`, as a file's adder is frozen.
--   R4  Stamped. "removedAt" is the database's time.
--   R5  A reason, or the adder's own hour. A row with no reason is only the adder's own removal, within an hour of the
--       link's "addedAt" (both stamped by the database, so the CHECK reads the database's clock). A reason is at most 300
--       characters and never blank.
--   R6  The file really goes. A row commits only if its file's link is gone by the end of its transaction (a deferred
--       constraint trigger), so no visit shows a file both present and removed.
--   R7  A link goes only with its record. A file's link that its file's delete would cascade away, while its visit and
--       project stand, is refused unless this table holds the file's record ("SiteVisitMedia_removal_recorded"), so every
--       writer that removes a visit file leaves the line. The project's own removal (the project row, or the visit, is
--       already gone) is untouched, and so is the sanctioned reset.
--   R8  Frozen. A row is never changed, never deleted on its own (it goes with its visit), never truncated outside the
--       sanctioned reset.
--   L1  One lock order for every writer. A file's link insert waits for its visit's row (FOR KEY SHARE, what its
--       foreign key takes anyway) before any other lock ("SiteVisitMedia_00_visit_lock", first in name order), so a
--       raw writer that never locks the visit itself still queues behind a removal holding it rather than taking the
--       adder's identity first and deadlocking against that removal's standing check (Codex round 2).
--   R9  Removed once, for good. A file that has a record is never put on a visit again ("SiteVisitMedia_not_removed"),
--       so a file id recreated after its removal cannot borrow the old record to leave without its own line.
--
-- PREVIOUS RELEASE. The serving release refuses every delete of a file that is on a visit, in its server
-- (`SiteVisitFilesParticipant.assertMediaDisposable`), before any statement; R7's refusal sits on a path it never takes,
-- and nothing it does reads or writes this table.
--
-- NAMES. Every function names its tables in public and runs with search_path pg_catalog, public, pg_temp, so a
-- writer's search_path or temporary table can neither hide a link or a record from these checks nor stand in for one.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table but not the
-- triggers or the CHECK. Every statement is guarded or replaces itself. `prisma migrate deploy` applies the file as one
-- transaction; a plain `psql -f` without --single-transaction does not, and a re-run completes what a stopped run left.

DO $sv_removal$
BEGIN
  CREATE TABLE IF NOT EXISTS public."SiteVisitFileRemoval" (
    "projectId"     TEXT NOT NULL,
    "visitId"       TEXT NOT NULL,
    "mediaId"       TEXT NOT NULL,
    "fileKind"      TEXT NOT NULL DEFAULT 'file',
    "addedById"     TEXT NOT NULL,
    "addedByRole"   TEXT NOT NULL DEFAULT '',
    "addedByName"   TEXT NOT NULL DEFAULT '',
    "addedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById"   TEXT NOT NULL,
    "removedByRole" TEXT NOT NULL,
    "removedByName" TEXT NOT NULL DEFAULT '',
    "reason"        VARCHAR(300),
    "removedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteVisitFileRemoval_pkey" PRIMARY KEY ("mediaId")
  );
  CREATE INDEX IF NOT EXISTS "SiteVisitFileRemoval_projectId_visitId_idx" ON public."SiteVisitFileRemoval"("projectId", "visitId");
  CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitFileRemoval_projectId_mediaId_key" ON public."SiteVisitFileRemoval"("projectId", "mediaId");
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."SiteVisitFileRemoval"'::regclass AND conname = 'SiteVisitFileRemoval_projectId_visitId_fkey') THEN
    ALTER TABLE public."SiteVisitFileRemoval" ADD CONSTRAINT "SiteVisitFileRemoval_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES public."SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."SiteVisitFileRemoval"'::regclass AND conname = 'SiteVisitFileRemoval_addedById_fkey') THEN
    ALTER TABLE public."SiteVisitFileRemoval" ADD CONSTRAINT "SiteVisitFileRemoval_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."SiteVisitFileRemoval"'::regclass AND conname = 'SiteVisitFileRemoval_removedById_fkey') THEN
    ALTER TABLE public."SiteVisitFileRemoval" ADD CONSTRAINT "SiteVisitFileRemoval_removedById_fkey"
      FOREIGN KEY ("removedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  -- R2, R3 and R5, with the whitespace set the SV1-a and SV2 shape checks use
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public."SiteVisitFileRemoval"'::regclass AND conname = 'SiteVisitFileRemoval_shape_check') THEN
    ALTER TABLE public."SiteVisitFileRemoval" ADD CONSTRAINT "SiteVisitFileRemoval_shape_check" CHECK (
      "fileKind" IN ('photo', 'voice', 'video', 'file')
      AND btrim("addedByRole", E' \t\n\x0B\f\r') <> ''
      AND btrim("addedByName", E' \t\n\x0B\f\r') <> ''
      AND btrim("removedByRole", E' \t\n\x0B\f\r') <> ''
      AND btrim("removedByName", E' \t\n\x0B\f\r') <> ''
      AND ("reason" IS NULL OR btrim("reason", E' \t\n\x0B\f\r') <> '')
      AND ("reason" IS NOT NULL OR ("removedById" = "addedById" AND "removedAt" <= "addedAt" + interval '1 hour'))
    );
  END IF;
END $sv_removal$;

-- The media module's database contract: a file's stored type, read as of the statement. NULL when it is not a file of
-- the project. A later change to how media stores its type changes it here.
CREATE OR REPLACE FUNCTION public.media_mime_of(p_project TEXT, p_media TEXT)
RETURNS TEXT LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT "mime" FROM public."Media" WHERE "projectId" = p_project AND "id" = p_media;
$$;

-- R1 to R4, in the order every other write on a visit takes its locks: the visit row FOR UPDATE first (as a file's add,
-- an attendee's or a place's does, under the visit lock), then the file's "Media" row FOR UPDATE, then the file's link,
-- then the remover's standing, the project row and identity (`site_visits_standing_name`). The "Media" row comes before
-- the link because a delete of the file locks it first and then cascades to the link: holding the link first would
-- wait on that delete while it waited on the link (Codex, round 1), even though R7 would refuse that delete. Taking the project row or identity before the visit would
-- invert that order and deadlock against another write on the same visit (gap-check F2). The link's visit is read
-- unlocked to find which visit to lock; a link is frozen, so its visit cannot change after. A second removal of the
-- same file waits on the visit, then finds no link and is refused.
CREATE OR REPLACE FUNCTION public.site_visits_file_removal_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_visit TEXT; v_link RECORD; v_mime TEXT;
BEGIN
  SELECT "visitId" INTO v_visit FROM public."SiteVisitMedia" WHERE "projectId" = NEW."projectId" AND "mediaId" = NEW."mediaId";
  IF FOUND THEN
    PERFORM 1 FROM public."SiteVisit" WHERE "projectId" = NEW."projectId" AND "id" = v_visit FOR UPDATE;
  END IF;
  PERFORM 1 FROM public."Media" WHERE "projectId" = NEW."projectId" AND "id" = NEW."mediaId" FOR UPDATE;
  SELECT "visitId", "addedById", "addedByRole", "addedByName", "addedAt" INTO v_link
    FROM public."SiteVisitMedia" WHERE "projectId" = NEW."projectId" AND "mediaId" = NEW."mediaId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site-visits: the file % is not on a site visit of project %, so it has no removal to record', NEW."mediaId", NEW."projectId";
  END IF;
  NEW."visitId" := v_link."visitId";
  NEW."addedById" := v_link."addedById";
  NEW."addedByRole" := v_link."addedByRole";
  NEW."addedByName" := v_link."addedByName";
  NEW."addedAt" := v_link."addedAt";
  v_mime := lower(coalesce(public.media_mime_of(NEW."projectId", NEW."mediaId"), ''));
  NEW."fileKind" := CASE
    WHEN v_mime LIKE 'image/%' THEN 'photo'
    WHEN v_mime LIKE 'audio/%' THEN 'voice'
    WHEN v_mime LIKE 'video/%' THEN 'video'
    ELSE 'file' END;
  NEW."removedByName" := public.site_visits_standing_name(NEW."projectId", NEW."removedById", NEW."removedByRole", 'remover of a file');
  NEW."removedAt" := public.site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitFileRemoval_insert" ON public."SiteVisitFileRemoval";
CREATE TRIGGER "SiteVisitFileRemoval_insert"
  BEFORE INSERT ON public."SiteVisitFileRemoval"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_file_removal_insert();

-- R6: at commit, the file's link is gone.
CREATE OR REPLACE FUNCTION public.site_visits_file_removal_done() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."SiteVisitMedia" WHERE "projectId" = NEW."projectId" AND "mediaId" = NEW."mediaId") THEN
    RAISE EXCEPTION 'site-visits: the removal of file % was recorded but the file is still on visit %', NEW."mediaId", NEW."visitId";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitFileRemoval_done" ON public."SiteVisitFileRemoval";
CREATE CONSTRAINT TRIGGER "SiteVisitFileRemoval_done"
  AFTER INSERT ON public."SiteVisitFileRemoval"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_file_removal_done();

-- R8: frozen; a row goes only with its visit (the visit's own cascade, below trigger depth 1).
CREATE OR REPLACE FUNCTION public.site_visits_file_removal_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'site-visits: the removal of file % from visit % is part of the visit record and is not changed or removed',
    OLD."mediaId", OLD."visitId";
END $$;

DROP TRIGGER IF EXISTS "SiteVisitFileRemoval_frozen" ON public."SiteVisitFileRemoval";
CREATE TRIGGER "SiteVisitFileRemoval_frozen"
  BEFORE UPDATE OR DELETE ON public."SiteVisitFileRemoval"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_file_removal_frozen();

DROP TRIGGER IF EXISTS "SiteVisitFileRemoval_no_truncate" ON public."SiteVisitFileRemoval";
CREATE TRIGGER "SiteVisitFileRemoval_no_truncate"
  BEFORE TRUNCATE ON public."SiteVisitFileRemoval"
  FOR EACH STATEMENT EXECUTE FUNCTION public.site_visits_no_truncate();

-- R7: a link cascaded away by its file's delete, while its project and visit stand, needs its record. A direct DELETE
-- is refused before this by SV2's "SiteVisitMedia_no_delete" (trigger depth 1, and BEFORE triggers fire in name order).
-- A project's removal deletes the project row (or the visit) before its cascade reaches the link, so neither is found
-- here and the link goes. (Today "Media"'s project key is RESTRICT, so a project holding files is never deleted by a
-- plain DELETE; `project:remove` lifts this trigger with the others. The project test stays as the fail-safe for any
-- later cascade.)
CREATE OR REPLACE FUNCTION public.site_visits_media_removal_recorded() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Project" WHERE "id" = OLD."projectId")
     AND EXISTS (SELECT 1 FROM public."SiteVisit" WHERE "projectId" = OLD."projectId" AND "id" = OLD."visitId")
     AND NOT EXISTS (SELECT 1 FROM public."SiteVisitFileRemoval" WHERE "projectId" = OLD."projectId" AND "mediaId" = OLD."mediaId") THEN
    RAISE EXCEPTION 'site-visits: the file % is on visit %; it is removed only with a record of who removed it',
      OLD."mediaId", OLD."visitId";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMedia_removal_recorded" ON public."SiteVisitMedia";
CREATE TRIGGER "SiteVisitMedia_removal_recorded"
  BEFORE DELETE ON public."SiteVisitMedia"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_removal_recorded();

-- R9: a removed file is never linked again. A raw writer can recreate a "Media" row under a removed file's id; without
-- this, its new link would find the old record in R7 and cascade away with no line of its own.
CREATE OR REPLACE FUNCTION public.site_visits_media_not_removed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."SiteVisitFileRemoval" WHERE "mediaId" = NEW."mediaId") THEN
    RAISE EXCEPTION 'site-visits: the file % was removed from a site visit and is not added to one again', NEW."mediaId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMedia_not_removed" ON public."SiteVisitMedia";
CREATE TRIGGER "SiteVisitMedia_not_removed"
  BEFORE INSERT ON public."SiteVisitMedia"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_not_removed();

-- L1: a link insert takes its visit's row before its own trigger takes a place, a file or the adder's identity, so
-- it waits behind a removal (or any write) holding the visit FOR UPDATE instead of forming a cycle with it. The
-- server already holds the visit FOR UPDATE here, so for it this is a no-op.
CREATE OR REPLACE FUNCTION public.site_visits_media_visit_lock() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public."SiteVisit" WHERE "projectId" = NEW."projectId" AND "id" = NEW."visitId" FOR KEY SHARE;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMedia_00_visit_lock" ON public."SiteVisitMedia";
CREATE TRIGGER "SiteVisitMedia_00_visit_lock"
  BEFORE INSERT ON public."SiteVisitMedia"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_visit_lock();
