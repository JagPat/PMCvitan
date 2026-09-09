-- Phase 6 task 4d, unit 4d-i — THE DARK MIGRATION
-- (docs/superpowers/plans/2026-09-07-decision-workflow-4d.md §A and §D).
--
-- MIGRATION-ONLY in the template's sense. Everything here is additive and DARK: no service,
-- controller, query, emitter, participant or UI change rides with it, and nothing in the running
-- release writes the new columns or reads the new registers. 4d-ii carries the application half.
--
-- THE FILE IS IN FOUR PARTS, ordered so no window opens. Prisma runs the file in ONE transaction,
-- so "committed first" here means "ordered first": PostgreSQL DDL is transactional, and a relation
-- created in Part 0 is visible to every later statement in the same transaction.
--
--   Part 0  the RETIREMENT MARKER table and its seals. FIRST, because every marker-aware statement
--           in this file reads it — the transient reservation block of Part 1 included — and on a
--           fresh database the relation does not exist yet (#572's review round 25, finding 4:
--           round 23 made Part 1 marker-aware and left this table in Part 3, so a fresh install
--           would abort on a missing relation while dropping the query would restore the
--           mature-replay downgrade the marker exists to prevent).
--   Part 1  the shared refusal function and the two TEXT-judged `Decision` reservation doors.
--   Part 2  the enum additions.
--   Part 3  the seal-and-audit body.
--
-- ENUM VALUES ADDED HERE ARE NEVER CONSUMED HERE. `ALTER TYPE … ADD VALUE` inside a transaction
-- leaves the value unusable until commit, so every comparison against `architect` and
-- `awaiting_countersign` in this file is made on `::text` — the way 20271015 added `recorded`.
-- That is also why Part 1's doors can be created BEFORE Part 2 adds the values they name: a
-- trigger's body is not evaluated until a row is written.
--
-- RE-RUNNABLE AND MARKER-AWARE. Every statement is `IF NOT EXISTS` / `IF EXISTS` /
-- `CREATE OR REPLACE`, so a partial apply retries. The PERMANENT portion (tables, columns, seals,
-- backfills, primitives, registers) runs unconditionally; the TRANSIENT portion (the five
-- reservation doors, their shared refusal function, and the audits) runs ONLY while the
-- `RolloutRetirement` marker for this unit is ABSENT — in `ALWAYS_EXECUTE` a later P3005 baseline
-- of a MATURE database replays this file after 4d-iii retired the doors, and an unconditional
-- body would re-create a reservation and abort on rows that are legitimately there.
--
-- Recovery for a failed apply: docs/RUNBOOK.md §P6T4D.

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — THE RETIREMENT MARKER
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- One row per retired unit. It is the durable fact that 4d-iii has run, and it is read by every
-- conditional statement below. It is NOT a row on `OutboxOperatorAction`: that table's 4c-iii-r
-- verifier (`verifyMarkerSeals`) keeps a CLOSED trigger inventory, and a fourth trigger on it
-- would fail the verifier. So the marker gets its own table carrying the 4c-iii-r seal SHAPE on
-- its own surface.

CREATE TABLE IF NOT EXISTS "RolloutRetirement" (
  "unit"      TEXT NOT NULL,
  "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredBy" TEXT NOT NULL,
  CONSTRAINT "RolloutRetirement_pkey" PRIMARY KEY ("unit")
);

