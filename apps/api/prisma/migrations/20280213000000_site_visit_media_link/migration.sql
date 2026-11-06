-- Video on site visits, V2g-0 (#995; Jagrut's choice of 6 Nov 2026, "small clip + paste a Drive link"): the database
-- half of "a visit's video clip links to its full-quality video in Google Drive or Zoho WorkDrive". The app keeps the
-- small clip; the full video stays in the cloud and its share link sits beside the clip. It ships alone, before any
-- server or screen uses it.
--
-- WHAT. One new table, "SiteVisitMediaLink": a share link on a visit's video file, who put it there (their id, the role
-- they acted in and their name as they stood) and when; and, once it is taken off or replaced, who did that, in which
-- role, under which name, when, and the reason when one was given. A file holds at most one CURRENT link (one with no
-- "endedAt"); a replace ends the current link and adds the new one in the same transaction, so every link a clip ever
-- had stays as its history. The file is a composite (projectId, mediaId) foreign key to "SiteVisitMedia", ON DELETE
-- CASCADE: a link exists only while its file is on a visit.
--
-- WHY A TABLE OF ITS OWN, OWNED BY SITE VISITS. "SiteVisitMedia" is a frozen record of what was added, by whom and when;
-- a link is added later, may be added by someone else, and may be replaced. Keeping it in its own rows leaves the file's
-- record untouched and gives the link its own who-and-when. The site-visits module owns and writes it (V2g-1).
--
-- THE ROW IS A RECORD. What the database guarantees for every writer, raw SQL included:
--   K1  Drive or Zoho only. "url" is https, on one of the allowed hosts, with nothing between "https://" and the host
--       (no userinfo) and a "/" right after it (no port), printable ASCII only (no space of any kind, no control or
--       other character, whatever the database's character settings), at most 2,000 characters. "host" is set from the
--       url ('drive' or 'zoho'), whatever the writer sent. The allowed hosts: drive.google.com (a Drive file or folder
--       share is always there; docs.google.com is left out, it also serves Forms and /url redirects),
--       workdrive.zoho.{com,in,eu} and workdrive.zohopublic.{com,in,eu}. Lowercase only: the web and the server send
--       the host as URL parsing writes it. V2g-1's shared allow-list matches this list exactly.
--   K2  A video on a visit. The file must be on a visit of the same project (the foreign key) and be a video (the media
--       module's contract, `media_mime_of`).
--   K3  Who, as they stood. The writer names the role the adder acts in; the insert checks that they hold it on the
--       project, refuses an archived project, and copies their account name, through SV1-a's
--       `site_visits_standing_name`, as a visit's file freezes its adder. The same holds for whoever ends a link.
--   K4  Stamped. "addedAt" and "endedAt" are the database's receipt time (`site_visits_now()`).
--   K5  One current link per file: a partial unique index on "mediaId" WHERE "endedAt" IS NULL. A second current link
--       is refused with 23505, which the server reads as "someone else changed this link first" (409).
--   K6  Ends once, and nothing else changes. An UPDATE may only end a current link: set "endedById" and "endedByRole"
--       (and "reason"); the database stamps "endedAt" and copies "endedByName". Every other column, and an ended link,
--       is frozen.
--   K7  A reason, or the adder's own hour (the rule a visit file's removal uses). A link ended with no reason is only
--       its adder's own, within an hour of its "addedAt". A reason is at most 300 characters and never blank.
--   K8  Never removed on its own. A row goes only with its file's link to the visit (the file's removal deletes that
--       link, recorded in "SiteVisitFileRemoval", and the cascade reaches this table below trigger depth 1), its visit
--       or its project. A direct DELETE is refused; TRUNCATE is refused outside the sanctioned reset.
--
-- A REMOVED FILE. A visit file's removal deletes its "SiteVisitMedia" row (#1179 R6/R7), so its links go with it by
-- the cascade, and a new link on it is refused by the foreign key; #1179 R9 never lets that file back on a visit. No
-- read can therefore show a link on a removed file.
--
-- LOCK ORDER. The server's writer (V2g-1) takes, in this order and never retries: the visit row FOR UPDATE (as every
-- write on a visit does), the file's "SiteVisitMedia" row FOR UPDATE, the file's current link FOR UPDATE; then it ends
-- that link and inserts the new one. The triggers below take the visit FOR KEY SHARE and the file's link FOR SHARE
-- before the writer's standing (`site_visits_standing_name`), the order a file's removal takes them in, so a raw
-- inserter that never locks the visit itself still waits behind a removal holding it. A raw UPDATE already holds its
-- own link row before its trigger runs: one that skips the visit lock may meet a concurrent removal in a deadlock,
-- which PostgreSQL detects and aborts, writing nothing.
--
-- WHAT THIS FILE DOES NOT DO. Who may add, replace or take off a link, and when (the visit's adder rule and the
-- project PMC with a reason, while the visit is not closed), and the events other viewers read, are the server unit's
-- rule (V2g-1). Nothing here fetches a link.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the table: nothing reads or writes it, and no
-- statement of the previous release changes because it exists. A file's removal and a project's removal cascade through
-- it below trigger depth 1, which K8 lets through.
--
-- LOCKS WHILE IT RUNS. A new table: its foreign keys need SHARE ROW EXCLUSIVE on "SiteVisitMedia" and "User". Both are
-- taken by ONE LOCK TABLE statement before any change, so the file never holds one while it waits for the other, and no
-- later statement needs a stronger lock on either; they are held to COMMIT of this short transaction (an empty table: no
-- rows to validate). No lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline models
-- the table but not the triggers, the check or the partial index). IF NOT EXISTS with a shape guard, constraints
-- re-issued or added when missing, functions replaced, triggers dropped and re-made. Schema-qualified, with a fixed
-- search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

