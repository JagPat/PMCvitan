-- CONSTRUCTED PROBE — not a historical extract.
--
-- THIS IS THE FINDING THAT SURVIVED BOTH REVIEW ROUNDS OF PR #423, and the reason that pull
-- request was closed rather than corrected again. The rule's evidence for "this place checks
-- enablement" was gathered first across the whole FILE and then, after a correction, across the
-- whole BLOCK. Both are the same mistake: EVIDENCE GATHERED AT A COARSER GRANULARITY THAN THE
-- THING BEING JUDGED. A file that verified key A correctly and key B presence-only passed, because
-- `tgenabled` appeared SOMEWHERE.
--
-- So both resolutions live in ONE `DO $$ … $$` block, on purpose. A fixture that put them in
-- separate blocks, or separate files, would not test the thing that failed twice — it would pass
-- against both of the defective implementations this probe exists to refuse.
--
--   RESOLUTION A  reaches the key's own internal triggers through `tgconstraint` and refuses a key
--                 whose `tgenabled` says it does not act.  MI-001 must NOT fire.
--   RESOLUTION B  reads `convalidated` and the `confrelid` OID and stops there. Every column it
--                 reads survives `ALTER TABLE ... DISABLE TRIGGER ALL` byte for byte.
--                 MI-001 MUST fire, on this query, with A standing right beside it.

DO $$
DECLARE v_bad TEXT; v_ok BOOLEAN;
BEGIN
  -- RESOLUTION A — enforcement asked and answered in the query that draws the conclusion.
  SELECT k.conname INTO v_bad
    FROM pg_constraint k
    JOIN pg_trigger g ON g.tgconstraint = k.oid AND g.tgisinternal
   WHERE k.conname = 'Decoy_guarded_fkey' AND k.contype = 'f'
     AND k.conrelid = 'public."Decoy"'::regclass
     AND g.tgenabled IN ('D', 'R');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'decoy: foreign key % is present but is not enforcing', v_bad;
  END IF;

  -- RESOLUTION B — the same shape as PR #411 head a222e91: present, valid, pointed at the right
  -- table, and switched off. The neighbour above must not answer for it.
  SELECT (k.convalidated AND k.confrelid = to_regclass('public."Other"')) INTO v_ok
    FROM pg_constraint k
   WHERE k.conname = 'Decoy_unguarded_fkey' AND k.contype = 'f'
     AND k.conrelid = 'public."Decoy"'::regclass;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'decoy: foreign key "Decoy_unguarded_fkey" is missing or points elsewhere';
  END IF;
END $$;
