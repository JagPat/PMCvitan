-- Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH.
--
-- One concern: a finish-to-start edge between two activities of one project, and the guarantee
-- that the set of those edges is always a valid DAG. Durations, the working calendar, baselines,
-- forecast computation and the readiness gate are separate units; this one installs the graph and
-- the rules that keep it honest, so nothing built on top has to re-check them.
--
-- Additive: one new table, no existing table altered.

-- ══ THIS MIGRATION COMPLETES ITS OWN INSTALL. IT ADOPTS NOTHING ELSE. ═════════════════════════
--
-- One rule, applied to every object below — the table, each column, each CHECK, the primary key,
-- each composite foreign key, each index, each function, each trigger:
--
--     absent                                        -> create it;
--     present AND identical to what this file installs -> leave it, this is the resumed apply;
--     present AND different                         -> ABORT, naming the object and BOTH
--                                                      definitions.
--
-- And for ROWS: a partially-applied FRESH install cannot hold any. Nothing can write this table
-- between the `CREATE TABLE` that makes it and the seals a few statements later, because that
-- CREATE takes ACCESS EXCLUSIVE and holds it to COMMIT. So a table holding even one row is not
-- this file's unfinished work, and section 1 aborts rather than adopting it.
--
-- WHY THIS SHAPE, rather than the unconditional refusal this file carried before. `AGENTS.md`
-- requires a new migration to tolerate PARTIAL APPLICATION and to be safe to re-run. Refusing an
-- existing table satisfies neither: a caller that does not wrap the file in a transaction, having
-- failed anywhere after `CREATE TABLE`, leaves the table behind — and every retry from then on
-- stops at the refusal, including a complete and otherwise correct re-run, with a destructive
-- `DROP TABLE` as the only way forward. Completing the install is the retry-safe answer, and
-- comparing by DEFINITION is what keeps it from being adoption.
--
-- COMPARE BY DEFINITION, NEVER BY NAME. A name test cannot tell a rule from its impersonation: a
-- hollow `CHECK (TRUE)`, a foreign key pointing at `User` instead of `Membership`, a `NOT VALID`
-- constraint that judges nothing already present, a non-unique index called `..._key`, a unique
-- index missing its partial predicate, an `indisvalid = false` leftover, a disabled trigger, or a
-- same-named function whose body has been hollowed out — each reads as PRESENT to a name test, so
-- the guarded create is skipped and this file reports success over a rule that is not there. The
-- function case is the one that closed PR #409 specifically: `CREATE OR REPLACE FUNCTION`
-- preserves the function's identity, so a hollowed body of the right name survives every check
-- short of reading `prosrc`. So constraints are compared through `pg_get_constraintdef` plus
-- `convalidated`, indexes through `pg_get_indexdef` plus `indisunique`/`indisvalid`, triggers
-- through `pg_get_triggerdef` plus `tgenabled`, and functions through their BODY.
--
-- SCOPE EVERY CHECK TO THIS TABLE. Index names are schema-scoped in PostgreSQL, not table-scoped,
-- so a same-named index on ANOTHER relation both hides itself from a table-scoped lookup and
-- silences `CREATE INDEX IF NOT EXISTS`. Section 1a asks that question first and ABORTS; it never
-- drops or reclaims an object owned elsewhere.
--
-- WHAT THIS STILL REFUSES, and it is the case the runbook's `DROP TABLE` now exists for: a table
-- this file did not install. The realistic one is a `prisma db push` or baseline reconciliation
-- shape — `schema.prisma` can express neither a CHECK nor a trigger, so it produces the columns,
-- the primary key, the modelled foreign keys and the two modelled indexes, and NONE of the four
-- CHECKs, the two `Membership` keys, the partial unique index or the five seals. Section 2 creates
-- every CHECK and key INLINE with the table, atomically, so on this file's own partial apply they
-- are all present; a table missing any of them was made by something else, and section 1 says so
-- and stops. That is the last resort, not the routine answer: `docs/RUNBOOK.md` section B1 leads
-- with re-running the deploy and reaches for the DROP only when the migration names a
-- disagreement it cannot honestly resolve.
--
-- DEFERRED, and named rather than silently dropped: real ADOPTION of a `db push`-shaped table —
-- reconciling its column contract, installing the constraints it never had, and deciding what may
-- honestly be said about rows written before any guard existed — is a SEPARATE future unit, to be
-- built if and when a database that needs it exists. None does today: `ActivityDependency` exists
-- in no released schema and no service writes it.

-- THE TRANSACTION, AND WHY THIS FILE STILL CARRIES NO `BEGIN;`/`COMMIT;` OF ITS OWN.
--
-- Both facts hold at once, and they are independent:
--
--   * IDEMPOTENCE comes from the guards above and below — every object is created only if absent,
--     and only after being compared by definition when present. That is what makes a retry work
--     for a caller that supplies NO transaction, which is the caller `AGENTS.md` requires this
--     file to tolerate and the one the unconditional refusal failed.
--   * ATOMICITY comes from the CALLER, and both real callers supply it: `prisma migrate deploy`
--     runs each migration in one transaction (MEASURED, not assumed: a two-statement variant of
--     this file whose SECOND statement raised left the table its FIRST statement created absent
--     afterwards), and every psql caller passes `--single-transaction` — the probe suite's
--     `applyMigration`, and anyone applying this file by hand.
--
-- Idempotence is what the finding asked for; atomicity is a bonus the ordinary path gets. Neither
-- is bought at the other's expense.
--
-- AN EXPLICIT `BEGIN;` HERE WOULD BE ACTIVELY HARMFUL, since the obvious instinct is to write one.
-- The schema engine sends this script to a connection that is ALREADY in a transaction and sends
-- its statements one at a time. An explicit `BEGIN` is then a no-op warning; section 1's RAISE
-- aborts the transaction, and every remaining statement fails with `current transaction is
-- aborted` — so the error the engine reports is the LAST one, and the named diagnostic an operator
-- needs is discarded. Measured: with `BEGIN;`/`COMMIT;` present, `migrate deploy` printed
-- `ERROR: current transaction is aborted, commands ignored until end of transaction block`;
-- without them it printed the section 1 message verbatim, RUNBOOK pointer and all. That
-- measurement stands, `scripts/schedule-b1-baseline-proof.sh` asserts the message through the real
-- production runner, and probe P22 pins the absence — so re-introducing the explicit transaction
-- fails a required CI job rather than quietly costing the next operator their diagnostic.
--
-- ══ WHY THERE IS NO CATALOG-ATTRIBUTE ENUMERATION HERE ANY MORE ══════════════════════════════
--
-- Every finding this unit has taken against the resume path has had one shape: "you compare N
-- attributes of this object; attribute N+1 also changes behaviour." By NAME, then by DEFINITION,
-- then by function BODY, then by the COLUMN CONTRACT, then by relation PERSISTENCE and function
-- VOLATILITY, then by ENFORCEMENT STATE — and then, in the round that produced this file, BY NAME
-- AGAIN, in a second place: the deploy-time verifier added to close the previous round's finding
-- checked CHECK constraints by `conname` and `convalidated` only, which is the exact defect this
-- migration had already fixed two rounds earlier.
--
-- Roughly 1,150 lines stood here arguing which `pg_catalog` columns were CHECKED, which were
-- COVERED BY something already compared, and which were EXCLUDED and why. That argument was
-- careful and it was still the wrong shape, because EVERY CHECK IN IT WAS A LIST, and a list is
-- always potentially shorter than the set of things that can go wrong. Extending it once more
-- buys the next round, not the last one.
--
-- So this file no longer chooses attributes. Section 9 reads EVERY object of every kind attached
-- to this table out of the catalog and compares the FULL ACTUAL SET against the FULL EXPECTED SET,
-- refusing on a difference in either direction — missing, unexpected, or same-name-different-
-- definition. There is no list to be short, and nothing to enumerate in prose, because nothing is
-- being excluded. The two places where a set equality is genuinely not possible — the install
-- barrier, whose expected state differs between the two callers, and the function bodies, which
-- are compared against the single `$body$` literals rather than a second copy — are named at the
-- inventory itself, with their reasons.
--
-- Section 1 no longer carries a second copy of that comparison either. It used to enumerate the
-- columns, the ten constraints, the five foreign-key targets, the twenty internal enforcement
-- triggers, the three indexes, the five functions and the five triggers, so a foreign table was
-- refused before section 2 ran. Two hand-written lists that must agree eventually will not — and
-- that is precisely how the by-name defect survived in one of them. Section 1 now decides only
-- what must be decided BEFORE the table is read (its relation kind) and the row verdict it has
-- always deferred; the comparison happens once, in section 9, and the write barrier is lifted only
-- after it passes.
--
-- The operator-facing half of the removed text — what each seal is for, what a refusal means and
-- what to do about it — is in `docs/RUNBOOK.md` section B1, which is where an operator reading a
-- diagnostic at 3am can actually find it.
--
-- AND THE VERIFIER IS HELD TO THE SAME STANDARD IT APPLIES. Extraction refuses a file with no
-- marker pair, with more than one, or whose inventory no longer carries the single plpgsql
-- assignment it strips — because a verifier that quietly asks nothing reports every database as
-- sealed, which is the worst answer available. "Table absent" is its own exit code and never a
-- success: on a deploy path the table must exist, so its absence means the deploy did not do what
-- the ledger claims.

-- THE SCHEMA PIN, AND WHY `SET LOCAL` COULD NOT BE IT.
--
-- Under a role whose search path names a per-user, temporary or decoy schema first, an unqualified
-- CREATE would build the whole graph somewhere else and commit successfully, while the
-- application's `public` schema still has no table — and section 1, which qualifies its lookups,
-- would keep reporting a fresh install forever. So EVERY object this file creates is written
-- `public.`-qualified, which makes the outcome independent of the caller's path.
--
-- `SET LOCAL search_path = public` USED TO STAND HERE AND WAS INERT, which is how the foreign-key
-- targets came to bind to a decoy: LOCAL is only a WARNING outside a transaction block, so for the
-- autocommit caller this file is required to tolerate it did nothing whatsoever, and every name
-- this file did not qualify resolved through the caller's path. Measured: with a caller path of
-- `b1decoy,public` and same-named decoy tables in it, the file exited 0 with all five foreign keys
-- pointing into `b1decoy` — no project, endpoint or membership containment at all.
--
-- A plain `SET` is not local, so it works for BOTH callers, and the caller's value is saved into a
-- custom GUC first and restored after section 9 so nothing leaks into the connection the deploy
-- goes on to use. Inside a transaction the SET is rolled back with the migration if it aborts; in
-- autocommit an aborted run leaves the path changed on a connection that is about to be discarded.
--
-- `pg_catalog` ALONE, deliberately, and it is doing two jobs. It makes every unqualified name in
-- this file an error rather than a silent capture — nothing here is unqualified, and if a later
-- edit adds something, it fails closed. And it makes every `pg_get_constraintdef`,
-- `pg_get_indexdef` and `pg_get_triggerdef` in this file render FULLY QUALIFIED, so the canonical
-- strings compared by section 8 and by section 9's inventory name `public."Project"` outright and a decoy binding
-- is textually different rather than textually identical. Sections 1, 8 and 9 additionally pin the
-- path inside their own blocks, so each is correct on its own terms even if this line is lost.
SELECT set_config('vitan.schedule_b1_caller_search_path',
                  current_setting('search_path'), false);
