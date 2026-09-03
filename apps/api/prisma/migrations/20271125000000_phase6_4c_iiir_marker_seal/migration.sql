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

-- ONE TRANSACTION, EXPLICITLY (Codex round 11, P2). Prisma DOCUMENTS that it does not wrap a
-- migration in a transaction, so without this the three DROP/CREATE pairs below commit one at a
-- time. A process that dies between a `DROP TRIGGER` and its `CREATE TRIGGER` would then leave the
-- marker present with its gate GONE — and the next deploy re-runs this file, whose adoption test
-- now correctly refuses exactly that state, so the deployment would be stuck behind a manual
-- `seals repair` rather than simply retrying. Wrapping it makes a partial apply unrepresentable:
-- the retry either finds the seals as they were, or finds them whole.
--
-- This is this repository's own convention rather than a new idea — `20271120000000` records the
-- same reasoning ("a seal whose indivisibility depends on undocumented behaviour loses it silently
-- at the next upgrade, with no test failing") and two other migrations already do it. Measuring
-- that the current Prisma happens to roll back is the wrong KIND of evidence; the file states the
-- boundary it needs instead of inferring it.
--
-- The diagnostic stays FIRST inside that transaction, and still runs before any DDL: it reads the
-- seals AS FOUND, and installing canonical ones first would destroy the very evidence it weighs.
BEGIN;

-- ── 0. DIAGNOSTIC-FIRST: a marker is evidence only if the seal was ENFORCING when it was written ──
-- The gates BELOW gate future writes. A marker row already present when this migration runs was
-- gated by whatever was installed at the time — which, on the first install, is nothing at all: such
-- a row can only have arrived by a partial restore, or from a writer planting it before this
-- deployment, because the only legitimate writer of a marker is the repair step that ships with this
-- migration and that step sets `vitan.phase6_4c_iiir_repair` inside its own transaction. Sealing it
-- would make an unverified row permanent authorization to skip the repair — the exact outcome the
-- whole file exists to prevent (Codex on c57b167).
--
-- On a RE-RUN there may be a genuine marker and a working seal, and this must not abort on those —
-- so the question below is not "does a marker predate this file" but "can the marker be shown to
-- have been written under a seal that was actually enforcing". Either way it FAILS CLOSED.
--
-- IT RUNS FIRST, BEFORE ANY DDL BELOW (Codex on e8b6d8c). Placed after the trigger installs, a
-- database carrying such a row would have the seals applied and THEN abort, leaving every retry to
-- reinstall the seals and hit the same exception. Asking the question before anything is installed
-- makes the failure leave the database exactly as it was, whether or not the runner wraps the file
-- in a transaction — which matters because the answer below is read from the seals AS FOUND, and
-- installing canonical ones first would destroy the very evidence being weighed.
DO $$
DECLARE
  v_count BIGINT;
  v_sample TEXT;
  v_unenforced TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg("id" || ' @ ' || "at", ', ' ORDER BY "at"), '')
    INTO v_count, v_sample
    FROM (SELECT "id", "at" FROM "OutboxOperatorAction"
           WHERE "action" = 'projection.rebuild.phase6-4c-iii-r' LIMIT 5) AS s;
  IF v_count = 0 THEN
    RETURN;                                  -- nothing to adopt, and nothing to refuse.
  END IF;

  -- A MARKER MAY BE ADOPTED ON RE-RUN ONLY IF THE SEAL WAS DEMONSTRABLY ENFORCING (Codex round 10,
  -- finding 2). If a restore or a ledger repair loses this migration's `_prisma_migrations` row
  -- while the triggers and a genuine marker survive, `migrate deploy` re-runs this file; without
  -- SOME adoption test it would abort forever, and the DELETE the message below suggests would
  -- itself be refused by the very seal still installed.
  --
  -- But an earlier draft asked only whether a trigger of the right NAME existed, and a name is not
  -- enforcement. A trigger that is disabled, points at another function, carries the wrong event
  -- mask, has been hollowed by `CREATE OR REPLACE FUNCTION` (which keeps every identity property
  -- while replacing what the function DOES), or is owned by a role the table's owner does not
  -- control, is a gap — and so is a present, perfect row seal STANDING ALONE, because the row seal
  -- fires BEFORE UPDATE OR DELETE and never sees an INSERT. Through any of those gaps the marker
  -- now sitting in this table could have been inserted, promoted or rewritten by anyone holding the
  -- application's own database role, and this file would then replace the triggers with canonical
  -- versions and bless it permanently.
  --
  -- A `WHEN` predicate is part of that inventory and is the least visible member of it (Codex
  -- round 11, P1): it lives in `tgqual`, not in `tgtype`, the function, the body, the owner or the
  -- enablement, so `BEFORE INSERT … WHEN (false)` matches every other check while the trigger never
  -- fires once. Measured on this schema, a forged marker was accepted through exactly that gate
  -- while the runtime verifier reported `sealed: true`. The canonical triggers carry no predicate,
  -- so the expected value is exact rather than a comparison: any predicate is a deviation.
  --
  -- So the test below is the WHOLE inventory the runtime verifier asks — present, enabled, right
  -- function, exact tgtype, NO WHEN predicate, canonical body, owner matching the table's — over the two seals that
  -- can be a forgery's route in. `phase6_4c_iiir_no_truncate` is deliberately excluded: it can only
  -- DESTROY markers, never manufacture one, so a marker that outlived a missing truncate guard is
  -- exactly as trustworthy as one that never met it, and refusing here would demand operator work
  -- for a risk that ran the other way. That is the same rule, and the same two seals, as
  -- `MARKER_FORGERY_SEALS` in `src/platform/projections/inbox-repair-seals.ts` — stated once,
  -- applied in both places, so the migration's refusal and the repair's invalidation can never
  -- disagree about which markers are trustworthy.
  --
  -- The expected bodies are pinned as MD5 digests of the dollar-quoted function literals INSTALLED
  -- BY THIS FILE, below. (Their delimiter is not written out here: this block is itself dollar
  -- quoted, and PostgreSQL ends that quoting at the next delimiter it sees — inside a comment or
  -- not.) They are not hand-maintained either: `phase6-4c-iiir-inbox-repair.test.ts` recomputes them
  -- from the same literals `extractCanonicalMarkerBodies` reads and fails if this block drifts from
  -- them, so a copy here cannot quietly stop matching what is actually deployed.
  SELECT COALESCE(string_agg(x.detail, '; ' ORDER BY x.fn), '') INTO v_unenforced
    FROM (
      SELECT e.fn,
             CASE
               WHEN t.tgname IS NULL
                 THEN e.fn || ': trigger "' || e.trg || '" is absent'
               WHEN t.tgenabled <> 'O'
                 THEN e.fn || ': tgenabled=' || quote_literal(t.tgenabled::text)
                        || ', so it does not fire for ordinary writes'
               WHEN p.proname <> e.fn
                 THEN e.fn || ': the trigger executes ' || p.proname || ' instead'
               WHEN t.tgtype::int <> e.tgtype
                 THEN e.fn || ': tgtype=' || t.tgtype::int || ' is not ' || e.tgtype
                        || ' - the timing or the events it fires on have changed'
               WHEN t.tgqual IS NOT NULL
                 THEN e.fn || ': the trigger carries a WHEN predicate, which this migration never'
                        || ' installs - a predicate excluding the marker leaves every other property'
                        || ' identical while the trigger never fires'
               WHEN md5(p.prosrc) <> e.body_md5
                 THEN e.fn || ': the function body is not the one this migration installs'
               WHEN pg_get_userbyid(p.proowner) <> pg_get_userbyid(c.relowner)
                 THEN e.fn || ': owned by "' || pg_get_userbyid(p.proowner)
                        || '" while the table is owned by "' || pg_get_userbyid(c.relowner) || '"'
             END AS detail
        FROM (VALUES
                ('phase6_4c_iiir_marker_insert_gated',
                 'OutboxOperatorAction_4c_iiir_marker_insert_gated',
                 7, '4974989ec3c3a1d4265c5b33c1adc479'),
                ('phase6_4c_iiir_marker_sealed',
                 'OutboxOperatorAction_4c_iiir_marker_sealed',
                 27, '975b532176655b65e919efdc1c4bcfa8')
             ) AS e(fn, trg, tgtype, body_md5)
        LEFT JOIN pg_class c
               ON c.relname = 'OutboxOperatorAction'
              AND c.relnamespace = 'public'::regnamespace
        LEFT JOIN pg_trigger t
               ON t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgname = e.trg
        LEFT JOIN pg_proc p ON p.oid = t.tgfoid
    ) AS x
   WHERE x.detail IS NOT NULL;

  IF v_unenforced <> '' THEN
    RAISE EXCEPTION
      'phase6-4c-iii-r: this database carries % repair marker row(s) (%) that CANNOT be shown to '
      'have been written under an enforcing seal: %. A marker is authorization to skip the repair, '
      'so adopting one that could have been inserted, promoted or rewritten through that gap would '
      'make an unverified row permanent evidence. Establish where the row(s) came from. To clear '
      'them, run `node dist/platform/projections/inbox-repair.cli.js seals repair`, which reinstalls '
      'the seals and - because a forgery-relevant seal is failing - invalidates the marker(s) in the '
      'same transaction; then redeploy and let the repair earn a new marker. See docs/RUNBOOK.md '
      'section P64CIIIR.',
      v_count, v_sample, v_unenforced;
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

COMMIT;