LOCK TABLE public."User", public."SiteVisitMedia" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public."SiteVisitMediaLink" (
  "id"          TEXT NOT NULL,
  "projectId"   TEXT NOT NULL,
  "mediaId"     TEXT NOT NULL,
  "url"         VARCHAR(2000) NOT NULL,
  "host"        TEXT NOT NULL,
  "label"       VARCHAR(120),
  "addedById"   TEXT NOT NULL,
  "addedByRole" TEXT NOT NULL,
  "addedByName" TEXT NOT NULL DEFAULT '',
  "addedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"     TIMESTAMP(3),
  "endedById"   TEXT,
  "endedByRole" TEXT,
  "endedByName" TEXT,
  "reason"      VARCHAR(300),
  CONSTRAINT "SiteVisitMediaLink_pkey" PRIMARY KEY ("id")
);

-- A table that already stands with another shape (a db-push baseline drifted from schema.prisma) is refused, not kept:
-- its columns (type, NOT NULL, count) and its primary key.
DO $site_visit_media_link$
DECLARE
  c record;
  n integer;
  pk text;
BEGIN
  FOR c IN
    SELECT w.name, w.want_type, w.want_notnull, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull
      FROM (VALUES ('id', 'text', true), ('projectId', 'text', true), ('mediaId', 'text', true),
                   ('url', 'character varying(2000)', true), ('host', 'text', true),
                   ('label', 'character varying(120)', false), ('addedById', 'text', true),
                   ('addedByRole', 'text', true), ('addedByName', 'text', true),
                   ('addedAt', 'timestamp(3) without time zone', true),
                   ('endedAt', 'timestamp(3) without time zone', false), ('endedById', 'text', false),
                   ('endedByRole', 'text', false), ('endedByName', 'text', false),
                   ('reason', 'character varying(300)', false)) AS w(name, want_type, want_notnull)
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = 'public."SiteVisitMediaLink"'::regclass AND a.attname = w.name AND NOT a.attisdropped
  LOOP
    IF c.typ IS DISTINCT FROM c.want_type OR c.notnull IS DISTINCT FROM c.want_notnull THEN
      RAISE EXCEPTION 'SiteVisitMediaLink.% already stands as % (not null: %), not % (not null: %)',
        c.name, c.typ, c.notnull, c.want_type, c.want_notnull;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public."SiteVisitMediaLink"'::regclass AND attnum > 0 AND NOT attisdropped;
  IF n <> 15 THEN
    RAISE EXCEPTION 'SiteVisitMediaLink already stands with % columns, not 15', n;
  END IF;
  SELECT pg_catalog.string_agg(a.attname, ',' ORDER BY a.attname) INTO pk
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
   WHERE k.conrelid = 'public."SiteVisitMediaLink"'::regclass AND k.contype = 'p';
  IF pk IS DISTINCT FROM 'id' THEN
    RAISE EXCEPTION 'SiteVisitMediaLink already stands with primary key (%), not (id)', pk;
  END IF;
END $site_visit_media_link$;