SET search_path = pg_catalog;

-- ── 1. Resume this file's own install; refuse anything it did not install ─────────────────────
DO $$
DECLARE
  v_bad   TEXT;
  v_rows  BIGINT;
  v_path  TEXT;
BEGIN
  v_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog', true);

  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    PERFORM set_config('search_path', v_path, true);
    RETURN;                        -- nothing installed yet; sections 2..8 install all of it
  END IF;

  -- THE RELATION KIND, asked HERE and not left to section 9, because everything below this line
  -- reads or locks the relation and those operations are only meaningful on an ordinary permanent
  -- table. Section 9's `relation` row asks the same question again on the finished install; this
  -- is the pre-flight that makes the read safe, not a second opinion about the answer.
  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO v_bad FROM (
    SELECT 'relkind is ' || c.relkind::TEXT || ', expected r (an ordinary table)' AS what
      FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"') AND c.relkind <> 'r'
    UNION ALL
    SELECT 'relpersistence is ' || c.relpersistence::TEXT
           || CASE c.relpersistence WHEN 'u' THEN ' (UNLOGGED — PostgreSQL truncates it after a crash)'
                                    WHEN 't' THEN ' (TEMPORARY — invisible to every other session)'
                                    ELSE '' END || ', expected p (permanent)'
      FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"') AND c.relpersistence <> 'p'
    UNION ALL
    SELECT CASE WHEN c.relispartition THEN 'the relation is a PARTITION of another table'
                ELSE 'the relation INHERITS from another table' END
      FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"')
       AND EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = c.oid)
    UNION ALL
    SELECT 'the relation has INHERITANCE CHILDREN, whose rows this file would read and whose writes bypass its triggers'
      FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"')
       AND EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhparent = c.oid)
    UNION ALL
    SELECT 'ROW LEVEL SECURITY is enabled, so a policy can hide rows from the seals themselves'
      FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"')
       AND (c.relrowsecurity OR c.relforcerowsecurity)) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" exists but is not the kind of relation this migration installs and reasons about: %. Every rule below is a rule about an ORDINARY, PERMANENT, un-inherited table with no row-level security; on anything else the checks would pass and enforce nothing. This is not this migration''s partial apply and will not be adopted. Repair whichever applies — ALTER TABLE public."ActivityDependency" SET LOGGED / NO INHERIT <parent> / DISABLE ROW LEVEL SECURITY — or, if this relation is not the dependency graph at all, rename it. Then re-run. Procedure: docs/RUNBOOK.md section B1.',
      v_bad;
  END IF;

  -- THE ROW VERDICT, and it is DEFERRED on purpose.
  --
  -- A partially-applied FRESH install cannot hold a row: `CREATE TABLE` takes ACCESS EXCLUSIVE and
  -- holds it to COMMIT, so nothing can write between the create and the seals. So rows plus an
  -- UNLIFTED install barrier is a contradiction, and it is refused here naming both facts.
  --
  -- Rows with the barrier already GONE is the ordinary replay of a finished install, and it is not
  -- refused here — section 9 proves the install object by object and decides. That is the whole
  -- point of deferring: this block no longer holds a second opinion about what a correct install
  -- looks like, so it cannot disagree with the one that does.
  LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO v_rows FROM public."ActivityDependency";
  IF v_rows > 0 AND EXISTS (SELECT 1 FROM pg_constraint k
                             WHERE k.conrelid = to_regclass('public."ActivityDependency"')
                               AND k.conname = 'ActivityDependency_install_incomplete_check') THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" holds % row(s) while its install barrier "ActivityDependency_install_incomplete_check" is still in place. Those two cannot both be true of this migration''s own work: the barrier is dropped only as the last act of a proven install, and until it is dropped the table cannot be written. So these rows were not written through a completed install of this file, and this file will neither adopt them nor erase them. Establish where the rows came from, then either drop the table deliberately or clear the barrier by hand once you are satisfied. Procedure: docs/RUNBOOK.md section B1.',
      v_rows;
  END IF;

  -- POPULATED AND INCOMPLETE IS REFUSED, AND IT IS REFUSED HERE, BEFORE ANYTHING IS CREATED.
  --
  -- This file completes its OWN install, and its own install cannot hold a row: `CREATE TABLE`
  -- holds ACCESS EXCLUSIVE to COMMIT, so nothing can write between the create and the seals. A
  -- table that holds rows AND is missing a seal was therefore not built by this file, and the
  -- answer is to refuse — not to weld the missing seal onto somebody else's data and report
  -- success. If this ran later than here, sections 3 to 8 would have created the missing objects
  -- first and section 9 would then find nothing wrong, which is precisely the silent repair this
  -- file exists to refuse.
  --
  -- WHAT THIS IS AND IS NOT. It is a LIVENESS gate — "did an install finish here?" — and it names
  -- the five seals whose ABSENCE means it did not. It is deliberately NOT a second copy of section
  -- 9's correctness inventory, and it cannot rot into one: it asks only about presence, never
  -- about definitions, and if a seal is RENAMED, section 9 reports it as both MISSING and
  -- UNEXPECTED and refuses regardless of what this gate concluded.
  IF v_rows > 0 THEN
    SELECT string_agg('"' || m.name || '"', ', ' ORDER BY m.name) INTO v_bad
      FROM (VALUES ('ActivityDependency_born_live'), ('ActivityDependency_no_delete'),
                   ('ActivityDependency_no_truncate'), ('ActivityDependency_frozen'),
                   ('ActivityDependency_acyclic')) AS m(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                        WHERE g.tgrelid = to_regclass('public."ActivityDependency"')
                          AND g.tgname = m.name AND NOT g.tgisinternal AND g.tgenabled = 'O');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'schedule B1: "ActivityDependency" already exists and holds % row(s), and its installation is INCOMPLETE: armed trigger %. Both facts together mean this table was not built by a finished run of this migration — a partial apply of this file cannot hold rows, because CREATE TABLE holds ACCESS EXCLUSIVE until COMMIT. This run will not create the missing seals over data it did not write, and it neither adopted nor changed anything. Establish where the rows came from, then either drop the table deliberately or install the seals by hand once you are satisfied. Procedure: docs/RUNBOOK.md section B1.',
        v_rows, v_bad;
    END IF;
  END IF;

  -- RE-ARM A BARRIER THAT IS SIMPLY GONE, over an install that never finished.
  --
  -- An unfinished install with no write barrier is an open window with nothing in it. Refusing
  -- would be the wrong answer — it leaves the table unguarded and dead-ends the retry — so the
  -- barrier is put back from this file's own text, under the ACCESS EXCLUSIVE lock taken above,
  -- and section 9 lifts it again on proof like any other run.
  --
  -- UNCONDITIONAL WHEN ABSENT, and that is the point rather than an oversight. The invariant is
  -- "this table is writable only while a COMPLETE install stands proven", and the only thing that
  -- proves it is section 9 finishing. So every run re-arms the barrier if it is not there and
  -- section 9 lifts it again on proof; an ordinary replay of a healthy install re-arms and lifts
  -- in the same run and is a no-op end to end.
  --
  -- An earlier version of this made the re-arm conditional on the table carrying fewer than five
  -- seals — "does this look finished?" — and that was too weak in exactly the case that matters:
  -- a run whose seals all installed but whose section 9 ABORTED has five seals and an unproven
  -- install, so the condition read "finished" and left the table open with nothing verified. Any
  -- test of appearance can be satisfied by an install that never passed. Presence of the proof is
  -- the only safe condition, and the proof happens later, so the safe default before it is SHUT.
  -- SCOPED TO AN EMPTY TABLE, and that scope is forced by what the barrier IS. `CHECK ("id" !~
  -- '^')` is unsatisfiable by construction — every string matches `^` — which is exactly what
  -- makes it a write exclusion. PostgreSQL VALIDATES a CHECK against existing rows when it is
  -- added, so re-arming over a POPULATED table cannot succeed and would turn every replay of a
  -- finished, populated install into a failure. It does not need to: a partially-applied install
  -- cannot hold a row (`CREATE TABLE` holds ACCESS EXCLUSIVE to COMMIT, so nothing can write
  -- between the create and the seals), so "populated and unbarriered" is a FINISHED install being
  -- replayed, and "empty and unbarriered" is the unfinished one this re-arms.
  IF v_rows = 0
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = to_regclass('public."ActivityDependency"')
                        AND k.conname = 'ActivityDependency_install_incomplete_check') THEN
    EXECUTE 'ALTER TABLE public."ActivityDependency" ADD CONSTRAINT '
            || '"ActivityDependency_install_incomplete_check" CHECK ("id" !~ ''^'')';
    RAISE NOTICE 'schedule B1: the write barrier was absent; it has been re-armed from this file and section 9 will lift it again on proof.';
  END IF;

  -- EVERYTHING ELSE IS SECTION 9'S QUESTION, ASKED ONCE.
  --
  -- Earlier heads of this unit enumerated the columns, the ten constraints, the five foreign-key
  -- targets, the twenty internal enforcement triggers, the three indexes, the five functions and
  -- the five triggers HERE as well, so that a foreign table was refused before section 2 ran. That
  -- second enumeration is exactly the thing that failed: it was a hand-written copy of section 9's
  -- list, and the sixth review round found a by-name check in one of them that the other had
  -- already fixed. Two lists that must agree will eventually not.
  --
  -- There is now ONE comparison, in section 9, and it is a SET EQUALITY rather than a list. Nothing
  -- between here and there can make a wrong table writable: sections 2 to 8 are all guarded creates
  -- that add nothing to a relation that already carries the object, section 2 installs the write
  -- barrier INLINE with the table, and the barrier is dropped only after section 9 has compared
  -- every catalog object attached to this table against the full expected set in both directions.
  -- A foreign table therefore reaches section 9 and is refused there, by name, with both
  -- definitions printed — and stays unwritable because the barrier is never lifted.
  PERFORM set_config('search_path', v_path, true);
END $$;

