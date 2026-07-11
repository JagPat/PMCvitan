-- Draft → Publish lifecycle for decisions. A decision with a null `publishedAt` is a private
-- DRAFT: the snapshot delivers it only to its author (`authorId`), it never notifies the
-- client, and the app treats it as weightless (no pending count, no schedule gate). Publishing
-- sets `publishedAt` and fires the normal side-effects. Both columns are additive and nullable
-- so this is safe on the live DB.
ALTER TABLE "Decision" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "Decision" ADD COLUMN "authorId" TEXT;

-- Backfill: every EXISTING decision is already live, so mark it published (at its creation
-- time) — otherwise existing rows would silently become invisible drafts on deploy.
UPDATE "Decision" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL;
