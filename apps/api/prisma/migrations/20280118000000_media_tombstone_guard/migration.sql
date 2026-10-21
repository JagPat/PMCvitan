-- #482 site photos: a deleted photo's key is never stored again, by any writer. This is a database change shipped alone.
--
-- WHY. 20280117 keeps a record ("MediaTombstone") of every deleted photo's send key, written by the database in the
-- delete's own statement. Nothing yet stops a later send of that key from storing the photo again: the release serving
-- today never reads the record, nor will any release still serving while the next one rolls out. A copy of a send
-- still queued on another phone could bring a deleted photo back for as long as one such release serves.
--
-- WHAT. One trigger on "Media", AFTER INSERT OR UPDATE OF "projectId", "clientKey", per row: a row with a key that has
-- a record in its project is refused (SQLSTATE MT410, "media: this photo was deleted"). The statement fails and its
-- transaction rolls back, so nothing of that send is kept. Every writer meets it, whatever its release, ORM or raw SQL,
-- and whichever of the two columns it sets: a new row, a key given to a row, or a row moved into a project that
-- recorded its key. A row with no key, a key with no record written at READ COMMITTED, and the same key in another
-- project are untouched.
--
-- WHY AFTER, NOT BEFORE. A send of a key whose earlier row a delete is still removing waits on the
-- ("projectId", "clientKey") unique index until that delete commits, together with the record its trigger writes. A
-- BEFORE trigger runs before that wait and would miss the record; an AFTER trigger runs once the row is in the index.
-- Its lookup is a separate statement in a VOLATILE function, so under READ COMMITTED (every "Media" writer) it takes a
-- fresh snapshot and sees the record committed during the wait.
--
-- READ COMMITTED ONLY. The fresh snapshot above is READ COMMITTED's. Under REPEATABLE READ or SERIALIZABLE the lookup
-- would use the transaction's snapshot, which can predate the delete and miss its record, so a keyed row written at
-- any other level is refused outright (SQLSTATE MTISO): fail closed. Every "Media" writer runs at READ COMMITTED. The
-- refusal is deliberately not MT410: the server answers it 500, which a phone keeps and sends again, never a 4xx,
-- which it would drop as final and so lose a photo that was never deleted.
--
-- THE LOOKUP is one probe of "MediaTombstone_pkey" ("projectId", "clientKey"), the record's primary key. It takes
-- ACCESS SHARE on "MediaTombstone" only, which conflicts with nothing but ACCESS EXCLUSIVE.
--
-- NAMES. Both ends of the record name public."MediaTombstone" and run with search_path pg_catalog, public, pg_temp
-- (pg_temp last, or it would be searched first), so a writer's search_path or temporary table can neither hide a
-- record from the guard nor take the record its delete writes. That covers the record's writer too: 20280117's
-- delete trigger function is replaced here, with the same body, qualified. Migrations apply in name order, on every
-- path including `scripts/migrate.sh`'s ALWAYS_EXECUTE, so wherever 20280117 runs this file runs after it.
--
-- ONE STATEMENT. The whole install is one DO block, so it is one transaction whatever runs it: `prisma migrate deploy`,
-- psql with or without --single-transaction, or an operator. It either installs everything or nothing; no point in the
-- run leaves a function without its trigger, or the old guard dropped. A failure keeps its own message in Prisma's log
-- (an explicit BEGIN/COMMIT would replace it with "current transaction is aborted").
--
-- ROWS ALREADY STORED. A trigger judges only the writes after it. So the block first takes SHARE ROW EXCLUSIVE on
-- "Media", which waits for every write in flight to commit and holds back every new one (a delete too, and with it the
-- record's writer) until the block commits. Under that lock it installs both functions and the trigger, then checks
-- every row already stored: a keyed row whose project has a record for its key raises (SQLSTATE MTSTO) and nothing is
-- installed. So no row written before the guard, by any release, in any window, is trusted; it is found here, and the
-- owner decides it (the read-only count in docs/RUNBOOK.md §MG finds the same rows beforehand). The block waits at most
-- 15 s for that lock (lock_timeout, local to its transaction). That is longer than any app write holds "Media" (Prisma's
-- 5 s transaction timeout); a longer holder, such as project:remove or a stray open session, makes the install fail with
-- nothing installed, after holding new photo writes behind it for at most 15 s (a send held past its own 5 s timeout
-- is answered 500 and sent again). The check runs only at READ COMMITTED, where each
-- statement sees every commit before it; at any other level the block refuses to run.
--
-- RECOVERY. Any failure of this file (MTSTO, MTISO, the lock timeout, a killed install, or the deploy client dying
-- mid-install) leaves Prisma's P3009 on the next deploy. The recovery is the same each time, and safe even when the
-- install had committed: docs/RUNBOOK.md §MG, also printed by scripts/migrate.sh.
--
-- REPLACED IN PLACE. Each object is replaced, never dropped (CREATE OR REPLACE FUNCTION, CREATE OR REPLACE TRIGGER,
-- PostgreSQL 14+; production relies on 15 already, for 20261025's column-list SET NULL). Re-runnable, and on
-- `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline has no triggers.

DO $install$
DECLARE
  v_stored bigint;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'media guard install: run at READ COMMITTED, not %; nothing was installed',
      pg_catalog.current_setting('transaction_isolation') USING ERRCODE = 'MTISO';
  END IF;
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, public, pg_temp', true);

  -- every write in flight commits before this returns, or the block fails after 15 s; every later write waits for it
  PERFORM pg_catalog.set_config('lock_timeout', '15s', true);
  LOCK TABLE public."Media" IN SHARE ROW EXCLUSIVE MODE;

  EXECUTE $fn_delete$
CREATE OR REPLACE FUNCTION public.media_tombstone_on_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $body$
BEGIN
  IF OLD."clientKey" IS NOT NULL THEN
    -- read through "Project", so a row whose project went in the same statement writes nothing
    INSERT INTO public."MediaTombstone" ("projectId", "clientKey")
    SELECT p."id", OLD."clientKey" FROM public."Project" p WHERE p."id" = OLD."projectId"
    ON CONFLICT ("projectId", "clientKey") DO NOTHING;
  END IF;
  RETURN NULL;
END $body$
$fn_delete$;

  EXECUTE $fn_guard$
CREATE OR REPLACE FUNCTION public.media_tombstone_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $body$
BEGIN
  IF NEW."clientKey" IS NULL THEN
    RETURN NULL;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'media: a photo with a send key is stored only under READ COMMITTED, not %', current_setting('transaction_isolation')
      USING ERRCODE = 'MTISO';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."MediaTombstone" t WHERE t."projectId" = NEW."projectId" AND t."clientKey" = NEW."clientKey"
  ) THEN
    RAISE EXCEPTION 'media: this photo was deleted (%, %)', NEW."projectId", NEW."clientKey" USING ERRCODE = 'MT410';
  END IF;
  RETURN NULL;
END $body$
$fn_guard$;

  EXECUTE $trigger$
CREATE OR REPLACE TRIGGER "Media_tombstone_guard"
  AFTER INSERT OR UPDATE OF "projectId", "clientKey" ON public."Media"
  FOR EACH ROW EXECUTE FUNCTION public.media_tombstone_guard()
$trigger$;

  -- under the lock, every row stored before this block: none may carry a deleted photo's key
  SELECT count(*) INTO v_stored
    FROM public."Media" m
    JOIN public."MediaTombstone" t ON t."projectId" = m."projectId" AND t."clientKey" = m."clientKey";
  IF v_stored > 0 THEN
    RAISE EXCEPTION 'media guard install: % stored photo(s) carry the key of a deleted photo; nothing was installed', v_stored
      USING ERRCODE = 'MTSTO',
            HINT = 'Nothing was installed. List them with the read-only count in docs/RUNBOOK.md §MG; the owner decides each one; then run npx prisma migrate resolve --rolled-back 20280118000000_media_tombstone_guard and deploy again.';
  END IF;
END $install$;