-- ── 2. The table, with its keys and its CHECKs declared INLINE ────────────────────────────────
-- `IF NOT EXISTS` is what makes the resume path possible, and section 1 is what makes it safe.
-- The guard matches on the table's NAME, so on a table that is already there this whole
-- definition — every column, every CHECK, every key — is skipped WHOLESALE. Left on its own that
-- would silently report success over a table carrying none of these rules. Section 1d and 1e ran
-- first precisely to remove that possibility: past them, a table that exists has exactly these
-- columns and exactly these ten constraints, so skipping the definition skips nothing.
--
-- Declaring them INLINE rather than as separate guarded ALTERs is then the stronger choice, and
-- deliberately so: `CREATE TABLE` installs the table and all ten ATOMICALLY, which is what lets
-- section 9's set equality treat an ABSENT CHECK as proof that some other tool built this table.
CREATE TABLE IF NOT EXISTS public."ActivityDependency" (
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

  -- ── THE INSTALL BARRIER ─────────────────────────────────────────────────────────────────────
  -- NOTHING MAY WRITE THIS TABLE UNTIL EVERY SEAL BELOW IS ARMED, and a lock cannot say that.
  --
  -- The hazard, concretely: this file deliberately opens no transaction of its own, so for a
  -- caller in autocommit the `CREATE TABLE` above COMMITS on its own and releases the ACCESS
  -- EXCLUSIVE lock it took. Between that commit and the `CREATE TRIGGER` statements at the end of
  -- the file the table exists and is unguarded, and one interleaving is enough:
  --
  --     T1  runs this file, finishes CREATE TABLE, commits
  --     T2  INSERTs an edge that is ALREADY REVOKED — a withdrawal that never happened
  --     T1  arms `ActivityDependency_born_live` and reports success
  --
  -- Creating a trigger validates NOTHING already in the table, so T2's row survives — and every
  -- other seal then works in its favour: section 6 refuses to touch a revoked row, so the
  -- fabrication is permanent; section 7's walk reads live edges only, so it passes trivially; and
  -- the partial unique index covers live rows only, so the same pair can accumulate more.
  --
  -- A lock cannot close this. A lock is released at COMMIT, and on the autocommit path COMMIT
  -- happens after every statement — no rewriting of this file can hold one across the gap, which
  -- is a property of the CALLER. So the exclusion is written into the TABLE instead.
  --
  -- This CHECK is unsatisfiable: every text value matches the start-of-string anchor, so `!~ '^'`
  -- is FALSE for every non-null `id`, and `id` is NOT NULL. While it stands the table refuses
  -- every INSERT, from every role, including a superuser — a CHECK is not a trigger and
  -- `session_replication_role = replica` does not switch it off. Section 9 drops it, and only
  -- after proving that all five seals are armed and bound to the functions in `public`.
  --
  -- It is written as a regex rather than as `CHECK (false)` on purpose: a constant-false CHECK is
  -- visible to constraint exclusion, and under `constraint_exclusion = on` the planner may answer
  -- "no rows" for a scan of this table without reading it — which would make section 1's own row
  -- count lie. This form depends on the column, so it cannot be folded away.
  --
  -- It is STRICTLY STRONGER than the transaction it replaces: a lock dies with the session, so a
  -- run killed mid-install would leave the unguarded table behind anyway. This barrier survives
  -- the crash — an unfinished install is unwritable until a later run finishes it.
  CONSTRAINT "ActivityDependency_install_incomplete_check" CHECK ("id" !~ '^'),

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
  --
  -- EVERY TARGET IS `public.`-QUALIFIED, and that is the difference between containment and the
  -- appearance of it. A foreign-key target is resolved through the search path of whoever runs
  -- this statement. The `SET LOCAL search_path` that used to stand at the top of this file was
  -- inert for the autocommit caller — LOCAL is a warning, not an error, outside a transaction
  -- block — so an unqualified `REFERENCES "Project"` bound to whatever the caller's path found
  -- first. MEASURED against the earlier head with a caller path of `b1decoy,public` holding
  -- same-named decoys: exit 0, all five keys pointing into `b1decoy`, and no containment at all.
  -- Worse, a deparsed comparison could not see it, because `pg_get_constraintdef` renders the
  -- target relative to that same path and printed the decoy as `"Project"`. So the target is
  -- written out here, and the file pins `search_path = pg_catalog` so every rendered definition
  -- section 9 compares is FULLY QUALIFIED and a decoy binding is textually different.
  CONSTRAINT "ActivityDependency_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
    FOREIGN KEY ("projectId", "predecessorId") REFERENCES public."Activity"("projectId", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ActivityDependency_projectId_successorId_fkey"
    FOREIGN KEY ("projectId", "successorId") REFERENCES public."Activity"("projectId", "id")
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
    FOREIGN KEY ("projectId", "createdById") REFERENCES public."Membership"("projectId", "userId")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ActivityDependency_revokedBy_fkey"
    FOREIGN KEY ("projectId", "revokedById") REFERENCES public."Membership"("projectId", "userId")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- NOTHING MAY WRITE THIS TABLE BETWEEN ITS CREATION AND ITS SEALS.
--
-- On both paths through this file the lock is ALREADY HELD by the time this runs — on a fresh
-- install by the `CREATE TABLE` above, on a resume by section 1's LOCK — and PostgreSQL holds it until
-- COMMIT. It is stated anyway rather than left implicit: asserting the requirement where it is
-- relied on does not depend on which branch got here, and it costs one lock acquisition the
-- transaction already owns.
--
-- WRAPPED IN A `DO` BLOCK, and that is the point rather than a style choice. A bare
-- `LOCK TABLE` is an ERROR outside a transaction block — `LOCK TABLE can only be used in
-- transaction blocks` — so as a top-level statement it makes this file UNRUNNABLE for a caller in
-- autocommit: the `CREATE TABLE` above commits, this fails, the table is left behind, and every
-- retry fails here again. That is the same dead end the unconditional refusal produced, one
-- statement further down. Inside a `DO` block the statement always has a transaction — the
-- caller's if there is one, an implicit single-statement one if there is not.
--
-- What autocommit cannot have is the lock HELD ACROSS statements, and no rewriting of this file
-- changes that: the seals below then go on in separate transactions and a writer could reach the
-- table between them. That is a property of the caller, not of this file, which is why both real
-- callers supply a transaction and the header says so.
--
-- ACCESS EXCLUSIVE, not a weaker mode: the writer to shut out is an ordinary INSERT, and only this
-- mode conflicts with the ROW EXCLUSIVE lock an INSERT takes.
DO $$ BEGIN LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE; END $$;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────────────────────
-- Separate statements, so unlike the inline constraints these CAN legitimately be missing from
-- this file's own interrupted run — which is why they are guarded and the constraints are not.
-- `IF NOT EXISTS` matches on the NAME alone, and index names are schema-scoped rather than
-- table-scoped, so a same-named index on ANOTHER relation silences this create and leaves this
-- table unindexed. That is not pre-checked here: section 9 compares the index set attached to
-- THIS table, so the index reads as MISSING, the barrier is not lifted, and the refusal says so
-- — and it also reports where the colliding name actually lives, so the operator is not left
-- guessing why a create that reported success installed nothing.
--
-- The unique index is PARTIAL because a revoked edge stays on the record: re-imposing a constraint
-- withdrawn earlier is an ordinary re-plan, and what must not be allowed is two LIVE edges for one
-- ordered pair. It is also the candidate key an EDGE-SCOPED dependency override must reference —
-- an override attached to the successor alone would excuse every predecessor at once. Prisma
-- cannot express a partial unique, which is why it is raw SQL and why `schema.prisma` says so.
CREATE UNIQUE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_predecessorId_key"
  ON public."ActivityDependency" ("projectId", "successorId", "predecessorId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_predecessorId_idx"
  ON public."ActivityDependency" ("projectId", "predecessorId");

CREATE INDEX IF NOT EXISTS "ActivityDependency_projectId_successorId_idx"
  ON public."ActivityDependency" ("projectId", "successorId");

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
--
-- The body is held in a variable and the function is created FROM that variable, so the text this
-- file installs and the text it compares against are the SAME string — there is no second copy to
-- drift. `prosrc` stores exactly what the `AS` literal contained, so the comparison is exact.
-- WHAT IS COMPARED IS THE WHOLE CATALOG ROW, not only the body. The header's FUNCTION enumeration
-- carries the verdict on every `pg_proc` column; these are the ones a same-bodied clone can differ
-- in, and every one of them is part of the string below:
--   prorettype / prolang  a body of the right shape on the wrong return type or language.
--   proconfig             the `search_path` pin IS part of the rule — without it the acyclicity
--                         walk resolves `"ActivityDependency"` through the CALLING session's path,
--                         and `pg_temp` comes first by default.
--   provolatile           must be VOLATILE, and this is the one that reaches furthest. A STABLE or
--                         IMMUTABLE clone runs its reads on the CALLING STATEMENT's snapshot, so
--                         the advisory-lock protocol in section 7 stops working: T2 starts an
--                         opposing INSERT, waits on T1's project lock, wakes after T1 commits, and
--                         re-runs the reachability read on a snapshot taken BEFORE the lock — it
--                         cannot see T1's edge, and it commits the cycle. Same body, same
--                         language, same pin, opposite behaviour. MEASURED against the earlier
--                         head: a `STABLE` clone of the identical body was accepted, exit 0.
--   prosecdef             must be SECURITY INVOKER — a definer clone runs as another role, with
--                         that role's privileges and RLS exemptions.
--   proleakproof          must be false — a leakproof function may be pushed down past a security
--                         barrier or an RLS qual, which changes what it reads.
--   proparallel /         pinned to what `CREATE FUNCTION` produces. None of the three can be
--   proisstrict /         exploited today, and each costs exactly one comparison to pin, which is
--   prokind / proretset   cheaper than defending the exclusion in a later round.
--   proowner              must be the OWNER OF THE TABLE. Ownership is the right to
--                         `CREATE OR REPLACE` this body at any moment, so a seal owned by a role
--                         the table's owner does not control is not a seal. Compared RELATIVELY,
--                         because this file creates the table and all five functions in one run.
DO $install$
DECLARE
  v_body TEXT := $body$
BEGIN
  IF NEW."revokedAt"        IS NOT NULL
     OR NEW."revokedById"   IS NOT NULL
     OR NEW."revokedByName" IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: dependency edge % cannot be created already revoked — a withdrawal is the record of a constraint that once stood, and this one never did. Insert the edge live, then revoke it.', NEW."id";
  END IF;
  RETURN NEW;
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/volatile/invoker/kind=f/setof=f/strict=f/leakproof=f/parallel=u'
            || '/owner=table/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname
         || '/' || pg_catalog.format_type(p.prorettype, NULL)
         || '/' || CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable'
                                      WHEN 'i' THEN 'immutable' ELSE p.provolatile::TEXT END
         || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
         || '/kind=' || p.prokind::TEXT
         || '/setof=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
         || '/strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
         || '/leakproof=' || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
         || '/parallel=' || p.proparallel::TEXT
         || '/owner=' || CASE WHEN p.proowner = (SELECT c.relowner FROM pg_class c
                                                  WHERE c.oid = 'public."ActivityDependency"'::regclass)
                              THEN 'table' ELSE p.proowner::REGROLE::TEXT END
         || '/' || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'activity_dependency_born_live' AND p.pronargs = 0;
  IF v_found IS NOT NULL AND v_found <> v_want THEN
    RAISE EXCEPTION 'schedule B1: function public.activity_dependency_born_live() already exists with a definition this migration did not install, so this is not this migration''s partial apply and the function will not be adopted or overwritten. Expected: %. Found: %. Procedure: docs/RUNBOOK.md section B1.',
      v_want, v_found;
  END IF;
  IF v_found IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS %L',
                   'activity_dependency_born_live', v_body);
  END IF;
END $install$;

-- ── 5. Removal must not launder attribution ───────────────────────────────────────────────────
-- Section 6 makes the record permanent against UPDATE. It has nothing to hold on to against
-- DELETE: an edge attributed to one person could be removed and the identical pair re-inserted
-- under another name, both statements accepted and the original author gone from the record. Since
-- a disputed sequence is what the attribution exists to answer, the supported way to remove an
-- edge is to REVOKE it — the row stays, both attributions stay, and the partial unique index lets
-- the pair be re-imposed afterwards.
--
-- The body is held in a variable and the function is created FROM that variable, so the text this
-- file installs and the text it compares against are the SAME string — there is no second copy to
-- drift. `prosrc` stores exactly what the `AS` literal contained, so the comparison is exact.
-- WHAT IS COMPARED IS THE WHOLE CATALOG ROW, not only the body. The header's FUNCTION enumeration
-- carries the verdict on every `pg_proc` column; these are the ones a same-bodied clone can differ
-- in, and every one of them is part of the string below:
--   prorettype / prolang  a body of the right shape on the wrong return type or language.
--   proconfig             the `search_path` pin IS part of the rule — without it the acyclicity
--                         walk resolves `"ActivityDependency"` through the CALLING session's path,
--                         and `pg_temp` comes first by default.
--   provolatile           must be VOLATILE, and this is the one that reaches furthest. A STABLE or
--                         IMMUTABLE clone runs its reads on the CALLING STATEMENT's snapshot, so
--                         the advisory-lock protocol in section 7 stops working: T2 starts an
--                         opposing INSERT, waits on T1's project lock, wakes after T1 commits, and
--                         re-runs the reachability read on a snapshot taken BEFORE the lock — it
--                         cannot see T1's edge, and it commits the cycle. Same body, same
--                         language, same pin, opposite behaviour. MEASURED against the earlier
--                         head: a `STABLE` clone of the identical body was accepted, exit 0.
--   prosecdef             must be SECURITY INVOKER — a definer clone runs as another role, with
--                         that role's privileges and RLS exemptions.
--   proleakproof          must be false — a leakproof function may be pushed down past a security
--                         barrier or an RLS qual, which changes what it reads.
--   proparallel /         pinned to what `CREATE FUNCTION` produces. None of the three can be
--   proisstrict /         exploited today, and each costs exactly one comparison to pin, which is
--   prokind / proretset   cheaper than defending the exclusion in a later round.
--   proowner              must be the OWNER OF THE TABLE. Ownership is the right to
--                         `CREATE OR REPLACE` this body at any moment, so a seal owned by a role
--                         the table's owner does not control is not a seal. Compared RELATIVELY,
--                         because this file creates the table and all five functions in one run.
DO $install$
DECLARE
  v_body TEXT := $body$
BEGIN
  RAISE EXCEPTION 'schedule: dependency edge % is not deletable — who imposed this sequencing constraint, and who withdrew it, are both part of the record. Revoke it instead (set revokedAt/revokedById/revokedByName).', OLD."id";
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/volatile/invoker/kind=f/setof=f/strict=f/leakproof=f/parallel=u'
            || '/owner=table/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname
         || '/' || pg_catalog.format_type(p.prorettype, NULL)
         || '/' || CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable'
                                      WHEN 'i' THEN 'immutable' ELSE p.provolatile::TEXT END
         || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
         || '/kind=' || p.prokind::TEXT
         || '/setof=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
         || '/strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
         || '/leakproof=' || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
         || '/parallel=' || p.proparallel::TEXT
         || '/owner=' || CASE WHEN p.proowner = (SELECT c.relowner FROM pg_class c
                                                  WHERE c.oid = 'public."ActivityDependency"'::regclass)
                              THEN 'table' ELSE p.proowner::REGROLE::TEXT END
         || '/' || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'activity_dependency_no_delete' AND p.pronargs = 0;
  IF v_found IS NOT NULL AND v_found <> v_want THEN
    RAISE EXCEPTION 'schedule B1: function public.activity_dependency_no_delete() already exists with a definition this migration did not install, so this is not this migration''s partial apply and the function will not be adopted or overwritten. Expected: %. Found: %. Procedure: docs/RUNBOOK.md section B1.',
      v_want, v_found;
  END IF;
  IF v_found IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS %L',
                   'activity_dependency_no_delete', v_body);
  END IF;
END $install$;

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
--
-- The body is held in a variable and the function is created FROM that variable, so the text this
-- file installs and the text it compares against are the SAME string — there is no second copy to
-- drift. `prosrc` stores exactly what the `AS` literal contained, so the comparison is exact.
-- WHAT IS COMPARED IS THE WHOLE CATALOG ROW, not only the body. The header's FUNCTION enumeration
-- carries the verdict on every `pg_proc` column; these are the ones a same-bodied clone can differ
-- in, and every one of them is part of the string below:
--   prorettype / prolang  a body of the right shape on the wrong return type or language.
--   proconfig             the `search_path` pin IS part of the rule — without it the acyclicity
--                         walk resolves `"ActivityDependency"` through the CALLING session's path,
--                         and `pg_temp` comes first by default.
--   provolatile           must be VOLATILE, and this is the one that reaches furthest. A STABLE or
--                         IMMUTABLE clone runs its reads on the CALLING STATEMENT's snapshot, so
--                         the advisory-lock protocol in section 7 stops working: T2 starts an
--                         opposing INSERT, waits on T1's project lock, wakes after T1 commits, and
--                         re-runs the reachability read on a snapshot taken BEFORE the lock — it
--                         cannot see T1's edge, and it commits the cycle. Same body, same
--                         language, same pin, opposite behaviour. MEASURED against the earlier
--                         head: a `STABLE` clone of the identical body was accepted, exit 0.
--   prosecdef             must be SECURITY INVOKER — a definer clone runs as another role, with
--                         that role's privileges and RLS exemptions.
--   proleakproof          must be false — a leakproof function may be pushed down past a security
--                         barrier or an RLS qual, which changes what it reads.
--   proparallel /         pinned to what `CREATE FUNCTION` produces. None of the three can be
--   proisstrict /         exploited today, and each costs exactly one comparison to pin, which is
--   prokind / proretset   cheaper than defending the exclusion in a later round.
--   proowner              must be the OWNER OF THE TABLE. Ownership is the right to
--                         `CREATE OR REPLACE` this body at any moment, so a seal owned by a role
--                         the table's owner does not control is not a seal. Compared RELATIVELY,
--                         because this file creates the table and all five functions in one run.
DO $install$
DECLARE
  v_body TEXT := $body$
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
  -- THE FAST PATH IS ONLY SOUND UNDER READ COMMITTED, and this is the finding that closes.
  --
  -- The lock is not enough. TRUNCATE takes ACCESS EXCLUSIVE before firing this trigger, which
  -- serialises PHYSICAL access — but it does not move a transaction's SNAPSHOT. Under REPEATABLE
  -- READ or SERIALIZABLE the snapshot is fixed at the transaction's first statement, so T1 can fix
  -- a snapshot on an empty table, T2 can insert an edge and COMMIT, and T1 can then take the lock
  -- while this SELECT still reads the old snapshot, see nothing, and let the physical truncate
  -- erase T2's committed sequencing evidence. MEASURED before this guard existed, on PostgreSQL
  -- 16.13, driven by a pg_locks barrier rather than a sleep: T1_SNAPSHOT_SEES=0, T1's TRUNCATE
  -- queued as BLOCKED mode=AccessExclusiveLock, T2 committed its edge, T1's log recorded
  -- `TRUNCATE TABLE`, and the surviving row count was 0.
  --
  -- Under READ COMMITTED each statement takes a FRESH snapshot, and this trigger's statement runs
  -- after the lock is held, so what it reads is everything committed at that moment and no writer
  -- can slip in behind it. So the fast path is trusted there and refused everywhere else.
  --
  -- Refusing the ISOLATION rather than refusing TRUNCATE outright, because the fast path is
  -- load-bearing and unconditional refusal is NOT available: `apps/api/test/integration/
  -- event-catalog.test.ts` resets with `TRUNCATE "Decision","Activity",... CASCADE`, and this
  -- table foreign-keys into "Activity", so the CASCADE reaches it and fires this trigger WITHOUT
  -- disabling it by name. MEASURED: a cascaded BEFORE TRUNCATE trigger does fire. Every caller
  -- that truncates this table DIRECTLY (`prisma/seed.ts`, this unit's own suite) already disables
  -- the seal by name first; the CASCADE path is the one that depends on the emptiness answer.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'schedule: "ActivityDependency" cannot be TRUNCATEd from a % transaction. This seal permits a TRUNCATE that erases nothing, and that emptiness test is only race-free under READ COMMITTED, where the statement''s snapshot is taken after the ACCESS EXCLUSIVE lock is held. Under a fixed-snapshot isolation level a concurrently committed edge is invisible here and would be erased. Re-run the reset under READ COMMITTED, or disable "ActivityDependency_no_truncate" by name for the duration of a sanctioned destructive reset.',
      current_setting('transaction_isolation');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ActivityDependency") THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'schedule: "ActivityDependency" holds the sequencing record — who imposed each constraint and who withdrew it — and is never truncated. Revoke edges individually; a sanctioned destructive reset disables "ActivityDependency_no_truncate" by name for the duration of the reset.';
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/volatile/invoker/kind=f/setof=f/strict=f/leakproof=f/parallel=u'
            || '/owner=table/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname
         || '/' || pg_catalog.format_type(p.prorettype, NULL)
         || '/' || CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable'
                                      WHEN 'i' THEN 'immutable' ELSE p.provolatile::TEXT END
         || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
         || '/kind=' || p.prokind::TEXT
         || '/setof=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
         || '/strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
         || '/leakproof=' || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
         || '/parallel=' || p.proparallel::TEXT
         || '/owner=' || CASE WHEN p.proowner = (SELECT c.relowner FROM pg_class c
                                                  WHERE c.oid = 'public."ActivityDependency"'::regclass)
                              THEN 'table' ELSE p.proowner::REGROLE::TEXT END
         || '/' || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'activity_dependency_no_truncate' AND p.pronargs = 0;
  IF v_found IS NOT NULL AND v_found <> v_want THEN
    RAISE EXCEPTION 'schedule B1: function public.activity_dependency_no_truncate() already exists with a definition this migration did not install, so this is not this migration''s partial apply and the function will not be adopted or overwritten. Expected: %. Found: %. Procedure: docs/RUNBOOK.md section B1.',
      v_want, v_found;
  END IF;
  IF v_found IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS %L',
                   'activity_dependency_no_truncate', v_body);
  END IF;
END $install$;

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
--
-- The body is held in a variable and the function is created FROM that variable, so the text this
-- file installs and the text it compares against are the SAME string — there is no second copy to
-- drift. `prosrc` stores exactly what the `AS` literal contained, so the comparison is exact.
-- WHAT IS COMPARED IS THE WHOLE CATALOG ROW, not only the body. The header's FUNCTION enumeration
-- carries the verdict on every `pg_proc` column; these are the ones a same-bodied clone can differ
-- in, and every one of them is part of the string below:
--   prorettype / prolang  a body of the right shape on the wrong return type or language.
--   proconfig             the `search_path` pin IS part of the rule — without it the acyclicity
--                         walk resolves `"ActivityDependency"` through the CALLING session's path,
--                         and `pg_temp` comes first by default.
--   provolatile           must be VOLATILE, and this is the one that reaches furthest. A STABLE or
--                         IMMUTABLE clone runs its reads on the CALLING STATEMENT's snapshot, so
--                         the advisory-lock protocol in section 7 stops working: T2 starts an
--                         opposing INSERT, waits on T1's project lock, wakes after T1 commits, and
--                         re-runs the reachability read on a snapshot taken BEFORE the lock — it
--                         cannot see T1's edge, and it commits the cycle. Same body, same
--                         language, same pin, opposite behaviour. MEASURED against the earlier
--                         head: a `STABLE` clone of the identical body was accepted, exit 0.
--   prosecdef             must be SECURITY INVOKER — a definer clone runs as another role, with
--                         that role's privileges and RLS exemptions.
--   proleakproof          must be false — a leakproof function may be pushed down past a security
--                         barrier or an RLS qual, which changes what it reads.
--   proparallel /         pinned to what `CREATE FUNCTION` produces. None of the three can be
--   proisstrict /         exploited today, and each costs exactly one comparison to pin, which is
--   prokind / proretset   cheaper than defending the exclusion in a later round.
--   proowner              must be the OWNER OF THE TABLE. Ownership is the right to
--                         `CREATE OR REPLACE` this body at any moment, so a seal owned by a role
--                         the table's owner does not control is not a seal. Compared RELATIVELY,
--                         because this file creates the table and all five functions in one run.
DO $install$
DECLARE
  v_body TEXT := $body$
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
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/volatile/invoker/kind=f/setof=f/strict=f/leakproof=f/parallel=u'
            || '/owner=table/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname
         || '/' || pg_catalog.format_type(p.prorettype, NULL)
         || '/' || CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable'
                                      WHEN 'i' THEN 'immutable' ELSE p.provolatile::TEXT END
         || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
         || '/kind=' || p.prokind::TEXT
         || '/setof=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
         || '/strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
         || '/leakproof=' || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
         || '/parallel=' || p.proparallel::TEXT
         || '/owner=' || CASE WHEN p.proowner = (SELECT c.relowner FROM pg_class c
                                                  WHERE c.oid = 'public."ActivityDependency"'::regclass)
                              THEN 'table' ELSE p.proowner::REGROLE::TEXT END
         || '/' || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'activity_dependency_frozen' AND p.pronargs = 0;
  IF v_found IS NOT NULL AND v_found <> v_want THEN
    RAISE EXCEPTION 'schedule B1: function public.activity_dependency_frozen() already exists with a definition this migration did not install, so this is not this migration''s partial apply and the function will not be adopted or overwritten. Expected: %. Found: %. Procedure: docs/RUNBOOK.md section B1.',
      v_want, v_found;
  END IF;
  IF v_found IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS %L',
                   'activity_dependency_frozen', v_body);
  END IF;
