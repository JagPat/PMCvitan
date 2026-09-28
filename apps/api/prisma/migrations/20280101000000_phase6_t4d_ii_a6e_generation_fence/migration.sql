-- Phase 6 task 4d unit 4d-ii-a / A6e — the SERVER-GENERATION FENCE (the staging document
-- `2026-09-26-4d-ii-a-additive-units.md`, "The drain": "Every build compiles a monotone server
-- generation. At startup, a process reads the persisted minimum, written only by migrations, and
-- refuses to start when that minimum is greater than its own generation. A6's migration sets the
-- minimum to A6's generation, so nothing running is refused. A8b raises it.").
--
-- WHY A SECOND FENCE (#640 Codex finding 4110816159). §D makes the drain durable by bumping the
-- consumer contract versions, which `syncConsumerCatalog` compares at startup, so a restarted or
-- rolled-back older process is refused. Under the additive staging those bumps land in A7, before
-- A8a and A8b, so they alone would still admit an A7 image restarted after A8b: a server that lacks
-- the four commands and their effects, reachable once 4d-iii retires the doors. The generation is
-- NOT a consumer contract version — only A7 changes those — it is the release lineage itself, an
-- integer every build compiles (`src/platform/server-generation.ts`, `SERVER_GENERATION`) and every
-- migration that must refuse older builds raises here. The check has to be compiled into every
-- build it must refuse, which is why it ships in A6 and not in A8b: a check first shipped in A8b
-- could not stop an A7 image, which would not contain it. Builds older than A6 carry no check, and
-- they are also older than A7, so A7's contract bumps refuse them; between the two fences every
-- build older than A8b is refused.
--
-- WHAT THIS FILE INSTALLS:
--   · `ServerGeneration`, a SINGLETON register (`key = 'singleton'`): the persisted minimum, the
--     migration that last raised it and when. A `schema.prisma` model, so a `db push` baseline
--     creates the table; everything else here is raw and on `ALWAYS_EXECUTE`.
--   · `ServerGeneration_t4d_raised` (BEFORE INSERT OR UPDATE): the minimum is ONLY EVER RAISED — a
--     lower value is refused whoever writes it, a migration included — and it is WRITTEN ONLY BY A
--     MIGRATION: the row is admitted only while `platform_t4d_server_generation_migration_open()`
--     exists AND was created by the current transaction (A6c's DDL transition, #661's review round
--     1, finding 1: a transaction-local setting is ordinary session state any DML writer can set
--     first; a function is DDL, which a DML-only writer cannot create, and one created by another
--     session is invisible here until committed, at which point it is no longer in progress). A
--     RAISE MUST RECORD ITS OWN PROVENANCE (#663's review round 1, finding 1): a new `raisedBy` and a
--     later `raisedAt`, or the row would attribute the raised fence to the migration that last
--     raised it, and every startup refusal and DRAIN-EVIDENCE would report that stale provenance. An
--     UPDATE that raises nothing may rewrite neither: the evidence of the last raise stands.
--   · THE READ IS SERIALIZED WITH THE RAISE (#663's review round 1, finding 2). A process reads the
--     row `FOR SHARE` inside a transaction it holds until it SERVES (its lease registered), so a
--     raise — whose UPDATE takes the row FOR NO KEY UPDATE, which conflicts with FOR SHARE — cannot
--     commit between a process's admission and its serving: it waits for every process in that
--     window, and every process that starts after it reads the raised minimum and is refused. A
--     plain READ COMMITTED select would have let an older image read the old minimum, have the raise
--     commit under it, and go on to serve.
--   · `ServerGeneration_t4d_retained` (BEFORE DELETE) and `ServerGeneration_t4d_no_truncate`
--     (BEFORE TRUNCATE): the minimum, once persisted, is never removed — a process reading no row
--     is refused (the fence fails closed on an absent minimum), and a removed row would be the one
--     way to "lower" it.
--   · THE RAISE: inside the transition, `INSERT ... ON CONFLICT DO UPDATE SET "minimumGeneration" =
--     GREATEST(existing, this file's)`, so re-running this file after A8b's cannot undo A8b's fence
--     (the staging document, "Every migration an A-unit ships"). This file's literal is 1, A6e's
--     generation; `server-generation.test.ts` pins the compiled constant to it.
--
-- RE-RUNNABLE (it is on `ALWAYS_EXECUTE`): `CREATE TABLE IF NOT EXISTS`, guarded constraints,
-- `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`, and a raise
-- that is a no-op when the persisted minimum is already at or above this file's.

-- ── 1. the register ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ServerGeneration" (
    "key"               TEXT NOT NULL,
    -- the lowest compiled `SERVER_GENERATION` a process may start with; only ever raised
    "minimumGeneration" INTEGER NOT NULL,
    -- the migration that last raised it — a name from `prisma/migrations`, evidence not a setting
    "raisedBy"          TEXT NOT NULL,
    "raisedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServerGeneration_pkey" PRIMARY KEY ("key")
);
DO $$ BEGIN
  ALTER TABLE "ServerGeneration" ADD CONSTRAINT "ServerGeneration_singleton_check"
    CHECK ("key" = 'singleton');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- generation 0 is no build: the first fenced build compiles 1, and a minimum below it would
  -- admit a process claiming to be older than any fenced release
  ALTER TABLE "ServerGeneration" ADD CONSTRAINT "ServerGeneration_minimumGeneration_check"
    CHECK ("minimumGeneration" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ServerGeneration" ADD CONSTRAINT "ServerGeneration_raisedBy_nonblank_check"
    CHECK (btrim("raisedBy", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. the raise seal: ServerGeneration_t4d_raised (BEFORE INSERT OR UPDATE) ─────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_server_generation_raised() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  -- the migration transition: the marker function exists (visible to this transaction) AND its
  -- creating transaction is still in progress — only this transaction, or one of its own
  -- subtransactions, can have created it (the epoch is taken from txid_current, whose upper 32 bits
  -- carry it, so the 32-bit xmin is judged in the same era)
  v_migration BOOLEAN := EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'platform_t4d_server_generation_migration_open'
       AND txid_status(((txid_current() >> 32) << 32) + p.xmin::text::bigint) = 'in progress');
BEGIN
  -- WRITTEN ONLY BY A MIGRATION: the DDL transition, never a DML writer and never startup — asked
  -- first, so a direct write is refused by the name of what it is, whatever shape it carries
  IF NOT v_migration THEN
    RAISE EXCEPTION
      'phase6 4d-ii: "ServerGeneration" is written only inside a versioned migration''s own transaction (the one that created platform_t4d_server_generation_migration_open) and by nothing else — this % (migration transition closed) is refused. A process reads the minimum at startup and never writes it; to raise it, ship a migration (the staging document, "The drain").',
      TG_OP;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- ONLY EVER RAISED, whoever writes: a migration that lowered it would re-admit every build the
    -- raise refused
    IF NEW."minimumGeneration" < OLD."minimumGeneration" THEN
      RAISE EXCEPTION
        'phase6 4d-ii: the persisted server-generation minimum is only ever RAISED — % -> % is refused, whoever writes it (a migration raises with GREATEST; the staging document, "The drain"). Lowering it would re-admit every build the raise fenced out.',
        OLD."minimumGeneration", NEW."minimumGeneration";
    END IF;
    -- a RAISE records its own provenance: the raising migration's name and a later timestamp — the
    -- row must never attribute a raised fence to an earlier raise (#663's review round 1, finding 1)
    IF NEW."minimumGeneration" > OLD."minimumGeneration"
       AND (NEW."raisedBy" IS NOT DISTINCT FROM OLD."raisedBy"
            OR NEW."raisedAt" IS NULL
            OR NEW."raisedAt" <= OLD."raisedAt") THEN
      RAISE EXCEPTION
        'phase6 4d-ii: a raise of the persisted server-generation minimum (% -> %) must record its own provenance — a new "raisedBy" (the raising migration''s name, not the last raise''s %) and a "raisedAt" later than the last raise''s (%) — or the row would attribute the raised fence to an earlier migration in every startup refusal and drain evidence (#663 round 1, finding 1).',
        OLD."minimumGeneration", NEW."minimumGeneration", OLD."raisedBy", OLD."raisedAt";
    END IF;
    -- an UPDATE that raises nothing is a no-op re-apply; it may not rewrite the evidence of the raise
    IF NEW."minimumGeneration" = OLD."minimumGeneration"
       AND (NEW."raisedBy" IS DISTINCT FROM OLD."raisedBy" OR NEW."raisedAt" IS DISTINCT FROM OLD."raisedAt") THEN
      RAISE EXCEPTION
        'phase6 4d-ii: the persisted server-generation minimum was not raised by this UPDATE (still %), so "raisedBy" / "raisedAt" — the evidence of the last raise (% at %) — may not move.',
        OLD."minimumGeneration", OLD."raisedBy", OLD."raisedAt";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ServerGeneration_t4d_raised" ON "ServerGeneration";
CREATE TRIGGER "ServerGeneration_t4d_raised" BEFORE INSERT OR UPDATE ON "ServerGeneration"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_server_generation_raised();

-- ── 3. the retention: ServerGeneration_t4d_retained (BEFORE DELETE) ──────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_server_generation_retained() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-ii: the persisted server-generation minimum (% raised by %) is never deleted — a process that reads no minimum is refused at startup, and a removed row is the one way to lower a minimum that is only ever raised (the staging document, "The drain").',
    OLD."minimumGeneration", OLD."raisedBy";
END $$;

DROP TRIGGER IF EXISTS "ServerGeneration_t4d_retained" ON "ServerGeneration";
CREATE TRIGGER "ServerGeneration_t4d_retained" BEFORE DELETE ON "ServerGeneration"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_server_generation_retained();

-- ── 4. TRUNCATE fires no row trigger ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_server_generation_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-ii: "ServerGeneration" is never truncated — the persisted server-generation minimum is the fence every fenced build reads at startup (the staging document, "The drain").';
END $$;

DROP TRIGGER IF EXISTS "ServerGeneration_t4d_no_truncate" ON "ServerGeneration";
CREATE TRIGGER "ServerGeneration_t4d_no_truncate" BEFORE TRUNCATE ON "ServerGeneration"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_server_generation_no_truncate();

-- ── 5. THE RAISE, inside the migration transition ────────────────────────────────────────────────
-- ONE statement, so it is one transaction on every apply path (Prisma's deploy and `migrate.sh`'s
-- psql replay alike): the marker is created, the minimum raised with GREATEST, the marker dropped.
-- This file's generation is 1 (A6e's). A later fence-raising migration copies this block with its
-- own literal and name; re-running THIS file after it changes nothing — `raisedBy` and `raisedAt`
-- keep the later raise's evidence.
DO $$
BEGIN
  EXECUTE 'CREATE FUNCTION platform_t4d_server_generation_migration_open() RETURNS void LANGUAGE sql AS ''SELECT''';
  INSERT INTO "ServerGeneration" ("key", "minimumGeneration", "raisedBy", "raisedAt")
  VALUES ('singleton', 1, '20280101000000_phase6_t4d_ii_a6e_generation_fence', CURRENT_TIMESTAMP)
  ON CONFLICT ("key") DO UPDATE
    SET "minimumGeneration" = GREATEST("ServerGeneration"."minimumGeneration", EXCLUDED."minimumGeneration"),
        "raisedBy" = CASE WHEN EXCLUDED."minimumGeneration" > "ServerGeneration"."minimumGeneration"
                          THEN EXCLUDED."raisedBy" ELSE "ServerGeneration"."raisedBy" END,
        "raisedAt" = CASE WHEN EXCLUDED."minimumGeneration" > "ServerGeneration"."minimumGeneration"
                          THEN CURRENT_TIMESTAMP ELSE "ServerGeneration"."raisedAt" END;
  EXECUTE 'DROP FUNCTION platform_t4d_server_generation_migration_open()';
END $$;

-- ── 6. FAIL CLOSED ON ITS OWN INSTALLATION ───────────────────────────────────────────────────────
-- A deploy that reported success with the fence silently absent, or with no minimum persisted, would
-- leave every fenced build starting unfenced — the state this file exists to make unrepresentable.
DO $verify$
DECLARE
  n integer;
  v_min integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE ns.nspname = 'public' AND c.relname = 'ServerGeneration'
     AND ((t.tgname = 'ServerGeneration_t4d_raised' AND p.proname = 'platform_t4d_server_generation_raised' AND t.tgtype = 23)        -- ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16)
       OR (t.tgname = 'ServerGeneration_t4d_retained' AND p.proname = 'platform_t4d_server_generation_retained' AND t.tgtype = 11)    -- ROW(1) + BEFORE(2) + DELETE(8)
       OR (t.tgname = 'ServerGeneration_t4d_no_truncate' AND p.proname = 'platform_t4d_server_generation_no_truncate' AND t.tgtype = 34)) -- BEFORE(2) + TRUNCATE(32), per statement
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgqual IS NULL
     AND t.tgattr = ''::int2vector
     AND p.proconfig IS NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A6e: the server-generation fence did not install (found % of the 3 required seals). The deploy is refused rather than starting with an unfenced generation register.', n;
  END IF;
  SELECT "minimumGeneration" INTO v_min FROM "ServerGeneration" WHERE "key" = 'singleton';
  IF v_min IS NULL OR v_min < 1 THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A6e: no persisted server-generation minimum after the raise (found %). The deploy is refused: every fenced build reads this row at startup.', coalesce(v_min::text, '<no row>');
  END IF;
  IF to_regprocedure('platform_t4d_server_generation_migration_open()') IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii / A6e: the migration transition marker was left behind — the register would stay open to any writer in this transaction. The deploy is refused.';
  END IF;
END
$verify$;
