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
  IF to_regclass('"ActivityDependency"') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'ActivityDependency_acyclic' AND NOT tgisinternal) THEN
    RAISE NOTICE 'schedule: the dependency guards are already installed — this is a re-application, and the rows present were judged by those guards when they were written.';
    RETURN;
  END IF;
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
  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id")
);

-- ── Containment: both endpoints are activities of THIS row's project ──────────────────────────
-- Each foreign key carries the edge's own `projectId`, so an edge between two different projects
-- does not exist as a representable row. That is the difference between an invariant and a
-- convention: no service, import, script or hand-written UPDATE can produce one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_fkey') THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_predecessorId_fkey') THEN
    ALTER TABLE "ActivityDependency"
      ADD CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
      FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_projectId_successorId_fkey') THEN
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_no_self_check') THEN
    ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check"
      CHECK ("predecessorId" <> "successorId");
  END IF;
  -- A NEGATIVE lag would let a successor begin before its predecessor finished, which is the one
  -- thing this table exists to forbid. Zero is legal and is the common case.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityDependency_lag_nonneg_check') THEN
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
CREATE OR REPLACE FUNCTION activity_dependency_endpoints_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION activity_dependency_acyclic() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_path TEXT; v_closes_loop BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('vitan:schedule-graph:' || NEW."projectId"));

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
      FROM "ActivityDependency" d
      JOIN reachable r ON d."predecessorId" = r."activityId"
     WHERE d."projectId" = NEW."projectId"
  )
  SELECT EXISTS (SELECT 1 FROM reachable r WHERE r."activityId" = NEW."predecessorId")
    INTO v_closes_loop;

  IF v_closes_loop THEN
    -- Only now, and only to name ONE route for the person who has to fix it. This runs solely on
    -- the rejection path and is bounded twice over — by the per-path visited guard and by an
    -- explicit depth cap — so the expensive shape above cannot be reached through it. If no route
    -- fits inside the cap the refusal still stands; only its detail is coarser.
    WITH RECURSIVE walk("activityId", "path") AS (
      SELECT NEW."successorId", ARRAY[NEW."successorId"]
      UNION ALL
      SELECT d."successorId", w."path" || d."successorId"
        FROM "ActivityDependency" d
        JOIN walk w ON d."predecessorId" = w."activityId"
       WHERE d."projectId" = NEW."projectId"
         AND d."successorId" <> ALL(w."path")
         AND array_length(w."path", 1) < 32
    )
    SELECT array_to_string(w."path", ' -> ') INTO v_path
      FROM walk w
     WHERE w."activityId" = NEW."predecessorId"
     LIMIT 1;

    RAISE EXCEPTION 'schedule: % -> % would create a dependency cycle — % already leads back.',
      NEW."predecessorId", NEW."successorId",
      COALESCE(v_path, format('%s reaches %s by a route longer than this diagnostic prints', NEW."successorId", NEW."predecessorId"));
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ActivityDependency_acyclic" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_acyclic"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_acyclic();


