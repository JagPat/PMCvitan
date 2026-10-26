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
--       "hubVersionOrder", and every Hub column of a ledger row, its project included, so a fetched blob never moves to
--       another project. Setting one on an existing row that had none is refused too: a PMC drawing is never turned into
--       a Hub one (Q1). Rows are created with their ids. A tombstone is never changed at all (H6).
--   H4  "Drawing"."hubGovernedOrder" only rises: NULL to a value, or a value to a larger one. It is never lowered or
--       cleared, so the fact that a version once governed survives a later supersede or withdrawal (plan, re-check 6).
--   H5  Every Hub row is well formed. Each required Hub id, the link's "linkedBy" and a receipt's "eventType" hold more
--       than whitespace (the full ASCII set, E' \t\n\x0B\f\r', as "manualReason" does in 20270220), and so does a Hub id on
--       "Drawing" or "DrawingRevision" once set. A receipt's outcome is 'applied', 'refused' or 'ignored'. A link is
--       never unlinked before it was linked. An order is recorded only beside its id: "hubGovernedOrder" needs
--       "hubFileId", and "hubVersionOrder" needs "hubVersionId".
--   H6  A receipt and a tombstone are records: never changed and never removed on their own. Any UPDATE is refused, a
--       direct DELETE (trigger depth 1) is refused, and TRUNCATE is refused (a statement-level seal). Each goes only with
--       its org or project, through the key's ON DELETE CASCADE, which runs below depth 1, the rule "MediaTombstone"
--       (20280117) uses. So a handled delivery is never handled again, and a withdrawn version never governs again.
--       `project:remove` disables ON DELETE triggers on the tables it empties for its own run and puts them back, as for
--       every other sealed table; the sanctioned reset lifts the two TRUNCATE seals by name ("TRUNCATE_SEALS" in
--       prisma/sanctioned-reset.ts).
--   H7  A Hub row never leaves its project: the columns that place it are never changed once it exists. A link's
--       "projectId", "orgId" and "hubProjectId" (a project follows one Hub project for life; a relink after an unlink
--       is to the same one); a Hub drawing's "id" and "projectId"; a Hub revision's "id", "projectId" and "drawingId".
--       (A ledger row's project is H3's; receipts and tombstones are never changed at all, H6.) The guard reads the Hub
--       id from the row as it was, so one UPDATE that clears the id and moves the row is refused; H3 refuses clearing
--       or setting the id at all, so a row never becomes, or stops being, a Hub row after insert. A PMC drawing or
--       revision, whose Hub id is NULL, is not judged. A change of a project's own "id" that would cascade
--       into a Hub row is refused with it, as H6 refuses it for a record.
--   The link's lifecycle columns, "linkedAt", "linkedBy" and "unlinkedAt", stay writable within H5: U7 links, unlinks
--       and relinks a project through that one row.
--
-- SAFE UNDER THE PREVIOUS RELEASE. Every new column is nullable with no default and every new table is unknown to the
-- previous release, so its reads and inserts are unchanged and its rows carry NULLs, which no unique judges. The H3/H4
-- triggers fire only on an UPDATE whose SET names a Hub column (UPDATE OF), which the previous release never writes, so
-- its issue, publish, refile, link and acknowledge writes never reach them. The H5 checks judge only the new columns,
-- which that release leaves NULL, and the new tables, which it never writes; the H6 seals are on the new tables only.
-- The H7 triggers judge only a row with a Hub id, which that release never writes, and pass any UPDATE that keeps the
-- value, so its writes to PMC drawings and revisions are unchanged.
--
-- LOCKS WHILE IT RUNS. The file runs in one transaction, so every lock below is held until it commits. The new tables,
-- their keys and checks, the five functions and the new tables' triggers come first. Adding each key takes
-- ShareRowExclusiveLock on "Project" or "Org", so from then until commit, inserts, updates and deletes on those two
-- tables wait; reads and row locks do not. Adding the new tables' checks takes AccessExclusiveLock on those four
-- tables, which nothing else uses yet. The statements on "Drawing" and "DrawingRevision" come last. ADD COLUMN (a
-- catalog change, no rewrite) and DROP TRIGGER take AccessExclusiveLock on each, so from then until commit every read
-- and write of those two tables waits. The three unique indexes are built inside that window, without CONCURRENTLY,
-- which a transaction does not allow, and the four checks on those tables are validated there too: a full read of each
-- table, with no rewrite, under the locks above. Every check is dropped and added again whenever the file runs. An
-- ordinary deploy runs it once; it runs again only when `scripts/migrate.sh` leaves it pending on a `db push` baseline
-- (ALWAYS_EXECUTE).
--
-- NAMES. Every function has search_path pg_catalog, public, pg_temp and qualified names. Re-runnable, and on
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the tables and columns but not the partial uniques,
-- the checks or the triggers. Every statement is guarded or replaces itself.

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

