-- Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH.
--
-- One concern: a finish-to-start edge between two activities of one project, and the guarantee
-- that the set of those edges is always a valid DAG. Durations, the working calendar, baselines,
-- forecast computation and the readiness gate are separate units; this one installs the graph and
-- the rules that keep it honest, so nothing built on top has to re-check them.
--
-- Additive: one new table, no existing table altered.

-- ONE TRANSACTION, on every path that can apply this file.
--
-- `prisma migrate deploy` already wraps a migration, but that is not the only way this file runs:
-- `psql -f` does NOT, and then every statement autocommits. That matters most at the trigger
-- replacements near the end — between a drop and its create the table has no acyclicity guard at
-- all, and a concurrent writer inserting opposing edges in that window leaves both rows behind,
-- unchecked. Wrapping the file makes the preflight and every replacement atomic however it is
-- applied. This is the shape `20270610000000_phase5_t6b_status_derivation` already uses.
BEGIN;

-- Everything below runs in the `public` schema, whoever applies it.
--
-- `prisma migrate deploy` sets this up; `psql -f` does not, and takes the caller's search path
-- instead. Under a role whose path names a per-user or temporary schema first, every unqualified
-- CREATE TABLE, ALTER TABLE, CREATE FUNCTION and CREATE TRIGGER below would build the whole graph
-- somewhere else and commit successfully, while the application's `public` schema still has no
-- table at all — and a re-run would follow the same shadow objects and never notice.
SET LOCAL search_path = public;

