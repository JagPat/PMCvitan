-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #412 head 96c9cc4 (the head that fixed #411's a222e91)
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  1003-1021 (barrier compared by definition) + 845-863 (per-key enforcement read)
-- Proves: MI-001 and MI-002 — the corrected forms pass.
-- Trimmed only by DELETING whole lines outside the ranges; nothing inside is altered.

DO $$
DECLARE v_barrier TEXT; v_missing TEXT; v_wrong TEXT; v_barrier_absent BOOLEAN; v_bad TEXT;
BEGIN
  SELECT regexp_replace(pg_get_constraintdef(k.oid), '[[:space:]]+', ' ', 'g')
         || CASE WHEN k.convalidated THEN '' ELSE ' [NOT VALID]' END
    INTO v_barrier
    FROM pg_constraint k
   WHERE k.conname = 'ActivityDependency_install_incomplete_check'
     AND k.conrelid = 'public."ActivityDependency"'::regclass;

  IF v_barrier IS NULL THEN
    -- ABSENT. Either the install FINISHED (section 9 dropped it, and nothing else is missing), or
    -- somebody dropped it off an install that never finished. The second is decided in 1h, where
    -- the rest of the record is readable; it is recorded here.
    v_barrier_absent := TRUE;
  ELSIF v_barrier <> 'CHECK ((id !~ ''^''::text))' THEN
    v_wrong := COALESCE(v_wrong, format('"ActivityDependency" carries a constraint named "ActivityDependency_install_incomplete_check" that this migration did not write: %s. Expected: %s. That name is this file''s proof that an unfinished install cannot be written AT ALL, and the proof is the definition, not the name — a hollow barrier of the right name says "unwritable" while admitting every INSERT, so a concurrent writer can place a row between this block''s commit and the seals installed after it, and that row would then be certified by silence. This is not this migration''s partial apply and will not be adopted.',
      v_barrier, 'CHECK ((id !~ ''^''::text))'));
  ELSE
    v_missing := COALESCE(v_missing || ', ', '') || 'the install barrier is still in place';
  END IF;


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
          ) AS k(name, side, fn, tgtype)
          JOIN pg_constraint c ON c.conname = k.name AND c.contype = 'f'
    ) AS e WHERE e.found <> $q$exactly that$q$
  ) AS x;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION $q$schedule B1: %$q$, v_bad; END IF;
END $$;
