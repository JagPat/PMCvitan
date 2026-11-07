-- #1393: a visit file's removal line names the file's kind (photo, voice, video or file) by the media module's own exact,
-- case-sensitive test of its type, never a lower-cased one. It ships alone; it re-issues one function and nothing else.
--
-- WHAT. `site_visits_file_removal_insert()` (20280125000000_site_visit_file_removal, R2) set "fileKind" from
-- lower(media_mime_of(...)) LIKE 'image/%' / 'audio/%' / 'video/%'. lower() follows the database's locale for some
-- letters: on PostgreSQL 16 with a C.UTF-8 database, lower('vİdeo/webm') is 'video/webm' (U+0130 lowers to "i"); and
-- lower('VIDEO/webm') is 'video/webm' under any locale. The
-- media module calls a file a photo, a voice note or a video only on the exact prefix (`media.service.ts` startsWith
-- 'image/', 'audio/', 'video/'; "Media_av_shape_check" LIKE 'video/%'), so a type a raw writer stored as 'VIDEO/webm'
-- was labelled a video on its removal line while the media module treats it as no video. The function below is the
-- deployed one with that one change: the type is matched as stored. V2g-0 (#1389) makes the same exact match.
--
-- WHAT IT DOES NOT DO. The label is all that changes: no access rule, lock or guarantee reads "fileKind". Lines already
-- written are frozen ("SiteVisitFileRemoval_frozen") and stay as written; every server upload stores its type as the
-- media module checked it, so no line written through the server is labelled differently by the exact match. The
-- deployed migration is never edited.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The function's name, signature, trigger, lock order and every other field it sets are
-- unchanged; the previous release writes the same rows and reads the same labels. CREATE OR REPLACE re-runs as a no-op.

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
  -- #1393: the type as stored, matched by the media module's exact, case-sensitive prefixes (no lower())
  v_mime := coalesce(public.media_mime_of(NEW."projectId", NEW."mediaId"), '');
  NEW."fileKind" := CASE
    WHEN v_mime LIKE 'image/%' THEN 'photo'
    WHEN v_mime LIKE 'audio/%' THEN 'voice'
    WHEN v_mime LIKE 'video/%' THEN 'video'
    ELSE 'file' END;
  NEW."removedByName" := public.site_visits_standing_name(NEW."projectId", NEW."removedById", NEW."removedByRole", 'remover of a file');
  NEW."removedAt" := public.site_visits_now();
  RETURN NEW;
END $$;