-- H5. Each check is dropped and added again whenever the file runs, so what the table ends with is exactly this definition,
-- validated against every row, whatever a `db push` baseline or an earlier run left under the name.
ALTER TABLE public."DrawingHubLink"
  DROP CONSTRAINT IF EXISTS "DrawingHubLink_hubProjectId_present",
  ADD CONSTRAINT "DrawingHubLink_hubProjectId_present" CHECK (pg_catalog.btrim("hubProjectId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "DrawingHubLink_linkedBy_present",
  ADD CONSTRAINT "DrawingHubLink_linkedBy_present" CHECK (pg_catalog.btrim("linkedBy", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "DrawingHubLink_unlinked_after_linked",
  ADD CONSTRAINT "DrawingHubLink_unlinked_after_linked" CHECK ("unlinkedAt" IS NULL OR "unlinkedAt" >= "linkedAt");
ALTER TABLE public."HubWebhookReceipt"
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_webhookId_present",
  ADD CONSTRAINT "HubWebhookReceipt_webhookId_present" CHECK (pg_catalog.btrim("webhookId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_eventType_present",
  ADD CONSTRAINT "HubWebhookReceipt_eventType_present" CHECK (pg_catalog.btrim("eventType", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_outcome_known",
  ADD CONSTRAINT "HubWebhookReceipt_outcome_known" CHECK ("outcome" IN ('applied', 'refused', 'ignored'));
ALTER TABLE public."HubVersionTombstone"
  DROP CONSTRAINT IF EXISTS "HubVersionTombstone_hubVersionId_present",
  ADD CONSTRAINT "HubVersionTombstone_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubVersionTombstone_hubFileId_present",
  ADD CONSTRAINT "HubVersionTombstone_hubFileId_present" CHECK (pg_catalog.btrim("hubFileId", E' \t\n\x0B\f\r') <> '');
ALTER TABLE public."HubFetchedBlob"
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_storageKey_present",
  ADD CONSTRAINT "HubFetchedBlob_storageKey_present" CHECK (pg_catalog.btrim("storageKey", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_hubVersionId_present",
  ADD CONSTRAINT "HubFetchedBlob_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> '');

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

DROP TRIGGER IF EXISTS "HubFetchedBlob_ids_immutable" ON public."HubFetchedBlob";
CREATE TRIGGER "HubFetchedBlob_ids_immutable"
  BEFORE UPDATE OF "id", "storageKey", "projectId", "hubVersionId" ON public."HubFetchedBlob"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_ids_immutable('id', 'storageKey', 'projectId', 'hubVersionId');

-- H6: the trigger's argument names what the record goes with.
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

-- H7: the first argument names the Hub id that makes the row a Hub row ('' for every row); the rest name the columns
-- that place it.
CREATE OR REPLACE FUNCTION public.drawings_hub_owner_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  was jsonb := pg_catalog.to_jsonb(OLD);
  now_ jsonb := pg_catalog.to_jsonb(NEW);
BEGIN
  IF TG_ARGV[0] <> '' AND pg_catalog.jsonb_typeof(was -> TG_ARGV[0]) IS DISTINCT FROM 'string' THEN
    RETURN NEW;
  END IF;
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    IF was -> TG_ARGV[i] IS DISTINCT FROM now_ -> TG_ARGV[i] THEN
      RAISE EXCEPTION 'drawings: %.% places a Hub row in its project and is never changed (from % to %)',
        TG_TABLE_NAME, TG_ARGV[i], was -> TG_ARGV[i], now_ -> TG_ARGV[i];
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.drawings_hub_record_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'drawings: % rows are records and are never truncated; each goes only with its %', TG_TABLE_NAME, TG_ARGV[0];
END $$;

DROP TRIGGER IF EXISTS "DrawingHubLink_owner_frozen" ON public."DrawingHubLink";
CREATE TRIGGER "DrawingHubLink_owner_frozen"
  BEFORE UPDATE OF "projectId", "orgId", "hubProjectId" ON public."DrawingHubLink"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_owner_frozen('', 'projectId', 'orgId', 'hubProjectId');

DROP TRIGGER IF EXISTS "HubWebhookReceipt_sealed" ON public."HubWebhookReceipt";
CREATE TRIGGER "HubWebhookReceipt_sealed"
  BEFORE UPDATE OR DELETE ON public."HubWebhookReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('org');
DROP TRIGGER IF EXISTS "HubWebhookReceipt_no_truncate" ON public."HubWebhookReceipt";
CREATE TRIGGER "HubWebhookReceipt_no_truncate"
  BEFORE TRUNCATE ON public."HubWebhookReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('org');

DROP TRIGGER IF EXISTS "HubVersionTombstone_sealed" ON public."HubVersionTombstone";
CREATE TRIGGER "HubVersionTombstone_sealed"
  BEFORE UPDATE OR DELETE ON public."HubVersionTombstone"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubVersionTombstone_no_truncate" ON public."HubVersionTombstone";
CREATE TRIGGER "HubVersionTombstone_no_truncate"
  BEFORE TRUNCATE ON public."HubVersionTombstone"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

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

-- H5 on "Drawing" and "DrawingRevision", dropped and added again as above (a full read of each table, under the lock
-- ADD COLUMN already holds).
ALTER TABLE public."Drawing"
  DROP CONSTRAINT IF EXISTS "Drawing_hubFileId_present",
  ADD CONSTRAINT "Drawing_hubFileId_present" CHECK ("hubFileId" IS NULL OR pg_catalog.btrim("hubFileId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "Drawing_hub_order_needs_file",
  ADD CONSTRAINT "Drawing_hub_order_needs_file" CHECK ("hubGovernedOrder" IS NULL OR "hubFileId" IS NOT NULL);
ALTER TABLE public."DrawingRevision"
  DROP CONSTRAINT IF EXISTS "DrawingRevision_hubVersionId_present",
  ADD CONSTRAINT "DrawingRevision_hubVersionId_present" CHECK ("hubVersionId" IS NULL OR pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "DrawingRevision_hub_order_needs_version",
  ADD CONSTRAINT "DrawingRevision_hub_order_needs_version" CHECK ("hubVersionOrder" IS NULL OR "hubVersionId" IS NOT NULL);

-- H3, H4 and H7 on "Drawing" and "DrawingRevision".
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

DROP TRIGGER IF EXISTS "Drawing_hub_owner_frozen" ON public."Drawing";
CREATE TRIGGER "Drawing_hub_owner_frozen"
  BEFORE UPDATE OF "id", "projectId" ON public."Drawing"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_owner_frozen('hubFileId', 'id', 'projectId');

DROP TRIGGER IF EXISTS "DrawingRevision_hub_owner_frozen" ON public."DrawingRevision";
CREATE TRIGGER "DrawingRevision_hub_owner_frozen"
  BEFORE UPDATE OF "id", "projectId", "drawingId" ON public."DrawingRevision"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_owner_frozen('hubVersionId', 'id', 'projectId', 'drawingId');
