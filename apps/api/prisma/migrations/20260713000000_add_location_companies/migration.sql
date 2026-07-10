-- AlterTable: project site address (free text), non-breaking default
ALTER TABLE "Project" ADD COLUMN "location" TEXT NOT NULL DEFAULT '';

-- CreateTable: firms/consultants associated with a project
CREATE TABLE "ProjectCompany" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectCompany_projectId_idx" ON "ProjectCompany"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectCompany" ADD CONSTRAINT "ProjectCompany_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
