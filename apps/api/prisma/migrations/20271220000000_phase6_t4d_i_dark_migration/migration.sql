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
  IF phase6_t4d_retired() THEN RETURN; END IF;

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
  IF phase6_t4d_retired() THEN RETURN; END IF;

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
--   * `vitan.phase6_4d_reprojection` — 4d-iii's fenced verify-and-repair, which re-projects the
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
  v_reproject BOOLEAN := coalesce(current_setting('vitan.phase6_4d_reprojection', true), '') = 'on';
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
    'phase6 4d-i: "%" is a platform REGISTER projected from the orgs tables by their own triggers — a % issued directly (trigger depth 1) is refused. Its truth is the orgs row it mirrors; a register written by anything else is evidence of nothing. The migration backfill runs under `vitan.phase6_4d_standing_backfill`, and 4d-iii''s re-projection under `vitan.phase6_4d_reprojection`.',
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
DECLARE v_backfilled BIGINT;
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

  -- every account's display name
  INSERT INTO "UserIdentity" ("userId", "displayName")
  SELECT u."id", u."name" FROM "User" u
   WHERE btrim(u."name", E' \t\n\x0B\f\r') <> ''
     AND NOT EXISTS (SELECT 1 FROM "UserIdentity" i WHERE i."userId" = u."id")
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
  SELECT count(*) INTO v_backfilled FROM "Project" p
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectRoleStanding" r
                      WHERE r."projectId" = p."id" AND r."role" = 'architect');
  IF v_backfilled > 0 THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: % project(s) hold no zero-count `architect` standing row after the backfill; refusing to commit.', v_backfilled;
  END IF;
  SELECT count(*) INTO v_backfilled FROM "ProjectRoleStanding"
   WHERE "role" = 'architect' AND "activeCount" <> 0;
  IF v_backfilled > 0 THEN
    RAISE EXCEPTION 'phase6 4d-i ABORT: % `architect` standing row(s) are non-zero, which the reservation and the audit make impossible; refusing to commit.', v_backfilled;
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
DECLARE d RECORD;
BEGIN
  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."forwardedById", NEW."forwardedByRole",
                                 NEW."forwardedByName", 'DecisionForward ' || NEW."id");

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

