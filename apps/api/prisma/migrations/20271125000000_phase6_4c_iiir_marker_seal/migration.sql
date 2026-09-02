-- Phase 6 unit 4c-iii-r — SEAL THE REPAIR MARKER.
--
-- WHY. The deploy-time `decisions.inbox` repair records its success as one `OutboxOperatorAction`
-- row with `action = 'projection.rebuild.phase6-4c-iii-r'`, and every later start SKIPS the repair
-- when that row is present. The row is therefore not audit trail — it is AUTHORIZATION, and
-- `OutboxOperatorAction` carried no seal of any kind: no append-only trigger, no truncate guard.
-- Three writes defeated the step (Codex F2 on 44b2ad8), and this file makes each unrepresentable:
--
--   0. FORGED CREATION — a direct `INSERT` of a row carrying the marker action. An alternate writer
--      using the application's own database role needs nothing else: the next start's marker read
--      accepts it and SKIPS the repair on an unrepaired database. Sealing only post-insert
--      mutation leaves the cheapest forgery of all wide open (Codex round 2, P1), so the seal
--      starts here — creation is gated to the repair path itself, below.
--   1. PROMOTION — `UPDATE "OutboxOperatorAction" SET action = 'projection.rebuild.phase6-4c-iii-r'`
--      over ANY existing audit row manufactures a marker the step trusts, so the next deploy skips
--      an UNREPAIRED database. This needs no delete permission and leaves a row that looks exactly
--      like the real thing.
--   2. MUTATION — editing a genuine marker's own columns rewrites the evidence of what was repaired
--      and when.
--   3. DESTRUCTION — DELETE (or TRUNCATE, which no row trigger sees) removes the exactly-once
--      evidence. That direction is the safe-ish failure — the next deploy repairs again, which is
--      idempotent — but it erases the record that the repair ever ran, and this unit's whole claim
--      is that the record is trustworthy.
--
-- SCOPE, deliberately narrow. Only the marker action is sealed. `OutboxOperatorAction` is the
-- general operator audit table and other rows keep whatever lifecycle they have; a blanket
-- append-only seal here would be a much larger behavioural change than this unit's one concern, and
-- is not what the finding asks for. The guards below name the marker action explicitly and are
-- inert for every other row — proven both ways in `phase6-4c-iiir-inbox-repair.test.ts`.
--
-- ADDITIVE AND ROW-SAFE. It creates three functions and three triggers and touches no data. A
-- database that has already run the repair keeps its marker and simply becomes unable to lose or
-- forge one.

-- ── 0. DIAGNOSTIC-FIRST: a marker that predates this seal is not evidence of anything ──────────
-- The gates BELOW gate future writes. A marker row already present when this migration runs was
-- never gated by anything: it can only have arrived by a partial restore, or by a writer planting
-- it before this deployment. Sealing it would make an unverified row permanent authorization to
-- skip the repair — the exact outcome the whole file exists to prevent (Codex on c57b167).
--
-- No legitimate marker can predate this migration, because the only writer of one is the repair
-- step that ships with it and that step sets `vitan.phase6_4c_iiir_repair` inside its own
-- transaction. So this is unambiguous, and it FAILS CLOSED rather than sealing and trusting it.
--
-- IT RUNS FIRST, BEFORE ANY DDL BELOW (Codex on e8b6d8c). Placed after the trigger installs, a
-- database carrying such a row would have the seals applied and THEN abort — and the cleanup this
-- message documents (an ordinary DELETE) would itself be refused by the seal that had just been
-- installed, leaving every retry to reinstall the seals and hit the same exception. Asking the
-- question before anything is installed makes the failure leave the database exactly as it was
-- and the documented cleanup actually work, whether or not the runner wraps the file in a
-- transaction.
DO $$
DECLARE
  v_count BIGINT;
  v_sealed BIGINT;
  v_sample TEXT;
BEGIN
  -- AND ONLY WHEN THE SEAL IS NOT ALREADY THERE (Codex on 8eea3ca). A marker that exists ALONGSIDE
  -- an installed row seal was necessarily written under it — by the repair step, inside the
  -- transaction that set the flag — so it is genuine and this file has nothing to object to. If
  -- a restore or a ledger repair loses this migration's `_prisma_migrations` row while the triggers
  -- and that marker survive, `migrate deploy` re-runs this file; without this test it would abort
  -- forever, and the DELETE the message below suggests would itself be refused by the very seal
  -- still installed. Asking about the seal makes the completed migration safely re-runnable, which
  -- is what restore and partial-apply recovery need, while still refusing the pre-seal marker this
  -- check exists for.
  SELECT count(*) INTO v_sealed
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'OutboxOperatorAction' AND NOT t.tgisinternal
     AND t.tgname = 'OutboxOperatorAction_4c_iiir_marker_sealed';

  SELECT count(*), COALESCE(string_agg("id" || ' @ ' || "at", ', ' ORDER BY "at"), '')
    INTO v_count, v_sample
    FROM (SELECT "id", "at" FROM "OutboxOperatorAction"
           WHERE "action" = 'projection.rebuild.phase6-4c-iii-r' LIMIT 5) AS s;
  IF v_count > 0 AND v_sealed = 0 THEN
    RAISE EXCEPTION
      'phase6-4c-iii-r: this database already carries % repair marker row(s) BEFORE the seal that '
      'makes a marker mean anything was installed (%). No legitimate marker can predate this '
      'migration — the only writer of one is the repair step that ships with it. Sealing these '
      'would make unverified rows permanent authorization to skip the repair. Establish where they '
      'came from, delete them (the seal is not yet installed, so an ordinary DELETE still works), '
      'and redeploy. See docs/RUNBOOK.md section P64CIIIR.',
      v_count, v_sample;
  END IF;
