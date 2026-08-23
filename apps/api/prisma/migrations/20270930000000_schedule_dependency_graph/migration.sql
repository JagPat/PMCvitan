-- Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH.
--
-- One concern: a finish-to-start edge between two activities of one project, and the guarantee
-- that the set of those edges is always a valid DAG. Durations, the working calendar, baselines,
-- forecast computation and the readiness gate are separate units; this one installs the graph and
-- the rules that keep it honest, so nothing built on top has to re-check them.
--
-- Additive: one new table, no existing table altered.

-- ══ THIS MIGRATION CREATES "ActivityDependency". IT DOES NOT ADOPT ONE. ════════════════════════
--
-- That is the whole of its policy toward a table that is already there: section 1 ABORTS, names
-- the table, and states the one action that clears it. There is no verification of pre-existing
-- rows, no definition comparison, no drop-and-recreate repair, and no column-contract preflight,
-- because there is no adopt path for any of them to serve.
--
-- WHY REFUSING IS SAFE HERE, stated as a fact about the deployed estate rather than asserted as a
-- principle: `ActivityDependency` is a NEW table. It exists in no released schema, no service
-- writes it, and it therefore holds ZERO ROWS on every deployed database. "Inspect the table, drop
-- it if it is not wanted, re-run" destroys nothing — which is exactly what is NOT true of the
-- diagnostic-first migrations elsewhere in this repository (§T45, §P4T2C, §P4LC2, §P4T3C3), each
-- of which aborts over real operational data and needs a judgement to repair.
--
-- WHY THIS IS NOT THE DEFECT PR #363 WAS CLOSED FOR. #363 also refused a pre-existing table, and
-- that refusal was found (PR #408 F1) — but the finding was about the COMBINATION, not the
-- refusal. `scripts/migrate.sh` lists this migration in ALWAYS_EXECUTE, which leaves it PENDING on
-- the P3005 baseline path so its raw guards really execute; #363's file then refused and exited 1,
-- a deterministic dead end presented as if the path worked. The ALWAYS_EXECUTE entry is KEPT,
-- because its reasoning is right — `schema.prisma` can describe neither a CHECK nor a trigger, so
-- baselining this migration WITHOUT running it would record guards that never existed. What
-- changes is that the abort is now a DOCUMENTED, REPAIRABLE, INTENDED outcome: the message names
-- `docs/RUNBOOK.md` §B1, that section carries the operator procedure, and
-- `scripts/schedule-b1-baseline-proof.sh` runs the real production runner through both halves —
-- the install on a database without the table, and the abort-then-repair on one with it.
--
-- DEFERRED, and named rather than silently dropped: real adoption of a `prisma db push`-shaped
-- table — reconciling its column contract, its constraints and its indexes, and deciding what may
-- honestly be said about rows written before any guard existed — is a SEPARATE future unit, to be
-- built if and when a database that needs it exists. None does today.

-- ONE TRANSACTION, PROVIDED BY THE CALLER — this file deliberately carries NO `BEGIN;`/`COMMIT;`,
-- and that is a correctness decision rather than a style one. Do not add them back.
--
-- The transaction itself is what makes this file re-runnable now that there is no adopt path.
-- Every statement below either all commits or all rolls back, so a run that fails for any reason —
-- the section 1 abort, a lost connection, a fixture that violates a constraint — leaves the
-- database with no table, no function and no trigger. The next run is therefore a FRESH INSTALL
-- again, which is the only shape this file knows how to be. Idempotence by object-level guards is
-- what an adopt path needs; a transaction is what a create-only path needs, and it is stronger.
--
-- Both callers supply it:
--   * `prisma migrate deploy` runs each migration in ONE transaction. MEASURED, not assumed: a
--     two-statement variant of this file whose SECOND statement raised left the table its FIRST
--     statement created absent afterwards. (The standing indirect evidence is that
--     `CREATE INDEX CONCURRENTLY` cannot be used in a Prisma migration at all.)
--   * every psql caller passes `--single-transaction` — the probe suite's `applyMigration`, and
--     anyone applying this file by hand.
--
-- WHY AN EXPLICIT `BEGIN;` HERE WOULD BE ACTIVELY HARMFUL, since the obvious instinct is to write
-- one: the schema engine sends this script to a connection that is ALREADY in a transaction and
-- sends its statements one at a time. An explicit `BEGIN` is then a no-op warning, section 1's
-- RAISE aborts the transaction, and every remaining statement fails with `current transaction is
-- aborted` — so the error the engine reports is the LAST one, and the named diagnostic an operator
-- needs is discarded. Measured: with `BEGIN;`/`COMMIT;` present, `migrate deploy` printed
-- `ERROR: current transaction is aborted, commands ignored until end of transaction block`;
-- without them it printed the section 1 message verbatim, RUNBOOK pointer and all.
-- `scripts/schedule-b1-baseline-proof.sh` asserts that message through the real production runner,
-- so re-introducing the explicit transaction fails a required CI job rather than quietly costing
-- the next operator their diagnostic.
--
-- The schema is still pinned. Without it psql takes the caller's search path — so under a role
-- whose path names a per-user or temporary schema first, every unqualified CREATE below would
-- build the whole graph somewhere else and commit successfully, while the application's `public`
-- schema still has no table. `SET LOCAL` scopes it to the caller's transaction, so it cannot leak
-- into the connection the deploy goes on to use.
SET LOCAL search_path = public;

-- ── 1. A table that is already there is not this one ──────────────────────────────────────────
-- `CREATE TABLE` without `IF NOT EXISTS` would refuse on its own, but with `relation
-- "ActivityDependency" already exists` — which names neither what this file expected nor what an
-- operator should do about it. So the refusal is asked first, in terms someone can act on.
DO $$
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: table "ActivityDependency" already exists. This migration CREATES that table and does not adopt one — it can say nothing honest about columns, constraints, triggers or rows it did not install. Inspect the table (it holds no rows on any deployed database); if it is not wanted, drop it and re-run. Procedure: docs/RUNBOOK.md section B1.';
  END IF;
END $$;

-- ── 2. The table, with its keys and its CHECKs declared INLINE ────────────────────────────────
-- Inline is possible precisely because section 1 refuses an existing table: `CREATE TABLE` here is
-- unconditional, so nothing in this definition can be skipped. (The predecessor of this file wrote
-- every constraint as a separate guarded ALTER, because `CREATE TABLE IF NOT EXISTS` is skipped
-- WHOLESALE when the table is present — which would have left the CHECKs silently absent on
-- exactly the databases that most needed them. With no adopt path that hazard does not exist.)
CREATE TABLE "ActivityDependency" (
  "id"             TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "predecessorId"  TEXT NOT NULL,
  "successorId"    TEXT NOT NULL,
  "lagWorkingDays" INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"    TEXT NOT NULL,
  "createdByName"  TEXT NOT NULL,
  -- Removal is a REVOCATION, not a delete. See the DELETE seal in section 5 for why.
  "revokedAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "revokedByName"  TEXT,

  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id"),

  -- Attribution that is present but not ANSWERABLE is worse than none: section 6 freezes whatever
  -- is in these columns, so an illegible value is a permanent one.
  CONSTRAINT "ActivityDependency_attribution_check"
    CHECK ("createdById" !~ '^[[:space:]]*$' AND "createdByName" !~ '^[[:space:]]*$'),

  -- The revocation tuple moves together, or not at all. `revokedByName IS NOT NULL` is stated
  -- EXPLICITLY and is not redundant with the regex beside it: a CHECK PASSES when its expression
  -- is UNKNOWN, and `NULL !~ '...'` is UNKNOWN — so without that clause the revoked arm accepts a
  -- withdrawal carrying a stamp and an id but NO NAME, which is the erasure the DELETE seal exists
  -- to prevent arriving through another door. Three-valued logic is this file's recurring trap;
  -- every test that can meet a NULL is written two-valued in full.
  --
  -- BOTH revocation identity columns are checked for blankness, not just the name. The foreign key
  -- proves the id names a membership; it does not prove the id is LEGIBLE, and a writer able to
  -- create a whitespace-id user and membership could revoke through it. That attribution is then
  -- permanent (section 6), which is exactly the asymmetry the creation arm above already refuses
  -- on `createdById`. A withdrawal answers "who", or it is not a withdrawal.
  CONSTRAINT "ActivityDependency_revocation_check"
    CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokedByName" IS NULL)
           OR ("revokedAt" IS NOT NULL
               AND "revokedById"   IS NOT NULL AND "revokedById"   !~ '^[[:space:]]*$'
               AND "revokedByName" IS NOT NULL AND "revokedByName" !~ '^[[:space:]]*$')),

  -- An activity waiting for itself can never start. Cheap to state, so state it.
  CONSTRAINT "ActivityDependency_no_self_check" CHECK ("predecessorId" <> "successorId"),

  -- A NEGATIVE lag would let a successor begin before its predecessor finished, which is the one
  -- thing this table exists to forbid. Zero is legal and is the common case.
  CONSTRAINT "ActivityDependency_lag_nonneg_check" CHECK ("lagWorkingDays" >= 0),

  -- Containment: each endpoint key carries the edge's OWN `projectId`, so an edge between two
  -- projects is not a representable row. That is the difference between an invariant and a
  -- convention — no service, import, script or hand-written UPDATE can produce one.
  CONSTRAINT "ActivityDependency_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
    FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ActivityDependency_projectId_successorId_fkey"
    FOREIGN KEY ("projectId", "successorId") REFERENCES "Activity"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,

  -- Attribution is bound to a MEMBER OF THIS PROJECT. A global `User` reference proves the id
  -- names somebody, not that the somebody had anything to do with this site — so without the
  -- project half an edge on project A can be attributed, permanently (section 6 freezes it), to a
  -- user who is only ever a member of project B. `Membership(projectId, userId)` is the identity
  -- every other project-scoped evidence column in this repository binds to
  -- (`ActivityRequirement.responsibleId`, `Inspection.assigneeId`, `DrawingRecipient.userId`,
  -- `Activity.completionRequestedById`, `Decision.withdrawnById`).
  --
  -- The revoker key is MATCH SIMPLE over a nullable column, so a live edge — which has no revoker
  -- — switches the reference off rather than failing it. The revocation CHECK decides whether
  -- those columns may be null at all; this key decides who the revoker may be.
  CONSTRAINT "ActivityDependency_createdBy_fkey"
    FOREIGN KEY ("projectId", "createdById") REFERENCES "Membership"("projectId", "userId")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ActivityDependency_revokedBy_fkey"
    FOREIGN KEY ("projectId", "revokedById") REFERENCES "Membership"("projectId", "userId")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- NOTHING MAY WRITE THIS TABLE BETWEEN ITS CREATION AND ITS SEALS.
--
-- On this path the statement is REDUNDANT and is kept deliberately rather than left implicit: the
-- `CREATE TABLE` above already took ACCESS EXCLUSIVE and PostgreSQL holds it until COMMIT, so no
-- other session can so much as see the table before every guard below is in place. Stating the
-- requirement as a statement rather than as a comment means the invariant is asserted where it is
-- relied on, and costs one lock acquisition the transaction already owns.
--
-- ACCESS EXCLUSIVE, not a weaker mode: the writer to shut out is an ordinary INSERT, and only this
-- mode conflicts with the ROW EXCLUSIVE lock an INSERT takes.
LOCK TABLE "ActivityDependency" IN ACCESS EXCLUSIVE MODE;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────────────────────
-- Created unconditionally, like everything else here: the table was created three statements ago
-- and has no indexes but its primary key, so there is nothing to detect and nothing to repair.
--
-- The unique index is PARTIAL because a revoked edge stays on the record: re-imposing a constraint
-- withdrawn earlier is an ordinary re-plan, and what must not be allowed is two LIVE edges for one
-- ordered pair. It is also the candidate key an EDGE-SCOPED dependency override must reference —
-- an override attached to the successor alone would excuse every predecessor at once. Prisma
-- cannot express a partial unique, which is why it is raw SQL and why `schema.prisma` says so.
CREATE UNIQUE INDEX "ActivityDependency_projectId_successorId_predecessorId_key"
  ON "ActivityDependency" ("projectId", "successorId", "predecessorId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX "ActivityDependency_projectId_predecessorId_idx"
  ON "ActivityDependency" ("projectId", "predecessorId");

CREATE INDEX "ActivityDependency_projectId_successorId_idx"
  ON "ActivityDependency" ("projectId", "successorId");

-- ── 4. An edge is BORN LIVE ───────────────────────────────────────────────────────────────────
-- The revocation CHECK says the three revocation columns move together. It cannot say WHEN they
-- may first be set, because a CHECK sees one row and cannot tell an INSERT from an UPDATE — so its
-- revoked arm is satisfied by a row that arrives ALREADY REVOKED. Such a row is not a withdrawal;
-- it records a withdrawal that never happened, and every other guard here then works in its
-- favour: section 6 refuses to touch an already-revoked row, so the fabrication is permanent;
-- section 7's walk reads LIVE edges only, so it passes trivially; and the partial unique index
-- covers live rows only, so one ordered pair can accumulate unlimited fabricated withdrawals.
--
-- A trigger can tell an INSERT from an UPDATE, so the rule lives here — written two-valued in
-- full, never a comparison that could evaluate to UNKNOWN and be waved through.
CREATE OR REPLACE FUNCTION activity_dependency_born_live() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."revokedAt"        IS NOT NULL
     OR NEW."revokedById"   IS NOT NULL
     OR NEW."revokedByName" IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: dependency edge % cannot be created already revoked — a withdrawal is the record of a constraint that once stood, and this one never did. Insert the edge live, then revoke it.', NEW."id";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ActivityDependency_born_live"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_born_live();

-- ── 5. Removal must not launder attribution ───────────────────────────────────────────────────
-- Section 6 makes the record permanent against UPDATE. It has nothing to hold on to against
-- DELETE: an edge attributed to one person could be removed and the identical pair re-inserted
-- under another name, both statements accepted and the original author gone from the record. Since
-- a disputed sequence is what the attribution exists to answer, the supported way to remove an
-- edge is to REVOKE it — the row stays, both attributions stay, and the partial unique index lets
-- the pair be re-imposed afterwards.
CREATE OR REPLACE FUNCTION activity_dependency_no_delete() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'schedule: dependency edge % is not deletable — who imposed this sequencing constraint, and who withdrew it, are both part of the record. Revoke it instead (set revokedAt/revokedById/revokedByName).', OLD."id";
END $$;

CREATE TRIGGER "ActivityDependency_no_delete"
  BEFORE DELETE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_no_delete();

-- A ROW trigger does not fire for TRUNCATE. TRUNCATE is a separate, statement-level event, and
-- without this seal one statement erases every edge and every attribution the DELETE seal was
-- installed to protect — available to exactly the ordinary application role, which is the writer
-- this table is defended against. The repository already seals its evidence tables this way
-- (`T3CRepairAction_no_truncate`, `DecisionEvent_t4a_no_truncate`, `Decision_t4b_no_truncate`), and
-- the sanctioned test and seed resets disable the named seal for the duration of the reset.
--
-- What this does NOT cover, stated rather than left to be discovered: `DROP TABLE` and `ALTER
-- TABLE ... DROP COLUMN` fire no table trigger at all. Only an EVENT trigger does, and installing
-- one requires a superuser deploy role — a trade `20270225000000_phase4_t3_correction3` makes for
-- `T3CRepairAction` because that table is the before-image evidence a repair path depends on. This
-- table is not in that position: it holds no rows on any deployed database, no service writes it
-- yet, and a dropped table is caught as drift by the next migration rather than read as a schedule.
CREATE OR REPLACE FUNCTION activity_dependency_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  -- A TRUNCATE that erases NOTHING erases nothing, and it is permitted.
  --
  -- This is not a softening of the seal; it is the seal being about the right thing. What must not
  -- be destroyed is the RECORD — who imposed each constraint and who withdrew it. With no edges
  -- there is no such record, and refusing anyway would refuse every fixture reset that CASCADEs
  -- through "Activity" (this table has foreign keys into it) on databases where no edge has ever
  -- been written. That buys nothing and pushes the many callers into disabling the seal routinely,
  -- which is how a seal becomes a formality.
  --
  -- Race-free: TRUNCATE takes an ACCESS EXCLUSIVE lock on the table BEFORE firing this trigger, so
  -- no concurrent transaction can insert the first edge between this test and the erasure.
  IF NOT EXISTS (SELECT 1 FROM public."ActivityDependency") THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'schedule: "ActivityDependency" holds the sequencing record — who imposed each constraint and who withdrew it — and is never truncated. Revoke edges individually; a sanctioned destructive reset disables "ActivityDependency_no_truncate" by name for the duration of the reset.';
END $$;

CREATE TRIGGER "ActivityDependency_no_truncate"
  BEFORE TRUNCATE ON "ActivityDependency"
  FOR EACH STATEMENT EXECUTE FUNCTION activity_dependency_no_truncate();

-- ── 6. The row is frozen; the ONE permitted transition is live → revoked ──────────────────────
--   NOTHING about an edge changes, ever, except that a LIVE edge may be REVOKED, ONCE.
--
--   endpoints   — the cycle check runs at INSERT. If an edge could be re-pointed afterwards, a
--                 cycle would walk straight past it: insert A->B legally, then UPDATE it to B->A.
--   lag         — part of the sequencing claim, not a display attribute. Editing it in place
--                 leaves the frozen creation attribution saying that whoever imposed a seven-day
--                 constraint imposed today's zero-day one, with no record of the person who
--                 actually re-planned it. Changing a lag is revoking the edge and imposing the one
--                 you mean — which is what the partial unique index makes room for.
--   attribution — who constrained the schedule, and when, is the whole point of recording it.
--   revocation  — once withdrawn, the withdrawal is evidence too. Left unfrozen, a direct writer
--                 could re-attribute it, or set the three columns back to NULL and resurrect the
--                 edge — returning a live edge to the graph without ever passing the acyclicity
--                 trigger, which fires on INSERT.
--
-- The frozen half is compared as JSONB with the three revocation keys removed, rather than as a
-- list of column comparisons, so a column added to this table later is frozen BY DEFAULT: the next
-- person to widen the row cannot create a fourth mutable field by forgetting a list entry.
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

CREATE TRIGGER "ActivityDependency_frozen"
  BEFORE UPDATE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_frozen();

-- ── 7. No cycles, and no cycles UNDER CONCURRENCY ─────────────────────────────────────────────
-- The reachability test is the easy half. The hard half is that two sessions can each add one edge
-- that is individually fine and jointly a loop:
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
-- first edge visible and is refused. One lock, one key, always taken before any other work in this
-- trigger, so no ordering exists for two writers to invert. The key namespace is deliberately its
-- own: the project readiness key is TRY-acquired and refuses rather than waits, so borrowing it
-- would make a held readiness key turn every schedule write into a spurious failure.
--
-- `SET search_path` is not decoration. Without it this function resolves `"ActivityDependency"`
-- through the CALLING session's search path, and `pg_temp` comes first by default — so any writer
-- holding the ordinary TEMP privilege could create a temporary table of that name, and the walk
-- would traverse it, finding nothing, while the row landed in the real table. Pinning the path and
-- qualifying the relation means the trigger reads the same table the insert writes.
CREATE OR REPLACE FUNCTION activity_dependency_acyclic() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  v_path TEXT; v_closes_loop BOOLEAN; v_scope INT; v_key INT; v_isolation TEXT;
  v_frontier TEXT[]; v_next TEXT[]; v_parent JSONB; v_level JSONB; v_node TEXT;
BEGIN
  -- A FRESH SNAPSHOT AFTER THE LOCK IS THE WHOLE MECHANISM, so the isolation level is checked
  -- before anything else. The lock makes the second writer WAIT; what makes waiting useful is that
  -- the reachability query afterwards SEES the first writer's edge. Under READ COMMITTED it does —
  -- every statement takes its own snapshot. Under REPEATABLE READ and SERIALIZABLE the snapshot is
  -- fixed when the transaction starts and no amount of waiting refreshes it, so T2 blocks, T1
  -- commits A -> B, T2 wakes, walks a graph that still does not contain A -> B, and commits B -> A.
  -- Both succeed and the cycle is in the table. SERIALIZABLE would probably be caught by SSI's
  -- read-write conflict detection, but "probably" is not the standard for an invariant the rest of
  -- the system treats as physically impossible, and a trigger is the wrong place to reason about
  -- predicate locks. So the guard states its requirement instead of hoping.
  v_isolation := current_setting('transaction_isolation');
  IF v_isolation <> 'read committed' THEN
    RAISE EXCEPTION 'schedule: dependency edges cannot be written under % isolation. The cycle check needs a snapshot taken AFTER the project graph lock, and only READ COMMITTED gives it one — under a fixed snapshot two transactions can each add an edge the other cannot see and compose a cycle. Write dependency edges in a READ COMMITTED transaction.',
      v_isolation;
  END IF;

  -- One project per transaction, derived from the locks this transaction ALREADY HOLDS.
  --
  -- The lock below is per project, and this is a ROW trigger, so a single statement spanning two
  -- projects takes two of them in the order the rows happen to arrive. One transaction inserting
  -- for P1 then P2, against another inserting for P2 then P1, is a textbook deadlock, and no
  -- ordering rule inside a row trigger can fix it because the trigger cannot see the rows still to
  -- come.
  --
  -- The scope is NOT remembered in a GUC. A GUC is ordinary session state, and any writer able to
  -- insert an edge is equally able to `set_config(..., true)` it back to empty between statements —
  -- restoring the deadlock, and most easily for the direct-SQL writer this file explicitly treats
  -- as an alternate writer. `pg_locks` is not switchable: a transaction-scoped advisory lock CANNOT
  -- be released before commit (`pg_advisory_unlock` refuses xact-scoped locks outright), so the set
  -- of graph locks this backend holds is authoritative transaction state. The key is taken in
  -- two-int form so the namespace is a column to filter on: `classid` namespace, `objid` project.
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
  -- Traversing history would refuse the very re-plan the partial unique index exists to permit.
  --
  -- The walk carries NO path and dedupes on activity identity, and that is a correctness property
  -- rather than a tidiness one. Carrying a path forces `UNION ALL`, because two routes to the same
  -- activity differ in their path column — so a branching DAG enumerates every distinct ROUTE, not
  -- every node. `UNION` dedupes against the working set, so this visits each activity once and is
  -- linear in edges. Termination on an already-cyclic graph comes from the same dedup.
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
    -- A path-carrying recursive CTE is not an option here, and neither are a depth cap, `LIMIT 1`,
    -- or PostgreSQL 14's `SEARCH`/`CYCLE` clauses: all of them are defined over the same UNION ALL
    -- enumeration, and routes are exponential in a shape that is not exotic at all — two activities
    -- per layer, fully connected between layers, is about 120 edges across 31 layers and over two
    -- billion routes. Capping the DEPTH does not help, because the explosion is in the breadth at
    -- each depth.
    --
    -- So this is a breadth-first search that dedupes on activity identity and remembers how each
    -- activity was first reached; the route is then read back off the parent map. ONE jsonb map
    -- serves as BOTH the parent record and the seen set, built one LEVEL at a time. Two growing
    -- TEXT[]s would make the ITERATION count linear but not the work: `NOT (successorId =
    -- ANY(v_seen))` is a linear array scan per candidate edge (O(E*N) comparisons) and
    -- `v_seen := v_seen || v_node` rebuilds the array per node (O(N^2)) — all of it while holding
    -- the project graph lock, so every other schedule write for that project queues behind a
    -- diagnostic. `v_parent ? key` is a binary search over jsonb's sorted keys, and one
    -- `jsonb_object_agg` per level replaces one array rebuild per node.
    v_frontier := ARRAY[NEW."successorId"];
    v_parent   := jsonb_build_object(NEW."successorId", NULL);   -- the root: seen, no parent

    WHILE COALESCE(array_length(v_frontier, 1), 0) > 0
          AND NOT (v_parent ? NEW."predecessorId") LOOP
      SELECT COALESCE(jsonb_object_agg(s.succ, s.pred), '{}'::jsonb),
             COALESCE(array_agg(s.succ), ARRAY[]::TEXT[])
        INTO v_level, v_next
        FROM (SELECT DISTINCT ON (d."successorId")
                     d."successorId" AS succ, d."predecessorId" AS pred
                FROM public."ActivityDependency" d
               WHERE d."projectId" = NEW."projectId"
                 AND d."revokedAt" IS NULL
                 AND d."predecessorId" = ANY(v_frontier)
                 AND NOT (v_parent ? d."successorId")
               ORDER BY d."successorId", d."predecessorId") s;
      v_parent   := v_parent || v_level;
      v_frontier := v_next;
    END LOOP;

    -- Read the route back from the predecessor to the successor, then state it forwards. The root
    -- carries a JSON null parent, so `->>` returns NULL there and the walk stops.
    IF v_parent ? NEW."predecessorId" THEN
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

CREATE TRIGGER "ActivityDependency_acyclic"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_acyclic();
