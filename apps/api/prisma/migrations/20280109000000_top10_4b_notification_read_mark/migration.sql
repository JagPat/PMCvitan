-- Top 10 #4b (#778) — each viewer's read watermark on a project's notification feed.
--
-- The bell has no read state: its badge counts every notice, so a viewer cannot tell new from seen (live-bug 2,
-- the owner's retest of 2026-10-07). Notices are per project, not per recipient, so "read" is a per-viewer
-- WATERMARK rather than a flag per notice: a notice is unread for a viewer when it was written after that viewer's
-- "seenAt". One row per (project, user); opening the bell moves it forward (4c).
--
-- The watermark only moves FORWARD, enforced here and not only by the writer: a late or replayed "mark seen"
-- carrying an older instant (an offline replay, a second tab) must never make already-seen notices unread
-- again. The BEFORE UPDATE trigger keeps the greater of the stored and proposed instants.
--
-- Both references CASCADE: the mark is derived per-viewer state with no history value, so it goes with its
-- project or its user. That also keeps the seed's DELETE phase closed (the project and user wipes reach it by
-- cascade; reset-list-closure.test.ts).
--
-- Additive and previous-release safe: an old release neither reads nor writes the table.
CREATE TABLE IF NOT EXISTS "NotificationReadMark" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationReadMark_pkey" PRIMARY KEY ("projectId", "userId")
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
BEGIN
  NEW."seenAt" := GREATEST(OLD."seenAt", NEW."seenAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NotificationReadMark_forward_only" ON "NotificationReadMark";
CREATE TRIGGER "NotificationReadMark_forward_only"
  BEFORE UPDATE ON "NotificationReadMark"
  FOR EACH ROW EXECUTE FUNCTION "NotificationReadMark_forward_only"();