-- K1, K3, K6 and K7's shape, re-issued on every run, with the whitespace set the SV1-a shape checks use.
ALTER TABLE public."SiteVisitMediaLink"
  DROP CONSTRAINT IF EXISTS "SiteVisitMediaLink_shape_check",
  ADD CONSTRAINT "SiteVisitMediaLink_shape_check" CHECK (
    "url" ~ '^https://(drive\.google\.com|workdrive\.zoho\.(com|in|eu)|workdrive\.zohopublic\.(com|in|eu))/'
    AND "url" ~ '^[\x21-\x7E]+$'
    AND "host" = CASE WHEN "url" ~ '^https://drive\.google\.com/' THEN 'drive' ELSE 'zoho' END
    AND ("label" IS NULL OR btrim("label", E' \t\n\x0B\f\r') <> '')
    AND btrim("addedByRole", E' \t\n\x0B\f\r') <> ''
    AND btrim("addedByName", E' \t\n\x0B\f\r') <> ''
    AND (
      ("endedAt" IS NULL AND "endedById" IS NULL AND "endedByRole" IS NULL AND "endedByName" IS NULL AND "reason" IS NULL)
      OR ("endedAt" IS NOT NULL AND "endedById" IS NOT NULL
          AND btrim(coalesce("endedByRole", ''), E' \t\n\x0B\f\r') <> ''
          AND btrim(coalesce("endedByName", ''), E' \t\n\x0B\f\r') <> ''
          AND ("reason" IS NULL OR btrim("reason", E' \t\n\x0B\f\r') <> '')
          AND ("reason" IS NOT NULL OR ("endedById" = "addedById" AND "endedAt" <= "addedAt" + interval '1 hour')))
    )
  );

-- K5: one current link per file.
CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitMediaLink_one_current_per_file"
  ON public."SiteVisitMediaLink"("mediaId") WHERE "endedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "SiteVisitMediaLink_projectId_mediaId_idx"
  ON public."SiteVisitMediaLink"("projectId", "mediaId");

-- The partial index is re-made when it stands under its name without its predicate or uniqueness.
DO $site_visit_media_link_index$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'SiteVisitMediaLink_one_current_per_file'
               AND indexdef IS DISTINCT FROM 'CREATE UNIQUE INDEX "SiteVisitMediaLink_one_current_per_file" ON public."SiteVisitMediaLink" USING btree ("mediaId") WHERE ("endedAt" IS NULL)') THEN
    DROP INDEX public."SiteVisitMediaLink_one_current_per_file";
    CREATE UNIQUE INDEX "SiteVisitMediaLink_one_current_per_file"
      ON public."SiteVisitMediaLink"("mediaId") WHERE "endedAt" IS NULL;
  END IF;
END $site_visit_media_link_index$;

