-- Guided site inspections, decision 3 (5 Nov 2026, approved by Jagrut): a recording picked from the phone's gallery,
-- rather than taken in the app at the time, is allowed but labelled "from gallery" with its original date. This file
-- adds the two columns that keep that label on the file itself; a later unit writes them with each upload and the app
-- shows them. Nothing else changes here.
--
-- WHAT. Two columns on "Media":
--   "fromGallery"       BOOLEAN NOT NULL DEFAULT false: true when the file was picked from the device's gallery.
--   "galleryOriginalAt" TIMESTAMP(3) NULL: the picked file's own date as the device reported it, when it reported one.
-- A CHECK ("Media_gallery_original_needs_gallery") keeps an original date to a gallery file only. A gallery file may
-- carry no original date (a device that reports none); a camera file never carries one.
--
-- FIXED AT THE INSERT. Where a file came from is a fact of the upload, so it is taken only when the row is made: a
-- BEFORE UPDATE OF trigger ("Media_gallery_origin_fixed") refuses any change to either column, on every writer, raw SQL
-- too. A later write could otherwise relabel a gallery file as taken on site, which is the label's whole point.
-- Writing the same values again is no change. The rule is the upload source's (20280204000000).
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names either column: its Prisma client neither selects
-- nor writes them, its inserts take the default (false, NULL), which the CHECK and the trigger accept, and none of its
-- updates touch them. Every stored row reads "taken in the app", which is what the previous release offered: it had
-- no gallery label to lose.
--
-- LOCKS WHILE IT RUNS. Only "Media" is locked, once, by an explicit LOCK TABLE before any change: ACCESS EXCLUSIVE,
-- held to COMMIT. No later statement needs a stronger lock on it or any lock on another table, so the file cannot join
-- a deadlock cycle. ADD COLUMN with a constant default and ADD COLUMN with none are catalog changes (PostgreSQL 11+
-- stores a constant default without rewriting the table). The CHECK is validated by one read of the table's rows under
-- the lock already held; every stored row has the defaults (false, NULL), which pass. The trigger is a catalog change.
-- No lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- NOT NULL WITHOUT A BACKFILL STEP. "fromGallery" is NOT NULL because DEFAULT false is its backfill: PostgreSQL gives
-- every stored row the constant default at ADD COLUMN, without a rewrite. A stored row was taken through the previous
-- release, which offered no gallery label, so false ("taken in the app") is its true value.
--
-- WHAT IT DOES NOT GUARD. The trigger guards UPDATE. A raw writer that deletes a file row and inserts one again under the
-- same id could give it another label; the upload source (20280204000000) has the same edge. File rows are removed for
-- real (tombstones, site-visit file removal), so a delete guard is not added here; no writer in the app re-inserts a
-- removed id.
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the columns but not the CHECK or the trigger). IF NOT EXISTS with a shape guard, the CHECK re-issued, the
-- function replaced and the trigger dropped and re-made. Schema-qualified, with a fixed search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

LOCK TABLE public."Media" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public."Media" ADD COLUMN IF NOT EXISTS "fromGallery" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public."Media" ADD COLUMN IF NOT EXISTS "galleryOriginalAt" TIMESTAMP(3);

-- A column that already stands with another shape (a db-push baseline drifted from schema.prisma) is refused, not kept.
DO $media_gallery_origin$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT n.name, n.want_type, n.want_notnull, n.want_default,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS dflt
      FROM (VALUES ('fromGallery', 'boolean', true, 'false'),
                   ('galleryOriginalAt', 'timestamp(3) without time zone', false, NULL)) AS n(name, want_type, want_notnull, want_default)
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = 'public."Media"'::regclass AND a.attname = n.name AND NOT a.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LOOP
    IF c.typ IS DISTINCT FROM c.want_type OR c.notnull IS DISTINCT FROM c.want_notnull OR c.dflt IS DISTINCT FROM c.want_default THEN
      RAISE EXCEPTION 'Media.% already stands as % (not null: %, default: %), not % (not null: %, default: %)',
        c.name, c.typ, c.notnull, c.dflt, c.want_type, c.want_notnull, c.want_default;
    END IF;
  END LOOP;
END $media_gallery_origin$;

-- re-issued on every run, so a same-named CHECK with another definition never stands
ALTER TABLE public."Media"
  DROP CONSTRAINT IF EXISTS "Media_gallery_original_needs_gallery",
  ADD CONSTRAINT "Media_gallery_original_needs_gallery" CHECK ("galleryOriginalAt" IS NULL OR "fromGallery");

CREATE OR REPLACE FUNCTION public.media_gallery_origin_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."fromGallery" IS DISTINCT FROM OLD."fromGallery"
     OR NEW."galleryOriginalAt" IS DISTINCT FROM OLD."galleryOriginalAt" THEN
    RAISE EXCEPTION 'media: the file % keeps where it was taken from', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Media_gallery_origin_fixed" ON public."Media";
CREATE TRIGGER "Media_gallery_origin_fixed"
  BEFORE UPDATE OF "fromGallery", "galleryOriginalAt" ON public."Media"
  FOR EACH ROW EXECUTE FUNCTION public.media_gallery_origin_fixed();

COMMIT;
