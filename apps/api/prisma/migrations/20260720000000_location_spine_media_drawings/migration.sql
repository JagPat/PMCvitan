-- Location spine, wave 2: extend the location tree (zones → rooms → objects) to
-- photos and drawings so every discipline pins to the same place. A photo pinned to a
-- node is "the reality" there; a drawing pinned to a node is "the intent" — the Place
-- view reads both off one coordinate. Additive: both columns are nullable with
-- ON DELETE SET NULL, so existing media/drawings (unfiled) keep working and removing a
-- location never deletes a photo or drawing.

ALTER TABLE "Media" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "Media_nodeId_idx" ON "Media"("nodeId");
ALTER TABLE "Media" ADD CONSTRAINT "Media_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Drawing" ADD COLUMN "nodeId" TEXT;
CREATE INDEX "Drawing_nodeId_idx" ON "Drawing"("nodeId");
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "ProjectNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
