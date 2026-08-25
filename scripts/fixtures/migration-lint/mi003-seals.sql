-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #411 head a222e91 (unchanged through #412 — only migrate.sh differed)
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  1707-1712 (section 9's self-verification) + the seal install it verifies
-- Proves: MI-003 — seals verified only at apply time. RED and GREEN differ ONLY in migrate.sh.

-- The RUNBOOK procedure token is what ties this file to its deploy-time counterpart.
-- RAISE messages in this migration end with: Procedure: docs/RUNBOOK.md section B1.
DO $install$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate()', 'ActivityDependency_no_truncate');
END $install$;

DO $finish$
DECLARE v_missing TEXT;
BEGIN
  SELECT string_agg(t.name, $q$, $q$) INTO v_missing FROM (VALUES
    ('ActivityDependency_no_truncate')) AS t(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgname = t.name AND g.tgenabled = 'O'
                        AND pg_get_triggerdef(g.oid) IS NOT NULL);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: seal % is not armed. Procedure: docs/RUNBOOK.md section B1.', v_missing;
  END IF;
END $finish$;
