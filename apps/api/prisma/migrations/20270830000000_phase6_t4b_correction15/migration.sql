-- Phase 6 unit 4b-i — ROUND 15 CORRECTION (Codex, head ac99e6b).
--
-- ONE of the four findings lands in SQL. Every earlier migration — `20270815000000` through
-- `20270829000000` — is byte-for-byte unchanged, and no seal function is redefined here.
--
--   F4 (P2)  `decision_t4b_recorded_seal`'s `DELETE` arm calls a published recorded issue a
--            permanent register entry and refuses to delete one. A row-level trigger never fires
--            for `TRUNCATE`, so a role holding the separately grantable TRUNCATE privilege could
--            drop the entire register in one statement. The child evidence tables carry
--            statement-level guards already (`DecisionEvent_t4a_no_truncate`, and round 11's
--            legacy-approval guard), but both are CONDITIONAL — on a database whose records were
--            never approved there is no evidence to protect, they permit the cascade, and the
--            parent table itself had nothing to say.
--
-- The other three are answered in code (F1) or refuted (F2, F3); see the PR body and
-- `docs/reviews/pr-344-convergence.md`.

-- ── F4: the permanence rule, stated for the verb that erases a whole table ────────────────────
-- CONDITIONAL, exactly like the two guards it sits beside, and for the same reason: a disposable
-- database with nothing permanent in it has nothing to defend, and a reset that would destroy no
-- register entry must not be blocked by a seal protecting rows that do not exist. Suites that DO
-- hold such rows disable this trigger by name for exactly their wipe — the same sanctioned-bypass
-- contract `wipeDecisions` and the `event-catalog` reset already use.
--
-- It covers WITHDRAWN decisions as well as published records. `Decision_t4a_d_no_delete` and this
-- unit's `DELETE` arm make the identical promise about the identical table, and a guard that
-- protected one from truncation and not the other would be arbitrary — the finding names the
-- records because that is the arm it was reading.
CREATE OR REPLACE FUNCTION decision_t4b_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_records INT;
  v_withdrawn INT;
BEGIN
  SELECT COUNT(*) INTO v_records
    FROM "Decision" WHERE "status"::text = 'recorded' AND "publishedAt" IS NOT NULL;
  SELECT COUNT(*) INTO v_withdrawn
    FROM "Decision" WHERE "status"::text = 'withdrawn';
  IF v_records > 0 OR v_withdrawn > 0 THEN
    RAISE EXCEPTION 'phase6-4b: TRUNCATE would erase % published recorded issue(s) and % withdrawn decision(s) — a permanent register entry is permanent against every verb, not only DELETE.', v_records, v_withdrawn;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_no_truncate" ON "Decision";
CREATE TRIGGER "Decision_t4b_no_truncate"
  BEFORE TRUNCATE ON "Decision"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_no_truncate();
