-- #1118 U1a-2 (notes/hub/u1a/r4/redesign-plan.md, replacing #1139): a project's Hub link and its history, the first of
-- the three Hub record units (U1a-2 link, U1a-3 fetched blobs, U1a-1 receipts). A database change shipped alone,
-- before any server code reads or writes it. Nothing is backfilled.
--
-- WHY. A project linked to Hub takes its drawings from Hub (C1-C7 in notes/hub/1118-plan.md). PMC has to know whether
-- a project is linked, to which Hub project, and who linked or unlinked it, when. Each of these is a record: written
-- once, never changed, removed only with its project.
--
-- WHAT.
--   "DrawingHubLink"       one per project that has ever been linked to Hub, with its org (the project's own). It names
--                          no Hub project, holds no lifecycle and records no one: who linked or unlinked the project,
--                          and when, is its events' alone (event 1 is the first link), so there is one answer.
--   "DrawingHubLinkEvent"  the project's link history, one row per link or unlink, in order. Event 1 is a link; links and
--                          unlinks alternate; each link names the Hub project; each names the user who acted. The active
--                          link is the latest event when it is a link.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   L1  Keys: one link per project, one event per (project, seq).
--   L2  Owners: a link's org is its project's org (a composite key to "Project" ("orgId", "id")); an event belongs to its
--       project's link. Each goes with its project (ON DELETE CASCADE). An event's actor is a real user: "byUserId" is a
--       key to "User" ("id"), NO ACTION, the rule every actor column here follows ("createdById", "approvedById",
--       "boundById"), so a user who linked or unlinked a project is never deleted from under its history. Whether that
--       user may link this project is the linking command's check, through the orgs module (U7), not a trigger here: a
--       trigger reading "Membership" or "OrgMembership" is the cross-module read AGENTS.md forbids (20270515, round 11).
--       No key ever moves (ON UPDATE NO ACTION, and L3).
--   L3  Records: a link and an event are never changed, never deleted on their own and never truncated. Any UPDATE is
--       refused; a direct DELETE (trigger depth 1) is refused; TRUNCATE is refused (a statement seal). Each goes only by
--       its project's cascade, which runs below depth 1, the rule "MediaTombstone" (20280117) uses. `project:remove`
--       turns off the ON DELETE triggers of the tables it empties for its own run, as for every sealed table, and the
--       sanctioned reset lifts the TRUNCATE seals by name ("TRUNCATE_SEALS" in prisma/sanctioned-reset.ts).
--   L4  The history is a chain by its keys and checks alone: event 1 has no previous event, every later event names the
--       one before it (a key to the same project's event "seq" - 1; the check compares with IS NOT DISTINCT FROM, so a
--       NULL "prevSeq" on a later event is refused rather than passing as unknown, and the key then always applies), odd
--       events are links and even events unlinks, a link names a Hub project and an unlink names none. So the history is
--       never rewritten, has no gap, and never holds two links or two unlinks in a row.
--   L5  No link without its history (#1139 r4385819929): a link commits only with its event 1, checked at commit by a
--       deferred constraint trigger, so the link and its first event are one transaction's work. With event 1 present, L4
--       makes it a link naming its Hub project, its actor and its time; events are never deleted on their own (L3), so
--       a committed link always has them. A writer that asks for the check at once (SET CONSTRAINTS ... IMMEDIATE)
--       before writing event 1 is refused.
--   L6  Well formed: an event's Hub project holds more than whitespace (the full ASCII set, E' \t\n\x0B\f\r', as
--       "manualReason" does in 20270220).
--
-- SAFE UNDER THE PREVIOUS RELEASE. Both tables are new, so the previous release never reads or writes them; no existing
-- table, column, index or trigger changes.
--
-- ONE TRANSACTION. The file is BEGIN ... COMMIT itself, so it is all-or-nothing under Prisma and under `psql -f` alike:
-- a failure anywhere leaves nothing of it, and a replay's DROP TRIGGER and its CREATE TRIGGER commit together, so no
-- writer ever sees a record table without its seal.
--
-- LOCKS WHILE IT RUNS. Every lock is held until the file commits. Adding the keys to "Project" and "User" takes
-- ShareRowExclusiveLock on each, so from then until commit inserts, updates and deletes on those two tables wait; reads
-- and row locks do not. No lock is waited for longer than 15 s (lock_timeout, set for this transaction only).
-- Everything else is on the new tables, which nothing uses yet.
--
-- NAMES. Every function has search_path pg_catalog, public, pg_temp and qualified names. The two seal functions are
-- shared with the other Hub record units, which declare them with the same body, so each file stands alone. Re-runnable,
-- and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the tables and keys but not the checks or
-- the triggers. Every statement is guarded or replaces itself.

BEGIN;

-- A writer holding "Project" or "User" open would make a key's lock wait without end, with every later write to that
-- table queued behind it; 15 s bounds the wait, and on expiry the whole file rolls back and can be run again.
SELECT pg_catalog.set_config('lock_timeout', '15s', true);

-- L1
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
  "byUserId" TEXT NOT NULL,
  CONSTRAINT "DrawingHubLinkEvent_pkey" PRIMARY KEY ("projectId", "seq")
);
CREATE INDEX IF NOT EXISTS "DrawingHubLinkEvent_byUserId_idx" ON public."DrawingHubLinkEvent" ("byUserId");