-- ── Preflight: RECOGNIZE, then either proceed or refuse ───────────────────────────────────────
-- Three states, and the difference between the second and the third is the whole point:
--
--   the table is absent            → fresh install. Everything below creates it.
--   the table is present and is EXACTLY what this migration installs, with every guard in force
--                                  → this migration is already applied. Every statement below is
--                                    idempotent and finds its object already there, so a second
--                                    application is a no-op. That is the operator-repair path
--                                    (`migrate resolve --rolled-back`, then deploy again) and the
--                                    repository's re-runnability requirement.
--   the table is present and is anything else
--                                  → rows may exist that no guard ever judged. Stop, change
--                                    nothing, and let a person decide.
--
-- An earlier head of this unit refused BOTH of the last two cases with one blunt test, which
-- bought refusal at the cost of re-runnability. The head before that went the other way and tried
-- to REPAIR a partial install — adopting whatever rows it found, which is the one thing a guard
-- cannot honestly do, because "were these edges ever cycle-checked?" is unanswerable after the
-- fact. This preflight does neither: it only RECOGNIZES a complete, in-force installation, and
-- refuses everything it does not recognize. Recognition is decidable; adoption is not.
--
-- Why each attribute is checked rather than just the name:
--   `tgrelid`     — a trigger of the right name on ANOTHER table proves nothing about this one.
--   `tgenabled`   — 'D' (disabled) and 'R' (REPLICA, inert on an origin server) both read as
--                   present while enforcing nothing.
--   `tgfoid`      — a correctly-named trigger bound to some other function is a decoy.
--   `tgtype`      — EXACT, not a require-bits test: a raising function bound to the wrong events is
--                   either inert (the seal is missing) or blocks legitimate writes (the table is
--                   unusable), and a require-bits test reports both healthy. Bits: 1=ROW,
--                   2=BEFORE, 4=INSERT, 8=DELETE, 16=UPDATE, 32=TRUNCATE.
--   `convalidated`— a constraint added NOT VALID exists in the catalog and enforces nothing about
--                   the rows already in the table, which is precisely the population in question.
--   `indisvalid`  — a failed concurrent build leaves an index that is present and not enforcing.
DO $$
DECLARE v_wrong TEXT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    RETURN;                                  -- fresh install; there is nothing to recognize
  END IF;

  SELECT string_agg(x, ', ' ORDER BY x) INTO v_wrong FROM (
    SELECT 'trigger ' || e.name AS x
      FROM (VALUES ('ActivityDependency_acyclic',     'activity_dependency_acyclic',      7),
                   ('ActivityDependency_frozen',      'activity_dependency_frozen',      19),
                   ('ActivityDependency_no_delete',   'activity_dependency_no_delete',   11),
                   ('ActivityDependency_no_truncate', 'activity_dependency_no_truncate', 34))
             AS e(name, fn, tgtype)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgname = e.name
          AND g.tgrelid = 'public."ActivityDependency"'::regclass
          AND NOT g.tgisinternal
          AND g.tgenabled = 'O'
          AND g.tgfoid::regproc::text = e.fn
          AND g.tgtype = e.tgtype)
    UNION ALL
    SELECT 'constraint ' || c.name
      FROM (VALUES ('ActivityDependency_pkey'),
                   ('ActivityDependency_attribution_check'),
                   ('ActivityDependency_revocation_check'),
                   ('ActivityDependency_no_self_check'),
                   ('ActivityDependency_lag_nonneg_check'),
                   ('ActivityDependency_projectId_fkey'),
                   ('ActivityDependency_projectId_predecessorId_fkey'),
                   ('ActivityDependency_projectId_successorId_fkey'),
                   ('ActivityDependency_createdBy_fkey'),
                   ('ActivityDependency_revokedBy_fkey')) AS c(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_constraint k
        WHERE k.conname = c.name
          AND k.conrelid = 'public."ActivityDependency"'::regclass
          AND k.convalidated)
    UNION ALL
    SELECT 'index ' || i.name
      FROM (VALUES ('ActivityDependency_projectId_successorId_predecessorId_key'),
                   ('ActivityDependency_projectId_predecessorId_idx'),
                   ('ActivityDependency_projectId_successorId_idx')) AS i(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_class ci
         JOIN pg_index ix ON ix.indexrelid = ci.oid
        WHERE ci.relname = i.name
          AND ix.indrelid = 'public."ActivityDependency"'::regclass
          AND ix.indisvalid)
  ) q;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: "ActivityDependency" already exists but is not the table this migration installs — % absent or not in force. This migration creates that table and does not adopt an existing one, because it cannot know whether the rows in it were ever cycle-checked. Inspect the table and drop it if it is not wanted, then re-run.', v_wrong;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ActivityDependency" (
  "id"             TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "predecessorId"  TEXT NOT NULL,
  "successorId"    TEXT NOT NULL,
  "lagWorkingDays" INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"    TEXT NOT NULL,
  "createdByName"  TEXT NOT NULL,
  -- Removal is a REVOCATION, not a delete. See the DELETE seal further down for why.
  "revokedAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "revokedByName"  TEXT,
  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id"),
  -- NOT NULL is not the same as answerable. An empty string satisfies it, and so does a run of
  -- spaces or a lone tab — and the freeze below then makes that unusable value permanent, so an
  -- edge whose sequencing someone later disputes cannot say who imposed it. The point of storing
  -- attribution at all is to answer that question.
  --
  -- `[[:space:]]`, not a hand-assembled trim set. PostgreSQL reads `\v` in an E-string as the
  -- LETTER v, so E' \t\n\r\v\f' both fails to strip a real vertical tab and strips the v out of
  -- ordinary words. The POSIX class covers every ASCII whitespace character and cannot be
  -- mis-assembled.
  CONSTRAINT "ActivityDependency_attribution_check"
    CHECK ("createdById" !~ '^[[:space:]]*$' AND "createdByName" !~ '^[[:space:]]*$')
);

