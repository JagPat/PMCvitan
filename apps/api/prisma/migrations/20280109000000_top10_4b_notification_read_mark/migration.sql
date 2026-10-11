-- Top 10 #4b (#778) — each viewer's read position on a project's notification feed.
--
-- The bell has no read state: its badge counts every notice, so a viewer cannot tell new from seen (live-bug 2,
-- the owner's retest of 2026-10-07). Notices are per project, not per recipient, so "read" is a per-viewer
-- position on the feed rather than a flag per notice. One row per (project, user); opening the bell moves it (4c).
--
-- The position is COMMIT-ordered, not a timestamp (#785 review round 1). `Notification.at` is the writing
-- transaction's start instant: a notice whose transaction began before a "mark seen" and committed after it would
-- carry an earlier `at` than the mark although the viewer never saw it, and notices in one millisecond tie. So:
--   * every notice records the transaction that wrote it (`Notification.writerXid`, defaulted from
--     `pg_current_xact_id()`; a writer never sets it), and
--   * the mark stores the SNAPSHOT the viewer's feed was read under (`seenSnapshot`, the `pg_snapshot` text form).
-- A notice is seen exactly when its writer is visible in that snapshot: committed before the feed was read, so it
-- was in the feed. A notice committed later, however early its transaction began, is not visible, so it stays
-- unread. Rows written before this migration carry no writer; every mark is taken after them, so they read as seen
-- once the viewer has a mark at all.
--
-- The position only moves FORWARD, enforced here and not only by the writer: a late or replayed "mark seen"
-- carrying an older snapshot (an offline replay, a second tab) must never make already-seen notices unread again.
-- A snapshot taken later sees a superset of an earlier one, and the later of two snapshots has the greater xmax,
-- or the same xmax and no more in-progress transactions. The BEFORE UPDATE trigger keeps the later of the stored
-- and proposed snapshots by that order. The CHECK refuses text that is not a snapshot.
--
-- Both references CASCADE: the mark is derived per-viewer state with no history value, so it goes with its
-- project or its user. That also keeps the seed's DELETE phase closed (the project and user wipes reach it by
-- cascade; reset-list-closure.test.ts).
--
-- Additive and previous-release safe: the new Notification column is nullable and defaulted, so an older
-- release's inserts fill it without naming it (the column is added first and the default set separately, so no
-- existing row is rewritten), and an old release neither reads nor writes the mark table.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "writerXid" BIGINT;
ALTER TABLE "Notification" ALTER COLUMN "writerXid" SET DEFAULT ((pg_current_xact_id())::text)::bigint;

CREATE TABLE IF NOT EXISTS "NotificationReadMark" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenSnapshot" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationReadMark_pkey" PRIMARY KEY ("projectId", "userId"),
    CONSTRAINT "NotificationReadMark_seenSnapshot_check" CHECK (("seenSnapshot")::pg_snapshot IS NOT NULL)
);

DO $$ BEGIN
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
  IF pg_snapshot_xmax(new_snap) < pg_snapshot_xmax(old_snap)
     OR (pg_snapshot_xmax(new_snap) = pg_snapshot_xmax(old_snap)
         AND (SELECT count(*) FROM pg_snapshot_xip(new_snap)) > (SELECT count(*) FROM pg_snapshot_xip(old_snap))) THEN
    NEW."seenSnapshot" := OLD."seenSnapshot";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NotificationReadMark_forward_only" ON "NotificationReadMark";
CREATE TRIGGER "NotificationReadMark_forward_only"
  BEFORE UPDATE ON "NotificationReadMark"
  FOR EACH ROW EXECUTE FUNCTION "NotificationReadMark_forward_only"();
