-- Phase 6 task 4d unit 4d-ii-a / A8a — THE FROZEN APPROVAL TUPLE ON `awaiting_countersign` (the plan's
-- §A.2 "Forwarding", change (2) of `decision_t4b_attribution_seal`: "a PROVISIONAL approval writes the
-- tuple exactly as the finalizing act would, so `→ awaiting_countersign` joins `→ approved`"; §A.2
-- "Countersign, and the state that carries it": the chain reapproval `change → awaiting_countersign`).
--
-- WHAT THIS FILE DOES. 4d-i widened the attribution SEAL's two approval clauses for the provisional
-- transition — the tuple's first write on `pending`/`change → awaiting_countersign`, and the standing
-- arm's `change → awaiting_countersign` — but not the CHECK constraint 4b installed beside them:
-- `Decision_t4b_approved_tuple_check` admits a non-NULL tuple only while `status IN ('approved',
-- 'change')`. Under the delivered database the provisional act therefore could not write the tuple
-- (the CHECK refuses the row), and — worse — a decision whose tuple was frozen by an EARLIER approval
-- could never be re-approved under a chain at all: `change → awaiting_countersign` moves a tuple-
-- bearing row into a status the CHECK does not admit, whatever the writer does. A8a is the first
-- writer to meet this (its live suite, the chain reapproval arm, RED at the delivered CHECK), and it
-- re-issues the constraint with `awaiting_countersign` admitted, byte-for-byte the 4b predicate
-- otherwise: the tuple stays coherent (kind, label non-blank, the member pair), and it may exist only
-- on a decision that carries an approval act — final, reopened, or awaiting its countersign.
--
-- Nothing else moves. The SEAL already judges the transition (the tuple's first write only by an
-- approval transition, the tuple equal to the holder, frozen once written); the entry seal and the
-- awaiting pairing judge the provisional head; this file lets the row the seals admit exist.
--
-- Re-runnable: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, one transaction, verified at the end.
-- `ALWAYS_EXECUTE` (the staging document, "Every migration an A-unit ships"): the CHECK is not in
-- `schema.prisma`, so a db-push baseline would otherwise leave the 4b shape in place and refuse the
-- first chain reapproval in production.

BEGIN;

-- ── THE PREREQUISITES ARE 4b's AND 4d-i's, VERIFIED, NOT ASSUMED ─────────────────────────────
DO $t4dii_a8a_prereq$
DECLARE v_src TEXT;
BEGIN
  IF to_regproc('decision_t4b_attribution_seal') IS NULL OR to_regproc('phase6_t4d_approved_entry_seal') IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8a ABORT: this unit widens a CHECK beside the attribution seal 4b installed and the entry seal 4d-i installed, and this database holds neither `decision_t4b_attribution_seal()` nor `phase6_t4d_approved_entry_seal()` in full. Those files apply before this one in the ledger; on the P3005 baseline path they are on ALWAYS_EXECUTE (4d-i) or resolved from a database that ran them (4b).';
  END IF;
  -- the seal's widened arm is the reason this CHECK widens: a database whose seal still refuses the
  -- provisional tuple would admit through the CHECK what the seal refuses — harmless, but a sign the
  -- ledger is not the one this file was written against
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.proname = 'decision_t4b_attribution_seal';
  IF position('awaiting_countersign' in v_src) = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-ii-a A8a ABORT: `decision_t4b_attribution_seal()` carries no `awaiting_countersign` arm — 4d-i''s decision-facts migration (20271221000000) re-issues it with the provisional transition admitted, and this file widens the CHECK beside that arm, never ahead of it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Decision"'::regclass AND conname = 'Decision_t4b_approved_tuple_check') THEN
    RAISE NOTICE 'phase6 4d-ii-a A8a: `Decision_t4b_approved_tuple_check` is absent (a db-push baseline never carried it) — installed below in its widened form';
  END IF;
END $t4dii_a8a_prereq$;

-- ── THE CHECK, RE-ISSUED WITH THE PROVISIONAL STATE ADMITTED ─────────────────────────────────
ALTER TABLE "Decision" DROP CONSTRAINT IF EXISTS "Decision_t4b_approved_tuple_check";
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_approved_tuple_check" CHECK (
  (
    "approvedDeciderKind" IS NULL
    AND "approvedDeciderMembershipId" IS NULL
    AND "approvedDeciderLabel" IS NULL
  ) OR (
    "approvedDeciderKind" IS NOT NULL
    AND "approvedDeciderLabel" IS NOT NULL
    AND btrim("approvedDeciderLabel", E' \t\n\x0B\f\r') <> ''
    AND (("approvedDeciderKind"::text = 'member') = ("approvedDeciderMembershipId" IS NOT NULL))
    -- 4d-ii-a / A8a: the provisional approval carries the tuple the finalizer confirms
    AND "status"::text IN ('approved', 'change', 'awaiting_countersign')
  )
);

-- ── VERIFICATION: THIS FILE FAILS CLOSED ON ITS OWN INSTALLATION ─────────────────────────────
DO $t4dii_a8a_verify$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = '"Decision"'::regclass AND c.conname = 'Decision_t4b_approved_tuple_check' AND c.contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8a ABORT: `Decision_t4b_approved_tuple_check` is not installed after this file ran';
  END IF;
  IF position('awaiting_countersign' in v_def) = 0
     OR position('approved' in v_def) = 0 OR position('change' in v_def) = 0
     OR position('approvedDeciderMembershipId' in v_def) = 0 OR position('btrim' in v_def) = 0 THEN
    RAISE EXCEPTION 'phase6 4d-ii-a A8a ABORT: `Decision_t4b_approved_tuple_check` does not carry the widened predicate this file installs (got: %)', v_def;
  END IF;
  RAISE NOTICE 'phase6 4d-ii-a A8a: `Decision_t4b_approved_tuple_check` admits the frozen tuple on approved, change and awaiting_countersign';
END $t4dii_a8a_verify$;

COMMIT;
