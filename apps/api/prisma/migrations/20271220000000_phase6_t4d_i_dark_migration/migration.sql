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
-- ATOMICITY IS THIS FILE'S OWN, and the BEGIN below is why (#582's review round 3, finding 1).
-- The unit's whole claim is that it deploys DARK and leaves no observable window: the reservation
-- doors, the enum values, the registers, the seals and the audits either are all there or none of
-- them is. Nothing was enforcing that. Prisma DOCUMENTS the opposite — migrations are not
-- automatically wrapped in a transaction — so under a runner that autocommits, a failure in the
-- late audits would leave doors and trigger replacements committed while the migration is reported
-- FAILED, and §P6T4D's recovery would be telling an operator that everything rolled back when it
-- had not. `20271120000000_phase6_t4c_iii_enablement` records exactly this reasoning and adds its
-- own wrapper; this file is the third in the repository to do so.
--
-- The first version of this file argued the opposite, IN CONTRADICTION WITH ITS OWN PARAGRAPH
-- ABOVE: the catalog-gate comment claimed "this file is not wrapped in one transaction (Part 2's
-- `ALTER TYPE` statements cannot be)", while the paragraph above already states the real rule —
-- a value added by `ALTER TYPE … ADD VALUE` is unusable until commit, which is a restriction on
-- CONSUMING it, not on adding it inside a transaction. PostgreSQL has permitted the ADD since 12.
-- Measured rather than argued: the whole file applies inside one BEGIN/COMMIT on PostgreSQL 16,
-- and the probe below asserts both directions — it applies wrapped, and a raise anywhere inside
-- it leaves NO object behind.
--
-- Recovery for a failed apply: docs/RUNBOOK.md §P6T4D.

