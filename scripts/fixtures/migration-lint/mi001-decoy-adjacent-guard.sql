-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: MI-001 binds to the GUARD, not to the file (Codex finding F2 against head c6e9ff17).
--
-- TWO refusing catalog guards. The FIRST is correct: it fetches pg_get_constraintdef and COMPARES
-- what came back. The SECOND resolves a constraint by conname, refuses on what it finds, and never
-- reads a definition at all.
--
-- At head c6e9ff17 this file was CLEAN. Part (a) of the rule took one site per catalog with
-- .find() and then asked `pg_get_constraintdef` of `file.masked` — the whole file — which the
-- FIRST guard satisfied. So the second guard's verdict was accepted on evidence found in a block
-- that knows nothing about it. A fixture with only the second guard would have fired before the
-- fix as well, for the wrong reason, and would have proved nothing: only a SATISFIED NEIGHBOUR can
-- show that the rule stopped accepting one site's evidence for another's.

DO $$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(k.oid) INTO v_def
    FROM pg_constraint k
   WHERE k.conname = 'Decoy_guarded_check'
     AND k.conrelid = 'public."Decoy"'::regclass;
  IF v_def IS NULL OR v_def <> 'CHECK ((a > 0))' THEN
    RAISE EXCEPTION 'decoy: the guarded barrier is not the one this file wrote (%)', v_def;
  END IF;
END $$;

DO $$
DECLARE v_present BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conname = 'Decoy_unguarded_check'
                    AND k.conrelid = 'public."Decoy"'::regclass) INTO v_present;
  IF NOT v_present THEN
    RAISE EXCEPTION 'decoy: the unguarded barrier is missing';
  END IF;
END $$;