END $install$;

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
--
-- The body is held in a variable and the function is created FROM that variable, so the text this
-- file installs and the text it compares against are the SAME string — there is no second copy to
-- drift. `prosrc` stores exactly what the `AS` literal contained, so the comparison is exact.
-- WHAT IS COMPARED IS THE WHOLE CATALOG ROW, not only the body. The header's FUNCTION enumeration
-- carries the verdict on every `pg_proc` column; these are the ones a same-bodied clone can differ
-- in, and every one of them is part of the string below:
--   prorettype / prolang  a body of the right shape on the wrong return type or language.
--   proconfig             the `search_path` pin IS part of the rule — without it the acyclicity
--                         walk resolves `"ActivityDependency"` through the CALLING session's path,
--                         and `pg_temp` comes first by default.
--   provolatile           must be VOLATILE, and this is the one that reaches furthest. A STABLE or
--                         IMMUTABLE clone runs its reads on the CALLING STATEMENT's snapshot, so
--                         the advisory-lock protocol in section 7 stops working: T2 starts an
--                         opposing INSERT, waits on T1's project lock, wakes after T1 commits, and
--                         re-runs the reachability read on a snapshot taken BEFORE the lock — it
--                         cannot see T1's edge, and it commits the cycle. Same body, same
--                         language, same pin, opposite behaviour. MEASURED against the earlier
--                         head: a `STABLE` clone of the identical body was accepted, exit 0.
--   prosecdef             must be SECURITY INVOKER — a definer clone runs as another role, with
--                         that role's privileges and RLS exemptions.
--   proleakproof          must be false — a leakproof function may be pushed down past a security
--                         barrier or an RLS qual, which changes what it reads.
--   proparallel /         pinned to what `CREATE FUNCTION` produces. None of the three can be
--   proisstrict /         exploited today, and each costs exactly one comparison to pin, which is
--   prokind / proretset   cheaper than defending the exclusion in a later round.
--   proowner              must be the OWNER OF THE TABLE. Ownership is the right to
--                         `CREATE OR REPLACE` this body at any moment, so a seal owned by a role
--                         the table's owner does not control is not a seal. Compared RELATIVELY,
--                         because this file creates the table and all five functions in one run.
DO $install$
DECLARE
  v_body TEXT := $body$
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
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/volatile/invoker/kind=f/setof=f/strict=f/leakproof=f/parallel=u'
            || '/owner=table/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname
         || '/' || pg_catalog.format_type(p.prorettype, NULL)
         || '/' || CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable'
                                      WHEN 'i' THEN 'immutable' ELSE p.provolatile::TEXT END
         || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
         || '/kind=' || p.prokind::TEXT
         || '/setof=' || CASE WHEN p.proretset THEN 't' ELSE 'f' END
         || '/strict=' || CASE WHEN p.proisstrict THEN 't' ELSE 'f' END
         || '/leakproof=' || CASE WHEN p.proleakproof THEN 't' ELSE 'f' END
         || '/parallel=' || p.proparallel::TEXT
         || '/owner=' || CASE WHEN p.proowner = (SELECT c.relowner FROM pg_class c
                                                  WHERE c.oid = 'public."ActivityDependency"'::regclass)
                              THEN 'table' ELSE p.proowner::REGROLE::TEXT END
         || '/' || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
    INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language  l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND p.proname = 'activity_dependency_acyclic' AND p.pronargs = 0;
  IF v_found IS NOT NULL AND v_found <> v_want THEN
    RAISE EXCEPTION 'schedule B1: function public.activity_dependency_acyclic() already exists with a definition this migration did not install, so this is not this migration''s partial apply and the function will not be adopted or overwritten. Expected: %. Found: %. Procedure: docs/RUNBOOK.md section B1.',
      v_want, v_found;
  END IF;
  IF v_found IS NULL THEN
    EXECUTE format('CREATE FUNCTION public.%I() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS %L',
                   'activity_dependency_acyclic', v_body);
  END IF;
