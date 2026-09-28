-- Phase 6 task 4d unit 4d-ii-a / A6a — the OUTBOX CONSUMER ACTIVATION REGISTER, exactly as the
-- companion document specifies it (`docs/superpowers/plans/2026-09-09-outbox-consumer-activation.md`,
-- "The register" and "Every catalog row has a head, from the moment the table exists"). §D and that
-- document said 4d-i installs it; it did not (the staging doc's "One gap the map found"), so A6 does,
-- and this is A6's first sub-unit.
--
-- THE PROBLEM IT ENDS (#560's review round 1, findings 1 and 2). `OutboxConsumerCatalog.active` is a
-- plain writable column and `registeredAt` a writable timestamp. The obligation set — which consumers
-- owe a delivery row for an event — must be judged from an APPEND-ONLY, ATTRIBUTABLE fact, never from
-- a column anyone can edit and never from a date. From this unit every catalog row has a HEAD: the
-- newest `OutboxConsumerActivation` row for it, whose `active` the catalog column MIRRORS.
--
-- WHAT THIS UNIT INSTALLS (A6a), AND WHAT THE NEXT DOES NOT YET (A6b):
--   · the register table, its CHECKs and its uniqueness (the triple `(consumer, actorKind,
--     requestToken)`: the KIND is part of the retry identity; PostgreSQL admits any number of NULLs,
--     so the token-less registration rows never contend on it);
--   · `OutboxConsumerCatalog.activationSeq`, the head's sequence, mirrored beside `active`;
--   · the BEFORE INSERT head lock (the catalog row `FOR UPDATE`, `seq = activationSeq + 1`) and the
--     AFTER INSERT apply, which is THE ONLY WRITER of the mirror and advances `active` and
--     `activationSeq` together under the transaction-local marker `vitan.outbox_activation_applying`;
--   · the append-only and no-truncate seals on the register;
--   · the catalog-INSERT baseline trigger: every catalog row born from now on gets its `seq = 1`
--     head in the same statement, whoever creates it (`syncConsumerCatalog()` at every boot, a
--     migration, a direct writer) — the operation is covered, not a list of writers;
--   · the BACKFILL: one `seq = 1` baseline fact for every catalog row that pre-dates the trigger,
--     mirroring that row's current `active`, `actorKind = 'migration'`, this migration's name as its
--     retry identity, and each `activationSeq` set to 1 by the apply trigger.
--   NOT YET: the freeze of `active` / `activationSeq` / `registeredAt` on the catalog
--   (`OutboxConsumerCatalog_t4d_rules`, whose admitted seam is the marker above) and the
--   `outbox:consumer` operator protocol. Until A6b the delivered direct UPDATE of `active` still
--   works exactly as today, so this unit changes no behaviour of any delivered writer or fixture:
--   it only gives every consumer an attributable head and refuses every erasure of it.
--
-- RE-RUNNABLE, on `ALWAYS_EXECUTE`'s terms: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
-- guarded constraints, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before each `CREATE
-- TRIGGER`, and a backfill that inserts only for a catalog row holding no fact at all. A replay after
-- A6b installs the freeze appends nothing, so it never meets it.
--
-- NO DELETION IS ADMITTED IN PRODUCTION (#580's review round 3, finding 1). The FK is `ON DELETE
-- RESTRICT` and the seal refuses every DELETE; since every consumer has a head, a catalog row can no
-- longer be deleted at all outside the test seam, which is the row-scoped `sanctionedConsumerRemoval`
-- in `prisma/sanctioned-reset.ts`, never a cascade. Nothing in `src/` deletes a catalog row.

-- ── the head's sequence, mirrored on the catalog ─────────────────────────────────────────────
ALTER TABLE "OutboxConsumerCatalog" ADD COLUMN IF NOT EXISTS "activationSeq" INTEGER NOT NULL DEFAULT 0;

-- ── the register ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OutboxConsumerActivation" (
    "consumer"     TEXT NOT NULL,
    -- monotone per consumer; the head lock below requires exactly `activationSeq + 1`
    "seq"          INTEGER NOT NULL,
    -- the intended state this fact asserts; the mirror takes it
    "active"       BOOLEAN NOT NULL,
    "reason"       TEXT NOT NULL,
    -- 'operator' | 'migration' | 'registration' — a closed set (#580's review round 1, finding 5)
    "actorKind"    TEXT NOT NULL,
    -- OPERATOR-DECLARED for 'operator'; a NAMED CONSTANT system actor for the other two kinds
    "actorId"      TEXT NOT NULL,
    -- the retry identity: REQUIRED for the two kinds that can retry, ABSENT for a registration
    -- (#580's review round 2, finding 2); a present token must be a real one (round 4, finding 5)
    "requestToken" TEXT,
    "at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxConsumerActivation_pkey" PRIMARY KEY ("consumer", "seq")
);
-- THE ONE uniqueness beyond the key: the retry identity, KIND included (#580's review round 3,
-- finding 2; round 4, finding 3 retired the narrower `(consumer, requestToken)` duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS "OutboxConsumerActivation_consumer_actorKind_requestToken_key"
  ON "OutboxConsumerActivation"("consumer", "actorKind", "requestToken");
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_consumer_fkey"
    FOREIGN KEY ("consumer") REFERENCES "OutboxConsumerCatalog"("consumer") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_seq_check"
    CHECK ("seq" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_actorKind_check"
    CHECK ("actorKind" IN ('operator', 'migration', 'registration'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- THE WHITESPACE DISCIPLINE (`DecisionForward.reason`'s; #560's review round 2, finding 4; #580's
-- review round 1, finding 10): a value that is empty once every ASCII whitespace character is
-- stripped is refused AT THE DATABASE, so a direct writer cannot persist a tab-only reason, a blank
-- identity or a whitespace retry identity that zod would have refused. Three separate constraints,
-- so removing any one is RED on its own row (P-A7).
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_reason_present_check"
    CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_actorId_present_check"
    CHECK (btrim("actorId", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_requestToken_present_check"
    CHECK ("requestToken" IS NULL OR btrim("requestToken", E' \t\n\x0B\f\r') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- the token is MANDATORY for the writers that retry and ABSENT for the one that cannot: one rule
DO $$ BEGIN
  ALTER TABLE "OutboxConsumerActivation" ADD CONSTRAINT "OutboxConsumerActivation_requestToken_kind_check"
    CHECK (("actorKind" = 'registration') = ("requestToken" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the head lock: BEFORE INSERT ─────────────────────────────────────────────────────────────
-- Takes the consumer's catalog row `FOR UPDATE` and requires `NEW.seq = activationSeq + 1` against
-- the stored head (#561's review round 1, finding 5): two appends serialize on the row, the loser
-- waits, re-reads the committed head and appends after it — never reordered. The catalog lookup is
-- STRICT: an unknown consumer RAISES here by name (#580's review round 1, finding 8) — under
-- three-valued logic `1 = NULL + 1` is NULL, not false, so a non-strict lookup would raise nothing
-- and leave an orphan fact with no mirror; the FK refuses it again at statement end.
CREATE OR REPLACE FUNCTION platform_t4d_activation_head_lock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_head INTEGER;
BEGIN
  BEGIN
    SELECT c."activationSeq" INTO STRICT v_head
      FROM "OutboxConsumerCatalog" c
     WHERE c."consumer" = NEW."consumer"
       FOR UPDATE;
  EXCEPTION WHEN no_data_found THEN
    RAISE EXCEPTION
      'phase6 4d-ii: an activation names consumer "%", which has no "OutboxConsumerCatalog" row — a fact for an unregistered consumer would be an orphan with no mirror, and its history would collide with a later registration (companion document, P-A8).',
      NEW."consumer";
  END;
  IF NEW."seq" <> v_head + 1 THEN
    RAISE EXCEPTION
      'phase6 4d-ii: activation seq % for consumer "%" is STALE — the committed head is % and the next fact must be seq %. The catalog row is locked FOR UPDATE, so a writer that re-reads the head under it never sees this; a direct writer that precomputed its sequence does (companion document, "The register").',
      NEW."seq", NEW."consumer", v_head, v_head + 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerActivation_t4d_head_lock" ON "OutboxConsumerActivation";
CREATE TRIGGER "OutboxConsumerActivation_t4d_head_lock" BEFORE INSERT ON "OutboxConsumerActivation"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_activation_head_lock();

-- ── the apply: AFTER INSERT, THE ONLY WRITER of the mirror ───────────────────────────────────
-- Advances `active` and `activationSeq` together. The transaction-local marker is the narrow, named
-- write seam (#580's review round 1, finding 6) A6b's rules freeze admits a NESTED update of exactly
-- these two columns under: `pg_trigger_depth() > 1` AND the marker set. Set before the statement,
-- cleared after it; an exception unwinds both with the transaction.
CREATE OR REPLACE FUNCTION platform_t4d_activation_apply() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('vitan.outbox_activation_applying', 'on', true);
  UPDATE "OutboxConsumerCatalog"
     SET "active" = NEW."active", "activationSeq" = NEW."seq"
   WHERE "consumer" = NEW."consumer";
  PERFORM set_config('vitan.outbox_activation_applying', '', true);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerActivation_t4d_apply" ON "OutboxConsumerActivation";
CREATE TRIGGER "OutboxConsumerActivation_t4d_apply" AFTER INSERT ON "OutboxConsumerActivation"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_activation_apply();

-- ── the seals: append-only at the row, no TRUNCATE at the statement ──────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_activation_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-ii: "OutboxConsumerActivation" is an append-only attributable register and its rows are immutable evidence — a % is refused. Excluding a consumer means APPENDING a deactivation that survives; erasing a token receipt would let a lost request execute again. The row-scoped test seam (prisma/sanctioned-reset.ts sanctionedConsumerRemoval) disables this trigger BY NAME.',
    TG_OP;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerActivation_t4d_append_only" ON "OutboxConsumerActivation";
CREATE TRIGGER "OutboxConsumerActivation_t4d_append_only" BEFORE UPDATE OR DELETE ON "OutboxConsumerActivation"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_activation_append_only();

CREATE OR REPLACE FUNCTION platform_t4d_activation_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'phase6 4d-ii: "OutboxConsumerActivation" is never truncated — a row trigger does not fire for TRUNCATE, so the statement is sealed too; a wipe would erase the evidence and leave every mirror unexplained (#560 round 2, finding 2). It stays outside every sanctioned reset; the sanctioned reset (prisma/sanctioned-reset.ts TRUNCATE_SEALS) names this trigger so a cascade cannot reach it unannounced.';
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerActivation_t4d_no_truncate" ON "OutboxConsumerActivation";
CREATE TRIGGER "OutboxConsumerActivation_t4d_no_truncate" BEFORE TRUNCATE ON "OutboxConsumerActivation"
  FOR EACH STATEMENT EXECUTE FUNCTION platform_t4d_activation_no_truncate();

-- ── every catalog row has a head from the moment it exists: the catalog's own INSERT ─────────
-- Installed BEFORE the backfill below (#572's review round 12, finding 2; #580's review round 1,
-- finding 4): a row this or any later migration registers, and every row `syncConsumerCatalog()`
-- creates at boot, gets its head from this trigger, so the backfill covers only what pre-dates it.
-- The head mirrors the value the INSERT gave `active` (the column default, when none was supplied),
-- and a registration carries no token: the catalog's primary key admits that INSERT exactly once.
CREATE OR REPLACE FUNCTION platform_t4d_catalog_registration_head() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "OutboxConsumerActivation" ("consumer", "seq", "active", "reason", "actorKind", "actorId", "requestToken")
  VALUES (
    NEW."consumer", 1, NEW."active",
    'registration baseline: the value the catalog row''s own INSERT gave `active` (syncConsumerCatalog at boot, or the migration that registered the consumer)',
    'registration', 'system:outbox-registration', NULL
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerCatalog_t4d_registration_head" ON "OutboxConsumerCatalog";
CREATE TRIGGER "OutboxConsumerCatalog_t4d_registration_head" AFTER INSERT ON "OutboxConsumerCatalog"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_catalog_registration_head();

-- ── the backfill: one baseline fact per catalog row that pre-dates the trigger ───────────────
-- On upgrade the catalog already holds `webpush.notify`, `decisions.inbox`, … whose `active` mirror
-- would otherwise have no attributable row explaining it (#572's review round 10, finding 3). The
-- migration's own name is its retry identity — `ALWAYS_EXECUTE` replays this file on every baseline
-- path — and the insert is guarded on the ABSENCE of any fact for the row, so a replay after an
-- operator's later deactivation appends nothing and re-activates nothing.
INSERT INTO "OutboxConsumerActivation" ("consumer", "seq", "active", "reason", "actorKind", "actorId", "requestToken")
SELECT c."consumer", 1, c."active",
       'baseline backfill: this catalog row pre-dates the activation register; its head mirrors the `active` it held when 20271228000000_phase6_t4d_ii_a6a_activation_register installed the register',
       'migration', 'system:migration:20271228000000_phase6_t4d_ii_a6a_activation_register',
       '20271228000000_phase6_t4d_ii_a6a_activation_register'
  FROM "OutboxConsumerCatalog" c
 WHERE NOT EXISTS (SELECT 1 FROM "OutboxConsumerActivation" a WHERE a."consumer" = c."consumer")
 ORDER BY c."consumer";