BEGIN;

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
--
-- A MARKER ALONE IS NOT EVIDENCE (#582 round 5, finding 2). `RolloutRetirement` is a
-- `schema.prisma` model, so on the supported P3005 path `prisma db push` creates the TABLE before
-- any of its raw seals exist — the gate that admits only the retiring migration, the freeze, the
-- truncate refusal are all in this file. A row written into that unsealed window would be adopted
-- here at face value, and the consequence is not a cosmetic one: every conditional below would
-- skip, so the five reservation doors and the legacy-role audit would never install, pre-existing
-- architect memberships would be paired against a zero-count backfill, and a rollout the operator
-- believes is DARK would be open on a database that never ran retirement.
--
-- So the marker is adopted only alongside evidence that there was something to retire. 4d-iii
-- retires a unit that 4d-i INSTALLED, and 4d-i's seals are raw `CREATE FUNCTION` — the one class
-- of object `prisma db push` cannot reproduce from the schema, and the one 4d-iii has no reason to
-- drop, because the chain those seals protect is exactly what goes live. A database claiming
-- retirement without them has a marker and no history, and this file treats that as unretired:
-- installing doors that a genuinely retired database no longer needs is a replay's cost, while
-- skipping them on a forged marker is a hole with no floor.
CREATE OR REPLACE FUNCTION phase6_t4d_retired() RETURNS boolean AS $fn$
  SELECT EXISTS (SELECT 1 FROM "RolloutRetirement" WHERE "unit" = 'phase6-4d')
     AND to_regproc('phase6_t4d_membership_transition_seal') IS NOT NULL;
$fn$ LANGUAGE sql STABLE;

-- THE VERDICT IS TAKEN ONCE, BEFORE THIS FILE CREATES ANY OF THE EVIDENCE IT READS
-- (#582's review round 7, finding 1). The evidence conjunct above was round 5's answer to a
-- forged marker, and it made the predicate SELF-FULFILLING: the artifact it names,
-- `phase6_t4d_membership_transition_seal`, is created by THIS migration a few thousand lines
-- below. On a db-push baseline carrying an unsealed `phase6-4d` marker the predicate is
-- correctly FALSE at the doors, turns TRUE the moment the seal function is created, and every
-- gate after that point then skips as if 4d-iii had run — leaving `DecisionForward_t4d_reserved`
-- uninstalled and `DecisionEvent_t4d_correspondence` absent on a database that retired nothing.
-- The unit would commit calling itself dark with the forwarding door open.
--
-- A predicate cannot be evidence of a state this file is in the middle of creating. So the
-- question is asked ONCE, here, against the PRE-MIGRATION database, and every gate in this file
-- reads the answer rather than re-deriving it. `phase6_t4d_retired()` stays as the durable
-- definition of "retired" — it is what this snapshot calls, and what a later unit asks of a
-- settled database — while `phase6_t4d_retired_at_start()` is what THIS transaction may ask,
-- because only it is fixed against the file's own writes.
--
-- TRANSACTION-LOCAL (`is_local = true`), like the catalog gate: this file is one transaction
-- (round 3, finding 1), so the snapshot covers every statement in it and survives no failure.
DO $snapshot$
BEGIN
  PERFORM set_config('vitan.phase6_4d_retired_at_start',
                     CASE WHEN phase6_t4d_retired() THEN 'on' ELSE 'off' END, true);
END $snapshot$;

CREATE OR REPLACE FUNCTION phase6_t4d_retired_at_start() RETURNS boolean AS $fn$
  SELECT current_setting('vitan.phase6_4d_retired_at_start', true) = 'on';
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
  IF phase6_t4d_retired_at_start() THEN
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
  IF phase6_t4d_retired_at_start() THEN
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

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — THE SEAL-AND-AUDIT TRANSACTION
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Part 3 opens with BOTH orgs-owned RESERVATIONS and only then audits (§D, and #558's review
-- round 2, finding 9). The ordering is the whole point and is stated once here:
--
--   * `CREATE TRIGGER` on "Membership" takes ACCESS EXCLUSIVE on that table, so every concurrent
--     membership writer blocks until this transaction ends.
--   * That lock cannot block a concurrent `User(role = 'architect')` creation, so the transaction
--     ALSO takes `LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE` and installs the FIFTH door
--     (#558's review round 1, finding 5). Without it a still-serving `ensure-accounts` could
--     commit its user AFTER the audit counted zero, be refused only at its membership upsert,
--     and leave a residual identity behind a migration that recorded success.
--   * Only after BOTH locks are held does the audit count. Auditing FIRST would leave the
--     classic gap: a row inserted after the count observed zero and before `CREATE TRIGGER`
--     took its lock would be grandfathered past the reservation.
--
-- The audit RAISES with a bounded sample and rolls the WHOLE transaction back, the triggers
-- included. It never re-roles and never deletes: the operator repair is a RE-ROLE through the
-- ordinary team command (docs/RUNBOOK.md §P6T4D), then
-- `prisma migrate resolve --rolled-back`, then redeploy.

-- ── the "Membership" and "User" doors ────────────────────────────────────────────────────────
-- Judged on NEW regardless of OLD, so a soft-removed row already spelling `architect` can be
-- neither restored nor re-keyed into service through it — the exact shape of 4c-i's
-- `ProjectCapability_t4c_reserved`. `Membership.role` and `User.role` are unconstrained TEXT
-- columns, so these are string comparisons and need no cast.
--
-- The "User" lock is taken BEFORE its trigger, so the ordering is stated rather than left as a
-- side effect of the DDL: SHARE ROW EXCLUSIVE conflicts with every ordinary writer and with
-- itself, which is what the audit needs, and the `CREATE TRIGGER` that follows escalates to
-- ACCESS EXCLUSIVE anyway.
DO $$
DECLARE tg pg_trigger;
BEGIN
  IF phase6_t4d_retired_at_start() THEN RETURN; END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'Membership_t4d_architect_reserved'
     AND tgrelid = '"Membership"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "Membership_t4d_architect_reserved" BEFORE INSERT OR UPDATE ON "Membership"
      FOR EACH ROW WHEN (NEW."role" = 'architect')
      EXECUTE FUNCTION phase6_t4d_reserved('Membership.role = architect');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 23 THEN           -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16)
    RAISE EXCEPTION
      'phase6 4d-i: Membership_t4d_architect_reserved exists but does not reserve the role (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;

  LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'User_t4d_architect_reserved'
     AND tgrelid = '"User"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "User_t4d_architect_reserved" BEFORE INSERT OR UPDATE ON "User"
      FOR EACH ROW WHEN (NEW."role" = 'architect')
      EXECUTE FUNCTION phase6_t4d_reserved('User.role = architect');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 23 THEN
    RAISE EXCEPTION
      'phase6 4d-i: User_t4d_architect_reserved exists but does not reserve the role (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- ── the diagnostic-first audit ───────────────────────────────────────────────────────────────
-- ANY status counts: the ordinary team removal sets `status = 'removed'` and leaves `role` in
-- place, so a soft-removed row aborts identically. `User.role` is counted because the dev-session
-- fallback reads it verbatim.
DO $$
DECLARE
  v_memberships BIGINT;
  v_users       BIGINT;
  v_sample      TEXT;
BEGIN
  IF phase6_t4d_retired_at_start() THEN RETURN; END IF;

  SELECT count(*) INTO v_memberships FROM "Membership" WHERE "role" = 'architect';
  SELECT count(*) INTO v_users       FROM "User"       WHERE "role" = 'architect';

  IF v_memberships > 0 OR v_users > 0 THEN
    SELECT string_agg(line, E'\n') INTO v_sample FROM (
      (SELECT 'Membership ' || m."id" || ' (project ' || m."projectId"
              || ', user ' || m."userId" || ', status ' || m."status" || ')' AS line
         FROM "Membership" m WHERE m."role" = 'architect' ORDER BY m."id" LIMIT 10)
      UNION ALL
      (SELECT 'User ' || u."id" || ' (' || COALESCE(u."email", '<no email>') || ')' AS line
         FROM "User" u WHERE u."role" = 'architect' ORDER BY u."id" LIMIT 10)
    ) s;
    RAISE EXCEPTION
      'phase6 4d-i ABORT: % "Membership" row(s) and % "User" row(s) already spell the reserved role `architect`. Nothing validated that value before this migration, so the reservation would leave them in place and arm the chain the instant the role is understood. Refusing to commit; nothing was installed. Sample (max 10 of each):%',
      v_memberships, v_users,
      E'\n' || v_sample
        || E'\nSee docs/RUNBOOK.md §P6T4D for the repair: RE-ROLE through the team command, then `prisma migrate resolve --rolled-back`, then redeploy.';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3b — THE PLATFORM REGISTERS, THEIR GENERIC WRITERS AND THE KERNEL READS
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- These come BEFORE the fact tables that read them. §D's Part 3 inventory lists the facts
-- first, but that list is an INVENTORY of what the transaction contains, not a statement
-- order: the only orderings §D mandates inside Part 3 are the two reservations and their locks
-- before the audit, and the audit before everything else. Placing the registers, their
-- primitives and the kernel reads ahead of their callers follows the repository's own
-- SHAPE-then-SEAL convention (20271101, 4c-i) and makes the backfills — which are ordinary
-- statements and DO depend on the tables existing — legible in one pass.
--
-- WHY THESE REGISTERS EXIST AT ALL (§A.2, #561's review round 1, finding 1): no decisions- or
-- platform-owned trigger reads an orgs table. Standing, identity, team-management authority and
-- the project→org mapping reach every seal through platform-owned REGISTERS that ORGS-owned
-- triggers project from their OWN rows. The registers agree with the orgs tables BY
-- CONSTRUCTION — both are functions of the same rows, a row trigger fires for every row write,
-- and the writer-depth seal admits no other writer — never by a cross-module check.

-- ── the tables ───────────────────────────────────────────────────────────────────────────────

-- The project→org mapping. Without it a decisions-owned seal holding only a `projectId` cannot
-- reach `OrgUserAuthority` (keyed by `orgId`) at all, and a derivation that SKIPPED the join
-- would accept an owner or admin of an UNRELATED organisation as `pmc` on this project
-- (#572's review round 14, finding 1). `orgId` is IMMUTABLE: a project does not change
-- organisation, and if that ever becomes a product operation it is a migration with its own
-- unit, not a silent re-tenanting of every fact that cites the old org.
CREATE TABLE IF NOT EXISTS "ProjectOrg" (
    "projectId" TEXT NOT NULL,
    "orgId"     TEXT NOT NULL,
    CONSTRAINT "ProjectOrg_pkey" PRIMARY KEY ("projectId")
);

-- The COUNTED role register. Generic in shape so a later unit can carry other roles; 4d
-- maintains the `architect` row only, and `phase6_effective_role_standing` stays the authority
-- for `client`/`pmc` exactly as delivered.
CREATE TABLE IF NOT EXISTS "ProjectRoleStanding" (
    "projectId"   TEXT NOT NULL,
    "role"        TEXT NOT NULL,
    "activeCount" INTEGER NOT NULL DEFAULT 0,
    "changedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectRoleStanding_pkey" PRIMARY KEY ("projectId", "role")
);

-- PER-USER standing: a row is present IFF that user holds ACTIVE standing in that role on that
-- project — an active membership in the role, the row naming it; or, for `pmc`, an org
-- owner/admin with NO active membership on the project (the membership-less arm the token role
-- and the delivered `ProjectAccessService` already admit), `membershipId` NULL.
CREATE TABLE IF NOT EXISTS "ProjectUserStanding" (
    "projectId"    TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "role"         TEXT NOT NULL,
    "membershipId" TEXT,
    CONSTRAINT "ProjectUserStanding_pkey" PRIMARY KEY ("projectId", "userId", "role")
);

-- The display name every frozen `<act>ByName` is judged against.
CREATE TABLE IF NOT EXISTS "UserIdentity" (
    "userId"      TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("userId")
);

-- Team-management AUTHORITY, which is distinct from token ROLE: an owner/admin row per org
-- membership in those roles (#562's review round 1, finding 2).
CREATE TABLE IF NOT EXISTS "OrgUserAuthority" (
    "orgId"  TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role"   TEXT NOT NULL,
    CONSTRAINT "OrgUserAuthority_pkey" PRIMARY KEY ("orgId", "userId")
);

CREATE INDEX IF NOT EXISTS "ProjectUserStanding_userId_idx" ON "ProjectUserStanding"("userId");
CREATE INDEX IF NOT EXISTS "OrgUserAuthority_userId_idx" ON "OrgUserAuthority"("userId");
CREATE INDEX IF NOT EXISTS "ProjectOrg_orgId_idx" ON "ProjectOrg"("orgId");

DO $$ BEGIN
  ALTER TABLE "ProjectOrg" ADD CONSTRAINT "ProjectOrg_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectRoleStanding" ADD CONSTRAINT "ProjectRoleStanding_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectUserStanding" ADD CONSTRAINT "ProjectUserStanding_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The identity row FALLS WITH ITS USER (#572's review round 4, finding 4). The seed and the
-- integration fixtures HARD-DELETE `User` rows; without the cascade either the delete fails on
-- this row's FK and no reset completes, or the row outlives its user and `platform:verify`
-- reports orphaned identity evidence forever. The seal ADMITS the cascade (it arrives nested,
-- at trigger depth) while a direct `DELETE FROM "UserIdentity"` stays refused.
DO $$ BEGIN
  ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUserAuthority" ADD CONSTRAINT "OrgUserAuthority_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUserAuthority" ADD CONSTRAINT "OrgUserAuthority_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A negative delta is a REFUSAL, never a clamp: a count that would go below zero means the
-- register and the memberships have diverged, and silently flooring it would hide exactly the
-- divergence this register exists to make impossible.
DO $$ BEGIN
  ALTER TABLE "ProjectRoleStanding" ADD CONSTRAINT "ProjectRoleStanding_activeCount_check"
    CHECK ("activeCount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_displayName_present_check"
    CHECK (btrim("displayName", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OrgUserAuthority" ADD CONSTRAINT "OrgUserAuthority_role_check"
    CHECK ("role" IN ('owner', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the orgs-owned project-delete flag ───────────────────────────────────────────────────────
-- 4c-iii's `Project_t4c_deleting` shape, reinstalled under a 4d name because 4c-v retired the
-- original. It lives on `Project` — orgs' own table, where "this project is being deleted"
-- belongs — and publishes the fact as a TRANSACTION-LOCAL flag the platform seals read. They
-- consult the flag, never the table, so no platform invariant depends on orgs' physical schema.
--
-- The flag is a BOOLEAN and not the deleting project's id, for the reason 4c-iii measured:
-- under a multi-row `DELETE FROM "Project" WHERE …` PostgreSQL queues the RI cascades as
-- AFTER-statement actions, so an id-valued flag would hold only the LAST row's id by the time
-- they fire and every earlier project's cascade would be wrongly refused — which is exactly the
-- shape the shared fixture teardown uses.
CREATE OR REPLACE FUNCTION phase6_t4d_project_deleting() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('phase6.t4d_project_delete', 'on', true);
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Project_t4d_deleting" ON "Project";
CREATE TRIGGER "Project_t4d_deleting"
  BEFORE DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_project_deleting();

-- ── the shared writer-depth seal ─────────────────────────────────────────────────────────────
-- Every register above is a PROJECTION. Its truth is the orgs table it is projected from, so
-- the only legal writer is the trigger that watches that table, and a register written by
-- anything else is evidence of nothing. The rule is one local fact:
--
--   `pg_trigger_depth() = 1` means the statement was issued DIRECTLY by a client. Anything
--   deeper arrived nested inside another trigger — the orgs standing/identity/authority
--   triggers, or the RI cascade of the project's or the user's own deletion, which 4c-iii
--   measured at depth 2 on PostgreSQL 16 including the multi-row parent delete.
--
-- TWO gates open a depth-1 door, each narrow and each named:
--
--   * `vitan.phase6_4d_standing_backfill` — THIS migration's backfills, and every
--     `ALWAYS_EXECUTE` replay of them. Admits INSERTs only. The exclusion of rows that already
--     exist belongs to the STATEMENT (`WHERE NOT EXISTS … ON CONFLICT DO NOTHING`), never to
--     the seal: a seal clause reading "only for a project that has no row" is evaluated per
--     VALUES row and would refuse the replay's own insert, making 4d-i unreplayable (#560's
--     review round 2, finding 5; #572's review round 9).
--   * `vitan.phase6_4d_standing_reprojection` — 4d-iii's fenced verify-and-repair, which re-projects the
--     two per-user registers from the orgs truth before it closes any door (#572's review
--     round 5, finding 4). Installed here because the SEAL is installed here; nothing in 4d-i
--     sets it.
--
-- Neither gate is a general escape hatch: outside them a depth-1 write is refused whatever it
-- carries, which is what P42's negative arm proves by issuing the same repair statements with
-- no gate and with the gate but no fence.
CREATE OR REPLACE FUNCTION platform_t4d_register_writer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_row     RECORD;
  v_backfill BOOLEAN := coalesce(current_setting('vitan.phase6_4d_standing_backfill', true), '') = 'on';
  v_reproject BOOLEAN := coalesce(current_setting('vitan.phase6_4d_standing_reprojection', true), '') = 'on';
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND v_backfill THEN RETURN NEW; END IF;
  IF v_reproject AND TG_TABLE_NAME IN ('ProjectUserStanding', 'OrgUserAuthority') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'phase6 4d-i: "%" is a platform REGISTER projected from the orgs tables by their own triggers — a % issued directly (trigger depth 1) is refused. Its truth is the orgs row it mirrors; a register written by anything else is evidence of nothing. The migration backfill runs under `vitan.phase6_4d_standing_backfill`, and 4d-iii''s re-projection under `vitan.phase6_4d_standing_reprojection`.',
    TG_TABLE_NAME, TG_OP;
END $$;

-- `orgId` is IMMUTABLE. Installed as its own seal rather than folded into the shared one,
-- because it is a different claim: the writer-depth seal says WHO may write, this says WHAT may
-- change, and a nested write from a legitimate trigger must still not re-tenant the project.
CREATE OR REPLACE FUNCTION platform_t4d_project_org_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: project % is registered to org % and may not be re-tenanted to % — every fact that cites the old org would silently change meaning. If moving a project between organisations becomes a product operation it is a migration with its own unit.',
      OLD."projectId", OLD."orgId", NEW."orgId";
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProjectOrg', 'ProjectRoleStanding', 'ProjectUserStanding',
                           'UserIdentity', 'OrgUserAuthority'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_writer', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I'
      || ' FOR EACH ROW EXECUTE FUNCTION platform_t4d_register_writer()',
      t || '_t4d_writer', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS "ProjectOrg_t4d_frozen" ON "ProjectOrg";
CREATE TRIGGER "ProjectOrg_t4d_frozen" BEFORE UPDATE ON "ProjectOrg"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_project_org_frozen();

-- ── the statement-level no-TRUNCATE seals ────────────────────────────────────────────────────
-- A row trigger never fires for TRUNCATE, so every register that carries a row seal carries a
-- statement seal too, and each is disabled BY NAME by the sanctioned reset
-- (prisma/sanctioned-reset.ts `TRUNCATE_SEALS`). `Membership` joins them because it is the
-- source the counted register mirrors: truncating it would leave the counts standing over
-- nothing.
CREATE OR REPLACE FUNCTION platform_t4d_register_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "%" is a projected register (or the orgs table one mirrors) and is never truncated — a row trigger does not fire for TRUNCATE, so the statement is sealed too. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME.',
    TG_TABLE_NAME;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ProjectOrg', 'ProjectRoleStanding', 'ProjectUserStanding',
                           'UserIdentity', 'OrgUserAuthority', 'Membership'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_no_truncate', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I'
      || ' FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_register_no_truncate()',
      t || '_t4d_no_truncate', t);
  END LOOP;
END $$;

-- ── the GENERIC platform writers ─────────────────────────────────────────────────────────────
-- Each knows NO role, reads NO table and makes NO decision: it is handed a fact and records it.
-- That is what keeps orchestration out of the leaf (#554's review round 2, finding 4) — the
-- dependency runs orgs → platform, as every module's does, and the orgs trigger that calls
-- these is the one that understands what `architect` or `owner` MEANS.

CREATE OR REPLACE FUNCTION platform_project_org_apply(p_project TEXT, p_org TEXT)
RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  INSERT INTO "ProjectOrg" ("projectId", "orgId") VALUES (p_project, p_org)
  ON CONFLICT ("projectId") DO NOTHING;
END $$;

-- UPDATE-FIRST, and the shape is not cosmetic. §A.2 spells this primitive as
-- `INSERT … ON CONFLICT ("projectId","role") DO UPDATE SET "activeCount" = "activeCount" + delta`,
-- and that spelling CANNOT apply a negative delta at all: PostgreSQL evaluates a table's CHECK
-- constraints against the PROPOSED insert row BEFORE it resolves the conflict, so
-- `VALUES (…, -1) ON CONFLICT DO UPDATE` fails `activeCount >= 0` on the proposed `-1` even when
-- the existing row holds 5. Measured directly on this server, on a two-column temp table with
-- the same CHECK. Under that spelling the removal of an architect would ALWAYS abort — the
-- register could be incremented and never decremented — so the plan''s §A.2 text is corrected
-- here and owes the same correction (self-found implementing 4d-i).
--
-- The refusal the plan DOES want is kept exactly: a negative delta against a row that does not
-- exist is real divergence between the register and the memberships, and the INSERT arm below
-- meets the CHECK and refuses it. A negative delta is never clamped.
CREATE OR REPLACE FUNCTION platform_role_standing_apply(p_project TEXT, p_role TEXT, p_delta INT)
RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;

  UPDATE "ProjectRoleStanding"
     SET "activeCount" = "activeCount" + p_delta, "changedAt" = CURRENT_TIMESTAMP
   WHERE "projectId" = p_project AND "role" = p_role;
  IF FOUND THEN RETURN; END IF;

  -- No row yet. A concurrent writer may be creating it, so the insert tolerates the collision
  -- and the delta is re-applied to whichever row won.
  INSERT INTO "ProjectRoleStanding" ("projectId", "role", "activeCount", "changedAt")
  VALUES (p_project, p_role, p_delta, CURRENT_TIMESTAMP)
  ON CONFLICT ("projectId", "role") DO NOTHING;
  IF NOT FOUND THEN
    UPDATE "ProjectRoleStanding"
       SET "activeCount" = "activeCount" + p_delta, "changedAt" = CURRENT_TIMESTAMP
     WHERE "projectId" = p_project AND "role" = p_role;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION platform_user_standing_apply(
  p_project TEXT, p_user TEXT, p_role TEXT, p_membership TEXT, p_present BOOLEAN
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_present THEN
    INSERT INTO "ProjectUserStanding" ("projectId", "userId", "role", "membershipId")
    VALUES (p_project, p_user, p_role, p_membership)
    ON CONFLICT ("projectId", "userId", "role")
    DO UPDATE SET "membershipId" = EXCLUDED."membershipId";
  ELSE
    DELETE FROM "ProjectUserStanding"
     WHERE "projectId" = p_project AND "userId" = p_user AND "role" = p_role;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION platform_user_identity_apply(p_user TEXT, p_name TEXT)
RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  INSERT INTO "UserIdentity" ("userId", "displayName") VALUES (p_user, p_name)
  ON CONFLICT ("userId") DO UPDATE SET "displayName" = EXCLUDED."displayName";
END $$;

CREATE OR REPLACE FUNCTION platform_org_authority_apply(
  p_org TEXT, p_user TEXT, p_role TEXT, p_present BOOLEAN
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF p_present THEN
    INSERT INTO "OrgUserAuthority" ("orgId", "userId", "role") VALUES (p_org, p_user, p_role)
    ON CONFLICT ("orgId", "userId") DO UPDATE SET "role" = EXCLUDED."role";
  ELSE
    DELETE FROM "OrgUserAuthority" WHERE "orgId" = p_org AND "userId" = p_user;
  END IF;
END $$;

-- ── the KERNEL READS every seal asks its questions through ───────────────────────────────────
-- No decisions- or platform-owned trigger reads an orgs table; it asks one of these.

CREATE OR REPLACE FUNCTION platform_role_standing(p_project TEXT, p_role TEXT)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT "activeCount" FROM "ProjectRoleStanding"
                    WHERE "projectId" = p_project AND "role" = p_role), 0);
$$;

-- Asked of ANY role, so it reads the PER-USER register rather than the counted one: 4d
-- maintains an `architect` count only (`phase6_effective_role_standing` stays the authority for
-- `client`/`pmc`, §A.2), while the re-homing rule of §A.2 asks this question about a `client` or
-- `pmc` role designation emptied the same way. Reading the count would answer "no holder" for
-- every role but `architect`. It also agrees with `platform_role_holder_user_ids` by
-- construction, both being EXISTS/SELECT over the same rows.
CREATE OR REPLACE FUNCTION platform_role_has_holder(p_project TEXT, p_role TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "ProjectUserStanding"
                  WHERE "projectId" = p_project AND "role" = p_role);
$$;

-- The CURRENT holders, resolved at the moment of the call — never a set frozen earlier. A
-- role-held designation names a role, not a person, so every question about "who holds this"
-- is answered here and nowhere else.
CREATE OR REPLACE FUNCTION platform_role_holder_user_ids(p_project TEXT, p_role TEXT)
RETURNS SETOF TEXT LANGUAGE sql STABLE AS $$
  SELECT "userId" FROM "ProjectUserStanding"
   WHERE "projectId" = p_project AND "role" = p_role ORDER BY "userId";
$$;

-- Takes the membership row's lock, then returns its `userId` when ACTIVE and NULL otherwise, so
-- a seal establishes standing and reads the identity in ONE owned call. What it serializes
-- against is the ACTIVE→removed transition, which is a live state change; splitting it into a
-- boolean check plus a separate read would leave a window between them. This is the kernel twin
-- of 4c's orgs-owned `phase6_membership_active_user`, and it reads the REGISTER, not
-- `Membership` — the register's `membershipId` is the row to lock.
CREATE OR REPLACE FUNCTION platform_membership_active_user(p_project TEXT, p_membership TEXT)
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_user TEXT;
BEGIN
  IF p_project IS NULL OR p_membership IS NULL THEN RETURN NULL; END IF;
  SELECT "userId" INTO v_user FROM "ProjectUserStanding"
   WHERE "projectId" = p_project AND "membershipId" = p_membership FOR UPDATE;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION platform_user_holds_role(p_project TEXT, p_user TEXT, p_role TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "ProjectUserStanding"
                  WHERE "projectId" = p_project AND "userId" = p_user AND "role" = p_role);
$$;

CREATE OR REPLACE FUNCTION platform_user_display_name(p_user TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT "displayName" FROM "UserIdentity" WHERE "userId" = p_user;
$$;

-- Team-management authority, resolved projectId → orgId → OrgUserAuthority INSIDE the kernel,
-- touching no orgs table. The tenancy join is what makes the answer about THIS project's
-- organisation rather than about any organisation the user happens to own (#572's review
-- round 14, finding 1).
CREATE OR REPLACE FUNCTION platform_user_orchestration_authority(p_project TEXT, p_user TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "ProjectOrg" po
      JOIN "OrgUserAuthority" a ON a."orgId" = po."orgId"
     WHERE po."projectId" = p_project AND a."userId" = p_user
  );
$$;

-- ── the ORGS-owned projection triggers ───────────────────────────────────────────────────────
-- These read ONLY orgs tables (`Project`, `Membership`, `OrgMembership`, `User`) and write ONLY
-- through the generic platform primitives. That is the whole shape of the dependency: orgs
-- knows what a role means, platform knows how to record a fact, and neither reaches into the
-- other's tables.

-- A new project registers itself from its OWN row: no cross-table read, so no race
-- (§A.2 — only the fan-out of membership-less owners/admins across projects races, and 4d-iii
-- re-projects it before it closes a door).
CREATE OR REPLACE FUNCTION phase6_t4d_project_registered() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform_project_org_apply(NEW."id", NEW."orgId");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Project_t4d_project_org" ON "Project";
CREATE TRIGGER "Project_t4d_project_org"
  AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_project_registered();

-- A new project seeds its org's owners and admins as membership-less `pmc` rows — the arm the
-- delivered `ProjectAccessService` already authorizes with a `pmc` token. This is the half of
-- the fan-out that reads `OrgMembership` from a `Project` INSERT; its converse below reads
-- `Project` from an `OrgMembership` INSERT. Each can run before the other's uncommitted row is
-- visible, which is why 4d-iii re-projects both registers before it closes any door
-- (#562's review round 2, finding 3).
CREATE OR REPLACE FUNCTION phase6_t4d_project_user_standing() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT om."userId" FROM "OrgMembership" om
            WHERE om."orgId" = NEW."orgId" AND om."role" IN ('owner', 'admin')
  LOOP
    PERFORM platform_user_standing_apply(NEW."id", r."userId", 'pmc', NULL, TRUE);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Project_t4d_user_standing" ON "Project";
CREATE TRIGGER "Project_t4d_user_standing"
  AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_project_user_standing();

-- A new account is projected the instant it EXISTS, and a rename rewrites the row. Both arms
-- are required: an insert-blind trigger leaves every actor provisioned after 4d-i without an
-- identity row, so every fact of theirs would be refused (#561's review round 2, finding 7).
-- Deletion needs no arm — the identity row's FK cascades from the `User` row itself.
CREATE OR REPLACE FUNCTION phase6_t4d_user_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM platform_user_identity_apply(NEW."id", NEW."name");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "User_t4d_identity" ON "User";
CREATE TRIGGER "User_t4d_identity"
  AFTER INSERT OR UPDATE OF "name" ON "User"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_user_identity();

-- Team-management authority follows the org membership: an owner/admin insert, promotion,
-- demotion or removal writes that user's authority row for the org. Without this writer every
-- owner/admin holding a non-PMC membership fails the authority seal (#562's review round 2,
-- finding 1).
CREATE OR REPLACE FUNCTION phase6_t4d_org_authority() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (OLD."role" IN ('owner', 'admin')) THEN
    PERFORM platform_org_authority_apply(OLD."orgId", OLD."userId", OLD."role", FALSE);
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW."role" IN ('owner', 'admin')) THEN
    PERFORM platform_org_authority_apply(NEW."orgId", NEW."userId", NEW."role", TRUE);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "OrgMembership_t4d_org_authority" ON "OrgMembership";
CREATE TRIGGER "OrgMembership_t4d_org_authority"
  AFTER INSERT OR UPDATE OR DELETE ON "OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_org_authority();

-- The conditional `pmc` fan-out: an owner/admin GAIN or LOSS writes the row on EVERY project of
-- the org where that user has no ACTIVE membership. The condition is the whole point — an org
-- owner who also holds an active membership stands in THAT membership's role, not as `pmc`.
CREATE OR REPLACE FUNCTION phase6_t4d_org_user_standing() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_org      TEXT := COALESCE(NEW."orgId", OLD."orgId");
  v_user     TEXT := COALESCE(NEW."userId", OLD."userId");
  v_authoritative BOOLEAN := (TG_OP <> 'DELETE' AND NEW."role" IN ('owner', 'admin'));
  p RECORD;
BEGIN
  FOR p IN SELECT "id" FROM "Project" WHERE "orgId" = v_org LOOP
    PERFORM platform_user_standing_apply(
      p."id", v_user, 'pmc', NULL,
      v_authoritative AND NOT EXISTS (
        SELECT 1 FROM "Membership" m
         WHERE m."projectId" = p."id" AND m."userId" = v_user AND m."status" = 'active'));
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "OrgMembership_t4d_user_standing" ON "OrgMembership";
CREATE TRIGGER "OrgMembership_t4d_user_standing"
  AFTER INSERT OR UPDATE OR DELETE ON "OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_org_user_standing();

-- ── the membership standing trigger ──────────────────────────────────────────────────────────
-- BEFORE ROW, not AFTER (#565's review round 2, finding 1). The delivered
-- `Membership_t4b2_holder_guard` is an AFTER trigger; PostgreSQL fires same-kind triggers in
-- NAME order and `t4b2` sorts before `t4d`, so an AFTER register trigger would apply its delta
-- only after the guard's architect arm had already read the register — the removal of the last
-- architect under a designated open decision would see `1`, pass, and leave the count at zero.
-- A BEFORE ROW trigger applies the delta before the row is written, so every AFTER guard on
-- `Membership` judges the POST-write count, for one row and for every row of a multi-row
-- statement alike, and a row a later constraint refuses rolls its delta back with it. The
-- reservation and readiness doors sort before this one by name and refuse first.
--
-- It computes the change from the ROW IT IS HANDED and nothing else: no read of `Membership`,
-- no read of any decisions table, no count, and no emission (§A.4). The one read it does make
-- is `OrgMembership`/`Project` for the CONDITIONAL `pmc` row, which is an orgs table and this
-- is an orgs-owned trigger.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_role_standing() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_project TEXT := COALESCE(NEW."projectId", OLD."projectId");
  v_user    TEXT := COALESCE(NEW."userId", OLD."userId");
  v_before  BOOLEAN := (TG_OP <> 'INSERT' AND OLD."status" = 'active');
  v_after   BOOLEAN := (TG_OP <> 'DELETE' AND NEW."status" = 'active');
  v_architect_before BOOLEAN := (TG_OP <> 'INSERT' AND OLD."role" = 'architect' AND OLD."status" = 'active');
  v_architect_after  BOOLEAN := (TG_OP <> 'DELETE' AND NEW."role" = 'architect' AND NEW."status" = 'active');
  v_org     TEXT;
BEGIN
  -- (1) the COUNTED register, `architect` ONLY, computed from this row alone as §A.2 states it:
  --     before := (OLD.role = 'architect' AND OLD.status = 'active')
  --     after  := (NEW.role = 'architect' AND NEW.status = 'active')
  --     delta  := after - before
  --
  -- ARCHITECT ONLY, and that is load-bearing rather than a narrowing for its own sake. The
  -- backfill seeds a zero-count `architect` row per project and nothing else, because
  -- `phase6_effective_role_standing` stays the delivered authority for `client`/`pmc` (§A.2). A
  -- writer that counted EVERY role would apply `-1` for a pre-existing active `engineer`
  -- membership whose row was never seeded, the CHECK would refuse it, and the ordinary team
  -- REMOVAL would abort — a defect this trigger had until it was driven against a real
  -- membership. The register's SHAPE stays generic so a later unit can carry other roles; what
  -- is architect-scoped is 4d's arm.
  IF v_architect_before AND NOT v_architect_after THEN
    PERFORM platform_role_standing_apply(v_project, 'architect', -1);
  ELSIF v_architect_after AND NOT v_architect_before THEN
    PERFORM platform_role_standing_apply(v_project, 'architect', 1);
  END IF;

  -- (2) the PER-USER register, for the OLD role and the NEW one.
  IF v_before AND (NOT v_after OR NEW."role" IS DISTINCT FROM OLD."role") THEN
    PERFORM platform_user_standing_apply(v_project, v_user, OLD."role", OLD."id", FALSE);
  END IF;
  IF v_after THEN
    PERFORM platform_user_standing_apply(v_project, v_user, NEW."role", NEW."id", TRUE);
  END IF;

  -- (3) the CONDITIONAL membership-less `pmc` row, recomputed whenever this user's ACTIVE
  -- presence on the project changes. Writing only the old and the new role row preserved `pmc`
  -- for a new engineer and never restored it for an owner whose last membership ended
  -- (#561's review round 2, finding 1). An explicit `pmc` membership is handled by (2) and
  -- takes precedence: (2) runs first and this arm never clears a row it just wrote, because a
  -- user with an active membership is not membership-less.
  IF v_before <> v_after THEN
    SELECT "orgId" INTO v_org FROM "Project" WHERE "id" = v_project;
    IF v_org IS NOT NULL
       AND EXISTS (SELECT 1 FROM "OrgMembership" om
                    WHERE om."orgId" = v_org AND om."userId" = v_user
                      AND om."role" IN ('owner', 'admin'))
       AND NOT (v_after AND NEW."role" = 'pmc') THEN
      PERFORM platform_user_standing_apply(v_project, v_user, 'pmc', NULL, NOT v_after);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_role_standing" ON "Membership";
CREATE TRIGGER "Membership_t4d_role_standing"
  BEFORE INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_role_standing();

-- ── the gated backfills ──────────────────────────────────────────────────────────────────────
-- Every statement here is written so an `ALWAYS_EXECUTE` REPLAY re-runs it and commits: the
-- exclusion of rows that already exist is in the STATEMENT (`WHERE NOT EXISTS` /
-- `ON CONFLICT DO NOTHING`), never in the seal. A project, org membership or account created
-- since the last run is picked up by the replay; one already registered is skipped.
--
-- `SET LOCAL` scopes the gate to this transaction, so nothing outside the migration can write a
-- register directly even in the same session.
DO $$
DECLARE v_backfilled BIGINT; v_blank_names BIGINT; v_blank_sample TEXT; v_sample_org TEXT;
BEGIN
  PERFORM set_config('vitan.phase6_4d_standing_backfill', 'on', true);

  -- the project → org mapping
  INSERT INTO "ProjectOrg" ("projectId", "orgId")
  SELECT p."id", p."orgId" FROM "Project" p
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectOrg" r WHERE r."projectId" = p."id")
  ON CONFLICT ("projectId") DO NOTHING;

  -- one `architect` row per project, at ZERO. The audit above proves the count is zero: no
  -- `Membership` row spells the role, and none can be written while the reservation stands.
  INSERT INTO "ProjectRoleStanding" ("projectId", "role", "activeCount", "changedAt")
  SELECT p."id", 'architect', 0, CURRENT_TIMESTAMP FROM "Project" p
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectRoleStanding" r
                      WHERE r."projectId" = p."id" AND r."role" = 'architect')
  ON CONFLICT ("projectId", "role") DO NOTHING;

  -- every account's display name. AND THE REGISTER IS COMPLETE OR THE MIGRATION ABORTS
  -- (#582's review round 3, finding 2). The whitespace filter existed because `UserIdentity`
  -- carries a non-blank CHECK, and it silently DROPPED any account whose `User.name` is
  -- whitespace-only — `User.name` has no such constraint today, and `ensure-accounts.ts` casts
  -- `ACCOUNTS_JSON` without validating names. The migration then reported success with that
  -- account missing from the register, and the damage lands much later and somewhere else: from
  -- 4d-ii, `phase6_t4d_actor_bound` resolves the frozen name through this register, so that
  -- user's otherwise-authorized forward, countersign or membership command is refused for a
  -- reason no message names. A register whose completeness the seals depend on is not a
  -- best-effort projection, so the unprojectable rows are DIAGNOSED and the apply refuses.
  SELECT count(*), string_agg(u."id", ', ' ORDER BY u."id")
    INTO v_blank_names, v_blank_sample
    FROM "User" u
   WHERE btrim(COALESCE(u."name", ''), E' \t\n\x0B\f\r') = ''
     AND NOT EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id");
  IF v_blank_names > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i ABORT: % account(s) carry a blank or whitespace-only "User"."name" and cannot be projected into "UserIdentity", whose displayName is non-blank by CHECK. Every 4d fact resolves its frozen actor name through that register, so committing without these rows would refuse those users'' commands from 4d-ii with no message naming the cause. Give each account a real display name and re-run: UPDATE "User" SET "name" = ''<real name>'' WHERE "id" = ''<id>''. Ids: %',
      v_blank_names, v_blank_sample;
  END IF;

  INSERT INTO "UserIdentity" ("userId", "displayName")
  SELECT u."id", u."name" FROM "User" u
   WHERE NOT EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id")
  ON CONFLICT ("userId") DO NOTHING;

  -- team-management authority, per org membership in an authoritative role
  INSERT INTO "OrgUserAuthority" ("orgId", "userId", "role")
  SELECT om."orgId", om."userId", om."role" FROM "OrgMembership" om
   WHERE om."role" IN ('owner', 'admin')
     AND NOT EXISTS (SELECT 1 FROM "OrgUserAuthority" a
                      WHERE a."orgId" = om."orgId" AND a."userId" = om."userId")
  ON CONFLICT ("orgId", "userId") DO NOTHING;

  -- per-user standing, membership-granted
  INSERT INTO "ProjectUserStanding" ("projectId", "userId", "role", "membershipId")
  SELECT m."projectId", m."userId", m."role", m."id" FROM "Membership" m
   WHERE m."status" = 'active'
     AND NOT EXISTS (SELECT 1 FROM "ProjectUserStanding" s
                      WHERE s."projectId" = m."projectId" AND s."userId" = m."userId"
                        AND s."role" = m."role")
  ON CONFLICT ("projectId", "userId", "role") DO NOTHING;

  -- per-user standing, the membership-less `pmc` arm: an org owner/admin with NO active
  -- membership on the project.
  INSERT INTO "ProjectUserStanding" ("projectId", "userId", "role", "membershipId")
  SELECT p."id", om."userId", 'pmc', NULL
    FROM "Project" p
    JOIN "OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
   WHERE NOT EXISTS (SELECT 1 FROM "Membership" m
                      WHERE m."projectId" = p."id" AND m."userId" = om."userId"
                        AND m."status" = 'active')
     AND NOT EXISTS (SELECT 1 FROM "ProjectUserStanding" s
                      WHERE s."projectId" = p."id" AND s."userId" = om."userId"
                        AND s."role" = 'pmc')
  ON CONFLICT ("projectId", "userId", "role") DO NOTHING;

  PERFORM set_config('vitan.phase6_4d_standing_backfill', 'off', true);

  -- The register the whole chain reads must agree with the orgs truth the moment this
  -- transaction commits, so the agreement is ASSERTED here rather than left to
  -- `platform:verify` to discover later.
  SELECT count(*) INTO v_backfilled FROM "Project" p
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectOrg" r WHERE r."projectId" = p."id");
  IF v_backfilled > 0 THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: % project(s) hold no "ProjectOrg" row after the backfill — the project→org mapping every tenancy join depends on is incomplete; refusing to commit.', v_backfilled;
  END IF;

  -- AND THE ROW MUST SAY THE RIGHT THING (#582's review round 7, finding 2). The audit above
  -- proves a row EXISTS and nothing about what it holds, which is the whole question on the one
  -- path where this table can be older than its seals: a `prisma db push` / P3005 baseline has
  -- the modelled table without the writer-depth and freeze triggers, so a row put there by any
  -- means survives. The backfill's `WHERE NOT EXISTS` is keyed on the PROJECT, so it preserves
  -- such a row rather than correcting it, this audit passed it, and the freeze installed below
  -- then makes it PERMANENT. A project mapped to the wrong org is not a cosmetic drift:
  -- `platform_user_orchestration_authority` joins through this register, so every owner and
  -- admin of the named org gains team-management authority over a project that is not theirs —
  -- the exact tenancy boundary this register exists to state.
  --
  -- Repairing it here would be worse than aborting: the mapping is the tenancy fact, and a
  -- migration that silently re-points a project to a different org is doing the thing the seal
  -- forbids every other writer from doing. The operator is told which projects disagree.
  SELECT count(*) INTO v_backfilled FROM "Project" p
    JOIN "ProjectOrg" r ON r."projectId" = p."id"
   WHERE r."orgId" IS DISTINCT FROM p."orgId";
  IF v_backfilled > 0 THEN
    SELECT string_agg(format('%s→%s (Project says %s)', r."projectId", r."orgId", p."orgId"), ', ')
      INTO v_sample_org
      FROM "Project" p JOIN "ProjectOrg" r ON r."projectId" = p."id"
     WHERE r."orgId" IS DISTINCT FROM p."orgId";
    RAISE EXCEPTION
      'phase6 4d-i ABORT: % "ProjectOrg" row(s) name an org their "Project" does not — %. The register is about to be FROZEN, and a mismatched mapping grants that org''s owners and admins team-management authority over a project that is not theirs. Correct the register (or the Project) before this migration adopts it; this file will not re-point a tenancy mapping on its own.',
      v_backfilled, v_sample_org;
  END IF;
  SELECT count(*) INTO v_backfilled FROM "Project" p
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectRoleStanding" r
                      WHERE r."projectId" = p."id" AND r."role" = 'architect');
  IF v_backfilled > 0 THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: % project(s) hold no zero-count `architect` standing row after the backfill; refusing to commit.', v_backfilled;
  END IF;
  -- THE ZERO-COUNT AUDIT IS PRE-RETIREMENT ONLY (#582 round 6, finding 1). Its premise is the
  -- RESERVATION: while the doors stand no architect membership can exist, so every counted row
  -- must read zero and a non-zero one is evidence the reservation leaked. After 4d-iii retires
  -- the doors that premise is simply false — an architect is a legitimate, ordinary thing for a
  -- project to have — and an `ALWAYS_EXECUTE` replay over such a database would abort on the
  -- healthiest state the system can be in, which is precisely what P28's marker-aware replay
  -- forbids. Every transient block above is already gated this way; this one was missed because
  -- it lives in the BACKFILL rather than among the doors, and the backfill runs on both paths.
  --
  -- The seeding above stays unconditional: `WHERE NOT EXISTS` makes it a no-op for rows that are
  -- already there, so a mature database keeps its counts and gains any register row a project
  -- created since the last run still lacks.
  IF NOT phase6_t4d_retired_at_start() THEN
    SELECT count(*) INTO v_backfilled FROM "ProjectRoleStanding"
     WHERE "role" = 'architect' AND "activeCount" <> 0;
    IF v_backfilled > 0 THEN
      RAISE EXCEPTION 'phase6 4d-i ABORT: % `architect` standing row(s) are non-zero while the reservation still stands, which the doors and the audit make impossible; refusing to commit.', v_backfilled;
    END IF;
  ELSE
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — the zero-count architect audit is SKIPPED (an active architect is legitimate after retirement; this is a replay over a retired database)';
  END IF;
END $$;

-- ── the two kernel TRANSACTION reads ─────────────────────────────────────────────────────────
-- §A.3 obligation 7 asks a fact's seal "is the effect this act owes present in THIS transaction?"
-- Every such seal asks it the same way, so it is asked ONCE here. Platform-owned, because the
-- effect tables are the kernel's; a decisions seal calling these reads no peer table.
--
-- THE WORD THAT DOES THE WORK IS "TRANSACTION" (Codex round 1, findings 2, 8 and 9 — one root
-- cause). The first version of these functions carried no transaction predicate at all, and
-- neither did the seals, which asked their own inline `EXISTS` instead of calling here. An
-- unscoped existence check is satisfied by HISTORY: once a decision has ever been approved, its
-- old `decision.approved` event answers every later `approved` audit row, so a direct writer can
-- append fabricated evidence that the append-only seal then makes permanent. Worse, the seals'
-- own error messages already said "in this transaction" — the sentence was right and the query
-- underneath it was not.
--
-- `xmin` is the transaction that inserted the row; `txid_current()::text::xid` truncates the
-- 64-bit counter to the 32-bit xid the row carries. It is the SAME comparison
-- `20270425000000_platform_command_receipt_seal` uses to bind a completion to the transaction
-- that reserved it, and the plan names that migration as the precedent.
--
-- These are the VERIFICATION side of the pairing, not the claiming side: a bundle's non-primary
-- facts check through these and never write a claim (§A.3 — one claimant per event branch).
CREATE OR REPLACE FUNCTION platform_tx_event(
  p_project TEXT, p_entity_type TEXT, p_entity TEXT, p_types TEXT[]
) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT e."eventId" FROM "DomainEvent" e
   WHERE e."projectId" = p_project
     AND e."entityType" = p_entity_type AND e."entityId" = p_entity
     AND e."eventType" = ANY (p_types)
     AND e."xmin" = txid_current()::text::xid
   ORDER BY e."streamPosition" DESC
   LIMIT 1;
$$;

-- How MANY same-transaction events match. The exactness claims (§A.3's "exactly ONE") need a
-- count, not an existence: two events for one act are as wrong as none.
CREATE OR REPLACE FUNCTION platform_tx_event_count(
  p_project TEXT, p_entity_type TEXT, p_entity TEXT, p_types TEXT[]
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM "DomainEvent" e
   WHERE e."projectId" = p_project
     AND e."entityType" = p_entity_type AND e."entityId" = p_entity
     AND e."eventType" = ANY (p_types)
     AND e."xmin" = txid_current()::text::xid;
$$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3a — THE THREE DECISIONS-OWNED FACT TABLES (shape)
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Each lives under the uniform seal contract of §A.3, whose seven obligations are installed in
-- the seal slice below. This slice is SHAPE ONLY — tables, keys, references and the CHECKs that
-- are properties of a row rather than of a transition — so the probes fail on BEHAVIOUR and
-- never on a missing symbol (the 4c-i convention).
--
-- WHY THE DESIGNATION AND ROLE COLUMNS ARE `TEXT` AND NOT THE ENUM: `DeciderKind` gained
-- `architect` in Part 2 of THIS transaction, and a value added by `ALTER TYPE … ADD VALUE` is
-- unusable until it commits. A column typed `"DeciderKind"` could be declared, but any CHECK,
-- DEFAULT or comparison naming `'architect'` in this file would abort. TEXT with a CHECK over
-- the vocabulary keeps the whole file judgeable in one transaction and matches the discipline
-- Parts 1 and 3 already use, where every comparison against the reserved values is made on
-- `::text`. The seals below compare these columns to `Decision."deciderKind"::text`.

-- The provenance and same-project FK targets these facts need. Both are ADDITIVE and VACUOUSLY
-- SATISFIABLE — `id` is already unique on its own, so neither index can reject an existing or a
-- future row, and no writer changes (the argument 4c-i used for
-- `DecisionOption_decision_option_key`).
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionApprovalRevision_project_revision_key"
  ON "DecisionApprovalRevision"("projectId", "id");

CREATE TABLE IF NOT EXISTS "DecisionForward" (
    "id"                          TEXT NOT NULL,
    "projectId"                   TEXT NOT NULL,
    "decisionId"                  TEXT NOT NULL,
    -- the DISPLACED holder, kind + membership, exactly as the decision carried it
    "fromDesignationKind"         TEXT NOT NULL,
    "fromDesignationMembershipId" TEXT,
    -- the NEW holder
    "toDesignationKind"           TEXT NOT NULL,
    "toDesignationMembershipId"   TEXT,
    -- the ACTOR, who need not be the displaced holder: forward authority includes non-holders,
    -- so a PMC forwarding a client-held decision is recorded as the PMC displacing the client.
    "forwardedById"               TEXT NOT NULL,
    "forwardedByRole"             TEXT NOT NULL,
    "forwardedByName"             TEXT NOT NULL,
    "reason"                      TEXT NOT NULL,
    "at"                          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"             TEXT NOT NULL,
    CONSTRAINT "DecisionForward_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionCountersign" (
    "id"                    TEXT NOT NULL,
    "projectId"             TEXT NOT NULL,
    "decisionId"            TEXT NOT NULL,
    -- the EXACT revision countersigned. Not "the decision's head at some later moment": the
    -- fact records which provisional approval this act finalized, and the one-per-revision key
    -- below is what makes a decision re-stranded on a LATER revision resolvable again while the
    -- same revision can never be finalized twice.
    "revisionId"            TEXT NOT NULL,
    "countersignedById"     TEXT NOT NULL,
    "countersignedByRole"   TEXT NOT NULL,
    "countersignedByName"   TEXT NOT NULL,
    "at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"       TEXT NOT NULL,
    CONSTRAINT "DecisionCountersign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DecisionStrandedResolution" (
    "id"               TEXT NOT NULL,
    "projectId"        TEXT NOT NULL,
    "decisionId"       TEXT NOT NULL,
    "revisionId"       TEXT NOT NULL,
    "outcome"          TEXT NOT NULL,
    "resolvedById"     TEXT NOT NULL,
    "resolvedByRole"   TEXT NOT NULL,
    "resolvedByName"   TEXT NOT NULL,
    "reason"           TEXT NOT NULL,
    "at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId"  TEXT NOT NULL,
    CONSTRAINT "DecisionStrandedResolution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DecisionForward_projectId_decisionId_idx"
  ON "DecisionForward"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionCountersign_projectId_decisionId_idx"
  ON "DecisionCountersign"("projectId", "decisionId");
CREATE INDEX IF NOT EXISTS "DecisionStrandedResolution_projectId_decisionId_idx"
  ON "DecisionStrandedResolution"("projectId", "decisionId");

-- ONE-USE provenance (§A.3 obligation 6): a receipt backs AT MOST ONE row per table, so a single
-- genuine receipt cannot be replayed to mint a second fact.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionForward_source_command_key"
  ON "DecisionForward"("projectId", "sourceCommandId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionCountersign_source_command_key"
  ON "DecisionCountersign"("projectId", "sourceCommandId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionStrandedResolution_source_command_key"
  ON "DecisionStrandedResolution"("projectId", "sourceCommandId");

-- One finalization per revision, and one disposal per revision. A decision re-stranded on a
-- LATER revision resolves again; the SAME revision never twice.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionCountersign_revision_key"
  ON "DecisionCountersign"("projectId", "decisionId", "revisionId");
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionStrandedResolution_revision_key"
  ON "DecisionStrandedResolution"("projectId", "decisionId", "revisionId");

DO $$
DECLARE
  t TEXT;
  fk TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    -- §A.3 obligation 5: every reference is project-bound through the child's own `projectId`.
    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "decisionId")'
              || ' REFERENCES "Decision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_decisionId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;

    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "sourceCommandId")'
              || ' REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_sourceCommandId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    fk := format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId", "revisionId")'
              || ' REFERENCES "DecisionApprovalRevision"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
                 t, t || '_projectId_revisionId_fkey');
    BEGIN EXECUTE fk; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_forwardedById_fkey"
    FOREIGN KEY ("forwardedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionCountersign" ADD CONSTRAINT "DecisionCountersign_countersignedById_fkey"
    FOREIGN KEY ("countersignedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionStrandedResolution" ADD CONSTRAINT "DecisionStrandedResolution_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_from_membership_fkey"
    FOREIGN KEY ("projectId", "fromDesignationMembershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_to_membership_fkey"
    FOREIGN KEY ("projectId", "toDesignationMembershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the row CHECKs ───────────────────────────────────────────────────────────────────────────
-- NOT NULL and non-blank are TWO obligations, not one: a CHECK over NULL evaluates to UNKNOWN
-- and PASSES, so a `btrim` guard alone would let a direct insert commit append-only evidence
-- with no text at all. The columns are NOT NULL above; these close the whitespace-only door,
-- over the COMPLETE ASCII whitespace set rather than the space character alone.
DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('DecisionForward',            'reason'),
      ('DecisionForward',            'forwardedByRole'),
      ('DecisionForward',            'forwardedByName'),
      ('DecisionCountersign',        'countersignedByRole'),
      ('DecisionCountersign',        'countersignedByName'),
      ('DecisionStrandedResolution', 'reason'),
      ('DecisionStrandedResolution', 'resolvedByRole'),
      ('DecisionStrandedResolution', 'resolvedByName')
    ) AS v(tbl, col)
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (btrim(%I, E'' \t\n\x0B\f\r'') <> '''')',
        spec.tbl, spec.tbl || '_' || spec.col || '_present_check', spec.col);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

-- The DISCRIMINATORS. `member` is the only kind that names a membership, and every other kind
-- names a role — so the kind and the membership column agree or the row is not a designation at
-- all. `none` is the RECORD designation (4b §A.2) and can neither be forwarded from nor to: a
-- record has no decider to displace and no decider to hand it to.
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_from_designation_check"
    CHECK ("fromDesignationKind" IN ('client', 'pmc', 'member', 'architect')
           AND (("fromDesignationKind" = 'member') = ("fromDesignationMembershipId" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_to_designation_check"
    CHECK ("toDesignationKind" IN ('client', 'pmc', 'member', 'architect')
           AND (("toDesignationKind" = 'member') = ("toDesignationMembershipId" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A forward that changes NOTHING is not a forward. The command refuses a same-target hand-off
-- 409 "already the holder", the holder-door arm requires the holder columns to actually change,
-- and this is the same claim made where it cannot be argued around: `from` and `to` DIFFER.
DO $$ BEGIN
  ALTER TABLE "DecisionForward" ADD CONSTRAINT "DecisionForward_designation_moves_check"
    CHECK ("fromDesignationKind" IS DISTINCT FROM "toDesignationKind"
           OR "fromDesignationMembershipId" IS DISTINCT FROM "toDesignationMembershipId");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two explicit attributed outcomes, and nothing else. `completed` finalizes under the
-- no-chain rule; `returned` sends the decision back to its decider with an open
-- `countersign_rejection` request carrying the PMC's reason. Neither touches `pending`.
DO $$ BEGIN
  ALTER TABLE "DecisionStrandedResolution" ADD CONSTRAINT "DecisionStrandedResolution_outcome_check"
    CHECK ("outcome" IN ('completed', 'returned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3a — THE SEVEN OBLIGATIONS, INSTALLED
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- §A.3 states the contract once and every 4b–4d fact carries all seven. What follows installs
-- obligations 1, 3, 4, 5, 6 and the fact-side half of 2 for the three tables above. Obligation
-- 7 (effect correspondence) and the DECISION-side half of 2 need the kernel envelope columns and
-- the widened delivered seals, and are installed with them.
--
-- WHY HERE AND NOT WITH THE CALLER: a DB invariant whose first probe waits for the behaviour
-- unit can be wrong and become immutable history before anything detects it. No invariant this
-- file installs is probed later than the PR that installs it (the 4c-i rule).

-- ── obligation 1: append-only + evidence freeze ──────────────────────────────────────────────
-- These three facts have NO permitted mutations. §A.3 allows "the named close-transitions" as
-- exceptions, and none of the three has one: a forward, a countersign and a stranded resolution
-- are each complete at the instant they are written. So the seal is total — every UPDATE and
-- every DELETE refused, with no column-by-column comparison to get wrong.
CREATE OR REPLACE FUNCTION phase6_t4d_fact_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "%" is an append-only register and its rows are immutable evidence — a % is refused. A forward, a countersign and a stranded resolution are each COMPLETE at the instant they are written; none has a close transition, so there is nothing legitimate to rewrite. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME.',
    TG_TABLE_NAME, TG_OP;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4d_fact_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "%" is an append-only register and is never truncated — a row trigger does not fire for TRUNCATE, so the statement is sealed too. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME.',
    TG_TABLE_NAME;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I'
      || ' FOR EACH ROW EXECUTE FUNCTION phase6_t4d_fact_append_only()',
      t || '_t4d_append_only', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_no_truncate', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I'
      || ' FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_fact_no_truncate()',
      t || '_t4d_no_truncate', t);
  END LOOP;
END $$;

-- ── obligations 3 + 4, the SHARED half ───────────────────────────────────────────────────────
-- Every fact answers the same two questions about its actor and its subject, so they are asked
-- in ONE owned helper rather than re-derived per seal:
--
--   3. ACTOR STANDING — the recorded actor holds ACTIVE standing that authorizes the act, judged
--      at the DB under `phase6_try_readiness`; the frozen `<act>ByRole` is a role THAT actor
--      holds, per user, through the kernel read `platform_user_holds_role` over
--      `ProjectUserStanding`; and the frozen `<act>ByName` equals the account's display name
--      read by `platform_user_display_name` over `UserIdentity`.
--
--      The WINDOW exception of §A.3 is carried inline, not left to a reader: through the drain
--      window a `pmc` claim is judged by the RACE-FREE derivation — an `OrgUserAuthority`
--      owner/admin row for this project's org AND no membership-granted row for that actor on
--      the project — because a membership-less org owner/admin has no fanned-out `pmc` row
--      until 4d-iii re-projects. Judging that claim from the register alone would refuse
--      exactly the actor the delivered `ProjectAccessService` authorizes with a `pmc` token
--      (#572's review round 25, finding 8). The derivation is tenancy-joined through
--      `ProjectOrg`, so an owner of an UNRELATED organisation is refused (#572's review
--      round 14, finding 1).
--
--   4. SUBJECT ELIGIBILITY — the project is operable via `phase6_project_operable`, lock before
--      read, the 4c §A order. The per-fact status predicate is the seal's own, below.
--
-- §B.1 TRY-ACQUIRE-OR-REFUSE: reentrant on the service path (the command already holds the
-- key), acquired and held to commit on a free direct write, REFUSED when contended. A seal
-- never waits inside a trigger, so no lock-order inversion can exist.
CREATE OR REPLACE FUNCTION phase6_t4d_actor_bound(
  p_project TEXT, p_actor TEXT, p_role TEXT, p_name TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_name TEXT;
  v_holds BOOLEAN;
BEGIN
  IF NOT phase6_try_readiness(p_project) THEN
    RAISE EXCEPTION 'phase6 4d-i: the project readiness key is held elsewhere — this direct write of % is refused rather than waiting inside a trigger', p_row;
  END IF;
  IF NOT phase6_project_operable(p_project) THEN
    RAISE EXCEPTION 'phase6 4d-i: project % is archived — no decision fact may be recorded against it (%)', p_project, p_row;
  END IF;

  v_holds := platform_user_holds_role(p_project, p_actor, p_role);

  -- The WINDOW arm, for `pmc` only. Everything else is the register, in the window and after it.
  IF NOT v_holds AND p_role = 'pmc' THEN
    v_holds := platform_user_orchestration_authority(p_project, p_actor)
               AND NOT EXISTS (SELECT 1 FROM "ProjectUserStanding" s
                                WHERE s."projectId" = p_project AND s."userId" = p_actor
                                  AND s."membershipId" IS NOT NULL);
  END IF;

  IF NOT v_holds THEN
    RAISE EXCEPTION
      'phase6 4d-i: % records actor % acting as `%`, a role that actor does not hold on project % — the frozen role is EVIDENCE, and a fact may not attribute an act to a standing its actor never had. (For `pmc`, an org owner/admin with no membership on this project is admitted through the race-free derivation; an owner of another organisation is not.)',
      p_row, p_actor, p_role, p_project;
  END IF;

  -- The frozen NAME comes from the register, read under the same lock discipline the writer
  -- takes (§A.3, #572's review round 11, finding 3): the command resolves the name from
  -- `UserIdentity` INSIDE its own transaction with the identity row locked, so a concurrent
  -- rename either commits first (and the fact freezes the NEW name, true at the act) or waits
  -- behind it (and the fact freezes the old one, equally true at its act). The comparison is
  -- then between two values read under the same lock, never against a pre-transaction read.
  SELECT "displayName" INTO v_name FROM "UserIdentity" WHERE "userId" = p_actor FOR UPDATE;
  IF v_name IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: % attributes an act to user %, who has no "UserIdentity" row — there is no account name for the frozen evidence to be true of', p_row, p_actor;
  END IF;
  IF v_name IS DISTINCT FROM p_name THEN
    RAISE EXCEPTION
      'phase6 4d-i: % freezes the name %, but user %''s account name is % — the frozen pair is evidence of WHO acted, and a supplied name that is not the account''s is refused at the fact',
      p_row, p_name, p_actor, v_name;
  END IF;
END $$;

-- ── the FORWARD INSERT seal ──────────────────────────────────────────────────────────────────
-- Status-gated AND PUBLICATION-gated (#572's review round 21, finding 2). Status alone is not
-- the question: an unpublished DRAFT also carries `status = 'pending'` — `decisions.service.ts`
-- creates it that way and stamps `publishedAt` only on publication — and a draft is its
-- author's private workspace, hidden by `decisionVisibleToViewer`. Forwarding one would hand
-- someone an action item that renders as nothing, while every effect still committed. The
-- delivered code draws this line one command over (`assertConsultationEligible` refuses when
-- `publishedAt IS NULL`); the forward door is the sibling that did not.
--
-- `awaiting_countersign` is EXCLUDED from the generic command — that status is the ARCHITECT's
-- action item — and admitted by the DOOR only when the transaction also carries the
-- `countersign_rejection` request, which is the disagreement's forward-on. That arm is judged
-- at COMMIT by the pairing seal below, because the request may be written after the forward.
CREATE OR REPLACE FUNCTION phase6_t4d_forward_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  d RECORD;
  v_holder_user TEXT;
BEGIN
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."forwardedById", NEW."forwardedByRole",
                                 NEW."forwardedByName", 'DecisionForward ' || NEW."id");

  -- AUTHORITY, which `phase6_t4d_actor_bound` does not supply (Codex round 1, finding 14).
  -- That helper proves the actor TRULY holds the role and name they wrote down — it is an
  -- honesty check, not a permission one, and every project member passes it about themselves.
  -- The policy is the owner's settled 2026-08-13 amendment, carried into this plan at line
  -- 1930: FORWARD AUTHORITY = the current HOLDER + PMC + architect (once one exists). Without
  -- this arm an active engineer or contractor could write a truthful fact, hand a client-held
  -- decision to an active target, and pass every other check in this trigger.
  --
  -- The HOLDER arm reads the DISPLACED designation, which the field-for-field comparison below
  -- ties to the decision's actual holder: a named membership resolves to its ACTIVE user, a role
  -- designation to anyone holding that role. (`none` is not representable here — the designation
  -- CHECK admits `client`, `pmc`, `member` and `architect` only — so every forward displaces a
  -- designation somebody can hold.)
  IF NEW."fromDesignationKind" = 'member' THEN
    v_holder_user := platform_membership_active_user(NEW."projectId", NEW."fromDesignationMembershipId");
  END IF;
  IF NOT (
       (v_holder_user IS NOT NULL AND v_holder_user = NEW."forwardedById")
    OR (NEW."fromDesignationKind" <> 'member'
        AND platform_user_holds_role(NEW."projectId", NEW."forwardedById", NEW."fromDesignationKind"))
    OR platform_user_holds_role(NEW."projectId", NEW."forwardedById", 'pmc')
    OR platform_user_holds_role(NEW."projectId", NEW."forwardedById", 'architect')
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % hands decision % on, but user % is neither its current holder (%/%) nor a `pmc` nor an active `architect` on project % — forwarding is an AUTHORIZED act, and holding the role you truthfully named is not the same as being allowed to perform it',
      NEW."id", NEW."decisionId", NEW."forwardedById", NEW."fromDesignationKind",
      COALESCE(NEW."fromDesignationMembershipId", '<role>'), NEW."projectId";
  END IF;

  SELECT "status"::text AS status, "publishedAt", "deciderKind"::text AS kind, "deciderMembershipId"
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6 4d-i: DecisionForward % names decision %, which does not exist in project %', NEW."id", NEW."decisionId", NEW."projectId";
  END IF;
  IF d."publishedAt" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is an unpublished DRAFT and may not be forwarded — it is its author''s private workspace, hidden from the target by `decisionVisibleToViewer`, so the hand-off would deliver an action item that renders as nothing (DecisionForward %)',
      NEW."decisionId", NEW."id";
  END IF;
  IF d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%` and may not be forwarded — forwarding is legal only in states the NEW holder can act on (DecisionForward %)',
      NEW."decisionId", d.status, NEW."id";
  END IF;

  -- Mere row presence is forgeable: a hostile transaction could insert a forward naming
  -- unrelated designations and re-home the holder to a third member. So the fact is compared to
  -- the decision FIELD-FOR-FIELD — the row it displaces must be the holder the decision
  -- actually carries at this instant.
  IF NEW."fromDesignationKind" IS DISTINCT FROM d.kind
     OR NEW."fromDesignationMembershipId" IS DISTINCT FROM d."deciderMembershipId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % records displacing %/% but decision % is held by %/% — a forward is evidence of the hand-off that actually happened, never of one asserted about it',
      NEW."id", NEW."fromDesignationKind", COALESCE(NEW."fromDesignationMembershipId", '<role>'),
      NEW."decisionId", d.kind, COALESCE(d."deciderMembershipId", '<role>');
  END IF;

  -- The TARGET must be able to act, judged at the DB too. A named-member designation resolves
  -- through `platform_membership_active_user` (the composite FK pins existence and project;
  -- ACTIVE standing is the primitive's read, under the membership row lock); a role designation
  -- must have at least one active holder.
  IF NEW."toDesignationKind" = 'member' THEN
    IF platform_membership_active_user(NEW."projectId", NEW."toDesignationMembershipId") IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionForward % hands decision % to membership %, which holds no ACTIVE standing on this project — the new holder must be able to act',
        NEW."id", NEW."decisionId", NEW."toDesignationMembershipId";
    END IF;
  ELSIF NOT platform_role_has_holder(NEW."projectId", NEW."toDesignationKind") THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % hands decision % to the `%` role, which has no active holder on this project — the decision would land with nobody able to act on it',
      NEW."id", NEW."decisionId", NEW."toDesignationKind";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionForward_t4d_seal" ON "DecisionForward";
CREATE TRIGGER "DecisionForward_t4d_seal" BEFORE INSERT ON "DecisionForward"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_seal();

-- ── the finalizer's subject: the PROVISIONAL HEAD, not merely "a revision of this decision" ──
-- Codex round 1, finding 15. A finalizer names WHICH provisional approval it finalizes, and
-- `revisionId` is writer-chosen, so "belongs to this decision" is not the question — a decision
-- reopened after an earlier approval carries an OLDER FINALIZED revision beside its new
-- provisional one. A countersign citing the old row passes a belongs-to check, drives the
-- decision to `approved`, and satisfies the deferred flip pairing because that row is already
-- `finalized` and never flips — leaving the ACTUAL provisional head unfinalized forever, with a
-- final-looking decision resting on a finalization of something else.
--
-- The head is the highest `version` for the decision, and it must still be PROVISIONAL: the
-- revision the awaiting transition produced. Both finalizers ask this — the countersign and the
-- `completed` stranded resolution alike — because both end the same provisional approval.
CREATE OR REPLACE FUNCTION phase6_t4d_provisional_head(
  p_project TEXT, p_decision TEXT, p_revision TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_head TEXT; v_head_version INTEGER;
BEGIN
  SELECT "decisionId", "finalized", "version" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = p_project AND "id" = p_revision FOR UPDATE;
  IF NOT FOUND OR r."decisionId" <> p_decision THEN
    RAISE EXCEPTION
      'phase6 4d-i: % names revision %, which is not a revision of decision % — the fact records WHICH provisional approval it finalized',
      p_row, p_revision, p_decision;
  END IF;

  SELECT "id", "version" INTO v_head, v_head_version FROM "DecisionApprovalRevision"
   WHERE "projectId" = p_project AND "decisionId" = p_decision
   ORDER BY "version" DESC LIMIT 1;
  IF v_head IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION
      'phase6 4d-i: % finalizes revision % (version %), but decision %''s current revision is % (version %) — a finalizer ends the approval that is OPEN, and citing a superseded one would leave the live provisional approval unfinalized behind a decision that reads as final',
      p_row, p_revision, r."version", p_decision, v_head, v_head_version;
  END IF;
  IF r."finalized" THEN
    RAISE EXCEPTION
      'phase6 4d-i: % finalizes revision %, which is ALREADY final — there is no provisional approval left for it to end',
      p_row, p_revision;
  END IF;
END $$;

-- ── the COUNTERSIGN INSERT seal ──────────────────────────────────────────────────────────────
-- The countersigner must BE an architect, and the subject must be exactly `awaiting_countersign`
-- — the only state a countersign is legal in.
CREATE OR REPLACE FUNCTION phase6_t4d_countersign_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  IF NEW."countersignedByRole" <> 'architect' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % freezes the role `%` — a countersign is the ARCHITECT''s act and no other role performs it',
      NEW."id", NEW."countersignedByRole";
  END IF;
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."countersignedById", 'architect',
                                 NEW."countersignedByName", 'DecisionCountersign ' || NEW."id");

  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND OR d.status <> 'awaiting_countersign' THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%`, not `awaiting_countersign` — there is no provisional approval for DecisionCountersign % to finalize',
      NEW."decisionId", COALESCE(d.status, '<missing>'), NEW."id";
  END IF;

  PERFORM phase6_t4d_provisional_head(NEW."projectId", NEW."decisionId", NEW."revisionId",
                                      'DecisionCountersign ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_seal" ON "DecisionCountersign";
CREATE TRIGGER "DecisionCountersign_t4d_seal" BEFORE INSERT ON "DecisionCountersign"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_seal();

-- ── the STRANDED RESOLUTION INSERT seal ──────────────────────────────────────────────────────
-- Legal ONLY while the decision is `awaiting_countersign` AND no active architect exists. Both
-- are re-judged here, under the decision row lock and the readiness key the helper takes, so the
-- architect-reappears race is closed at the DB and not only at the command's CAS.
CREATE OR REPLACE FUNCTION phase6_t4d_stranded_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  IF NEW."resolvedByRole" <> 'pmc' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionStrandedResolution % freezes the role `%` — resolving a stranded decision is the PMC''s named act and no other role performs it',
      NEW."id", NEW."resolvedByRole";
  END IF;
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."resolvedById", 'pmc',
                                 NEW."resolvedByName", 'DecisionStrandedResolution ' || NEW."id");

  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR UPDATE;
  IF NOT FOUND OR d.status <> 'awaiting_countersign' THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % is `%`, not `awaiting_countersign` — it is not stranded, so DecisionStrandedResolution % has nothing to resolve',
      NEW."decisionId", COALESCE(d.status, '<missing>'), NEW."id";
  END IF;

  -- The whole premise of the command: an architect who could countersign makes this act
  -- illegal. Judged from the counted register under the readiness key already held.
  IF platform_role_standing(NEW."projectId", 'architect') > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: project % still holds an ACTIVE architect, so decision % is not stranded — the countersign is the legal path and DecisionStrandedResolution % is refused',
      NEW."projectId", NEW."decisionId", NEW."id";
  END IF;

  -- the same subject rule as the countersign, on BOTH outcomes: `completed` ends the open
  -- provisional approval and `returned` sends it back, and neither is an act about a superseded
  -- or already-final revision (Codex round 1, finding 15's second half).
  PERFORM phase6_t4d_provisional_head(NEW."projectId", NEW."decisionId", NEW."revisionId",
                                      'DecisionStrandedResolution ' || NEW."id");
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_seal" ON "DecisionStrandedResolution";
CREATE TRIGGER "DecisionStrandedResolution_t4d_seal" BEFORE INSERT ON "DecisionStrandedResolution"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_seal();

-- ── obligation 6: BUNDLE-AWARE command provenance ────────────────────────────────────────────
-- The delivered `phase6_t4c_provenance_bound` requires the receipt's `resultRef` to name the ROW
-- ITSELF. A command that writes ONE fact satisfies that; a command that writes a BUNDLE cannot.
-- Two bundles exist (§A.3, obligation 6):
--
--   * `decisions.disagree` — the forward-on writes a `countersign_rejection` REQUEST and a
--     `DecisionForward`; the reject-back writes the request alone. The REQUEST is the primary.
--   * `decisions.resolveStrandedCountersign` — the `returned` outcome writes a RESOLUTION, a
--     request, and (when the installed designation has no active holder) a `DecisionForward`
--     re-homing it. The RESOLUTION is the primary.
--
-- So the 4d-owned check accepts a `resultRef` naming the row ITSELF **or** the bundle's PRIMARY
-- fact, when the same transaction pairs them and BOTH cite the SAME receipt. The per-table
-- one-use UNIQUE still holds, so the widening cannot be used to mint two facts from one receipt
-- in the same table.
--
-- DEFERRED, like its 4c sibling: the receipt is `reserved` while the command runs and only
-- becomes `succeeded` when it completes, so an immediate check would judge a receipt that has
-- not finished yet.
--
-- THE RECEIPT IS IDENTIFIED BEFORE IT IS MATCHED (Codex round 1, finding 12 — a hole in the
-- CONTRACT's rule, not an abbreviation of it, so §A.3 obligation 6 gains this paragraph with
-- the code). `status` and `resultRef` alone do not say WHICH command the receipt belongs to,
-- and `resultRef = NEW."id"` is an equality over a writer-CHOSEN column: give a forged
-- `DecisionForward` the id of an existing decision and cite that decision''s `decisions.create`
-- receipt, and the identity arm accepts it as forward provenance. Nor does either column say
-- who acted — a fact could name one actor while its receipt recorded another, and the frozen
-- attribution pair would be truthful about a person who did nothing.
--
-- So the receipt must be the RIGHT KIND of command, run by the SAME actor:
--
--   · `DecisionForward` — `decisions.forward`, or the two BUNDLES that also write one:
--     `decisions.disagree`''s forward-on and `decisions.resolveStrandedCountersign`''s
--     departed-holder re-homing;
--   · `DecisionCountersign` — `decisions.countersign`;
--   · `DecisionStrandedResolution` — `decisions.resolveStrandedCountersign`.
--
-- These are the four ledgered commands the plan derives from the §A.3 fact table (lines
-- 4325-4336), and naming them here means a 4d-ii command that spells its type differently is
-- REFUSED rather than silently admitted — which is the coupling this seal is for. A table
-- added to the loop below without an entry here is refused outright: the map fails CLOSED,
-- because a fact whose expected command kind nobody stated is a fact nothing is checking.
CREATE OR REPLACE FUNCTION phase6_t4d_provenance_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  v_primary_ok BOOLEAN := FALSE;
  v_types TEXT[];
  v_actor_column TEXT;
  v_actor TEXT;
BEGIN
  v_types := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN
      ARRAY['decisions.forward', 'decisions.disagree', 'decisions.resolveStrandedCountersign']
    WHEN 'DecisionCountersign' THEN ARRAY['decisions.countersign']
    WHEN 'DecisionStrandedResolution' THEN ARRAY['decisions.resolveStrandedCountersign']
    ELSE NULL
  END;
  v_actor_column := CASE TG_TABLE_NAME
    WHEN 'DecisionForward' THEN 'forwardedById'
    WHEN 'DecisionCountersign' THEN 'countersignedById'
    WHEN 'DecisionStrandedResolution' THEN 'resolvedById'
    ELSE NULL
  END;
  IF v_types IS NULL OR v_actor_column IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% is bound by phase6_t4d_provenance_bound, but no command kind or actor column is declared for table % — a fact whose expected provenance nobody stated is a fact nothing is checking',
      TG_TABLE_NAME, NEW."id", TG_TABLE_NAME;
  END IF;
  v_actor := to_jsonb(NEW) ->> v_actor_column;

  -- THE RECEIPT IS THIS TRANSACTION'S (#582 round 4, finding 3). Round 3's finding 3 corrected
  -- exactly this shape on `phase6_t4d_membership_transition_bound` — a message that has said "in
  -- this transaction" since round 1 over a query with no transaction predicate — and the commit
  -- that carried it reasoned that the DECISION facts were safe because their commands are new.
  -- They are not: `decisions.forward`, `decisions.disagree`, `decisions.countersign` and
  -- `decisions.resolveStrandedCountersign` are all DELIVERED and ledgered today, so a mature
  -- database holds succeeded receipts for every one of them that no 4d fact has ever cited. A
  -- later direct transaction can write a forward, countersign or resolution citing one of those
  -- HISTORICAL receipts and satisfy every other clause here truthfully — right command kind, right
  -- actor, right result — presenting a new act as an old command's. `xmin` closes it, and it is
  -- read under an alias no other predicate in this body uses so the contract register can witness
  -- THIS clause rather than some other use of `txid_current`.
  SELECT "status", "resultRef", "commandType", "actorId",
         "xmin" = txid_current()::text::xid AS "receiptThisTx"
    INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the row',
      TG_TABLE_NAME, NEW."id";
  END IF;
  IF NOT COALESCE(c."receiptThisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites receipt %, which was completed by an EARLIER transaction — the fact and its receipt are one act seen twice, and a receipt lying around from a past forward, countersign or resolution cannot back an act performed now',
      TG_TABLE_NAME, NEW."id", NEW."sourceCommandId";
  END IF;

  IF NOT (c."commandType" = ANY (v_types)) THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a `%` receipt, which is not a command that writes this fact (expected one of %) — provenance names the act, and a receipt borrowed from an unrelated command proves nothing about this one',
      TG_TABLE_NAME, NEW."id", c."commandType", array_to_string(v_types, ', ');
  END IF;

  IF c."actorId" IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% attributes the act to %, but its receipt was run by % — the fact and the receipt are one act seen twice, and a truthful attribution pair naming someone who ran no command is exactly the forgery the frozen pair exists to prevent',
      TG_TABLE_NAME, NEW."id", COALESCE(v_actor, '<null>'), COALESCE(c."actorId", '<null>');
  END IF;

  IF c."resultRef" = NEW."id" THEN RETURN NULL; END IF;

  -- The bundle arm. The primary is looked up by the SHARED receipt, which is what makes this a
  -- bundle rather than two unrelated rows: a row citing a receipt whose result names some other
  -- command's fact finds nothing here and is refused.
  SELECT EXISTS (
    SELECT 1 FROM "ChangeRequest" cr
     WHERE cr."projectId" = NEW."projectId" AND cr."id" = c."resultRef"
       AND cr."sourceCommandId" = NEW."sourceCommandId"
       AND cr."decisionId" = NEW."decisionId"
  ) OR EXISTS (
    SELECT 1 FROM "DecisionStrandedResolution" sr
     WHERE sr."projectId" = NEW."projectId" AND sr."id" = c."resultRef"
       AND sr."sourceCommandId" = NEW."sourceCommandId"
       AND sr."decisionId" = NEW."decisionId"
  ) INTO v_primary_ok;

  IF NOT v_primary_ok THEN
    RAISE EXCEPTION
      'phase6 4d-i: the receipt cited by %.% names result %, which is neither this row nor a PRIMARY fact of its bundle citing the same receipt for the same decision — a receipt for another result cannot be borrowed',
      TG_TABLE_NAME, NEW."id", COALESCE(c."resultRef", '<null>');
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['DecisionForward', 'DecisionCountersign', 'DecisionStrandedResolution'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_t4d_provenance_bound', t);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I'
      || ' DEFERRABLE INITIALLY DEFERRED'
      || ' FOR EACH ROW EXECUTE FUNCTION phase6_t4d_provenance_bound()',
      t || '_t4d_provenance_bound', t);
  END LOOP;
END $$;

-- ── obligation 2: the FACT side of the pairing, in both directions ───────────────────────────
-- A fact and its transition commit together or neither does. The DECISION side of each pairing
-- is installed with the widened delivered seals; this is the FACT side — an orphan row would
-- fabricate immutable evidence for a transition that never happened.
--
-- DEFERRED, because within one transaction the fact may be written before or after the
-- transition it records, and a seal that demanded one order would reject valid bundles.

CREATE OR REPLACE FUNCTION phase6_t4d_forward_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  SELECT "status"::text AS status, "deciderKind"::text AS kind, "deciderMembershipId"
    INTO d FROM "Decision" WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF d.kind IS DISTINCT FROM NEW."toDesignationKind"
     OR d."deciderMembershipId" IS DISTINCT FROM NEW."toDesignationMembershipId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward % records handing decision % to %/%, but at commit the decision is held by %/% — the row is ORPHAN evidence of a hand-off that did not happen',
      NEW."id", NEW."decisionId", NEW."toDesignationKind",
      COALESCE(NEW."toDesignationMembershipId", '<role>'),
      COALESCE(d.kind, '<missing>'), COALESCE(d."deciderMembershipId", '<role>');
  END IF;

  -- The disagreement's FORWARD-ON: a forward out of `awaiting_countersign` is legal only inside
  -- the bundle that also opens the `countersign_rejection` request. Judged here rather than at
  -- INSERT because the request may be written after the forward.
  IF d.status = 'change' AND NOT EXISTS (
       SELECT 1 FROM "ChangeRequest" cr
        WHERE cr."projectId" = NEW."projectId" AND cr."decisionId" = NEW."decisionId"
          AND cr."status" = 'open' AND cr."origin" = 'countersign_rejection'
     ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: decision % ended this transaction in `change` with DecisionForward % and no open `countersign_rejection` request — the forward-on is a BUNDLE, and the transition without its request leaves a decision whose reason no reader can see and which neither approve nor withdrawChange can close',
      NEW."decisionId", NEW."id";
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4d_countersign_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD;
BEGIN
  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";
  SELECT "finalized" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId";

  -- Row, flip and status are ONE transaction or none. Both the orphan row and the split
  -- two-transaction replay are refused here (P31).
  IF d.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % finalizes decision %, but at commit the decision is `%` rather than `approved` — the fact, the finality flip and the status transition commit together or not at all',
      NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
  END IF;
  IF r."finalized" IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % names revision %, which is not finalized at commit — a countersign that does not flip the revision it countersigns is evidence of nothing',
      NEW."id", NEW."revisionId";
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4d_stranded_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD;
BEGIN
  SELECT "status"::text AS status INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId";

  IF NEW."outcome" = 'completed' THEN
    SELECT "finalized" INTO r FROM "DecisionApprovalRevision"
     WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId";
    IF d.status IS DISTINCT FROM 'approved' OR r."finalized" IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % resolves decision % as `completed`, which owes BOTH the finality flip on revision % and the `awaiting_countersign → approved` transition — at commit the decision is `%` and the revision finalized=%',
        NEW."id", NEW."decisionId", NEW."revisionId",
        COALESCE(d.status, '<missing>'), COALESCE(r."finalized"::text, '<missing>');
    END IF;
  ELSE
    -- `returned`. The transition ALONE is not enough: without the request the decision lands in
    -- `change` with a reason no reader can see, and neither `approve` nor `withdrawChange` can
    -- close it, both requiring exactly one open request.
    IF d.status IS DISTINCT FROM 'change' THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % returns decision % to its decider, but at commit the decision is `%` rather than `change`',
        NEW."id", NEW."decisionId", COALESCE(d.status, '<missing>');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ChangeRequest" cr
                    WHERE cr."projectId" = NEW."projectId" AND cr."decisionId" = NEW."decisionId"
                      AND cr."status" = 'open' AND cr."origin" = 'countersign_rejection') THEN
      RAISE EXCEPTION
        'phase6 4d-i: DecisionStrandedResolution % returns decision % with no open `countersign_rejection` request in the same transaction — the bundle is the resolution AND the request, and the transition alone commits a decision nothing can close',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionForward_t4d_paired" ON "DecisionForward";
CREATE CONSTRAINT TRIGGER "DecisionForward_t4d_paired"
  AFTER INSERT ON "DecisionForward" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_forward_paired();
DROP TRIGGER IF EXISTS "DecisionCountersign_t4d_paired" ON "DecisionCountersign";
CREATE CONSTRAINT TRIGGER "DecisionCountersign_t4d_paired"
  AFTER INSERT ON "DecisionCountersign" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_countersign_paired();
DROP TRIGGER IF EXISTS "DecisionStrandedResolution_t4d_paired" ON "DecisionStrandedResolution";
CREATE CONSTRAINT TRIGGER "DecisionStrandedResolution_t4d_paired"
  AFTER INSERT ON "DecisionStrandedResolution" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_stranded_paired();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3e (partial) — THE EXISTING-TABLE COLUMNS THE FACT SEALS ABOVE READ
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Placed here, before the rest of Part 3, because the pairing and provenance seals just
-- installed read `ChangeRequest."origin"`, `ChangeRequest."sourceCommandId"` and
-- `DecisionApprovalRevision."finalized"`. Everything is one transaction, so a later position
-- would still be correct at COMMIT — but a file whose seals name columns declared 400 lines
-- further down is not reviewable, and "reviewable in one pass" is the reason the repository
-- writes SHAPE before SEAL at all.

-- ── ChangeRequest gains a project ────────────────────────────────────────────────────────────
-- The table carries no `projectId` today, and obligation 5 requires every reference to be
-- project-bound through the child's own column. Three steps, in the only order that keeps the
-- PREVIOUS RELEASE working through the drain:
--
--   1. add it NULLABLE and backfill from each row's decision;
--   2. install a BEFORE INSERT trigger that fills it from the row's decision when the writer
--      omits it — the delivered `requestChange` never names it, and it must keep working;
--   3. only then make it NOT NULL, which is now true of every row past and future.
--
-- A BEFORE INSERT trigger runs before constraint checks, so the NOT NULL never sees the gap.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

UPDATE "ChangeRequest" cr SET "projectId" = d."projectId"
  FROM "Decision" d WHERE d."id" = cr."decisionId" AND cr."projectId" IS NULL;

CREATE OR REPLACE FUNCTION phase6_t4d_change_request_project() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."projectId" IS NULL THEN
    SELECT "projectId" INTO NEW."projectId" FROM "Decision" WHERE "id" = NEW."decisionId";
    IF NEW."projectId" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: ChangeRequest % names decision %, which does not exist — there is no project for the row to belong to',
        NEW."id", NEW."decisionId";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_project" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_project" BEFORE INSERT ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_project();

DO $$
DECLARE v_orphans BIGINT;
BEGIN
  SELECT count(*) INTO v_orphans FROM "ChangeRequest" WHERE "projectId" IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i ABORT: % "ChangeRequest" row(s) name a decision that does not exist, so the backfill cannot give them a project. Refusing to commit rather than dropping the column''s guarantee.',
      v_orphans;
  END IF;
END $$;

ALTER TABLE "ChangeRequest" ALTER COLUMN "projectId" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_decisionId_fkey"
    FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the origin discriminator, and the evidence the two origins owe ───────────────────────────
-- `standard` is the delivered request every existing row is, so it is the DEFAULT and the
-- backfill is the default itself. `countersign_rejection` is 4d's: the architect's disagreement
-- under an ACTIVE chain, or the PMC's stranded return under an INACTIVE one — TWO legal
-- producers, discriminated by the fact each is paired with (§B.6).
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'standard';
-- The exact revision this rejection DISPOSED of, so a rejected head can never be re-entered by
-- a bare status flip while a real re-approval appends a fresh head that passes.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "revisionId" TEXT;
-- The frozen requester pair (§A.3 obligation 3). Nullable for legacy rows and for the previous
-- release's writer during the drain; 4d-ii writes it and 4d-iii requires it.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "requestedByRole" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "requestedByName" TEXT;
-- TWO provenance columns, because the row is written by TWO commands (#572's review round 5,
-- finding 5): the REQUEST that opens it and the CLOSURE that takes it out of `open`.
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "sourceCommandId" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByCommandId" TEXT;
-- The frozen RESOLVER pair, owed by every writer of `resolvedById` (#572's review round 7).
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByRole" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN IF NOT EXISTS "resolvedByName" TEXT;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_origin_check"
    CHECK ("origin" IN ('standard', 'countersign_rejection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A rejection names the revision it disposed of; a standard request has no revision to dispose
-- of and names none. CHECK-pinned in both directions.
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_revision_by_origin_check"
    CHECK (("origin" = 'countersign_rejection') = ("revisionId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_revisionId_fkey"
    FOREIGN KEY ("projectId", "revisionId") REFERENCES "DecisionApprovalRevision"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_projectId_resolvedByCommandId_fkey"
    FOREIGN KEY ("projectId", "resolvedByCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ONE-USE, and PARTIAL because the legacy and drain-window rows carry NULL. Prisma cannot
-- express a predicate on `@@unique`, so these live in SQL only — the shape
-- `DecisionApprovalRevision_source_command_key` already uses.
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeRequest_source_command_key"
  ON "ChangeRequest"("projectId", "sourceCommandId") WHERE "sourceCommandId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ChangeRequest_resolved_command_key"
  ON "ChangeRequest"("projectId", "resolvedByCommandId") WHERE "resolvedByCommandId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ChangeRequest_projectId_decisionId_idx"
  ON "ChangeRequest"("projectId", "decisionId");

-- ── DecisionApprovalRevision gains its finality key and the act it records ───────────────────
-- `finalized` is born TRUE outside a chain — today's behaviour byte-identical, and the reason
-- the DEFAULT is `true` rather than `false`: every existing row IS final, and every approval a
-- still-serving 4b/4c instance performs during the drain is too.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "finalized" BOOLEAN NOT NULL DEFAULT TRUE;
-- The finalizing event is a fact the PROVISIONAL approval RECORDED, not a guess the finalizer
-- makes: the delivered `approve` emits `decision.reapproved` when it acts from `change` and
-- `decision.approved` from `pending`. Under a chain that act is provisional and its finalizer
-- runs later, so the revision carries which one it was.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedFrom" TEXT;
-- The approval-time display name and the role HELD at the act — the register's `approvedById`
-- names an account whose name can change between the provisional approval and its finalization.
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedByName" TEXT;
ALTER TABLE "DecisionApprovalRevision" ADD COLUMN IF NOT EXISTS "approvedByRole" TEXT;

DO $$ BEGIN
  ALTER TABLE "DecisionApprovalRevision" ADD CONSTRAINT "DecisionApprovalRevision_approvedFrom_check"
    CHECK ("approvedFrom" IS NULL OR "approvedFrom" IN ('pending', 'change'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `ChangeRequest` joins the no-TRUNCATE set (§D). A statement trigger fires even on an EMPTY
-- table, and the harness's `TRUNCATE "Decision" … CASCADE` reaches this table — so the seal is
-- met by suites that never opened a request, which is why it is registered in `TRUNCATE_SEALS`
-- in the same unit that installs it.
DROP TRIGGER IF EXISTS "ChangeRequest_t4d_no_truncate" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_no_truncate" BEFORE TRUNCATE ON "ChangeRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_fact_no_truncate();

-- ── the EVIDENCE FREEZE on the columns this unit introduces ──────────────────────────────────
-- §A.3 obligation 1 puts `ChangeRequest` in the fact class: "every evidence AND discriminator
-- column immutable (`origin`, kinds, designations, `outcome`, the frozen `<act>ByRole` /
-- `<act>ByName` pair included)", and P33 names the columns — `decisionId`, `origin`,
-- `revisionId`, `projectId`, `sourceCommandId` and the frozen role/name pair — with the
-- re-point, the re-label, the NULLing and the replacing UPDATE each refused.
--
-- NOTHING WAS ENFORCING THAT (#582's review round 3, finding 4). The delivered
-- `ChangeRequest_t4b2_seal` freezes `decisionId` and nothing else, and it is a MERGED migration
-- that stays byte-for-byte unchanged — so the eight evidence columns this unit adds arrived with
-- no freeze at all. Until 4d-iii trusts and permanently seals the row, a direct UPDATE could
-- re-point `sourceCommandId` at another receipt, NULL `resolvedByCommandId`, re-label `origin`
-- from `standard` to `countersign_rejection`, or rewrite the frozen actor pair — changing which
-- command and which person the record says opened or closed the request, and the later stages
-- would then seal the forgery.
--
-- TWO CLASSES, because the columns are written at two different moments:
--
--   · FROZEN OUTRIGHT — `projectId`, `origin`, `revisionId`. These are the row's identity and
--     its discriminator, decided at INSERT. `revisionId` is CHECK-tied to `origin`, so admitting
--     a later write to either would let the pair be re-formed after the fact.
--   · ONE-WAY — `sourceCommandId` and the requester pair, `resolvedByCommandId` and the
--     resolver pair. NULL -> value is admitted because that is how they are legitimately
--     written: the drain leaves `sourceCommandId` NULL (4d-iii requires it), and the CLOSURE is
--     what writes the resolver set when the request leaves `open`. Once written they are
--     evidence, so value -> anything else, value -> NULL included, is refused.
--
-- `decisionId` is deliberately NOT repeated here: the delivered seal already refuses it by name,
-- and two triggers raising different messages about one write helps nobody.
CREATE OR REPLACE FUNCTION phase6_t4d_change_request_evidence_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_col TEXT;
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN v_col := 'projectId';
  ELSIF NEW."origin" IS DISTINCT FROM OLD."origin" THEN v_col := 'origin';
  ELSIF NEW."revisionId" IS DISTINCT FROM OLD."revisionId" THEN v_col := 'revisionId';
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % is evidence — its % is decided when the request is opened and may not be rewritten. Re-labelling a request''s origin or re-pointing its disposed revision changes what the record says happened.',
      OLD."id", v_col;
  END IF;

  IF OLD."sourceCommandId" IS NOT NULL AND NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId" THEN v_col := 'sourceCommandId';
  ELSIF OLD."requestedByRole" IS NOT NULL AND NEW."requestedByRole" IS DISTINCT FROM OLD."requestedByRole" THEN v_col := 'requestedByRole';
  ELSIF OLD."requestedByName" IS NOT NULL AND NEW."requestedByName" IS DISTINCT FROM OLD."requestedByName" THEN v_col := 'requestedByName';
  ELSIF OLD."resolvedByCommandId" IS NOT NULL AND NEW."resolvedByCommandId" IS DISTINCT FROM OLD."resolvedByCommandId" THEN v_col := 'resolvedByCommandId';
  ELSIF OLD."resolvedByRole" IS NOT NULL AND NEW."resolvedByRole" IS DISTINCT FROM OLD."resolvedByRole" THEN v_col := 'resolvedByRole';
  ELSIF OLD."resolvedByName" IS NOT NULL AND NEW."resolvedByName" IS DISTINCT FROM OLD."resolvedByName" THEN v_col := 'resolvedByName';
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: change request % already records % as provenance and it may not be replaced or cleared — the receipt and the frozen actor pair are written ONCE, by the command that performed the act they describe.',
      OLD."id", v_col;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ChangeRequest_t4d_evidence_frozen" ON "ChangeRequest";
CREATE TRIGGER "ChangeRequest_t4d_evidence_frozen" BEFORE UPDATE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_change_request_evidence_frozen();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3c — THE ORGS-OWNED MembershipTransition FACT
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- The architect chain is armed and disarmed by ORDINARY TEAM ACTS — a PMC adds an architect
-- member, or the last one leaves — so the standing change is a fact with the same seven
-- obligations every other 4d fact carries (§A.3). Without it "the chain turned on" is a count
-- with no attributable act behind it.
--
-- THE COLUMNS ARE THE PLAN'S, and were not until #582's review round 5 (findings 3 and 5, whose
-- single shared cause this is). The contract states the fact exactly — `MembershipTransition(id,
-- projectId, membershipId, fromRole, fromStatus, toRole, toStatus, actorId, actorRole, actorName,
-- sourceCommandId, at)` (plan line 2851): the WHOLE membership transition, old role and status to
-- new role and status, in ONE row. The first version of this table invented a different model —
-- `role` plus `fromStanding`/`toStanding`, one role's standing flip per fact, plus a stored
-- `activeCount` — and both round-5 findings are consequences of that one divergence:
--
--   · a re-role changes TWO roles' standing, so the invented model owed two facts for one
--     command, while `MembershipTransition_one_flip_key` admits one. The contract has no such
--     tension: one transition is one fact, and the UNIQUE is right as it stands.
--   · `fromStanding` had nothing to bind to. The membership row at commit is the POST-state, so a
--     fact could claim any prior standing it liked and the seal could not contradict it. The
--     pre-state is `fromRole`/`fromStatus`, and the membership-side pairing compares all four
--     against the write's OLD and NEW — the plan's own sentence at line 2915.
--
-- `role` and `activeCount` are gone because they were never fact columns: §A.3 names them as
-- EVENT PAYLOAD fields, and the payload's `activeCount` is compared against the register by the
-- event seal 4d-ii installs, not by the fact. Round 4's finding 1 deferred a comparison of the
-- invented column; the column it deferred does not exist in the contract, so the comparison goes
-- with it rather than being carried forward against a value nothing owes.
--
-- TWO DOMAIN DETERMINATIONS the plan leaves open, recorded rather than left implicit:
--
--   (i)  `fromRole`/`fromStatus` are NULL together, and only for an ADD — the membership did not
--        exist, so it held no role in any status. Every other transition has both.
--   (ii) `toRole`/`toStatus` are never NULL: the ordinary removal is SOFT (`status = 'removed'`,
--        the row and its role left in place), which is the same fact the reservation audit and
--        the deferred FK below already rest on.
--
-- "ONE FLIP PER MEMBERSHIP AND PER PROJECT PER TRANSACTION" is enforced as one flip per
-- membership per RECEIPT. A transaction has no column to key on; a command does, every
-- ledgered write carries one, and each command is one transaction — so the UNIQUE says the
-- same thing in a form the database can hold.

CREATE TABLE IF NOT EXISTS "MembershipTransition" (
    "id"              TEXT NOT NULL,
    "projectId"       TEXT NOT NULL,
    "membershipId"    TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "fromRole"        TEXT,
    "fromStatus"      TEXT,
    "toRole"          TEXT NOT NULL,
    "toStatus"        TEXT NOT NULL,
    "actorId"         TEXT NOT NULL,
    "actorRole"       TEXT NOT NULL,
    "actorName"       TEXT NOT NULL,
    "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId" TEXT NOT NULL,
    CONSTRAINT "MembershipTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MembershipTransition_projectId_membershipId_idx"
  ON "MembershipTransition"("projectId", "membershipId");
CREATE UNIQUE INDEX IF NOT EXISTS "MembershipTransition_source_command_key"
  ON "MembershipTransition"("projectId", "sourceCommandId");
-- one flip per membership per receipt (see the determination above)
CREATE UNIQUE INDEX IF NOT EXISTS "MembershipTransition_one_flip_key"
  ON "MembershipTransition"("projectId", "membershipId", "sourceCommandId");

DO $$ BEGIN
  -- the pre-state is present or absent as a PAIR: a fact that names a prior role without its
  -- status (or the reverse) states half a transition, and half a transition cannot be compared
  -- against the write's OLD row.
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_from_pair_check"
    CHECK (("fromRole" IS NULL) = ("fromStatus" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- A FACT RECORDS A CHANGE. Without this a row could claim `(engineer, active)` moved to
  -- `(engineer, active)` — a transition of nothing, immutable, and agreeing with any membership
  -- write that happened to touch the row. It is the same rule the old `fromStanding <> toStanding`
  -- CHECK carried, restated over the columns that now hold the transition.
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_moves_check"
    CHECK (("fromRole", "fromStatus") IS DISTINCT FROM ("toRole", "toStatus"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_actorRole_present_check"
    CHECK (btrim("actorRole", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_actorName_present_check"
    CHECK (btrim("actorName", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The project's own deletion CASCADES through both references. The append-only seal admits that
-- cascade explicitly (trigger depth plus the `Project_t4d_deleting` flag), exactly as the
-- registers admit theirs — a `NO ACTION` here would make a project undeletable the moment one
-- membership had ever changed standing.
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_projectId_sourceCommandId_fkey"
    FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DEFERRED because the fact and the membership are written in ONE transaction in either order:
-- an ADD may write the transition before the `Membership` row exists, and an immediate FK would
-- refuse the very act the fact records. It does NOT need to survive a departure, because the
-- ordinary team removal is SOFT — it sets `status = 'removed'` and leaves the row (and its
-- `role`) in place, which is the same fact the reservation audit above relies on. A project's
-- own deletion takes both rows together through the cascade.
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_projectId_membershipId_fkey"
    FOREIGN KEY ("projectId", "membershipId") REFERENCES "Membership"("projectId", "id")
    ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── obligation 1, with the project-cascade exception ─────────────────────────────────────────
-- The fact is immutable and undeletable, EXCEPT as part of the project's own deletion (#572's
-- review round 12, finding 5). Without that arm a project that had ever changed a membership's
-- standing could never be deleted, and the shared fixture teardown deletes projects.
--
-- The exception is TWO local facts, both required, exactly as 4c-iii established: trigger depth
-- above 1 (an RI cascade runs the child delete at depth 2 — measured), AND the transaction-local
-- flag the orgs-owned `Project_t4d_deleting` trigger sets. Depth alone would admit any other
-- trigger's delete; the flag alone would admit a DIRECT delete issued later in the same
-- transaction, which is at depth 1 and stays refused.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_transition_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
       AND coalesce(current_setting('phase6.t4d_project_delete', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % is the attributable record of a standing change and may not be DELETED — the chain turning on or off is evidence, not bookkeeping. (A cascade from the project''s own deletion is permitted; this is a direct delete.)',
      OLD."id";
  END IF;
  RAISE EXCEPTION
    'phase6 4d-i: MembershipTransition % is immutable — a writer that can rewrite who changed whose standing, or from what to what, can present one team act as another',
    OLD."id";
END $$;

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_append_only" ON "MembershipTransition";
CREATE TRIGGER "MembershipTransition_t4d_append_only"
  BEFORE UPDATE OR DELETE ON "MembershipTransition"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_transition_immutable();

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_no_truncate" ON "MembershipTransition";
CREATE TRIGGER "MembershipTransition_t4d_no_truncate"
  BEFORE TRUNCATE ON "MembershipTransition"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4d_fact_no_truncate();

-- ── obligation 3: the ACTOR must hold team-management authority ──────────────────────────────
-- THREE arms, and the third is not a loophole but the only way a real act can be recorded:
--
--   (a) an org owner/admin of THIS project's organisation — the tenancy-joined derivation, so
--       an owner of an unrelated org is refused;
--   (b) an active project `pmc`;
--   (c) SELF-DEMOTION. An actor who is the SUBJECT of a transition that REMOVES active standing
--       (they held a role actively before and do not after) is admitted even when (a) and (b) no
--       longer hold —
--       because by the time the seal runs the standing they are giving up may already be gone,
--       and the whole act is them giving it up. Refusing it would make the last owner
--       permanently unable to step down. It is narrow by construction: it admits only a
--       transition whose subject IS the actor and whose direction is LOSS.
--
-- The frozen `actorRole`/`actorName` pair is judged by the same shared helper every other 4d
-- fact uses, so the window disposition for a membership-less `pmc` claim is identical here.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_transition_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_self_demotion BOOLEAN;
BEGIN
  -- LOSS is now read off the transition itself: the subject held an ACTIVE role before and does
  -- not after. Under the invented columns this was `toStanding = 'not_held'`, which asked the same
  -- question of a value the fact simply asserted; here it is computed from the pre- and post-state
  -- the membership write is bound to, so a fact cannot talk its way into the self-demotion arm.
  v_self_demotion := (NEW."actorId" = NEW."userId"
                      AND NEW."fromStatus" = 'active'
                      AND NEW."toStatus" IS DISTINCT FROM 'active');

  IF NOT v_self_demotion
     AND NOT platform_user_orchestration_authority(NEW."projectId", NEW."actorId")
     AND NOT platform_user_holds_role(NEW."projectId", NEW."actorId", 'pmc') THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % attributes a standing change on project % to user %, who holds neither owner/admin authority in the project''s organisation nor active `pmc` standing on it, and is not the subject stepping down — team management is an authorized act',
      NEW."id", NEW."projectId", NEW."actorId";
  END IF;

  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."actorId", NEW."actorRole",
                                 NEW."actorName", 'MembershipTransition ' || NEW."id");

  -- NO REGISTER COMPARISON HERE, AND NONE BELOW. Round 4's finding 1 correctly moved it out of
  -- this immediate seal — the register only moves when the MEMBERSHIP is written, and the fact is
  -- written FIRST (plan line 2860: "the fact is inserted BEFORE the membership write it
  -- describes, for every transition"), so an INSERT-time comparison refused correct transactions.
  -- Round 5 removes the comparison itself: it compared a stored `activeCount` that the contract
  -- does not give this fact. The count is an EVENT PAYLOAD field (§A.3), and the event seal 4d-ii
  -- installs is what compares it against the register at commit. A fact column that duplicates a
  -- register is a second copy of a truth that already has one, and the round-4 defect was only
  -- ever a symptom of storing it.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_seal" ON "MembershipTransition";
CREATE TRIGGER "MembershipTransition_t4d_seal" BEFORE INSERT ON "MembershipTransition"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_transition_seal();

-- ── obligation 6: the receipt binding ────────────────────────────────────────────────────────
-- Named `phase6_t4d_membership_transition_bound` by §D, and the plan states BOTH of its clauses:
-- "requiring at commit that the cited command SUCCEEDED naming `NEW."membershipId"` as its
-- result (the delivered `phase6_t4c_provenance_bound` binds `resultRef = NEW.id`, which here
-- would be the fact's own id) AND that a same-transaction `Membership` write matching the fact
-- exists (an orphan fact refused)" (plan lines 2951-2956).
--
-- THE RESULT IS THE MEMBERSHIP, NOT THE FACT (Codex round 1, finding 11). §A's membership
-- command contract completes every one of the three member commands with `resultRef` = the
-- membership id (plan line 3095) — the affected entity, exactly as `decisions.create` names the
-- decision. The first version copied the delivered 4c binding, which compares against the row's
-- own id, so a correct 4d-ii add, re-role or removal would have reached commit and been REFUSED
-- there: a seal that only its own contradiction can pass. This is the single-fact shape — one
-- command writes ONE transition — so it needs no bundle widening.
--
-- THE ORPHAN CLAUSE. The INSERT seal's `activeCount` comparison proves the fact agrees with the
-- register; it does NOT prove any membership moved. With an architect already active the
-- register reads 1, and a fabricated `not_held → held` fact claiming `activeCount = 1` agrees
-- with it while no membership was touched — permanent evidence of a standing change nobody
-- performed. The converse (a membership write with no fact) is the membership-side pairing
-- trigger; this is the direction it cannot see, and the plan puts it here.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_transition_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; v_mem RECORD;
BEGIN
  -- THE RECEIPT IS THIS TRANSACTION'S (#582 round 3, finding 3). The message below has said
  -- "in this transaction" since round 1 and the query underneath it did not — the same shape
  -- round 1's finding 2 corrected in `platform_tx_event`, arriving again on the one table whose
  -- commands PREDATE the fact. `members.add`/`updateRole`/`remove` have existed since long
  -- before `MembershipTransition`, so a mature database holds succeeded member receipts that no
  -- transition has ever cited: a later direct transaction can update the membership (satisfying
  -- the `xmin` check on `Membership`) and insert a transition citing one of those HISTORICAL
  -- receipts, presenting a new standing change as an old command's act, with the actor and
  -- command type both truthfully matching that old act. `xmin` on the receipt closes it — the
  -- same comparison the delivered ledger seal uses to bind a completion to its reservation.
  SELECT "status", "resultRef", "commandType", "actorId",
         "xmin" = txid_current()::text::xid AS "thisTx"
    INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the fact',
      NEW."id";
  END IF;
  IF NOT COALESCE(c."thisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % cites receipt %, which was completed by an EARLIER transaction — a member command''s receipt is one act seen twice, and a receipt lying around from a past add, re-role or removal cannot back a standing change made now',
      NEW."id", NEW."sourceCommandId";
  END IF;

  -- THE RECEIPT IS IDENTIFIED BEFORE IT IS MATCHED, here too (#582 round 2, finding 5).
  -- Round 1's finding 12 established this clause and its correction landed on the three
  -- DECISION facts only; the commit message that carried it stated "the membership binding
  -- carries the same two clauses" and that was false. Without them a transaction can back a
  -- transition attributed to authorized actor B with an unrelated succeeded command whose
  -- result happens to equal the membership id, or with a member command actually run by A —
  -- and the same-transaction membership write then satisfies everything else, making the false
  -- attribution immutable. `members.add`/`updateRole`/`remove` are the three ledgered member
  -- commands (§A, plan line 3095).
  IF NOT (c."commandType" = ANY (ARRAY['members.add', 'members.updateRole', 'members.remove'])) THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % cites a `%` receipt, which is not a command that changes membership standing (expected members.add, members.updateRole or members.remove) — a receipt borrowed from an unrelated command proves nothing about this act',
      NEW."id", c."commandType";
  END IF;

  -- AND THE COMMAND MUST MATCH THE SHAPE OF THE TRANSITION (#582's review round 7, finding 3).
  -- Round 4's answer bound the command's KIND to a SET of three and stopped there, which makes
  -- the three interchangeable: a direct transaction can reserve a `members.remove` receipt,
  -- insert a fact describing a removed or absent membership becoming ACTIVE, perform that
  -- re-activation, and complete the receipt naming the membership. Actor, result,
  -- same-transaction and exact-standing checks all pass, and the append-only seal then keeps
  -- immutable evidence that a REMOVAL produced an ADD — with a removal's authorisation behind an
  -- addition's effect. The set was the easy half of the rule; the shape is the rule.
  --
  -- The three shapes come from the plan, not from this file's guesswork: `members.add` is the
  -- command re-activation goes through (plan line 3085, verbatim), so it is the one that moves a
  -- membership INTO `active`; `members.remove` is the one that moves it OUT; `members.updateRole`
  -- moves the ROLE of a membership that is active on both sides — a re-role is not a way in or
  -- out. Nothing here constrains a removal's role or an addition's, because the plan does not:
  -- only the standing edge each command owns is asserted.
  IF c."commandType" = 'members.remove' AND NEW."toStatus" = 'active' THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % records membership % becoming `active`, but cites a `members.remove` receipt — a removal is the command that ends a standing, never the one that grants it, and this fact would stand forever as an addition authorised by a removal',
      NEW."id", NEW."membershipId";
  END IF;
  IF c."commandType" = 'members.add' AND NEW."toStatus" <> 'active' THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % records membership % becoming `%`, but cites a `members.add` receipt — an add ends with the membership ACTIVE (re-activation of a removed member goes through it too), so a fact that ends anywhere else was produced by a different command',
      NEW."id", NEW."membershipId", NEW."toStatus";
  END IF;
  IF c."commandType" = 'members.updateRole'
     AND (NEW."toStatus" <> 'active' OR NEW."fromStatus" IS DISTINCT FROM 'active'
          OR NEW."fromRole" IS NULL OR NEW."fromRole" = NEW."toRole") THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % cites a `members.updateRole` receipt but records % → % / % → % — a re-role moves the ROLE of a membership that is active on both sides; a birth, a way in and a way out are members.add and members.remove',
      NEW."id", COALESCE(NEW."fromRole", '<null>'), NEW."toRole",
      COALESCE(NEW."fromStatus", '<null>'), NEW."toStatus";
  END IF;
  IF c."actorId" IS DISTINCT FROM NEW."actorId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % attributes the standing change to %, but its receipt was run by % — the fact and the receipt are one act seen twice, and team management is the act whose attribution matters most',
      NEW."id", NEW."actorId", COALESCE(c."actorId", '<null>');
  END IF;
  IF c."resultRef" IS DISTINCT FROM NEW."membershipId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: the command cited by MembershipTransition % names result %, not the membership % this fact records — a member command''s receipt names the MEMBERSHIP it affected, and a receipt for another result cannot be borrowed',
      NEW."id", COALESCE(c."resultRef", '<null>'), NEW."membershipId";
  END IF;

  SELECT m."role" AS "roleNow", m."status" AS "statusNow",
         m."xmin" = txid_current()::text::xid AS "movedThisTx"
    INTO v_mem FROM "Membership" m
   WHERE m."id" = NEW."membershipId"
     AND m."projectId" = NEW."projectId"
     AND m."userId" = NEW."userId";
  IF NOT FOUND OR NOT COALESCE(v_mem."movedThisTx", FALSE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % records a standing change of membership % (user %) that no write in this transaction performed — the fact and the membership move together or neither moves, and an ORPHAN fact is permanent evidence of an act that never happened',
      NEW."id", NEW."membershipId", NEW."userId";
  END IF;

  -- THE POST-STATE MUST BE THE ONE THIS FACT CLAIMS (#582 round 4, finding 2, now stated over the
  -- contract's columns). `xmin` alone proves only that SOME write touched the membership; the
  -- fact's `(toRole, toStatus)` has to BE the row the transaction left behind, or the fact is
  -- riding a write that did something else. The PRE-state half of the same question —
  -- `(fromRole, fromStatus)` — cannot be asked here at all, because at commit the OLD row is
  -- gone; it is asked by `phase6_t4d_membership_architect_paired` from the MEMBERSHIP side, where
  -- OLD is in hand (#582 round 5, finding 5, and plan line 2915, which put it there in the first
  -- place). Between the two directions all four columns are bound to the write.
  IF v_mem."roleNow" IS DISTINCT FROM NEW."toRole"
     OR v_mem."statusNow" IS DISTINCT FROM NEW."toStatus" THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % records membership % arriving at (%, %), but after this transaction''s writes that membership is (%, %) — a fact must name the change the write actually made, not merely ride a write that touched the same row',
      NEW."id", NEW."membershipId", NEW."toRole", NEW."toStatus",
      COALESCE(v_mem."roleNow", '<none>'), COALESCE(v_mem."statusNow", '<none>');
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_provenance_bound" ON "MembershipTransition";
CREATE CONSTRAINT TRIGGER "MembershipTransition_t4d_provenance_bound"
  AFTER INSERT ON "MembershipTransition" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_transition_bound();

-- ── obligation 2: the ARCHITECT standing write is paired with its fact, PERMANENTLY ──────────
-- Orgs-owned, on the orgs table, and NOT retired by 4d-iii: after the reservation is dropped an
-- architect membership becomes writable, and from that moment every arrival and departure of
-- architect standing must carry its attributable record or the chain can be armed by a write
-- nobody performed.
--
-- DEFERRED, and judged from the MEMBERSHIP side: the transition row may be written before or
-- after the membership write inside the command's transaction. The converse direction — a fact
-- with no standing change — is judged by `phase6_t4d_membership_transition_bound`, which is
-- deferred for this same reason: it reads the register and the membership row once every write
-- in the transaction has run (#582 round 4, findings 1 and 2). It said "the `activeCount`
-- comparison in the INSERT seal above" until round 4, and that placement was the defect — an
-- immediate check cannot read a register a later statement in the same command still has to move.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_architect_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_before     BOOLEAN := (TG_OP <> 'INSERT' AND OLD."role" = 'architect' AND OLD."status" = 'active');
  v_after      BOOLEAN := (TG_OP <> 'DELETE' AND NEW."role" = 'architect' AND NEW."status" = 'active');
  v_project    TEXT;
  v_membership TEXT;
  v_user       TEXT;
  v_from_role  TEXT;
  v_from_stat  TEXT;
  v_to_role    TEXT;
  v_to_stat    TEXT;
BEGIN
  -- OLD and NEW are records, and plpgsql has no expression that picks between two of them, so
  -- the fields are read explicitly per operation rather than through a CASE over the rows.
  -- `userId` is frozen on a membership (the identity-freeze class), so OLD and NEW agree on it
  -- wherever both exist and either side names the same subject.
  IF TG_OP = 'DELETE' THEN
    v_project := OLD."projectId"; v_membership := OLD."id"; v_user := OLD."userId";
  ELSE
    v_project := NEW."projectId"; v_membership := NEW."id"; v_user := NEW."userId";
  END IF;

  -- THE TRANSITION THE WRITE ACTUALLY MADE, both ends of it. An INSERT has no prior row, so its
  -- pre-state is NULL/NULL — the one shape the fact's `from_pair` CHECK admits as absent.
  IF TG_OP <> 'INSERT' THEN
    v_from_role := OLD."role"; v_from_stat := OLD."status";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_to_role := NEW."role"; v_to_stat := NEW."status";
  END IF;

  -- TWO RULES, AND THEY HAVE DIFFERENT SCOPES (#582 round 5, finding 5).
  --
  -- (1) EVERY ROLE: if a fact for this membership was written in this transaction, it must
  --     describe THIS write. That is the clause the pre-state needs, and it cannot be architect-
  --     scoped: the counted register carries `architect` alone, so for any other role nothing else
  --     narrows what a fact may claim. An already-active engineer membership given a same-value
  --     update inside a hand-run bundle satisfies `xmin`, and a fact fabricating an arrival that
  --     never happened — a NULL pre-state, as though the member had just been added — agrees with
  --     the post-state too, because the post-state is genuinely `(engineer, active)`. Only the
  --     PRE-state contradicts it, and only this side of the pairing can see it.
  --
  --     It DEMANDS nothing: a membership write with no fact passes this arm untouched, which is
  --     what keeps the unit dark while the delivered member commands still write no facts.
  IF EXISTS (
    SELECT 1 FROM "MembershipTransition" mt
     WHERE mt."projectId" = v_project AND mt."membershipId" = v_membership
       AND mt."xmin" = txid_current()::text::xid
  ) AND NOT EXISTS (
    SELECT 1 FROM "MembershipTransition" mt
     WHERE mt."projectId" = v_project AND mt."membershipId" = v_membership
       AND mt."xmin" = txid_current()::text::xid
       AND mt."userId" = v_user
       AND mt."fromRole" IS NOT DISTINCT FROM v_from_role
       AND mt."fromStatus" IS NOT DISTINCT FROM v_from_stat
       AND mt."toRole" IS NOT DISTINCT FROM v_to_role
       AND mt."toStatus" IS NOT DISTINCT FROM v_to_stat
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: a MembershipTransition written in this transaction for membership % on project % does not describe the write that happened — this write moved user % (%, %) → (%, %), and a fact that names any other move is permanent evidence of an act nobody performed',
      v_membership, v_project, v_user, COALESCE(v_from_role, '<none>'), COALESCE(v_from_stat, '<none>'),
      COALESCE(v_to_role, '<none>'), COALESCE(v_to_stat, '<none>');
  END IF;

  -- (2) ARCHITECT ONLY: the chain's arrival and departure must CARRY a fact. This is the demand,
  --     and it stays architect-scoped because that is the standing the chain reads.
  IF v_before = v_after THEN RETURN NULL; END IF;

  -- IN THIS TRANSACTION, about THIS MEMBER, and NAMING THIS TRANSITION — all four columns
  -- (Codex round 1, findings 9 and 13; #582 round 5, finding 5). Unscoped, it accepted historical
  -- evidence: an architect legitimately activated, removed, then bare-restored found the ORIGINAL
  -- row and passed, re-arming the chain with no attributable act. Without the subject comparison a
  -- PMC could activate membership A while inserting an otherwise-valid immutable transition naming
  -- an unrelated user B. And matching only the DIRECTION — which is all the invented
  -- `toStanding` column could express — left the pre-state unbound: an already-active engineer
  -- membership, given a same-value update inside a hand-run bundle, satisfied every other clause
  -- while the fact claimed a `not_held → held` arrival that never happened. Comparing
  -- `(fromRole, fromStatus, toRole, toStatus)` against OLD and NEW is the plan's own sentence
  -- (line 2915) and closes it: the fact must describe the write, end to end.
  IF NOT EXISTS (
    SELECT 1 FROM "MembershipTransition" mt
     WHERE mt."projectId" = v_project AND mt."membershipId" = v_membership
       AND mt."userId" = v_user
       AND mt."fromRole" IS NOT DISTINCT FROM v_from_role
       AND mt."fromStatus" IS NOT DISTINCT FROM v_from_stat
       AND mt."toRole" IS NOT DISTINCT FROM v_to_role
       AND mt."toStatus" IS NOT DISTINCT FROM v_to_stat
       AND mt."xmin" = txid_current()::text::xid
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: membership % on project % moved architect standing (%, %) → (%, %) in this transaction with no MembershipTransition written HERE naming user % and that exact transition — the chain is armed and disarmed by attributable ACTS, never by a bare row write, never by an older act reused, and never by a fact that describes a different move',
      v_membership, v_project, COALESCE(v_from_role, '<none>'), COALESCE(v_from_stat, '<none>'),
      COALESCE(v_to_role, '<none>'), COALESCE(v_to_stat, '<none>'), v_user;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_architect_provenance" ON "Membership";
CREATE CONSTRAINT TRIGGER "Membership_t4d_architect_provenance"
  AFTER INSERT OR UPDATE OR DELETE ON "Membership" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_architect_paired();

-- ── the ORDER, enforced where order can be enforced ──────────────────────────────────────────
-- #582 round 6, finding 2. The pairing above is DEFERRED, which makes it blind to WHEN the fact
-- arrived: it asks at commit whether a fact describing this write exists, and a bundle that wrote
-- the membership FIRST satisfies it just as well as one that wrote the fact first. That ordering
-- is not decoration. The plan requires the fact BEFORE the membership write "for every
-- transition" (line 2860) for a specific reason: the fact's own INSERT seal reads the actor's
-- authority and frozen role LIVE, so it must read them against the PRE-state.
--
-- Written membership-first, a direct bundle after 4d-iii can complete a `members.updateRole`
-- receipt for an active engineer, update THAT ACTOR'S OWN membership to `pmc`, and only then
-- insert the transition claiming `actorRole = 'pmc'`. Every later check agrees: the deferred
-- pairing sees a fact describing the write, and the fact's live authority read sees the freshly
-- projected `pmc` standing. The actor authorises their own promotion, and the register says a PMC
-- did it. The plan already anticipated this exact shape (#566's review round 1, finding 2, which
-- is why the live reads were placed at the fact's insert); nothing was enforcing the placement.
--
-- IMMEDIATE, because that is the whole point — a deferred check cannot distinguish orders. It
-- fires only where a standing-flipping write is possible at all, and it DEMANDS nothing of a
-- write with no fact: a plain membership write commits untouched, which keeps the unit dark.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_fact_first() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_project TEXT; v_membership TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project := OLD."projectId"; v_membership := OLD."id";
  ELSE
    v_project := NEW."projectId"; v_membership := NEW."id";
  END IF;

  -- A fact for this membership written LATER in the same transaction cannot exist yet, so
  -- "already present" is exactly the question this trigger can answer and the deferred one cannot.
  -- The converse — a fact with no membership write — stays with the deferred binding.
  IF EXISTS (
    SELECT 1 FROM "CommandExecution" c
     WHERE c."projectId" = v_project
       AND c."commandType" = ANY (ARRAY['members.add', 'members.updateRole', 'members.remove'])
       AND c."xmin" = txid_current()::text::xid
  ) AND NOT EXISTS (
    SELECT 1 FROM "MembershipTransition" mt
     WHERE mt."projectId" = v_project AND mt."membershipId" = v_membership
       AND mt."xmin" = txid_current()::text::xid
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: membership % on project % is being written by a member command whose MembershipTransition has not been inserted yet — the fact comes FIRST, so the authority and frozen role it records are read against the standing the actor held BEFORE this write, never the standing this write grants them',
      v_membership, v_project;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_fact_first" ON "Membership";
CREATE TRIGGER "Membership_t4d_fact_first"
  AFTER INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_fact_first();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3e — THE KERNEL ENVELOPE, THE EFFECT CATALOG, AND THE RELEASE LEASE
-- ────────────────────────────────────────────────────────────────────────────────────────────

-- ── the envelope columns, DARK ───────────────────────────────────────────────────────────────
-- §A.3 obligation 7 compares a fact's frozen `<act>ByRole`/`<act>ByName` pair against the
-- EVENT's envelope, and the delivered envelope carries neither (#555's review round 1,
-- finding 2). They land here as nullable columns the delivered `20261015000000` append-only
-- trigger already freezes, and NOTHING writes them until 4d-ii hands `emitEvent` the actor. A
-- NULL pair is admitted through the drain on every sealed event type, because the previous
-- release writes events and knows nothing about these columns.
ALTER TABLE "DomainEvent" ADD COLUMN IF NOT EXISTS "actorRole" TEXT;
ALTER TABLE "DomainEvent" ADD COLUMN IF NOT EXISTS "actorName" TEXT;

-- The candidate key `Notification.eventId`'s same-project composite FK references. Additive and
-- VACUOUSLY SATISFIABLE — `eventId` is already the primary key — so it can reject no row.
CREATE UNIQUE INDEX IF NOT EXISTS "DomainEvent_project_event_key"
  ON "DomainEvent"("projectId", "eventId");

-- ── the notice binding ───────────────────────────────────────────────────────────────────────
-- A notice is a DERIVED communication artifact; the event is the fact. Binding a notice to the
-- event it announces makes "this notice is about that act" a database truth rather than a
-- display-text match. Both nullable: legacy notices and every notice the previous release writes
-- carry neither.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "eventId" TEXT;

-- The notice half of the kernel's transaction reads. It lives HERE and not beside its sibling in
-- Part 3b because a `LANGUAGE sql` body IS validated at CREATE time, and `Notification.eventId`
-- is the column the two statements above have just added.
CREATE OR REPLACE FUNCTION platform_tx_notification(p_project TEXT, p_event TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT n."id" FROM "Notification" n
   WHERE n."projectId" = p_project AND n."eventId" = p_event
     AND n."xmin" = txid_current()::text::xid
   LIMIT 1;
$$;


DO $$ BEGIN
  ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_eventId_fkey"
    FOREIGN KEY ("projectId", "eventId") REFERENCES "DomainEvent"("projectId", "eventId")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ONE notice per event, PARTIAL so the legacy and drain-window rows (which carry no `eventId`)
-- stay out of it. Prisma cannot express a predicate on `@@unique`, so it lives in SQL only.
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_event_key"
  ON "Notification"("projectId", "eventId") WHERE "eventId" IS NOT NULL;

-- ── the external-effect catalog, as DATA ─────────────────────────────────────────────────────
-- The catalog is compiled into the server today (`apps/api/src/platform/external-effects.ts`),
-- which is exactly why a seal cannot read it: a trigger judging whether an event owed a push has
-- no way to ask a TypeScript constant. It is projected here as rows, seeded from the CURRENT
-- compiled catalog as literal SQL, and a tripwire in the suite compares the two so a catalog
-- entry added in code without its row — or a row that drifts from code — fails a test rather
-- than silently changing what the seals judge.
--
-- `retiredAt` is a ONE-WAY stamp, gated: an effect key leaves service by being retired, never by
-- being deleted, so a historical event's key still resolves.
-- §A.2's ELEVEN columns, keyed by `(coverageVersion, effectKey)`. The first version of this file
-- implemented six of them under `effectKey` alone (Codex round 1, findings 4 and 5), which cannot
-- express the state the whole drain rests on: through the window the PREVIOUS release emits the
-- old `coverageVersion` of a key while 4d-ii emits a new one, and both definitions must resolve
-- deterministically at the same time. Under a single-column key the new row COLLIDES with the old
-- and the seed's `ON CONFLICT DO NOTHING` silently keeps the stale definition — a drain that
-- looks seeded and is not.
CREATE TABLE IF NOT EXISTS "ExternalEffectCatalog" (
    "coverageVersion" TEXT NOT NULL,
    "effectKey"       TEXT NOT NULL,
    "eventType"       TEXT NOT NULL,
    "invalidate"      BOOLEAN NOT NULL,
    "pushRoles"       JSONB,
    "pushFamily"      TEXT,
    -- the push-shape evidence the envelope and transition seals read (#560's review round 1,
    -- finding 3, and round 2's `audience`): `requiresPush` says the family OWES a push, so a
    -- hand-run writer cannot seal a `noop` where the delivered service always announces;
    -- `audience` says WHICH shape is owed — `broadcast` (roles EQUAL the ceiling), `targeted` (a
    -- target within the ceiling) or `frozen` (the frozen-audience rule); `frozenAudience` and the
    -- family's constant, decision-free `pushBody` are what the transition seal compares a frozen
    -- family's push against. NO DEFAULT on `audience`: a pushing row without one is a row the
    -- seal cannot judge, and silence there would read as permission.
    "frozenAudience"  BOOLEAN NOT NULL,
    "requiresPush"    BOOLEAN NOT NULL,
    "audience"        TEXT,
    "pushBody"        TEXT,
    -- §A.3 obligation 7's generic pairing: whether an event of this key must be CLAIMED by
    -- exactly one fact. Seeded false; 4d-ii turns it on per key as its facts land.
    "pairingRequired" BOOLEAN NOT NULL DEFAULT FALSE,
    "retiredAt"       TIMESTAMP(3),
    CONSTRAINT "ExternalEffectCatalog_pkey" PRIMARY KEY ("coverageVersion", "effectKey")
);

-- THE CHECKS ARE ADDED SEPARATELY, and that is not a style choice (#582 round 4, finding 4).
-- `CREATE TABLE IF NOT EXISTS` skips its ENTIRE body when the table is already there, and on the
-- P3005 baseline path it always is: `prisma db push` built the schema from `schema.prisma`, which
-- reproduces this table's columns and primary key and NONE of its CHECKs — Prisma cannot express
-- them — and `migrate.sh` then runs this file from `ALWAYS_EXECUTE` over that database. Written
-- inline, the three constraints below would have installed on a fresh migrate and on NO baseline
-- database, so the seals that read this catalog would have been judging rows nothing constrained,
-- on exactly the deployments the drain is aimed at. Every other table in this file already adds
-- its CHECKs this way (`ReleaseLease`, `MembershipTransition`, `ProjectRoleStanding`, the spec
-- tables); this one was the single exception, and `migrate.sh`'s own baseline comment states the
-- rule it broke: "a db-push baseline has their modeled tables and columns but NONE of their raw
-- CHECK, append-only, eligibility or provenance triggers".
DO $$ BEGIN
  -- A row that MAY push names its shape; a row that may not names none. The shape is tied to
  -- `pushRoles`, not to `requiresPush`, because the two answer different questions (#582 round
  -- 2, finding 1, and the seeding defect it exposed): `pushRoles` is the audience CEILING a
  -- key may ever reach, `requiresPush` is whether the delivered branch ALWAYS announces. Four
  -- delivered keys may push and legitimately do not on one of their branches — a
  -- participant-initialised activity or inspection, an inspection approval folded into an
  -- activity sign-off, and a RECORD publication, which pushes at nobody because there is
  -- nothing to approve. Keying `audience` to `requiresPush` would have left exactly those four
  -- families' push SHAPE unjudged, `decision.published`'s decider narrowing among them.
  ALTER TABLE "ExternalEffectCatalog" ADD CONSTRAINT "ExternalEffectCatalog_audience_check"
    CHECK (("pushRoles" IS NOT NULL AND "audience" IN ('broadcast', 'targeted', 'frozen'))
           OR ("pushRoles" IS NULL AND "audience" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- a branch cannot be obliged to announce to an audience it has no ceiling for.
  ALTER TABLE "ExternalEffectCatalog" ADD CONSTRAINT "ExternalEffectCatalog_requires_push_check"
    CHECK (NOT "requiresPush" OR "pushRoles" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- only a frozen-audience family carries a constant body, and it carries one.
  ALTER TABLE "ExternalEffectCatalog" ADD CONSTRAINT "ExternalEffectCatalog_frozen_body_check"
    CHECK (("frozenAudience" AND "audience" = 'frozen' AND "pushBody" IS NOT NULL)
           OR (NOT "frozenAudience" AND "pushBody" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the release lease, DARK ──────────────────────────────────────────────────────────────────
-- The drain attestation's TRUSTED AUTONOMOUS EVIDENCE, and the plan states its columns exactly:
-- `ReleaseLease(instanceId, catalogVersion, release, startedAt, leaseUntil)` (plan line 6707).
-- Every serving process writes its row at startup with the consumer-catalog version COMPILED
-- into it — the same durable generation identity `syncConsumerCatalog` already judges — and
-- renews `leaseUntil` on an interval while it serves. The preflight's question is therefore one
-- query: "is any lease whose `leaseUntil` is still in the future sitting at a `catalogVersion`
-- below the minimum?", and a NO is in-database proof that no process of an older generation
-- that started after this register existed is still serving.
--
-- The first version of this table shipped `id`/`acquiredAt`/`acquiredBy`/`heartbeatAt`/
-- `releasedAt` — an ACQUIRE/RELEASE mutex, which is a different mechanism answering a different
-- question (Codex round 1, finding 10, and the column set beyond what that finding raised). A
-- mutex carries no `catalogVersion`, so the preflight cannot ask its question of it at all; and
-- its `releasedAt` is a stamp any caller may set, retiring a STILL-SERVING release before
-- 4d-iii's preflight reads it — precisely the hole the register exists to close. An EXPIRY is
-- not a stamp: a stopped process's lease runs out on its own and stays as history, and no
-- writer can make a live lease look dead.
CREATE TABLE IF NOT EXISTS "ReleaseLease" (
    -- one row per SERVING PROCESS, keyed by the process instance. A restarted container is a
    -- new instance and takes a new row; the old row expires where it stands.
    "instanceId"     TEXT NOT NULL,
    -- the consumer-catalog contract version compiled into that process — an INTEGER, the shape
    -- `OutboxConsumerCatalog.catalogVersion` carries, because the preflight compares the two.
    "catalogVersion" INTEGER NOT NULL,
    "release"        TEXT NOT NULL,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NO DEFAULT: a lease whose expiry its writer did not state is a lease the preflight cannot
    -- judge, and a default here would silently make every such row either eternally live or
    -- instantly dead. The renewal moves this column and only this column.
    "leaseUntil"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReleaseLease_pkey" PRIMARY KEY ("instanceId")
);
-- the preflight's index: every live lease below a version, in one range scan.
CREATE INDEX IF NOT EXISTS "ReleaseLease_catalogVersion_leaseUntil_idx"
  ON "ReleaseLease"("catalogVersion", "leaseUntil");
CREATE INDEX IF NOT EXISTS "ReleaseLease_release_idx" ON "ReleaseLease"("release");

DO $$ BEGIN
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_release_present_check"
    CHECK (btrim("release", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_instanceId_present_check"
    CHECK (btrim("instanceId", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- a version at or below zero is no generation the catalog ever registered, and admitting one
  -- would let a process claim to be OLDER than any minimum the preflight can name.
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_catalogVersion_check"
    CHECK ("catalogVersion" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- a lease that expired before it began is not evidence that anything served.
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_leaseUntil_after_start_check"
    CHECK ("leaseUntil" >= "startedAt");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the generic pairing register ─────────────────────────────────────────────────────────────
-- ONE claim per event, and the claim is supplied per BRANCH by that branch's PRIMARY fact — never
-- by every fact in a bundle (§A.3, #568's review round 1, finding 2; #572's review round 5,
-- finding 2). A blanket "every fact seal claims its events" aborts a VALID bundle: a returned
-- stranded resolution's `DecisionStrandedResolution` and its `ChangeRequest` share one
-- `decision.change_requested`, so two claimants would collide on the per-event UNIQUE below —
-- the same collision a reapproval revision and its closing request would meet.
CREATE TABLE IF NOT EXISTS "DomainEventPairingClaim" (
    "projectId"   TEXT NOT NULL,
    "eventId"     TEXT NOT NULL,
    "claimedBy"   TEXT NOT NULL,
    "claimedById" TEXT NOT NULL,
    "claimedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainEventPairingClaim_pkey" PRIMARY KEY ("eventId")
);
CREATE INDEX IF NOT EXISTS "DomainEventPairingClaim_projectId_idx"
  ON "DomainEventPairingClaim"("projectId");

DO $$ BEGIN
  ALTER TABLE "DomainEventPairingClaim" ADD CONSTRAINT "DomainEventPairingClaim_event_fkey"
    FOREIGN KEY ("projectId", "eventId") REFERENCES "DomainEvent"("projectId", "eventId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The seed: the CURRENT compiled catalog, as literal SQL, generated from
-- `apps/api/src/platform/external-effects.ts` rather than transcribed. `ON CONFLICT DO NOTHING`
-- so an `ALWAYS_EXECUTE` replay adds keys that appeared since and never rewrites a row an
-- operator or a later unit has moved.
-- The seed DECLARES itself, which is what the INSERT arm above requires. TRANSACTION-LOCAL
-- (`is_local = true`, the `SET LOCAL` form) since the file gained its own BEGIN (#582's review
-- round 3, finding 1): a gate that outlives a FAILED apply is a gate standing open in a session
-- whose writes were rolled back. The earlier session-scoped form carried a reason that was
-- false — see the header.
SELECT set_config('vitan.phase6_4d_catalog', 'on', true);

INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, false, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.consultation_requested', 'decision.consultation_requested', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.consultation_responded', 'decision.consultation_responded', true, '["pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.published', 'decision.published', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, false, 'targeted', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, false, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, false, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('b731a407835f7a9ff0cbc1d375a31930a55c9ef5c83c356b528fa0e1afec0f61', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

SELECT set_config('vitan.phase6_4d_catalog', 'off', true);

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3d — THE GENERIC PAIRING MECHANISM AND THE KERNEL SEALS
-- ────────────────────────────────────────────────────────────────────────────────────────────

-- ── the pairing primitive ────────────────────────────────────────────────────────────────────
-- Generic, platform-owned, and it decides nothing: a fact's seal calls it to say "this event is
-- mine". The per-event primary key is what makes the claim EXCLUSIVE, so a second claimant meets
-- a constraint rather than a rule someone has to remember.
CREATE OR REPLACE FUNCTION platform_claim_event_pairing(
  p_project TEXT, p_event TEXT, p_table TEXT, p_row TEXT
) RETURNS VOID LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  INSERT INTO "DomainEventPairingClaim" ("projectId", "eventId", "claimedBy", "claimedById")
  VALUES (p_project, p_event, p_table, p_row);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION
    'phase6 4d-i: event % is already claimed by another fact — exactly ONE fact per event branch supplies the claim, and %.% is a second claimant. A bundle''s non-primary facts are verification-only.',
    p_event, p_table, p_row;
END $$;

-- The register is projected from the facts that claim, so it takes the same writer-depth rule
-- as the standing registers: a claim arrives from inside a fact's trigger, never from a
-- statement someone typed.
DROP TRIGGER IF EXISTS "DomainEventPairingClaim_t4d_writer" ON "DomainEventPairingClaim";
CREATE TRIGGER "DomainEventPairingClaim_t4d_writer"
  BEFORE INSERT OR UPDATE OR DELETE ON "DomainEventPairingClaim"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_register_writer();

DROP TRIGGER IF EXISTS "DomainEventPairingClaim_t4d_no_truncate" ON "DomainEventPairingClaim";
CREATE TRIGGER "DomainEventPairingClaim_t4d_no_truncate"
  BEFORE TRUNCATE ON "DomainEventPairingClaim"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_register_no_truncate();

-- ── the kernel-owned pairing seal ────────────────────────────────────────────────────────────
-- The converse of the claim: an event whose catalog entry says `pairingRequired` must be claimed
-- by the time the transaction commits. DEFERRED, because the event is written before the fact
-- that claims it. Owned by the KERNEL and driven by the CATALOG, so no peer module installs a
-- trigger on the kernel's table (#568's review round 1, finding 2).
--
-- Judged through the catalog rather than a list of event types: a list is a roster to keep in
-- step, and a roster is what this plan has repeatedly recorded failing.
CREATE OR REPLACE FUNCTION platform_t4d_event_pairing_claimed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_required BOOLEAN;
BEGIN
  -- THE EVENT'S OWN CATALOG ROW, by its full key (#582 round 2, finding 4). The previous
  -- lookup matched on `eventType` alone and took `ORDER BY effectKey LIMIT 1` — an ARBITRARY
  -- unretired row. That is wrong exactly where this unit is supposed to be careful: through the
  -- rolling drain two coverage versions of the same key coexist ON PURPOSE and may disagree on
  -- `pairingRequired`, so the old `false` row could be chosen for a new pairing-required event
  -- (admitting it unclaimed) or the new `true` row for a previous-release event (refusing a
  -- write the drain exists to keep working). The comment above this query already argued that a
  -- roster is what keeps failing — and then the query picked one by position.
  --
  -- `(coverageVersion, effectKey)` is the catalog's PRIMARY KEY, so this reads at most one row
  -- and needs no ordering. `retiredAt` is deliberately NOT filtered: the row the event NAMES is
  -- the policy that governed it when it was emitted, and retirement is a statement about what
  -- the current release implements, not about what an already-emitted event owed.
  --
  -- A legacy event carrying no intent resolves both keys to NULL, matches nothing, and is
  -- admitted — which is correct: an event with no catalog entry was never under this policy.
  SELECT c."pairingRequired" INTO v_required
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = NEW."dispatchIntent" ->> 'coverageVersion'
     AND c."effectKey"       = NEW."dispatchIntent" ->> 'effectKey';
  IF v_required IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;

  IF NOT EXISTS (SELECT 1 FROM "DomainEventPairingClaim" k
                  WHERE k."projectId" = NEW."projectId" AND k."eventId" = NEW."eventId") THEN
    RAISE EXCEPTION
      'phase6 4d-i: event % of type `%` requires a pairing claim and none was made in this transaction — the catalog says an act of this type is recorded by a FACT, and an unclaimed event is an effect with no act behind it',
      NEW."eventId", NEW."eventType";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DomainEvent_t4d_pairing_claimed" ON "DomainEvent";
CREATE CONSTRAINT TRIGGER "DomainEvent_t4d_pairing_claimed"
  AFTER INSERT ON "DomainEvent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_event_pairing_claimed();

-- ── the ENVELOPE seal ────────────────────────────────────────────────────────────────────────
-- The two new columns are EVIDENCE, so they are frozen the moment they are written and a NULL
-- pair may never be filled in afterwards: a role or name added to a historical event would be a
-- claim about an act nobody made at the time. The delivered `20261015000000` append-only trigger
-- already refuses UPDATEs wholesale; this seal states the columns' own rule so a later unit that
-- loosens that trigger cannot loosen this by accident.
--
-- It also pins the pair's COHERENCE: a human actor's role and name arrive together or not at
-- all. A half-filled envelope would pass a fact's comparison on one half and silently skip the
-- other.
CREATE OR REPLACE FUNCTION platform_t4d_event_envelope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_next BIGINT; v_allocated_here BOOLEAN;
  v_key TEXT; v_version TEXT; v_cat RECORD;
  v_push JSONB; v_roles TEXT[]; v_ceiling TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- (a) THE POSITION, and that THIS transaction allocated it (§A.2; Codex round 1, finding 3).
    -- The first version of this seal judged the actor pair alone, so a direct insert could write
    -- an otherwise-valid event at an arbitrary position without touching `ProjectEventStream`.
    -- No allocator trigger fires for that, the corrupt event commits, and the abort lands on the
    -- NEXT ordinary emit — in another transaction, naming neither the writer nor the row.
    --
    -- `emitEvent` follows increment-then-insert, so the event it is writing sits at
    -- `nextPosition - 1` of a stream row this transaction just moved. A writer that skips the
    -- increment lands on `nextPosition` (refused here) or on a taken position (refused by the
    -- `(projectId, streamPosition)` unique); a writer that increments once and inserts twice has
    -- its second insert refused. With `_t4d_allocation_bound` requiring the converse — every
    -- increment carries its event — allocations and events are one-to-one.
    SELECT s."nextPosition", s."xmin" = txid_current()::text::xid
      INTO v_next, v_allocated_here
      FROM "ProjectEventStream" s WHERE s."projectId" = NEW."projectId";
    IF v_next IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: project % has no event-stream allocator, so event % has no issued position to sit at',
        NEW."projectId", NEW."eventId";
    END IF;
    IF NEW."streamPosition" <> v_next - 1 OR NOT COALESCE(v_allocated_here, FALSE) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % sits at position % but this transaction did not allocate it (the allocator for project % stands at %, moved here: %) — a position is taken by incrementing the allocator in the SAME transaction that writes the event, never chosen',
        NEW."eventId", NEW."streamPosition", NEW."projectId", v_next, COALESCE(v_allocated_here, FALSE);
    END IF;

    -- (b) THE INTENT, judged against the PERSISTED catalog (§A.2 (b); #582 round 2, finding 1).
    -- The first version of this seal stopped after the allocation and the actor pair, so the
    -- ONE thing the catalog rows exist to make askable was never asked: a direct insert could
    -- commit an unknown or retired coverage version, flip `invalidate` off so no consumer ever
    -- refreshed, or persist a forged push audience — and the relay's `expandMissingDeliveries`
    -- rebuilds from exactly this immutable intent, so the forgery survives every replay.
    --
    -- FOR SHARE, not a bare read (plan line 5104): the gated retirement stamp takes `FOR UPDATE`
    -- on the same row, so the two order deterministically and an event cannot commit on an
    -- intent that was retired between this check and its commit. Share locks do not conflict
    -- with each other, so concurrent emits of the same key do not serialize behind one another.
    IF NEW."dispatchIntent" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries no dispatchIntent — every event names the catalog entry that decides its external consequence, and an intent-less event is one the relay would have to guess about',
        NEW."eventId";
    END IF;
    v_key     := NEW."dispatchIntent" ->> 'effectKey';
    v_version := NEW."dispatchIntent" ->> 'coverageVersion';
    IF v_key IS NULL OR v_version IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries an intent naming effectKey % at coverageVersion % — both halves of the catalog key are required, because the key alone does not identify a definition through the drain',
        NEW."eventId", COALESCE(v_key, '<null>'), COALESCE(v_version, '<null>');
    END IF;

    SELECT c."eventType", c."invalidate", c."pushRoles", c."requiresPush", c."audience", c."retiredAt"
      INTO v_cat
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_version AND c."effectKey" = v_key
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % names catalog entry (%, %), which this database does not hold — an intent the seals cannot resolve is an external consequence nobody approved',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_cat."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % names catalog entry (%, %), retired at % — a retired definition still resolves for HISTORY, and may not back a new event',
        NEW."eventId", v_version, v_key, v_cat."retiredAt";
    END IF;
    IF v_cat."eventType" <> NEW."eventType" THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % is of type `%` but names catalog entry (%, %), which is declared for `%` — an effect key is per command BRANCH, and a branch cannot be borrowed by another type',
        NEW."eventId", NEW."eventType", v_version, v_key, v_cat."eventType";
    END IF;
    IF (NEW."dispatchIntent" ->> 'invalidate')
       IS DISTINCT FROM (CASE WHEN v_cat."invalidate" THEN 'true' ELSE 'false' END) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % claims invalidate=% while catalog entry (%, %) declares % — suppressing the invalidation leaves every open surface showing the state before this act',
        NEW."eventId", COALESCE(NEW."dispatchIntent" ->> 'invalidate', '<absent>'), v_version, v_key,
        CASE WHEN v_cat."invalidate" THEN 'true' ELSE 'false' END;
    END IF;

    -- THE PUSH SHAPE. `pushRoles` is the CEILING a key may ever reach; `requiresPush` says the
    -- delivered branch ALWAYS announces, so a hand-run writer cannot seal a silent event where
    -- the service always speaks; `audience` says which shape is owed.
    v_push := NEW."dispatchIntent" -> 'push';
    IF v_push IS NOT NULL AND jsonb_typeof(v_push) <> 'object' THEN
      RAISE EXCEPTION
        'phase6 4d-i: the push of event % is a % — a push is an object of body, roles and an optional target',
        NEW."eventId", jsonb_typeof(v_push);
    END IF;
    IF v_push IS NOT NULL AND v_cat."pushRoles" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries a push, but catalog entry (%, %) declares no push audience at all — an announcement nobody approved is an audience invented at the write',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_push IS NULL AND v_cat."requiresPush" THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries no push, but catalog entry (%, %) declares that this branch always announces — a silent write of an act the service announces is a suppressed notice',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_push IS NOT NULL THEN
      -- THE BODY IS A NONBLANK STRING (#582 round 5, finding 1). Requiring only that `push` be an
      -- object let `{push: {body: '', roles: <the whole ceiling>}}` satisfy every clause below —
      -- and `deliveryFor` (`outbox/consumers.ts`) reads a falsy body as a `noop`, so the delivered
      -- service SILENTLY declines to announce an event the catalog says always announces. That is
      -- the exact hole `requiresPush` exists to close, reached through the body rather than
      -- through the flag: an empty string is not a quiet announcement, it is no announcement at
      -- all, and it must be refused where the intent is judged rather than discovered downstream.
      IF jsonb_typeof(v_push -> 'body') IS DISTINCT FROM 'string'
         OR btrim(v_push ->> 'body', E' \t\n\x0B\f\r') = '' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % carries body % — a push announces, so its body is a NONBLANK string; a missing or empty one is read as a `noop` by the delivered consumer and the announcement the catalog owes never happens',
          NEW."eventId", COALESCE(jsonb_typeof(v_push -> 'body'), '<absent>');
      END IF;
      IF jsonb_typeof(v_push -> 'roles') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % names roles as % — the audience is an array, and an absent one is not an empty one',
          NEW."eventId", COALESCE(jsonb_typeof(v_push -> 'roles'), '<absent>');
      END IF;
      SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::TEXT[]) INTO v_roles
        FROM jsonb_array_elements_text(v_push -> 'roles') AS t(r);
      SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::TEXT[]) INTO v_ceiling
        FROM jsonb_array_elements_text(v_cat."pushRoles") AS t(r);
      IF NOT (v_roles <@ v_ceiling) THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % names roles %, outside the ceiling % of catalog entry (%, %) — a site may NARROW an audience and may never widen it',
          NEW."eventId", v_roles, v_ceiling, v_version, v_key;
      END IF;
      IF v_cat."audience" = 'broadcast' AND NOT (v_ceiling <@ v_roles) THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a BROADCAST family, so the push of event % must reach its whole ceiling % and reaches % — a narrowed broadcast silently drops the roles it omits',
          v_version, v_key, NEW."eventId", v_ceiling, v_roles;
      END IF;
      -- A BROADCAST MAY NAME NO TARGET (#582 round 5, finding 6). The clause above proves the role
      -- set is the whole ceiling and stopped there, so an event could carry the full broadcast
      -- audience AND a scalar `targetUserId` — and the delivered consumer
      -- (`outbox/consumers.ts`, the targeted branch) PRIORITISES that target and returns, so
      -- exactly one user receives what the catalog declares a broadcast and everyone else is
      -- silently dropped. Widening the roles was already refused; narrowing by a back door was
      -- not. Both target shapes are rejected here, because `targetUserIds` on a non-frozen family
      -- is refused below for the same reason and a broadcast is not frozen either.
      IF v_cat."audience" = 'broadcast'
         AND ((v_push ? 'targetUserId') OR (v_push ? 'targetUserIds')) THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a BROADCAST family, but the push of event % also names a target — the delivered consumer prefers a target over the audience, so this reaches ONE user while claiming to reach the whole ceiling %',
          v_version, v_key, NEW."eventId", v_ceiling;
      END IF;
      IF v_cat."audience" = 'targeted'
         AND (v_push ->> 'targetUserId') IS NULL AND cardinality(v_roles) = 0 THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a TARGETED family, so the push of event % must name the user it is for or the non-empty role audience it narrows to, and it names neither',
          v_version, v_key, NEW."eventId";
      END IF;
      -- `targetUserIds` is the FROZEN-audience array (4d-ii's countersign demand and forward);
      -- on any other family it is a set of recipients no rule resolved.
      IF (v_push ? 'targetUserIds') AND v_cat."audience" IS DISTINCT FROM 'frozen' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % carries a frozen audience list, but catalog entry (%, %) is a `%` family — only a frozen-audience family resolves its recipients as a set',
          NEW."eventId", v_version, v_key, COALESCE(v_cat."audience", '<none>');
      END IF;
    END IF;

    IF (NEW."actorRole" IS NULL) <> (NEW."actorName" IS NULL) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries half an actor envelope (role %, name %) — the pair is written together or not at all, so a fact comparing it cannot pass on one half and skip the other',
        NEW."eventId", COALESCE(NEW."actorRole", '<null>'), COALESCE(NEW."actorName", '<null>');
    END IF;
    IF NEW."actorRole" IS NOT NULL AND NEW."actorKind" <> 'human' THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % is a `%` event and may not carry a human actor envelope — a system actor has no role and no display name to freeze',
        NEW."eventId", NEW."actorKind";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."actorRole" IS DISTINCT FROM OLD."actorRole"
     OR NEW."actorName" IS DISTINCT FROM OLD."actorName" THEN
    RAISE EXCEPTION
      'phase6 4d-i: the actor envelope of event % is immutable — attributing a past act to a different role or name, or filling in a pair that was never recorded, is a claim about something nobody did',
      OLD."eventId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DomainEvent_t4d_envelope" ON "DomainEvent";
CREATE TRIGGER "DomainEvent_t4d_envelope" BEFORE INSERT OR UPDATE ON "DomainEvent"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_event_envelope();

-- ── the NOTICE binding, split by TIMING ──────────────────────────────────────────────────────
-- TWO objects, and the split is not stylistic (#572's review round 4, finding 1). The FREEZE is
-- an immediate BEFORE UPDATE trigger: once a notice names an event and a kind, neither moves.
-- The BINDING is a DEFERRED constraint trigger on INSERT: a notice written before its event, in
-- the same transaction, must still be judged — and PostgreSQL cannot make a BEFORE trigger
-- deferred, so one object cannot be both.
-- The freeze covers FOUR columns and BOTH operations (§A.2, and #556's round 2 finding 5 as the
-- plan states it: "freezes `eventId`, `kind`, `decisionId` and `projectId` on any row whose
-- `eventId` is non-NULL and refuses its DELETE"). The first version froze two columns on UPDATE
-- only (Codex round 1, finding 6): once 4d-ii starts writing kinded, event-bound notices, a
-- direct DELETE removed the owed notice permanently while its transition and its event stayed
-- committed, and the INSERT-time correspondence trigger is not re-evaluated on a delete.
--
-- SCOPED to rows that carry an event. A legacy or drain-window notice carries none, and the
-- delivered withdraw's notice retirement deletes exactly those kind-less rows — so the seal must
-- not touch them. A kinded notice of a withdrawn decision is HIDDEN by the visibility filter,
-- never erased.
CREATE OR REPLACE FUNCTION platform_t4d_notification_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."eventId" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: notice % announces event % and may not be DELETED — its transition and its event stay committed, so erasing the notice leaves an act that was announced to nobody. A notice about a withdrawn decision is HIDDEN by the visibility filter, never removed; the delivered retirement path deletes kind-less legacy rows only.',
        OLD."id", OLD."eventId";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."eventId" IS DISTINCT FROM OLD."eventId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % is bound to event % and may not be re-pointed at % — a notice announces the act it was written for, and moving it makes it announce another',
      OLD."id", COALESCE(OLD."eventId", '<null>'), COALESCE(NEW."eventId", '<null>');
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice %''s kind (`%`) is evidence of WHAT was announced and may not be rewritten to `%`',
      OLD."id", COALESCE(OLD."kind", '<null>'), COALESCE(NEW."kind", '<null>');
  END IF;
  -- the two coordinates the binding rests on. Re-pointing either would make the notice render
  -- another decision's content, or another project's, under this row's visibility.
  IF OLD."eventId" IS NOT NULL THEN
    IF NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
      RAISE EXCEPTION
        'phase6 4d-i: notice % announces event % about decision % and may not be re-pointed at % — the binding is what makes "this notice is about that act" a database truth',
        OLD."id", OLD."eventId", COALESCE(OLD."decisionId", '<null>'), COALESCE(NEW."decisionId", '<null>');
    END IF;
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION
        'phase6 4d-i: notice % may not change project (% → %) — the notice, its event and its decision share one tenant, and moving the row across that boundary renders its content under another project''s visibility',
        OLD."id", OLD."projectId", NEW."projectId";
    END IF;
  END IF;

  -- THE RENDERED CACHE IS FROZEN ON A KINDED NOTICE (#582 round 6, finding 6). The clauses above
  -- freeze the BINDING — which event, which kind, which decision, which project — and stopped
  -- there, so `text` and `color` stayed writable. Through the 4d-ii rolling deployment that is a
  -- live hole with two readers: a new replica DERIVES a kinded notice's content from the immutable
  -- event and never looks at these columns, while a PREVIOUS-RELEASE 4c replica still renders the
  -- stored strings. A direct post-commit UPDATE therefore shows one thing to the old replica and
  -- another to the new one, and the reader that would notice is precisely the one that stopped
  -- reading. A kinded notice's cache is a copy of a derivation, so it may be written once and not
  -- edited; a legacy KINDLESS row has no derivation behind it and keeps its editability.
  IF OLD."kind" IS NOT NULL THEN
    IF NEW."text" IS DISTINCT FROM OLD."text" OR NEW."color" IS DISTINCT FROM OLD."color" THEN
      RAISE EXCEPTION
        'phase6 4d-i: notice % is KINDED (`%`), so its rendered text and colour are a cache of what its event already says and may not be edited — a previous-release replica still renders these columns, and rewriting them makes two releases announce different things about one act',
        OLD."id", OLD."kind";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Notification_t4d_binding" ON "Notification";
CREATE TRIGGER "Notification_t4d_binding" BEFORE UPDATE OR DELETE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_notification_binding();

CREATE OR REPLACE FUNCTION platform_t4d_notification_binding_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE e RECORD;
BEGIN
  IF NEW."eventId" IS NULL THEN
    -- A legacy or drain-window notice, which carries no event. Admitted; 4d-iii is where a
    -- kinded notice becomes required to name one.
    IF NEW."kind" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: notice % declares kind `%` but names no event — a KINDED notice is a derived artifact of a specific act, and one that names no act cannot be retired by identity',
        NEW."id", NEW."kind";
    END IF;
    RETURN NULL;
  END IF;

  SELECT "projectId", "entityType", "entityId", "eventType" INTO e FROM "DomainEvent"
   WHERE "projectId" = NEW."projectId" AND "eventId" = NEW."eventId";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % names event %, which does not exist in project % at commit',
      NEW."id", NEW."eventId", NEW."projectId";
  END IF;

  -- THE KIND IS THE EVENT'S TYPE (#582's review round 7, finding 5). §A.3 obligation 7 states it
  -- in those words — "exactly ONE `Notification` … whose `kind` equals that event's `eventType`"
  -- (plan line 4507) — and this binding read the event's project, entity type and entity id and
  -- never its TYPE. So a hand-run bundle could bind a notice with kind `decision.change_requested`
  -- to a `decision.approved` event about the same decision: the composite FK holds, the
  -- entity-correspondence clauses above hold, and the kinded freeze then makes the false kind
  -- IMMUTABLE. That is the failure `kind` exists to prevent (#555's review round 2, finding 7:
  -- a feed row saying the decision was rejected when it was countersigned), arriving through the
  -- one column the readers trust — every reader RENDERS a kinded row from `kind`, so a wrong
  -- kind is a wrong announcement no display-text check can catch.
  --
  -- A KINDLESS row is untouched: it is the legacy and drain-window shape, served from its stored
  -- text, and 4d-iii is where a notice bound to an event is required to declare a kind at all.
  IF NEW."kind" IS NOT NULL AND NEW."kind" IS DISTINCT FROM e."eventType" THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % declares kind `%` but names event %, which is a `%` — a kinded notice is RENDERED from its kind, so a kind that disagrees with its own event announces something that did not happen, and the freeze below is about to make it permanent',
      NEW."id", NEW."kind", NEW."eventId", e."eventType";
  END IF;
  IF NEW."decisionId" IS NOT NULL
     AND (e."entityType" <> 'Decision' OR e."entityId" IS DISTINCT FROM NEW."decisionId") THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % is stamped with decision % but names an event about %/% — the stamp and the event must be about the same thing, or retiring the notice by identity retires the wrong one',
      NEW."id", NEW."decisionId", e."entityType", e."entityId";
  END IF;

  -- A DECISION EVENT'S NOTICE NAMES ITS DECISION (#582 round 6, finding 4). The clause above
  -- guards a stamp that IS present and said nothing about one that is absent, so a hand-run
  -- bundle could insert a kinded `decision.forwarded` notice with the right project and the right
  -- event and a NULL `decisionId` — and skip the correspondence entirely. That is not a cosmetic
  -- gap: the kinded reader runs `decisionVisibleToViewer` off `decisionId`, so with none there is
  -- no decision to judge visibility against, and the legacy null-id fallback filters pending-TEXT
  -- notices only. The forwarding notice would be shown to viewers who cannot see the decision it
  -- announces. NULL stays legitimate for a notice whose event is about something else.
  IF e."entityType" = 'Decision' AND NEW."decisionId" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % names event %, which is about decision %, but carries no `decisionId` — a notice about a decision is READ through that stamp (the kinded reader judges visibility by it), and an unstamped one is rendered to viewers the decision itself would exclude',
      NEW."id", NEW."eventId", e."entityId";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Notification_t4d_binding_bound" ON "Notification";
CREATE CONSTRAINT TRIGGER "Notification_t4d_binding_bound"
  AFTER INSERT ON "Notification" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_notification_binding_bound();

-- A notice is NOT append-only — the withdraw path deletes a now-false pending notice by
-- identity, which is the whole reason `decisionId` and now `eventId` are stamped. What it may
-- not be is TRUNCATED: the row seal above is a ROW trigger and never fires for TRUNCATE, so a
-- wipe would erase the bindings the seal exists to protect. Its own message, because neither
-- the fact wording ("append-only register") nor the register wording ("projected from the orgs
-- tables") is true of a notice feed.
CREATE OR REPLACE FUNCTION platform_t4d_notification_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "Notification" carries the event-binding seal and is never truncated — the row seal is a ROW trigger and does not fire for TRUNCATE, so a wipe would erase exactly the bindings it protects. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME, and truncates "Notification" TOGETHER WITH "DomainEvent".';
END $$;

DROP TRIGGER IF EXISTS "Notification_t4d_no_truncate" ON "Notification";
CREATE TRIGGER "Notification_t4d_no_truncate" BEFORE TRUNCATE ON "Notification"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_notification_no_truncate();

-- ── the catalog's own seals ──────────────────────────────────────────────────────────────────
-- The catalog is what the pairing, envelope and transition seals READ, so whoever can change a
-- row can change what those seals judge. §A.2 states the rule as: rows are written ONLY by
-- migrations under a named gate, DELETE refused, and UPDATE refused EXCEPT the one retirement
-- stamp.
--
-- The first version of this file refused DELETE and froze `effectKey`/`eventType` only, while its
-- own comment claimed "every other column is frozen" (Codex round 1, finding 5 — the sentence was
-- right and the code was not, the same shape as the transaction predicates in R1-A). An ordinary
-- depth-1 UPDATE could set `pairingRequired = false`, switching fact/event correspondence off for
-- a whole event type, or rewrite `pushRoles` to redirect a trusted audience with no provenance at
-- all.
CREATE OR REPLACE FUNCTION platform_t4d_effect_catalog_sealed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- the 4c-iii-r mistake-proofing shape: a migration DECLARES itself, and nothing else writes.
    IF COALESCE(current_setting('vitan.phase6_4d_catalog', true), '') <> 'on' THEN
      RAISE EXCEPTION
        'phase6 4d-i: catalog entry `%` at coverage `%` was inserted outside a catalog migration — these rows are what the pairing, envelope and transition seals judge, so they are written only under `SET vitan.phase6_4d_catalog = ''on''` by a migration that says so',
        NEW."effectKey", NEW."coverageVersion";
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'phase6 4d-i: catalog entry `%` at coverage `%` may not be DELETED — a historical event''s key must still resolve, and a missing row silently switches the pairing seal off for its whole event type. An effect leaves service by being RETIRED.',
      OLD."effectKey", OLD."coverageVersion";
  END IF;

  -- THE ONE ADMITTED UPDATE: the retirement stamp, NULL → a timestamp, under the same gate.
  -- Everything else about the row is evidence and does not move.
  IF NEW."coverageVersion" IS DISTINCT FROM OLD."coverageVersion"
     OR NEW."effectKey"      IS DISTINCT FROM OLD."effectKey"
     OR NEW."eventType"      IS DISTINCT FROM OLD."eventType"
     OR NEW."invalidate"     IS DISTINCT FROM OLD."invalidate"
     OR NEW."pushRoles"      IS DISTINCT FROM OLD."pushRoles"
     OR NEW."pushFamily"     IS DISTINCT FROM OLD."pushFamily"
     OR NEW."frozenAudience" IS DISTINCT FROM OLD."frozenAudience"
     OR NEW."requiresPush"   IS DISTINCT FROM OLD."requiresPush"
     OR NEW."audience"       IS DISTINCT FROM OLD."audience"
     OR NEW."pushBody"       IS DISTINCT FROM OLD."pushBody"
     OR NEW."pairingRequired" IS DISTINCT FROM OLD."pairingRequired" THEN
    RAISE EXCEPTION
      'phase6 4d-i: catalog entry `%` at coverage `%` is frozen — the ONLY admitted update is the retirement stamp. Switching `pairingRequired` off would disable fact/event correspondence for a whole event type, and rewriting `pushRoles` or `audience` would redirect a trusted audience with no provenance; a definition changes by a NEW coverage version, never in place.',
      OLD."effectKey", OLD."coverageVersion";
  END IF;

  IF NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
    IF OLD."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: catalog entry `%` was retired at % — retirement is a ONE-WAY stamp and un-retiring an effect would revive a dispatch plan the release no longer implements',
        OLD."effectKey", OLD."retiredAt";
    END IF;
    IF COALESCE(current_setting('vitan.phase6_4d_catalog', true), '') <> 'on' THEN
      RAISE EXCEPTION
        'phase6 4d-i: catalog entry `%` is retired by a catalog MIGRATION under `SET vitan.phase6_4d_catalog = ''on''`, never by an ordinary statement',
        OLD."effectKey";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ExternalEffectCatalog_t4d_sealed" ON "ExternalEffectCatalog";
CREATE TRIGGER "ExternalEffectCatalog_t4d_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "ExternalEffectCatalog"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_effect_catalog_sealed();

DROP TRIGGER IF EXISTS "ExternalEffectCatalog_t4d_no_truncate" ON "ExternalEffectCatalog";
CREATE TRIGGER "ExternalEffectCatalog_t4d_no_truncate" BEFORE TRUNCATE ON "ExternalEffectCatalog"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_register_no_truncate();

-- ── the release lease's seals ────────────────────────────────────────────────────────────────
-- Identity FROZEN after insert, the ONLY admitted update a NON-DECREASING `leaseUntil`, DELETE
-- refused, `ReleaseLease_t4d_no_truncate` in `TRUNCATE_SEALS` (plan lines 401 and 6712; P38's
-- sentence: "a `ReleaseLease` row's `instanceId`/`release`/`catalogVersion`/`startedAt` UPDATE
-- refused, a `leaseUntil` decrease refused, DELETE and TRUNCATE refused, the renewal admitted").
--
-- The direction matters as much as the freeze. A live lower-version lease that could be
-- SHORTENED — `leaseUntil` moved back to the past — would read to 4d-iii's preflight exactly
-- like a stopped process, and the preflight would retire the doors while that process still
-- served: the same hole as a DELETE, reached through an UPDATE. Only forward, therefore, and
-- INSERT is unsealed because 4d-ii's startup writer is the one that establishes the identity
-- this seal then holds still.
CREATE OR REPLACE FUNCTION platform_t4d_release_lease_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease % (release %, catalog version %) may not be DELETED — the drain attestation rests on which generation was serving and until when; a stopped process''s lease EXPIRES and stays as history, and a lease that can be removed attests to nothing',
      OLD."instanceId", OLD."release", OLD."catalogVersion";
  END IF;

  IF NEW."instanceId" IS DISTINCT FROM OLD."instanceId"
     OR NEW."release" IS DISTINCT FROM OLD."release"
     OR NEW."catalogVersion" IS DISTINCT FROM OLD."catalogVersion"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease %''s identity (release %, catalog version %, started %) is FROZEN — only `leaseUntil` moves. Re-versioning a live lease into the minimum is how a preflight is talked into retiring the doors while an older generation still serves; a process at another version writes its OWN row.',
      OLD."instanceId", OLD."release", OLD."catalogVersion", OLD."startedAt";
  END IF;

  IF NEW."leaseUntil" < OLD."leaseUntil" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease %''s expiry may not move BACKWARD (% → %) — renewal extends a lease, and shortening one makes a still-serving process read as stopped, which is the DELETE this seal refuses reached through an UPDATE',
      OLD."instanceId", OLD."leaseUntil", NEW."leaseUntil";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ReleaseLease_t4d_frozen" ON "ReleaseLease";
CREATE TRIGGER "ReleaseLease_t4d_frozen" BEFORE UPDATE OR DELETE ON "ReleaseLease"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_release_lease_frozen();

DROP TRIGGER IF EXISTS "ReleaseLease_t4d_no_truncate" ON "ReleaseLease";
CREATE TRIGGER "ReleaseLease_t4d_no_truncate" BEFORE TRUNCATE ON "ReleaseLease"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_register_no_truncate();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3f — THE DELIVERED SEALS, WIDENED
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Everything above ADDS. This part CHANGES delivered behaviour, so each edit states what it
-- opens and why the opening cannot be used for anything else.

-- ── the holder freeze gains exactly ONE opening ──────────────────────────────────────────────
-- `decision_t4b_attribution_seal` is the trigger that ACTUALLY freezes the holder — its
-- published-or-attributed arm refuses any change to `deciderKind` or `deciderMembershipId`. Not
-- `phase6_t4b2_decision_seal`, whose arms are the role arms; naming the wrong one is how a
-- previous round's fix reached the wrong object.
--
-- THREE changes, in ONE `CREATE OR REPLACE`, and nothing else moves:
--
--   (1) THE FORWARD DOOR. The holder freeze admits a change accompanied by a same-transaction
--       `DecisionForward` row whose `fromDesignation` EQUALS the OLD holder columns, whose
--       `toDesignation` EQUALS the NEW ones, and whose two designations DIFFER. Mere row
--       presence is forgeable — a hostile transaction could insert a forward naming unrelated
--       designations and re-home the holder to a third member — so the seal compares the
--       transition to its evidence FIELD-FOR-FIELD, and the forward's own INSERT seal compares
--       `from` against the decision's CURRENT holder. Together they force the order: the
--       forward is written FIRST, the holder moves second, and neither is valid without the
--       other.
--
--   (2) THE TUPLE-WRITE ARM admits `→ awaiting_countersign` beside `→ approved`. Under a chain
--       the approval is PROVISIONAL: the tuple is written by the provisional act exactly as the
--       finalizing act wrote it, and the delivered arm — which admits the tuple's first write
--       only on `pending`/`change → approved` — would abort that transition before any 4d
--       pairing seal ran (#567's review round 2, finding 3).
--
--   (3) THE STANDING ARM admits `change → awaiting_countersign` beside `change → approved`, and
--       ONLY from `change`. The chain reapproval leaves `change` provisionally; an `approved`
--       decision never returns to awaiting, so that direction stays refused.
--
-- The INSERT clause is KEPT unchanged: a tuple belongs only to an approved decision, because a
-- decision is never BORN awaiting — the approved-entry seal's INSERT arm below refuses that
-- outright, and the seed plants no such row.
CREATE OR REPLACE FUNCTION decision_t4b_attribution_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_writes_tuple BOOLEAN;
  v_forwarded    BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4b: decision register identity is frozen from birth (%).', OLD."id";
    END IF;

    -- Round 1 (Codex F1): publication is a permanent register fact. Without this arm the holder
    -- freeze below could be unlocked in two transactions — clear `publishedAt`, then rewrite the
    -- holder while `OLD."publishedAt" IS NULL`. Nothing in the product ever un-publishes a
    -- decision (publish is a one-way `publishedAt IS NULL` transition), so refusing it costs the
    -- compatibility writer nothing and removes the nullable value's power to reopen the seal.
    IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-4b: a published decision cannot be un-published — publication is permanent (%).', OLD."id";
    END IF;

    -- Phase 6 unit 4d-i, change (1): the ONE opening in the holder freeze. Evaluated only when
    -- the holder actually moves, so an ordinary update pays nothing for it.
    v_forwarded := FALSE;
    IF (NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
        OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId") THEN
      -- IN THIS TRANSACTION (Codex round 1, finding 8). Without the `xmin` predicate this door
      -- accepted ANY historical forward fact: after legitimate moves A→B and B→A, a third direct
      -- update A→B reuses the FIRST append-only fact, passes, and moves the holder with no new
      -- fact, no command receipt, no event, no audit row and no notice. The refusal message below
      -- already said "a same-transaction row"; now the query says it too.
      v_forwarded := EXISTS (
        SELECT 1 FROM "DecisionForward" f
         WHERE f."projectId" = OLD."projectId" AND f."decisionId" = OLD."id"
           AND f."fromDesignationKind" = OLD."deciderKind"::text
           AND f."fromDesignationMembershipId" IS NOT DISTINCT FROM OLD."deciderMembershipId"
           AND f."toDesignationKind" = NEW."deciderKind"::text
           AND f."toDesignationMembershipId" IS NOT DISTINCT FROM NEW."deciderMembershipId"
           AND f."xmin" = txid_current()::text::xid
      );
    END IF;

    -- Round 1 (Codex F1): the freeze must not rest on the current nullable publication value
    -- alone. An approval tuple, approval/change standing, or a migration stamp each name the
    -- holder just as durably as publication does — an unpublished row carrying any of them
    -- would otherwise let its current holder drift away from the frozen approval claim, making
    -- the trusted evidence contradict itself. None of the four can be cleared first to reopen
    -- this arm: publication is permanent (above), the tuple is frozen and approval/change
    -- standing cannot be left (below), and the stamp is migration-owned and sealed.
    IF (
         OLD."publishedAt" IS NOT NULL
      OR OLD."approvedDeciderKind" IS NOT NULL
      OR OLD."status"::text IN ('approved', 'change', 'withdrawn')
      OR EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = OLD."id")
    ) AND (
         NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
      OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId"
    ) AND NOT v_forwarded THEN
      RAISE EXCEPTION 'phase6-4b: a published or attributed decision keeps its holder — the decider tuple is frozen (%). Phase 6 unit 4d opens exactly one door: a same-transaction "DecisionForward" row recording THIS hand-off, from the holder the decision actually carries to the one it is moving to.', OLD."id";
    END IF;

    IF OLD."approvedDeciderKind" IS NOT NULL AND (
         NEW."approvedDeciderKind" IS DISTINCT FROM OLD."approvedDeciderKind"
      OR NEW."approvedDeciderMembershipId" IS DISTINCT FROM OLD."approvedDeciderMembershipId"
      OR NEW."approvedDeciderLabel" IS DISTINCT FROM OLD."approvedDeciderLabel"
    ) THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution is frozen once written (%).', OLD."id";
    END IF;

    -- An approval can reopen to `change` and close back to `approved`; it cannot be laundered
    -- into a status that says the approval never happened. Tupleless old-writer rows are covered
    -- by the status itself and by their migration stamp.
    --
    -- Phase 6 unit 4d-i, change (3): `change → awaiting_countersign` joins the permitted
    -- destinations, and ONLY from `change` — the chain reapproval leaves `change`
    -- provisionally, while an `approved` decision never returns to awaiting.
    IF OLD."status"::text IN ('approved', 'change')
       AND NEW."status"::text NOT IN ('approved', 'change')
       AND NOT (OLD."status"::text = 'change' AND NEW."status"::text = 'awaiting_countersign') THEN
      RAISE EXCEPTION 'phase6-4b: an approval-bearing decision cannot leave approved/change standing (%).', OLD."id";
    END IF;

    v_writes_tuple := OLD."approvedDeciderKind" IS NULL
      AND NEW."approvedDeciderKind" IS NOT NULL;
    -- Phase 6 unit 4d-i, change (2): a PROVISIONAL approval writes the tuple exactly as the
    -- finalizing act would, so `→ awaiting_countersign` joins `→ approved` here.
    IF v_writes_tuple AND NOT (
      OLD."status"::text IN ('pending', 'change')
      AND NEW."status"::text IN ('approved', 'awaiting_countersign')
    ) THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution may first be written only by an approval transition (%).', OLD."id";
    END IF;
  ELSE
    v_writes_tuple := NEW."approvedDeciderKind" IS NOT NULL;
    IF v_writes_tuple AND NEW."status"::text <> 'approved' THEN
      RAISE EXCEPTION 'phase6-4b: an inserted approval tuple belongs only to an approved decision (%).', NEW."id";
    END IF;
  END IF;

  IF v_writes_tuple THEN
    IF NEW."approvedDeciderKind" IS DISTINCT FROM NEW."deciderKind"
       OR NEW."approvedDeciderMembershipId" IS DISTINCT FROM NEW."deciderMembershipId" THEN
      RAISE EXCEPTION 'phase6-4b: approval attribution must freeze the decision holder tuple (%).', NEW."id";
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- ── the approved-entry seal ──────────────────────────────────────────────────────────────────
-- Every entry into `awaiting_countersign` is sealed FROM THE DECISION SIDE: legal only FROM
-- `pending`/`change`, and only under an ACTIVE chain. Its INSERT arm refuses a decision BORN
-- awaiting outright (#567's review round 2, finding 2): after 4d-iii drops
-- `Decision_t4d_awaiting_reserved`, a direct INSERT of a published row already carrying the
-- status would pass the delivered 4b INSERT seal — which judges publication and holder standing
-- — and commit with no provisional revision, receipt, demand event, audit row or notice. That is
-- a head the countersign and the stranded resolution could never finalize. The state is ENTERED
-- through the sealed transition, never born.
CREATE OR REPLACE FUNCTION phase6_t4d_approved_entry_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text = 'awaiting_countersign' THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % may not be BORN `awaiting_countersign` — the state is entered by the sealed provisional-approval transition, and a row inserted straight into it carries no provisional revision, no receipt and no demand event, so nothing could ever finalize it',
        NEW."id";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status"::text = 'awaiting_countersign' AND OLD."status"::text <> 'awaiting_countersign' THEN
    IF OLD."status"::text NOT IN ('pending', 'change') THEN
      RAISE EXCEPTION
        'phase6 4d-i: decision % may not enter `awaiting_countersign` from `%` — a provisional approval is made from an OPEN decision',
        OLD."id", OLD."status";
    END IF;
    IF platform_role_standing(OLD."projectId", 'architect') = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i: project % holds no ACTIVE architect, so decision % cannot enter `awaiting_countersign` — with the chain off an approval lands `approved` directly, and a decision left awaiting a countersigner who does not exist is stranded from birth',
        OLD."projectId", OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- NAMED so it sorts AFTER both `Decision_t4d_architect_reserved` and
-- `Decision_t4d_awaiting_reserved`. PostgreSQL fires same-kind triggers in NAME order, and while
-- the reservation stands the DOOR must be the thing that refuses — its message names the drain
-- directive an operator can act on, where this seal would report "no active architect", which is
-- true but sends the reader somewhere else. `entry` sorts after `architect`/`awaiting`;
-- `approved_entry` would have sorted before both.
DROP TRIGGER IF EXISTS "Decision_t4d_approved_entry" ON "Decision";
DROP TRIGGER IF EXISTS "Decision_t4d_entry_seal" ON "Decision";
CREATE TRIGGER "Decision_t4d_entry_seal" BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_approved_entry_seal();

-- ── the LAST reservation door ────────────────────────────────────────────────────────────────
-- `DecisionForward` is reserved with the other four (§A.2). Forwarding needs no architect, so
-- without this door 4d-ii's `decisions.forward` would emit `decision.forwarded` while an
-- ALREADY-RUNNING previous-release push worker — fenced by the consumer version bump only when
-- it RESTARTS — could still claim that delivery, know no `forward` family, and take the
-- unguarded send path. Dropped by the same single 4d-iii statement as the other four.
DO $$
DECLARE tg pg_trigger;
BEGIN
  IF phase6_t4d_retired_at_start() THEN RETURN; END IF;

  SELECT * INTO tg FROM pg_trigger
   WHERE tgname = 'DecisionForward_t4d_reserved'
     AND tgrelid = '"DecisionForward"'::regclass AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER "DecisionForward_t4d_reserved" BEFORE INSERT ON "DecisionForward"
      FOR EACH ROW EXECUTE FUNCTION phase6_t4d_reserved('DecisionForward');
  ELSIF tg.tgenabled <> 'O'
     OR tg.tgfoid::regproc::text <> 'phase6_t4d_reserved'
     OR tg.tgtype <> 7 THEN               -- EXACTLY ROW(1) + BEFORE(2) + INSERT(4)
    RAISE EXCEPTION
      'phase6 4d-i: DecisionForward_t4d_reserved exists but does not reserve the table (enabled=%, function=%, tgtype=%). See docs/RUNBOOK.md §P6T4D.',
      tg.tgenabled, tg.tgfoid::regproc::text, tg.tgtype;
  END IF;
END $$;

-- -- the two 4c consultation seals, open set widened ------------------------------------------
-- These CANNOT be widened by a second trigger: the delivered seals REFUSE an
-- `awaiting_countersign` decision, and no other trigger can un-refuse what one has raised on. So
-- both functions are reproduced here VERBATIM with exactly ONE token changed in each -- the open
-- set gains `awaiting_countersign` -- and nothing else moves.
--
-- In particular the REQUESTER ARM stays on `phase6_user_decision_authority`, byte-identical.
-- That is the WINDOW RULE of A.2 (#566's review round 2, finding 1): through the drain a
-- membership-less org owner/admin has no fanned-out `pmc` row, so re-pointing the arm onto the
-- register here would refuse exactly the requester the delivered access path authorizes.
-- 4d-iii re-points it after the fenced re-projection, when the register can answer.
--
-- The bodies are PINNED before they are replaced. `CREATE OR REPLACE` on a function whose
-- delivered body has changed since would silently revert that change, so the migration asserts
-- the body it is about to overwrite is the one it was written against and ABORTS otherwise --
-- the same claim the repository's `t3c seals` preflight makes about function-BODY identity.
DO $pin$
DECLARE v_body TEXT; v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'phase6_t4c_consultation_request_seal', 'phase6_t4c_consultation_response_seal'
  ] LOOP
    SELECT prosrc INTO v_body FROM pg_proc WHERE proname = v_name;
    IF v_body IS NULL THEN
      RAISE EXCEPTION 'phase6 4d-i: % does not exist -- 4d-i widens the 4c consultation open set and cannot do so over a database that never installed it', v_name;
    END IF;
    -- Nested dollar quoting, so the searched fragment carries its own single quotes
    -- literally and no doubling has to be got right by eye.
    IF strpos(v_body, $frag$'pending', 'change'$frag$) = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i ABORT: the body of % no longer carries the delivered open set this migration was written to widen. Replacing it now would silently revert whatever changed it. Re-derive the widening against the current body before deploying. See docs/RUNBOOK.md P6T4D.',
        v_name;
    END IF;
  END LOOP;
END $pin$;

CREATE OR REPLACE FUNCTION phase6_t4c_consultation_request_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  -- §B.1 try-acquire-or-refuse: reentrant on the service path (the command already holds the
  -- key), acquired and held to commit on a free direct write, REFUSED when contended — a seal
  -- never waits inside a trigger, so no lock-order inversion can exist.
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct consultation write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no consultation may be recorded against it', NEW."projectId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", NEW."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is not ACTIVE on this project — a request for a removed member would become answerable if they were ever restored (%)', NEW."id";
  END IF;
  -- the WRONG-AUDIENCE forgery: `consulteeUserId` is the projection's REBUILDABLE audience, so an
  -- arbitrary user there would mint a projected slice — and a widened view — for a stranger.
  IF NEW."consulteeUserId" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: the recorded audience is not the user this membership resolves to — the canonical audience may not be forged (%)', NEW."id";
  END IF;
  -- the contract's actor-standing obligation, applied to this fact's RECORDED actor
  IF NOT phase6_user_decision_authority(NEW."projectId", NEW."requestedById") THEN
    RAISE EXCEPTION 'phase6-4c: the recorded requester holds no active authority to ask for advice on this project (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: decision % is not in this project', NEW."decisionId";
  END IF;
  -- eligibility: PUBLISHED (status alone admits an author-private draft whose status is
  -- `pending`) and still OPEN. Never `withdrawn` (whose title and reason are pmc-only — a
  -- consultation there leaks exactly what 4a hides), `approved` or `recorded` (nothing to inform).
  IF d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION 'phase6-4c: a consultation belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- the INITIAL cycle is SEALED, not merely compared later: a command bug storing `current + 1`
  -- would mint a consultation unanswerable now that becomes answerable after ONE approve-and-
  -- reopen — the exact revival this column exists to prevent, arriving through a legitimate writer.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId";
  IF NEW."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: the frozen open cycle % is not the decision''s current approval count % — a consultation is born in the cycle it was asked in', NEW."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.request', NEW."requestedById", NEW."id");
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION phase6_t4c_consultation_response_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD; v_user TEXT; d RECORD; v_cycle INT;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: the project readiness key is held elsewhere — this direct response write is refused rather than waiting inside a trigger (%)', NEW."id";
  END IF;
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6-4c: project % is archived — no advice may be recorded against it', NEW."projectId";
  END IF;

  SELECT "consulteeMembershipId", "openCycle", "decisionId" INTO c FROM "DecisionConsultation"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."consultationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'phase6-4c: no consultation % in this project', NEW."consultationId";
  END IF;

  v_user := phase6_membership_active_user(NEW."projectId", c."consulteeMembershipId");
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'phase6-4c: the consultee membership is no longer ACTIVE — a removed member cannot append immutable advice (%)', NEW."id";
  END IF;
  -- without a recorded actor compared against the named consultee, a raw writer could forge advice
  -- presented forever as the member's own
  IF NEW."respondedById" IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'phase6-4c: only the named consultee may be recorded as the responder (%)', NEW."id";
  END IF;

  SELECT "status"::text AS status, "publishedAt" INTO d FROM "Decision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."decisionId" FOR SHARE;
  IF NOT FOUND OR d."publishedAt" IS NULL OR d.status NOT IN ('pending', 'change', 'awaiting_countersign') THEN
    RAISE EXCEPTION 'phase6-4c: advice belongs only to a PUBLISHED, still-open decision — % is not one', NEW."decisionId";
  END IF;

  -- eligibility is not a STATUS test alone. Approve then `requestChange` returns the decision to
  -- an open status while the append-only consultation row remains by design; a status-only guard
  -- would REVIVE a consultation the approval already closed and mix two decision cycles in one
  -- immutable thread. Asking again in the new cycle means a NEW consultation.
  SELECT count(*) INTO v_cycle FROM "DecisionApprovalRevision" r WHERE r."decisionId" = NEW."decisionId";
  IF c."openCycle" IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'phase6-4c: this consultation belongs to cycle %, and the decision is now in cycle % — an approval permanently closes the consultations of the cycle it ended', c."openCycle", v_cycle;
  END IF;

  PERFORM phase6_t4c_provenance_reserved(NEW."projectId", NEW."sourceCommandId", 'consultations.respond', NEW."respondedById", NEW."id");
  RETURN NEW;
END $$;

-- ── the architect arms: SEPARATE triggers, the delivered arms untouched ──────────────────────
-- §D asks for "SEPARATE architect arms over `platform_role_standing`, the delivered `client`/`pmc`
-- arms untouched" (#565's review round 1, finding 1). Separate TRIGGERS, not a rewritten
-- function: `phase6_t4b2_decision_seal` and `phase6_t4b2_membership_guard` are large delivered
-- objects, and reproducing either to add one arm risks reverting a change made since. A second
-- trigger adds refusals without touching a byte of the first, and `t4d` sorts after `t4b2`, so
-- the delivered arms still refuse first for every role they already judge.
--
-- WHY THE ARCHITECT ARM READS A DIFFERENT PRIMITIVE: `phase6_effective_role_standing` answers
-- for `client`/`pmc` and knows nothing of `architect` — it is the delivered orgs derivation, and
-- teaching it the new role would put the chain's meaning in the wrong module. The architect
-- count lives in the platform register, so the architect arm reads `platform_role_standing`.

CREATE OR REPLACE FUNCTION phase6_t4d_holder_standing_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deciderKind"::text <> 'architect' THEN RETURN NEW; END IF;

  -- A row born ALREADY PUBLISHED, and the publication boundary, and the reopen — the same three
  -- boundaries the delivered seal judges for `client`/`pmc`, asked of the architect role.
  IF (TG_OP = 'INSERT' AND NEW."publishedAt" IS NOT NULL
      AND NEW."status"::text IN ('pending', 'change'))
     OR (TG_OP = 'UPDATE' AND OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND OLD."status"::text = 'approved' AND NEW."status"::text = 'change') THEN
    IF platform_role_standing(NEW."projectId", 'architect') = 0 THEN
      RAISE EXCEPTION
        'phase6 4d-i: this project has no active architect — a decision designated to the architect role would be born with nobody able to decide it (decision %)',
        NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4d_holder_standing" ON "Decision";
CREATE TRIGGER "Decision_t4d_holder_standing" BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_holder_standing_seal();

-- ── the membership guard's widened open set, and its ONE named exemption ─────────────────────
-- P39 states the rule exactly, and it is two claims, not one:
--
--   * THE OPEN SET WIDENS. An `awaiting_countersign` decision is OPEN, so removing or re-roling
--     its NAMED holder, or the last active member of its ROLE designation, is refused — at the
--     command through `holdsOpenDecisions` (4d-ii) and here at the database.
--
--   * THE ONE EXEMPTION. Removing the LAST ARCHITECT is NOT refused, even when that architect is
--     the named holder of an awaiting decision or the last member of the architect ROLE
--     designation it names. That departure DEACTIVATES the chain and STRANDS the decision, which
--     is a defined state with a named command to resolve it
--     (`decisions.resolveStrandedCountersign`); refusing it would instead trap the project —
--     the architect could never leave while any decision awaited their countersign.
--
--   The exemption is narrow in both directions, and both are probed:
--     · a named holder who IS an architect but NOT the last is REFUSED, naming the pending
--       countersign — the chain survives their departure, so the decision is not stranded and
--       has no defined resolution;
--     · a `pending`/`change` decision designated to the architect ROLE still REFUSES removing
--       its last architect — that decision is not awaiting a countersign, it is waiting for a
--       DECISION, and stranding has nothing to say about it.
--
-- The delivered `phase6_decisions_hold_role` / `phase6_decisions_name_membership` are LEFT
-- ALONE. Widening them would make the DELIVERED guard — which has no exemption — refuse the last
-- architect's departure, which is the one thing this rule exists to permit. So the widened open
-- set lives in this trigger's own predicates.
--
-- AFTER ROW, like the guard it sits beside, and the count it reads is therefore the POST-write
-- one: `Membership_t4d_role_standing` is a BEFORE trigger and has already applied its delta.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_project    TEXT := COALESCE(NEW."projectId", OLD."projectId");
  v_lost_role  TEXT;
  v_membership TEXT;
  v_architects INT;
BEGIN
  -- Only a write that can REDUCE holder-relevant standing is judged; a pure display or limit
  -- update passes untouched, exactly as the delivered guard decides it.
  IF TG_OP = 'UPDATE'
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF OLD."status" <> 'active' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" = 'active' AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;

  v_lost_role  := OLD."role";
  v_membership := OLD."id";
  v_architects := platform_role_standing(v_project, 'architect');

  IF NOT phase6_try_readiness(v_project) THEN
    RAISE EXCEPTION 'phase6 4d-i: the project readiness key is contended — retry this membership change (project %)', v_project;
  END IF;

  -- (a) the NAMED holder of an AWAITING decision
  IF EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = v_project AND d."deciderMembershipId" = v_membership
       AND d."publishedAt" IS NOT NULL AND d."status"::text = 'awaiting_countersign'
  ) AND NOT (v_lost_role = 'architect' AND v_architects = 0) THEN
    RAISE EXCEPTION
      'phase6 4d-i: membership % is the named holder of a decision awaiting countersign — resolve or forward it before removing them (project %). The one exception is the LAST architect leaving, which deactivates the chain and strands the decision for `decisions.resolveStrandedCountersign`; this project still holds % active architect(s).',
      v_membership, v_project, v_architects;
  END IF;

  -- (b) the last active member of a ROLE designation
  IF v_lost_role = 'architect' AND v_architects = 0 THEN
    -- The exemption covers AWAITING decisions only. A `pending`/`change` decision designated to
    -- the architect role is waiting for a DECISION, not for a countersign, and stranding has
    -- nothing to say about it.
    IF EXISTS (
      SELECT 1 FROM "Decision" d
       WHERE d."projectId" = v_project AND d."deciderKind"::text = 'architect'
         AND d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change')
    ) THEN
      RAISE EXCEPTION
        'phase6 4d-i: this change leaves NO active architect while a published OPEN decision is designated to that role (project %) — such a decision is waiting to be DECIDED, not countersigned, so no stranded resolution covers it; forward it or restore standing first',
        v_project;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "Decision" d
     WHERE d."projectId" = v_project AND d."deciderKind"::text = v_lost_role
       AND d."publishedAt" IS NOT NULL AND d."status"::text = 'awaiting_countersign'
  ) AND (
    (v_lost_role = 'architect' AND v_architects = 0)
    OR (v_lost_role <> 'architect' AND phase6_effective_role_standing(v_project, v_lost_role) = 0)
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: this change leaves NO effective % holder while a decision awaiting countersign is designated to that role (project %) — cover it first',
      v_lost_role, v_project;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_holder_guard" ON "Membership";
CREATE TRIGGER "Membership_t4d_holder_guard"
  AFTER UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_guard();

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3e (cont.) — THE APPROVAL REGISTER'S FINALITY KEY
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- THE DELIVERED SEAL IS REPLACED, NEVER STACKED UNDER. The register carries
-- `DecisionApprovalRevision_append_only` (`phase3_immutable_row()`), which rejects EVERY UPDATE
-- — so the countersign's `finalized` false→true flip would abort before the pairing trigger
-- judged it. 4d-i therefore DROPS that trigger in the same transaction that installs the
-- register's own replacement. The old trigger ABSENT and the replacement PRESENT by name are
-- both asserted below, and join `upgrade-proof.sh`.
--
-- The replacement is STRICTLY NARROWER than what it replaces in every direction but one: every
-- DELETE is still refused, every other column is still frozen, and the ONE thing it newly admits
-- is the `finalized` false→true flip — paired, by the deferred trigger of §B.4, to the fact that
-- performed it.
DROP TRIGGER IF EXISTS "DecisionApprovalRevision_append_only" ON "DecisionApprovalRevision";

CREATE OR REPLACE FUNCTION phase6_t4d_revision_one_flip() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'DecisionApprovalRevision is append-only: DELETE is forbidden (revision %)', OLD."id";
  END IF;

  -- Every column but `finalized` compared OLD to NEW. Enumerated rather than "everything except
  -- the one" so a column ADDED later is frozen by default: an unlisted column would otherwise be
  -- silently rewritable the day it appears, which is the failure shape a seal exists to prevent.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."optionKey" IS DISTINCT FROM OLD."optionKey"
     OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
     OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
     OR NEW."onBehalfOf" IS DISTINCT FROM OLD."onBehalfOf"
     OR NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId"
     OR NEW."approvedFrom" IS DISTINCT FROM OLD."approvedFrom"
     OR NEW."approvedByName" IS DISTINCT FROM OLD."approvedByName"
     OR NEW."approvedByRole" IS DISTINCT FROM OLD."approvedByRole" THEN
    RAISE EXCEPTION
      'DecisionApprovalRevision is append-only apart from ONE transition: revision % may only have `finalized` flipped false → true, and every other column is immutable evidence of the approval act',
      OLD."id";
  END IF;

  -- The ONE permitted transition, in ONE direction. A true→false write would un-finalize a
  -- countersigned approval; a true→true write is a no-op that would let a writer touch the row
  -- without changing it, which is not something any command needs to do.
  IF NOT (OLD."finalized" = FALSE AND NEW."finalized" = TRUE) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision %''s finality may only move false → true (saw % → %) — un-finalizing a countersigned approval would present a settled decision as provisional',
      OLD."id", OLD."finalized", NEW."finalized";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_one_flip" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4d_one_flip"
  BEFORE UPDATE OR DELETE ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_one_flip();

-- ── the BIRTH value is sealed too ────────────────────────────────────────────────────────────
-- A revision is BORN `false` under an active chain and `true` without one. Left unsealed, a
-- forged birth is the cheapest attack on the whole mechanism: a revision inserted `true` under a
-- chain is a final approval no architect ever countersigned, and one inserted `false` with no
-- chain can never be finalized, because neither finalizer exists.
CREATE OR REPLACE FUNCTION phase6_t4d_revision_birth() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_chain BOOLEAN;
BEGIN
  IF NOT phase6_try_readiness(NEW."projectId") THEN
    RAISE EXCEPTION 'phase6 4d-i: the project readiness key is held elsewhere — this direct approval-revision write is refused rather than waiting inside a trigger (revision %)', NEW."id";
  END IF;
  v_chain := platform_role_standing(NEW."projectId", 'architect') > 0;

  IF NEW."finalized" <> (NOT v_chain) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % is born finalized=% on a project whose architect chain is %, and the birth value is NOT the writer''s to choose — under a chain an approval is PROVISIONAL until countersigned, without one it is final at the act',
      NEW."id", NEW."finalized", CASE WHEN v_chain THEN 'ACTIVE' ELSE 'inactive' END;
  END IF;

  -- A revision born PROVISIONAL owes the pair its finalizer will emit from: without
  -- `approvedFrom` the countersign cannot know whether to emit `decision.approved` or
  -- `decision.reapproved`, and without the frozen pair the fact seals have nothing to compare.
  -- Legacy and drain-window rows are all born `true` and are untouched by this arm.
  IF NEW."finalized" = FALSE AND (
       NEW."approvedFrom" IS NULL OR NEW."approvedByName" IS NULL OR NEW."approvedByRole" IS NULL
     ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % is born PROVISIONAL and must record the act its finalizer will emit from — `approvedFrom`, `approvedByName` and `approvedByRole` are all required on a revision born unfinalized',
      NEW."id";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_birth" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_t4d_birth"
  BEFORE INSERT ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_birth();

-- ── the FLIP is PAIRED, in both directions (§B.4) — with EXACTLY ONE finalizer ───────────────
-- A finalized-only flip with NEITHER pairing fact is unrepresentable. The two legal finalizers
-- are the `DecisionCountersign` row (the chain path) and the `DecisionStrandedResolution` row
-- with outcome `completed` (the only other one) — so the seal names both and nothing else.
--
-- ONE, not "at least one" (Codex round 1, finding 16). The first version refused only the
-- ABSENCE of both, which admits their PRESENCE together: for a stranded decision, one
-- transaction can insert the `completed` resolution while the architect count is zero, activate
-- an architect, insert a countersign for the same revision, and flip. Both facts are immutable
-- and both claim to have ended the same provisional approval — a permanent contradiction in the
-- register whose whole purpose is to say, unambiguously, which act made an approval final. The
-- count is taken ACROSS the two tables because that is the question: not "did this table supply
-- a finalizer" but "how many finalizers does this revision have".
CREATE OR REPLACE FUNCTION phase6_t4d_revision_flip_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_finalizers BIGINT;
BEGIN
  IF OLD."finalized" = TRUE OR NEW."finalized" = FALSE THEN RETURN NULL; END IF;

  SELECT (
    SELECT count(*) FROM "DecisionCountersign" c
     WHERE c."projectId" = NEW."projectId" AND c."revisionId" = NEW."id"
  ) + (
    SELECT count(*) FROM "DecisionStrandedResolution" s
     WHERE s."projectId" = NEW."projectId" AND s."revisionId" = NEW."id"
       AND s."outcome" = 'completed'
  ) INTO v_finalizers;

  IF v_finalizers = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % was finalized in this transaction with neither a DecisionCountersign nor a `completed` DecisionStrandedResolution naming it — a provisional approval becomes final by an ACT, and a flip with no act behind it is exactly the forgery the register exists to make impossible',
      NEW."id";
  END IF;
  IF v_finalizers > 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % carries % finalizers — a countersign AND a `completed` stranded resolution, or two of one kind, each immutable and each claiming to have ended the same provisional approval. A finalized approval was made final by exactly ONE act, and the register may not record two.',
      NEW."id", v_finalizers;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionApprovalRevision_t4d_flip_paired" ON "DecisionApprovalRevision";
CREATE CONSTRAINT TRIGGER "DecisionApprovalRevision_t4d_flip_paired"
  AFTER UPDATE ON "DecisionApprovalRevision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_revision_flip_paired();

-- The replacement is VERIFIED, not assumed: a `CREATE OR REPLACE` that silently did nothing, or
-- a `DROP TRIGGER IF EXISTS` over a name that had already moved, would leave the register either
-- unsealed or still blanket-immutable, and both are discovered far too late.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'DecisionApprovalRevision_append_only'
                AND tgrelid = '"DecisionApprovalRevision"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: the delivered blanket append-only trigger is still present on "DecisionApprovalRevision" — the finality flip would abort before its pairing trigger judged it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'DecisionApprovalRevision_t4d_one_flip'
                    AND tgrelid = '"DecisionApprovalRevision"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: the replacement one-flip seal is missing from "DecisionApprovalRevision" — the register would be left rewritable.';
  END IF;
END $$;

-- ── the DecisionEvent audit register: append-only, and CORRESPONDING ─────────────────────────
-- The delivered `DecisionEvent_no_withdrawn_approval` refuses the DELETE of an approval row.
-- 4d-i widens that to the whole register: an audit row is the attributable record that an act
-- happened, and a writer who can rewrite or delete one can make a past act say something else.
-- The sanctioned reset disables it BY NAME alongside the delivered seal — that is §A.3's "one
-- new name", and `wipeDecisionEvents` gains it in the same unit.
CREATE OR REPLACE FUNCTION phase6_t4d_decision_event_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-i: "DecisionEvent" is the attributable audit register and is append-only — % is refused (row %). The sanctioned reset (test/integration/fixtures.ts wipeDecisionEvents, prisma/seed.ts) disables this trigger BY NAME.',
    TG_OP, COALESCE(OLD."id", '<unknown>');
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4d_append_only" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4d_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionEvent"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_decision_event_append_only();

-- ── the re-notification's CLAIM ──────────────────────────────────────────────────────────────
-- §A.3 obligation 7 needs exactly ONE claimant per pairing-required event, and the plan names
-- this branch's claimant as the `countersign_renotified` AUDIT ROW itself (#572's review round
-- 19; #582's round 5, finding 7). Every other sealed branch has a FACT TABLE to claim from —
-- a forward, a countersign, a stranded resolution, a transition. The re-notification has none:
-- it re-emits `decision.awaiting_countersign` for a crossing, and the only durable row the act
-- writes is its audit entry. Without a claimant here, the moment 4d-i-b sets `pairingRequired` on
-- that key (the pairing switch-on unit §D carves out of this one) the legitimate
-- `decisions.effects` transaction writes its event and its audit row,
-- creates no claim, and `DomainEvent_t4d_pairing_claimed` aborts it AT COMMIT — the seal killing
-- the act it was built to witness.
--
-- NARROW BY CONSTRUCTION. The `WHEN` clause admits one audit kind, so no other insert on this
-- register reaches the claim; the event is resolved through the kernel's own same-transaction
-- primitive rather than by a lookup this module invents; and a missing event is left to
-- `DecisionEvent_t4d_correspondence`, which is the seal that owes that message. Claiming is all
-- this does — the pairing's converse stays where it belongs, on the kernel's deferred seal.
CREATE OR REPLACE FUNCTION phase6_t4d_renotified_claims_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_project TEXT; v_event TEXT;
BEGIN
  SELECT d."projectId" INTO v_project FROM "Decision" d WHERE d."id" = NEW."decisionId";
  IF v_project IS NULL THEN RETURN NULL; END IF;

  v_event := platform_tx_event(v_project, 'Decision', NEW."decisionId",
                               ARRAY['decision.awaiting_countersign']);
  IF v_event IS NULL THEN RETURN NULL; END IF;

  PERFORM platform_claim_event_pairing(v_project, v_event, 'DecisionEvent', NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionEvent_t4d_renotified_claim" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_t4d_renotified_claim"
  AFTER INSERT ON "DecisionEvent"
  FOR EACH ROW WHEN (NEW."type" = 'countersign_renotified')
  EXECUTE FUNCTION phase6_t4d_renotified_claims_event();

-- ── the WEAK converse: the (kind, committed status) table §A.3 closes ────────────────────────
-- An audit row says an act happened. The correspondence says the same transaction must carry the
-- EVENT that act owes, so an audit trail and a delivery stream cannot disagree about what the
-- system did.
--
-- WHY A TABLE AND NOT A FUNCTION OF THE KIND (round 23, finding 1, replacing round 21's kind →
-- type function): `approved` and `reapproved` map to DIFFERENT events depending on where the
-- decision LANDED. The same `approved` audit row means `decision.approved` when the decision
-- committed `approved`, and `decision.awaiting_countersign` when a chain made that approval
-- PROVISIONAL. A function of the kind alone cannot tell them apart, and would demand the wrong
-- event for one of the two.
--
-- DEFERRED, because the delivered writers insert the audit row BEFORE they emit
-- (`decisions.service.ts`), so an immediate check would judge a transaction that is still
-- correct and merely unfinished. Judged at COMMIT, when the whole transaction is visible.
--
-- WEAK, because this is the 4d-i body: it derives the required event from the TRANSITION alone.
-- 4d-iii replaces it with the FULL converse, which also demands the FACT. A `DecisionEvent`
-- written for a transition this table does not list — the delivered `issued`, `drafted`,
-- `draft_updated`, and `withdrawn` — is untouched: the seal judges only what it admits.
CREATE OR REPLACE FUNCTION phase6_t4d_event_correspondence_weak() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_status   TEXT;
  v_project  TEXT;
  v_required TEXT[];
  v_events   BIGINT;
BEGIN
  SELECT d."status"::text, d."projectId" INTO v_status, v_project
    FROM "Decision" d WHERE d."id" = NEW."decisionId";
  IF v_status IS NULL THEN RETURN NULL; END IF;

  -- THE TABLE. Each row is (audit kind, the status the decision COMMITTED in) → the event types
  -- that kind owes there. A disjunction where the pair genuinely admits two: a countersign emits
  -- `decision.approved` or `decision.reapproved` by the revision's own `approvedFrom`, and which
  -- one is the finalizer's business, not this seal's.
  v_required := CASE
    WHEN NEW."type" = 'approved'    AND v_status = 'approved'              THEN ARRAY['decision.approved']
    WHEN NEW."type" = 'approved'    AND v_status = 'awaiting_countersign'  THEN ARRAY['decision.awaiting_countersign']
    WHEN NEW."type" = 'reapproved'  AND v_status = 'approved'              THEN ARRAY['decision.reapproved']
    WHEN NEW."type" = 'reapproved'  AND v_status = 'awaiting_countersign'  THEN ARRAY['decision.awaiting_countersign']
    WHEN NEW."type" = 'countersigned'      AND v_status = 'approved'       THEN ARRAY['decision.approved', 'decision.reapproved']
    WHEN NEW."type" = 'stranded_resolved'  AND v_status = 'approved'       THEN ARRAY['decision.approved', 'decision.reapproved']
    WHEN NEW."type" = 'stranded_resolved'  AND v_status = 'change'         THEN ARRAY['decision.change_requested']
    WHEN NEW."type" = 'change_requested'   AND v_status = 'change'         THEN ARRAY['decision.change_requested']
    WHEN NEW."type" = 'change_withdrawn'   AND v_status = 'approved'       THEN ARRAY['decision.change_withdrawn']
    WHEN NEW."type" = 'forwarded'                                          THEN ARRAY['decision.forwarded']
    WHEN NEW."type" = 'countersign_renotified'                             THEN ARRAY['decision.awaiting_countersign']
    ELSE NULL
  END;
  IF v_required IS NULL THEN RETURN NULL; END IF;

  -- Through the KERNEL PRIMITIVE, which is what makes "in this transaction" true of the query and
  -- not only of the message (Codex round 1, finding 2). An unscoped existence check let an
  -- approved decision's HISTORICAL `decision.approved` event answer every later `approved` audit
  -- insert, so a direct writer could append a second fabricated row with no emission at all —
  -- and `DecisionEvent_t4d_append_only` then made that false evidence permanent.
  -- EXACTLY ONE, WHICH IS A COUNT AND NOT AN EXISTENCE (#582's review round 7, finding 4).
  -- §A.3 says the audit row and the event record the SAME act; `platform_tx_event_count` was
  -- written for precisely this and its own doc comment says so — "two events for one act are as
  -- wrong as none" — and then nothing called it, which is the THIRD time in this unit a kernel
  -- primitive has been defined with the right rule in its comment and left unwired (round 1's
  -- `platform_tx_event`, round 2's `platform_claim_event_pairing`, this).
  --
  -- The hole an existence check leaves is not theoretical: a hand-run no-chain approval can take
  -- two valid allocator increments, insert two catalog-valid `decision.approved` events at the
  -- two positions it allocated, and append ONE `approved` audit row. Every envelope and
  -- allocation seal passes — each event is well-formed and correctly positioned — and this seal
  -- accepted whichever one `platform_tx_event` returned. The decision is then announced twice
  -- from one act, with two immutable deliveries and one audit row that cannot say which is real.
  v_events := platform_tx_event_count(v_project, 'Decision', NEW."decisionId", v_required);
  IF v_events = 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: the `%` audit row for decision % (committed `%`) has no matching % event in this transaction — the audit register and the delivery stream record the SAME act, and one without the other is a system that cannot say what it did',
      NEW."type", NEW."decisionId", v_status, array_to_string(v_required, ' or ');
  END IF;
  IF v_events > 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: the `%` audit row for decision % (committed `%`) is accompanied by % matching % events in this transaction — one act emits ONE event, and a second announces the same decision twice with nothing to say which is real',
      NEW."type", NEW."decisionId", v_status, v_events, array_to_string(v_required, ' or ');
  END IF;
  RETURN NULL;
END $$;

-- MARKER-AWARE (§D; #572's review round 23, finding 2). On a fresh install or an ordinary
-- upgrade this weak body is correct and is installed. On a P3005 BASELINE REPLAY of a MATURE
-- database — one where `RolloutRetirement` already carries `phase6-4d` — 4d-iii has already
-- replaced this trigger with the FULL converse, and re-pointing it here would DOWNGRADE a live
-- seal while waiting for a stage that has already run.
--
-- The guard is therefore "leave it alone", not "install 4d-iii's body". Carrying a copy of a
-- later unit's body in this file would mean two definitions of one seal drifting apart, and the
-- outcome the plan asks for — the mature database keeps the full body — is exactly what NOT
-- touching it produces.
DO $$
BEGIN
  IF phase6_t4d_retired_at_start() THEN
    RAISE NOTICE 'phase6 4d-i: RolloutRetirement carries phase6-4d — DecisionEvent_t4d_correspondence is left as 4d-iii installed it (this is a replay over a retired database; re-pointing it here would downgrade the live seal to the weak body)';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS "DecisionEvent_t4d_correspondence" ON "DecisionEvent";
  CREATE CONSTRAINT TRIGGER "DecisionEvent_t4d_correspondence"
    AFTER INSERT ON "DecisionEvent" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION phase6_t4d_event_correspondence_weak();
END $$;

-- ── the stream ALLOCATION seals ──────────────────────────────────────────────────────────────
-- `ProjectEventStream.nextPosition` is the allocator for `DomainEvent.streamPosition`, and the
-- guarantee every projection cursor rests on is that positions are issued ONCE, CONTIGUOUSLY,
-- and one per event. §A.2 states that as five objects, and the first version of this file
-- installed two of them with the first weakened (Codex round 1, findings 3 and 7; the jump was
-- already a KNOWN defect — the plan records it as #554's review round 2, finding 1 — so this is
-- a rule the contract had fixed and the implementation re-opened).
--
--   · `_t4d_allocation`      IMMEDIATE, admits ONLY `OLD + 1`. Never a jump, never a decrement.
--   · `_t4d_allocation_bound` DEFERRED, per INCREMENT: the position that increment allocated
--                             (`OLD."nextPosition"`) carries an event of THIS transaction.
--   · `_t4d_init`            BEFORE INSERT, admits only `nextPosition = 0` on a project with no
--                             events — so the row cannot be reintroduced further along.
--   · `_t4d_no_delete`       the row cannot be dropped and recreated to bypass the `+1` rule
--                             (#561's review round 1, finding 7), except under the project
--                             cascade `Project_t4d_deleting` marks.
--   · `_t4d_no_truncate`     the statement-level twin, in `TRUNCATE_SEALS`.
--
-- WHY A JUMP MATTERS, in the product's own terms: starting at N, a direct update to N+2 with no
-- events passed the old pair, and the next legitimate emit then wrote N+2 — leaving N and N+1
-- empty forever. `dispatchOrdered` waits for the next expected position and would never advance
-- past the hole, and every rebuild reports a replay gap.
CREATE OR REPLACE FUNCTION platform_t4d_stream_allocation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."nextPosition" <> OLD."nextPosition" + 1 THEN
    RAISE EXCEPTION
      'phase6 4d-i: the event-stream allocator for project % moves by exactly one (saw % → %) — a jump leaves positions nobody can fill, which stalls `dispatchOrdered` at the hole and makes every rebuild report a replay gap; a decrement re-issues positions that already carry events',
      OLD."projectId", OLD."nextPosition", NEW."nextPosition";
  END IF;
  RETURN NEW;
END $$;

-- PER INCREMENT, not per final value. A DEFERRED constraint trigger fires once per UPDATE and
-- each firing carries the row image FROM THAT UPDATE, which is exactly the granularity this rule
-- needs: `OLD."nextPosition"` is the position THAT increment handed out. (The earlier final-value
-- comparison misread the same fact — it treated a per-update image as the committed state and
-- refused correct transactions, 493 tests across 55 files. The image is not wrong; asking it the
-- wrong question was.)
CREATE OR REPLACE FUNCTION platform_t4d_stream_allocation_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_allocated BIGINT;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RETURN NULL; END IF;
  v_allocated := OLD."nextPosition";
  IF NOT EXISTS (
    SELECT 1 FROM "DomainEvent" e
     WHERE e."projectId" = NEW."projectId"
       AND e."streamPosition" = v_allocated
       AND e."xmin" = txid_current()::text::xid
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: the event-stream allocator for project % issued position % and this transaction wrote no event there — an allocation without its event is a permanent hole in the stream, and allocations are one-to-one with events',
      NEW."projectId", v_allocated;
  END IF;
  RETURN NULL;
END $$;

-- The counter row is BORN at zero on a project that has no events. Without this, a transaction
-- could delete the row and reinsert it further along, no UPDATE trigger firing at all.
CREATE OR REPLACE FUNCTION platform_t4d_stream_init() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."nextPosition" <> 0 THEN
    RAISE EXCEPTION
      'phase6 4d-i: a project event stream is created at position 0 (project % arrived at %) — a stream introduced further along skips positions no event can ever fill',
      NEW."projectId", NEW."nextPosition";
  END IF;
  IF EXISTS (SELECT 1 FROM "DomainEvent" e WHERE e."projectId" = NEW."projectId") THEN
    RAISE EXCEPTION
      'phase6 4d-i: project % already holds events, so its allocator cannot be created afresh at 0 — that would re-issue every position the stream has already used',
      NEW."projectId";
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION platform_t4d_stream_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('phase6.t4d_project_delete', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'phase6 4d-i: the event-stream allocator for project % may not be DELETED — dropping and recreating the row is how the `+1` rule gets bypassed. It goes only with its project, under the deletion cascade.',
    OLD."projectId";
END $$;

DROP TRIGGER IF EXISTS "ProjectEventStream_t4d_allocation" ON "ProjectEventStream";
CREATE TRIGGER "ProjectEventStream_t4d_allocation"
  BEFORE UPDATE ON "ProjectEventStream"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_stream_allocation();

DROP TRIGGER IF EXISTS "ProjectEventStream_t4d_allocation_bound" ON "ProjectEventStream";
CREATE CONSTRAINT TRIGGER "ProjectEventStream_t4d_allocation_bound"
  AFTER UPDATE ON "ProjectEventStream" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_stream_allocation_bound();

DROP TRIGGER IF EXISTS "ProjectEventStream_t4d_init" ON "ProjectEventStream";
CREATE TRIGGER "ProjectEventStream_t4d_init"
  BEFORE INSERT ON "ProjectEventStream"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_stream_init();

DROP TRIGGER IF EXISTS "ProjectEventStream_t4d_no_delete" ON "ProjectEventStream";
CREATE TRIGGER "ProjectEventStream_t4d_no_delete"
  BEFORE DELETE ON "ProjectEventStream"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_stream_no_delete();

DROP TRIGGER IF EXISTS "ProjectEventStream_t4d_no_truncate" ON "ProjectEventStream";
CREATE TRIGGER "ProjectEventStream_t4d_no_truncate"
  BEFORE TRUNCATE ON "ProjectEventStream"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_register_no_truncate();

-- ── the spec tables' finality CARRIER ────────────────────────────────────────────────────────
-- A requirement spec's provenance is an approval that REALLY happened — the delivered FK already
-- says that. 4d adds a second claim: it must be an approval that is FINAL. Under a chain an
-- approval is provisional until countersigned, and a material or labour demand derived from one
-- would be a commitment made on a decision nobody has finished making.
--
-- The mechanism is an FK, not a trigger. `revisionFinalized` exists to CARRY the referenced
-- value: the provenance FK is re-targeted at a widened candidate key that includes the
-- register's `finalized`, so a spec whose carrier says `true` can only bind a revision that IS
-- finalized, judged by the database on every write with no rule for anyone to remember.
--
-- DEFAULT `true` and KEPT: every existing spec references a finalized revision, because before
-- 4d every revision was born final. The CHECK states the rule in the table itself, where a
-- reader meets it — the FK enforces it, and the two agree by construction.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionApprovalRevision_finalized_provenance_key"
  ON "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized");

ALTER TABLE "MaterialRequirementSpec"
  ADD COLUMN IF NOT EXISTS "revisionFinalized" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "LabourRequirementSpec"
  ADD COLUMN IF NOT EXISTS "revisionFinalized" BOOLEAN NOT NULL DEFAULT TRUE;

DO $$ BEGIN
  ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_revisionFinalized_check"
    CHECK ("decisionId" IS NULL OR "revisionFinalized" = TRUE);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_revisionFinalized_check"
    CHECK ("decisionId" IS NULL OR "revisionFinalized" = TRUE);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The RE-TARGET. The old FK is dropped and the widened one added in the same transaction, so no
-- window exists in which a spec's provenance is unconstrained.
ALTER TABLE "MaterialRequirementSpec" DROP CONSTRAINT IF EXISTS "MaterialRequirementSpec_provenance_fkey";
DO $$ BEGIN
  ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_provenance_fkey"
    FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey", "revisionFinalized")
    REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "LabourRequirementSpec" DROP CONSTRAINT IF EXISTS "LabourRequirementSpec_provenance_fkey";
DO $$ BEGIN
  ALTER TABLE "LabourRequirementSpec" ADD CONSTRAINT "LabourRequirementSpec_provenance_fkey"
    FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey", "revisionFinalized")
    REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey", "finalized")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the four consultation attribution columns ────────────────────────────────────────────────
-- §A.3 obligation 3 applies to the 4c facts too, and #562's review round 2, finding 4 records
-- the inventory naming ONE of the four. All four, nullable for legacy and drain-window rows,
-- frozen once written by the seal below; 4d-ii writes them and 4d-iii requires them.
ALTER TABLE "DecisionConsultation" ADD COLUMN IF NOT EXISTS "requestedByRole" TEXT;
ALTER TABLE "DecisionConsultation" ADD COLUMN IF NOT EXISTS "requestedByName" TEXT;
ALTER TABLE "DecisionConsultationResponse" ADD COLUMN IF NOT EXISTS "respondedByRole" TEXT;
ALTER TABLE "DecisionConsultationResponse" ADD COLUMN IF NOT EXISTS "respondedByName" TEXT;

CREATE OR REPLACE FUNCTION phase6_t4d_consultation_attribution_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_old_role TEXT; v_old_name TEXT; v_new_role TEXT; v_new_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    v_old_role := OLD."requestedByRole"; v_old_name := OLD."requestedByName";
    v_new_role := NEW."requestedByRole"; v_new_name := NEW."requestedByName";
  ELSE
    v_old_role := OLD."respondedByRole"; v_old_name := OLD."respondedByName";
    v_new_role := NEW."respondedByRole"; v_new_name := NEW."respondedByName";
  END IF;

  IF (v_old_role IS NOT NULL AND v_new_role IS DISTINCT FROM v_old_role)
     OR (v_old_name IS NOT NULL AND v_new_name IS DISTINCT FROM v_old_name) THEN
    RAISE EXCEPTION
      'phase6 4d-i: the frozen attribution pair on %.% is evidence of WHO acted and may not be rewritten (% / % → % / %)',
      TG_TABLE_NAME, NEW."id",
      COALESCE(v_old_role, '<null>'), COALESCE(v_old_name, '<null>'),
      COALESCE(v_new_role, '<null>'), COALESCE(v_new_name, '<null>');
  END IF;
  RETURN NEW;
END $$;

-- THE PAIR IS WRITTEN AS A PAIR (#582 round 6, finding 5). The freeze above governs UPDATE only,
-- so through the 4d-i → 4d-iii window a direct INSERT could supply a role with no name, or a name
-- with no role — and the DELIVERED append-only seal then makes that half-attribution PERMANENT.
-- 4d-iii's "future inserts must carry the pair" cannot repair a row already committed, and the
-- consequence is not merely untidy: 4d-ii builds the response push audience from a request's
-- frozen `requestedByRole`, so a fabricated role with no name to contradict it steers who gets
-- told. A CHECK is the right instrument because it binds every writer at every moment, including
-- the ones this unit cannot see; the all-null legacy shape stays admitted, which is what keeps
-- the drain window open for the previous release.
DO $$ BEGIN
  ALTER TABLE "DecisionConsultation" ADD CONSTRAINT "DecisionConsultation_t4d_attribution_pair_check"
    CHECK (("requestedByRole" IS NULL) = ("requestedByName" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "DecisionConsultationResponse" ADD CONSTRAINT "DecisionConsultationResponse_t4d_attribution_pair_check"
    CHECK (("respondedByRole" IS NULL) = ("respondedByName" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- and a pair that IS present is judged at INSERT, not only frozen afterwards: a blank role or a
-- blank name satisfies the CHECK above (neither is null) while attributing nothing at all.
CREATE OR REPLACE FUNCTION phase6_t4d_consultation_attribution_present() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_role TEXT; v_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'DecisionConsultation' THEN
    v_role := NEW."requestedByRole"; v_name := NEW."requestedByName";
  ELSE
    v_role := NEW."respondedByRole"; v_name := NEW."respondedByName";
  END IF;
  IF v_role IS NULL THEN RETURN NEW; END IF;   -- the legacy all-null shape, admitted by the CHECK
  IF btrim(v_role, E' \t\n\x0B\f\r') = '' OR btrim(v_name, E' \t\n\x0B\f\r') = '' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% carries a blank attribution pair (role `%`, name `%`) — the pair is evidence of WHO acted, it is frozen the moment it lands, and a blank half attributes nothing while looking attributed',
      TG_TABLE_NAME, NEW."id", COALESCE(v_role, '<null>'), COALESCE(v_name, '<null>');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_attribution" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_attribution" BEFORE UPDATE ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_attribution" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_attribution" BEFORE UPDATE ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();
DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_attribution_present" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_attribution_present" BEFORE INSERT ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_present();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_attribution_present" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_attribution_present" BEFORE INSERT ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_present();

-- ── one re-notification per crossing ─────────────────────────────────────────────────────────
-- When the architect set changes while a decision awaits countersign, the new holder is notified
-- ONCE per crossing (§A.2, and #572's review round 19 puts `countersign_renotified` among the
-- audit kinds the correspondence judges). The audit row names the crossing event, and the
-- PARTIAL unique makes a second row for the same crossing unrepresentable rather than merely
-- refused by whichever writer happens to check.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionEvent_countersign_renotified_key"
  ON "DecisionEvent"("decisionId", (("payload" ->> 'crossingEventId')))
  WHERE "type" = 'countersign_renotified';

COMMIT;
