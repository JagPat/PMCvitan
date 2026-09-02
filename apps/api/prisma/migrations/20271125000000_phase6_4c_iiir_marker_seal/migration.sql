-- Phase 6 unit 4c-iii-r — SEAL THE REPAIR MARKER.
--
-- WHY. The deploy-time `decisions.inbox` repair records its success as one `OutboxOperatorAction`
-- row with `action = 'projection.rebuild.phase6-4c-iii-r'`, and every later start SKIPS the repair
-- when that row is present. The row is therefore not audit trail — it is AUTHORIZATION, and
-- `OutboxOperatorAction` carried no seal of any kind: no append-only trigger, no truncate guard.
-- Three writes defeated the step (Codex F2 on 44b2ad8), and this file makes each unrepresentable:
--
--   1. PROMOTION — `UPDATE "OutboxOperatorAction" SET action = 'projection.rebuild.phase6-4c-iii-r'`
--      over ANY existing audit row manufactures a marker the step trusts, so the next deploy skips
--      an UNREPAIRED database. This is the dangerous one: it needs no delete permission and leaves
--      a row that looks exactly like the real thing.
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
-- ADDITIVE AND ROW-SAFE. It creates two functions and two triggers and touches no data. A database
-- that has already run the repair keeps its marker and simply becomes unable to lose or forge one.

-- ── 1. the row seal: a marker cannot be mutated, deleted, or manufactured ──────────────────────
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

-- ── 2. the statement seal: TRUNCATE fires no row trigger ──────────────────────────────────────
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
