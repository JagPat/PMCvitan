-- Codex gate finding 4: complete the database-level tenant constraints.
-- Node, phase and material relations were single-column FKs — a DIRECT database
-- write could link one project's record to another project's node/phase/decision.
-- Composite (projectId, <ref>) FKs make that impossible in PostgreSQL itself.
-- SET NULL cascades become NO ACTION + service-owned unlinks (NodesService), the
-- same pattern 20260902000000_phase0_project_integrity set for drawings.

-- ── Diagnostics FIRST: fail LOUDLY if any cross-project or dangling link exists.
-- This migration never silently nulls or reassigns corrupt data.
DO $$
DECLARE n integer;
BEGIN
  -- ProjectNode.parentId (tree edge)
  SELECT count(*) INTO n FROM "ProjectNode" c JOIN "ProjectNode" p ON p.id = c."parentId"
    WHERE c."parentId" IS NOT NULL AND p."projectId" <> c."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % ProjectNode.parentId edge(s) cross projects — fix by hand before migrating', n; END IF;

  -- nodeId references (five referrers)
  SELECT count(*) INTO n FROM "Decision" r JOIN "ProjectNode" x ON x.id = r."nodeId"
    WHERE r."nodeId" IS NOT NULL AND x."projectId" <> r."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Decision.nodeId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Activity" r JOIN "ProjectNode" x ON x.id = r."nodeId"
    WHERE r."nodeId" IS NOT NULL AND x."projectId" <> r."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Activity.nodeId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Inspection" r JOIN "ProjectNode" x ON x.id = r."nodeId"
    WHERE r."nodeId" IS NOT NULL AND x."projectId" <> r."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Inspection.nodeId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Media" r JOIN "ProjectNode" x ON x.id = r."nodeId"
    WHERE r."nodeId" IS NOT NULL AND x."projectId" <> r."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Media.nodeId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Drawing" r JOIN "ProjectNode" x ON x.id = r."nodeId"
    WHERE r."nodeId" IS NOT NULL AND x."projectId" <> r."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Drawing.nodeId link(s) cross projects', n; END IF;

  -- Activity.phaseId
  SELECT count(*) INTO n FROM "Activity" a JOIN "Phase" p ON p.id = a."phaseId"
    WHERE a."phaseId" IS NOT NULL AND p."projectId" <> a."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % Activity.phaseId link(s) cross projects', n; END IF;

  -- SiteMaterial: its project is its daily log's project; decision/node must match it
  SELECT count(*) INTO n FROM "SiteMaterial" m JOIN "DailyLog" l ON l.id = m."dailyLogId"
    JOIN "Decision" d ON d.id = m."decisionId"
    WHERE m."decisionId" IS NOT NULL AND d."projectId" <> l."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % SiteMaterial.decisionId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "SiteMaterial" m JOIN "DailyLog" l ON l.id = m."dailyLogId"
    JOIN "ProjectNode" x ON x.id = m."nodeId"
    WHERE m."nodeId" IS NOT NULL AND x."projectId" <> l."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_tenant_constraints: % SiteMaterial.nodeId link(s) cross projects', n; END IF;
END $$;

-- ── SiteMaterial gains canonical project ownership (backfilled from its daily log).
ALTER TABLE "SiteMaterial" ADD COLUMN "projectId" TEXT;
UPDATE "SiteMaterial" m SET "projectId" = l."projectId" FROM "DailyLog" l WHERE l."id" = m."dailyLogId";
ALTER TABLE "SiteMaterial" ALTER COLUMN "projectId" SET NOT NULL;
CREATE INDEX "SiteMaterial_projectId_idx" ON "SiteMaterial"("projectId");
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Unique keys: the composite identities the new FKs reference.
CREATE UNIQUE INDEX "ProjectNode_projectId_id_key" ON "ProjectNode"("projectId", "id");
CREATE UNIQUE INDEX "Phase_projectId_id_key" ON "Phase"("projectId", "id");

-- ── Composite foreign keys. NO ACTION on delete/update (the owning projectId is
-- non-null so SET NULL is impossible; unlinking is service-owned — NodesService
-- clears every reference in the deleted subtree in-transaction). A NULL reference
-- column means the constraint is not checked (MATCH SIMPLE) — the optional-link
-- semantics these fields have. The tree edge keeps CASCADE: deleting a parent
-- removes the subtree, which never needs column-nulling.

ALTER TABLE "ProjectNode" DROP CONSTRAINT "ProjectNode_parentId_fkey";
ALTER TABLE "ProjectNode" ADD CONSTRAINT "ProjectNode_projectId_parentId_fkey"
  FOREIGN KEY ("projectId", "parentId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "Decision" DROP CONSTRAINT "Decision_nodeId_fkey";
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Activity" DROP CONSTRAINT "Activity_nodeId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_nodeId_fkey";
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Media" DROP CONSTRAINT "Media_nodeId_fkey";
ALTER TABLE "Media" ADD CONSTRAINT "Media_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Drawing" DROP CONSTRAINT "Drawing_nodeId_fkey";
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Activity" DROP CONSTRAINT "Activity_phaseId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_phaseId_fkey"
  FOREIGN KEY ("projectId", "phaseId") REFERENCES "Phase"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "SiteMaterial" DROP CONSTRAINT "SiteMaterial_dailyLogId_fkey";
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_projectId_dailyLogId_fkey"
  FOREIGN KEY ("projectId", "dailyLogId") REFERENCES "DailyLog"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "SiteMaterial" DROP CONSTRAINT "SiteMaterial_decisionId_fkey";
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "SiteMaterial" DROP CONSTRAINT "SiteMaterial_nodeId_fkey";
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