DO $$
BEGIN
  -- ── Attribution is bound to a MEMBER OF THIS PROJECT ────────────────────────────────────────
  -- A global `User` reference proves the id names somebody, not that the somebody had anything to
  -- do with this site. Without the project half, an edge on project A can be attributed —
  -- permanently, because the freeze below makes it permanent — to a user who is only ever a member
  -- of project B. That is cross-tenant attribution written into an immutable record.
  --
  -- `Membership(projectId, userId)` is the identity every other project-scoped evidence column in
  -- this repository binds to: `ActivityRequirement.responsibleId`, `Inspection.assigneeId`,
  -- `DrawingRecipient.userId`, `Activity.completionRequestedById`, `Decision.withdrawnById`.
  --
  -- The revoker reference is nullable and the key is MATCH SIMPLE, so a live edge — which has no
  -- revoker — switches the reference off rather than failing it. That is the intended reading
  -- here: the revocation CHECK below decides whether the three columns may be null at all, and
  -- this key decides who the revoker may be once there is one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_createdBy_fkey'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdBy_fkey"
      FOREIGN KEY ("projectId", "createdById") REFERENCES "Membership"("projectId", "userId")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_revokedBy_fkey'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_revokedBy_fkey"
      FOREIGN KEY ("projectId", "revokedById") REFERENCES "Membership"("projectId", "userId")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  -- ── Containment: both endpoints are activities of THIS row's project ────────────────────────
  -- Each foreign key carries the edge's own `projectId`, so an edge between two different projects
  -- does not exist as a representable row. That is the difference between an invariant and a
  -- convention: no service, import, script or hand-written UPDATE can produce one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_projectId_fkey'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_projectId_predecessorId_fkey'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
      FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_projectId_successorId_fkey'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_successorId_fkey"
      FOREIGN KEY ("projectId", "successorId") REFERENCES "Activity"("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  -- An activity waiting for itself can never start. Cheap to state, so state it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_no_self_check'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check"
      CHECK ("predecessorId" <> "successorId");
  END IF;
  -- A NEGATIVE lag would let a successor begin before its predecessor finished, which is the one
  -- thing this table exists to forbid. Zero is legal and is the common case.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_lag_nonneg_check'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_lag_nonneg_check"
      CHECK ("lagWorkingDays" >= 0);
  END IF;

  -- ── The revocation tuple moves together, or not at all ──────────────────────────────────────
  -- `revokedByName IS NOT NULL` is stated EXPLICITLY, and it is not redundant with the regex
  -- beside it. A CHECK constraint PASSES when its expression evaluates to UNKNOWN, and
  -- `NULL !~ '...'` is UNKNOWN — so the revoked arm without this clause accepts a revocation
  -- carrying a stamp and an id but NO NAME, which is exactly the erasure the DELETE seal below
  -- exists to prevent, arriving through a different door. Three-valued logic is the recurring trap
  -- in this file's history; every test that can meet a NULL is now written out two-valued in full.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ActivityDependency_revocation_check'
                    AND conrelid = 'public."ActivityDependency"'::regclass) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_revocation_check"
      CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokedByName" IS NULL)
             OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL
                 AND "revokedByName" IS NOT NULL
                 AND "revokedByName" !~ '^[[:space:]]*$'));
  END IF;
END $$;

-- One LIVE edge per ordered pair. Also the candidate key an EDGE-SCOPED dependency override must
-- reference: an override attached to the successor alone would excuse every predecessor at once,
-- so the override has to be able to name the exact pair.
-- PARTIAL, because a revoked edge stays on the record. Re-imposing a constraint that was withdrawn
-- earlier is an ordinary re-plan and must be allowed; what must not be allowed is two LIVE edges
-- for one ordered pair.
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_predecessorId_key"
  ON "ActivityDependency"("projectId", "successorId", "predecessorId")
  WHERE "revokedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_predecessorId_idx"
  ON "ActivityDependency"("projectId", "predecessorId");
CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_idx"
  ON "ActivityDependency"("projectId", "successorId");

-- ── Removal must not launder attribution ─────────────────────────────────────────────────────
-- The freeze below makes the record permanent against UPDATE. It has nothing to hold on to
-- against DELETE: an edge attributed to one person could be removed and the identical pair
-- re-inserted under another name, with both statements accepted and the original author gone from
-- the record. Since a disputed sequence is exactly what the attribution exists to answer, the
-- supported way to remove an edge is to REVOKE it — the row stays, both attributions stay, and the
-- partial unique above lets the pair be re-imposed afterwards.
CREATE OR REPLACE FUNCTION activity_dependency_no_delete() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'schedule: dependency edge % is not deletable — who imposed this sequencing constraint, and who withdrew it, are both part of the record. Revoke it instead (set revokedAt/revokedById/revokedByName).', OLD."id";
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_no_delete" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_no_delete"
  BEFORE DELETE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_no_delete();

