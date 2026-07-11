-- Draft → Publish lifecycle for drawings (mirrors Decision). A drawing with a null
-- `publishedAt` is a private DRAFT: the snapshot delivers it only to its author (`authorId`),
-- it never notifies the build team, and it's absent from the register / Site Map. Publishing
-- issues it. Both columns are additive and nullable — safe on the live DB.
ALTER TABLE "Drawing" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "Drawing" ADD COLUMN "authorId" TEXT;

-- Backfill: every EXISTING drawing is already issued, so mark it published (at its creation
-- time) — otherwise existing rows would silently become invisible drafts on deploy.
UPDATE "Drawing" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL;
