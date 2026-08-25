-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: MI-002 binds to the GUARD, not to the file (Codex finding F3 against head c6e9ff17).
--
-- TWO guards verify foreign keys through pg_constraint with contype = 'f'. The FIRST also joins
-- pg_trigger on tgconstraint and refuses a key whose tgenabled says it does not act. The SECOND
-- reads convalidated and stops there — every column it reads survives
-- `ALTER TABLE ... DISABLE TRIGGER ALL` unchanged.
--
-- At head c6e9ff17 this file was CLEAN. The rule took the FIRST contype='f' site in the file and
-- then asked whether the FILE mentioned tgconstraint and tgenabled anywhere; the first guard
-- supplied both, and discharged the second. One correct guard shielded a defective neighbour.

DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT k.conname INTO v_bad
    FROM pg_constraint k
    JOIN pg_trigger g ON g.tgconstraint = k.oid AND g.tgisinternal
   WHERE k.conname = 'Decoy_guarded_fkey' AND k.contype = 'f'
     AND g.tgenabled IN ('D', 'R');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'decoy: foreign key % is present but not enforcing', v_bad;
  END IF;
END $$;

DO $$
DECLARE v_ok BOOLEAN;
BEGIN
  SELECT (k.convalidated AND k.confrelid = to_regclass('public."Other"')) INTO v_ok
    FROM pg_constraint k
   WHERE k.conname = 'Decoy_unguarded_fkey' AND k.contype = 'f'
     AND k.conrelid = 'public."Decoy"'::regclass;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'decoy: foreign key "Decoy_unguarded_fkey" is missing or points elsewhere';
  END IF;
END $$;
