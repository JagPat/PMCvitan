-- Templates Slice 2: org-owned reusable structure modules (docs/TEMPLATES.md).
-- Purely additive — no existing table changes.
CREATE TABLE "TemplateModule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "anchorKind" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateModule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TemplateModule_orgId_category_idx" ON "TemplateModule"("orgId", "category");

ALTER TABLE "TemplateModule" ADD CONSTRAINT "TemplateModule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