-- The complete ASCII whitespace set, as everywhere else in this corpus: space, tab, newline,
-- vertical tab, form feed, carriage return. A blank unit names nothing and a blank actor
-- attributes nothing, and either would make the marker unreadable as evidence.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'RolloutRetirement_unit_nonblank'
       AND conrelid = '"RolloutRetirement"'::regclass
  ) THEN
    ALTER TABLE "RolloutRetirement"
      ADD CONSTRAINT "RolloutRetirement_unit_nonblank"
      CHECK (btrim("unit", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'RolloutRetirement_retiredBy_nonblank'
       AND conrelid = '"RolloutRetirement"'::regclass
  ) THEN
    ALTER TABLE "RolloutRetirement"
      ADD CONSTRAINT "RolloutRetirement_retiredBy_nonblank"
      CHECK (btrim("retiredBy", E' \t\n\x0B\f\r') <> '');
  END IF;
END $$;

-- CREATION IS GATED TO THE RETIRING TRANSACTION. Only 4d-iii sets
-- `SET LOCAL vitan.phase6_4d_retire = 'on'`, so no ordinary path — a maintenance script, an ORM,
-- a psql session, a restore tool — writes a marker by accident and silently converts every
-- marker-aware statement in this file to its post-retirement body.
--
-- STATED PLAINLY, in the 4c-iii-r sense: this is mistake-proofing, NEVER a privilege boundary.
-- An actor with direct write access can call `set_config` too, and this deployment's single
-- table-owning role could not honour a privilege claim anyway. What it buys is that shaping the
-- row correctly is no longer enough — writing one requires deliberately impersonating the
-- retirement protocol.
CREATE OR REPLACE FUNCTION phase6_t4d_rollout_retirement_gate() RETURNS trigger AS $fn$
DECLARE flag TEXT;
BEGIN
  flag := current_setting('vitan.phase6_4d_retire', true);
  IF flag IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'RolloutRetirement is written only by the retiring migration (phase 6 unit 4d-iii) — this insert is not inside a retirement transaction. See docs/RUNBOOK.md §P6T4D.';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- The marker is a FACT, not a setting: once written it is never edited and never withdrawn. A
-- mutable marker would let a writer flip this file between its pre- and post-retirement bodies
-- at will, which is the whole hazard the marker was introduced to close.
CREATE OR REPLACE FUNCTION phase6_t4d_rollout_retirement_frozen() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'RolloutRetirement is append-only — a retirement is never edited or withdrawn (unit %)', COALESCE(OLD."unit", NEW."unit");
END;
$fn$ LANGUAGE plpgsql;

-- TRUNCATE does not fire a row-level trigger; it is a separate, STATEMENT-level event. Without
-- this the whole retirement record can be erased in one statement and every marker-aware body
-- silently reverts.
CREATE OR REPLACE FUNCTION phase6_t4d_rollout_retirement_no_truncate() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'RolloutRetirement is never truncated — the retirement record is rollout evidence';
END;
$fn$ LANGUAGE plpgsql;

-- The idempotent install shape this corpus uses everywhere: create when absent, and when present
-- VERIFY the binding rather than assume it. tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT,
-- 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE.
DO $$
DECLARE tg pg_trigger;
BEGIN
  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'RolloutRetirement_t4d_gate'
     AND tgrelid = '"RolloutRetirement"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "RolloutRetirement_t4d_gate" BEFORE INSERT ON "RolloutRetirement"
      FOR EACH ROW EXECUTE FUNCTION phase6_t4d_rollout_retirement_gate();
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_rollout_retirement_gate'
     OR tg.tgtype <> 7 THEN            -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4)
    RAISE EXCEPTION
      'phase6 4d-i: RolloutRetirement_t4d_gate exists but does not gate INSERT (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'RolloutRetirement_t4d_frozen'
     AND tgrelid = '"RolloutRetirement"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "RolloutRetirement_t4d_frozen" BEFORE UPDATE OR DELETE ON "RolloutRetirement"
      FOR EACH ROW EXECUTE FUNCTION phase6_t4d_rollout_retirement_frozen();
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_rollout_retirement_frozen'
     OR tg.tgtype <> 27 THEN           -- EXACTLY ROW(1) + BEFORE(2) + DELETE(8) + UPDATE(16):
                                       -- an INSERT bit here would refuse the retirement itself
    RAISE EXCEPTION
      'phase6 4d-i: RolloutRetirement_t4d_frozen exists but does not freeze both UPDATE and DELETE (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'RolloutRetirement_t4d_no_truncate'
     AND tgrelid = '"RolloutRetirement"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "RolloutRetirement_t4d_no_truncate" BEFORE TRUNCATE ON "RolloutRetirement"
      FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_rollout_retirement_no_truncate();
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_rollout_retirement_no_truncate'
     OR tg.tgtype <> 34 THEN           -- EXACTLY BEFORE(2) + TRUNCATE(32), statement-level
    RAISE EXCEPTION
      'phase6 4d-i: RolloutRetirement_t4d_no_truncate exists but does not enforce the statement-level truncate seal (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- The ONE reader every conditional statement below shares. Kept as a function rather than an
-- inline EXISTS so the marker-aware set is greppable and so a later unit changing the predicate
-- changes it in one place.
CREATE OR REPLACE FUNCTION phase6_t4d_retired() RETURNS boolean AS $fn$
  SELECT EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d');
$fn$ LANGUAGE sql STABLE;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE RESERVATION DOORS (TRANSIENT)
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The architect chain and its `awaiting_countersign` state are RESERVED between this migration
-- and 4d-iii: the enum values exist so the schema is deployable, and these doors make them
-- unreachable so no row can be written into a state whose seals are not installed yet. They are
-- TEXT-judged, so they can be created before Part 2 adds the values they name.
--
-- The refusal function is SHARED by all five doors: one message, one place to change it, and a
-- single object for 4d-iii to drop.

DO $$
BEGIN
  IF phase6_t4d_retired() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the reservation doors are NOT installed (this is a replay over a retired database)';
  ELSE
    CREATE OR REPLACE FUNCTION phase6_t4d_reserved() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'the architect chain is reserved until phase 6 unit 4d-iii retires this door — % is not writable yet on %', TG_ARGV[0], TG_TABLE_NAME;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$
DECLARE tg pg_trigger;
BEGIN
  IF phase6_t4d_retired() THEN
    RETURN;
  END IF;

  -- `deciderKind = 'architect'` is unreachable until the designation's seals exist. Judged on
  -- ::text because Part 2 has not committed the enum value yet.
  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'Decision_t4d_architect_reserved'
     AND tgrelid = '"Decision"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "Decision_t4d_architect_reserved" BEFORE INSERT OR UPDATE ON "Decision"
      FOR EACH ROW WHEN (NEW."deciderKind"::text = 'architect')
      EXECUTE FUNCTION phase6_t4d_reserved('Decision.deciderKind = architect');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 23 THEN           -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16)
    RAISE EXCEPTION
      'phase6 4d-i: Decision_t4d_architect_reserved exists but does not reserve the designation (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;

  -- `status = 'awaiting_countersign'` is unreachable until the chain's seals exist.
  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'Decision_t4d_awaiting_reserved'
     AND tgrelid = '"Decision"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "Decision_t4d_awaiting_reserved" BEFORE INSERT OR UPDATE ON "Decision"
      FOR EACH ROW WHEN (NEW."status"::text = 'awaiting_countersign')
      EXECUTE FUNCTION phase6_t4d_reserved('Decision.status = awaiting_countersign');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 23 THEN
    RAISE EXCEPTION
      'phase6 4d-i: Decision_t4d_awaiting_reserved exists but does not reserve the chain state (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE ENUM ADDITIONS
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Each its own statement. Nothing in THIS transaction consumes either value — every comparison
-- above and below is made on ::text — so the unusable-in-same-transaction rule is never tripped.

ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS 'architect';
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'awaiting_countersign';
