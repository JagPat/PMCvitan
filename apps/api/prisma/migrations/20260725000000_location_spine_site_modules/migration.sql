-- Location spine, wave 3: extend the location tree (zones → rooms → objects) to the
-- remaining site modules — activities (the work), inspections (quality checks) and site
-- materials (deliveries) — so a place shows its full picture in the Site Map. Additive:
-- every column is nullable with ON DELETE SET NULL, so existing rows stay unfiled and
-- removing a location never deletes work, an inspection or a material.

ALTER TABLE "Activity" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "Activity_nodeId_idx" ON "Activity"("nodeId");
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Inspection" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "Inspection_nodeId_idx" ON "Inspection"("nodeId");
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SiteMaterial" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "SiteMaterial_nodeId_idx" ON "SiteMaterial"("nodeId");
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
