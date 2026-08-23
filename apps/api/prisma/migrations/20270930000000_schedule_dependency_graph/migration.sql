-- Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH.
--
-- One concern: a finish-to-start edge between two activities of one project, and the guarantee
-- that the set of those edges is always a valid DAG. Durations, the working calendar, baselines,
-- forecast computation and the readiness gate are separate units; this one installs the graph and
-- the rules that keep it honest, so nothing built on top has to re-check them.
--
-- Additive: one new table, no existing table altered.

-- ONE TRANSACTION, and one pinned schema, on every path that can apply this file. `prisma migrate
-- deploy` provides both; `psql -f` provides neither.
--
-- Without the transaction every statement autocommits, and that matters most at the trigger
-- replacements near the end: between a drop and its create the table has no acyclicity guard at
-- all, and a concurrent writer inserting opposing edges in that window leaves both rows behind,
-- unchecked. Without the pinned path, psql takes the caller's — so under a role whose path names a
-- per-user or temporary schema first, every unqualified CREATE below would build the whole graph
-- somewhere else and commit successfully, while the application's `public` schema still has no
-- table, and a re-run would follow the same shadow objects and never notice.
--
-- This is the shape `20270610000000_phase5_t6b_status_derivation` already uses.
BEGIN;
SET LOCAL search_path = public;

-- Sections 3 and 4 unconditionally `DROP ... IF EXISTS` before adding, so a fresh install would
-- otherwise emit a NOTICE per object saying the thing it is about to create does not exist yet.
-- Warnings and errors still surface.
SET LOCAL client_min_messages = warning;

-- ══ WHAT THIS FILE REFUSES ════════════════════════════════════════════════════════════════════
--
-- It refuses DATA it cannot honestly interpret. It does not refuse OBJECTS.
--
-- That distinction is the whole design, because `scripts/migrate.sh` leaves this migration PENDING
-- on the P3005 baseline path — deliberately, so its raw guards EXECUTE rather than being recorded
-- as applied over a `prisma db push`-shaped schema that cannot contain them. On exactly that
-- database the table already exists (Prisma models it) and is not what this file installs (a push
-- produces no CHECK and no trigger). A migration that refused any table it did not create would
-- therefore abort on the one path it was left pending to serve.
--
-- The in-repo pattern is `20270920000000_decision_option_kinds`, already on `main` and in the same
-- ALWAYS_EXECUTE list: diagnostic-first over DATA, idempotent over OBJECTS. So are T45, T2C, T3C.
--
-- "Were these edges ever cycle-checked?" is the wrong question, and it is the one an object
-- refusal is really asking. What matters is not whether the rows WERE checked but whether they
-- PASS, and that is decidable in one query. Verification is not adoption. So:
--
--   * every object is installed unconditionally and idempotently, and recognized by DEFINITION
--     rather than by name (sections 3 and 4 say why a name is not enough);
--   * the ROWS already present are verified against every rule about to be installed — including
--     acyclicity, which no constraint can validate retroactively — and this file aborts naming the
--     offending row or path if any of them fails.
--
-- Zero rows is trivially verified, which is the same reasoning section 6 applies to the TRUNCATE
-- seal: a TRUNCATE that erases nothing erases nothing.
--
-- BUT "verify the data instead of refusing it" is only half a rule, and stating just that half is
-- what let a fabricated withdrawal through. The guard set is not one kind of thing. Most of it is
-- STATE invariants — predicates over a row as it stands, decidable from the row. The rest are
-- TRANSITION invariants — born-live (5), the freeze (7), no-delete and no-truncate (6) — and a
-- transition CANNOT be verified from a single state snapshot, however complete that snapshot is.
-- So the rule this file applies, in full:
--
--   VERIFY every STATE invariant over the rows already present; REJECT any row whose existence
--   would require a FORBIDDEN TRANSITION, because this migration cannot certify what it never
--   observed.
--
-- Section 1b applies the second half and works the class through — including the two transitions
-- that need no code, because being explicit that they need none is part of sweeping a class rather
-- than patching an instance of it.

