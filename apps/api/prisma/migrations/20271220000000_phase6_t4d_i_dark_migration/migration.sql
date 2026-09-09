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
