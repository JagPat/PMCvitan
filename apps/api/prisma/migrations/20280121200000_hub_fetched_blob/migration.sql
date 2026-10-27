-- #1118 U1a-3 (notes/hub/u1a/r4/redesign-plan.md, the second of the units replacing #1139): the ledger of the Hub blobs
-- PMC fetched into storage, in a key namespace of its own. A database change shipped alone, before any server code reads
-- or writes it. Nothing is backfilled.
--
-- WHY. A project linked to Hub takes its drawings from Hub (C1-C7 in notes/hub/1118-plan.md), and PMC fetches each Hub
-- file into its own storage. The later sweep (U5s) removes the ones no longer needed. It walks this ledger and never
-- lists the bucket, so it can only ever touch an object a Hub fetch wrote, never a PMC upload.
--
-- WHAT.
--   "HubFetchedBlob"  one per storage key a Hub fetch wrote, with its project and Hub version.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   B1  Keys: one ledger row per storage key (unique beside its "id"). Keyed by an "id" like every other table that
--       holds a "storageKey": `project:inventory` lists a project's stored files by each such table's "id" column.
--   B2  Owner: a row names a project that exists and goes with it (ON DELETE CASCADE). Its key never moves (ON UPDATE
--       NO ACTION, and B3).
--   B3  A row is never changed and never truncated: any UPDATE is refused, so its project and key can never move
--       together, and TRUNCATE is refused (a statement seal), since it would erase the only list of the Hub objects in
--       storage. The sweep's DELETE of a row, one per object it removes, is its one designed delete. The sanctioned
--       reset lifts the TRUNCATE seal by name ("TRUNCATE_SEALS" in prisma/sanctioned-reset.ts).
--   B4  The key is in the Hub namespace and nowhere else (#1139 r4385819935, A13; #1135 4381565859). It is exactly what
--       `StorageService.keyFor(projectId, 'hub', mime)` makes: "<projectId>/hub/<uuid>.<ext>", a lower-case uuid and an
--       extension of 1-8 lower-case letters or digits. The project id holds no '/'. So a ledger key has exactly two '/',
--       and its second segment is "hub". Every native key's second segment is "drawings" or a media kind (progress,
--       inspection, decision, attendance, material, visit), and a native drawing key must start "<projectId>/drawings/"
--       (`DrawingsService.issue`). So no native key is ever a ledger key, for any project id, and the sweep cannot
--       delete a native object nor native removal a Hub one. The tail has no '/' and no '.' before its extension, so a
--       key never climbs out of its prefix ('../').
--   B5  Well formed: the "id" and the Hub version hold more than whitespace (the full ASCII set, E' \t\n\x0B\f\r', as
--       "manualReason" does in 20270220).
--
-- REPLACES #1139's KEY CHECK. A database that ran a #1139 head has this table with the check
-- "HubFetchedBlob_storageKey_in_project" (the old "<projectId>/drawings/hub/" prefix). It is dropped here by name, so
-- such a database does not go on refusing every new key. Production never ran #1139.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The table is new, so the previous release never reads or writes it; no existing
-- table, column, index or trigger changes.
--
-- ONE TRANSACTION. The file is BEGIN ... COMMIT itself, so it is all-or-nothing under Prisma and under `psql -f` alike:
-- a failure anywhere leaves nothing of it, and a replay's DROP TRIGGER and its CREATE TRIGGER commit together, so no
-- writer ever sees the ledger without its seal.
--
-- LOCKS WHILE IT RUNS. Every lock is held until the file commits. Adding the key to "Project" takes
-- ShareRowExclusiveLock on it, so from then until commit inserts, updates and deletes on "Project" wait; reads and row
-- locks do not. No lock is waited for longer than 15 s (lock_timeout, set for this transaction only). Everything else is
-- on the new table, which nothing uses yet.
--
-- NAMES. Both functions have search_path pg_catalog, public, pg_temp and qualified names. They are shared with the
-- other Hub record units, which declare them with the same body, so each file stands alone. Re-runnable, and on
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table and key but not the checks or the
-- triggers. Every statement is guarded or replaces itself.

BEGIN;

-- A writer holding "Project" open would make the key's lock wait without end, with every later write to it queued
-- behind it; 15 s bounds the wait, and on expiry the whole file rolls back and can be run again.
SELECT pg_catalog.set_config('lock_timeout', '15s', true);

-- B1
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

-- B2. Added only when the table has no foreign key of that name, so a second run, or a `db push` baseline that already
-- made it from schema.prisma, changes nothing.
DO $hub_blob_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."HubFetchedBlob"'::regclass AND contype = 'f' AND conname = 'HubFetchedBlob_projectId_fkey') THEN
    ALTER TABLE public."HubFetchedBlob" ADD CONSTRAINT "HubFetchedBlob_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $hub_blob_key$;

-- B4 and B5. Each check is dropped and added again whenever the file runs, so what the table ends with is exactly this
-- definition, validated against every row, whatever a `db push` baseline, an earlier run or a #1139 head left.
ALTER TABLE public."HubFetchedBlob"
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_storageKey_in_project",
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_storageKey_shape",
  ADD CONSTRAINT "HubFetchedBlob_storageKey_shape" CHECK (
    pg_catalog.strpos("projectId", '/') = 0
    AND pg_catalog.starts_with("storageKey", "projectId" || '/hub/')
    AND pg_catalog.substr("storageKey", pg_catalog.length("projectId" || '/hub/') + 1)
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$'),
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_id_present",
  ADD CONSTRAINT "HubFetchedBlob_id_present" CHECK (pg_catalog.btrim("id", E' \t\n\x0B\f\r') <> ''),
  DROP CONSTRAINT IF EXISTS "HubFetchedBlob_hubVersionId_present",
  ADD CONSTRAINT "HubFetchedBlob_hubVersionId_present" CHECK (pg_catalog.btrim("hubVersionId", E' \t\n\x0B\f\r') <> '');

-- B3: the trigger's argument names what the record goes with. The same bodies as the other Hub record units.
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

-- UPDATE and TRUNCATE only: a row DELETE is the sweep's
DROP TRIGGER IF EXISTS "HubFetchedBlob_sealed" ON public."HubFetchedBlob";
CREATE TRIGGER "HubFetchedBlob_sealed"
  BEFORE UPDATE ON public."HubFetchedBlob"
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_record_sealed('project');
DROP TRIGGER IF EXISTS "HubFetchedBlob_no_truncate" ON public."HubFetchedBlob";
CREATE TRIGGER "HubFetchedBlob_no_truncate"
  BEFORE TRUNCATE ON public."HubFetchedBlob"
  FOR EACH STATEMENT EXECUTE FUNCTION public.drawings_hub_record_no_truncate('project');

COMMIT;
