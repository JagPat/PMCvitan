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
-- recorded its key. A row with no key, a key with no record, and the same key in another project are untouched.
--
-- WHY AFTER, NOT BEFORE. A send of a key whose earlier row a delete is still removing waits on the
-- ("projectId", "clientKey") unique index until that delete commits, together with the record its trigger writes. A
-- BEFORE trigger runs before that wait and would miss the record; an AFTER trigger runs once the row is in the index.
-- Its lookup is a separate statement in a VOLATILE function, so under READ COMMITTED (every "Media" writer) it takes a
-- fresh snapshot and sees the record committed during the wait.
--
-- THE LOOKUP is one probe of "MediaTombstone_pkey" ("projectId", "clientKey"), the record's primary key. It takes
-- ACCESS SHARE on "MediaTombstone" only, which conflicts with nothing but ACCESS EXCLUSIVE.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline has no triggers.

CREATE OR REPLACE FUNCTION media_tombstone_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."clientKey" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "MediaTombstone" t WHERE t."projectId" = NEW."projectId" AND t."clientKey" = NEW."clientKey"
  ) THEN
    RAISE EXCEPTION 'media: this photo was deleted (%, %)', NEW."projectId", NEW."clientKey" USING ERRCODE = 'MT410';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Media_tombstone_guard" ON "Media";
CREATE TRIGGER "Media_tombstone_guard"
  AFTER INSERT OR UPDATE OF "projectId", "clientKey" ON "Media"
  FOR EACH ROW EXECUTE FUNCTION media_tombstone_guard();
