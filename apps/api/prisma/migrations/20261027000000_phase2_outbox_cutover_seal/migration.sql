-- Phase 2 fix-forward PR C Task 3 — the audited external-effect cutover SEAL (database side).
--
-- The seal is a FORWARD gate, never a rewrite. Once the singleton "OutboxCutoverState" row exists,
-- every NEW DomainEvent must carry a `dispatchIntent` — a null-intent (pre-cutover legacy) insert is
-- refused at the database, for EVERY role, so no producer can slip past the external-effect catalog
-- after cutover. Existing rows are untouched (this is a BEFORE INSERT trigger); history is preserved.
--
-- The seal TRANSACTION (in OutboxOperationsService.sealExternal) neutralizes the pre-cutover external
-- deliveries and upserts the coverage version; this migration only installs the invariant that makes
-- the sealed state self-enforcing at the row level.

CREATE OR REPLACE FUNCTION "domainEvent_seal_requires_intent"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Sealed ⇔ a singleton OutboxCutoverState row exists. While sealed, a DomainEvent with no
  -- dispatchIntent is refused: after cutover every producer must name an external-effect catalog key.
  IF NEW."dispatchIntent" IS NULL
     AND EXISTS (SELECT 1 FROM "OutboxCutoverState" WHERE "key" = 'singleton') THEN
    RAISE EXCEPTION 'external-effect cutover is sealed: a DomainEvent without dispatchIntent is not permitted (eventId=%). Every producer must name an external-effect catalog key.', NEW."eventId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DomainEvent_seal_requires_intent"
  BEFORE INSERT ON "DomainEvent"
  FOR EACH ROW EXECUTE FUNCTION "domainEvent_seal_requires_intent"();
