-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: a guard written as dynamic SQL is read as the STATEMENT it produces, or reported as
--         unread. It is never handed to the rules as the string that produces it — parsing the
--         LITERAL and finding no pg_constraint in it would be a clean report about SQL nobody read.
--
--   BLOCK 1  the text is decidable from the file, so it is parsed for real. It is a presence-only
--            foreign-key check, and MI-001 MUST fire on it.
--   BLOCK 2  the text does not exist until the migration runs. Nothing can be asked of it, and it
--            is REPORTED as unread rather than counted as an ordinary site.

DO $$
DECLARE n INT;
BEGIN
  EXECUTE 'SELECT count(*) FROM pg_constraint k WHERE k.conname = ''Dyn_fkey'' AND k.contype = ''f'' AND k.convalidated' INTO n;
  IF n <> 1 THEN
    RAISE EXCEPTION 'dyn: prerequisite foreign key "Dyn_fkey" is not installed and validated';
  END IF;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['Alpha', 'Beta']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
  END LOOP;
END $$;
