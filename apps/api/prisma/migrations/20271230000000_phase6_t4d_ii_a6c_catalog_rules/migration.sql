-- Phase 6 task 4d unit 4d-ii-a / A6c — the PERSISTED DISPATCH RULES and the REGISTRATION BARRIER
-- (the 4d plan `2026-09-07-decision-workflow-4d.md`, §A.3 obligation 7 — "The rules are sealed
-- evidence, not startup state", "A row's BIRTH carries its rule; the migration owns every rule that
-- already EXISTS", and "The EXCLUSIVE half is installed by a named trigger").
--
-- WHY THE COLUMNS EXIST. A6d's deferred seal `DomainEvent_t4d_deliveries` will require, for every
-- ACTIVE catalog row at an event's commit, one same-transaction delivery row whose action is
-- `dispatch` or `noop` "according to a PERSISTED rule the catalog row carries" — so the seal judges
-- the rows against kernel truth and reproduces no consumer logic. A trigger cannot read a TypeScript
-- function, so the rule lives on the row: `dispatchRule` in {all, invalidate, push, types} and, under
-- `types`, the sorted `subscribedEventTypes`.
--
-- WHO WRITES A RULE (#558's review round 2, finding 7; #572's review round 24, finding 2):
--   - a row's BIRTH carries it — `syncConsumerCatalog` INSERTs the rule from the compiled contract in
--     the same act as `consumerKind`/`consumerEffect`/`catalogVersion`, the same source startup
--     verification compares against, so that write can introduce no drift;
--   - the rule of a row that already EXISTS belongs to the versioned catalog-data migration: THIS file
--     writes the compiled rule of every consumer it knows, inside the RULE-MIGRATION TRANSITION below,
--     guarded on the ABSENCE of a rule so a re-run (this file is on `ALWAYS_EXECUTE`) rewrites
--     nothing; a CHANGED rule is a contract change and ships in its own migration through the same
--     transition;
--   - nobody else: `OutboxConsumerCatalog_t4d_rules` refuses every UPDATE of the rule columns outside
--     the transition, and `syncConsumerCatalog` VERIFIES an existing row's rule against the compiled
--     contract at every startup, refusing the process on drift exactly as it refuses a
--     `catalogVersion` mismatch, and never rewrites it.
-- A row this file does not know (a consumer no compiled contract names: planted history, a test's
-- residue) keeps NO rule; a compiled consumer meeting such a row is refused at startup by name.
--
-- THE RULE-MIGRATION TRANSITION IS NOT A SESSION SETTING (#661's review round 1, finding 1). A
-- transaction-local setting is ordinary session state: any writer that can issue the UPDATE can
-- `set_config` it first, so a setting-gated freeze admits a depth-1 rewrite by anyone. The rule
-- columns are sealed EVIDENCE, and evidence must not be rewritable by the class of writer the seal
-- exists to refuse. So the transition is a DDL object: the freeze admits a rule-column UPDATE only
-- while the function `platform_t4d_catalog_rule_migration_open()` EXISTS AND WAS CREATED BY THE
-- CURRENT TRANSACTION — its `pg_proc` row is visible to this transaction and its creating
-- transaction is still IN PROGRESS (`txid_status`), which only this transaction (or one of its own
-- subtransactions) can satisfy: another session's uncommitted DDL is invisible here, and a committed
-- marker is not in progress. A migration creates it, rewrites, and drops it, all inside one
-- transaction (the DO block below is one statement, so it is one transaction on every apply path —
-- Prisma's deploy and `migrate.sh`'s psql replay alike). A DML-only writer cannot create a function;
-- a writer who can is the class that could drop the seal itself — the one trust boundary every 4d
-- seal lives on. A marker left behind by an aborted apply opens nothing: the in-progress arm admits
-- only the transaction that created it, and the next apply's CREATE fails loudly on the leftover
-- rather than silently reopening the gate.
--
-- THE BARRIER (#572's review round 25, finding 7; round 26, finding 1). An event's obligation set is
-- read from the catalog, and a consumer registered between that read and the event's commit is a row
-- no row lock could cover, because it did not exist. So event authoring and catalog INSERT take ONE
-- shared barrier — a transaction-scoped advisory lock on a single catalog-registration key: EXCLUSIVE
-- by every catalog INSERT, SHARED by the event's seal before it scans. A contract that names no
-- installer is not installed, so the exclusive half is a named BEFORE INSERT trigger here —
-- `syncConsumerCatalog`'s creates, a migration's, a direct writer's alike — taken before any catalog
-- row lock, so the order is registration key → catalog rows, one direction. The SHARE half is A6d's
-- (`DomainEvent_t4d_deliveries` takes it at the head of its deferred body); `deliveryRowsFor` may take
-- it early for lock-ordering hygiene, and the lock is reentrant. The key is the literal both halves
-- carry: hashtext('OutboxConsumerCatalog:registration').
--
-- RE-RUNNABLE (on `ALWAYS_EXECUTE`): `ADD COLUMN IF NOT EXISTS`, constraints dropped and re-added by
-- name (so a corrected CHECK replaces its predecessor on replay), `CREATE OR REPLACE FUNCTION`,
-- `DROP TRIGGER IF EXISTS`, and a backfill guarded on absence.

-- ── 1. the rule columns ──────────────────────────────────────────────────────────────────────────
ALTER TABLE "OutboxConsumerCatalog" ADD COLUMN IF NOT EXISTS "dispatchRule" TEXT;
ALTER TABLE "OutboxConsumerCatalog" ADD COLUMN IF NOT EXISTS "subscribedEventTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- the closed vocabulary (NULL = no rule persisted for this row)
ALTER TABLE "OutboxConsumerCatalog" DROP CONSTRAINT IF EXISTS "OutboxConsumerCatalog_t4d_rule_kind";
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_t4d_rule_kind"
  CHECK ("dispatchRule" IS NULL OR "dispatchRule" IN ('all', 'invalidate', 'push', 'types'));
-- a subscription list belongs to `types` alone (NULL and the other three carry none)
ALTER TABLE "OutboxConsumerCatalog" DROP CONSTRAINT IF EXISTS "OutboxConsumerCatalog_t4d_rule_types";
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_t4d_rule_types"
  CHECK (coalesce("dispatchRule", '') = 'types' OR cardinality("subscribedEventTypes") = 0);
-- every subscribed type is a NAME: no NULL element (#661 round 1, finding 3 — `array_to_string`
-- skips NULLs and `array_position(…, '')` does not see them), no empty element, no whitespace anywhere
ALTER TABLE "OutboxConsumerCatalog" DROP CONSTRAINT IF EXISTS "OutboxConsumerCatalog_t4d_rule_type_names";
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_t4d_rule_type_names"
  CHECK (array_position("subscribedEventTypes", NULL) IS NULL
     AND array_position("subscribedEventTypes", '') IS NULL
     AND array_to_string("subscribedEventTypes", ',') !~ '\s');

-- ── 2. the rules trigger, re-issued with the rule columns under the rule-migration transition ───
-- A6b's function, one column family wider (the trigger's name and operations do not change). The
-- mirror seam and the `registeredAt` freeze are as A6b stated them; the rule columns are admitted on
-- exactly one condition, the DDL transition described above.
CREATE OR REPLACE FUNCTION platform_t4d_catalog_rules() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_applying BOOLEAN := coalesce(current_setting('vitan.outbox_activation_applying', true), '') = 'on';
  -- the rule-migration transition: the marker function exists (visible to this transaction) AND its
  -- creating transaction is still in progress — only this transaction, or one of its own
  -- subtransactions, can have created it (the epoch is taken from txid_current, whose upper 32 bits
  -- carry it, so the 32-bit xmin is judged in the same era)
  v_rule_migration BOOLEAN := EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'platform_t4d_catalog_rule_migration_open'
       AND txid_status(((txid_current() >> 32) << 32) + p.xmin::text::bigint) = 'in progress');
BEGIN
  -- frozen, and part of no rule
  IF NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt" THEN
    RAISE EXCEPTION
      'phase6 4d-ii: "OutboxConsumerCatalog"."registeredAt" of consumer "%" is FROZEN — it is immutable after insert and selects nothing (no obligation rule reads it), so there is no legitimate reason to move it (companion document, "The register"; #580 round 1, finding 9).',
      OLD."consumer";
  END IF;

  -- the mirror: written only by the register's apply, nested and under its marker
  IF NEW."active" IS DISTINCT FROM OLD."active" OR NEW."activationSeq" IS DISTINCT FROM OLD."activationSeq" THEN
    IF NOT (pg_trigger_depth() > 1 AND v_applying) THEN
      RAISE EXCEPTION
        'phase6 4d-ii: "OutboxConsumerCatalog"."active" / "activationSeq" of consumer "%" are the MIRROR of the activation register, written only by its AFTER INSERT (platform_t4d_activation_apply) — this % UPDATE (trigger depth %, marker %) is refused. To change a consumer''s state, APPEND a fact through the operator protocol (`outbox:consumer`); the head lock derives the sequence and the apply moves the mirror (companion document, "The register"; #580 round 1, finding 6).',
        OLD."consumer",
        CASE WHEN pg_trigger_depth() > 1 THEN 'nested' ELSE 'direct' END,
        pg_trigger_depth(),
        CASE WHEN v_applying THEN 'on' ELSE 'off' END;
    END IF;
  END IF;

  -- the persisted RULE: sealed evidence, rewritten only inside a versioned catalog-data migration's
  -- own transaction (the DDL transition) — never by startup, never by a DML writer
  IF NEW."dispatchRule" IS DISTINCT FROM OLD."dispatchRule" OR NEW."subscribedEventTypes" IS DISTINCT FROM OLD."subscribedEventTypes" THEN
    IF NOT v_rule_migration THEN
      RAISE EXCEPTION
        'phase6 4d-ii: the persisted dispatch RULE ("dispatchRule" / "subscribedEventTypes") of consumer "%" is SEALED EVIDENCE, rewritten only inside a versioned catalog-data migration''s own transaction (the one that created platform_t4d_catalog_rule_migration_open) and by nothing else — this UPDATE (rule-migration transition %) is refused. A changed rule is a contract change: ship it as a migration; startup verifies a rule and never writes one that exists (4d plan §A.3 obligation 7; #558 round 2, finding 7; #661 round 1, finding 1).',
        OLD."consumer",
        CASE WHEN v_rule_migration THEN 'open' ELSE 'closed' END;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerCatalog_t4d_rules" ON "OutboxConsumerCatalog";
CREATE TRIGGER "OutboxConsumerCatalog_t4d_rules" BEFORE UPDATE ON "OutboxConsumerCatalog"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_catalog_rules();

-- ── 3. the registration barrier: the EXCLUSIVE half, on every catalog INSERT ─────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_registration_barrier() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- ONE shared barrier for event authoring and catalog registration: EXCLUSIVE here, on every INSERT
  -- whoever issues it; SHARED by the event's delivery seal before it scans the catalog (A6d). Taken
  -- BEFORE any catalog row lock, so the order is registration key -> catalog rows, one direction; a
  -- transaction that already holds it re-acquires for free (the lock is reentrant).
  PERFORM pg_advisory_xact_lock(hashtext('OutboxConsumerCatalog:registration'));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerCatalog_t4d_registration_barrier" ON "OutboxConsumerCatalog";
CREATE TRIGGER "OutboxConsumerCatalog_t4d_registration_barrier" BEFORE INSERT ON "OutboxConsumerCatalog"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_registration_barrier();

-- ── 4. the rules of every row that already exists, from the compiled contracts ──────────────────
-- The literal below is PINNED to the compiled consumers by `catalog-rules.test.ts` (the migration
-- text against the module, as 4d-i's catalog seed is): a rule changed in code without its migration,
-- or a literal that drifts from the code, fails there. Guarded on the ABSENCE of a rule: a re-run
-- rewrites nothing, and a row `syncConsumerCatalog` created after this file (rule at birth) is left
-- as born. Inside the rule-migration transition: this ONE statement creates the marker function,
-- rewrites, and drops it, so the transition is open exactly for this transaction.
DO $$
BEGIN
  EXECUTE 'CREATE FUNCTION platform_t4d_catalog_rule_migration_open() RETURNS void LANGUAGE sql AS ''SELECT''';
  UPDATE "OutboxConsumerCatalog" AS c
     SET "dispatchRule" = r.rule, "subscribedEventTypes" = r.types
    FROM (VALUES
      ('activities.material-readiness', 'types', ARRAY['activity.material_blocked', 'activity.material_unblocked', 'delivery.committed', 'delivery.defaulted', 'delivery.fulfilled', 'delivery.revised', 'issue.recorded', 'mismatch.resolved', 'po.amended', 'po.cancelled', 'po.closed_short', 'po.issued', 'requirement.cancelled', 'requirement.created', 'requirement.revised', 'stock.transacted', 'substitution.approved', 'substitution.revoked']::TEXT[]),
      ('activities.schedule', 'types', ARRAY['activity.completion_requested', 'activity.created', 'activity.deleted', 'activity.labour_blocked', 'activity.labour_unblocked', 'activity.material_blocked', 'activity.material_unblocked', 'activity.override_granted', 'activity.override_revoked', 'activity.signed_off', 'activity.signoff_rejected', 'activity.started', 'activity.unfiled', 'activity.updated', 'phase.created', 'phase.removed']::TEXT[]),
      ('commercial.cash-forecast', 'types', ARRAY['capacity.committed', 'capacity.defaulted', 'capacity.revised', 'commercial.money_moved', 'delivery.committed', 'delivery.defaulted', 'delivery.fulfilled', 'delivery.revised', 'labour.po.amended', 'labour.po.cancelled', 'labour.po.closed_short', 'labour.po.issued', 'po.amended', 'po.cancelled', 'po.closed_short', 'po.issued', 'stock.transacted']::TEXT[]),
      ('daily-log.inbox', 'types', ARRAY['dailylog.started', 'dailylog.submitted', 'material.added', 'material.mismatch_flagged', 'material.unfiled']::TEXT[]),
      ('decisions.inbox', 'types', ARRAY['decision.approved', 'decision.change_requested', 'decision.change_withdrawn', 'decision.consultation_requested', 'decision.consultation_responded', 'decision.drafted', 'decision.published', 'decision.reapproved', 'decision.withdrawn']::TEXT[]),
      ('drawings.inbox', 'types', ARRAY['drawing.acknowledged', 'drawing.activity_unlinked', 'drawing.issued', 'drawing.published', 'drawing.recipients_frozen', 'drawing.refiled', 'drawing.removed', 'drawing.revised', 'drawing.unfiled']::TEXT[]),
      ('inspections.inbox', 'types', ARRAY['inspection.approved', 'inspection.closing_created', 'inspection.created', 'inspection.evidence_added', 'inspection.evidence_removed', 'inspection.reinspection_created', 'inspection.rejected', 'inspection.relabeled', 'inspection.submitted', 'inspection.unfiled']::TEXT[]),
      ('labour.readiness', 'types', ARRAY['allocation.made', 'allocation.released', 'capacity.committed', 'capacity.defaulted', 'capacity.revised', 'labour_work.recorded', 'requirement.cancelled', 'requirement.created', 'requirement.revised', 'skill_substitution.approved', 'skill_substitution.revoked']::TEXT[]),
      ('socket.invalidation', 'invalidate', ARRAY[]::TEXT[]),
      ('webpush.notify', 'push', ARRAY[]::TEXT[])
    ) AS r(consumer, rule, types)
   WHERE c."consumer" = r.consumer
     AND c."dispatchRule" IS NULL;
  EXECUTE 'DROP FUNCTION platform_t4d_catalog_rule_migration_open()';
END $$;