END $install$;

-- ── 8. Arm the five seals ─────────────────────────────────────────────────────────────────────
-- The functions above are the RULES; a rule nothing invokes is a comment. These five triggers are
-- what bind them to the table, and they are installed here, together, for one reason: a trigger is
-- the last object of the set, so if this file is interrupted the seals are the most likely thing
-- to be missing — and grouping them makes "are the seals armed?" one question with one answer.
--
-- `CREATE TRIGGER` has no `IF NOT EXISTS`, and PostgreSQL 14's `CREATE OR REPLACE TRIGGER` would
-- be worse than none here: it would overwrite whatever is there, which is exactly the adoption
-- this file refuses. So each is compared first.
--
-- COMPARED BY DEFINITION, four properties deep, because each is separately forgeable and each
-- failure is silent:
--   `pg_get_triggerdef`  covers the timing, the event, the FOR EACH level and the function bound —
--                        that is `tgtype` and `tgfoid` rendered as text, and it prints the table,
--                        so `tgrelid` is in it too. A `no_delete` trigger pointed at the
--                        `born_live` function, or an AFTER trigger where a BEFORE one is required,
--                        differs here and nowhere else.
--   `tgenabled`          is NOT in that text. `ALTER TABLE ... DISABLE TRIGGER` leaves a trigger
--                        that reads as present and fires for nobody, and the sanctioned test and
--                        seed resets in this repository disable seals by name — so a reset that
--                        died before re-enabling would otherwise be adopted as correct. 'O' is
--                        "enabled, origin", which is what a plain CREATE produces.
--   the lookup itself    is scoped by `tgrelid` and `NOT tgisinternal`: a trigger name is unique
--                        per TABLE in PostgreSQL, so unlike an index name there is nothing to
--                        reclaim, but the internal triggers backing the five foreign keys share
--                        this relation and are none of this file's business.
DO $install$
DECLARE
  r         RECORD;
  v_def     TEXT;
  v_enabled TEXT;
  v_foid    TEXT;
  v_type    SMALLINT;
  v_bound   BOOLEAN;
  v_path    TEXT;
