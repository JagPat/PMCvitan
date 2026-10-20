-- #482 site photos: a deleted photo stays deleted. This is the unit's one database change, and it ships alone, before any
-- server or screen uses it.
--
-- WHY. A photo sent from a phone carries its own key ("Media"."clientKey"), so a send repeated after a lost answer
-- lands once. Deleting the photo removes its row, and with it the only record that the key was ever used. A copy of
-- the same send still queued on another device (or held in a browser's evidence store) then arrives, finds no row for
-- its key, and creates the photo again, after a person was told it was gone.
--
-- WHAT. One new table, "MediaTombstone": one row per (project, clientKey) whose photo was deleted, with the time. The
-- database writes it itself: a trigger on "Media" records the key of every deleted row that has one, in the delete's
-- own statement, so it holds from the moment this file runs, for the release already serving as much as for the next
-- one (#1018 r4325096698: a record written only by the next release would miss every photo deleted in between). The
-- media module's next unit reads it before a new photo is stored under a key, so a key that once named a deleted photo
-- is answered "deleted" and never used again. A photo sent with no key leaves no tombstone. Also one index, "Media" (projectId, uploadedBy, createdAt), for the read of a member's own recent photos
-- that the screen unit adds.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included:
--   T1  One row per key in a project (the primary key), and only for a project that exists (the foreign key).
--   T2  A tombstone is never changed: any UPDATE is refused.
--   T3  A tombstone is never deleted on its own: a direct DELETE (trigger depth 1) is refused. It goes only with its
--       project, through the key's ON DELETE CASCADE, which runs below depth 1, the rule "NotificationReceipt" (20280109)
--       and the site-visit record (20280112) already use. `project:remove` disables ON DELETE triggers on the tables it
--       empties for its own run and puts them back, as it does for every other sealed table.
--   T4  The table is never truncated (a statement-level seal), except by the sanctioned reset, which lifts the seal by
--       name ("TRUNCATE_SEALS" in prisma/sanctioned-reset.ts) for a `TRUNCATE "Project" CASCADE` that reaches it.
--   T5  Every deleted "Media" row with a key leaves its tombstone (AFTER DELETE, per row; a repeat is a no-op). Every
--       delete of a "Media" row is a photo being removed: the member's or staff Delete, and the seed's wipe before its
--       projects go. None must let the same key be sent again. Nothing cascades into "Media" ("Media"."projectId" is
--       RESTRICT, the markup key sets "sourceMediaId" to NULL, and every other key of it is NO ACTION: no key deletes a
--       "Media" row), and `project:remove` disables this trigger with every other
--       ON DELETE trigger of the tables it empties. A row whose project is already gone in the same statement writes
--       nothing, so the record can never stop a project's removal.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table but not its seals.
-- Every statement is guarded or replaces itself.

CREATE TABLE IF NOT EXISTS "MediaTombstone" (
  "projectId" TEXT NOT NULL,
  "clientKey" TEXT NOT NULL,
  "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaTombstone_pkey" PRIMARY KEY ("projectId", "clientKey")
);

-- The two "Media" statements come before the project key, so the file takes "Media"'s lock before "Project"'s. A writer
-- that touches "Media" and then "Project" therefore never waits on this file while holding what it needs.
CREATE INDEX IF NOT EXISTS "Media_projectId_uploadedBy_createdAt_idx" ON "Media"("projectId", "uploadedBy", "createdAt");

-- T5
CREATE OR REPLACE FUNCTION media_tombstone_on_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."clientKey" IS NOT NULL THEN
    -- read through "Project", so a row whose project went in the same statement writes nothing
    INSERT INTO "MediaTombstone" ("projectId", "clientKey")
    SELECT p."id", OLD."clientKey" FROM "Project" p WHERE p."id" = OLD."projectId"
    ON CONFLICT ("projectId", "clientKey") DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Media_tombstone_on_delete" ON "Media";
CREATE TRIGGER "Media_tombstone_on_delete"
  AFTER DELETE ON "Media"
  FOR EACH ROW EXECUTE FUNCTION media_tombstone_on_delete();

DO $media_tombstone$
DECLARE
  tomb oid := '"MediaTombstone"'::regclass;
  project oid := '"Project"'::regclass;
  key_col smallint := (SELECT attnum FROM pg_attribute WHERE attrelid = '"MediaTombstone"'::regclass AND attname = 'projectId');
  id_col smallint := (SELECT attnum FROM pg_attribute WHERE attrelid = '"Project"'::regclass AND attname = 'id');
  wrong record;
BEGIN
  -- T1/T3: the project key is "MediaTombstone_projectId_fkey": ("projectId") references "Project"("id"), ON DELETE
  -- CASCADE, ON UPDATE CASCADE. A `db push` baseline creates it as RESTRICT when the schema says otherwise. Only this
  -- table's own constraints are read (conrelid), never a name alone: a same-named constraint on a table in another
  -- schema is not this one (#1018 r4324508652). Only the project key is judged: a foreign key here from "projectId" to
  -- "Project", or one under the project key's name. Any of those that is not exactly the key above is dropped, and the
  -- key is added when it is absent, so the table ends with exactly one project key. Any other foreign key on the table
  -- is left as it is (#1018 r4325096692). A second run finds the right key and changes nothing.
  FOR wrong IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = tomb AND contype = 'f'
      AND (conname = 'MediaTombstone_projectId_fkey' OR (confrelid = project AND conkey = ARRAY[key_col]))
      AND NOT (conname = 'MediaTombstone_projectId_fkey' AND confrelid = project
               AND conkey = ARRAY[key_col] AND confkey = ARRAY[id_col]
               AND confdeltype = 'c' AND confupdtype = 'c')
  LOOP
    EXECUTE format('ALTER TABLE "MediaTombstone" DROP CONSTRAINT %I', wrong.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = tomb AND contype = 'f' AND conname = 'MediaTombstone_projectId_fkey') THEN
    ALTER TABLE "MediaTombstone" ADD CONSTRAINT "MediaTombstone_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $media_tombstone$;

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