-- A ROW trigger does not fire for TRUNCATE. TRUNCATE is a separate, statement-level event, and
-- without this seal one statement erases every edge and every attribution the DELETE seal above
-- was installed to protect — available to exactly the ordinary application role, which is the
-- writer this table is defended against. The repository already seals its evidence tables this way
-- (`T3CRepairAction_no_truncate`, `DecisionEvent_t4a_no_truncate`, `Decision_t4b_no_truncate`), and
-- the sanctioned test and seed resets disable the named seal for the duration of the reset rather
-- than the seal being left out.
--
-- What this does NOT cover, stated rather than left to be discovered: `DROP TABLE` and
-- `ALTER TABLE ... DROP COLUMN` fire no table trigger at all, so neither seal sees them. Only an
-- EVENT trigger does, and this file does not install one. `20270225000000_phase4_t3_correction3`
-- does install one for `T3CRepairAction`, because that table is the before-image evidence a repair
-- path depends on and creating the guard is worth requiring a superuser deploy role for. This
-- table is not in that position: it holds no rows on any deployed database, no service writes it
-- yet, and a dropped table is caught as drift by the next migration rather than read as a
-- schedule. Making a brand-new table's install depend on superuser to close a DDL hole nothing
-- currently reaches would be the more dangerous trade.
CREATE OR REPLACE FUNCTION activity_dependency_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  -- A TRUNCATE that erases NOTHING erases nothing, and it is permitted.
  --
  -- This is not a softening of the seal, it is the seal being about the right thing. What must not
  -- be destroyed is the RECORD — who imposed each constraint and who withdrew it. With no edges
  -- there is no such record, and refusing anyway would mean refusing every fixture reset that
  -- CASCADEs through "Activity" (this table has foreign keys into it) on databases where no edge
  -- has ever been written. That would buy nothing and would push the many callers into disabling
  -- the seal routinely — which is how a seal becomes a formality.
  --
  -- Race-free: TRUNCATE takes an ACCESS EXCLUSIVE lock on the table BEFORE firing this trigger, so
  -- no concurrent transaction can insert the first edge between this test and the erasure.
  IF NOT EXISTS (SELECT 1 FROM public."ActivityDependency") THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'schedule: "ActivityDependency" holds the sequencing record — who imposed each constraint and who withdrew it — and is never truncated. Revoke edges individually; a sanctioned destructive reset disables "ActivityDependency_no_truncate" by name for the duration of the reset.';
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_no_truncate" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_no_truncate"
  BEFORE TRUNCATE ON "ActivityDependency"
  FOR EACH STATEMENT EXECUTE FUNCTION activity_dependency_no_truncate();

-- ── The row is frozen; the ONE permitted transition is live → revoked ─────────────────────────
-- This replaces three separate column freezes that between them left three doors open, and the
-- single rule is both stronger and easier to check than the list was:
--
--   NOTHING about an edge changes, ever, except that a LIVE edge may be REVOKED, ONCE.
--
--   endpoints   — the cycle check runs at INSERT. If an edge could be re-pointed afterwards, a
--                 cycle would walk straight past it: insert A->B legally, then UPDATE it to B->A.
--   lag         — the lag is part of the sequencing claim, not a display attribute. Editing it in
--                 place leaves the frozen creation attribution saying that whoever imposed a
--                 seven-day constraint imposed today's zero-day one, with no record of the person
--                 who actually re-planned it. Changing a lag is revoking the edge and imposing the
--                 one you mean — the honest audit trail, and exactly what the partial unique index
--                 above makes room for.
--   attribution — who constrained the schedule, and when, is the whole point of recording it.
--   revocation  — once withdrawn, the withdrawal is evidence too. Left unfrozen, a direct writer
--                 could re-attribute the withdrawal to someone else, or set the three columns back
--                 to NULL and resurrect the edge — which also returns a live edge to the graph
--                 without passing the acyclicity trigger at all, since that trigger fires on
--                 INSERT.
--
-- The frozen half is compared as JSONB with the three revocation keys removed, rather than as a
-- list of column comparisons. A column added to this table later is then frozen BY DEFAULT: the
-- next person to widen the row cannot silently create a fourth mutable field by forgetting to add
-- it to a list. That is the failure this rewrite is fixing, so it should not be re-introduced in
-- the fix.
CREATE OR REPLACE FUNCTION activity_dependency_frozen() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF to_jsonb(NEW) - 'revokedAt' - 'revokedById' - 'revokedByName'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'revokedAt' - 'revokedById' - 'revokedByName' THEN
    RAISE EXCEPTION 'schedule: dependency edge % is frozen — its endpoints, lag and creation attribution are the record of a sequencing decision and are not rewritable. Revoke the edge and impose the one you mean.', OLD."id";
  END IF;

  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: dependency edge % was already revoked by % at % — a withdrawal is evidence, and is neither re-attributable nor reversible. Impose a new edge instead.',
      OLD."id", OLD."revokedByName", OLD."revokedAt";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_endpoints_frozen" ON "ActivityDependency";
