-- #482 site photos: a deleted photo stays deleted. This is the unit's one database change, and it ships alone, before any
-- server or screen uses it.
--
-- WHY. A photo sent from a phone carries its own key ("Media"."clientKey"), so a send repeated after a lost answer
-- lands once. Deleting the photo removes its row, and with it the only record that the key was ever used. A copy of
-- the same send still queued on another device (or held in a browser's evidence store) then arrives, finds no row for
-- its key, and creates the photo again, after a person was told it was gone.
--
-- WHAT. One new table, "MediaTombstone": one row per (project, clientKey) whose photo was deleted, with the time. The
-- media module writes it in the delete's own transaction and reads it before a new photo is stored under a key, so a
-- key that once named a deleted photo is answered "deleted" and never used again. A photo sent with no key leaves no
-- tombstone. Also one index, "Media" (projectId, uploadedBy, createdAt), for the read of a member's own recent photos
-- that the screen unit adds.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   T1  One row per key in a project (the primary key), and only for a project that exists (the foreign key).
--   T2  A tombstone is never changed: any UPDATE is refused.
--   T3  A tombstone is never deleted on its own: a direct DELETE (trigger depth 1) is refused. It goes only with its
--       project, through the key's ON DELETE CASCADE, which runs below depth 1, the rule "NotificationReceipt" (20280109)
--       and the site-visit record (20280112) already use. `project:remove` disables ON DELETE triggers on the tables it
--       empties for its own run and puts them back, as it does for every other sealed table.
--   T4  The table is never truncated (a statement-level seal). No seed reset lists it.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table but not its seals.
-- Every statement is guarded or replaces itself.

CREATE TABLE IF NOT EXISTS "MediaTombstone" (
  "projectId" TEXT NOT NULL,
  "clientKey" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaTombstone_pkey" PRIMARY KEY ("projectId", "clientKey")
);

DO $media_tombstone$
BEGIN
  -- T1/T3: a `db push` baseline creates this key as RESTRICT when the schema says otherwise; it is judged by its delete
  -- action and replaced when that is not CASCADE
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaTombstone_projectId_fkey' AND confdeltype <> 'c') THEN
    ALTER TABLE "MediaTombstone" DROP CONSTRAINT "MediaTombstone_projectId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MediaTombstone_projectId_fkey') THEN
    ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $media_tombstone$;

CREATE INDEX IF NOT EXISTS "Media_projectId_uploadedBy_createdAt_idx" ON "Media"("projectId", "uploadedBy", "createdAt");

-- T2, T3
CREATE OR REPLACE FUNCTION media_tombstone_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'media: the deleted-photo record (%, %) is never changed', OLD."projectId", OLD."clientKey";
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'media: the deleted-photo record (%, %) is never deleted; it goes only with its project', OLD."projectId", OLD."clientKey";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "MediaTombstone_immutable" ON "MediaTombstone";
CREATE TRIGGER "MediaTombstone_immutable"
  BEFORE UPDATE OR DELETE ON "MediaTombstone"
  FOR EACH ROW EXECUTE FUNCTION media_tombstone_immutable();

-- T4
CREATE OR REPLACE FUNCTION media_tombstone_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media: the deleted-photo records are never truncated; each goes only with its project';
END $$;

DROP TRIGGER IF EXISTS "MediaTombstone_no_truncate" ON "MediaTombstone";
CREATE TRIGGER "MediaTombstone_no_truncate"
  BEFORE TRUNCATE ON "MediaTombstone"
  FOR EACH STATEMENT EXECUTE FUNCTION media_tombstone_no_truncate();
