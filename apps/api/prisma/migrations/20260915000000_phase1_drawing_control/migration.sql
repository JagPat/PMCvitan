-- Phase 1 Task 3 — controlled drawing lifecycle (additive, diagnostic-first).
--
-- Adds the tenant identity to DrawingRevision (projectId backfilled from the
-- parent drawing, then containment-constrained), the one-label-per-drawing
-- unique, the recipientsFrozenAt stamp, and the DrawingRecipient table whose
-- composite FKs make a forged distribution row impossible even on direct SQL.
--
-- DIAGNOSTICS FIRST — the migration ABORTS (never guesses) when legacy data is
-- ambiguous: duplicate (drawingId, rev) labels or a revision without a parent
-- drawing must be resolved by hand before the constraints can hold.

DO $$
DECLARE
  dup_count integer;
  orphan_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "drawingId", "rev" FROM "DrawingRevision"
    GROUP BY "drawingId", "rev" HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'phase1_drawing_control: % drawing/rev pair(s) carry duplicate revision labels — resolve by hand before migrating', dup_count;
  END IF;

  SELECT count(*) INTO orphan_count
  FROM "DrawingRevision" r LEFT JOIN "Drawing" d ON d."id" = r."drawingId"
  WHERE d."id" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'phase1_drawing_control: % revision(s) have no parent drawing — resolve by hand before migrating', orphan_count;
  END IF;
END $$;

-- DropForeignKey (replaced below by the composite containment FK)
ALTER TABLE "DrawingRevision" DROP CONSTRAINT "DrawingRevision_drawingId_fkey";

-- AlterTable: additive columns. projectId is backfilled from the parent drawing
-- BEFORE it is locked NOT NULL — never invented. recipientsFrozenAt stays NULL
-- for every legacy revision: the migration must not fabricate recipient snapshots.
ALTER TABLE "DrawingRevision" ADD COLUMN "projectId" TEXT;
ALTER TABLE "DrawingRevision" ADD COLUMN "recipientsFrozenAt" TIMESTAMP(3);

UPDATE "DrawingRevision" r
SET "projectId" = d."projectId"
FROM "Drawing" d
WHERE r."drawingId" = d."id";

ALTER TABLE "DrawingRevision" ALTER COLUMN "projectId" SET NOT NULL;

-- CreateTable: WHO a revision was issued to, frozen at issue time.
CREATE TABLE "DrawingRecipient" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleAtIssue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawingRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DrawingRecipient_projectId_userId_idx" ON "DrawingRecipient"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DrawingRecipient_revisionId_userId_key" ON "DrawingRecipient"("revisionId", "userId");

-- CreateIndex: composite identities for tenant-safe references
CREATE UNIQUE INDEX "Drawing_projectId_id_key" ON "Drawing"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DrawingRevision_projectId_id_key" ON "DrawingRevision"("projectId", "id");

-- CreateIndex: one Rev B per drawing — the diagnostic above guarantees this holds
CREATE UNIQUE INDEX "DrawingRevision_drawingId_rev_key" ON "DrawingRevision"("drawingId", "rev");

-- AddForeignKey: containment — a revision's project IS its parent drawing's project
ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_projectId_drawingId_fkey" FOREIGN KEY ("projectId", "drawingId") REFERENCES "Drawing"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a recipient can only name a revision of ITS OWN project
ALTER TABLE "DrawingRecipient" ADD CONSTRAINT "DrawingRecipient_projectId_revisionId_fkey" FOREIGN KEY ("projectId", "revisionId") REFERENCES "DrawingRevision"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: ...and only a user who actually holds a membership on that project.
-- NO ACTION is safe: memberships are soft-removed (status='removed'), never deleted.
ALTER TABLE "DrawingRecipient" ADD CONSTRAINT "DrawingRecipient_projectId_userId_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
