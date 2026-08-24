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
-- THE SCHEMA IS PINNED TWICE, and the second pin is the load-bearing one.
--
-- Under a role whose search path names a per-user or temporary schema first, an unqualified CREATE
-- would build the whole graph somewhere else and commit successfully, while the application's
-- `public` schema still has no table — and section 1, which qualifies its lookups, would keep
-- reporting a fresh install forever. So EVERY object this file creates is written `public.`-
-- qualified, which makes the outcome independent of the caller's path.
--
-- `SET LOCAL search_path = public` stays as defence in depth for anything that resolves a name
-- this file does not qualify (the foreign-key targets), and because LOCAL cannot leak into the
-- connection the deploy goes on to use. It is only a WARNING outside a transaction block, not an
-- error — which is exactly why it cannot be the only pin.
SET LOCAL search_path = public;

-- ── 1. Resume this file's own install; refuse anything it did not install ─────────────────────
DO $$
DECLARE
  r          RECORD;
  v_owner    TEXT;
  v_existing TEXT;
  v_bad      TEXT;
  v_rows     BIGINT;
  v_wrong    TEXT;                 -- the FIRST thing that is present and WRONG: an abort either way
  v_missing  TEXT;                 -- what is simply ABSENT: an abort only when the table holds rows
  v_note     TEXT := '';           -- appended to whatever abort fires, so a refusal names the rows
  v_barrier  TEXT;
  v_rel      TEXT;
  v_path     TEXT;
