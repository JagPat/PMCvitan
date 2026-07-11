-- Location tree: a per-project hierarchy of zones → rooms → elements that decisions
-- (and later activities / inspections / materials) attach to, so they can be grouped,
-- filtered and browsed by where they live in the building. Additive: Decision.nodeId is
-- nullable, so existing decisions (keyed only by the free-text `room`) keep working.

CREATE TABLE "ProjectNode" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectNode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectNode_projectId_idx" ON "ProjectNode"("projectId");
CREATE INDEX "ProjectNode_parentId_idx" ON "ProjectNode"("parentId");

ALTER TABLE "ProjectNode" ADD CONSTRAINT "ProjectNode_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectNode" ADD CONSTRAINT "ProjectNode_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "ProjectNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Decision" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "Decision_nodeId_idx" ON "Decision"("nodeId");
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