-- ── 1. Diagnostic-first over the rows already present ─────────────────────────────────────────
-- Every check below is a rule this file is about to install. A CHECK or a foreign key refuses a
-- violating row on its own when it is added, but opaquely — `constraint ... is violated by some
-- row` names neither the row nor the rule in terms an operator can act on. So each is asked
-- first, with a bounded sample.
--
-- 1a verifies the STATE invariants, 1b rejects the rows that would require a forbidden TRANSITION,
-- and 1c walks the graph.
--
-- ACYCLICITY IS THE ONE THAT ONLY THIS BLOCK CAN ASK. The trigger in section 8 fires on INSERT, so
-- it says nothing about rows already present; installing it over a graph that already contains a
-- loop would leave that loop permanently beyond every guard.
DO $$
DECLARE
  v_missing TEXT;
  v_bad     TEXT;
  v_sealed  BOOLEAN;
  v_proj    TEXT;
  v_alive   TEXT[];
  v_next    TEXT[];
  v_node    TEXT;
  v_seen    TEXT[];
  v_path    TEXT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    RETURN;                                  -- fresh install; there are no rows to verify
  END IF;

  -- LOCK BEFORE LOOKING, and hold it through the guard installation below.
  --
  -- Verifying a graph nobody is locked out of proves nothing about the graph that ends up guarded.
  -- Every check in this block reads a snapshot and the guards are installed AFTERWARDS, so on the
  -- `db push`-shaped database this file exists to serve a concurrent session can commit the opposing
  -- edge in exactly that window: the CHECKs and foreign keys added below accept it (each edge is
  -- legal in isolation; only the PAIR is a loop), and the migration commits a cycle with all five
  -- seals sitting on top of it, beyond the reach of every guard forever. Measured before this line
  -- existed: the migration exited 0 over a graph holding `A -> B` and `B -> A`.
  --
  -- ACCESS EXCLUSIVE, not a weaker mode: the writer to shut out is an ordinary INSERT, and only this
  -- mode conflicts with the ROW EXCLUSIVE lock an INSERT takes. PostgreSQL holds it until COMMIT, so
  -- the verification below and the objects installed after it see one another's world and nothing
  -- can slip between them. The cost is bounded — this table holds no rows on any deployed database,
  -- and section 3's ALTER TABLE takes the same lock a few statements later regardless.
  LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE;

  -- THE PHYSICAL COLUMN CONTRACT, not merely the column NAMES.
  --
  -- Section 2's `CREATE TABLE IF NOT EXISTS` skips its whole definition when the table is already
  -- there, so on the adopt path every column's type, nullability and default come from whatever
  -- produced it — and a name test cannot tell a conforming column from a differently-shaped one
  -- of the same name. That is section 3's name-versus-definition lesson applied one level down,
  -- and the consequence is not cosmetic: a NULLABLE `predecessorId` would be adopted silently and
  -- then accept a live edge with a null endpoint, because the composite foreign key is MATCH
  -- SIMPLE (a row with any NULL key column is not checked at all), the self-dependency CHECK
  -- evaluates to UNKNOWN and passes, and the reachability walk in section 8 matches no node. The
  -- table would hold an edge no guard here can see.
  --
  -- So each column is compared against the contract section 2 would have created: nullability,
  -- type, datetime precision and default. The comparison FAILS SAFE, like section 3's — anything
  -- other than an exact match aborts and names the disagreement, so a future PostgreSQL that
  -- renders `CURRENT_TIMESTAMP` differently costs a refusal an operator can read, never a silent
  -- adoption. A `db push`-shaped database, the realistic reason for the table to exist already,
  -- matches exactly, because Prisma builds it from the same model section 2 mirrors.
  SELECT string_agg(w.c || ' (' || w.detail || ')', ', ' ORDER BY w.c) INTO v_missing FROM (
    SELECT e.c AS c,
           CASE WHEN ic.column_name IS NULL THEN 'absent'
                ELSE 'is ' || ic.data_type || COALESCE('(' || ic.datetime_precision || ')', '')
                     || ', nullable=' || ic.is_nullable
                     || ', default=' || COALESCE(ic.column_default, 'none')
                     || '; expected ' || e.typ || COALESCE('(' || e.prec || ')', '')
                     || ', nullable=' || e.nullable
                     || ', default=' || COALESCE(e.def, 'none')
           END AS detail
      FROM (VALUES
              ('id',             'NO',  'text',                        NULL::INT, NULL::TEXT),
              ('projectId',      'NO',  'text',                        NULL,      NULL),
              ('predecessorId',  'NO',  'text',                        NULL,      NULL),
              ('successorId',    'NO',  'text',                        NULL,      NULL),
              ('lagWorkingDays', 'NO',  'integer',                     NULL,      '0'),
              ('createdAt',      'NO',  'timestamp without time zone', 3,         'CURRENT_TIMESTAMP'),
              ('createdById',    'NO',  'text',                        NULL,      NULL),
              ('createdByName',  'NO',  'text',                        NULL,      NULL),
              ('revokedAt',      'YES', 'timestamp without time zone', 3,         NULL),
              ('revokedById',    'YES', 'text',                        NULL,      NULL),
              ('revokedByName',  'YES', 'text',                        NULL,      NULL)
           ) AS e(c, nullable, typ, prec, def)
      LEFT JOIN information_schema.columns ic
             ON ic.table_schema = 'public' AND ic.table_name = 'ActivityDependency'
            AND ic.column_name = e.c
     WHERE ic.column_name IS NULL
        OR ic.is_nullable         IS DISTINCT FROM e.nullable
        OR ic.data_type           IS DISTINCT FROM e.typ
        OR ic.datetime_precision  IS DISTINCT FROM e.prec
        OR ic.column_default      IS DISTINCT FROM e.def) w;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" exists but does not match the column contract this migration installs and reasons about: %. Nothing honest can be said about the rows in it. Repair those columns, or — if it is not the dependency graph — rename or drop that table, then re-run.', v_missing;
  END IF;

  -- The PRIMARY KEY is part of the same contract and is not a column attribute, so it is asked
  -- separately. Without it `id` is not an identity, and every diagnostic below that names a row by
  -- id would be naming a set.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index ix
     WHERE ix.indrelid = 'public."ActivityDependency"'::regclass
       AND ix.indisprimary AND ix.indisvalid AND ix.indnatts = 1
       AND ix.indkey[0] = (SELECT a.attnum FROM pg_attribute a
                            WHERE a.attrelid = 'public."ActivityDependency"'::regclass
                              AND a.attname = 'id')) THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" exists but its PRIMARY KEY is not ("id"), so an edge has no identity and every diagnostic in this migration would name a set rather than a row. Repair the primary key, then re-run.';
  END IF;

  -- ── 1a. STATE invariants over the rows already present ──────────────────────────────────────
  -- Each of these is a predicate over one row as it stands, so a row either satisfies it or does
  -- not, and the answer is decidable from the rows themselves. This is what "verification is not
  -- adoption" buys, and it is why this file installs objects unconditionally rather than refusing
  -- a table it did not create.

  -- Attribution that is present but not answerable. Section 7 freezes whatever is in these
  -- columns, so an unanswerable value is a permanent one.
  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT "id" FROM public."ActivityDependency"
     WHERE "createdById" IS NULL OR "createdByName" IS NULL
        OR "createdById" ~ '^[[:space:]]*$' OR "createdByName" ~ '^[[:space:]]*$'
     ORDER BY "id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % carry no answerable creation attribution, and this migration installs the CHECK that forbids it. Attribute or remove those rows, then re-run.', v_bad;
  END IF;

  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT "id" FROM public."ActivityDependency"
     WHERE NOT (("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokedByName" IS NULL)
                OR ("revokedAt" IS NOT NULL
                    AND "revokedById" IS NOT NULL AND "revokedById" !~ '^[[:space:]]*$'
                    AND "revokedByName" IS NOT NULL AND "revokedByName" !~ '^[[:space:]]*$'))
     ORDER BY "id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % carry a partial or unattributed withdrawal — a revoked edge records when, by whom and under what name, or it is not revoked at all. Complete or clear those rows, then re-run.', v_bad;
  END IF;

  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT "id" FROM public."ActivityDependency" WHERE "predecessorId" = "successorId"
     ORDER BY "id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % make an activity wait for itself, which can never start. Remove those rows, then re-run.', v_bad;
  END IF;

  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT "id" FROM public."ActivityDependency" WHERE "lagWorkingDays" < 0
     ORDER BY "id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % carry a NEGATIVE lag, which would let a successor begin before its predecessor finished. Correct those rows, then re-run.', v_bad;
  END IF;

  -- Two LIVE edges for one ordered pair. The partial unique index in section 4 would refuse this
  -- with `could not create unique index`, which names the index and not the pair.
  SELECT string_agg(q.pair, ', ' ORDER BY q.pair) INTO v_bad FROM (
    SELECT "projectId" || ':' || "predecessorId" || '->' || "successorId" AS pair
      FROM public."ActivityDependency" WHERE "revokedAt" IS NULL
     GROUP BY "projectId", "predecessorId", "successorId" HAVING COUNT(*) > 1
     ORDER BY 1 LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: ordered pair(s) % carry more than one LIVE edge, and one live edge per pair is what this graph means. Revoke the duplicates, then re-run.', v_bad;
  END IF;

  -- Containment and project-scoped attribution: the composite foreign keys in section 3 make each
  -- of these unrepresentable, but only for rows written afterwards.
  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT d."id" FROM public."ActivityDependency" d
     WHERE NOT EXISTS (SELECT 1 FROM public."Activity" a
                        WHERE a."projectId" = d."projectId" AND a."id" = d."predecessorId")
        OR NOT EXISTS (SELECT 1 FROM public."Activity" a
                        WHERE a."projectId" = d."projectId" AND a."id" = d."successorId")
     ORDER BY d."id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % name an endpoint that is not an activity of the edge''s own project — a cross-project edge, which this migration makes unrepresentable. Remove those rows, then re-run.', v_bad;
  END IF;

  SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
    SELECT d."id" FROM public."ActivityDependency" d
     WHERE NOT EXISTS (SELECT 1 FROM public."Membership" m
                        WHERE m."projectId" = d."projectId" AND m."userId" = d."createdById")
        OR (d."revokedById" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public."Membership" m
                             WHERE m."projectId" = d."projectId" AND m."userId" = d."revokedById"))
     ORDER BY d."id" LIMIT 10) q;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: dependency edge(s) % are attributed to someone who is not a member of the edge''s own project — cross-tenant attribution, written into a record this migration then freezes. Correct those rows, then re-run.', v_bad;
  END IF;

  -- ── 1b. TRANSITION invariants: reject a row that would require a forbidden one ──────────────
  --
  -- The rule is stated in full at the top of this file. Worked through all four transitions here,
  -- INCLUDING the two that need no code — saying so is part of sweeping the class rather than
  -- patching an instance of it, and leaves no reader wondering whether they were considered.
  --
  --   born-live (5)   — ACTION REQUIRED, below. A row that is ALREADY WITHDRAWN is exactly such a
  --                     row. Born-live says a withdrawal records a constraint that once STOOD, and
  --                     nothing in a snapshot shows that this one ever did. Its revocation tuple is
  --                     complete, so 1a waves it through — COMPLETENESS IS NOT PROVENANCE, and that
  --                     is the defect. Section 5 lists what follows from letting one in: permanent,
  --                     never judged, unlimited per ordered pair.
  --   freeze (7)      — NO ACTION, and that is a decision rather than an omission. A row edited
  --                     before the trigger existed is indistinguishable from one never edited, AND
  --                     whatever it now says already satisfies every state invariant in 1a. So there
  --                     is no observable residue and no harmful one: what would be preserved is a
  --                     coherent edge, not a claim about an event that never happened.
  --   no-delete (6)   — NO ACTION. A row destroyed before the seal existed is GONE and leaves
  --                     nothing in the remaining state to reject. Refusing a table because
  --                     something may once have been removed from it would refuse every database.
  --   no-truncate (6) — NO ACTION, for the same reason at statement scale.
  --
  -- WHEN a pre-existing withdrawal IS admissible. Refusing every one outright would make the abort
  -- in 1c UNREPAIRABLE: that diagnostic tells the operator to revoke an edge on the loop, and on a
  -- database where this file has already run the rows are not deletable either (section 6). The
  -- exemption is not a softening of the rule — without it the repair path does not exist.
  --
  -- The exemption is the only evidence a database can offer about a transition: PostgreSQL itself
  -- was ARMED to enforce it. Both seals must be present ON THIS TABLE, ENABLED for ordinary origin
  -- sessions, bound to the functions this file binds them to, and firing on exactly the events it
  -- binds them to — `tgtype` 7 is BEFORE INSERT FOR EACH ROW, 19 is BEFORE UPDATE FOR EACH ROW.
  --
  -- Stated rather than implied, because a reader is owed the limit: this establishes that the
  -- transition was ENFORCEABLE, not that it was enforced for any particular row. A role that can
  -- disable a named trigger, or rebind that name to another function, defeats it — the same
  -- boundary section 6 already states for the TRUNCATE seal, and the general limit on certifying
  -- history from a snapshot. What it DOES exclude is the case that actually arises and that the
  -- ALWAYS_EXECUTE entry exists to serve: a `prisma db push`-shaped table, which carries every
  -- column and NO trigger, where an alternate writer can insert a complete withdrawal that 1a
  -- alone accepts.
  --
  -- `COUNT(*) = 2` is never UNKNOWN, so this cannot be waved through by three-valued logic — the
  -- recurring trap in this file.
  SELECT COUNT(*) = 2 INTO v_sealed FROM (VALUES
      ('ActivityDependency_born_live', 'activity_dependency_born_live',  7),
      ('ActivityDependency_frozen',    'activity_dependency_frozen',    19)) AS e(name, fn, tt)
   WHERE EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgname = e.name
                    AND g.tgrelid = 'public."ActivityDependency"'::regclass
                    AND NOT g.tgisinternal AND g.tgenabled IN ('O', 'A')
                    AND g.tgfoid::regproc::text = e.fn AND g.tgtype = e.tt);

  IF NOT v_sealed THEN
    -- ANY revocation column set, not just a complete tuple: a partial withdrawal is also a row
    -- whose existence requires the forbidden transition, so on an unsealed table this predicate is
    -- strictly stronger than 1a's tuple check and subsumes it. (That check stays necessary for the
    -- SEALED case, which this arm does not examine.)
    SELECT string_agg(q.id, ', ' ORDER BY q.id) INTO v_bad FROM (
      SELECT "id" FROM public."ActivityDependency"
       WHERE "revokedAt" IS NOT NULL OR "revokedById" IS NOT NULL OR "revokedByName" IS NOT NULL
       ORDER BY "id" LIMIT 10) q;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'schedule B1: dependency edge(s) % are already WITHDRAWN on a table that does not have BOTH the born-live and the freeze seals in force, so nothing here can show the edge ever STOOD — and this migration would freeze that withdrawal permanently. Decide from the site record whether each edge holds: clear all three revocation columns to keep it as a live edge, or remove the row. Then re-run.', v_bad;
    END IF;
  END IF;

  -- ── 1c. ACYCLICITY, by Kahn's peel, per project ─────────────────────────────────────────────
  -- Repeatedly discard every node with no LIVE incoming edge from a node still standing. A DAG
  -- empties completely; whatever survives has in-degree at least one within itself and is therefore
  -- on or downstream of a loop. This needs no starting vertex, which is exactly why the
  -- reachability walk in section 8 cannot answer this question.
  FOR v_proj IN SELECT DISTINCT "projectId" FROM public."ActivityDependency"
                 WHERE "revokedAt" IS NULL ORDER BY 1 LOOP
    SELECT COALESCE(array_agg(DISTINCT n), ARRAY[]::TEXT[]) INTO v_alive FROM (
      SELECT "predecessorId" AS n FROM public."ActivityDependency"
       WHERE "projectId" = v_proj AND "revokedAt" IS NULL
      UNION
      SELECT "successorId" FROM public."ActivityDependency"
       WHERE "projectId" = v_proj AND "revokedAt" IS NULL) x;

    LOOP
      SELECT COALESCE(array_agg(DISTINCT d."successorId"), ARRAY[]::TEXT[]) INTO v_next
        FROM public."ActivityDependency" d
       WHERE d."projectId" = v_proj AND d."revokedAt" IS NULL
         AND d."predecessorId" = ANY(v_alive) AND d."successorId" = ANY(v_alive);
      EXIT WHEN COALESCE(array_length(v_next, 1), 0)
              = COALESCE(array_length(v_alive, 1), 0);
      v_alive := v_next;
    END LOOP;

    IF COALESCE(array_length(v_alive, 1), 0) > 0 THEN
      -- Name one loop. Every survivor has a live predecessor among the survivors, so walking
      -- BACKWARD from any of them must revisit a node, and the revisited node opens the cycle.
      v_node := v_alive[1];
      v_seen := ARRAY[]::TEXT[];
      WHILE NOT (v_node = ANY(v_seen)) LOOP
        v_seen := v_seen || v_node;
        SELECT d."predecessorId" INTO v_node FROM public."ActivityDependency" d
         WHERE d."projectId" = v_proj AND d."revokedAt" IS NULL
           AND d."successorId" = v_node AND d."predecessorId" = ANY(v_alive)
         ORDER BY d."predecessorId" LIMIT 1;
        EXIT WHEN v_node IS NULL;
      END LOOP;
      v_path := CASE WHEN v_node IS NULL THEN array_to_string(v_seen, ' <- ')
                     ELSE v_node || ' -> '
                          || array_to_string(ARRAY(SELECT s FROM unnest(v_seen) WITH ORDINALITY AS u(s, o)
                                                    ORDER BY u.o DESC), ' -> ') END;
      RAISE EXCEPTION 'schedule B1: project % already holds a dependency CYCLE (%), and no constraint can judge a row after the fact — the acyclicity guard this migration installs fires on INSERT. Revoke an edge on that loop, then re-run.', v_proj, v_path;
    END IF;
  END LOOP;
