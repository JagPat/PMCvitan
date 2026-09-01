-- Phase 6 unit 4c-iii — the ENABLEMENT TRANSITION
-- (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md §D, review rounds 18/20/21/24/26).
--
-- THIS MIGRATION MAY LAND ONLY AFTER A VALID EXPLICIT OPERATOR ATTESTATION THAT THE PREVIOUS
-- RELEASE HAS DRAINED. The `phase-6-4c-previous-release-drained` directive is ACTIVE and
-- FAIL-CLOSED. An earlier draft of this header recorded the directive as already cleared "on the
-- operator's Coolify inspection at `main` 2cec61f"; that attribution was WITHDRAWN as
-- unattributable (an inspection performed by someone other than the operator, recorded as the
-- operator's own declaration) and the directive was restored on `main` 1b107a1. It must not ship
-- in an immutable migration, so it does not.
--
-- What clears it is one thing and nothing else: an explicit operator statement that every API,
-- projection/relay, web-push and delivery-worker process older than 5fcc2a58 is stopped or
-- drained and only 5fcc2a58 or later is claiming deliveries, landed as a STATUS commit. No agent
-- inspection, PR comment, review signal or green check is that statement.
--
-- The ordering below is why the drain matters: until every previous-release instance is gone, a
-- gate-blind and a gate-reading instance can disagree about the same project. Once the attestation
-- exists, this performs in ONE transaction the three things §D says must not be separable, IN
-- THIS ORDER:
--
--   1. REPLACE the 4c-i/4c-ii reservation with a PRESERVATION seal (round 24);
--   2. install an `AFTER INSERT` trigger on `Project` so every project created from now on
--      carries the row;
--   3. and THEN backfill the row for every EXISTING project.
--
-- WHY THE ORDER (round 21). Backfilling first leaves a hole: a concurrent `Project` INSERT can
-- commit after the backfill's statement snapshot but before `CREATE TRIGGER` takes its table
-- lock, so that project appears in neither — absent from the backfill, never seen by the trigger —
-- and its routes stay gate-off until 4c-iv despite the every-project claim. Creating the trigger
-- FIRST takes ACCESS EXCLUSIVE on `Project` inside this transaction, so concurrent inserts block
-- until commit and every row is covered by one mechanism or the other; the backfill is
-- `ON CONFLICT DO NOTHING` for the overlap.
--
-- WHY A DATABASE TRIGGER AND NOT `projects.create` (round 12, re-pointed by round 23). Deployed
-- code cannot start behaving differently because an operator acted, and a create path that
-- enabled from its own deploy time would make a project created while old workers were still
-- draining immediately gate-on. A DB-level default is produced by EVERY create path — the
-- previous release's and the new one's alike — so there is no build to upgrade before coverage is
-- complete, and no window in which a created project carries no row.
--
-- BEHAVIOUR DOES NOT CHANGE HERE. The gate READS stay in place and authoritative throughout;
-- what changes is that they now always find a row. The read removal is 4c-iv, and this unit is
-- separately revertible.

-- ── 1. the RESERVATION gives way to the PRESERVATION seal ──────────────────────────────────────
--
-- Replaced, not merely dropped, because the row's ABSENCE is as dangerous as its premature
-- presence (round 24). Between this unit and 4c-iv the gate reads are still authoritative and
-- `capability` is still free text written by the generic writer — so once the reservation is gone,
-- nothing would stop an alternate writer DELETING a `consultation` row or UPDATING its key away.
-- During the 4c-iv rollout that reproduces the split brain this staging exists to prevent, from
-- the other direction: a 4c-iv instance, which no longer reads the gate, accepts a consultation
-- write for that project while a still-serving 4c-ii/4c-iii instance refuses the same project
-- because its gate read finds no row.
--
-- This is NOT a vocabulary whitelist. The Board pin stands: no CHECK on `capability`, and every
-- other capability value is untouched by all three arms below.
--
-- ATOMICITY, stated here because the handover below depends on it and the file carries no
-- BEGIN/COMMIT of its own. `prisma migrate deploy` — the production path, `scripts/migrate.sh` —
-- runs each migration file inside ONE transaction on PostgreSQL, so the window between dropping
-- the reservation and installing the preservation seal does not exist for any other session, and
-- a failure anywhere below rolls the whole transition back. That is a property of the runner
-- rather than a claim of this file, so it is verified rather than assumed: a two-statement
-- migration whose second statement raises leaves NO trace of the first (`CREATE TABLE x; SELECT
-- 1/0;` under `prisma migrate deploy` → `to_regclass('x') IS NULL`). An explicit COMMIT here
-- would be worse than redundant: it would end the runner's transaction early and leave whatever
-- follows it outside the boundary the handover needs.
DROP TRIGGER IF EXISTS "ProjectCapability_t4c_reserved" ON "ProjectCapability";
DROP FUNCTION IF EXISTS phase6_t4c_capability_reserved();

-- ── 1a. the FK becomes ON DELETE CASCADE, so the seal can be scoped to a LIVE project ──────────
--
-- DELIBERATE DEVIATION from §D's "every way PostgreSQL offers to remove that row", argued in the
-- packet rather than taken silently.
--
-- §D's seal is absolute at the row level. Combined with this unit's own backfill — after which
-- EVERY project carries a `consultation` row — and the delivered `ON DELETE RESTRICT`, an
-- absolute DELETE arm makes a `Project` row undeletable FOREVER: the capability row must go
-- first, and the seal refuses it. That is inert in production (nothing in `src/` deletes a
-- project; projects are ARCHIVED via `archivedAt`), but it is not inert in the repository, where
-- 36 test files plus the shared `fixtures.ts` teardown delete the projects they create.
--
-- The invariant the seal actually protects is the split brain between gate-reading and
-- gate-blind instances FOR A PROJECT. A project that no longer exists has no such state: no
-- route resolves for it, no instance can accept or refuse a consultation write against it. So
-- the seal is scoped to a LIVE project — every removal that could produce the hazard is refused,
-- and the one that cannot is permitted.
--
-- The discriminator is exact rather than heuristic. Under CASCADE, PostgreSQL performs the
-- child delete in a later command than the parent's, so by the time this row trigger fires the
-- parent `Project` row is already invisible to the current snapshot; a DIRECT delete of the
-- capability row leaves the parent plainly visible. Verified on PostgreSQL 16 and probed in
-- `phase6-t4c-iii-enablement.test.ts` from both sides.
DO $$ BEGIN
  ALTER TABLE "ProjectCapability" DROP CONSTRAINT IF EXISTS "ProjectCapability_projectId_fkey";
  ALTER TABLE "ProjectCapability" ADD CONSTRAINT "ProjectCapability_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

-- ── 1b. the seal: row DELETE, row UPDATE of the sealed key, statement TRUNCATE ─────────────────
--
-- The three arms are stated by ENUMERATION over the mechanism, not because a review found each
-- one (round 26, which found the third — and that is the point). Row triggers do not fire for
-- `TRUNCATE`; this plan already relies on that fact twice, giving both consultation evidence
-- tables named statement-level no-truncate seals. The completeness rule is therefore: a seal that
-- must keep a row PRESENT is complete only when it covers row DELETE, row UPDATE of the sealed
-- key, and statement TRUNCATE.
CREATE OR REPLACE FUNCTION phase6_t4c_capability_preserved() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The discriminator reads NO foreign table. An earlier draft asked `EXISTS (SELECT 1 FROM
    -- "Project" ...)`, which made this platform-owned seal take a synchronous read of the
    -- orgs-owned `Project` table and coupled the capability invariant to orgs' physical schema
    -- (review finding on head 636d38e, P1). It is replaced by two local facts:
    --
    --   * `pg_trigger_depth() > 1` — this DELETE did not come from a client statement. A direct
    --     `DELETE FROM "ProjectCapability"` runs at depth 1; an FK cascade runs the child delete
    --     at depth 2. Verified on PostgreSQL 16, including the multi-row parent delete.
    --   * the orgs-owned `Project_t4c_deleting` BEFORE DELETE trigger below, which sets a
    --     TRANSACTION-LOCAL flag saying a `Project` delete is under way. That is the orgs-owned
    --     primitive authorizing the cascade; this seal only reads the flag.
    --
    -- BOTH are required, and that is what closes the hole either alone would leave. Depth alone
    -- would permit any other trigger that deletes the row; the flag alone is not enough because a
    -- direct delete later in the same transaction would still see it set — which the probe
    -- confirms is refused, because such a delete is at depth 1.
    --
    -- The flag is deliberately a BOOLEAN and not the deleting project's id. Under a multi-row
    -- `DELETE FROM "Project" WHERE ...` PostgreSQL queues the RI cascades as AFTER-statement
    -- actions, so by the time they fire an id-valued flag holds only the LAST row's id and every
    -- earlier project's cascade would be wrongly refused — which is exactly the shape the shared
    -- fixture teardown uses. Measured, not assumed.
    IF OLD."capability" = 'consultation'
       AND NOT (pg_trigger_depth() > 1
                AND coalesce(current_setting('phase6.t4c_project_delete', true), '') = 'on') THEN
      RAISE EXCEPTION 'phase6-4c: the `consultation` capability row for project % may not be DELETED directly — between 4c-iii and 4c-v the gate reads are still authoritative, and a missing row makes a gate-reading instance refuse a project a gate-blind instance accepts. (A cascade from the project''s own deletion is permitted; this is a direct delete.)', OLD."projectId";
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: the consultation row is FROZEN once it exists. Three distinct removals-by-another-name,
  -- and the third was a review finding on head 9067d0cc (P1) rather than something this file
  -- foresaw — recorded that way because the completeness rule below is what should have caught it.
  --
  --   (a) RE-KEYING it off `consultation` removes it under a different name;
  --   (b) RE-PARENTING it to another project removes it from THIS project — the gate reads are
  --       per-project, so moving the row is indistinguishable from deleting it here;
  --   (c) REWRITING its attribution (`enabledById`/`enabledAt`) leaves the row in place but
  --       destroys what it is EVIDENCE of. This migration writes `system:phase6-4c-iii` to record
  --       that the DATABASE enabled the capability and no person did; an alternate writer that can
  --       overwrite that can dress a machine enablement up as an operator's act, or an operator's
  --       as the machine's. A seal that keeps a row present while letting its provenance be
  --       rewritten protects the wrong half of it.
  --
  -- THE COMPLETENESS RULE, extended by the same reasoning round 26 used for TRUNCATE: a seal over a
  -- row that is EVIDENCE is complete only when it covers every column whose value the evidence
  -- rests on, not merely the key that identifies it.
  --
  -- A no-op UPDATE is permitted: the ordinary `capabilities.enable` writer is an upsert whose
  -- update branch changes nothing, and refusing an update that alters nothing would break the
  -- idempotent enable for no invariant's sake. So the test is IS DISTINCT FROM on each sealed
  -- column, never the mere fact of an UPDATE.
  IF OLD."capability" = 'consultation' THEN
    IF NEW."capability" IS DISTINCT FROM OLD."capability" THEN
      RAISE EXCEPTION 'phase6-4c: the `consultation` capability row for project % may not be RE-KEYED off `consultation` — `capability` is a mutable key with no freeze trigger, so a DELETE-only seal leaves the same gate-closed state reachable by renaming the row', OLD."projectId";
    END IF;
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-4c: the `consultation` capability row for project % may not be RE-PARENTED to project % — the gate reads are per-project, so moving the row removes it from this one exactly as a delete would', OLD."projectId", NEW."projectId";
    END IF;
    IF NEW."enabledById" IS DISTINCT FROM OLD."enabledById"
       OR NEW."enabledAt" IS DISTINCT FROM OLD."enabledAt" THEN
      RAISE EXCEPTION 'phase6-4c: the `consultation` capability row for project % carries the ATTRIBUTION of who enabled it (% at %), which is evidence and is immutable — a writer that can rewrite it can present a database enablement as an operator''s act, or the reverse', OLD."projectId", OLD."enabledById", OLD."enabledAt";
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Fires on EVERY update, not `UPDATE OF "capability"`: a column list narrows the trigger to the
-- columns named, which is precisely how the attribution arm above was reachable on head 9067d0cc.
-- The orgs-owned primitive that AUTHORIZES the cascade. It lives on `Project` — orgs' own table,
-- where the fact "this project is being deleted" belongs — and publishes it as a
-- transaction-local flag. The seal above consults only that flag, never the table, so the
-- capability invariant no longer depends on orgs' physical schema.
CREATE OR REPLACE FUNCTION phase6_t4c_project_deleting() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('phase6.t4c_project_delete', 'on', true);
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Project_t4c_deleting" ON "Project";
CREATE TRIGGER "Project_t4c_deleting"
  BEFORE DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_project_deleting();

DROP TRIGGER IF EXISTS "ProjectCapability_t4c_preserved" ON "ProjectCapability";
CREATE TRIGGER "ProjectCapability_t4c_preserved"
  BEFORE DELETE OR UPDATE ON "ProjectCapability"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_capability_preserved();

CREATE OR REPLACE FUNCTION phase6_t4c_capability_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase6-4c: "ProjectCapability" carries the consultation preservation seal and is never truncated — a row trigger does not fire for TRUNCATE, so the statement is sealed too. The sanctioned reset (prisma/sanctioned-reset.ts) disables this trigger BY NAME for test setup and seeding.';
END $$;

DROP TRIGGER IF EXISTS "ProjectCapability_t4c_no_truncate" ON "ProjectCapability";
CREATE TRIGGER "ProjectCapability_t4c_no_truncate"
  BEFORE TRUNCATE ON "ProjectCapability"
  FOR EACH STATEMENT EXECUTE FUNCTION phase6_t4c_capability_no_truncate();

-- ── 2. every project created FROM NOW ON carries the row ───────────────────────────────────────
-- `CREATE TRIGGER` takes ACCESS EXCLUSIVE on "Project" inside this transaction, which is what
-- makes step 3 exhaustive: a concurrent create blocks here until commit and is then covered by
-- this trigger, or it committed before and is covered by the backfill.
--
-- `enabledById` is NOT NULL and carries no FK, so the DB-level enablement records itself as its
-- own actor rather than borrowing a person's identity for an act no person performed.
CREATE OR REPLACE FUNCTION phase6_t4c_project_consultation_row() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ProjectCapability" ("projectId", "capability", "enabledAt", "enabledById")
  VALUES (NEW."id", 'consultation', now(), 'system:phase6-4c-iii')
  ON CONFLICT ("projectId", "capability") DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Project_t4c_consultation_enabled" ON "Project";
CREATE TRIGGER "Project_t4c_consultation_enabled"
  AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4c_project_consultation_row();

-- ── 3. …and THEN every project that already existed ────────────────────────────────────────────
-- ON CONFLICT DO NOTHING covers the overlap with step 2 and makes the whole file re-runnable.
INSERT INTO "ProjectCapability" ("projectId", "capability", "enabledAt", "enabledById")
SELECT p."id", 'consultation', now(), 'system:phase6-4c-iii'
  FROM "Project" p
ON CONFLICT ("projectId", "capability") DO NOTHING;

-- ── 4. the transition is COMPLETE, checked rather than asserted ────────────────────────────────
-- The every-project claim is the whole point of the unit, so it is verified before commit rather
-- than left to a probe: if any project lacks the row at this moment, the ordering above did not
-- hold and the transaction must not commit.
DO $$
DECLARE missing BIGINT;
BEGIN
  SELECT count(*) INTO missing
    FROM "Project" p
   WHERE NOT EXISTS (
     SELECT 1 FROM "ProjectCapability" c
      WHERE c."projectId" = p."id" AND c."capability" = 'consultation');
  IF missing > 0 THEN
    RAISE EXCEPTION 'phase6-4c ABORT: % project(s) still lack the `consultation` capability row after the trigger-then-backfill transition. The every-project guarantee this unit exists to establish does not hold; refusing to commit.', missing;
  END IF;
END $$;