-- ── the COUNTERSIGN INSERT seal ──────────────────────────────────────────────────────────────
-- The countersigner must BE an architect, and the subject must be exactly `awaiting_countersign`
-- — the only state a countersign is legal in.
CREATE OR REPLACE FUNCTION phase6_t4d_countersign_seal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD; r RECORD;
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

  SELECT "decisionId" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId" FOR UPDATE;
  IF NOT FOUND OR r."decisionId" <> NEW."decisionId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionCountersign % names revision %, which is not a revision of decision % — the fact records WHICH provisional approval it finalized',
      NEW."id", NEW."revisionId", NEW."decisionId";
  END IF;
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
DECLARE d RECORD; r RECORD;
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

  SELECT "decisionId" INTO r FROM "DecisionApprovalRevision"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."revisionId" FOR UPDATE;
  IF NOT FOUND OR r."decisionId" <> NEW."decisionId" THEN
    RAISE EXCEPTION
      'phase6 4d-i: DecisionStrandedResolution % names revision %, which is not a revision of decision %',
      NEW."id", NEW."revisionId", NEW."decisionId";
  END IF;
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
CREATE OR REPLACE FUNCTION phase6_t4d_provenance_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  v_primary_ok BOOLEAN := FALSE;
BEGIN
  SELECT "status", "resultRef" INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: %.% cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the row',
      TG_TABLE_NAME, NEW."id";
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

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- PART 3c — THE ORGS-OWNED MembershipTransition FACT
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- The architect chain is armed and disarmed by ORDINARY TEAM ACTS — a PMC adds an architect
-- member, or the last one leaves — so the standing change is a fact with the same seven
-- obligations every other 4d fact carries (§A.3). Without it "the chain turned on" is a count
-- with no attributable act behind it.
--
-- THREE COLUMN DETERMINATIONS THE PLAN LEAVES OPEN, recorded here rather than left implicit.
-- §A.3's effect row names the payload fields (`role`, `membershipId`, `from`, `to`,
-- `transitionId`, `activeCount`) and §D names the frozen pair, the FKs, the one-use UNIQUE and
-- the seals, but not the domain of `from`/`to`:
--
--   (i)   `role` is the role whose STANDING changed, not the membership's current role — a
--         re-role writes the fact for the role LEFT and the role ENTERED.
--   (ii)  `fromStanding`/`toStanding` are `held` / `not_held`: whether the membership held
--         `role` with ACTIVE standing. Statuses (`invited`/`active`/`removed`) would not do —
--         a re-role changes standing without changing status, and an `invited → removed`
--         change moves status without ever touching standing.
--   (iii) `activeCount` is the register's count AFTER the transition, which is what
--         `platform_role_standing` returns at the same instant and therefore what the
--         correspondence check can compare.
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
    "role"            TEXT NOT NULL,
    "fromStanding"    TEXT NOT NULL,
    "toStanding"      TEXT NOT NULL,
    "activeCount"     INTEGER NOT NULL,
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
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_standing_check"
    CHECK ("fromStanding" IN ('held', 'not_held') AND "toStanding" IN ('held', 'not_held')
           AND "fromStanding" <> "toStanding");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MembershipTransition" ADD CONSTRAINT "MembershipTransition_activeCount_check"
    CHECK ("activeCount" >= 0);
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
--   (c) SELF-DEMOTION. An actor who is the SUBJECT of a transition that REMOVES standing
--       (`toStanding = 'not_held'`) is admitted even when arms (a) and (b) no longer hold —
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
  v_self_demotion := (NEW."actorId" = NEW."userId" AND NEW."toStanding" = 'not_held');

  IF NOT v_self_demotion
     AND NOT platform_user_orchestration_authority(NEW."projectId", NEW."actorId")
     AND NOT platform_user_holds_role(NEW."projectId", NEW."actorId", 'pmc') THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % attributes a standing change on project % to user %, who holds neither owner/admin authority in the project''s organisation nor active `pmc` standing on it, and is not the subject stepping down — team management is an authorized act',
      NEW."id", NEW."projectId", NEW."actorId";
  END IF;

  PERFORM phase6_t4d_actor_bound(NEW."projectId", NEW."actorId", NEW."actorRole",
                                 NEW."actorName", 'MembershipTransition ' || NEW."id");

  -- `activeCount` is the register's count AFTER the transition, and the membership standing
  -- trigger is BEFORE ROW, so by the time this INSERT seal runs the delta is already applied.
  IF NEW."activeCount" IS DISTINCT FROM platform_role_standing(NEW."projectId", NEW."role") THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % records `%` standing at % on project %, but the register holds % — the fact and the register are the same truth and a fact that disagrees with it is evidence of nothing',
      NEW."id", NEW."role", NEW."activeCount", NEW."projectId",
      platform_role_standing(NEW."projectId", NEW."role");
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "MembershipTransition_t4d_seal" ON "MembershipTransition";
CREATE TRIGGER "MembershipTransition_t4d_seal" BEFORE INSERT ON "MembershipTransition"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_transition_seal();

