-- Phase 2 Task 7 — edge decision table (docs/reviews/phase2-projection-matrix.md §1):
-- edges 5, 6 and 7 are REFERENTIAL UNFILING, not business consequences, so they become
-- database FK ACTIONS instead of service-owned cross-module writes. Each composite FK
-- (projectId, <col>) referenced ProjectNode/Activity/Phase with ON DELETE NO ACTION,
-- so today the writer service nulls the <col> in application code (a cross-module edge).
--
-- PostgreSQL 15+ column-list `ON DELETE SET NULL (<col>)` nulls ONLY the referencing
-- column, leaving the NOT-NULL tenant `projectId` intact — which a bare composite
-- SET NULL could not do (it would null projectId too). Prisma cannot express the
-- column-list form, so this is an ACCEPTED-DRIFT raw-SQL migration (the same convention
-- as the CHECK/partial-index/composite-FK migrations); schema.prisma keeps NoAction with
-- a pointer here. Additive + row-free: it changes only the ON DELETE behaviour of
-- existing constraints; no row is written or transformed. Rollback = re-create the
-- constraints with ON DELETE NO ACTION.
--
-- NOT converted (they stay NO ACTION, on purpose):
--   • Decision_projectId_nodeId_fkey  — the one reference nodes.remove REFUSES to unfile
--     (a guard: the PMC must move/remove attached decisions first).
--   • Inspection_projectId_activityId_fkey, GateOverride_projectId_activityId_fkey —
--     the "linked records" that BLOCK an activity delete (activities.remove surfaces the
--     resulting error as a friendly Conflict); nulling them would silently orphan them.

-- edge 7: node unfiling across five domains → SET NULL (nodeId)
ALTER TABLE "Activity"     DROP CONSTRAINT "Activity_projectId_nodeId_fkey";
ALTER TABLE "Activity"     ADD  CONSTRAINT "Activity_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", id) ON DELETE SET NULL ("nodeId");

ALTER TABLE "Inspection"   DROP CONSTRAINT "Inspection_projectId_nodeId_fkey";
ALTER TABLE "Inspection"   ADD  CONSTRAINT "Inspection_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", id) ON DELETE SET NULL ("nodeId");

ALTER TABLE "Media"        DROP CONSTRAINT "Media_projectId_nodeId_fkey";
ALTER TABLE "Media"        ADD  CONSTRAINT "Media_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", id) ON DELETE SET NULL ("nodeId");

ALTER TABLE "Drawing"      DROP CONSTRAINT "Drawing_projectId_nodeId_fkey";
ALTER TABLE "Drawing"      ADD  CONSTRAINT "Drawing_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", id) ON DELETE SET NULL ("nodeId");

ALTER TABLE "SiteMaterial" DROP CONSTRAINT "SiteMaterial_projectId_nodeId_fkey";
ALTER TABLE "SiteMaterial" ADD  CONSTRAINT "SiteMaterial_projectId_nodeId_fkey"
  FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", id) ON DELETE SET NULL ("nodeId");

-- edge 5: an activity delete unlinks the drawings it governed → SET NULL (activityId)
ALTER TABLE "Drawing"  DROP CONSTRAINT "Drawing_projectId_activityId_fkey";
ALTER TABLE "Drawing"  ADD  CONSTRAINT "Drawing_projectId_activityId_fkey"
  FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", id) ON DELETE SET NULL ("activityId");

-- edge 6: a phase delete detaches its activities → SET NULL (phaseId)
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_projectId_phaseId_fkey";
ALTER TABLE "Activity" ADD  CONSTRAINT "Activity_projectId_phaseId_fkey"
  FOREIGN KEY ("projectId", "phaseId") REFERENCES "Phase"("projectId", id) ON DELETE SET NULL ("phaseId");
