-- #1118 U1a-1 (notes/hub/u1a/r4/redesign-plan.md §3, "U1a-1"): Hub's webhook deliveries and the versions Hub withdrew,
-- each delivery bound to the fact it wrote. The last Hub record unit (after U1a-2 link, U1a-3 fetched blobs, U1b drawing
-- identity). A database change shipped alone, before any server code reads or writes it. Nothing is backfilled.
--
-- WHY. Hub tells PMC about a drawing by webhook, and redelivers until PMC answers. PMC must skip a delivery it already
-- applied, judge again one it refused or ignored (C2 in notes/hub/1118-plan.md), and never let a receipt say "applied"
-- unless the fact that delivery wrote is there. #1139 bound an applied receipt only to a fact existing (r4385819940), so a
-- receipt could claim a fact a re-sync or an earlier delivery wrote, or claim the wrong kind of fact. Here each applied
-- receipt is bound, by keys both ways, to the fact row written with its own id, of the kind its event type allows.
--
-- WHAT.
--   "HubWebhookReceipt"    one row per judgement of a Hub delivery: its org, webhook id, event type and outcome
--                          ('applied', 'refused' or 'ignored'). An applied row also names its project, the Hub version,
--                          and the fact it wrote ('tombstone', 'revision' or 'mark'; a mark also names its drawing and
--                          order). A delivery has at most one applied row and any number of refused or ignored rows.
--   "HubVersionTombstone"  one per (project, Hub version) Hub withdrew, with its file and, when Hub sent one, its order.
--   "sourceReceiptId"      on "HubVersionTombstone", "HubRevision" and "HubGoverningMark" (U1b): the applied receipt of
--                          the delivery that wrote the row, or NULL for a row a re-sync wrote.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   W1  Keys: one applied receipt per (org, webhook id), a partial unique on outcome = 'applied'; refused and ignored rows
--       are not limited, so the ledger keeps every judgement. One tombstone per (project, version).
--   W2  Owners: a receipt names an org that exists, and its project, when it names one, is of that org (a key to
--       "Project" ("orgId", "id")); a tombstone names a project that exists. Each goes with its project or org (ON DELETE
--       CASCADE). No key ever moves (W4).
--   W3  An applied receipt is complete and of an allowed kind: it is applied exactly when it names a project, a version
--       and a fact; only an applied receipt names a fact; it names a mark's drawing and order exactly when its fact is a
--       mark; and its event type allows that fact: 'drawing.superseded' a tombstone, 'drawing.issued' a mark or a
--       revision, 'drawing.status_changed' a mark (the optional promotion, listed so subscribing to it later needs no
--       schema change). No other event type can be applied; a unit that subscribes to another widens this check.
--   W4  Bound both ways, every part a key, checked at commit (DEFERRABLE INITIALLY DEFERRED), so the receipt and its fact
--       are written in either order in one transaction:
--         receipt to fact: an applied tombstone receipt has a tombstone of its version whose source is this receipt; an
--         applied revision receipt has a "HubRevision" of its version whose source is this receipt; an applied mark
--         receipt has a "HubGoverningMark" of its drawing and order whose source is this receipt, and that order is its
--         version's own on that drawing (U1b's "HubRevision_version_drawing_order_key").
--         fact to receipt: a fact's source, when set, is an applied receipt of the same project that wrote that kind of
--         fact for that row: a tombstone's, a tombstone receipt of its version; a "HubRevision"'s, a revision or mark
--         receipt of its version; a mark's, a mark receipt of its drawing and order. So no refused or ignored receipt,
--         no other project's receipt and no other kind is ever a source.
--       Facts are sealed records (U1b I6 and W5), so no fact is re-pointed at a receipt after it is written: a fact a
--       re-sync or an earlier delivery wrote never backs a new applied claim.
--   W5  Records: a receipt and a tombstone are never changed, never deleted on their own and never truncated; each goes
--       only with its project or org (the seal of 20280121300000_hub_link L3). `project:remove` turns off the ON DELETE
--       triggers of the tables it empties for its run and checks the deferred keys before it ends.
--   W6  Well formed: a webhook id, an event type, a version id, a Hub file id and a mark's drawing id each hold more than
--       whitespace (the full ASCII set, as 20280121300000 L6); an outcome and a fact are from their lists.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The two tables are new, and the previous release never reads or writes them or U1b's
-- three tables; the new column on "HubRevision" and "HubGoverningMark" is nullable and nothing writes those tables yet.
--
-- ONE TRANSACTION. The file is BEGIN ... COMMIT itself, so it is all-or-nothing under Prisma and under `psql -f` alike.
--
-- LOCKS WHILE IT RUNS. Every lock is held until the file commits. Adding the column takes AccessExclusiveLock on
-- "HubRevision" and "HubGoverningMark", which nothing uses yet. Adding the keys takes ShareRowExclusiveLock on "Org" and
-- "Project", so from then until commit inserts, updates and deletes on those two wait; reads and row locks do not. No
-- lock is waited for longer than 15 s (lock_timeout, set for this transaction only): the file gets its locks or changes
-- nothing.
--
-- NAMES. Every function has search_path pg_catalog, public, pg_temp and qualified names. The two seal functions are
-- shared with the other Hub record units, which declare them with the same body, so each file stands alone. Re-runnable,
-- and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the tables, the columns Prisma writes and
-- the plain keys, but not the derived columns, the partial unique, the binding keys, the checks or the triggers. Every
-- statement is guarded or replaces itself.

