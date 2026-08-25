-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: dollar-tag recognition skips BLOCK comments, so prose cannot fabricate a dollar block.
--
-- Codex finding F6 against PR #423 head c6e9ff17: `dollarBlocks` skipped line comments and string
-- literals before recognising a `$tag$`, but not block comments. The two block comments below
-- carry matching `$tag$`. The walk opened a block at the first and closed it at the second, so the
-- real `DO $$` opener fell INSIDE that fabrication and the guard was never a depth-0 block at all.
--
-- The closing comment is placed mid-guard on purpose, and that placement is the whole probe. The
-- fabricated body ends BEFORE the `RAISE EXCEPTION`, so what the old scanner handed the rules was a
-- catalog-touching block that does not REFUSE — and MI-001 only judges guards that refuse. The
-- fabrication was therefore silent in BOTH directions: it hid the real guard, and what it put in
-- its place was exempt. A probe whose fabricated block still looked like a refusing guard would
-- have fired before the fix as well, for the wrong reason, and would have proved nothing.

/* Section 3 note: the install writes its body as $tag$ … so that the quoting survives EXECUTE. */
DO $$
DECLARE v_present BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conname = 'Decoy_hidden_check'
                    AND k.conrelid = 'public."Decoy"'::regclass) INTO v_present;
/* End of section 3. The closing delimiter is $tag$ and it is prose here too. */
  IF NOT v_present THEN
    RAISE EXCEPTION 'decoy: the barrier this file installed is missing';
  END IF;
END $$;