DROP TRIGGER IF EXISTS "ActivityDependency_frozen" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_frozen"
  BEFORE UPDATE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_frozen();
DROP FUNCTION IF EXISTS activity_dependency_endpoints_frozen();

-- ── No cycles, and no cycles UNDER CONCURRENCY ────────────────────────────────────────────────
-- The reachability test is the easy half. The hard half is that two sessions can each add one
-- edge that is individually fine and jointly a loop:
--
--   T1: add A -> B   (asks: does B already reach A?  no)
--   T2: add B -> A   (asks: does A already reach B?  no)
--   both commit, and the graph now contains A -> B -> A.
--
-- Neither session is wrong on its own evidence. They touch different rows, so they conflict on
-- nothing, and under READ COMMITTED neither can see the other uncommitted row.
--
-- Row locking cannot fix this, and it is worth saying why rather than leaving the next reader to
-- rediscover it: `SELECT ... FOR UPDATE` over the existing edges re-checks the rows it scanned and
-- drops those that stopped matching, but it NEVER picks up rows that started matching while it
-- waited. A predicate over a set another transaction is still inserting into is not lockable that
-- way. (This repository has paid for that lesson once already, in the org last-owner guard.)
--
-- So the decision is serialized with a transaction-scoped ADVISORY lock on the project's schedule
-- graph. The second writer blocks until the first commits, then re-runs reachability with the
-- first edge visible and is refused. One lock, one key, always taken before any other work in
-- this trigger, so no ordering exists for two writers to invert.
--
-- The key namespace is deliberately its own. It is NOT the project readiness key: that one is
-- TRY-acquired and refuses rather than waits, so borrowing it would make a held readiness key
-- turn every schedule write into a spurious failure.
--
-- `SET search_path` is not decoration. Without it this function resolves `"ActivityDependency"`
-- through the CALLING session's search path, and `pg_temp` comes first by default. Any writer
-- holding the ordinary TEMP privilege could therefore create a temporary table of that name, and
-- the walk below would traverse it — finding nothing — while the row landed in the real table. Two
-- opposing edges would both commit and the graph would carry a cycle no guard ever saw. Pinning
-- the path, and qualifying the relation, closes that off: the trigger reads the same table the
-- insert writes, whoever calls it.
CREATE OR REPLACE FUNCTION activity_dependency_acyclic() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  v_path TEXT; v_closes_loop BOOLEAN; v_scope INT; v_key INT; v_isolation TEXT;
  v_frontier TEXT[]; v_next TEXT[]; v_seen TEXT[]; v_parent JSONB; v_node TEXT; v_from TEXT;