BEGIN;

-- A writer holding "Org" or "Project" open would make a key's lock wait without end, with every later write to that
-- table queued behind it; 15 s bounds the wait, and on expiry the whole file rolls back and can be run again.
SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."HubWebhookReceipt" (
  "id" BIGSERIAL NOT NULL,
  "orgId" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT,
  "hubVersionId" TEXT,
  "appliedFact" TEXT,
  "markDrawingId" TEXT,
  "markOrder" INTEGER,
  CONSTRAINT "HubWebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- W4's derived key columns: the version, set only on an applied receipt of that kind. Stored and generated, so no writer
-- sets them (schema.prisma leaves them out).
ALTER TABLE public."HubWebhookReceipt"
  ADD COLUMN IF NOT EXISTS "tombstoneVersionId" TEXT
    GENERATED ALWAYS AS (CASE WHEN "outcome" = 'applied' AND "appliedFact" = 'tombstone' THEN "hubVersionId" END) STORED,
  ADD COLUMN IF NOT EXISTS "revisionVersionId" TEXT
    GENERATED ALWAYS AS (CASE WHEN "outcome" = 'applied' AND "appliedFact" = 'revision' THEN "hubVersionId" END) STORED,
  ADD COLUMN IF NOT EXISTS "writtenVersionId" TEXT
    GENERATED ALWAYS AS (CASE WHEN "outcome" = 'applied' AND "appliedFact" IN ('revision', 'mark') THEN "hubVersionId" END) STORED;

CREATE INDEX IF NOT EXISTS "HubWebhookReceipt_orgId_webhookId_idx" ON public."HubWebhookReceipt" ("orgId", "webhookId");
CREATE INDEX IF NOT EXISTS "HubWebhookReceipt_orgId_projectId_idx" ON public."HubWebhookReceipt" ("orgId", "projectId");
-- W1
CREATE UNIQUE INDEX IF NOT EXISTS "HubWebhookReceipt_one_applied"
  ON public."HubWebhookReceipt" ("orgId", "webhookId") WHERE "outcome" = 'applied';
-- W4's targets on the receipt (each holds the primary key, so each is unique already; a key needs it declared)
CREATE UNIQUE INDEX IF NOT EXISTS "HubWebhookReceipt_tombstone_key"
  ON public."HubWebhookReceipt" ("projectId", "tombstoneVersionId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "HubWebhookReceipt_written_key"
  ON public."HubWebhookReceipt" ("projectId", "writtenVersionId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "HubWebhookReceipt_mark_key"
  ON public."HubWebhookReceipt" ("projectId", "markDrawingId", "markOrder", "id");

CREATE TABLE IF NOT EXISTS public."HubVersionTombstone" (
  "projectId" TEXT NOT NULL,
  "hubVersionId" TEXT NOT NULL,
  "hubFileId" TEXT NOT NULL,
  "versionSeq" INTEGER,
  "withdrawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReceiptId" BIGINT,
  CONSTRAINT "HubVersionTombstone_pkey" PRIMARY KEY ("projectId", "hubVersionId")
);

-- the source column on U1b's two fact tables
ALTER TABLE public."HubRevision" ADD COLUMN IF NOT EXISTS "sourceReceiptId" BIGINT;
ALTER TABLE public."HubGoverningMark" ADD COLUMN IF NOT EXISTS "sourceReceiptId" BIGINT;

-- W4's targets on the facts: each fact's identity with its source
CREATE UNIQUE INDEX IF NOT EXISTS "HubVersionTombstone_source_key"
  ON public."HubVersionTombstone" ("projectId", "hubVersionId", "sourceReceiptId");
CREATE UNIQUE INDEX IF NOT EXISTS "HubRevision_source_key"
  ON public."HubRevision" ("projectId", "hubVersionId", "sourceReceiptId");
CREATE UNIQUE INDEX IF NOT EXISTS "HubGoverningMark_source_key"
  ON public."HubGoverningMark" ("projectId", "drawingId", "order", "sourceReceiptId");

-- W2's keys, then W4's. Each is added only when its table has no foreign key of that name, so a second run, or a `db
-- push` baseline that already made the plain keys from schema.prisma, changes nothing. W4's keys are raw SQL only
-- (Prisma cannot declare a deferrable key), so a baseline never holds one in another shape.
DO $hub_receipt_keys$
DECLARE
  k record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_orgId_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES public."Org"("id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_orgId_projectId_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES public."Project"("orgId", "id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"HubVersionTombstone"', 'HubVersionTombstone_projectId_fkey',
       'ALTER TABLE public."HubVersionTombstone" ADD CONSTRAINT "HubVersionTombstone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      -- receipt to fact
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_tombstone_fact_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_tombstone_fact_fkey" FOREIGN KEY ("projectId", "tombstoneVersionId", "id") REFERENCES public."HubVersionTombstone"("projectId", "hubVersionId", "sourceReceiptId") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_revision_fact_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_revision_fact_fkey" FOREIGN KEY ("projectId", "revisionVersionId", "id") REFERENCES public."HubRevision"("projectId", "hubVersionId", "sourceReceiptId") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_mark_fact_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_mark_fact_fkey" FOREIGN KEY ("projectId", "markDrawingId", "markOrder", "id") REFERENCES public."HubGoverningMark"("projectId", "drawingId", "order", "sourceReceiptId") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      ('"HubWebhookReceipt"', 'HubWebhookReceipt_mark_version_fkey',
       'ALTER TABLE public."HubWebhookReceipt" ADD CONSTRAINT "HubWebhookReceipt_mark_version_fkey" FOREIGN KEY ("projectId", "hubVersionId", "markDrawingId", "markOrder") REFERENCES public."HubRevision"("projectId", "hubVersionId", "drawingId", "hubVersionOrder") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      -- fact to receipt
      ('"HubVersionTombstone"', 'HubVersionTombstone_source_fkey',
       'ALTER TABLE public."HubVersionTombstone" ADD CONSTRAINT "HubVersionTombstone_source_fkey" FOREIGN KEY ("projectId", "hubVersionId", "sourceReceiptId") REFERENCES public."HubWebhookReceipt"("projectId", "tombstoneVersionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      ('"HubRevision"', 'HubRevision_source_fkey',
       'ALTER TABLE public."HubRevision" ADD CONSTRAINT "HubRevision_source_fkey" FOREIGN KEY ("projectId", "hubVersionId", "sourceReceiptId") REFERENCES public."HubWebhookReceipt"("projectId", "writtenVersionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED'),
      ('"HubGoverningMark"', 'HubGoverningMark_source_fkey',
       'ALTER TABLE public."HubGoverningMark" ADD CONSTRAINT "HubGoverningMark_source_fkey" FOREIGN KEY ("projectId", "drawingId", "order", "sourceReceiptId") REFERENCES public."HubWebhookReceipt"("projectId", "markDrawingId", "markOrder", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED')
    ) AS v(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = ('public.' || k.tbl)::regclass AND contype = 'f' AND conname = k.name) THEN
      EXECUTE k.ddl;
    END IF;
  END LOOP;
END $hub_receipt_keys$;

-- W3 and W6. Each check is dropped and added again whenever the file runs, so what the table ends with is exactly this
-- definition, validated against every row.
ALTER TABLE public."HubWebhookReceipt"
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_webhookId_present",
  ADD CONSTRAINT "HubWebhookReceipt_webhookId_present" CHECK (pg_catalog.btrim("webhookId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_eventType_present",
  ADD CONSTRAINT "HubWebhookReceipt_eventType_present" CHECK (pg_catalog.btrim("eventType", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_hubVersionId_present",
  ADD CONSTRAINT "HubWebhookReceipt_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_markDrawingId_present",
  ADD CONSTRAINT "HubWebhookReceipt_markDrawingId_present" CHECK (pg_catalog.btrim("markDrawingId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_outcome_known",
  ADD CONSTRAINT "HubWebhookReceipt_outcome_known" CHECK ("outcome" IN ('applied', 'refused', 'ignored')),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_appliedFact_known",
  ADD CONSTRAINT "HubWebhookReceipt_appliedFact_known" CHECK ("appliedFact" IN ('tombstone', 'revision', 'mark')),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_applied_has_fact",
  ADD CONSTRAINT "HubWebhookReceipt_applied_has_fact"
    CHECK (("outcome" = 'applied') = ("projectId" IS NOT NULL AND "hubVersionId" IS NOT NULL AND "appliedFact" IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_fact_only_applied",
  ADD CONSTRAINT "HubWebhookReceipt_fact_only_applied" CHECK ("appliedFact" IS NULL OR "outcome" = 'applied'),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_mark_cols",
  ADD CONSTRAINT "HubWebhookReceipt_mark_cols"
    CHECK (("appliedFact" IS NOT DISTINCT FROM 'mark') = ("markDrawingId" IS NOT NULL)
       AND ("appliedFact" IS NOT DISTINCT FROM 'mark') = ("markOrder" IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS "HubWebhookReceipt_event_fact",
  ADD CONSTRAINT "HubWebhookReceipt_event_fact"
    CHECK ("outcome" <> 'applied'
       OR ("eventType" = 'drawing.superseded' AND "appliedFact" = 'tombstone')
       OR ("eventType" = 'drawing.issued' AND "appliedFact" IN ('mark', 'revision'))
       OR ("eventType" = 'drawing.status_changed' AND "appliedFact" = 'mark'));
ALTER TABLE public."HubVersionTombstone"
  DROP CONSTRAINT IF EXISTS "HubVersionTombstone_hubVersionId_present",
  ADD CONSTRAINT "HubVersionTombstone_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubVersionTombstone_hubFileId_present",
  ADD CONSTRAINT "HubVersionTombstone_hubFileId_present" CHECK (pg_catalog.btrim("hubFileId", E' \t\n\x0B\f\r') <> '');

-- W5: the trigger's argument names what the record goes with. Bodies identical to 20280121300000's.
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
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project or org');
DROP TRIGGER IF EXISTS "HubWebhookReceipt_no_truncate" ON public."HubWebhookReceipt";
CREATE TRIGGER "HubWebhookReceipt_no_truncate"
  BEFORE TRUNCATE ON public."HubWebhookReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project or org');

DROP TRIGGER IF EXISTS "HubVersionTombstone_sealed" ON public."HubVersionTombstone";
CREATE TRIGGER "HubVersionTombstone_sealed"
  BEFORE UPDATE OR DELETE ON public."HubVersionTombstone"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubVersionTombstone_no_truncate" ON public."HubVersionTombstone";
CREATE TRIGGER "HubVersionTombstone_no_truncate"
  BEFORE TRUNCATE ON public."HubVersionTombstone"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

COMMIT;
