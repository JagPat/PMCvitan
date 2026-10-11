-- Top 10 #4b (#778) — each viewer's read position on a project's notification feed.
--
-- The bell has no read state: its badge counts every notice, so a viewer cannot tell new from seen (live-bug 2,
-- the owner's retest of 2026-10-07). Notices are per project, not per recipient, so "read" is a per-viewer
-- position on the feed rather than a flag per notice. One row per (project, user); opening the bell moves it (4c).
--
-- The position is COMMIT-ordered, not a timestamp (#785 review round 1). `Notification.at` is the writing
-- transaction's start instant: a notice whose transaction began before a "mark seen" and committed after it would
-- carry an earlier `at` than the mark although the viewer never saw it, and notices in one millisecond tie. So:
--   * every notice records the transaction that wrote it (`Notification.writerXid`), and
--   * the mark stores the SNAPSHOT the viewer's feed was read under (`seenSnapshot`, the `pg_snapshot` text form).
-- A notice is seen exactly when its writer is visible in that snapshot: committed before the feed was read, so it
-- was in the feed. A notice committed later, however early its transaction began, is not visible, so it stays
-- unread. Rows written before this migration carry no writer; every mark is taken after them, so they read as seen
-- once the viewer has a mark at all.
--
-- Every invariant is the DATABASE's, on every writer and every deploy path (#785 review round 2):
--   * The writer stamp is the inserting transaction, always: a BEFORE INSERT trigger sets it whatever an insert
--     supplies (NULL, an old id), and an UPDATE can neither rewrite it nor fill it on a pre-migration row. Either
--     would silently move a notice across every viewer's read position.
--   * The position only moves FORWARD. A proposed snapshot replaces the stored one only when it sees everything the
--     stored one saw: its xmax is no lower, and every transaction it still counts in progress below the stored
--     xmax was in progress in the stored one too. A late or replayed "mark seen" (an offline replay, a second tab)
--     and a snapshot that is not a successor (crafted, or incomparable) both keep the stored position, so an
--     already-seen notice is never made unread again.
--   * Transaction ids belong to one cluster. A stored position whose xmax is beyond this cluster's current xmax
--     cannot have been taken here (a logical copy, a dump restored into a fresh cluster): it is void, so any real
--     snapshot may replace it, and 4c reads it as no position at all.
--   * The CHECK refuses text that is not a snapshot.
--
-- Both references CASCADE: the mark is derived per-viewer state with no history value, so it goes with its
-- project or its user. That also keeps the seed's DELETE phase closed (the project and user wipes reach it by
-- cascade; reset-list-closure.test.ts).
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the column and the table
-- but none of the triggers or the CHECK, so on that path this file must run rather than be resolved. Every
-- statement is guarded: the column and table by IF NOT EXISTS, the CHECK and foreign keys by name (a table db push
-- created skips CREATE TABLE's body), the functions by CREATE OR REPLACE and the triggers by DROP IF EXISTS.
--
-- Additive and previous-release safe: the new Notification column is nullable, so an older release's inserts need
-- not name it (the trigger stamps them; the column is added first and its default set separately, so no existing
-- row is rewritten), and an old release neither reads nor writes the mark table.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "writerXid" BIGINT;
ALTER TABLE "Notification" ALTER COLUMN "writerXid" SET DEFAULT ((pg_current_xact_id())::text)::bigint;

CREATE OR REPLACE FUNCTION "Notification_writerXid_frozen"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."writerXid" := ((pg_current_xact_id())::text)::bigint;
  ELSIF NEW."writerXid" IS DISTINCT FROM OLD."writerXid" THEN
    RAISE EXCEPTION 'top10 4b: notice %''s writer is fixed at insert', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Notification_writerXid_frozen" ON "Notification";
CREATE TRIGGER "Notification_writerXid_frozen"
  BEFORE INSERT OR UPDATE OF "writerXid" ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION "Notification_writerXid_frozen"();

CREATE TABLE IF NOT EXISTS "NotificationReadMark" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenSnapshot" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationReadMark_pkey" PRIMARY KEY ("projectId", "userId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReadMark_seenSnapshot_check') THEN
    ALTER TABLE "NotificationReadMark" ADD CONSTRAINT "NotificationReadMark_seenSnapshot_check"
      CHECK (("seenSnapshot")::pg_snapshot IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReadMark_projectId_fkey') THEN
    ALTER TABLE "NotificationReadMark" ADD CONSTRAINT "NotificationReadMark_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReadMark_userId_fkey') THEN
    ALTER TABLE "NotificationReadMark" ADD CONSTRAINT "NotificationReadMark_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "NotificationReadMark_forward_only"() RETURNS trigger AS $$
DECLARE
  old_snap pg_snapshot := OLD."seenSnapshot"::pg_snapshot;
  new_snap pg_snapshot := NEW."seenSnapshot"::pg_snapshot;
BEGIN
  -- a stored position from another cluster is void: any proposed one replaces it
  IF pg_snapshot_xmax(old_snap) > pg_snapshot_xmax(pg_current_snapshot()) THEN
    RETURN NEW;
  END IF;
  -- otherwise the proposed one must see everything the stored one saw
  IF pg_snapshot_xmax(new_snap) < pg_snapshot_xmax(old_snap)
     OR EXISTS (
       SELECT 1 FROM pg_snapshot_xip(new_snap) AS x
       WHERE x < pg_snapshot_xmax(old_snap)
         AND x NOT IN (SELECT pg_snapshot_xip(old_snap))
     ) THEN
    NEW."seenSnapshot" := OLD."seenSnapshot";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NotificationReadMark_forward_only" ON "NotificationReadMark";
CREATE TRIGGER "NotificationReadMark_forward_only"
  BEFORE UPDATE ON "NotificationReadMark"
  FOR EACH ROW EXECUTE FUNCTION "NotificationReadMark_forward_only"();
