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
--   RESOLUTION C  joins the key's own internal triggers correctly and then merely SELECTS
--                 `tgenabled` without rejecting anything. The column is read; nothing turns on it.
--                 MI-001 MUST fire.
--   RESOLUTION D  names `pg_trigger`, links it correctly, and then takes `tgenabled` from a derived
--                 table of its own making. The column NAME is present and says nothing about any
--                 trigger. MI-001 MUST fire.
--
-- C and D are the two frauds the first draft of this rule admitted, because it asked only whether
-- the column names `tgenabled` and `tgconstraint` appeared somewhere in the query.

DO $$
DECLARE v_bad TEXT; v_ok BOOLEAN; v_state "char";
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

  -- RESOLUTION C — the right triggers, read and not judged.
  SELECT g.tgenabled INTO v_state
    FROM pg_constraint k
    JOIN pg_trigger g ON g.tgconstraint = k.oid AND g.tgisinternal
   WHERE k.conname = 'Decoy_projected_fkey' AND k.contype = 'f'
     AND k.conrelid = 'public."Decoy"'::regclass;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'decoy: foreign key "Decoy_projected_fkey" has no internal triggers at all';
  END IF;

  -- RESOLUTION D — the right names, from the wrong place.
  SELECT k.conname INTO v_bad
    FROM pg_constraint k
    JOIN pg_trigger g ON g.tgconstraint = k.oid AND g.tgisinternal
    CROSS JOIN (SELECT 'O'::TEXT AS tgenabled) AS fake
   WHERE k.conname = 'Decoy_pretend_fkey' AND k.contype = 'f'
     AND k.conrelid = 'public."Decoy"'::regclass
     AND fake.tgenabled NOT IN ('D', 'R');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'decoy: foreign key % is present but is not enforcing', v_bad;
  END IF;
END $$;
