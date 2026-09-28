-- Phase 6 task 4d unit 4d-ii-a / A6b — the MIRROR'S SOLE WRITER: `OutboxConsumerCatalog_t4d_rules`
-- (the companion document `2026-09-09-outbox-consumer-activation.md`, "The register": "the only way
-- to exclude a consumer from an event's obligation is to append an attributable deactivation row
-- that survives as evidence", and "The mirror's write seam is narrow and named").
--
-- A6a installed the register, its head lock, and the AFTER INSERT apply that advances the catalog's
-- `active` and `activationSeq` together under the transaction-local marker
-- `vitan.outbox_activation_applying`. It left the catalog's columns WRITABLE, so a direct UPDATE of
-- `active` still worked and the delivered fixtures still used it. This unit closes that: from here
-- the catalog mirror moves ONLY through the register's apply, and the `outbox:consumer` operator
-- protocol (`src/platform/outbox/consumer-activation.service.ts`, shipped in this same unit) is the
-- supported way to ask for a change.
--
-- THE SEAM (#580's review round 1, finding 6). A rules trigger that froze `active` unconditionally
-- would roll back every activation, because the register's own AFTER INSERT is the writer that must
-- move it; one broadly bypassable would leave the column open to the direct updates this register
-- exists to end. So an UPDATE touching `active` / `activationSeq` is admitted on EXACTLY one
-- condition: it arrives NESTED (`pg_trigger_depth() > 1`) AND under the marker the apply sets around
-- its own statement. Every depth-1 UPDATE of either column is refused whatever else it carries (a
-- direct writer setting the marker itself included), and a nested update from any OTHER trigger is
-- refused for want of the marker. This is the depth-and-flag doctrine the 4d registers already use
-- for their writer seals, applied here to one column pair.
--
-- `registeredAt` IS FROZEN AND SELECTS NOTHING (#580's review round 1, finding 9): immutable after
-- insert — which is what makes the original defect (moving the cutoff past an event) unwritable —
-- and consulted by no obligation rule, so it is harmless to keep. The rule columns A6c adds
-- (`dispatchRule`, `subscribedEventTypes`) will join this function under their own `SET LOCAL` gate;
-- it is `CREATE OR REPLACE`d then, so the trigger's name and operations do not change.
--
-- WHAT IS UNTOUCHED: INSERTs (`syncConsumerCatalog()` creates a row exactly as before, and the
-- registration trigger gives it its head through this seam), DELETEs (refused already by the
-- register's RESTRICT FK; the row-scoped test seam deletes the facts first), and every other column.
--
-- RE-RUNNABLE (on `ALWAYS_EXECUTE`): `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`.

CREATE OR REPLACE FUNCTION platform_t4d_catalog_rules() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_applying BOOLEAN := coalesce(current_setting('vitan.outbox_activation_applying', true), '') = 'on';
BEGIN
  -- frozen, and part of no rule
  IF NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt" THEN
    RAISE EXCEPTION
      'phase6 4d-ii: "OutboxConsumerCatalog"."registeredAt" of consumer "%" is FROZEN — it is immutable after insert and selects nothing (no obligation rule reads it), so there is no legitimate reason to move it (companion document, "The register"; #580 round 1, finding 9).',
      OLD."consumer";
  END IF;

  -- the mirror: written only by the register's apply, nested and under its marker
  IF NEW."active" IS DISTINCT FROM OLD."active" OR NEW."activationSeq" IS DISTINCT FROM OLD."activationSeq" THEN
    IF pg_trigger_depth() > 1 AND v_applying THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'phase6 4d-ii: "OutboxConsumerCatalog"."active" / "activationSeq" of consumer "%" are the MIRROR of the activation register, written only by its AFTER INSERT (platform_t4d_activation_apply) — this % UPDATE (trigger depth %, marker %) is refused. To change a consumer''s state, APPEND a fact through the operator protocol (`outbox:consumer`); the head lock derives the sequence and the apply moves the mirror (companion document, "The register"; #580 round 1, finding 6).',
      OLD."consumer",
      CASE WHEN pg_trigger_depth() > 1 THEN 'nested' ELSE 'direct' END,
      pg_trigger_depth(),
      CASE WHEN v_applying THEN 'on' ELSE 'off' END;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxConsumerCatalog_t4d_rules" ON "OutboxConsumerCatalog";
CREATE TRIGGER "OutboxConsumerCatalog_t4d_rules" BEFORE UPDATE ON "OutboxConsumerCatalog"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_catalog_rules();