-- ── obligation 6: the receipt binding ────────────────────────────────────────────────────────
-- Named `phase6_t4d_membership_transition_bound` by §D. It is the single-fact shape — a
-- membership command writes ONE transition and its receipt names it — so it does not need the
-- bundle widening the decisions facts take.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_transition_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  SELECT "status", "resultRef" INTO c FROM "CommandExecution"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."sourceCommandId";
  IF NOT FOUND OR c."status" <> 'succeeded' THEN
    RAISE EXCEPTION
      'phase6 4d-i: MembershipTransition % cites a command that did not succeed in this transaction — the receipt must be COMPLETED by the command that wrote the fact',
      NEW."id";
  END IF;
  IF c."resultRef" IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION
      'phase6 4d-i: the command cited by MembershipTransition % names result %, not this fact — a receipt for another result cannot be borrowed',
      NEW."id", COALESCE(c."resultRef", '<null>');
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
-- with no standing change — is judged by the `activeCount` comparison in the INSERT seal above,
-- which reads the register the membership trigger has already moved.
CREATE OR REPLACE FUNCTION phase6_t4d_membership_architect_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_before     BOOLEAN := (TG_OP <> 'INSERT' AND OLD."role" = 'architect' AND OLD."status" = 'active');
  v_after      BOOLEAN := (TG_OP <> 'DELETE' AND NEW."role" = 'architect' AND NEW."status" = 'active');
  v_project    TEXT;
  v_membership TEXT;
  v_user       TEXT;
  v_direction  TEXT;
BEGIN
  IF v_before = v_after THEN RETURN NULL; END IF;

  -- OLD and NEW are records, and plpgsql has no expression that picks between two of them, so
  -- the fields are read explicitly per operation rather than through a CASE over the rows.
  -- `userId` is frozen on a membership (the identity-freeze class), so OLD and NEW agree on it
  -- wherever both exist and either side names the same subject.
  IF TG_OP = 'DELETE' THEN
    v_project := OLD."projectId"; v_membership := OLD."id"; v_user := OLD."userId";
  ELSE
    v_project := NEW."projectId"; v_membership := NEW."id"; v_user := NEW."userId";
  END IF;
  v_direction := CASE WHEN v_after THEN 'held' ELSE 'not_held' END;

  -- IN THIS TRANSACTION, and about THIS MEMBER (Codex round 1, findings 9 and 13 — two holes in
  -- one predicate). Unscoped, it accepted historical evidence: an architect legitimately
  -- activated, removed, then bare-restored found the ORIGINAL `toStanding = 'held'` row and
  -- passed, re-arming the chain with no attributable act. And without the subject comparison a
  -- PMC could activate membership A while inserting an otherwise-valid immutable transition
  -- naming an unrelated user B, leaving permanent evidence that B's standing changed.
  IF NOT EXISTS (
    SELECT 1 FROM "MembershipTransition" mt
     WHERE mt."projectId" = v_project AND mt."membershipId" = v_membership
       AND mt."role" = 'architect' AND mt."toStanding" = v_direction
       AND mt."userId" = v_user
       AND mt."xmin" = txid_current()::text::xid
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: membership % on project % moved architect standing to `%` in this transaction with no MembershipTransition written HERE naming user % — the chain is armed and disarmed by attributable ACTS, never by a bare row write and never by an older act reused',
      v_membership, v_project, v_direction, v_user;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Membership_t4d_architect_provenance" ON "Membership";
CREATE CONSTRAINT TRIGGER "Membership_t4d_architect_provenance"
  AFTER INSERT OR UPDATE OR DELETE ON "Membership" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_membership_architect_paired();

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
    CONSTRAINT "ExternalEffectCatalog_pkey" PRIMARY KEY ("coverageVersion", "effectKey"),
    -- a pushing row names its shape; a non-pushing row names none.
    CONSTRAINT "ExternalEffectCatalog_audience_check"
      CHECK (("requiresPush" AND "audience" IN ('broadcast', 'targeted', 'frozen'))
             OR (NOT "requiresPush" AND "audience" IS NULL)),
    -- only a frozen-audience family carries a constant body, and it carries one.
    CONSTRAINT "ExternalEffectCatalog_frozen_body_check"
      CHECK (("frozenAudience" AND "audience" = 'frozen' AND "pushBody" IS NOT NULL)
             OR (NOT "frozenAudience" AND "pushBody" IS NULL))
);

