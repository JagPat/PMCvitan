-- Phase 0 Task 5: same-project references enforced by PostgreSQL itself.
-- Composite (projectId, <ref>) foreign keys make a cross-project link impossible
-- even through a forged request or a direct database write.

-- ── Diagnostics FIRST: fail LOUDLY if any cross-project or dangling link exists.
-- This migration never silently nulls or reassigns corrupt data — a failure here
-- means a human must look at the rows it names.
DO $$
DECLARE n integer;
BEGIN
  -- Drawing.activityId
  SELECT count(*) INTO n FROM "Drawing" d JOIN "Activity" a ON a.id = d."activityId"
    WHERE d."activityId" IS NOT NULL AND a."projectId" <> d."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Drawing.activityId link(s) cross projects — fix by hand before migrating', n; END IF;
  SELECT count(*) INTO n FROM "Drawing" d LEFT JOIN "Activity" a ON a.id = d."activityId"
    WHERE d."activityId" IS NOT NULL AND a.id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Drawing.activityId link(s) dangle (activity missing)', n; END IF;

  -- Drawing.decisionId
  SELECT count(*) INTO n FROM "Drawing" d JOIN "Decision" x ON x.id = d."decisionId"
    WHERE d."decisionId" IS NOT NULL AND x."projectId" <> d."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Drawing.decisionId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Drawing" d LEFT JOIN "Decision" x ON x.id = d."decisionId"
    WHERE d."decisionId" IS NOT NULL AND x.id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Drawing.decisionId link(s) dangle', n; END IF;

  -- Media.decisionId
  SELECT count(*) INTO n FROM "Media" m JOIN "Decision" x ON x.id = m."decisionId"
    WHERE m."decisionId" IS NOT NULL AND x."projectId" <> m."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Media.decisionId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Media" m LEFT JOIN "Decision" x ON x.id = m."decisionId"
    WHERE m."decisionId" IS NOT NULL AND x.id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Media.decisionId link(s) dangle', n; END IF;

  -- Media.dailyLogId
  SELECT count(*) INTO n FROM "Media" m JOIN "DailyLog" l ON l.id = m."dailyLogId"
    WHERE m."dailyLogId" IS NOT NULL AND l."projectId" <> m."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Media.dailyLogId link(s) cross projects', n; END IF;
  SELECT count(*) INTO n FROM "Media" m LEFT JOIN "DailyLog" l ON l.id = m."dailyLogId"
    WHERE m."dailyLogId" IS NOT NULL AND l.id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Media.dailyLogId link(s) dangle', n; END IF;

  -- Activity.decisionId (had a single-column FK, so it cannot dangle — but it COULD cross projects)
  SELECT count(*) INTO n FROM "Activity" a JOIN "Decision" x ON x.id = a."decisionId"
    WHERE a."decisionId" IS NOT NULL AND x."projectId" <> a."projectId";
  IF n > 0 THEN RAISE EXCEPTION 'phase0_project_integrity: % Activity.decisionId link(s) cross projects', n; END IF;
END $$;

-- ── Unique keys first: the composite identities the new FKs reference.
-- ("Activity" already has Activity_projectId_id_key from 0_init.)
CREATE UNIQUE INDEX "Decision_projectId_id_key" ON "Decision"("projectId", "id");
CREATE UNIQUE INDEX "DailyLog_projectId_id_key" ON "DailyLog"("projectId", "id");

-- ── Composite foreign keys. NO ACTION on delete/update: the owning projectId is
-- non-null so SET NULL is impossible; deletion behavior stays service-owned
-- (ActivitiesService.remove unlinks referencing drawings before deleting).
-- A NULL reference column means the constraint is not checked (MATCH SIMPLE) —
-- exactly the optional-link semantics these fields have.

-- Activity.decisionId: replace the single-column FK with the composite one.
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_decisionId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Drawing.activityId / Drawing.decisionId: previously loose strings — now enforced.
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_projectId_activityId_fkey"
  FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Drawing" ADD CONSTRAINT "Drawing_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Media.decisionId / Media.dailyLogId: previously loose strings — now enforced.
ALTER TABLE "Media" ADD CONSTRAINT "Media_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "Media" ADD CONSTRAINT "Media_projectId_dailyLogId_fkey"
  FOREIGN KEY ("projectId", "dailyLogId") REFERENCES "DailyLog"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