END $$;

-- ── 2. The table ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ActivityDependency" (
  "id"             TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "predecessorId"  TEXT NOT NULL,
  "successorId"    TEXT NOT NULL,
  "lagWorkingDays" INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"    TEXT NOT NULL,
  "createdByName"  TEXT NOT NULL,
  -- Removal is a REVOCATION, not a delete. See the DELETE seal in section 6 for why.
  "revokedAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "revokedByName"  TEXT,
  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id")
  -- No CHECK is written inline. `CREATE TABLE IF NOT EXISTS` is skipped WHOLESALE when the table
  -- already exists, and `schema.prisma` describes this table — so a baseline or `db push`-shaped
  -- reconciliation produces the table, its columns and its foreign keys but never a CHECK. Written
  -- inline, those constraints would be silently absent on exactly the databases that most need
  -- them, and this file would report success. Section 3 installs them separately.
);

-- ── 3. Constraints, recognized by DEFINITION and never by name ────────────────────────────────
-- A guarded `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)` is not enough here.
-- A constraint of the right NAME whose definition is something else — a hollow `CHECK (TRUE)`, a
-- foreign key pointing at `User` instead of `Membership`, a `NOT VALID` constraint that judges
-- nothing already in the table — reads as present to a name test, so the ALTER is skipped and this
-- file reports success while the rule it claims to have installed is absent. The rows verified in
-- section 1 would then be guarded by nothing.
--
-- So each constraint is compared against its CANONICAL DEFINITION as PostgreSQL itself deparses it
-- (`pg_get_constraintdef`), whitespace-normalized. This is the discipline the cleared T3C seals
-- apply to trigger functions, where they compare `pg_proc.prosrc` rather than the bound function's
-- name for exactly this reason.
--
-- The comparison FAILS SAFE. A match keeps what is there; anything else — absent, different,
-- `NOT VALID`, or merely deparsed differently by some future PostgreSQL — drops it and adds the
-- canonical one. A false negative costs a needless recreate over an empty table; a false positive
-- is impossible, because only an exact canonical match skips. Dropping is safe precisely because
-- section 1 ran first: every row present already satisfies the constraint about to be added.
--
-- THE RESULTING INVARIANT: after this section, a constraint of one of these names EXISTS AND HAS
-- THE DEFINITION PRINTED HERE. Name-presence implies definition-correctness on this table, so a
-- later reader — or a later migration using the repository's ordinary `IF NOT EXISTS (... conname
-- ...)` guard against it — may rely on the name as evidence of the rule.
DO $$
DECLARE
  r          RECORD;
  v_existing TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_attribution_check',
       'CHECK ("createdById" !~ ''^[[:space:]]*$'' AND "createdByName" !~ ''^[[:space:]]*$'')',
       'CHECK ((("createdById" !~ ''^[[:space:]]*$''::text) AND ("createdByName" !~ ''^[[:space:]]*$''::text)))'),
      -- The revocation tuple moves together, or not at all. `revokedByName IS NOT NULL` is stated
      -- EXPLICITLY and is not redundant with the regex beside it: a CHECK PASSES when its
      -- expression is UNKNOWN, and `NULL !~ '...'` is UNKNOWN — so without that clause the revoked
      -- arm accepts a withdrawal carrying a stamp and an id but NO NAME, which is the erasure the
      -- DELETE seal exists to prevent arriving through another door. Three-valued logic is this
      -- file's recurring trap; every test that can meet a NULL is written two-valued in full.
      --
      -- BOTH revocation identity columns are checked for blankness, not just the name. The
      -- foreign key proves the id names a membership; it does not prove the id is legible, and a
      -- writer able to create a whitespace-id user and membership could revoke through it. That
      -- attribution is then permanent (section 7), which is exactly the asymmetry the creation
      -- arm above already refuses on `createdById`. A withdrawal answers "who", or it is not a
      -- withdrawal.
      ('ActivityDependency_revocation_check',
       'CHECK (("revokedAt" IS NULL AND "revokedById" IS NULL AND "revokedByName" IS NULL) OR ("revokedAt" IS NOT NULL AND "revokedById" IS NOT NULL AND "revokedById" !~ ''^[[:space:]]*$'' AND "revokedByName" IS NOT NULL AND "revokedByName" !~ ''^[[:space:]]*$''))',
       'CHECK (((("revokedAt" IS NULL) AND ("revokedById" IS NULL) AND ("revokedByName" IS NULL)) OR (("revokedAt" IS NOT NULL) AND ("revokedById" IS NOT NULL) AND ("revokedById" !~ ''^[[:space:]]*$''::text) AND ("revokedByName" IS NOT NULL) AND ("revokedByName" !~ ''^[[:space:]]*$''::text))))'),
      -- An activity waiting for itself can never start. Cheap to state, so state it.
      ('ActivityDependency_no_self_check',
       'CHECK ("predecessorId" <> "successorId")',
       'CHECK (("predecessorId" <> "successorId"))'),
      -- A NEGATIVE lag would let a successor begin before its predecessor finished, which is the
      -- one thing this table exists to forbid. Zero is legal and is the common case.
      ('ActivityDependency_lag_nonneg_check',
       'CHECK ("lagWorkingDays" >= 0)',
       'CHECK (("lagWorkingDays" >= 0))'),
      -- Containment: each endpoint key carries the edge's OWN `projectId`, so an edge between two
      -- projects is not a representable row. That is the difference between an invariant and a
      -- convention — no service, import, script or hand-written UPDATE can produce one.
      ('ActivityDependency_projectId_fkey',
       'FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
       'FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON UPDATE CASCADE ON DELETE RESTRICT'),
      ('ActivityDependency_projectId_predecessorId_fkey',
       'FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
       'FOREIGN KEY ("projectId", "predecessorId") REFERENCES "Activity"("projectId", id)'),
      ('ActivityDependency_projectId_successorId_fkey',
       'FOREIGN KEY ("projectId", "successorId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION',
       'FOREIGN KEY ("projectId", "successorId") REFERENCES "Activity"("projectId", id)'),
      -- Attribution is bound to a MEMBER OF THIS PROJECT. A global `User` reference proves the id
      -- names somebody, not that the somebody had anything to do with this site — so without the
      -- project half an edge on project A can be attributed, permanently (section 7 freezes it),
      -- to a user who is only ever a member of project B. `Membership(projectId, userId)` is the
      -- identity every other project-scoped evidence column in this repository binds to
      -- (`ActivityRequirement.responsibleId`, `Inspection.assigneeId`, `DrawingRecipient.userId`,
      -- `Activity.completionRequestedById`, `Decision.withdrawnById`).
      --
      -- The revoker key is MATCH SIMPLE over a nullable column, so a live edge — which has no
      -- revoker — switches the reference off rather than failing it. The revocation CHECK decides
      -- whether those columns may be null at all; this key decides who the revoker may be.
      ('ActivityDependency_createdBy_fkey',
       'FOREIGN KEY ("projectId", "createdById") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION',
       'FOREIGN KEY ("projectId", "createdById") REFERENCES "Membership"("projectId", "userId")'),
      ('ActivityDependency_revokedBy_fkey',
       'FOREIGN KEY ("projectId", "revokedById") REFERENCES "Membership"("projectId", "userId") ON DELETE NO ACTION ON UPDATE NO ACTION',
       'FOREIGN KEY ("projectId", "revokedById") REFERENCES "Membership"("projectId", "userId")')
    ) AS c(name, ddl, canonical)
  LOOP
    SELECT regexp_replace(pg_get_constraintdef(k.oid), '[[:space:]]+', ' ', 'g')
      INTO v_existing
      FROM pg_constraint k
     WHERE k.conname = r.name
       AND k.conrelid = 'public."ActivityDependency"'::regclass
       AND k.convalidated;

    CONTINUE WHEN v_existing IS NOT NULL
             AND v_existing = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g');

    EXECUTE format('ALTER TABLE "ActivityDependency" DROP CONSTRAINT IF EXISTS %I', r.name);
    EXECUTE format('ALTER TABLE "ActivityDependency" ADD CONSTRAINT %I %s', r.name, r.ddl);
  END LOOP;
END $$;

-- ── 4. Indexes, recognized by DEFINITION and never by name ────────────────────────────────────
-- Section 3's reasoning, applied to indexes: `CREATE UNIQUE INDEX IF NOT EXISTS` skips on the NAME
-- alone, and a plain non-unique index called `..._key`, a unique index WITHOUT the partial
-- predicate, or one left `indisvalid = false` by a failed concurrent build each satisfies that
-- guard — leaving the ordered pair unconstrained forever. `pg_get_indexdef` renders UNIQUE, the
-- columns and the WHERE predicate, so comparing it covers the first three; `indisvalid` is not in
-- that text and is asked separately. Same fail-safe, same resulting invariant.
--
-- The unique index is PARTIAL because a revoked edge stays on the record: re-imposing a constraint
-- withdrawn earlier is an ordinary re-plan, and what must not be allowed is two LIVE edges for one
-- ordered pair. It is also the candidate key an EDGE-SCOPED dependency override must reference —
-- an override attached to the successor alone would excuse every predecessor at once.
DO $$
DECLARE
  r          RECORD;
  v_existing TEXT;
  v_owner    TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_projectId_successorId_predecessorId_key',
       'CREATE UNIQUE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON "ActivityDependency"("projectId", "successorId", "predecessorId") WHERE "revokedAt" IS NULL',
       'CREATE UNIQUE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON public."ActivityDependency" USING btree ("projectId", "successorId", "predecessorId") WHERE ("revokedAt" IS NULL)'),
      ('ActivityDependency_projectId_predecessorId_idx',
       'CREATE INDEX "ActivityDependency_projectId_predecessorId_idx" ON "ActivityDependency"("projectId", "predecessorId")',
       'CREATE INDEX "ActivityDependency_projectId_predecessorId_idx" ON public."ActivityDependency" USING btree ("projectId", "predecessorId")'),
      ('ActivityDependency_projectId_successorId_idx',
       'CREATE INDEX "ActivityDependency_projectId_successorId_idx" ON "ActivityDependency"("projectId", "successorId")',
       'CREATE INDEX "ActivityDependency_projectId_successorId_idx" ON public."ActivityDependency" USING btree ("projectId", "successorId")')
    ) AS i(name, ddl, canonical)
  LOOP
    SELECT regexp_replace(pg_get_indexdef(ci.oid), '[[:space:]]+', ' ', 'g')
      INTO v_existing
      FROM pg_class ci
      JOIN pg_index ix ON ix.indexrelid = ci.oid
      JOIN pg_namespace ns ON ns.oid = ci.relnamespace
     WHERE ci.relname = r.name
       AND ns.nspname = 'public'
       AND ix.indrelid = 'public."ActivityDependency"'::regclass
       AND ix.indisvalid;

    CONTINUE WHEN v_existing IS NOT NULL
             AND v_existing = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g');

    -- AN INDEX NAME IS UNIQUE PER SCHEMA, NOT PER TABLE, and the lookup above filters on
    -- `indrelid` — so finding no matching definition does NOT mean the name is free. Unscoped,
    -- the DROP below would then destroy an index of that name belonging to ANOTHER table: a
    -- performance guard, or a standalone uniqueness rule, silently gone on any database where the
    -- name collides. That is a strictly worse failure than the one this section exists to repair,
    -- and it would happen on a retry or a reconciled database rather than on some exotic path.
    --
    -- This file may repair what belongs to "ActivityDependency". It must not RECLAIM what does
    -- not, so a collision is data it cannot honestly interpret and it aborts naming both sides.
    -- (Section 3 needs no counterpart: a constraint name is unique per TABLE and its DROP is
    -- already scoped by `ALTER TABLE`.)
    SELECT c2.relname INTO v_owner
      FROM pg_class ci
      JOIN pg_namespace ns ON ns.oid = ci.relnamespace
      JOIN pg_index ix ON ix.indexrelid = ci.oid
      JOIN pg_class c2 ON c2.oid = ix.indrelid
     WHERE ci.relname = r.name AND ns.nspname = 'public'
       AND ix.indrelid <> 'public."ActivityDependency"'::regclass;
    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION 'schedule B1: an index named "%" already exists in schema public on table "%", not on "ActivityDependency". This migration repairs its own objects and will not reclaim one it does not own — rename or drop that index deliberately, then re-run.', r.name, v_owner;
    END IF;

    -- A UNIQUE CONSTRAINT of the same name owns its index, and `DROP INDEX` on it fails with
    -- "cannot drop index ... because constraint requires it" — an opaque abort in the middle of a
    -- migration that is otherwise able to repair itself. A constraint cannot express the partial
    -- predicate, so one of this name is by definition not what belongs here; drop it first.
    EXECUTE format('ALTER TABLE "ActivityDependency" DROP CONSTRAINT IF EXISTS %I', r.name);
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.name);
    EXECUTE r.ddl;
  END LOOP;
END $$;

-- ── 5. An edge is BORN LIVE ───────────────────────────────────────────────────────────────────
-- The revocation CHECK says the three revocation columns move together. It cannot say WHEN they
-- may first be set, because a CHECK sees one row and cannot tell an INSERT from an UPDATE — so its
-- revoked arm is satisfied by a row that arrives ALREADY REVOKED. Such a row is not a withdrawal;
-- it records a withdrawal that never happened, and every other guard here then works in its
-- favour: section 7 refuses to touch an already-revoked row, so the fabrication is permanent;
-- section 8's walk reads LIVE edges only, so it passes trivially; and the partial unique index
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

DROP TRIGGER IF EXISTS "ActivityDependency_born_live" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_born_live"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_born_live();

-- ── 6. Removal must not launder attribution ───────────────────────────────────────────────────
-- Section 7 makes the record permanent against UPDATE. It has nothing to hold on to against
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

DROP TRIGGER IF EXISTS "ActivityDependency_no_delete" ON "ActivityDependency";
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

DROP TRIGGER IF EXISTS "ActivityDependency_no_truncate" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_no_truncate"
  BEFORE TRUNCATE ON "ActivityDependency"
  FOR EACH STATEMENT EXECUTE FUNCTION activity_dependency_no_truncate();

-- ── 7. The row is frozen; the ONE permitted transition is live → revoked ──────────────────────
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

DROP TRIGGER IF EXISTS "ActivityDependency_frozen" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_frozen"
  BEFORE UPDATE ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_frozen();

-- ── 8. No cycles, and no cycles UNDER CONCURRENCY ─────────────────────────────────────────────
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

DROP TRIGGER IF EXISTS "ActivityDependency_acyclic" ON "ActivityDependency";
CREATE TRIGGER "ActivityDependency_acyclic"
  BEFORE INSERT ON "ActivityDependency"
  FOR EACH ROW EXECUTE FUNCTION activity_dependency_acyclic();

COMMIT;
