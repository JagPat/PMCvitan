-- #1118 U1a (notes/hub/u1/r3/redesign-plan.md, replacing #1135): the Hub records the later units build on, the inbound
-- and link ledger. A database change shipped alone, before any server code reads or writes it. Nothing is backfilled.
--
-- WHY. The Hub becomes the register for a linked project's drawings (C1-C7 in notes/hub/1118-plan.md). PMC has to know
-- which webhook deliveries it already handled, which Hub versions were withdrawn, which project is linked to which Hub
-- project (and who linked or unlinked it, when), and which Hub blobs it fetched into storage. #1135 kept these as rows
-- that could change and closed each way of changing them with its own trigger; each review found the next way. Here
-- every one is a record: written once, never changed, and removed only with its project or org.
--
-- WHAT.
--   "HubWebhookReceipt"    one per (org, webhook-id) Hub delivered, with its event type and what PMC did with it.
--   "HubVersionTombstone"  one per (project, Hub version) Hub withdrew, with its file and, when Hub sent one, its order.
--   "DrawingHubLink"       one per project that has ever been linked to Hub, with its org (the project's own). It names
--                          no Hub project, holds no lifecycle and records no one: who linked or unlinked the project,
--                          and when, is its events' alone (event 1 is the first link), so there is one answer.
--   "DrawingHubLinkEvent"  the project's link history, one row per link or unlink, in order. Event 1 is a link; links and
--                          unlinks alternate; each link names the Hub project. The active link is the latest event when
--                          it is a link. A project with no event is not linked (fail closed).
--   "HubFetchedBlob"       one per storage key a Hub fetch wrote, with its project and version, so the later sweep walks
--                          this ledger and never lists the bucket or touches a PMC upload.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   R1  Keys: one receipt per (org, webhook-id), one tombstone per (project, version), one link per project, one event
--       per (project, seq), one ledger row per storage key (unique beside its "id").
--   R2  Owners: a link's org is its project's org (a composite key to "Project" ("orgId", "id")); an event belongs to its
--       project's link; every other row names a project, or for a receipt an org, that exists. Each goes with its
--       project or org (ON DELETE CASCADE). No key ever moves (ON UPDATE NO ACTION, and R3).
--   R3  Records: a receipt, a tombstone, a link and an event are never changed, never deleted on their own and never
--       truncated. Any UPDATE is refused; a direct DELETE (trigger depth 1) is refused; TRUNCATE is refused (a statement
--       seal). Each goes only by its owner's cascade, which runs below depth 1, the rule "MediaTombstone" (20280117)
--       uses. `project:remove` turns off the ON DELETE triggers of the tables it empties for its own run, as for every
--       sealed table, and the sanctioned reset lifts the TRUNCATE seals by name ("TRUNCATE_SEALS" in
--       prisma/sanctioned-reset.ts). A ledger row is never changed either (UPDATE refused, so its project and key can
--       never move together); the sweep's DELETE of a ledger row is its one designed delete.
--   R4  The link history is a chain by its keys and checks alone: event 1 has no previous event, every later event names
--       the one before it (a key to the same project's event "seq" - 1; the check compares with IS NOT DISTINCT FROM, so
--       a NULL "prevSeq" on a later event is refused rather than passing as unknown, and the key then always applies), odd events are links and even events unlinks,
--       a link names a Hub project and an unlink names none. So the history is never rewritten, has no gap, and never
--       holds two links or two unlinks in a row.
--   R5  Well formed: every required id (a ledger row's "id" too), an event's "by" and a receipt's "eventType" hold more than whitespace
--       (the full ASCII set, E' \t\n\x0B\f\r', as "manualReason" does in 20270220); a receipt's outcome is 'applied',
--       'refused' or 'ignored'; a ledger key starts with its own project's Hub prefix, "projectId" || '/drawings/hub/'
--       (`starts_with`, which has no wildcards), and names something after it.
--
-- SAFE UNDER THE PREVIOUS RELEASE. Every table here is new, so the previous release never reads or writes one; no
-- existing table, column, index or trigger changes.
--
-- ONE TRANSACTION. The file is BEGIN ... COMMIT itself, so it is all-or-nothing under Prisma and under `psql -f` alike:
-- a failure anywhere leaves nothing of it, and a replay's DROP TRIGGER and its CREATE TRIGGER commit together, so no
-- writer ever sees a record table without its seal.
--
-- LOCKS WHILE IT RUNS. Every lock is held until the file commits. Adding each key to
-- "Project" or "Org" takes ShareRowExclusiveLock on that table, so from then until commit inserts, updates and deletes
-- on those two tables wait; reads and row locks do not. Everything else is on the new tables, which nothing uses yet.
--
-- NAMES. Both functions have search_path pg_catalog, public, pg_temp and qualified names. Re-runnable, and on
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the tables and keys but not the checks or the
-- triggers. Every statement is guarded or replaces itself.

BEGIN;

-- R1
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

CREATE TABLE IF NOT EXISTS public."DrawingHubLink" (
  "projectId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  CONSTRAINT "DrawingHubLink_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE IF NOT EXISTS public."DrawingHubLinkEvent" (
  "projectId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "prevSeq" INTEGER,
  "kind" TEXT NOT NULL,
  "hubProjectId" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "by" TEXT NOT NULL,
  CONSTRAINT "DrawingHubLinkEvent_pkey" PRIMARY KEY ("projectId", "seq")
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

-- R2 and R4's keys. Each is added only when its table has no foreign key of that name (read from the table's own
-- constraints), so a second run, or a `db push` baseline that already made it from schema.prisma, changes nothing.
DO $hub_keys$
DECLARE
  k record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_orgId_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES public."Org"("id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"HubVersionTombstone"', 'HubVersionTombstone_projectId_fkey',
       'ALTER TABLE public."HubVersionTombstone" ADD CONSTRAINT "HubVersionTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"DrawingHubLink"', 'DrawingHubLink_orgId_projectId_fkey',
       'ALTER TABLE public."DrawingHubLink" ADD CONSTRAINT "DrawingHubLink_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES public."Project"("orgId", "id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"DrawingHubLinkEvent"', 'DrawingHubLinkEvent_projectId_fkey',
       'ALTER TABLE public."DrawingHubLinkEvent" ADD CONSTRAINT "DrawingHubLinkEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."DrawingHubLink"("projectId") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"DrawingHubLinkEvent"', 'DrawingHubLinkEvent_projectId_prevSeq_fkey',
       'ALTER TABLE public."DrawingHubLinkEvent" ADD CONSTRAINT "DrawingHubLinkEvent_projectId_prevSeq_fkey" FOREIGN KEY ("projectId", "prevSeq") REFERENCES public."DrawingHubLinkEvent"("projectId", "seq") ON DELETE NO ACTION ON UPDATE NO ACTION'),
      ('"HubFetchedBlob"', 'HubFetchedBlob_projectId_fkey',
       'ALTER TABLE public."HubFetchedBlob" ADD CONSTRAINT "HubFetchedBlob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
    ) AS v(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = ('public.' || k.tbl)::regclass AND contype = 'f' AND conname = k.name) THEN
      EXECUTE k.ddl;
    END IF;
  END LOOP;
END $hub_keys$;

-- R4 and R5. Each check is dropped and added again whenever the file runs, so what the table ends with is exactly this
-- definition, validated against every row, whatever a `db push` baseline or an earlier run left under the name.
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
ALTER TABLE public."DrawingHubLinkEvent"
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_chain",
  ADD CONSTRAINT "DrawingHubLinkEvent_chain" CHECK ("seq" >= 1 AND "prevSeq" IS NOT DISTINCT FROM NULLIF("seq" - 1, 0)),
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_kind_alternates",
  ADD CONSTRAINT "DrawingHubLinkEvent_kind_alternates" CHECK ("kind" = CASE WHEN "seq" % 2 = 1 THEN 'linked' ELSE 'unlinked' END),
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_hubProjectId_on_link",
  ADD CONSTRAINT "DrawingHubLinkEvent_hubProjectId_on_link" CHECK (
    ("kind" = 'linked' AND "hubProjectId" IS NOT NULL AND pg_catalog.btrim("hubProjectId", E' \t\n\x0B\f\r') <> '')
    OR ("kind" = 'unlinked' AND "hubProjectId" IS NULL)),
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_by_present",
  ADD CONSTRAINT "DrawingHubLinkEvent_by_present" CHECK (pg_catalog.btrim("by", E' \t\n\x0B\f\r') <> '');
ALTER TABLE public."HubFetchedBlob"
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_id_present",
  ADD CONSTRAINT "HubFetchedBlob_id_present" CHECK (pg_catalog.btrim("id", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_storageKey_in_project",
  ADD CONSTRAINT "HubFetchedBlob_storageKey_in_project" CHECK (
    pg_catalog.starts_with("storageKey", "projectId" || '/drawings/hub/')
    AND pg_catalog.length("storageKey") > pg_catalog.length("projectId" || '/drawings/hub/')),
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_hubVersionId_present",
  ADD CONSTRAINT "HubFetchedBlob_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> '');

-- R3: the trigger's argument names what the record goes with.
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

DROP TRIGGER IF EXISTS "DrawingHubLink_sealed" ON public."DrawingHubLink";
CREATE TRIGGER "DrawingHubLink_sealed"
  BEFORE UPDATE OR DELETE ON public."DrawingHubLink"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "DrawingHubLink_no_truncate" ON public."DrawingHubLink";
CREATE TRIGGER "DrawingHubLink_no_truncate"
  BEFORE TRUNCATE ON public."DrawingHubLink"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

DROP TRIGGER IF EXISTS "DrawingHubLinkEvent_sealed" ON public."DrawingHubLinkEvent";
CREATE TRIGGER "DrawingHubLinkEvent_sealed"
  BEFORE UPDATE OR DELETE ON public."DrawingHubLinkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "DrawingHubLinkEvent_no_truncate" ON public."DrawingHubLinkEvent";
CREATE TRIGGER "DrawingHubLinkEvent_no_truncate"
  BEFORE TRUNCATE ON public."DrawingHubLinkEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

-- the ledger: UPDATE only (its DELETE is the sweep's)
DROP TRIGGER IF EXISTS "HubFetchedBlob_sealed" ON public."HubFetchedBlob";
CREATE TRIGGER "HubFetchedBlob_sealed"
  BEFORE UPDATE ON public."HubFetchedBlob"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');

COMMIT;
