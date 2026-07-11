-- Draft → Publish lifecycle for location-tree nodes (mirrors Decision/Drawing). A node with a
-- null `publishedAt` is a private DRAFT: delivered only to its author, hidden from the team's
-- Site Map and the filing pickers. Publishing a node publishes its subtree + draft ancestors.
-- Both columns are additive and nullable — safe on the live DB.
ALTER TABLE "ProjectNode" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "ProjectNode" ADD COLUMN "authorId" TEXT;

-- Backfill: every EXISTING node is already live, so mark it published (at its creation time) —
-- otherwise existing locations would silently become invisible drafts on deploy.
UPDATE "ProjectNode" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL;