-- L2 and L4's keys. Each is added only when its table has no foreign key of that name (read from the table's own
-- constraints), so a second run, or a `db push` baseline that already made it from schema.prisma, changes nothing.
DO $hub_link_keys$
DECLARE
  k record;
BEGIN
  FOR k IN
    SELECT * FROM (VALUES
      ('"DrawingHubLink"', 'DrawingHubLink_orgId_projectId_fkey',
       'ALTER TABLE public."DrawingHubLink" ADD CONSTRAINT "DrawingHubLink_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES public."Project"("orgId", "id") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"DrawingHubLinkEvent"', 'DrawingHubLinkEvent_projectId_fkey',
       'ALTER TABLE public."DrawingHubLinkEvent" ADD CONSTRAINT "DrawingHubLinkEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."DrawingHubLink"("projectId") ON DELETE CASCADE ON UPDATE NO ACTION'),
      ('"DrawingHubLinkEvent"', 'DrawingHubLinkEvent_projectId_prevSeq_fkey',
       'ALTER TABLE public."DrawingHubLinkEvent" ADD CONSTRAINT "DrawingHubLinkEvent_projectId_prevSeq_fkey" FOREIGN KEY ("projectId", "prevSeq") REFERENCES public."DrawingHubLinkEvent"("projectId", "seq") ON DELETE NO ACTION ON UPDATE NO ACTION'),
      ('"DrawingHubLinkEvent"', 'DrawingHubLinkEvent_byUserId_fkey',
       'ALTER TABLE public."DrawingHubLinkEvent" ADD CONSTRAINT "DrawingHubLinkEvent_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES public."User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION')
    ) AS v(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                    WHERE conrelid = ('public.' || k.tbl)::regclass AND contype = 'f' AND conname = k.name) THEN
      EXECUTE k.ddl;
    END IF;
  END LOOP;
END $hub_link_keys$;

-- L4 and L6. Each check is dropped and added again whenever the file runs, so what the table ends with is exactly this
-- definition, validated against every row, whatever a `db push` baseline or an earlier run left under the name.
ALTER TABLE public."DrawingHubLinkEvent"
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_chain",
  ADD CONSTRAINT "DrawingHubLinkEvent_chain" CHECK ("seq" >= 1 AND "prevSeq" IS NOT DISTINCT FROM NULLIF("seq" - 1, 0)),
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_kind_alternates",
  ADD CONSTRAINT "DrawingHubLinkEvent_kind_alternates" CHECK ("kind" = CASE WHEN "seq" % 2 = 1 THEN 'linked' ELSE 'unlinked' END),
  DROP CONSTRAINT IF EXISTS "DrawingHubLinkEvent_hubProjectId_on_link",
  ADD CONSTRAINT "DrawingHubLinkEvent_hubProjectId_on_link" CHECK (
    ("kind" = 'linked' AND "hubProjectId" IS NOT NULL AND pg_catalog.btrim("hubProjectId", E' \t\n\x0B\f\r') <> '')
    OR ("kind" = 'unlinked' AND "hubProjectId" IS NULL));

-- L3: the trigger's argument names what the record goes with.
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

-- L5: at commit, the link's event 1 is there. Reads only the link's own history (this module's table).
CREATE OR REPLACE FUNCTION public.drawings_hub_link_has_first_event() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."DrawingHubLinkEvent" e WHERE e."projectId" = NEW."projectId" AND e."seq" = 1) THEN
    RAISE EXCEPTION 'drawings: the Hub link of project % has no first event; a link and its event 1 are written together', NEW."projectId"
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'DrawingHubLink_first_event';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DrawingHubLink_first_event" ON public."DrawingHubLink";
CREATE CONSTRAINT TRIGGER "DrawingHubLink_first_event"
  AFTER INSERT ON public."DrawingHubLink"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.drawings_hub_link_has_first_event();

COMMIT;