-- ── the release lease, DARK ──────────────────────────────────────────────────────────────────
-- The drain attestation's evidence: which release is serving, since when, and under whose
-- authority. Written by nothing until 4d-ii; its identity is frozen and its rows are neither
-- deletable nor truncatable, because a lease that can be rewritten attests to nothing.
CREATE TABLE IF NOT EXISTS "ReleaseLease" (
    "id"            TEXT NOT NULL,
    "release"       TEXT NOT NULL,
    "acquiredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acquiredBy"    TEXT NOT NULL,
    "heartbeatAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt"    TIMESTAMP(3),
    CONSTRAINT "ReleaseLease_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReleaseLease_release_idx" ON "ReleaseLease"("release");

DO $$ BEGIN
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_release_present_check"
    CHECK (btrim("release", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_acquiredBy_present_check"
    CHECK (btrim("acquiredBy", E' \t\n\x0B\f\r') <> '');
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
-- The seed DECLARES itself, which is what the INSERT arm above requires. Session-scoped rather
-- than `SET LOCAL`, because this file is not wrapped in one transaction (Part 2's `ALTER TYPE`
-- statements cannot be), and a `SET LOCAL` outside a transaction block sets nothing at all.
SELECT set_config('vitan.phase6_4d_catalog', 'on', false);

INSERT INTO "ExternalEffectCatalog" ("coverageVersion", "effectKey", "eventType", "invalidate", "pushRoles", "pushFamily", "frozenAudience", "requiresPush", "audience", "pushBody", "pairingRequired") VALUES
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.completion_requested', 'activity.completion_requested', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.created', 'activity.created', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.deleted', 'activity.deleted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.labour_blocked', 'activity.labour_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.labour_unblocked', 'activity.labour_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.material_blocked', 'activity.material_blocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.material_unblocked', 'activity.material_unblocked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.override_granted', 'activity.override_granted', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.override_revoked', 'activity.override_revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.signed_off', 'activity.signed_off', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.signoff_rejected', 'activity.signoff_rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.started', 'activity.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.unfiled', 'activity.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity.updated', 'activity.updated', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'activity_output.recorded', 'activity_output.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'allocation.made', 'allocation.made', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'allocation.released', 'allocation.released', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'attendance.recorded', 'attendance.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'attendance.revoked', 'attendance.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'capacity.committed', 'capacity.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'capacity.defaulted', 'capacity.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'capacity.revised', 'capacity.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'commercial.money_moved', 'commercial.money_moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'comparison.approved', 'comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'dailylog.started', 'dailylog.started', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'dailylog.submitted', 'dailylog.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.approved', 'decision.approved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.change_requested', 'decision.change_requested', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.change_withdrawn', 'decision.change_withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.consultation_requested', 'decision.consultation_requested', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'consultation_requested', false, true, 'targeted', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.consultation_responded', 'decision.consultation_responded', true, '["pmc"]'::jsonb, 'consultation_responded', false, true, 'targeted', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.drafted', 'decision.drafted', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.published', 'decision.published', true, '["client","consultant","contractor","engineer","pmc"]'::jsonb, 'decider', false, true, 'targeted', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.reapproved', 'decision.reapproved', true, '["contractor","engineer","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'decision.withdrawn', 'decision.withdrawn', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'delivery.committed', 'delivery.committed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'delivery.defaulted', 'delivery.defaulted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'delivery.fulfilled', 'delivery.fulfilled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'delivery.revised', 'delivery.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.acknowledged', 'drawing.acknowledged', true, '["pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.activity_unlinked', 'drawing.activity_unlinked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.issued', 'drawing.issued', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.issued_draft', 'drawing.issued', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.published', 'drawing.published', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.recipients_frozen', 'drawing.recipients_frozen', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.refiled', 'drawing.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.removed', 'drawing.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.revised', 'drawing.revised', true, '["contractor","engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.revised_draft', 'drawing.revised', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'drawing.unfiled', 'drawing.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.approved', 'inspection.approved', true, '["client","contractor"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.closing_created', 'inspection.closing_created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.created', 'inspection.created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.evidence_added', 'inspection.evidence_added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.evidence_removed', 'inspection.evidence_removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.reinspection_created', 'inspection.reinspection_created', true, '["engineer"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.rejected', 'inspection.rejected', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.relabeled', 'inspection.relabeled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.submitted', 'inspection.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'inspection.unfiled', 'inspection.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'issue.recorded', 'issue.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.comparison.approved', 'labour.comparison.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.po.amended', 'labour.po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.po.cancelled', 'labour.po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.po.closed_short', 'labour.po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.po.issued', 'labour.po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.requisition.approved', 'labour.requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour.requisition.submitted', 'labour.requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour_mismatch.recorded', 'labour_mismatch.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour_mismatch.resolved', 'labour_mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'labour_work.recorded', 'labour_work.recorded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'material.added', 'material.added', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'material.mismatch_flagged', 'material.mismatch_flagged', true, '["contractor","pmc"]'::jsonb, NULL, false, true, 'broadcast', NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'material.unfiled', 'material.unfiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'media.refiled', 'media.refiled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'media.removed', 'media.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'media.uploaded', 'media.uploaded', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'membership.added', 'membership.added', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'membership.discipline_changed', 'membership.discipline_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'membership.removed', 'membership.removed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'membership.role_changed', 'membership.role_changed', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'mismatch.resolved', 'mismatch.resolved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'node.created', 'node.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'node.moved', 'node.moved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'node.published', 'node.published', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'node.removed', 'node.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'node.renamed', 'node.renamed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'phase.created', 'phase.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'phase.removed', 'phase.removed', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'po.amended', 'po.amended', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'po.cancelled', 'po.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'po.closed_short', 'po.closed_short', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'po.issued', 'po.issued', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'project.archived', 'project.archived', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'project.created', 'project.created', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'project.restored', 'project.restored', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'project.updated', 'project.updated', false, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'requirement.cancelled', 'requirement.cancelled', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'requirement.created', 'requirement.created', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'requirement.revised', 'requirement.revised', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'requisition.approved', 'requisition.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'requisition.submitted', 'requisition.submitted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'skill_substitution.approved', 'skill_substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'skill_substitution.revoked', 'skill_substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'stock.transacted', 'stock.transacted', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'substitution.approved', 'substitution.approved', true, NULL, NULL, false, false, NULL, NULL, false),
  ('6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7', 'substitution.revoked', 'substitution.revoked', true, NULL, NULL, false, false, NULL, NULL, false)
ON CONFLICT ("coverageVersion", "effectKey") DO NOTHING;

SELECT set_config('vitan.phase6_4d_catalog', 'off', false);

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
  SELECT c."pairingRequired" INTO v_required
    FROM "ExternalEffectCatalog" c
   WHERE c."eventType" = NEW."eventType" AND c."retiredAt" IS NULL
   ORDER BY c."effectKey" LIMIT 1;
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
DECLARE v_next BIGINT; v_allocated_here BOOLEAN;
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
CREATE OR REPLACE FUNCTION platform_t4d_notification_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Notification_t4d_binding" ON "Notification";
CREATE TRIGGER "Notification_t4d_binding" BEFORE UPDATE ON "Notification"
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

  SELECT "projectId", "entityType", "entityId" INTO e FROM "DomainEvent"
   WHERE "projectId" = NEW."projectId" AND "eventId" = NEW."eventId";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % names event %, which does not exist in project % at commit',
      NEW."id", NEW."eventId", NEW."projectId";
  END IF;
  IF NEW."decisionId" IS NOT NULL
     AND (e."entityType" <> 'Decision' OR e."entityId" IS DISTINCT FROM NEW."decisionId") THEN
    RAISE EXCEPTION
      'phase6 4d-i: notice % is stamped with decision % but names an event about %/% — the stamp and the event must be about the same thing, or retiring the notice by identity retires the wrong one',
      NEW."id", NEW."decisionId", e."entityType", e."entityId";
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
-- Identity frozen, no DELETE, no TRUNCATE (§D). A lease whose release or acquirer can be
-- rewritten attests to nothing, and a drain attestation rests entirely on it.
CREATE OR REPLACE FUNCTION platform_t4d_release_lease_sealed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease % may not be DELETED — the drain attestation rests on which release was serving and when, and a lease that can be removed attests to nothing',
      OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."release" IS DISTINCT FROM OLD."release"
     OR NEW."acquiredAt" IS DISTINCT FROM OLD."acquiredAt"
     OR NEW."acquiredBy" IS DISTINCT FROM OLD."acquiredBy" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease %''s identity (release %, acquired by % at %) is frozen — only the heartbeat and the release stamp move',
      OLD."id", OLD."release", OLD."acquiredBy", OLD."acquiredAt";
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease % was released at % — that stamp is one-way, and un-releasing it would attest that a drained release was still serving',
      OLD."id", OLD."releasedAt";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ReleaseLease_t4d_sealed" ON "ReleaseLease";
CREATE TRIGGER "ReleaseLease_t4d_sealed" BEFORE UPDATE OR DELETE ON "ReleaseLease"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_release_lease_sealed();

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
  IF phase6_t4d_retired() THEN RETURN; END IF;

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

-- ── the FLIP is PAIRED, in both directions (§B.4) ────────────────────────────────────────────
-- A finalized-only flip with NEITHER pairing fact is unrepresentable. The two legal finalizers
-- are the `DecisionCountersign` row (the chain path) and the `DecisionStrandedResolution` row
-- with outcome `completed` (the only other one) — so the seal names both and nothing else.
CREATE OR REPLACE FUNCTION phase6_t4d_revision_flip_paired() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."finalized" = TRUE OR NEW."finalized" = FALSE THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "DecisionCountersign" c
     WHERE c."projectId" = NEW."projectId" AND c."revisionId" = NEW."id"
  ) AND NOT EXISTS (
    SELECT 1 FROM "DecisionStrandedResolution" s
     WHERE s."projectId" = NEW."projectId" AND s."revisionId" = NEW."id"
       AND s."outcome" = 'completed'
  ) THEN
    RAISE EXCEPTION
      'phase6 4d-i: revision % was finalized in this transaction with neither a DecisionCountersign nor a `completed` DecisionStrandedResolution naming it — a provisional approval becomes final by an ACT, and a flip with no act behind it is exactly the forgery the register exists to make impossible',
      NEW."id";
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
  IF platform_tx_event(v_project, 'Decision', NEW."decisionId", v_required) IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i: the `%` audit row for decision % (committed `%`) has no matching % event in this transaction — the audit register and the delivery stream record the SAME act, and one without the other is a system that cannot say what it did',
      NEW."type", NEW."decisionId", v_status, array_to_string(v_required, ' or ');
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
  IF phase6_t4d_retired() THEN
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

DROP TRIGGER IF EXISTS "DecisionConsultation_t4d_attribution" ON "DecisionConsultation";
CREATE TRIGGER "DecisionConsultation_t4d_attribution" BEFORE UPDATE ON "DecisionConsultation"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();
DROP TRIGGER IF EXISTS "DecisionConsultationResponse_t4d_attribution" ON "DecisionConsultationResponse";
CREATE TRIGGER "DecisionConsultationResponse_t4d_attribution" BEFORE UPDATE ON "DecisionConsultationResponse"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4d_consultation_attribution_frozen();

-- ── one re-notification per crossing ─────────────────────────────────────────────────────────
-- When the architect set changes while a decision awaits countersign, the new holder is notified
-- ONCE per crossing (§A.2, and #572's review round 19 puts `countersign_renotified` among the
-- audit kinds the correspondence judges). The audit row names the crossing event, and the
-- PARTIAL unique makes a second row for the same crossing unrepresentable rather than merely
-- refused by whichever writer happens to check.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionEvent_countersign_renotified_key"
  ON "DecisionEvent"("decisionId", (("payload" ->> 'crossingEventId')))
  WHERE "type" = 'countersign_renotified';