BEGIN
  -- THE FUNCTION REFERENCE IS RESOLVED THROUGH THE CALLER'S SEARCH PATH unless it is qualified,
  -- and `SET LOCAL search_path` at the top of this file is only a WARNING outside a transaction
  -- block — so for the autocommit caller this file must support, it does nothing at all. A role
  -- whose path names another schema before `public`, holding a same-named no-op, would get a
  -- trigger bound to the DECOY: the migration verifies and creates the canonical function in
  -- `public`, arms a trigger that calls something else, and exits 0 with the seal inert.
  --
  -- Three things close that, and all three are needed:
  --   1. every `EXECUTE FUNCTION` target below is written `public.`-qualified, so creation cannot
  --      resolve anywhere else;
  --   2. `pg_get_triggerdef` renders the function reference RELATIVE TO THE READER'S path, which
  --      would make the comparison below path-dependent — so the path is pinned to `pg_catalog`
  --      for the duration of this block, under which every reference renders fully qualified and
  --      a decoy binding is textually different from a canonical one;
  --   3. a trigger this file has just CREATED is re-read and compared like any other, rather than
  --      assumed correct. That is what makes the qualification proven instead of intended.
  -- Section 9 then re-asks the same question one last time, against `tgfoid` directly.
  --
  -- The pin is transaction-local and the previous value is restored at the end of the block, so
  -- nothing leaks into the rest of the file or into the connection the deploy goes on to use.
  v_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog', true);

  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_born_live', 'activity_dependency_born_live', 7::SMALLINT,
       'CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live()',
       'CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live()'),
      ('ActivityDependency_no_delete', 'activity_dependency_no_delete', 11::SMALLINT,
       'CREATE TRIGGER "ActivityDependency_no_delete" BEFORE DELETE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_no_delete()',
       'CREATE TRIGGER "ActivityDependency_no_delete" BEFORE DELETE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_no_delete()'),
      ('ActivityDependency_no_truncate', 'activity_dependency_no_truncate', 34::SMALLINT,
       'CREATE TRIGGER "ActivityDependency_no_truncate" BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate()',
       'CREATE TRIGGER "ActivityDependency_no_truncate" BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate()'),
      ('ActivityDependency_frozen', 'activity_dependency_frozen', 19::SMALLINT,
       'CREATE TRIGGER "ActivityDependency_frozen" BEFORE UPDATE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_frozen()',
       'CREATE TRIGGER "ActivityDependency_frozen" BEFORE UPDATE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_frozen()'),
      ('ActivityDependency_acyclic', 'activity_dependency_acyclic', 7::SMALLINT,
       'CREATE TRIGGER "ActivityDependency_acyclic" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_acyclic()',
       'CREATE TRIGGER "ActivityDependency_acyclic" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_acyclic()')
    ) AS t(name, fn, tgtype, ddl, canonical)
  LOOP
    SELECT regexp_replace(pg_get_triggerdef(g.oid), '[[:space:]]+', ' ', 'g'),
           g.tgenabled::TEXT, g.tgfoid::REGPROCEDURE::TEXT, g.tgtype,
           g.tgfoid = to_regprocedure('public.' || r.fn || '()')
      INTO v_def, v_enabled, v_foid, v_type, v_bound
      FROM pg_trigger g
     WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
       AND g.tgname = r.name AND NOT g.tgisinternal;

    IF v_def IS NULL THEN
      EXECUTE r.ddl;                                       -- absent: this is the resumable case
      -- AND RE-READ IT. What was just created is not assumed to be what was just asked for; the
      -- comparison below runs over the trigger that actually exists, so a binding that resolved
      -- somewhere other than `public` is caught on the run that made it rather than on the next.
      SELECT regexp_replace(pg_get_triggerdef(g.oid), '[[:space:]]+', ' ', 'g'),
             g.tgenabled::TEXT, g.tgfoid::REGPROCEDURE::TEXT, g.tgtype,
             g.tgfoid = to_regprocedure('public.' || r.fn || '()')
        INTO v_def, v_enabled, v_foid, v_type, v_bound
        FROM pg_trigger g
       WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
         AND g.tgname = r.name AND NOT g.tgisinternal;
    END IF;

    -- FOUR PROPERTIES, and two of them are asked as CATALOG VALUES rather than as rendered text.
    --
    -- `pg_get_triggerdef` deparses the timing, the event mask, the FOR EACH level and the bound
    -- function — but it deparses the FUNCTION relative to a search path, which is why this block
    -- pins one. `tgtype` and `tgfoid` are those same two facts as raw catalog values, and a value
    -- has no rendering to be relative to: `tgtype` pins BEFORE-vs-AFTER and ROW-vs-STATEMENT as
    -- the integer PostgreSQL actually stores, and `tgfoid` is compared against
    -- `to_regprocedure('public.…')`, so a trigger bound to a same-named decoy fails here however
    -- it prints. Section 9 asks `tgfoid` once more over the finished install.
    CONTINUE WHEN v_def = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g')
             AND v_enabled = 'O' AND v_type = r.tgtype AND v_bound;

    RAISE EXCEPTION 'schedule B1: trigger "%" already exists on "ActivityDependency" with a definition this migration did not install, and it will not be adopted or overwritten. Found: % (tgenabled=%, tgtype=%, function %, bound to public.%()=%). Expected: % (tgenabled=O, tgtype=%). Procedure: docs/RUNBOOK.md section B1.',
      r.name, v_def, v_enabled, v_type, v_foid, r.fn, COALESCE(v_bound::TEXT, 'unknown'),
      regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g'), r.tgtype;
  END LOOP;

  PERFORM set_config('search_path', v_path, true);
END $install$;

