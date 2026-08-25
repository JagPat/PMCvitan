-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: the scanner honours backslash escapes inside an `E'…'` escape-string literal.
--
-- Codex finding F7 against PR #423 head c6e9ff17: the literal loop treated `\'` as the END of the
-- literal. The real closing quote then opened a SECOND literal that ran on to the next quote in the
-- file — here the one opening 'Decoy_hidden_check' — masking the whole `DO $$` opener in between.
-- The catalog guard below was therefore never recognised as a block at all, and MI-001, which
-- judges guards, had nothing to judge. One escaped quote blinded the rule for the rest of the file.

SELECT E'abc\'def';
DO $$
DECLARE v_present BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conname = 'Decoy_hidden_check'
                    AND k.conrelid = 'public."Decoy"'::regclass) INTO v_present;
  IF NOT v_present THEN
    RAISE EXCEPTION 'decoy: the barrier this file installed is missing';
  END IF;
END $$;
