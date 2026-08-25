-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #411 head a222e91 (the head #412 replaced)
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  636-658 (section 1e's foreign-key arm), two of the five VALUES rows kept
-- Proves: MI-002 — contype='f' verified without ever reading pg_trigger.tgenabled.
-- Trimmed only by DELETING whole lines outside the range; nothing inside is altered.

DO $$
DECLARE r RECORD; v_existing TEXT; v_wrong TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_projectId_fkey',              'public."Project"'),
      ('ActivityDependency_projectId_predecessorId_fkey','public."Activity"'),
    ) AS c(name, target)
  LOOP
    SELECT k.confrelid::REGCLASS::TEXT INTO v_existing
      FROM pg_constraint k
     WHERE k.conname = r.name AND k.contype = 'f'
       AND k.conrelid = 'public."ActivityDependency"'::regclass
       AND k.confrelid = to_regclass(r.target);
    CONTINUE WHEN v_existing IS NOT NULL;

    SELECT COALESCE(k.confrelid::REGCLASS::TEXT, 'no foreign key of that name') INTO v_existing
      FROM pg_constraint k
     WHERE k.conname = r.name AND k.conrelid = 'public."ActivityDependency"'::regclass;

    v_wrong := COALESCE(v_wrong, format('"ActivityDependency" exists but its foreign key "%s" does not reference %s — it references %s. A foreign key''s target is resolved through the search path of whoever created it, and a same-named table in a schema ahead of "public" renders identically to the real one, so this is asked against the OID rather than against any rendered name. This table has no containment and will not be adopted.',
      r.name, r.target, COALESCE(v_existing, 'nothing this file can identify')));
    EXIT;
  END LOOP;
  IF v_wrong IS NOT NULL THEN RAISE EXCEPTION 'schedule B1: %', v_wrong; END IF;
END $$;