-- ── 9. Finish the install: prove every seal, then LIFT THE INSTALL BARRIER ────────────────────
-- Section 2 made the table unwritable the moment it existed. This is where that ends, and it ends
-- only on proof — so the barrier is not a formality that gets dropped a few lines later, it is a
-- gate the install has to pass. Until this statement commits, no INSERT into the dependency graph
-- can succeed by any route: not the application, not a seed, not a direct SQL client, not a
-- superuser. That is what "hold the write exclusion through creation of every seal" means for a
-- file whose caller may supply no transaction at all.
--
-- WHAT IS ASKED HERE THAT WAS NOT ASKED ABOVE. Sections 1 to 8 each judge one object as they meet
-- it, and each may CREATE the object it was judging. This section runs after all of them and asks
-- the whole question ONCE, as a SET EQUALITY over every catalog object now attached to this table
-- — relation, columns, constraints, indexes, user triggers, the internal triggers that implement
-- each foreign key, and the trigger functions. The comparison and its two named exceptions are
-- documented at the inventory itself, a few lines below.
--
-- It is the ONLY full comparison in this file, and `apps/api/src/activities/b1/b1-seals.ts`
-- extracts and re-runs the same text on every production deploy. That is deliberate: the previous
-- head kept a second hand-written comparison in section 1, and the round that closed it found a
-- by-name CHECK test in the deploy verifier that section 1 had already been fixed to avoid. One
-- expression, two callers, no copy to drift.
DO $finish$
DECLARE
  v_missing TEXT;
  v_barrier TEXT;
  v_rows    BIGINT;
  v_path    TEXT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" does not exist at the end of this migration, so nothing was installed. Procedure: docs/RUNBOOK.md section B1.';
  END IF;

  -- The same `pg_catalog` pin sections 1 and 8 take, for the same reason: nothing judged below may
  -- depend on how a name happens to render under the caller's path.
  v_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog', true);

  -- The same ACCESS EXCLUSIVE lock the rest of the file takes: the proof below and the DROP that
  -- acts on it must see one world, and the drop needs the lock in any case.
  LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE;

  -- ┌── B1-SEAL-INVENTORY BEGIN ─────────────────────────────────────────────────────────────────
  -- THE WHOLE PHYSICAL-SEAL QUESTION, ASKED AS A SET EQUALITY, AND IT IS THE ONLY COPY.
  --
  -- `apps/api/src/activities/b1/b1-seals.ts` extracts the text between these markers and re-runs
  -- it verbatim on every production deploy. There is ONE inventory and both readers run it, so
  -- there is no second list to drift. Both callers pin `search_path = pg_catalog` first — section 9
  -- with `set_config(..., true)` inside this DO block, the verifier with `SET LOCAL` inside an
  -- explicit `$transaction` — because `pg_get_constraintdef`, `pg_get_indexdef` and
  -- `pg_get_triggerdef` RENDER RELATIVE TO THE SEARCH PATH. Unpinned they emit `REFERENCES
  -- "Membership"`; pinned they emit `REFERENCES public."Membership"`. Two callers on different
  -- paths would compare the same honest database against the same expected text and disagree.
  --
  -- WHY A SET EQUALITY AND NOT A LIST. Five rounds of this unit were spent lengthening lists — by
  -- name, then by definition, then by function body, then by column contract, then by persistence
  -- and volatility, then by enforcement state — and the sixth round found the SAME by-name defect
  -- again, inside the code written to fix the fifth. That is not carelessness about which attribute
  -- to check. A list is always potentially shorter than the set of things that can go wrong, so
  -- extending it once more only buys the next round.
  --
  -- So nothing here is a list of things to look for. Every object of every kind ATTACHED TO THIS
  -- TABLE is read out of the catalog, and the full actual set is compared against the full expected
  -- set with a FULL OUTER JOIN. A difference in EITHER DIRECTION is a refusal:
  --
  --     in expected, not in actual   -> MISSING     (the guard is not there)
  --     in actual, not in expected   -> UNEXPECTED  (something this file did not install is attached)
  --     in both, definitions differ  -> DIFFERS     (an impersonation: right name, wrong rule)
  --
  -- The DIFFERS leg is what closes the finding that a validated `CHECK (TRUE)` installed under
  -- `ActivityDependency_attribution_check` by a restore or catalog repair passed the old inventory,
  -- which asked only `conname` and `convalidated`. MEASURED before this change, on PostgreSQL
  -- 16.13: the hollow constraint was installed, `b1:seals` exited 0 reporting sealed, and an INSERT
  -- with a whitespace-only `createdByName` committed — after which the freeze and no-delete seals
  -- made that invalid attribution permanent. The definition is now part of the comparison, so the
  -- hollow constraint reads as DIFFERS and the barrier is not lifted.
  --
  -- The UNEXPECTED leg has no equivalent in the old inventory at all. An extra trigger, an extra
  -- index, an extra foreign key or an extra CHECK attached to this table by anything other than
  -- this file was previously invisible to every check in it.
  --
  -- WHERE SET EQUALITY IS NOT POSSIBLE, and why — the two exceptions, named rather than hidden:
  --
  --   THE INSTALL BARRIER.  `ActivityDependency_install_incomplete_check` is the one object whose
  --                         EXPECTED STATE DIFFERS BETWEEN THE TWO CALLERS: section 9 requires it
  --                         PRESENT (it is dropped a few lines below, as the last act of a proven
  --                         install), and the deploy verifier requires it ABSENT (its presence
  --                         afterwards means the install never finished). One shared expected set
  --                         cannot hold both, so it is excluded here by name and asserted
  --                         separately in each caller. It is excluded from BOTH sides, so it can
  --                         never be silently accepted as an unexpected object either.
  --   THE FUNCTION BODIES.  `prosrc` is compared against the `$body$ … $body$` literals THIS FILE
  --                         installs from — by sections 4 to 7 at install time and by
  --                         `b1-seals.ts` at deploy time, both reading the same single literals.
  --                         Embedding those bodies here as VALUES text would create a second copy
  --                         of exactly the thing that must not drift. What is set-compared here is
  --                         every other `pg_proc` property, and the SET OF FUNCTION NAMES: a sixth
  --                         `activity_dependency_*` function is UNEXPECTED and refused.
  SELECT string_agg(d.what, ', ' ORDER BY d.what) INTO v_missing FROM (
    WITH expected(kind, name, def) AS (VALUES
      ('column', 'id', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'projectId', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'predecessorId', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'successorId', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'lagWorkingDays', 'pg_catalog.int4 | notnull=true | default=0 | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'createdAt', 'pg_catalog.timestamp | notnull=true | default=CURRENT_TIMESTAMP | identity=none | generated=none | collation=default | typmod=3'),
      ('column', 'createdById', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'createdByName', 'pg_catalog.text | notnull=true | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'revokedAt', 'pg_catalog.timestamp | notnull=false | default=none | identity=none | generated=none | collation=default | typmod=3'),
      ('column', 'revokedById', 'pg_catalog.text | notnull=false | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('column', 'revokedByName', 'pg_catalog.text | notnull=false | default=none | identity=none | generated=none | collation=default | typmod=-1'),
      ('constraint', 'ActivityDependency_attribution_check', 'CHECK ((("createdById" !~ ''^[[:space:]]*$''::text) AND ("createdByName" !~ ''^[[:space:]]*$''::text))) | validated=true'),
      ('constraint', 'ActivityDependency_createdBy_fkey', 'FOREIGN KEY ("projectId", "createdById") REFERENCES public."Membership"("projectId", "userId") | validated=true'),
      ('constraint', 'ActivityDependency_lag_nonneg_check', 'CHECK (("lagWorkingDays" >= 0)) | validated=true'),
      ('constraint', 'ActivityDependency_no_self_check', 'CHECK (("predecessorId" <> "successorId")) | validated=true'),
      ('constraint', 'ActivityDependency_pkey', 'PRIMARY KEY (id) | validated=true'),
      ('constraint', 'ActivityDependency_projectId_fkey', 'FOREIGN KEY ("projectId") REFERENCES public."Project"(id) ON UPDATE CASCADE ON DELETE RESTRICT | validated=true'),
      ('constraint', 'ActivityDependency_projectId_predecessorId_fkey', 'FOREIGN KEY ("projectId", "predecessorId") REFERENCES public."Activity"("projectId", id) | validated=true'),
      ('constraint', 'ActivityDependency_projectId_successorId_fkey', 'FOREIGN KEY ("projectId", "successorId") REFERENCES public."Activity"("projectId", id) | validated=true'),
      ('constraint', 'ActivityDependency_revocation_check', 'CHECK (((("revokedAt" IS NULL) AND ("revokedById" IS NULL) AND ("revokedByName" IS NULL)) OR (("revokedAt" IS NOT NULL) AND ("revokedById" IS NOT NULL) AND ("revokedById" !~ ''^[[:space:]]*$''::text) AND ("revokedByName" IS NOT NULL) AND ("revokedByName" !~ ''^[[:space:]]*$''::text)))) | validated=true'),
      ('constraint', 'ActivityDependency_revokedBy_fkey', 'FOREIGN KEY ("projectId", "revokedById") REFERENCES public."Membership"("projectId", "userId") | validated=true'),
      ('index', 'ActivityDependency_pkey', 'CREATE UNIQUE INDEX "ActivityDependency_pkey" ON public."ActivityDependency" USING btree (id) | valid=true,ready=true,live=true'),
      ('index', 'ActivityDependency_projectId_predecessorId_idx', 'CREATE INDEX "ActivityDependency_projectId_predecessorId_idx" ON public."ActivityDependency" USING btree ("projectId", "predecessorId") | valid=true,ready=true,live=true'),
      ('index', 'ActivityDependency_projectId_successorId_idx', 'CREATE INDEX "ActivityDependency_projectId_successorId_idx" ON public."ActivityDependency" USING btree ("projectId", "successorId") | valid=true,ready=true,live=true'),
      ('index', 'ActivityDependency_projectId_successorId_predecessorId_key', 'CREATE UNIQUE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON public."ActivityDependency" USING btree ("projectId", "successorId", "predecessorId") WHERE ("revokedAt" IS NULL) | valid=true,ready=true,live=true'),
      ('trigger', 'ActivityDependency_acyclic', 'CREATE TRIGGER "ActivityDependency_acyclic" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_acyclic() | enabled=O | fn=public.activity_dependency_acyclic'),
      ('trigger', 'ActivityDependency_born_live', 'CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live() | enabled=O | fn=public.activity_dependency_born_live'),
      ('trigger', 'ActivityDependency_frozen', 'CREATE TRIGGER "ActivityDependency_frozen" BEFORE UPDATE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_frozen() | enabled=O | fn=public.activity_dependency_frozen'),
      ('trigger', 'ActivityDependency_no_delete', 'CREATE TRIGGER "ActivityDependency_no_delete" BEFORE DELETE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_no_delete() | enabled=O | fn=public.activity_dependency_no_delete'),
      ('trigger', 'ActivityDependency_no_truncate', 'CREATE TRIGGER "ActivityDependency_no_truncate" BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate() | enabled=O | fn=public.activity_dependency_no_truncate'),
      ('fk-enforcement', 'ActivityDependency_createdBy_fkey -> RI_FKey_check_ins type=5 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_createdBy_fkey -> RI_FKey_check_upd type=17 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_createdBy_fkey -> RI_FKey_noaction_del type=9 on public.Membership', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_createdBy_fkey -> RI_FKey_noaction_upd type=17 on public.Membership', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_fkey -> RI_FKey_cascade_upd type=17 on public.Project', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_fkey -> RI_FKey_check_ins type=5 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_fkey -> RI_FKey_check_upd type=17 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_fkey -> RI_FKey_restrict_del type=9 on public.Project', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_predecessorId_fkey -> RI_FKey_check_ins type=5 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_predecessorId_fkey -> RI_FKey_check_upd type=17 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_predecessorId_fkey -> RI_FKey_noaction_del type=9 on public.Activity', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_predecessorId_fkey -> RI_FKey_noaction_upd type=17 on public.Activity', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_successorId_fkey -> RI_FKey_check_ins type=5 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_successorId_fkey -> RI_FKey_check_upd type=17 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_successorId_fkey -> RI_FKey_noaction_del type=9 on public.Activity', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_projectId_successorId_fkey -> RI_FKey_noaction_upd type=17 on public.Activity', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_revokedBy_fkey -> RI_FKey_check_ins type=5 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_revokedBy_fkey -> RI_FKey_check_upd type=17 on public.ActivityDependency', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_revokedBy_fkey -> RI_FKey_noaction_del type=9 on public.Membership', 'enabled=O'),
      ('fk-enforcement', 'ActivityDependency_revokedBy_fkey -> RI_FKey_noaction_upd type=17 on public.Membership', 'enabled=O'),
      ('function', 'activity_dependency_acyclic', 'plpgsql/trigger/v/invoker/kind=f/setof=false/strict=false/leakproof=false/parallel=u/owner=table/{"search_path=pg_catalog, public"}'),
      ('function', 'activity_dependency_born_live', 'plpgsql/trigger/v/invoker/kind=f/setof=false/strict=false/leakproof=false/parallel=u/owner=table/{"search_path=pg_catalog, public"}'),
      ('function', 'activity_dependency_frozen', 'plpgsql/trigger/v/invoker/kind=f/setof=false/strict=false/leakproof=false/parallel=u/owner=table/{"search_path=pg_catalog, public"}'),
      ('function', 'activity_dependency_no_delete', 'plpgsql/trigger/v/invoker/kind=f/setof=false/strict=false/leakproof=false/parallel=u/owner=table/{"search_path=pg_catalog, public"}'),
      ('function', 'activity_dependency_no_truncate', 'plpgsql/trigger/v/invoker/kind=f/setof=false/strict=false/leakproof=false/parallel=u/owner=table/{"search_path=pg_catalog, public"}'),
      ('relation', 'public."ActivityDependency"', 'relkind=r | persistence=p | rls=false | inherits=false | inherited=false | rules=0')
    ), actual(kind, name, def) AS (
      SELECT 'column', a.attname::TEXT,
             tn.nspname::TEXT || '.' || t.typname::TEXT
          || ' | notnull=' || a.attnotnull::TEXT
          || ' | default=' || COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 'none')
          || ' | identity=' || COALESCE(NULLIF(a.attidentity::TEXT, ''), 'none')
          || ' | generated=' || COALESCE(NULLIF(a.attgenerated::TEXT, ''), 'none')
          || ' | collation=' || CASE WHEN a.attcollation = 0 OR a.attcollation = t.typcollation
                                     THEN 'default' ELSE a.attcollation::REGCOLLATION::TEXT END
          || ' | typmod=' || a.atttypmod::TEXT
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
        LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = pg_catalog.to_regclass('public."ActivityDependency"')
         AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint', c.conname::TEXT,
             pg_catalog.pg_get_constraintdef(c.oid) || ' | validated=' || c.convalidated::TEXT
        FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = pg_catalog.to_regclass('public."ActivityDependency"')
         AND c.conname <> 'ActivityDependency_install_incomplete_check'
      UNION ALL
      SELECT 'index', ci.relname::TEXT,
             pg_catalog.pg_get_indexdef(ci.oid) || ' | valid=' || ix.indisvalid::TEXT
          || ',ready=' || ix.indisready::TEXT || ',live=' || ix.indislive::TEXT
        FROM pg_catalog.pg_class ci
        JOIN pg_catalog.pg_index ix ON ix.indexrelid = ci.oid
       WHERE ix.indrelid = pg_catalog.to_regclass('public."ActivityDependency"')
      UNION ALL
      -- THE BOUND FUNCTION IS ASKED THROUGH `tgfoid`, NOT THROUGH THE RENDERED DEFINITION.
      -- `pg_get_triggerdef` deparses the function name relative to the search path; this file pins
      -- `pg_catalog` so it renders qualified, but a rendering is still a rendering. Resolving
      -- `tgfoid` through `pg_proc` names the function PostgreSQL will actually call, by OID, so a
      -- trigger bound to a same-named decoy in another schema fails this however it prints.
      SELECT 'trigger', tg.tgname::TEXT,
             pg_catalog.pg_get_triggerdef(tg.oid) || ' | enabled=' || tg.tgenabled::TEXT
          || ' | fn=' || fn.nspname::TEXT || '.' || fp.proname::TEXT
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_proc fp ON fp.oid = tg.tgfoid
        JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
       WHERE tg.tgrelid = pg_catalog.to_regclass('public."ActivityDependency"')
         AND NOT tg.tgisinternal
      UNION ALL
      -- The FK enforcement machinery, keyed on (constraint, function, event type, relation) and
      -- NOT on `tgname`: internal trigger names embed OIDs (`RI_ConstraintTrigger_c_25006`) and
      -- differ on every install, so a name-keyed set would report all twenty as both missing and
      -- unexpected on a healthy database. The key names the referential ACTION literally, so
      -- `RI_FKey_cascade_del` standing in for `RI_FKey_restrict_del` reads as a difference.
      SELECT 'fk-enforcement',
             c.conname::TEXT || ' -> ' || fp.proname::TEXT || ' type=' || tg.tgtype::TEXT
          || ' on ' || fn.nspname::TEXT || '.' || fr.relname::TEXT,
             'enabled=' || tg.tgenabled::TEXT
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_constraint c ON c.oid = tg.tgconstraint
        JOIN pg_catalog.pg_proc fp ON fp.oid = tg.tgfoid
        JOIN pg_catalog.pg_class fr ON fr.oid = tg.tgrelid
        JOIN pg_catalog.pg_namespace fn ON fn.oid = fr.relnamespace
       WHERE tg.tgisinternal
         AND c.conrelid = pg_catalog.to_regclass('public."ActivityDependency"')
      UNION ALL
      SELECT 'function', p.proname::TEXT,
             l.lanname::TEXT || '/' || pg_catalog.format_type(p.prorettype, NULL)
          || '/' || p.provolatile::TEXT
          || '/' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
          || '/kind=' || p.prokind::TEXT || '/setof=' || p.proretset::TEXT
          || '/strict=' || p.proisstrict::TEXT || '/leakproof=' || p.proleakproof::TEXT
          || '/parallel=' || p.proparallel::TEXT
          || '/owner=' || CASE WHEN p.proowner = (SELECT rc.relowner FROM pg_catalog.pg_class rc
                                                   WHERE rc.oid = pg_catalog.to_regclass('public."ActivityDependency"'))
                               THEN 'table' ELSE p.proowner::REGROLE::TEXT END
          || '/' || COALESCE(p.proconfig::TEXT, '{}')
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_language  l ON l.oid = p.prolang
       WHERE n.nspname = 'public' AND p.pronargs = 0
         AND p.proname LIKE 'activity\_dependency\_%'
      UNION ALL
      -- The RELATION ITSELF, and any REWRITE RULE on it. One row each, so they take part in the
      -- same equality: an UNLOGGED table (emptied by PostgreSQL after any crash), a partition, an
      -- inheritance parent, RLS, or a rule that rewrites statements before any trigger fires all
      -- read as a differing definition rather than needing their own bespoke branch.
      SELECT 'relation', 'public."ActivityDependency"',
             'relkind=' || c.relkind::TEXT || ' | persistence=' || c.relpersistence::TEXT
          || ' | rls=' || (c.relrowsecurity OR c.relforcerowsecurity)::TEXT
          || ' | inherits=' || EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid = c.oid)::TEXT
          || ' | inherited=' || EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhparent = c.oid)::TEXT
          || ' | rules=' || (SELECT COUNT(*)::TEXT FROM pg_catalog.pg_rewrite w
                              WHERE w.ev_class = c.oid AND w.rulename <> '_RETURN')
        FROM pg_catalog.pg_class c
       WHERE c.oid = pg_catalog.to_regclass('public."ActivityDependency"')
    )
    SELECT CASE
             WHEN a.name IS NULL
               THEN e.kind || ' "' || e.name || '" is MISSING (expected: ' || e.def || ')'
                    -- Index names are SCHEMA-scoped, not table-scoped, so `CREATE INDEX IF NOT
                    -- EXISTS` is silenced by a same-named index on ANOTHER relation and installs
                    -- nothing here. The set equality catches that as MISSING; this says WHERE the
                    -- name actually lives, so the refusal is actionable instead of baffling.
                    || CASE WHEN e.kind = 'index' THEN COALESCE(
                         (SELECT ' — note: an index of that name already exists in schema public on '
                                 || owner_ns.nspname || '."' || owner.relname || '", which silences '
                                 || 'the guarded CREATE for this table; rename or drop it deliberately'
                            FROM pg_catalog.pg_class ci2
                            JOIN pg_catalog.pg_namespace cns ON cns.oid = ci2.relnamespace
                            JOIN pg_catalog.pg_index ix2 ON ix2.indexrelid = ci2.oid
                            JOIN pg_catalog.pg_class owner ON owner.oid = ix2.indrelid
                            JOIN pg_catalog.pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
                           WHERE ci2.relname = e.name AND cns.nspname = 'public'
                           LIMIT 1), '')
                       ELSE '' END
             WHEN e.name IS NULL
               THEN a.kind || ' "' || a.name || '" is UNEXPECTED — this migration installs no such '
                    || 'object on this table (found: ' || a.def || ')'
             ELSE e.kind || ' "' || e.name || '" DIFFERS — expected [' || e.def
                    || '] but found [' || a.def || ']'
           END
           -- THE REPAIR, NAMED WITH THE DIAGNOSTIC. This file never silently repairs, so a refusal
           -- that does not say what to do is a refusal that costs the operator the round.
           || CASE COALESCE(e.kind, a.kind)
                WHEN 'fk-enforcement' THEN
                  ' [repair: ALTER TABLE public."ActivityDependency" ENABLE TRIGGER ALL re-enables a'
                  || ' DISABLED enforcement trigger; a MISSING trigger row needs the key dropped and'
                  || ' re-added, which revalidates it. Confirm what was written while it was'
                  || ' unenforced before re-running.]'
                WHEN 'function' THEN
                  ' [repair: the function is re-created by this file once the impostor is dropped;'
                  || ' DROP the trigger that binds it, then DROP FUNCTION, then re-run.]'
                ELSE '' END AS what
      FROM expected e
      FULL OUTER JOIN actual a ON a.kind = e.kind AND a.name = e.name
     WHERE e.def IS DISTINCT FROM a.def
  ) d;
  -- └── B1-SEAL-INVENTORY END ───────────────────────────────────────────────────────────────────

  IF v_missing IS NOT NULL THEN
    -- The ROW COUNT is named alongside the difference, because those are the two facts an operator
    -- needs together. Section 1 deferred this verdict rather than deciding it: a populated table
    -- whose install is COMPLETE is an ordinary replay and passes here, while a populated table that
    -- this file did not build is refused — and the refusal has to say both what is wrong AND that
    -- there are rows nobody has accounted for, or the operator repairs the objects and never asks
    -- where the rows came from.
    SELECT COUNT(*) INTO v_rows FROM public."ActivityDependency";
    RAISE EXCEPTION 'schedule B1: the install did not finish, so the write barrier stays and "ActivityDependency" remains unwritable. This migration completes its OWN install and will not be adopted onto a table built by anything else, so nothing here was repaired: the table holds % row(s), which this run neither adopted nor changed. Differences against what this migration installs: %. Procedure: docs/RUNBOOK.md section B1.',
      v_rows, v_missing;
  END IF;

  -- Proven. The table opens for business — and this is idempotent: a complete install that has
  -- been in service has no barrier left to drop, so a replay reaches here and does nothing.
  -- THE INSTALL BARRIER, BY DEFINITION, and it is asked HERE rather than inside the set equality
  -- above for the reason given there: it is the one object whose expected state differs between
  -- this caller and the deploy verifier, so one shared expected set cannot hold both. Excluding it
  -- from the set is what makes that possible — and excluding it without asking a question of its
  -- own would leave exactly the hole this file exists to refuse: a barrier of the right NAME with
  -- a hollowed body is not a barrier, and it is about to be dropped either way.
  --
  -- The definition matters twice over. `CHECK ("id" !~ '^')` is a REGEX, deliberately, and not
  -- `CHECK (false)`: a constant-false CHECK is visible to constraint exclusion, so under
  -- `constraint_exclusion = on` the planner can answer "no rows" for a scan of this table without
  -- reading it, and section 1's row count would then lie. And it is a CHECK rather than a trigger
  -- so that `session_replication_role = replica` cannot switch it off. A replacement that is
  -- constant-false, or NOT VALID, or attached under the same name by anything else, is refused.
  SELECT pg_get_constraintdef(k.oid) || ' | validated=' || k.convalidated::TEXT
    INTO v_barrier
    FROM pg_constraint k
   WHERE k.conrelid = to_regclass('public."ActivityDependency"')
     AND k.conname = 'ActivityDependency_install_incomplete_check';
  -- ABSENT is legitimate and is NOT an error here: on a replay over an install this file already
  -- finished, section 9 dropped the barrier on the earlier run and section 2's guarded CREATE does
  -- not put it back. That case is the ordinary no-op replay, and the set equality above has already
  -- proved the install it belongs to. What is refused is a barrier that is PRESENT and is not the
  -- one this file installs.
  IF v_barrier IS NOT NULL
     AND v_barrier <> 'CHECK ((id !~ ''^''::text)) | validated=true' THEN
    RAISE EXCEPTION 'schedule B1: the install barrier "ActivityDependency_install_incomplete_check" is present as %, which is not the write exclusion this install is held behind, so this run will not lift it and "ActivityDependency" stays unwritable. Expected: CHECK ((id !~ ''^''::text)) | validated=true. The regex form is deliberate — a constant-false CHECK is foldable by constraint exclusion, so the planner could answer "no rows" for this table without reading it — and a NOT VALID one judges nothing already present. Procedure: docs/RUNBOOK.md section B1.',
      v_barrier;
  END IF;

  ALTER TABLE public."ActivityDependency"
    DROP CONSTRAINT IF EXISTS "ActivityDependency_install_incomplete_check";

  PERFORM set_config('search_path', v_path, true);
END $finish$;

-- ── 10. Give the caller its search path back ──────────────────────────────────────────────────
-- The pin at the top of this file is a plain `SET`, not `SET LOCAL`, because LOCAL is inert
-- outside a transaction block and the autocommit caller is one this file must support — that
-- inertness is exactly how the foreign keys came to bind to a decoy schema. A plain `SET` is not
-- undone at COMMIT, so it is undone here instead, from the value stashed before it was changed.
-- Nothing leaks into the connection `prisma migrate deploy` goes on to use for the next migration.
--
-- An ABORTED run does not reach this line and does not need to: inside a transaction the SET is
-- rolled back with everything else, and in autocommit the run has already failed and its
-- connection is discarded.
SELECT set_config('search_path',
                  current_setting('vitan.schedule_b1_caller_search_path', true), false);