BEGIN
  -- A FRESH SNAPSHOT AFTER THE LOCK IS THE WHOLE MECHANISM, so the isolation level is checked
  -- before anything else.
  --
  -- The lock below makes the second writer wait for the first. What makes waiting useful is that
  -- the reachability query afterwards then SEES the first writer's edge. Under READ COMMITTED it
  -- does: every statement takes its own snapshot. Under REPEATABLE READ and SERIALIZABLE the
  -- snapshot is fixed when the transaction starts, and no amount of waiting refreshes it — so T2
  -- blocks, T1 commits A -> B, T2 wakes, walks a graph that still does not contain A -> B, and
  -- commits B -> A. Both succeed, and the cycle is in the table. The lock did its job; the read
  -- was answering a question about the past.
  --
  -- SERIALIZABLE would probably be caught by SSI's read-write conflict detection, but "probably"
  -- is not the standard for an invariant the rest of the system treats as physically impossible,
  -- and a trigger is the wrong place to reason about predicate locks. So the guard states its
  -- requirement instead of hoping: it needs a snapshot taken after the lock, only READ COMMITTED
  -- provides one, and anything else is refused rather than silently unguarded.
  v_isolation := current_setting('transaction_isolation');
  IF v_isolation <> 'read committed' THEN
    RAISE EXCEPTION 'schedule: dependency edges cannot be written under % isolation. The cycle check needs a snapshot taken AFTER the project graph lock, and only READ COMMITTED gives it one — under a fixed snapshot two transactions can each add an edge the other cannot see and compose a cycle. Write dependency edges in a READ COMMITTED transaction.',
      v_isolation;
  END IF;

  -- One project per transaction, derived from the locks this transaction ALREADY HOLDS.
  --
  -- The lock below is per project, and this is a ROW trigger, so a single statement spanning two
  -- projects takes two of them in the order the rows happen to arrive. One transaction inserting
  -- for P1 then P2, against another inserting for P2 then P1, is a textbook deadlock: each holds
  -- what the other is waiting for, and PostgreSQL kills one of two otherwise legal imports. No
  -- ordering rule inside a row trigger can fix that, because the trigger cannot see the rows still
  -- to come.
  --
  -- The first version of this remembered the claimed project in a custom GUC. That was the right
  -- idea in the wrong place: a GUC is ordinary session state, and any writer able to insert an edge
  -- is equally able to `set_config(..., true)` it back to empty between statements — which restores
  -- the deadlock exactly, and does so most easily for the direct-SQL writer this migration
  -- explicitly treats as an alternate writer. A guard a caller can switch off is a convention.
  --
  -- `pg_locks` is not switchable. A transaction-scoped advisory lock CANNOT be released before
  -- commit — `pg_advisory_unlock` refuses xact-scoped locks outright — so the set of graph locks
  -- this backend holds is authoritative transaction state, and it is exactly the state the ordering
  -- hazard is about. The key is taken in two-int form so the namespace is a column to filter on
  -- rather than a range to decode: `classid` is the namespace, `objid` the project.
  v_key := hashtext(NEW."projectId");
  SELECT l.objid::INT INTO v_scope
    FROM pg_locks l
   WHERE l.locktype = 'advisory' AND l.granted
     AND l.pid = pg_backend_pid()
     AND l.classid = hashtext('vitan:schedule-graph') AND l.objsubid = 2
     AND l.objid::INT <> v_key
   LIMIT 1;
  IF v_scope IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: this transaction already holds the dependency graph lock for another project, and edges for project % cannot be written in the same transaction — the per-project locks would be taken out of order and two such writers would deadlock. Write one project per transaction.',
      NEW."projectId";
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('vitan:schedule-graph'), v_key);

  IF NEW."predecessorId" = NEW."successorId" THEN
    RAISE EXCEPTION 'schedule: activity % cannot depend on itself.', NEW."successorId";
  END IF;

  -- Walk FORWARD from the proposed successor over the LIVE edges that already exist. If the
  -- proposed predecessor is reachable, then predecessor -> successor closes a loop.
  --
  -- `revokedAt IS NULL` is what makes this walk agree with the rest of the file. A revoked edge is
  -- a withdrawn constraint kept for the record; it binds nothing, and nobody is waiting on it.
  -- Traversing history would refuse the very re-plan the partial unique index exists to permit:
  -- revoke A -> B, and the legitimate replacement B -> A is rejected as a cycle through an edge
  -- that was withdrawn precisely to make room for it.
  --
  -- The walk carries NO path and dedupes on activity identity, and that is a correctness property
  -- rather than a tidiness one. Carrying a path forces `UNION ALL`, because two routes to the same
  -- activity differ in their path column — so a branching DAG enumerates every distinct ROUTE, not
  -- every node. Thirty diamonds in series is a graph of sixty-odd edges and roughly a billion
  -- paths, and the guard would exhaust the statement timeout on a schedule a person could draw by
  -- hand. `UNION` dedupes against the working set, so this visits each activity once and is linear
  -- in edges. Termination on an already-cyclic graph comes from the same dedup, so a diagnostic
  -- still cannot hang on the data it is diagnosing.
  WITH RECURSIVE reachable("activityId") AS (
    SELECT NEW."successorId"
    UNION
    SELECT d."successorId"
      FROM public."ActivityDependency" d
      JOIN reachable r ON d."predecessorId" = r."activityId"
     WHERE d."projectId" = NEW."projectId"
       AND d."revokedAt" IS NULL
  )
  SELECT EXISTS (SELECT 1 FROM reachable r WHERE r."activityId" = NEW."predecessorId")
    INTO v_closes_loop;

  IF v_closes_loop THEN
    -- Only now, and only to name ONE route for the person who has to fix it.
    --
    -- A per-path visited guard and a depth cap are NOT enough here, and the earlier version of this
    -- block proved it. Carrying a path forces `UNION ALL`, so the walk enumerates every distinct
    -- ROUTE rather than every node — and routes are exponential in a shape that is not exotic at
    -- all: two activities per layer, fully connected between layers, is about 120 edges across 31
    -- layers and over two billion paths. Capping the DEPTH does not help, because the explosion is
    -- in the breadth at each depth. So a rejected insert could still exhaust its statement timeout,
    -- and the guard would fail on the very graph it was refusing.
    --
    -- This is a breadth-first search that dedupes on activity identity and remembers how each
    -- activity was first reached. Every activity enters the frontier at most once, so it is linear
    -- in edges — the same property the detection walk above relies on — and the route is then read
    -- back off the parent map. There is no cap, because none is needed.
    v_frontier := ARRAY[NEW."successorId"];
    v_seen     := ARRAY[NEW."successorId"];
    v_parent   := '{}'::jsonb;

    WHILE COALESCE(array_length(v_frontier, 1), 0) > 0
          AND NOT (NEW."predecessorId" = ANY(v_seen)) LOOP
      v_next := ARRAY[]::TEXT[];
      FOR v_node, v_from IN
        SELECT DISTINCT ON (d."successorId") d."successorId", d."predecessorId"
          FROM public."ActivityDependency" d
         WHERE d."projectId" = NEW."projectId"
           AND d."revokedAt" IS NULL
           AND d."predecessorId" = ANY(v_frontier)
           AND NOT (d."successorId" = ANY(v_seen))
         ORDER BY d."successorId", d."predecessorId"
      LOOP
        v_parent := v_parent || jsonb_build_object(v_node, v_from);
        v_seen   := v_seen || v_node;
        v_next   := v_next || v_node;
      END LOOP;
      v_frontier := v_next;
    END LOOP;

    -- Read the route back from the predecessor to the successor, then state it forwards.
    IF NEW."predecessorId" = ANY(v_seen) THEN
      v_path := NEW."predecessorId";
      v_node := NEW."predecessorId";
      WHILE v_node <> NEW."successorId" LOOP
        v_node := v_parent ->> v_node;
        EXIT WHEN v_node IS NULL;
        v_path := v_node || ' -> ' || v_path;
      END LOOP;
    END IF;

    RAISE EXCEPTION 'schedule: % -> % would create a dependency cycle — % already leads back.',
      NEW."predecessorId", NEW."successorId",
      COALESCE(v_path, format('%s reaches %s', NEW."successorId", NEW."predecessorId"));
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_acyclic" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_acyclic"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_acyclic();

COMMIT;
