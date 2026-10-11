-- Top 10 #4b (#778) — per-notice read receipts: one row per (notice, viewer) that has seen it.
--
-- The bell has no read state: its badge counts every notice, so a viewer cannot tell new from seen (live-bug 2,
-- the owner's retest of 2026-10-07). Notices are per project, not per recipient, so read state is per viewer.
-- A notice is unread for a viewer exactly when that viewer holds no receipt for it. Which receipts get written,
-- and only for notices actually served to the viewer, is 4c's (units B–D of #785's approved redesign); this unit
-- is the storage and the invariants the database owns. Additive, with NO backfill (#778): existing notices start
-- unread.
--
-- This replaces #785's earlier transaction-snapshot design (review rounds 1–3: commit order, writer stamps, cluster
-- identity). A receipt names a notice by id, so nothing here is ordered, nothing is cluster-local, and a dump
-- restored anywhere means the same thing.
--
-- INVARIANTS (every writer, raw SQL included):
--   R1  Tenant binding, continuously. A receipt's (notificationId, projectId) is a composite foreign key to the
--       notice's (id, projectId) — ON UPDATE NO ACTION — so at every committed state the receipt and its notice
--       share one project. 4d-i freezes a notice's project only when it is KINDED; a kindless notice could
--       otherwise move to another project after a receipt exists, carrying a viewer's receipt into a project
--       where their standing was never judged. With this key the move is refused while a receipt references the
--       old pair; a kindless notice with no receipt stays exactly as movable as before. (CASCADE is deliberately
--       not used: following the move would be that unjudged carry.)
--   R2  Standing at insert. A receipt is written only for a viewer with standing on the project, by the existing
--       windowed contract — a `ProjectUserStanding` row in any role, or `pmc` through
--       `platform_user_holds_role_windowed` (a membership-less org owner/admin before 4d-iii re-projects) — on an
--       operable project (`phase6_project_operable`, the existing project-row lock against an archive). The
--       registers are read under the actor envelope's lock order (OrgUserAuthority, then ProjectUserStanding,
--       FOR SHARE), so a concurrent removal or demotion of a PRESENT row waits for the insert or is seen by it.
--       Only kernel registers and kernel functions are read; no org table, no new permission.
--   R3  Immutable. A receipt is never updated. It is never deleted directly; it goes only with its notice, its
--       viewer or its project (the foreign keys' cascades, which run below trigger depth 1).
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the table, the composite
-- key and the unique key it references, but not the triggers. Every statement is guarded.
--
-- Previous-release safe: `Notification` gains no column and no trigger, only a unique index on (id, projectId),
-- which every existing row already satisfies because `id` is its primary key. An older release neither reads nor
-- writes receipts, and its notice inserts, deletes and (receipt-free) updates behave exactly as before.

CREATE UNIQUE INDEX IF NOT EXISTS "Notification_id_projectId_key" ON "Notification"("id", "projectId");

CREATE TABLE IF NOT EXISTS "NotificationReceipt" (
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationReceipt_pkey" PRIMARY KEY ("notificationId", "userId")
);

CREATE INDEX IF NOT EXISTS "NotificationReceipt_projectId_userId_idx" ON "NotificationReceipt"("projectId", "userId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReceipt_notificationId_projectId_fkey') THEN
    ALTER TABLE "NotificationReceipt" ADD CONSTRAINT "NotificationReceipt_notificationId_projectId_fkey"
      FOREIGN KEY ("notificationId", "projectId") REFERENCES "Notification"("id", "projectId") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReceipt_userId_fkey') THEN
    ALTER TABLE "NotificationReceipt" ADD CONSTRAINT "NotificationReceipt_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationReceipt_projectId_fkey') THEN
    ALTER TABLE "NotificationReceipt" ADD CONSTRAINT "NotificationReceipt_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- R2 — the viewer has standing on an operable project when the receipt is written.
CREATE OR REPLACE FUNCTION "NotificationReceipt_viewer_standing"() RETURNS trigger AS $$
BEGIN
  -- the established order: the actor envelope's register locks (OrgUserAuthority through the project's org, then
  -- ProjectUserStanding), and only then the project row the operability check holds — as every 4d emit does
  PERFORM 1 FROM "OrgUserAuthority" a JOIN "ProjectOrg" po ON po."orgId" = a."orgId"
   WHERE po."projectId" = NEW."projectId" AND a."userId" = NEW."userId"
     FOR SHARE OF a;
  PERFORM 1 FROM "ProjectUserStanding"
   WHERE "projectId" = NEW."projectId" AND "userId" = NEW."userId"
     FOR SHARE;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'top10 4b: project % is not operable, so no receipt may be written on it', NEW."projectId";
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM "ProjectUserStanding" s WHERE s."projectId" = NEW."projectId" AND s."userId" = NEW."userId")
          OR platform_user_holds_role_windowed(NEW."projectId", NEW."userId", 'pmc')) THEN
    RAISE EXCEPTION 'top10 4b: user % has no standing on project %, so no receipt may be written for them', NEW."userId", NEW."projectId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NotificationReceipt_viewer_standing" ON "NotificationReceipt";
CREATE TRIGGER "NotificationReceipt_viewer_standing"
  BEFORE INSERT ON "NotificationReceipt"
  FOR EACH ROW EXECUTE FUNCTION "NotificationReceipt_viewer_standing"();

-- R3 — never updated; never deleted except by a cascade (a foreign key's action runs below trigger depth 1).
CREATE OR REPLACE FUNCTION "NotificationReceipt_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'top10 4b: receipt (%, %) is immutable', OLD."notificationId", OLD."userId";
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'top10 4b: receipt (%, %) may not be deleted directly; it goes only with its notice, viewer or project', OLD."notificationId", OLD."userId";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NotificationReceipt_immutable" ON "NotificationReceipt";
CREATE TRIGGER "NotificationReceipt_immutable"
  BEFORE UPDATE OR DELETE ON "NotificationReceipt"
  FOR EACH ROW EXECUTE FUNCTION "NotificationReceipt_immutable"();
