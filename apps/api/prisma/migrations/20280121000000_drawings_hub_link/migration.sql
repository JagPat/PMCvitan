-- #1118 U1 (the Hub drawing link plan, notes/hub/1118-plan.md §2): the schema the Hub units build on. This is a database
-- change shipped alone, before any server code reads or writes it. Nothing here is used until a later unit, and nothing
-- is backfilled.
--
-- WHY. The Hub becomes the register for a linked project's drawings (C1-C7 in the plan). PMC then has to know which
-- project is linked to which Hub project, which Hub file and version each drawing and revision came from, which
-- versions Hub withdrew, how far a drawing's governing order has risen, which webhook deliveries it already handled,
-- and which Hub blobs it fetched into storage. None of that has a column today.
--
-- WHAT.
--   "DrawingHubLink"       one row per linked project: the Hub project it follows, who linked it and when, and when it
--                          was unlinked. Its org is the project's own (a composite key to "Project" ("orgId", "id")).
--   "HubWebhookReceipt"    one row per (org, webhook-id) Hub delivered, with its event type and what PMC did with it, so
--                          a replayed delivery is recognised whether it was applied, refused or ignored.
--   "HubVersionTombstone"  one row per (project, Hub version) Hub withdrew, with its file and, when Hub sent one, its
--                          order. A withdrawn version never governs again, whatever arrives after it.
--   "HubFetchedBlob"       one row per storage key a Hub fetch wrote, with its project and version, so the later sweep
--                          walks this ledger and never lists the bucket or touches a PMC upload.
--   "Drawing"."hubFileId"          the Hub file a drawing follows; at most one drawing per Hub file in a project.
--   "Drawing"."hubGovernedOrder"   the highest Hub order ever written for construction on the drawing (the plan's mark M).
--   "DrawingRevision"."hubVersionId"     the Hub version a revision holds; at most one revision per Hub version in a project.
--   "DrawingRevision"."hubVersionOrder"  that version's order; at most one revision per order on a drawing.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   H1  The keys above: one link per project, one receipt per (org, webhook-id), one tombstone per (project, version),
--       one ledger row per storage key (unique beside its "id"), and the three uniques on the new "Drawing"/"DrawingRevision" columns (a NULL
--       never collides, so every existing row and every PMC-issued row stays valid).
--   H2  A link's org is its project's org, and every new row names a project (or, for a receipt, an org) that exists.
--       Each goes with its project (ON DELETE CASCADE), so `project:remove` and a project delete take them as they take
--       a drawing; a receipt goes with its org.
--   H3  A Hub id, once written, never changes: "Drawing"."hubFileId", "DrawingRevision"."hubVersionId" and
--       "hubVersionOrder", and every Hub column of a tombstone and of a ledger row. Setting one on an existing row that
--       had none is refused too: a PMC drawing is never turned into a Hub one (Q1). Rows are created with their ids.
--   H4  "Drawing"."hubGovernedOrder" only rises: NULL to a value, or a value to a larger one. It is never lowered or
--       cleared, so the fact that a version once governed survives a later supersede or withdrawal (plan, re-check 6).
--   The link's own columns stay writable: U7 links, unlinks and relinks a project through that one row.
--
-- SAFE UNDER THE PREVIOUS RELEASE. Every new column is nullable with no default and every new table is unknown to the
-- previous release, so its reads and inserts are unchanged and its rows carry NULLs, which no unique judges. The H3/H4
-- triggers fire only on an UPDATE whose SET names a Hub column (UPDATE OF), which the previous release never writes, so
-- its issue, publish, refile, link and acknowledge writes never reach them. `project:remove` only deletes, and no
-- trigger here is on DELETE or TRUNCATE.
--
-- LOCKS WHILE IT RUNS. The file runs in one transaction, so every lock below is held until it commits. The new tables,
-- their keys and the two functions come first. Adding each key takes ShareRowExclusiveLock on "Project" or "Org", so
-- from then until commit, inserts, updates and deletes on those two tables wait; reads and row locks do not. The
-- statements on "Drawing" and "DrawingRevision" come last. ADD COLUMN (a catalog change, no rewrite) and DROP TRIGGER
-- take AccessExclusiveLock on each, so from then until commit every read and write of those two tables waits. The three
-- unique indexes are built inside that window, without CONCURRENTLY, which a transaction does not allow.
--
-- NAMES. Every function has search_path pg_catalog, public, pg_temp and qualified names. Re-runnable, and on
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the tables and columns but not the partial uniques
-- or the triggers. Every statement is guarded or replaces itself.

-- H1
CREATE TABLE IF NOT EXISTS public."DrawingHubLink" (
  "projectId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "hubProjectId" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "linkedBy" TEXT NOT NULL,
  "unlinkedAt" TIMESTAMP(3),
  CONSTRAINT "DrawingHubLink_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE IF NOT EXISTS public."HubWebhookReceipt" (
  "orgId" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HubWebhookReceipt_pkey" PRIMARY KEY ("orgId", "webhookId")
);

CREATE TABLE IF NOT EXISTS public."HubVersionTombstone" (
  "projectId" TEXT NOT NULL,
  "hubVersionId" TEXT NOT NULL,
  "hubFileId" TEXT NOT NULL,
  "versionSeq" INTEGER,
  "withdrawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HubVersionTombstone_pkey" PRIMARY KEY ("projectId", "hubVersionId")
);

-- Keyed by an "id" like every other table that holds a "storageKey": `project:inventory` lists a project's stored files
-- by each such table's "id" column. The storage key is unique beside it.
CREATE TABLE IF NOT EXISTS public."HubFetchedBlob" (
  "id" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "hubVersionId" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HubFetchedBlob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HubFetchedBlob_storageKey_key" ON public."HubFetchedBlob" ("storageKey");
CREATE INDEX IF NOT EXISTS "HubFetchedBlob_projectId_idx" ON public."HubFetchedBlob" ("projectId");
-- H2. Each key is added only when this table has no constraint of that name (read from its own constraints, never by
-- name alone), so a second run, or a `db push` baseline that already made it from schema.prisma, changes nothing.
DO $hub_keys$
DECLARE
  k record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('"DrawingHubLink"', 'DrawingHubLink_orgId_projectId_fkey',
       'ALTER TABLE public."DrawingHubLink" ADD CONSTRAINT "DrawingHubLink_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES public."Project"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_orgId_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES public."Org"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('"HubVersionTombstone"', 'HubVersionTombstone_projectId_fkey',
       'ALTER TABLE public."HubVersionTombstone" ADD CONSTRAINT "HubVersionTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE'),
      ('"HubFetchedBlob"', 'HubFetchedBlob_projectId_fkey',
       'ALTER TABLE public."HubFetchedBlob" ADD CONSTRAINT "HubFetchedBlob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE')
    ) AS v(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = ('public.' || k.tbl)::regclass AND contype = 'f' AND conname = k.name) THEN
      EXECUTE k.ddl;
    END IF;
  END LOOP;
END $hub_keys$;

-- H3: the trigger's arguments name the columns that never change once the row exists.
CREATE OR REPLACE FUNCTION public.drawings_hub_ids_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  col text;
  was jsonb := pg_catalog.to_jsonb(OLD);
  now_ jsonb := pg_catalog.to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF was -> col IS DISTINCT FROM now_ -> col THEN
      RAISE EXCEPTION 'drawings: %.% is a Hub id and is never changed once the row exists (from % to %)',
        TG_TABLE_NAME, col, was -> col, now_ -> col;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "HubVersionTombstone_ids_immutable" ON public."HubVersionTombstone";
CREATE TRIGGER "HubVersionTombstone_ids_immutable"
  BEFORE UPDATE OF "hubVersionId", "hubFileId", "versionSeq" ON public."HubVersionTombstone"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_ids_immutable('hubVersionId', 'hubFileId', 'versionSeq');

DROP TRIGGER IF EXISTS "HubFetchedBlob_ids_immutable" ON public."HubFetchedBlob";
CREATE TRIGGER "HubFetchedBlob_ids_immutable"
  BEFORE UPDATE OF "id", "storageKey", "hubVersionId" ON public."HubFetchedBlob"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_ids_immutable('id', 'storageKey', 'hubVersionId');

-- H4
CREATE OR REPLACE FUNCTION public.drawings_hub_mark_rises() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."hubGovernedOrder" IS NOT NULL
     AND (NEW."hubGovernedOrder" IS NULL OR NEW."hubGovernedOrder" < OLD."hubGovernedOrder") THEN
    RAISE EXCEPTION 'drawings: the Hub governed order of drawing % only rises (from % to %)',
      OLD."id", OLD."hubGovernedOrder", NEW."hubGovernedOrder";
  END IF;
  RETURN NEW;
END $$;

-- "Drawing" and "DrawingRevision" last (see LOCKS).
ALTER TABLE public."Drawing" ADD COLUMN IF NOT EXISTS "hubFileId" TEXT;
ALTER TABLE public."Drawing" ADD COLUMN IF NOT EXISTS "hubGovernedOrder" INTEGER;
ALTER TABLE public."DrawingRevision" ADD COLUMN IF NOT EXISTS "hubVersionId" TEXT;
ALTER TABLE public."DrawingRevision" ADD COLUMN IF NOT EXISTS "hubVersionOrder" INTEGER;

-- H1 (partial: Prisma cannot express them, so schema.prisma names them in comments)
CREATE UNIQUE INDEX IF NOT EXISTS "Drawing_hub_file_per_project"
  ON public."Drawing" ("projectId", "hubFileId") WHERE "hubFileId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "DrawingRevision_hub_version_per_project"
  ON public."DrawingRevision" ("projectId", "hubVersionId") WHERE "hubVersionId" IS NOT NULL;
-- H1 (schema.prisma's @@unique([drawingId, hubVersionOrder]))
CREATE UNIQUE INDEX IF NOT EXISTS "DrawingRevision_drawingId_hubVersionOrder_key"
  ON public."DrawingRevision" ("drawingId", "hubVersionOrder");

-- H3 and H4 on "Drawing" and "DrawingRevision".
DROP TRIGGER IF EXISTS "Drawing_hub_ids_immutable" ON public."Drawing";
CREATE TRIGGER "Drawing_hub_ids_immutable"
  BEFORE UPDATE OF "hubFileId" ON public."Drawing"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_ids_immutable('hubFileId');

DROP TRIGGER IF EXISTS "DrawingRevision_hub_ids_immutable" ON public."DrawingRevision";
CREATE TRIGGER "DrawingRevision_hub_ids_immutable"
  BEFORE UPDATE OF "hubVersionId", "hubVersionOrder" ON public."DrawingRevision"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_ids_immutable('hubVersionId', 'hubVersionOrder');

DROP TRIGGER IF EXISTS "Drawing_hub_mark_rises" ON public."Drawing";
CREATE TRIGGER "Drawing_hub_mark_rises"
  BEFORE UPDATE OF "hubGovernedOrder" ON public."Drawing"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_mark_rises();
