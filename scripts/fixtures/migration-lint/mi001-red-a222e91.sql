-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #411 head a222e91
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  739-750 (barrier lookup in section 1g)
-- Proves: MI-001 — a definition fetched and only NULL-tested
--
-- Trimmed only by DELETING whole lines outside the range; nothing inside is altered.

DO $$
DECLARE
  v_barrier  TEXT;
  v_missing  TEXT;
BEGIN
  SELECT pg_get_constraintdef(k.oid) INTO v_barrier
    FROM pg_constraint k
   WHERE k.conname = 'ActivityDependency_install_incomplete_check'
     AND k.conrelid = 'public."ActivityDependency"'::regclass;
  IF v_barrier IS NOT NULL THEN
    v_missing := COALESCE(v_missing || ', ', '') || 'the install barrier is still in place';
  END IF;
END $$;
