-- Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH.
--
-- One concern: a finish-to-start edge between two activities of one project, and the guarantee
-- that the set of those edges is always a valid DAG. Durations, the working calendar, baselines,
-- forecast computation and the readiness gate are separate units; this one installs the graph and
-- the rules that keep it honest, so nothing built on top has to re-check them.
--
-- Additive and retry-safe: one new table, no existing table altered, every object guarded so a
-- second application is a no-op. Nothing in the running release reads or writes this table, so it
-- is inert on deploy.

-- ── Pre-flight: this table must arrive ROW-FREE on a FIRST installation ───────────────────────
-- Evaluated BEFORE anything below is created, because the question it asks — "were these edges
-- written before the guards that judge them existed?" — stops being answerable the moment this
-- migration installs those guards. Asking it at the end of the file would read the triggers this
-- run just created and pass unconditionally, which is a check that cannot fail rather than a
-- check that holds.
--
--   fresh install  → the table does not exist yet; nothing to judge.
--   re-application → the guards are already present, so every row was cycle-checked on its way
--                    in, and this migration stays re-runnable for an operator repair.
--   anything else  → rows exist that no guard ever saw. Stop, and change nothing.
DO $$
DECLARE v_rows INT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    RETURN;
  END IF;
  -- Scoped by `tgrelid`, not by name alone. A trigger name is unique per TABLE, not per database,
  -- so an unrelated table — in any schema — carrying a trigger called `ActivityDependency_acyclic`
  -- would otherwise satisfy this test. That matters precisely here: this branch decides that the
  -- rows already present were judged on their way in, and getting it wrong the optimistic way lets
  -- a pre-existing cycle survive the very installation meant to make cycles impossible.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'ActivityDependency_acyclic' AND NOT tgisinternal
                AND tgrelid = to_regclass('public."ActivityDependency"')) THEN
    RAISE NOTICE 'schedule: the dependency guards are already installed — this is a re-application, and the rows present were judged by those guards when they were written.';
    RETURN;
  END IF;
  -- Lock BEFORE counting, and do not let go until this migration commits.
  --
  -- Counting an unlocked table answers a question about committed rows only. A writer that has
  -- inserted A -> B and B -> A but not yet committed is invisible to this COUNT, so the migration
  -- would read zero, proceed, and add the foreign keys and CHECKs — none of which have any opinion
  -- about cycles — while that writer commits behind it. The trigger arrives last, and the cycle it
  -- exists to prevent is already in the table, permanently, having been validated as structurally
  -- legal on the way past.
  --
  -- ACCESS EXCLUSIVE excludes every writer and every reader. Requesting it here also makes the
  -- migration WAIT for an in-flight writer rather than race it: when the lock is granted, that
  -- transaction has ended, and its rows are either committed — and therefore counted, and the
  -- migration aborts — or rolled back. There is no third outcome. The lock is held for the rest of
  -- this migration's transaction, so no writer can slip in between this count and the trigger.
  LOCK TABLE "ActivityDependency" IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO v_rows FROM "ActivityDependency";
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'schedule: "ActivityDependency" already holds % row(s) before its guards existed — those edges were never cycle-checked. Aborting with the database unchanged.', v_rows;
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

-- …and again, guarded, because the definition above is not reached on every path. `CREATE TABLE
-- IF NOT EXISTS` skips its ENTIRE body when the table is already there — which is exactly the
-- partial-install state this migration is written to repair, and the state a `prisma db push`
-- leaves behind. Without this the re-run reports success while whitespace attribution stays
-- insertable and the freeze then makes it permanent. Every other constraint here is installed
-- through a guarded ALTER for the same reason; this one was inline only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_attribution_check'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_attribution_check"
      CHECK ("createdById" !~ '^[[:space:]]*$' AND "createdByName" !~ '^[[:space:]]*$');
  END IF;
END $$;

-- The primary key, for the same reason and by the same route. `CREATE TABLE IF NOT EXISTS` skips
-- the key along with everything else in its body, and a table without one silently accepts
-- duplicate ids — which the ordered-pair unique index below does NOT catch, because two rows may
-- share an id while naming different endpoints. This is the same class of gap as the attribution
-- CHECK above rather than a second coincidence: every constraint declared inline needs a guarded
-- ALTER beside it, and these are now all of them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_pkey'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id");
  END IF;
