-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: dollar-tag recognition skips BLOCK comments, so prose cannot fabricate a dollar block.
--
-- Codex finding F6 against PR #423 head c6e9ff17: `dollarBlocks` skipped line comments and string
-- literals before recognising a `$tag$`, but not block comments or quoted identifiers. The two
-- block comments below carry matching `$tag$`, so the walk opened a block at the first and closed
-- it at the second — swallowing the three real statements between them. `statements()` then found
-- no top-level semicolon inside that fabricated block, merged all three under the leading SELECT,
-- and MI-004 never saw the `SET LOCAL` as a statement at all. The fabricated block's body contains
-- an UPDATE, so it classified as a data-backfill and MI-000 was clean too. Prose hid executable SQL.

/* Section 3 note: the install writes its body as $tag$ … so that the quoting survives EXECUTE. */
SELECT 1;
SET LOCAL search_path = public;
UPDATE public."Decoy" SET a = 1 WHERE a IS NULL;
/* End of section 3. The closing delimiter is $tag$ and it is prose here too. */