END $$;

-- ── 1. the creation gate: only the repair path may WRITE a marker ─────────────────────────────
-- The marker is authorization, so the question is not "may this row change" but "who is allowed to
-- make one at all". PostgreSQL cannot see which application code issued a statement, but it can see
-- a transaction-local setting, and `SET LOCAL` is unforgeable by accident: it lives only inside the
-- transaction that set it and disappears at COMMIT.
--
-- `runInboxRepairStep` writes its marker inside one transaction that first sets
-- `vitan.phase6_4c_iiir_repair = 'on'`, and it does that ONLY after a verified report. Every other
-- writer — an operator at psql, a maintenance script, an alternate service using the same database
-- role — inserts without the flag and is refused here, by name.
--
-- This is a DELIBERATE, NAMED gate rather than a claim of unforgeability: a writer that sets the
-- flag on purpose can still write a marker. That is the same trust boundary the sanctioned reset
-- already lives on (it disables named seals to do its work), and it is the honest limit — the seal
-- makes forgery an explicit, auditable act instead of an ordinary INSERT.

CREATE OR REPLACE FUNCTION phase6_4c_iiir_marker_insert_gated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."action" = 'projection.rebuild.phase6-4c-iii-r'
     AND COALESCE(current_setting('vitan.phase6_4c_iiir_repair', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'The 4c-iii-r repair marker is written only by the repair step, inside the transaction that verified the rebuild; it cannot be inserted directly (%)',
      NEW."id";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction";
CREATE TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated"
  BEFORE INSERT ON "OutboxOperatorAction"
  FOR EACH ROW EXECUTE FUNCTION phase6_4c_iiir_marker_insert_gated();

-- ── 2. the row seal: a marker cannot be mutated, deleted, or manufactured ──────────────────────
CREATE OR REPLACE FUNCTION phase6_4c_iiir_marker_sealed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- vector 3 — SCOPED to the marker. `OutboxOperatorAction` is the general operator audit table
  -- and its other rows keep the lifecycle they had; a blanket no-delete seal here would be a much
  -- larger behavioural change than this unit's one concern, and would break every sanctioned reset.
  IF TG_OP = 'DELETE' THEN
    IF OLD."action" = 'projection.rebuild.phase6-4c-iii-r' THEN
      RAISE EXCEPTION
        'The 4c-iii-r repair marker is immutable evidence that the decisions.inbox repair succeeded on this database; it is never deleted (%)',
        OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  -- vector 2 — an existing marker may not be edited at all, in any column.
  IF OLD."action" = 'projection.rebuild.phase6-4c-iii-r' THEN
    RAISE EXCEPTION
      'The 4c-iii-r repair marker is immutable; re-run the repair rather than editing its record (%)',
      OLD."id";
  END IF;

  -- vector 1 — and no other audit row may BECOME one. Without this arm the seal above protects
  -- only rows that are already markers, which is precisely the wrong half: forging a marker skips
  -- the repair on a database that still carries the defect.
  IF NEW."action" = 'projection.rebuild.phase6-4c-iii-r' THEN
    RAISE EXCEPTION
      'An operator action cannot be re-keyed into the 4c-iii-r repair marker — the marker is written only by the repair step, after a verified report (%)',
      OLD."id";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxOperatorAction_4c_iiir_marker_sealed" ON "OutboxOperatorAction";
CREATE TRIGGER "OutboxOperatorAction_4c_iiir_marker_sealed"
  BEFORE UPDATE OR DELETE ON "OutboxOperatorAction"
  FOR EACH ROW EXECUTE FUNCTION phase6_4c_iiir_marker_sealed();

-- ── 3. the statement seal: TRUNCATE fires no row trigger ──────────────────────────────────────
-- Without this, `TRUNCATE "OutboxOperatorAction"` walks past every guard above and takes the marker
-- with the rest of the table. The guard is unconditional because TRUNCATE cannot be scoped to rows:
-- there is no per-row test to make, so the whole table becomes untruncatable once a seal on any of
-- its rows has to mean something.
CREATE OR REPLACE FUNCTION phase6_4c_iiir_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'OutboxOperatorAction is never truncated — it carries the 4c-iii-r repair marker, and a row trigger never fires for TRUNCATE';
END $$;

DROP TRIGGER IF EXISTS "OutboxOperatorAction_4c_iiir_no_truncate" ON "OutboxOperatorAction";
CREATE TRIGGER "OutboxOperatorAction_4c_iiir_no_truncate"
  BEFORE TRUNCATE ON "OutboxOperatorAction"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_4c_iiir_no_truncate();
