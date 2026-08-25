-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #412 head 96c9cc4 (the head that fixed #411's a222e91)
-- File:   apps/api/prisma/migrations/20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  844-890 (section 1e'', the per-trigger enforcement read)
-- Proves: MI-001 — the corrected form PASSES. The same query that tests contype = 'f' reaches the
--         key's own internal triggers through tgconstraint and asks what tgenabled says.
-- Trimmed by deleting 17 of the 20 whole VALUES rows, which changes nothing the rule reads;
-- nothing inside any surviving line is altered. The scaffolding below is added, as in the RED
-- fixture, because a PL/pgSQL fragment is not a file.

DO $$
DECLARE v_bad TEXT; v_wrong TEXT;
BEGIN
  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO v_bad FROM (
    SELECT format('foreign key "%s" is not enforced on its %s: expected exactly one enabled internal trigger of type %s running pg_catalog."%s"() on %s, found %s',
                  e.name, e.side, e.tgtype::TEXT, e.fn, e.rel::REGCLASS::TEXT, e.found) AS what
      FROM (
        SELECT k.name, k.side, k.fn, k.tgtype,
               CASE WHEN k.side = 'referencing side' THEN c.conrelid ELSE c.confrelid END AS rel,
               (SELECT CASE WHEN COUNT(*) = 0 THEN 'none'
                            WHEN COUNT(*) > 1 THEN COUNT(*)::TEXT || ' of them'
                            WHEN MIN(g.tgenabled::TEXT) = 'D' THEN 'one, DISABLED'
                            WHEN MIN(g.tgenabled::TEXT) = 'R' THEN 'one, REPLICA-ONLY'
                            WHEN MIN(g.tgenabled::TEXT) NOT IN ('O', 'A')
                                 THEN 'one, in state ' || MIN(g.tgenabled::TEXT)
                            ELSE 'exactly that' END
                  FROM pg_trigger g
                  JOIN pg_proc p ON p.oid = g.tgfoid
                  JOIN pg_namespace pn ON pn.oid = p.pronamespace
                 WHERE g.tgconstraint = c.oid AND g.tgisinternal AND g.tgtype = k.tgtype
                   AND g.tgrelid = CASE WHEN k.side = 'referencing side'
                                        THEN c.conrelid ELSE c.confrelid END
                   AND pn.nspname = 'pg_catalog' AND p.proname = k.fn) AS found
          FROM (VALUES
            ('ActivityDependency_projectId_fkey',              'referencing side',        'RI_FKey_check_ins',     5::SMALLINT),
            ('ActivityDependency_revokedBy_fkey',              'referenced ON UPDATE',    'RI_FKey_noaction_upd', 17::SMALLINT),
            ('ActivityDependency_revokedBy_fkey',              'referenced ON DELETE',    'RI_FKey_noaction_del',  9::SMALLINT)
          ) AS k(name, side, fn, tgtype)
          JOIN pg_constraint c ON c.conname = k.name AND c.contype = 'f'
                              AND c.conrelid = 'public."ActivityDependency"'::regclass
      ) e
     WHERE e.found <> 'exactly that'
  ) x;
END $$;