-- A key standing under the right name with another delete action or other columns is replaced, not kept.
DO $site_visit_media_link_keys$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitMediaLink"'::regclass
               AND conname = 'SiteVisitMediaLink_projectId_mediaId_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'c' AND confrelid = 'public."SiteVisitMedia"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("projectId", "mediaId") REFERENCES "SiteVisitMedia"("projectId", "mediaId")%')) THEN
    ALTER TABLE public."SiteVisitMediaLink" DROP CONSTRAINT "SiteVisitMediaLink_projectId_mediaId_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitMediaLink"'::regclass
               AND conname = 'SiteVisitMediaLink_addedById_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'r' AND confrelid = 'public."User"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("addedById") REFERENCES "User"(id)%')) THEN
    ALTER TABLE public."SiteVisitMediaLink" DROP CONSTRAINT "SiteVisitMediaLink_addedById_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitMediaLink"'::regclass
               AND conname = 'SiteVisitMediaLink_endedById_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'r' AND confrelid = 'public."User"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("endedById") REFERENCES "User"(id)%')) THEN
    ALTER TABLE public."SiteVisitMediaLink" DROP CONSTRAINT "SiteVisitMediaLink_endedById_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitMediaLink_projectId_mediaId_fkey'
                   AND conrelid = 'public."SiteVisitMediaLink"'::regclass) THEN
    ALTER TABLE public."SiteVisitMediaLink" ADD CONSTRAINT "SiteVisitMediaLink_projectId_mediaId_fkey"
      FOREIGN KEY ("projectId", "mediaId") REFERENCES public."SiteVisitMedia"("projectId", "mediaId") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitMediaLink_addedById_fkey'
                   AND conrelid = 'public."SiteVisitMediaLink"'::regclass) THEN
    ALTER TABLE public."SiteVisitMediaLink" ADD CONSTRAINT "SiteVisitMediaLink_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitMediaLink_endedById_fkey'
                   AND conrelid = 'public."SiteVisitMediaLink"'::regclass) THEN
    ALTER TABLE public."SiteVisitMediaLink" ADD CONSTRAINT "SiteVisitMediaLink_endedById_fkey"
      FOREIGN KEY ("endedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $site_visit_media_link_keys$;

-- K1 to K4 on insert, in the lock order above: the file's visit FOR KEY SHARE, the file's link FOR SHARE, then the
-- adder's standing and frozen name, then the receipt stamp (read after the locks are held). A writer cannot add a link
-- that is already ended.
CREATE OR REPLACE FUNCTION public.site_visits_media_link_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_visit TEXT; v_mime TEXT;
BEGIN
  SELECT "visitId" INTO v_visit FROM public."SiteVisitMedia" WHERE "projectId" = NEW."projectId" AND "mediaId" = NEW."mediaId";
  IF FOUND THEN
    PERFORM 1 FROM public."SiteVisit" WHERE "projectId" = NEW."projectId" AND "id" = v_visit FOR KEY SHARE;
  END IF;
  PERFORM 1 FROM public."SiteVisitMedia" WHERE "projectId" = NEW."projectId" AND "mediaId" = NEW."mediaId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site-visits: the file % is not on a site visit of project %, so it takes no full-video link', NEW."mediaId", NEW."projectId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  v_mime := lower(coalesce(public.media_mime_of(NEW."projectId", NEW."mediaId"), ''));
  IF v_mime NOT LIKE 'video/%' THEN
    RAISE EXCEPTION 'site-visits: the file % is not a video, so it takes no full-video link', NEW."mediaId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endedAt" IS NOT NULL OR NEW."endedById" IS NOT NULL OR NEW."endedByRole" IS NOT NULL
     OR NEW."endedByName" IS NOT NULL OR NEW."reason" IS NOT NULL THEN
    RAISE EXCEPTION 'site-visits: a full-video link is added current; it is ended only by an update'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."host" := CASE WHEN NEW."url" ~ '^https://drive\.google\.com/' THEN 'drive' ELSE 'zoho' END;
  NEW."addedByName" := public.site_visits_standing_name(NEW."projectId", NEW."addedById", NEW."addedByRole", 'adder of a full-video link');
  NEW."addedAt" := public.site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMediaLink_insert" ON public."SiteVisitMediaLink";
CREATE TRIGGER "SiteVisitMediaLink_insert"
  BEFORE INSERT ON public."SiteVisitMediaLink"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_link_insert();

-- K6 and K3/K4 on end: only a current link ends, only its end columns change, and the database stamps the time and
-- copies the ender's name as they stood.
CREATE OR REPLACE FUNCTION public.site_visits_media_link_end() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_visit TEXT;
BEGIN
  IF OLD."endedAt" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."mediaId" IS DISTINCT FROM OLD."mediaId" OR NEW."url" IS DISTINCT FROM OLD."url"
     OR NEW."host" IS DISTINCT FROM OLD."host" OR NEW."label" IS DISTINCT FROM OLD."label"
     OR NEW."addedById" IS DISTINCT FROM OLD."addedById" OR NEW."addedByRole" IS DISTINCT FROM OLD."addedByRole"
     OR NEW."addedByName" IS DISTINCT FROM OLD."addedByName" OR NEW."addedAt" IS DISTINCT FROM OLD."addedAt"
     OR NEW."endedById" IS NULL OR NEW."endedByRole" IS NULL THEN
    RAISE EXCEPTION 'site-visits: the full-video link % is a record; a current link is only ended, and an ended link is not changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "visitId" INTO v_visit FROM public."SiteVisitMedia" WHERE "projectId" = OLD."projectId" AND "mediaId" = OLD."mediaId";
  IF FOUND THEN
    PERFORM 1 FROM public."SiteVisit" WHERE "projectId" = OLD."projectId" AND "id" = v_visit FOR KEY SHARE;
  END IF;
  PERFORM 1 FROM public."SiteVisitMedia" WHERE "projectId" = OLD."projectId" AND "mediaId" = OLD."mediaId" FOR SHARE;
  NEW."endedByName" := public.site_visits_standing_name(NEW."projectId", NEW."endedById", NEW."endedByRole", 'remover of a full-video link');
  NEW."endedAt" := public.site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMediaLink_end" ON public."SiteVisitMediaLink";
CREATE TRIGGER "SiteVisitMediaLink_end"
  BEFORE UPDATE ON public."SiteVisitMediaLink"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_link_end();

-- K8: a row goes only with its file's link to the visit, its visit or its project. Each is a foreign-key cascade, which
-- runs below trigger depth 1; a direct DELETE is depth 1. TRUNCATE is refused by SV1-a's seal function, which the
-- sanctioned reset disables by name.
CREATE OR REPLACE FUNCTION public.site_visits_media_link_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'site-visits: the full-video link % is part of the visit record; it goes only with its file, its visit or its project', OLD."id";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitMediaLink_no_delete" ON public."SiteVisitMediaLink";
CREATE TRIGGER "SiteVisitMediaLink_no_delete"
  BEFORE DELETE ON public."SiteVisitMediaLink"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_media_link_no_delete();

DROP TRIGGER IF EXISTS "SiteVisitMediaLink_no_truncate" ON public."SiteVisitMediaLink";
CREATE TRIGGER "SiteVisitMediaLink_no_truncate"
  BEFORE TRUNCATE ON public."SiteVisitMediaLink"
  FOR EACH STATEMENT EXECUTE FUNCTION public.site_visits_no_truncate();

COMMIT;