END $$;

-- ── F-C: the recorded creator is a real user ─────────────────────────────────────────────────
-- `createdById` is the evidence of WHO imposed the sequencing constraint, and the freeze below
-- makes whatever lands here permanent. A non-blank string is not an identity: without this a
-- direct writer can record `forged-user` and the freeze preserves the fabrication forever. Bound
-- the way every other attributed record in this repository binds it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_createdById_fkey'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- ── Containment: both endpoints are activities of THIS row's project ──────────────────────────
-- Each foreign key carries the edge's own `projectId`, so an edge between two different projects
-- does not exist as a representable row. That is the difference between an invariant and a
-- convention: no service, import, script or hand-written UPDATE can produce one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_fkey'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_predecessorId_fkey'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
      FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_successorId_fkey'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_successorId_fkey"
      FOREIGN KEY ("projectId", "successorId") REFERENCES "Activity"("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- One edge per ordered pair. Also the candidate key an EDGE-SCOPED dependency override must
-- reference: an override attached to the successor alone would excuse every predecessor at once,
-- so the override has to be able to name the exact pair.
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_predecessorId_key"
  ON "ActivityDependency"("projectId", "successorId", "predecessorId");
CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_predecessorId_idx"
  ON "ActivityDependency"("projectId", "predecessorId");
CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_idx"
  ON "ActivityDependency"("projectId", "successorId");

DO $$
BEGIN
  -- An activity waiting for itself can never start. Cheap to state, so state it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_no_self_check'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check"
      CHECK ("predecessorId" <> "successorId");
  END IF;
  -- A NEGATIVE lag would let a successor begin before its predecessor finished, which is the one
  -- thing this table exists to forbid. Zero is legal and is the common case.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_lag_nonneg_check'
                  AND conrelid = to_regclass('public."ActivityDependency"')) THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_lag_nonneg_check"
      CHECK ("lagWorkingDays" >= 0);
  END IF;
END $$;

-- ── Endpoint identity is frozen ───────────────────────────────────────────────────────────────
-- The cycle check below runs at INSERT. If an edge could later be re-pointed, a cycle would walk
-- straight past it: insert A->B legally, then UPDATE it to B->A. Freezing the endpoints closes
-- that door and keeps the check meaningful, and it costs nothing real — re-sequencing is removing
-- an edge and adding the one you meant, which is also the honest audit trail. `lagWorkingDays`
-- stays editable, so an ordinary re-plan is an ordinary UPDATE.
-- Pinned like its sibling. This function resolves no relation — it only compares OLD to NEW — so
-- unlike the acyclicity guard it was never exploitable through the caller's path. It is pinned
-- anyway because "which of these two seals reads a table?" is not a question a future reader
-- should have to re-derive to know which one is safe.
CREATE OR REPLACE FUNCTION activity_dependency_endpoints_frozen() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."predecessorId" IS DISTINCT FROM OLD."predecessorId"
     OR NEW."successorId" IS DISTINCT FROM OLD."successorId" THEN
    RAISE EXCEPTION 'schedule: the endpoints of dependency edge % are frozen — remove the edge and add the one you mean.', OLD."id";
  END IF;
  -- WHO constrained the schedule, and WHEN, is the whole point of recording it. A sequencing
  -- dispute is answerable only if the attribution cannot be rewritten afterwards, so the creation
  -- provenance is frozen exactly as hard as the endpoints are. Freezing the endpoints alone left
  -- an alternate writer able to keep the constraint and change who imposed it.
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdByName" IS DISTINCT FROM OLD."createdByName"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'schedule: the creation provenance of dependency edge % is frozen — who imposed a constraint, and when, is not rewritable.', OLD."id";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_endpoints_frozen" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_endpoints_frozen"
  BEFORE UPDATE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_endpoints_frozen();

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

  -- Walk FORWARD from the proposed successor over the edges that already exist. If the proposed
  -- predecessor is reachable, then predecessor -> successor closes a loop.
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


