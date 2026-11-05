-- #1118 U7a L0 (notes/hub/u7a/plan.md, Board ask #1094 6648450228): the Hub project's number and name, kept on the link
-- event that names it. A database change shipped alone, before any server code reads or writes it. Nothing is backfilled.
--
-- WHY. Once a PMC site is linked to its Hub project, the site's dashboard shows "Site Code VFP-01 · Hub 24-017" beside
-- an "Open in Hub" link. Hub's number and name are read from Hub once, when the link is made, and kept with that link
-- event, so showing them never calls Hub (a local screen never waits on another app; redbracket-portal PLATFORM.md,
-- decision 4). They are what Hub said at link time, the way "hubProjectId" is: a later rename in Hub is shown after the
-- next relink. Event rows are records (20280121300000, L3), so the label is written with its event or never.
--
-- WHAT. Two nullable text columns on "DrawingHubLinkEvent": "hubProjectNumber" and "hubProjectName". One CHECK,
-- "DrawingHubLinkEvent_hubProject_label", holds:
--   - an unlink names no Hub project, so it carries neither (as "hubProjectId" on an unlink is NULL);
--   - on a link each is optional (a Hub project may have no number), and when given it holds more than whitespace (the
--     full ASCII set, E' \t\n\x0B\f\r', as "DrawingHubLinkEvent_hubProjectId_on_link" does) and is at most 128 (number)
--     or 256 (name) characters, so a screen line stays bounded whatever Hub sends.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never writes a link event (no server code writes one before
-- U7a L1), and never names either column. ADD COLUMN on a table with a sealed BEFORE UPDATE trigger fires no trigger.
-- Existing rows (there are none in production) carry two NULLs, which pass the CHECK.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on "DrawingHubLinkEvent" until COMMIT; the
-- table is empty in production and nothing reads it yet. No lock is waited for longer than 15 s (lock_timeout, this
-- transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT. The columns are added when missing; a column already standing under
-- either name must be nullable text, or the file stops with an error rather than keep it. The CHECK is dropped and added
-- again on every run, so what the table ends with is exactly this definition, validated against every row. A db-push
-- baseline models the columns but not the CHECK, so the file is on `scripts/migrate.sh`'s ALWAYS_EXECUTE.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true);

ALTER TABLE public."DrawingHubLinkEvent" ADD COLUMN IF NOT EXISTS "hubProjectNumber" TEXT;
ALTER TABLE public."DrawingHubLinkEvent" ADD COLUMN IF NOT EXISTS "hubProjectName" TEXT;

DO $hub_link_label$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT n.name, a.atttypid::regtype::text AS typ, a.attnotnull AS notnull
      FROM (VALUES ('hubProjectNumber'), ('hubProjectName')) AS n(name)
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = 'public."DrawingHubLinkEvent"'::regclass AND a.attname = n.name AND NOT a.attisdropped
  LOOP
    IF c.typ IS DISTINCT FROM 'text' OR c.notnull THEN
      RAISE EXCEPTION 'DrawingHubLinkEvent.% already stands as % (not null: %), not a nullable text column', c.name, c.typ, c.notnull;
    END IF;
  END LOOP;
END $hub_link_label$;

ALTER TABLE public."DrawingHubLinkEvent"
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_hubProject_label",
  ADD CONSTRAINT "DrawingHubLinkEvent_hubProject_label" CHECK (
    ("kind" = 'unlinked' AND "hubProjectNumber" IS NULL AND "hubProjectName" IS NULL)
    OR ("kind" = 'linked'
        AND ("hubProjectNumber" IS NULL
             OR (pg_catalog.btrim("hubProjectNumber", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("hubProjectNumber") <= 128))
        AND ("hubProjectName" IS NULL
             OR (pg_catalog.btrim("hubProjectName", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("hubProjectName") <= 256))));

COMMIT;
