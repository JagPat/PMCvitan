-- #1118 U1b (notes/hub/u1/r3/redesign-plan.md §3, "U1b tables and columns"): a drawing's identity, PMC's own or from
-- Hub, and the Hub records of a Hub drawing, its versions and its governing marks. The fourth Hub record unit (after
-- U1a-2 link, U1a-3 fetched blobs; U1a-1 receipts follows). A database change shipped alone, before any server code
-- reads or writes it. Nothing is backfilled: every existing drawing and revision is PMC's own.
--
-- WHY. A project linked to Hub takes its drawings from Hub (C1-C7 in notes/hub/1118-plan.md). Which drawing came from
-- Hub, which Hub file and version it holds, and which Hub version last governed it are facts PMC must never lose or
-- rewrite: a drawing's source decides who may change it, and the mark decides whether a late Hub version may govern.
-- #1135's columns on "Drawing" and "DrawingRevision" could be moved, cleared or deleted (round 3: 4381565873, a Hub
-- revision under a PMC drawing; 4381565882, a Hub drawing deleted, its mark with it). Here each fact is a record, and
-- who owns it is a key.
--
-- WHAT.
--   "Drawing"."source", "DrawingRevision"."source"  'pmc' or 'hub', fixed when the row is written; every existing row and
--                          every row the previous release writes is 'pmc' (the default).
--   "HubDrawing"           one per Hub drawing: the Hub file it follows and the Hub project it came from.
--   "HubRevision"          one per Hub revision: the Hub version it holds and that version's order on its file.
--   "HubGoverningMark"     one per Hub version written for construction on a drawing; the drawing's mark is the highest.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   I1  Source: a drawing and a revision are 'pmc' or 'hub', and a revision's source is its drawing's: a key from
--       "DrawingRevision" ("projectId", "drawingId", "source") to "Drawing" ("projectId", "id", "source"). So a PMC
--       revision never sits under a Hub drawing, nor a Hub revision under a PMC drawing (#1135 4381565873). The key
--       cascades both ways, as the revision's existing key to its drawing does, so a PMC drawing still moves to another
--       project with its revisions, as on main, whichever key's action runs first (no code in src/ moves a drawing). A
--       source never changes (I2), and a Hub drawing never moves (I4).
--   I2  Fixed: a row's source is never changed, revisions or none (a same-value write passes, as for any column). So a
--       row becomes 'hub' only by its insert.
--   I3  Complete: a 'hub' drawing commits only with its "HubDrawing", and a 'hub' revision only with its "HubRevision",
--       checked at commit by deferred constraint triggers. With I2, insert is the only way a row becomes 'hub', so the
--       two checks cover every path. A writer that asks for the check at once before writing the record is refused.
--   I4  Owners: a "HubDrawing" belongs to a 'hub' drawing, a key to "Drawing" ("projectId", "id", "source") with its own
--       source fixed at 'hub'; a "HubRevision" belongs to a "HubDrawing" (so a Hub revision's drawing is a Hub drawing)
--       and to a 'hub' revision of that drawing; a "HubGoverningMark" names a Hub version of its drawing by order. Every
--       one of these keys is RESTRICT both ways: a Hub drawing or revision is never deleted while its record exists
--       (#1135 4381565882), and no key ever moves.
--   I5  Keys: one record per Hub drawing and per Hub revision; one Hub drawing per Hub file in a project; one Hub
--       revision per Hub version in a project, and per order on a drawing; one mark per order on a drawing. The
--       (project, version, drawing, order) key is what a webhook receipt names (U1a-1), so a mark it claims is this
--       version's own.
--   I6  Records: a Hub record is never changed, never deleted on its own and never truncated; it goes only with its
--       project, through `project:remove` (L3 of 20280121300000_hub_link, the same seal). Since a mark is never removed
--       while its drawing exists, the drawing's mark, max("order"), only rises.
--   I7  Well formed: a Hub file, project and version id each hold more than whitespace (the full ASCII set, as
--       20280121300000 L6).
--
-- SAFE UNDER THE PREVIOUS RELEASE. It never names "source", so every drawing and revision it inserts is 'pmc' and
-- passes I1-I3; it never reads or writes the three new tables. Its drawing updates name columns other than "source".
-- After a later unit has written Hub drawings, the previous release's issue by number onto one is refused (I1, 23503)
-- and writes nothing; that is reachable only on a rollback past that unit.
--
-- ONE TRANSACTION. The file is BEGIN ... COMMIT itself, so it is all-or-nothing under Prisma and under `psql -f` alike.
--
-- LOCKS WHILE IT RUNS. Every lock is held until the file commits. Adding a column takes AccessExclusiveLock on "Drawing"
-- and on "DrawingRevision" (metadata only: a constant default rewrites nothing), so from then until commit every read
-- and write of drawings waits; the two unique index builds and the key's validation scan run inside that window. Adding
-- the new tables' keys takes ShareRowExclusiveLock on the tables they reference, both already held. No lock is waited
-- for longer than 15 s (lock_timeout, set for this transaction only): the file gets its locks or changes nothing.
--
-- NAMES. Every function has search_path pg_catalog, public, pg_temp and qualified names. The two seal functions are
-- shared with the other Hub record units, which declare them with the same body, so each file stands alone. Re-runnable,
-- and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the columns, tables and the new tables' keys
-- but not the checks, the revision's source key or the triggers. Every statement is guarded or replaces itself.

BEGIN;

-- A reader or writer holding "Drawing" or "DrawingRevision" open would make the column's lock wait without end, with
-- every later drawings read queued behind it; 15 s bounds the wait, and on expiry the whole file rolls back.
SELECT pg_catalog.set_config('lock_timeout', '15s', true);

-- I1: the source columns, "Drawing" first and then "DrawingRevision", the order every drawings writer locks them in.
ALTER TABLE public."Drawing" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'pmc';
ALTER TABLE public."DrawingRevision" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'pmc';

-- I1 and I4's key targets (schema.prisma's @@unique on each).
CREATE UNIQUE INDEX IF NOT EXISTS "Drawing_projectId_id_source_key"
  ON public."Drawing" ("projectId", "id", "source");
CREATE UNIQUE INDEX IF NOT EXISTS "DrawingRevision_projectId_drawingId_id_source_key"
  ON public."DrawingRevision" ("projectId", "drawingId", "id", "source");

-- I1 and I7, and each new table's fixed source. Each check is dropped and added again whenever the file runs, so what the
-- table ends with is exactly this definition, validated against every row.
ALTER TABLE public."Drawing"
  DROP CONSTRAINT IF EXISTS "Drawing_source_known",
  ADD CONSTRAINT "Drawing_source_known" CHECK ("source" IN ('pmc', 'hub'));
ALTER TABLE public."DrawingRevision"
  DROP CONSTRAINT IF EXISTS "DrawingRevision_source_known",
  ADD CONSTRAINT "DrawingRevision_source_known" CHECK ("source" IN ('pmc', 'hub'));

-- I1: a revision's source is its drawing's. Added NOT VALID and then validated, guarded on its name: a second run, or a
-- run after one that stopped between the two, validates what is there (a no-op once valid).
DO $hub_identity_source_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."DrawingRevision"'::regclass AND contype = 'f'
                    AND conname = 'DrawingRevision_projectId_drawingId_source_fkey') THEN
    ALTER TABLE public."DrawingRevision" ADD CONSTRAINT "DrawingRevision_projectId_drawingId_source_fkey"
      FOREIGN KEY ("projectId", "drawingId", "source") REFERENCES public."Drawing"("projectId", "id", "source")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $hub_identity_source_key$;
ALTER TABLE public."DrawingRevision" VALIDATE CONSTRAINT "DrawingRevision_projectId_drawingId_source_fkey";

-- I2: one function, a trigger on each table. Only an actual change is refused.
CREATE OR REPLACE FUNCTION public.drawings_source_fixed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'drawings: a % row''s source is fixed when it is written (% to %)', TG_TABLE_NAME, OLD."source", NEW."source"
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_TABLE_NAME || '_source_fixed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Drawing_source_fixed" ON public."Drawing";
CREATE TRIGGER "Drawing_source_fixed"
  BEFORE UPDATE OF "source" ON public."Drawing"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_source_fixed();
DROP TRIGGER IF EXISTS "DrawingRevision_source_fixed" ON public."DrawingRevision";
CREATE TRIGGER "DrawingRevision_source_fixed"
  BEFORE UPDATE OF "source" ON public."DrawingRevision"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_source_fixed();

-- I4 and I5: the records.
CREATE TABLE IF NOT EXISTS public."HubDrawing" (
  "projectId" TEXT NOT NULL,
  "drawingId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'hub',
  "hubFileId" TEXT NOT NULL,
  "hubProjectId" TEXT NOT NULL,
  CONSTRAINT "HubDrawing_pkey" PRIMARY KEY ("projectId", "drawingId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HubDrawing_projectId_hubFileId_key" ON public."HubDrawing" ("projectId", "hubFileId");

CREATE TABLE IF NOT EXISTS public."HubRevision" (
  "projectId" TEXT NOT NULL,
  "drawingId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'hub',
  "hubVersionId" TEXT NOT NULL,
  "hubVersionOrder" INTEGER NOT NULL,
  CONSTRAINT "HubRevision_pkey" PRIMARY KEY ("projectId", "revisionId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HubRevision_projectId_hubVersionId_key" ON public."HubRevision" ("projectId", "hubVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "HubRevision_projectId_drawingId_hubVersionOrder_key"
  ON public."HubRevision" ("projectId", "drawingId", "hubVersionOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "HubRevision_version_drawing_order_key"
  ON public."HubRevision" ("projectId", "hubVersionId", "drawingId", "hubVersionOrder");

CREATE TABLE IF NOT EXISTS public."HubGoverningMark" (
  "projectId" TEXT NOT NULL,
  "drawingId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HubGoverningMark_pkey" PRIMARY KEY ("projectId", "drawingId", "order")
);

-- I4's keys. Each is added only when its table has no foreign key of that name, so a second run, or a `db push` baseline
-- that already made it from schema.prisma, changes nothing.
DO $hub_identity_keys$
DECLARE
  k record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('"HubDrawing"', 'HubDrawing_projectId_drawingId_source_fkey',
       'ALTER TABLE public."HubDrawing" ADD CONSTRAINT "HubDrawing_projectId_drawingId_source_fkey" FOREIGN KEY ("projectId", "drawingId", "source") REFERENCES public."Drawing"("projectId", "id", "source") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('"HubRevision"', 'HubRevision_projectId_drawingId_fkey',
       'ALTER TABLE public."HubRevision" ADD CONSTRAINT "HubRevision_projectId_drawingId_fkey" FOREIGN KEY ("projectId", "drawingId") REFERENCES public."HubDrawing"("projectId", "drawingId") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('"HubRevision"', 'HubRevision_projectId_drawingId_revisionId_source_fkey',
       'ALTER TABLE public."HubRevision" ADD CONSTRAINT "HubRevision_projectId_drawingId_revisionId_source_fkey" FOREIGN KEY ("projectId", "drawingId", "revisionId", "source") REFERENCES public."DrawingRevision"("projectId", "drawingId", "id", "source") ON DELETE RESTRICT ON UPDATE RESTRICT'),
      ('"HubGoverningMark"', 'HubGoverningMark_projectId_drawingId_order_fkey',
       'ALTER TABLE public."HubGoverningMark" ADD CONSTRAINT "HubGoverningMark_projectId_drawingId_order_fkey" FOREIGN KEY ("projectId", "drawingId", "order") REFERENCES public."HubRevision"("projectId", "drawingId", "hubVersionOrder") ON DELETE RESTRICT ON UPDATE RESTRICT')
    ) AS v(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = ('public.' || k.tbl)::regclass AND contype = 'f' AND conname = k.name) THEN
      EXECUTE k.ddl;
    END IF;
  END LOOP;
END $hub_identity_keys$;

ALTER TABLE public."HubDrawing"
  DROP CONSTRAINT IF EXISTS "HubDrawing_source_hub",
  ADD CONSTRAINT "HubDrawing_source_hub" CHECK ("source" = 'hub'),
  DROP CONSTRAINT IF EXISTS "HubDrawing_hubFileId_present",
  ADD CONSTRAINT "HubDrawing_hubFileId_present" CHECK (pg_catalog.btrim("hubFileId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubDrawing_hubProjectId_present",
  ADD CONSTRAINT "HubDrawing_hubProjectId_present" CHECK (pg_catalog.btrim("hubProjectId", E' \t\n\x0B\f\r') <> '');
ALTER TABLE public."HubRevision"
  DROP CONSTRAINT IF EXISTS "HubRevision_source_hub",
  ADD CONSTRAINT "HubRevision_source_hub" CHECK ("source" = 'hub'),
  DROP CONSTRAINT IF EXISTS "HubRevision_hubVersionId_present",
  ADD CONSTRAINT "HubRevision_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> '');

-- I6: the trigger's argument names what the record goes with. Bodies identical to 20280121300000's.
CREATE OR REPLACE FUNCTION public.drawings_hub_record_sealed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'drawings: a % row is a record and is never changed', TG_TABLE_NAME;
  END IF;
  IF pg_catalog.pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'drawings: a % row is a record and is never deleted; it goes only with its %', TG_TABLE_NAME, TG_ARGV[0];
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION public.drawings_hub_record_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'drawings: % rows are records and are never truncated; each goes only with its %', TG_TABLE_NAME, TG_ARGV[0];
END $$;

DROP TRIGGER IF EXISTS "HubDrawing_sealed" ON public."HubDrawing";
CREATE TRIGGER "HubDrawing_sealed"
  BEFORE UPDATE OR DELETE ON public."HubDrawing"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubDrawing_no_truncate" ON public."HubDrawing";
CREATE TRIGGER "HubDrawing_no_truncate"
  BEFORE TRUNCATE ON public."HubDrawing"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

DROP TRIGGER IF EXISTS "HubRevision_sealed" ON public."HubRevision";
CREATE TRIGGER "HubRevision_sealed"
  BEFORE UPDATE OR DELETE ON public."HubRevision"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubRevision_no_truncate" ON public."HubRevision";
CREATE TRIGGER "HubRevision_no_truncate"
  BEFORE TRUNCATE ON public."HubRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

DROP TRIGGER IF EXISTS "HubGoverningMark_sealed" ON public."HubGoverningMark";
CREATE TRIGGER "HubGoverningMark_sealed"
  BEFORE UPDATE OR DELETE ON public."HubGoverningMark"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubGoverningMark_no_truncate" ON public."HubGoverningMark";
CREATE TRIGGER "HubGoverningMark_no_truncate"
  BEFORE TRUNCATE ON public."HubGoverningMark"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

-- I3: at commit, a 'hub' drawing still there has its record. Reads only this module's tables. A row inserted and deleted
-- in the same transaction is gone by commit and needs none.
CREATE OR REPLACE FUNCTION public.drawings_hub_drawing_has_record() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Drawing" d
              WHERE d."id" = NEW."id" AND d."source" = 'hub'
                AND NOT EXISTS (SELECT 1 FROM public."HubDrawing" h WHERE h."projectId" = d."projectId" AND h."drawingId" = d."id")) THEN
    RAISE EXCEPTION 'drawings: Hub drawing % has no HubDrawing record; a Hub drawing and its record are written together', NEW."id"
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'Drawing_hub_record';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.drawings_hub_revision_has_record() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."DrawingRevision" r
              WHERE r."id" = NEW."id" AND r."source" = 'hub'
                AND NOT EXISTS (SELECT 1 FROM public."HubRevision" h WHERE h."projectId" = r."projectId" AND h."revisionId" = r."id")) THEN
    RAISE EXCEPTION 'drawings: Hub revision % has no HubRevision record; a Hub revision and its record are written together', NEW."id"
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'DrawingRevision_hub_record';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Drawing_hub_record" ON public."Drawing";
CREATE CONSTRAINT TRIGGER "Drawing_hub_record"
  AFTER INSERT ON public."Drawing"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."source" = 'hub') EXECUTE FUNCTION public.drawings_hub_drawing_has_record();
DROP TRIGGER IF EXISTS "DrawingRevision_hub_record" ON public."DrawingRevision";
CREATE CONSTRAINT TRIGGER "DrawingRevision_hub_record"
  AFTER INSERT ON public."DrawingRevision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."source" = 'hub') EXECUTE FUNCTION public.drawings_hub_revision_has_record();

COMMIT;