BEGIN
  -- EVERY COMPARISON BELOW IS RENDERED BY POSTGRESQL RELATIVE TO THE READER'S SEARCH PATH, so
  -- without this pin the canonical texts printed in this file would only match under some callers.
  -- The case that matters is not cosmetic: `pg_get_constraintdef` prints a foreign-key target
  -- UNQUALIFIED whenever the target's schema is on the path, so a key bound to `b1decoy."Project"`
  -- reads as `REFERENCES "Project"(id)` to a caller whose path is `b1decoy, public` — identical to
  -- the canonical text, and accepted. Pinned to `pg_catalog` alone, nothing but `pg_catalog` is
  -- visible, every relation renders schema-qualified, and a decoy is textually distinguishable
  -- from the real target. Restored at the end of the block; LOCAL, so it cannot leak into the
  -- connection the deploy goes on to use.
  v_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog', true);
  -- ── 1a. Index NAMES, asked BEFORE anything else and asked whether or not the table exists ───
  -- An index name is unique per SCHEMA, not per table. Two consequences, and both are silent:
  -- section 3's `CREATE INDEX IF NOT EXISTS` skips on a name owned by ANOTHER relation, leaving
  -- this table without the index it reports having created; and a table-scoped definition lookup
  -- finds nothing, so the definition check below would call the same name absent. This file
  -- repairs what belongs to "ActivityDependency" and does not RECLAIM what does not, so a
  -- collision is data it cannot honestly interpret: it names both sides and stops.
  FOR r IN SELECT * FROM (VALUES
      ('ActivityDependency_projectId_successorId_predecessorId_key'),
      ('ActivityDependency_projectId_predecessorId_idx'),
      ('ActivityDependency_projectId_successorId_idx')
    ) AS i(name)
  LOOP
    SELECT c2.relname INTO v_owner
      FROM pg_class ci
      JOIN pg_namespace ns ON ns.oid = ci.relnamespace
      JOIN pg_index ix ON ix.indexrelid = ci.oid
      JOIN pg_class c2 ON c2.oid = ix.indrelid
     WHERE ci.relname = r.name AND ns.nspname = 'public'
       AND ix.indrelid IS DISTINCT FROM to_regclass('public."ActivityDependency"');
    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION 'schedule B1: an index named "%" already exists in schema public on table "%", not on "ActivityDependency". Index names are schema-scoped, so the guarded CREATE below would silently skip and leave this table unindexed — and this migration will not drop or reclaim an object it does not own. Rename or drop that index deliberately, then re-run.',
        r.name, v_owner;
    END IF;
  END LOOP;

  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    PERFORM set_config('search_path', v_path, true);
    RETURN;                        -- nothing installed yet; sections 2..8 install all of it
  END IF;

  -- ── 1a-bis. IS IT AN ORDINARY, PERMANENT TABLE? ─────────────────────────────────────────────
  -- Asked before anything else about the relation, and asked because the answer is invisible in
  -- every other check: an UNLOGGED table carries the same columns, the same constraints, the same
  -- indexes and the same triggers as a permanent one, so a shape comparison cannot tell them
  -- apart. What differs is the only property this table exists for. PostgreSQL TRUNCATES an
  -- unlogged relation after a crash or unclean shutdown — so an append-only register of who
  -- imposed and who withdrew each sequencing constraint would be silently emptied, by design,
  -- with every seal still armed and reporting success. That is the one failure this file must
  -- never certify: the DELETE and TRUNCATE seals exist precisely to make that erasure impossible.
  --
  -- `relkind` is asked too, and for the same reason: a VIEW, a foreign table or a partitioned
  -- parent of the right name would satisfy `to_regclass` and then take a completely different set
  -- of rules — and `LOCK TABLE` below is not even legal on some of them. Section 2 creates an
  -- ordinary permanent table (`CREATE TABLE` with no qualifier), so on this file's own partial
  -- apply the answer is always `r`/`p`; anything else was built by something else.
  SELECT c.relkind::TEXT || '/' || c.relpersistence::TEXT INTO v_rel
    FROM pg_class c WHERE c.oid = to_regclass('public."ActivityDependency"');
  IF v_rel IS DISTINCT FROM 'r/p' THEN
    PERFORM set_config('search_path', v_path, true);
    RAISE EXCEPTION 'schedule B1: public."ActivityDependency" exists but is not an ordinary permanent table (pg_class relkind/relpersistence = %, expected r/p). This migration creates a PERMANENT table because the rows are an append-only record of who imposed and who withdrew each sequencing constraint: PostgreSQL truncates an UNLOGGED relation after a crash or unclean shutdown, so installing these seals over one would certify a register that erases itself while every guard still reports success. A view, foreign table or partitioned relation of this name takes different rules again. Rename or drop it, or convert it with ALTER TABLE ... SET LOGGED, then re-run. Procedure: docs/RUNBOOK.md section B1.',
      v_rel;
  END IF;

  -- ── 1b. LOCK BEFORE LOOKING, and hold it to COMMIT ──────────────────────────────────────────
  -- Everything below reads a snapshot, and the objects that act on those reads are installed
  -- AFTERWARDS. Without this lock a concurrent session can write between the two: the row check
  -- passes on an empty table, an INSERT commits, and the seals go on top of a row no guard here
  -- ever judged. Installing a trigger validates nothing already in the table, so an unserialized
  -- inspection proves nothing about the table that ends up sealed.
  --
  -- ACCESS EXCLUSIVE, not a weaker mode: the writer to shut out is an ordinary INSERT, and only
  -- this mode conflicts with the ROW EXCLUSIVE lock an INSERT takes. PostgreSQL holds it until
  -- COMMIT, so the verification here and the objects installed after it see one another's world.
  -- Taken only when the table exists — `LOCK TABLE` on a missing relation is an error, and there
  -- is nothing to serialize against until section 2's CREATE takes the same lock itself.
  LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE;

  -- ── 1c. COUNT the rows here; decide what they MEAN at the end of this block ─────────────────
  -- ROWS ARE NOT EVIDENCE OF ANYTHING ON THEIR OWN, and an earlier head of this file treated them
  -- as if they were: it aborted on the first row it saw, before comparing a single object. That
  -- made the migration non-rerunnable over the one populated state it will actually meet — a
  -- FINISHED install that has been in service. Two populated tables need opposite answers:
  --
  --   COMPLETE — every object present and canonical and the install barrier already lifted — is
  --   the ordinary state of a deployed database. A replay over it must be a no-op, because a
  --   direct repair, a re-deploy, or `migrate resolve` followed by `migrate deploy` all land here.
  --   Nothing is installed, nothing is adopted: every guard below is a skip.
  --
  --   INCOMPLETE or FOREIGN is the dangerous one. Finishing it would arm seals over rows written
  --   under rules this file never judged — and creating a trigger validates nothing already in
  --   the table, so those rows would be certified by silence. That is refused, and the rows are
  --   left exactly as they were.
  --
  -- So the count is taken here and the verdict is deferred. Sections 1d to 1g record two different
  -- kinds of disagreement — WRONG (present with a definition this file did not install: an abort
  -- either way) and MISSING (absent: an abort only when the table holds rows) — and section 1h
  -- reads both once.
  SELECT COUNT(*) INTO v_rows FROM public."ActivityDependency";
  IF v_rows > 0 THEN
    v_note := format(' "ActivityDependency" already exists and holds %s row(s), which this run neither adopted nor changed.', v_rows);
  END IF;

  -- ── 1d. THE PHYSICAL COLUMN CONTRACT, not merely the column NAMES ───────────────────────────
  -- Section 2's `CREATE TABLE IF NOT EXISTS` skips its whole definition when the table is already
  -- there, so on the resume path every column's type, nullability and default come from whatever
  -- produced it — and a name test cannot tell a conforming column from a differently-shaped one
  -- of the same name. The consequence is not cosmetic: a NULLABLE `predecessorId` would be adopted
  -- silently and then accept a live edge with a null endpoint, because the composite foreign key
  -- is MATCH SIMPLE (a row with any NULL key column is not checked at all), the self-dependency
  -- CHECK evaluates to UNKNOWN and passes, and the reachability walk in section 7 matches no node.
  -- The table would hold an edge no guard here can see.
  --
  -- Each column is compared against the contract section 2 would have created: nullability, type,
  -- datetime precision and default. The comparison FAILS SAFE — anything other than an exact match
  -- aborts and names the disagreement, so a future PostgreSQL that renders `CURRENT_TIMESTAMP`
  -- differently costs a refusal an operator can read, never a silent adoption.
  SELECT string_agg(w.c || ' (' || w.detail || ')', ', ' ORDER BY w.c) INTO v_bad FROM (
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
  IF v_bad IS NOT NULL THEN
    v_wrong := COALESCE(v_wrong, format('"ActivityDependency" exists but does not match the column contract this migration installs and reasons about: %s. This is not this migration''s partial apply, and nothing honest can be said about it. Repair those columns, or — if it is not the dependency graph — rename or drop that table, then re-run.', v_bad));
  END IF;

  -- ── 1e. The PRIMARY KEY, the four CHECKs and the five composite keys ────────────────────────
  -- Section 2 declares all ten INLINE, so `CREATE TABLE` installs them ATOMICALLY with the table:
  -- on this file's own partial apply, a table that exists has every one of them. That is why
  -- ABSENT is refused here rather than repaired — a table missing a CHECK is a table something
  -- else built, most plausibly a `db push` or baseline reconciliation, which produces the columns
  -- and the modelled keys and NONE of the CHECKs. Adding them would be adoption: this file would
  -- be certifying rules over a shape and a history it never observed.
  --
  -- DIFFERENT is refused for the reason a name test cannot see: `pg_get_constraintdef` is how
  -- PostgreSQL itself deparses the rule, and `convalidated` is the difference between a rule that
  -- judges the table and a `NOT VALID` one that judges only what arrives next. Both sides of the
  -- disagreement are printed, because "it differs" is not something an operator can act on.
  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_pkey',
       'PRIMARY KEY (id)'),
      ('ActivityDependency_attribution_check',
       'CHECK ((("createdById" !~ ''^[[:space:]]*$''::text) AND ("createdByName" !~ ''^[[:space:]]*$''::text)))'),
      ('ActivityDependency_revocation_check',
       'CHECK (((("revokedAt" IS NULL) AND ("revokedById" IS NULL) AND ("revokedByName" IS NULL)) OR (("revokedAt" IS NOT NULL) AND ("revokedById" IS NOT NULL) AND ("revokedById" !~ ''^[[:space:]]*$''::text) AND ("revokedByName" IS NOT NULL) AND ("revokedByName" !~ ''^[[:space:]]*$''::text))))'),
      ('ActivityDependency_no_self_check',
       'CHECK (("predecessorId" <> "successorId"))'),
      ('ActivityDependency_lag_nonneg_check',
       'CHECK (("lagWorkingDays" >= 0))'),
      ('ActivityDependency_projectId_fkey',
       'FOREIGN KEY ("projectId") REFERENCES public."Project"(id) ON UPDATE CASCADE ON DELETE RESTRICT'),
      ('ActivityDependency_projectId_predecessorId_fkey',
       'FOREIGN KEY ("projectId", "predecessorId") REFERENCES public."Activity"("projectId", id)'),
      ('ActivityDependency_projectId_successorId_fkey',
       'FOREIGN KEY ("projectId", "successorId") REFERENCES public."Activity"("projectId", id)'),
      ('ActivityDependency_createdBy_fkey',
       'FOREIGN KEY ("projectId", "createdById") REFERENCES public."Membership"("projectId", "userId")'),
      ('ActivityDependency_revokedBy_fkey',
       'FOREIGN KEY ("projectId", "revokedById") REFERENCES public."Membership"("projectId", "userId")')
    ) AS c(name, canonical)
  LOOP
    SELECT regexp_replace(pg_get_constraintdef(k.oid), '[[:space:]]+', ' ', 'g')
           || CASE WHEN k.convalidated THEN '' ELSE ' [NOT VALID]' END
      INTO v_existing
      FROM pg_constraint k
     WHERE k.conname = r.name
       AND k.conrelid = 'public."ActivityDependency"'::regclass;

    CONTINUE WHEN v_existing IS NOT NULL
             AND v_existing = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g');

    v_wrong := COALESCE(v_wrong, format('"ActivityDependency" exists but its constraint "%s" is %s. This migration declares that constraint INLINE with the table, so its own partial apply always carries it — a table without it, or with a different one, was built by something else and will not be adopted. Expected: %s.',
      r.name,
      COALESCE('present as ' || v_existing, 'ABSENT'),
      regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g')));
    EXIT;
  END LOOP;

  -- ── 1f. Indexes that ARE there must be the ones this file installs ──────────────────────────
  -- Unlike the constraints above, the three indexes are separate statements, so this file's own
  -- partial apply CAN legitimately be missing them — absent is the resumable case and section 3
  -- creates them. What must not pass is a same-named index on this table with a different
  -- definition, because section 3's `IF NOT EXISTS` matches on the NAME and would skip it: a plain
  -- non-unique index called `..._key`, a unique index WITHOUT the partial predicate, or one left
  -- `indisvalid = false` by a failed concurrent build each leaves the ordered pair unconstrained
  -- forever while this file reports success. `pg_get_indexdef` renders UNIQUE, the columns and the
  -- WHERE predicate; `indisvalid` is not in that text and is asked separately.
  FOR r IN
    SELECT * FROM (VALUES
      ('ActivityDependency_projectId_successorId_predecessorId_key',
       'CREATE UNIQUE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON public."ActivityDependency" USING btree ("projectId", "successorId", "predecessorId") WHERE ("revokedAt" IS NULL)'),
      ('ActivityDependency_projectId_predecessorId_idx',
       'CREATE INDEX "ActivityDependency_projectId_predecessorId_idx" ON public."ActivityDependency" USING btree ("projectId", "predecessorId")'),
      ('ActivityDependency_projectId_successorId_idx',
       'CREATE INDEX "ActivityDependency_projectId_successorId_idx" ON public."ActivityDependency" USING btree ("projectId", "successorId")')
    ) AS i(name, canonical)
  LOOP
    SELECT regexp_replace(pg_get_indexdef(ci.oid), '[[:space:]]+', ' ', 'g')
           || CASE WHEN ix.indisvalid THEN '' ELSE ' [INVALID]' END
      INTO v_existing
      FROM pg_class ci
      JOIN pg_namespace ns ON ns.oid = ci.relnamespace
      JOIN pg_index ix ON ix.indexrelid = ci.oid
     WHERE ci.relname = r.name AND ns.nspname = 'public'
       AND ix.indrelid = 'public."ActivityDependency"'::regclass;

    IF v_existing IS NULL THEN                            -- absent: section 3 creates it
      v_missing := COALESCE(v_missing || ', ', '') || format('index "%s"', r.name);
      CONTINUE;
    END IF;
    CONTINUE WHEN v_existing = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g');

    v_wrong := COALESCE(v_wrong, format('index "%s" exists on "ActivityDependency" with a definition this migration did not install, and the guarded CREATE below matches on the name alone — so it would be skipped and the rule left absent. Found: %s. Expected: %s.',
      r.name, v_existing, regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g')));
    EXIT;
  END LOOP;

  -- ── 1g. Are the five functions, the five seals and the barrier where a FINISHED install
  --        leaves them? PRESENCE only, and deliberately ────────────────────────────────────────
  -- Each DEFINITION is compared where it is WRITTEN (sections 4 to 8), because a function body
  -- exists exactly once in this file and a second copy here would be a copy that can drift. The
  -- question this section asks is a different one — IS THIS INSTALL FINISHED? — and presence
  -- answers it. A present-but-forged object is still refused, one section later, and refused
  -- BEFORE anything is installed over it, so permitting rows here never adopts a forgery.
  FOR r IN SELECT * FROM (VALUES
      ('activity_dependency_born_live'), ('activity_dependency_no_delete'),
      ('activity_dependency_no_truncate'), ('activity_dependency_frozen'),
      ('activity_dependency_acyclic')) AS f(name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = r.name AND p.pronargs = 0) THEN
      v_missing := COALESCE(v_missing || ', ', '') || format('function public.%s()', r.name);
    END IF;
  END LOOP;

  -- ARMED, not merely present: `tgenabled = 'O'` is the difference between a seal and a trigger
  -- that fires for nobody, and BOUND TO THE FUNCTION IN `public`, which is not the same question
  -- as "a trigger of that name exists" — `CREATE TRIGGER` resolves an unqualified function through
  -- the CALLER's search path, so a decoy in an earlier schema produces a trigger that reads as
  -- installed and enforces nothing.
  FOR r IN SELECT * FROM (VALUES
      ('ActivityDependency_born_live',    'activity_dependency_born_live'),
      ('ActivityDependency_no_delete',    'activity_dependency_no_delete'),
      ('ActivityDependency_no_truncate',  'activity_dependency_no_truncate'),
      ('ActivityDependency_frozen',       'activity_dependency_frozen'),
      ('ActivityDependency_acyclic',      'activity_dependency_acyclic')) AS t(name, fn)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
                      AND g.tgname = r.name AND NOT g.tgisinternal AND g.tgenabled = 'O'
                      AND g.tgfoid = to_regprocedure('public.' || r.fn || '()')) THEN
      v_missing := COALESCE(v_missing || ', ', '')
                || format('armed trigger "%s" bound to public.%s()', r.name, r.fn);
    END IF;
  END LOOP;

  -- THE INSTALL BARRIER is section 2's proof that an unfinished install cannot be written at all.
  -- While it stands every INSERT is refused, so a table still carrying it CANNOT have acquired a
  -- row after it was created; section 9 lifts it only once every seal is armed. Its presence
  -- therefore MEANS "this install has not finished", and its absence — with nothing missing above
  -- — means "this install finished".
  SELECT pg_get_constraintdef(k.oid) INTO v_barrier
    FROM pg_constraint k
   WHERE k.conname = 'ActivityDependency_install_incomplete_check'
     AND k.conrelid = 'public."ActivityDependency"'::regclass;
  IF v_barrier IS NOT NULL THEN
    v_missing := COALESCE(v_missing || ', ', '') || 'the install barrier is still in place';
  END IF;

  -- ── 1h. ONE verdict, read from both records ─────────────────────────────────────────────────
  -- MISSING alone is the resume path and is not an error: sections 2 to 9 install exactly what is
  -- absent. MISSING plus ROWS is the refusal, because there is no honest way to seal rows this
  -- file never judged. WRONG is a refusal either way, and it wins the message when both hold —
  -- "the constraint is a hollow CHECK (TRUE)" is more actionable than "the table has rows".
  IF v_wrong IS NULL AND v_missing IS NOT NULL AND v_rows > 0 THEN
    v_wrong := format('"ActivityDependency" holds rows and its installation is INCOMPLETE: %s. A COMPLETE install may be replayed as often as you like — that is the ordinary state of a deployed database and this file is a no-op over it. An INCOMPLETE or foreign populated table is refused rather than finished, because arming a seal validates nothing already in the table, so those rows would be certified by silence.', v_missing);
  END IF;
  PERFORM set_config('search_path', v_path, true);
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: % Procedure: docs/RUNBOOK.md section B1.', v_wrong || v_note;
  END IF;
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
-- section 1e treat an ABSENT CHECK as proof that some other tool built this table.
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
  -- "no rows" for a scan of this table without reading it — which would make section 1c's own row
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
  -- THE TARGETS ARE `public.`-QUALIFIED, and that is load-bearing rather than tidy. A foreign key
  -- resolves its target through the CALLER's search path at CREATE time, and `SET LOCAL
  -- search_path` at the top of this file is only a WARNING outside a transaction block — so under
  -- the autocommit caller this file must support, a role whose path names another schema first
  -- would bind all five keys to same-named DECOY tables there. Containment would then be a key
  -- that proves nothing: an edge could name any project, any activity, any user, and PostgreSQL
  -- would accept it. Worse, the check in section 1e could not see it, because
  -- `pg_get_constraintdef` renders the target relative to the READER's path too — which is why
  -- section 1 pins its own path to `pg_catalog` and compares fully-qualified text.
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
-- install by the `CREATE TABLE` above, on a resume by section 1b — and PostgreSQL holds it until
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
-- `IF NOT EXISTS` matches on the NAME alone; section 1a proved no other relation owns any of
-- these names, and section 1f proved that any index of these names ON THIS TABLE is the one
-- printed here. Past those two, the name is a safe stand-in for the definition.
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
-- Signature, language, VOLATILITY and `search_path` travel with it, because a body of the right
-- shape attached to the wrong return type, with the search-path pin removed, or re-declared
-- STABLE, is a different function. Volatility is the one that is invisible in the source text and
-- decisive at runtime: PostgreSQL gives a STABLE or IMMUTABLE function the CALLING STATEMENT's
-- snapshot, so a same-bodied `..._acyclic` declared STABLE would read the graph as it stood before
-- it began waiting on the project lock — miss the edge the session it was waiting for had just
-- committed, and let the cycle in. `ALTER FUNCTION ... STABLE` changes nothing else, which is why
-- `provolatile` has to be part of the identity rather than assumed from the CREATE below.
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
  v_want := 'plpgsql/trigger/v/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL) || '/'
         || p.provolatile::TEXT || '/'
         || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
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
-- Signature, language, VOLATILITY and `search_path` travel with it, because a body of the right
-- shape attached to the wrong return type, with the search-path pin removed, or re-declared
-- STABLE, is a different function. Volatility is the one that is invisible in the source text and
-- decisive at runtime: PostgreSQL gives a STABLE or IMMUTABLE function the CALLING STATEMENT's
-- snapshot, so a same-bodied `..._acyclic` declared STABLE would read the graph as it stood before
-- it began waiting on the project lock — miss the edge the session it was waiting for had just
-- committed, and let the cycle in. `ALTER FUNCTION ... STABLE` changes nothing else, which is why
-- `provolatile` has to be part of the identity rather than assumed from the CREATE below.
DO $install$
DECLARE
  v_body TEXT := $body$
BEGIN
  RAISE EXCEPTION 'schedule: dependency edge % is not deletable — who imposed this sequencing constraint, and who withdrew it, are both part of the record. Revoke it instead (set revokedAt/revokedById/revokedByName).', OLD."id";
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/v/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL) || '/'
         || p.provolatile::TEXT || '/'
         || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
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
-- Signature, language, VOLATILITY and `search_path` travel with it, because a body of the right
-- shape attached to the wrong return type, with the search-path pin removed, or re-declared
-- STABLE, is a different function. Volatility is the one that is invisible in the source text and
-- decisive at runtime: PostgreSQL gives a STABLE or IMMUTABLE function the CALLING STATEMENT's
-- snapshot, so a same-bodied `..._acyclic` declared STABLE would read the graph as it stood before
-- it began waiting on the project lock — miss the edge the session it was waiting for had just
-- committed, and let the cycle in. `ALTER FUNCTION ... STABLE` changes nothing else, which is why
-- `provolatile` has to be part of the identity rather than assumed from the CREATE below.
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
  -- Race-free: TRUNCATE takes an ACCESS EXCLUSIVE lock on the table BEFORE firing this trigger, so
  -- no concurrent transaction can insert the first edge between this test and the erasure.
  IF NOT EXISTS (SELECT 1 FROM public."ActivityDependency") THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'schedule: "ActivityDependency" holds the sequencing record — who imposed each constraint and who withdrew it — and is never truncated. Revoke edges individually; a sanctioned destructive reset disables "ActivityDependency_no_truncate" by name for the duration of the reset.';
END $body$;
  v_want TEXT;
  v_found TEXT;
BEGIN
  v_want := 'plpgsql/trigger/v/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL) || '/'
         || p.provolatile::TEXT || '/'
         || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
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
-- Signature, language, VOLATILITY and `search_path` travel with it, because a body of the right
-- shape attached to the wrong return type, with the search-path pin removed, or re-declared
-- STABLE, is a different function. Volatility is the one that is invisible in the source text and
-- decisive at runtime: PostgreSQL gives a STABLE or IMMUTABLE function the CALLING STATEMENT's
-- snapshot, so a same-bodied `..._acyclic` declared STABLE would read the graph as it stood before
-- it began waiting on the project lock — miss the edge the session it was waiting for had just
-- committed, and let the cycle in. `ALTER FUNCTION ... STABLE` changes nothing else, which is why
-- `provolatile` has to be part of the identity rather than assumed from the CREATE below.
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
  v_want := 'plpgsql/trigger/v/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL) || '/'
         || p.provolatile::TEXT || '/'
         || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
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
-- Signature, language, VOLATILITY and `search_path` travel with it, because a body of the right
-- shape attached to the wrong return type, with the search-path pin removed, or re-declared
-- STABLE, is a different function. Volatility is the one that is invisible in the source text and
-- decisive at runtime: PostgreSQL gives a STABLE or IMMUTABLE function the CALLING STATEMENT's
-- snapshot, so a same-bodied `..._acyclic` declared STABLE would read the graph as it stood before
-- it began waiting on the project lock — miss the edge the session it was waiting for had just
-- committed, and let the cycle in. `ALTER FUNCTION ... STABLE` changes nothing else, which is why
-- `provolatile` has to be part of the identity rather than assumed from the CREATE below.
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
  v_want := 'plpgsql/trigger/v/{"search_path=pg_catalog, public"}' || v_body;
  SELECT l.lanname || '/' || pg_catalog.format_type(p.prorettype, NULL) || '/'
         || p.provolatile::TEXT || '/'
         || COALESCE(p.proconfig::TEXT, '{}') || p.prosrc
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
      ('ActivityDependency_born_live',
       'CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live()',
       'CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live()'),
      ('ActivityDependency_no_delete',
       'CREATE TRIGGER "ActivityDependency_no_delete" BEFORE DELETE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_no_delete()',
       'CREATE TRIGGER "ActivityDependency_no_delete" BEFORE DELETE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_no_delete()'),
      ('ActivityDependency_no_truncate',
       'CREATE TRIGGER "ActivityDependency_no_truncate" BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate()',
       'CREATE TRIGGER "ActivityDependency_no_truncate" BEFORE TRUNCATE ON public."ActivityDependency" FOR EACH STATEMENT EXECUTE FUNCTION public.activity_dependency_no_truncate()'),
      ('ActivityDependency_frozen',
       'CREATE TRIGGER "ActivityDependency_frozen" BEFORE UPDATE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_frozen()',
       'CREATE TRIGGER "ActivityDependency_frozen" BEFORE UPDATE ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_frozen()'),
      ('ActivityDependency_acyclic',
       'CREATE TRIGGER "ActivityDependency_acyclic" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_acyclic()',
       'CREATE TRIGGER "ActivityDependency_acyclic" BEFORE INSERT ON public."ActivityDependency" FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_acyclic()')
    ) AS t(name, ddl, canonical)
  LOOP
    SELECT regexp_replace(pg_get_triggerdef(g.oid), '[[:space:]]+', ' ', 'g'),
           g.tgenabled::TEXT, g.tgfoid::REGPROCEDURE::TEXT
      INTO v_def, v_enabled, v_foid
      FROM pg_trigger g
     WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
       AND g.tgname = r.name AND NOT g.tgisinternal;

    IF v_def IS NULL THEN
      EXECUTE r.ddl;                                       -- absent: this is the resumable case
      -- AND RE-READ IT. What was just created is not assumed to be what was just asked for; the
      -- comparison below runs over the trigger that actually exists, so a binding that resolved
      -- somewhere other than `public` is caught on the run that made it rather than on the next.
      SELECT regexp_replace(pg_get_triggerdef(g.oid), '[[:space:]]+', ' ', 'g'),
             g.tgenabled::TEXT, g.tgfoid::REGPROCEDURE::TEXT
        INTO v_def, v_enabled, v_foid
        FROM pg_trigger g
       WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
         AND g.tgname = r.name AND NOT g.tgisinternal;
    END IF;

    CONTINUE WHEN v_def = regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g')
             AND v_enabled = 'O';

    RAISE EXCEPTION 'schedule B1: trigger "%" already exists on "ActivityDependency" with a definition this migration did not install, and it will not be adopted or overwritten. Found: % (tgenabled=%, function %). Expected: % (tgenabled=O). Procedure: docs/RUNBOOK.md section B1.',
      r.name, v_def, v_enabled, v_foid, regexp_replace(r.canonical, '[[:space:]]+', ' ', 'g');
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
-- the whole question once, over the objects that now exist:
--
--   * the ten constraints `CREATE TABLE` declares inline, each VALIDATED — and the five
--     containment keys asked, through `confrelid`, WHICH relation they actually reference;
--   * the three indexes, each `indisvalid`;
--   * the five functions in `public`, each VOLATILE — a STABLE one would read the graph from the
--     calling statement's snapshot and could miss an edge committed while it waited on the lock;
--   * the relation still an ordinary PERMANENT table, since an UNLOGGED one is truncated by
--     PostgreSQL after an unclean shutdown and this register may not erase itself;
--   * the five triggers, ENABLED, and — asked against `tgfoid` rather than against any rendered
--     text — bound to the function in `public` and to no other. A trigger created under a caller
--     path naming a same-named decoy first would satisfy every name test and fail this one.
--
-- If anything is missing the barrier STAYS, and the table stays unwritable. An operator gets a
-- refusal naming exactly what is absent, and a database that cannot be half-sealed in the interim.
DO $finish$
DECLARE
  v_missing TEXT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN
    RAISE EXCEPTION 'schedule B1: "ActivityDependency" does not exist at the end of this migration, so nothing was installed. Procedure: docs/RUNBOOK.md section B1.';
  END IF;

  -- The same ACCESS EXCLUSIVE lock the rest of the file takes: the proof below and the DROP that
  -- acts on it must see one world, and the drop needs the lock in any case.
  LOCK TABLE public."ActivityDependency" IN ACCESS EXCLUSIVE MODE;

  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO v_missing FROM (
    SELECT 'constraint "' || c.name || '"' AS what
      FROM (VALUES
        ('ActivityDependency_pkey'), ('ActivityDependency_attribution_check'),
        ('ActivityDependency_revocation_check'), ('ActivityDependency_no_self_check'),
        ('ActivityDependency_lag_nonneg_check')) AS c(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k
                        WHERE k.conname = c.name AND k.convalidated
                          AND k.conrelid = 'public."ActivityDependency"'::regclass)
    UNION ALL
    -- The five containment keys are asked a second question: WHICH RELATION do they point at?
    -- `confrelid` is the binding itself, so unlike any rendered text it cannot read one way to one
    -- caller and another way to the next. A key bound to a same-named decoy in another schema
    -- satisfies every name test and fails here.
    SELECT 'constraint "' || f.name || '" referencing public."' || f.target || '"'
      FROM (VALUES
        ('ActivityDependency_projectId_fkey',                'Project'),
        ('ActivityDependency_projectId_predecessorId_fkey',  'Activity'),
        ('ActivityDependency_projectId_successorId_fkey',    'Activity'),
        ('ActivityDependency_createdBy_fkey',                'Membership'),
        ('ActivityDependency_revokedBy_fkey',                'Membership')) AS f(name, target)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k
                        WHERE k.conname = f.name AND k.convalidated
                          AND k.conrelid = 'public."ActivityDependency"'::regclass
                          AND k.confrelid = to_regclass('public."' || f.target || '"'))
    UNION ALL
    SELECT 'index "' || i.name || '"'
      FROM (VALUES
        ('ActivityDependency_projectId_successorId_predecessorId_key'),
        ('ActivityDependency_projectId_predecessorId_idx'),
        ('ActivityDependency_projectId_successorId_idx')) AS i(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_class ci
                         JOIN pg_namespace ns ON ns.oid = ci.relnamespace
                         JOIN pg_index ix ON ix.indexrelid = ci.oid
                        WHERE ci.relname = i.name AND ns.nspname = 'public' AND ix.indisvalid
                          AND ix.indrelid = 'public."ActivityDependency"'::regclass)
    UNION ALL
    SELECT 'function public.' || f.name || '()'
      FROM (VALUES
        ('activity_dependency_born_live'), ('activity_dependency_no_delete'),
        ('activity_dependency_no_truncate'), ('activity_dependency_frozen'),
        ('activity_dependency_acyclic')) AS f(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = f.name AND p.pronargs = 0
                          AND p.provolatile = 'v')
    UNION ALL
    SELECT 'an ordinary permanent table (found relkind/relpersistence '
             || c.relkind::TEXT || '/' || c.relpersistence::TEXT || ')'
      FROM pg_class c
     WHERE c.oid = to_regclass('public."ActivityDependency"')
       AND (c.relkind <> 'r' OR c.relpersistence <> 'p')
    UNION ALL
    SELECT 'armed trigger "' || t.name || '" bound to public.' || t.fn || '()'
      FROM (VALUES
        ('ActivityDependency_born_live',   'activity_dependency_born_live'),
        ('ActivityDependency_no_delete',   'activity_dependency_no_delete'),
        ('ActivityDependency_no_truncate', 'activity_dependency_no_truncate'),
        ('ActivityDependency_frozen',      'activity_dependency_frozen'),
        ('ActivityDependency_acyclic',     'activity_dependency_acyclic')) AS t(name, fn)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                        WHERE g.tgrelid = 'public."ActivityDependency"'::regclass
                          AND g.tgname = t.name AND NOT g.tgisinternal AND g.tgenabled = 'O'
                          AND g.tgfoid = to_regprocedure('public.' || t.fn || '()'))
  ) x;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'schedule B1: the install did not finish, so the write barrier stays and "ActivityDependency" remains unwritable. Missing or not bound to public: %. Procedure: docs/RUNBOOK.md section B1.',
      v_missing;
  END IF;

  -- Proven. The table opens for business — and this is idempotent: a complete install that has
  -- been in service has no barrier left to drop, so a replay reaches here and does nothing.
  ALTER TABLE public."ActivityDependency"
    DROP CONSTRAINT IF EXISTS "ActivityDependency_install_incomplete_check";
END $finish$;
