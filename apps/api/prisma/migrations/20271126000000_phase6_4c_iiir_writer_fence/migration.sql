-- Phase 6 unit 4c-iii-r — THE WRITER FENCE.
--
-- WHAT THIS CLOSES. `20271125000000` seals the marker; the repair step rebuilds the register and
-- verifies it. Neither stops the case the drain prerequisite exists for: a previous-release relay
-- that was ALREADY RUNNING when the migration landed. The consumer-catalog startup fence
-- (`syncConsumerCatalog` throwing on a version difference) only asks a process at ITS start, and
-- `ProjectionGeneration.catalogVersion` only fences a generation a previous release BUILDS. An
-- already-running v1 relay goes on applying events into an EXISTING catalog-version-2 generation
-- with the v1 serializer, and it can do so the instant the repair releases its locks.
--
-- WHY A COLUMN AND NOT `cursorStatus`. `OutboxRelay.dispatchProjection` writes
-- `cursorStatus = 'live'` itself, in the same transaction, immediately after the projection handler
-- returns. A fence written there is erased by the very transaction it fences. `fencedAt` is a column
-- the previous release does not know exists, so nothing it writes can clear it.
--
-- WHY IT DOES NOT REJECT THE WRITE. Raising here would abort the legacy relay's delivery, which
-- retries, dead-letters at `MAX_ATTEMPTS`, and then blocks the generation on that dead position —
-- trading silent corruption for a projection that needs an operator after every rolling deploy. This
-- stamps instead: the write succeeds, the generation stops being SERVABLE the moment it is touched
-- (`readServableGeneration` refuses a fenced generation and the read path falls back to canonical,
-- which is always current), and the next deploy's repair rebuilds it. Corruption is never served,
-- and no delivery is lost.
--
-- ADDITIVE AND ROW-SAFE: one nullable column, one function, one trigger. It stamps nothing on
-- existing rows, and a deployment whose writers all declare their serializer never trips it.

BEGIN;

ALTER TABLE "ProjectionGeneration" ADD COLUMN IF NOT EXISTS "fencedAt" TIMESTAMP(3);

-- The declaration this release's projection writer makes, inside its own transaction, with
-- `set_config(..., true)` so it is LOCAL and cannot leak to another session's write.
CREATE OR REPLACE FUNCTION phase6_4c_iiir_fence_decision_projection_write()
RETURNS trigger
LANGUAGE plpgsql
AS $fence$
DECLARE
  declared text;
BEGIN
  declared := current_setting('vitan.decisions_inbox_catalog_version', true);
  IF declared IS NOT NULL AND declared = '2' THEN
    RETURN NULL;
  END IF;
  -- Stamp ONCE. The relay holds this generation row FOR UPDATE for the duration of its own
  -- transaction (`lockActiveGeneration`), so this UPDATE never waits on anyone else and never
  -- deadlocks: it is the same row, already locked by the transaction we are running inside.
  UPDATE "ProjectionGeneration"
     SET "fencedAt" = now()
   WHERE "id" = NEW."generationId" AND "fencedAt" IS NULL;
  RETURN NULL;
END;
$fence$;

DROP TRIGGER IF EXISTS "DecisionProjection_4c_iiir_writer_fence" ON "DecisionProjection";
CREATE TRIGGER "DecisionProjection_4c_iiir_writer_fence"
AFTER INSERT OR UPDATE ON "DecisionProjection"
FOR EACH ROW EXECUTE FUNCTION phase6_4c_iiir_fence_decision_projection_write();

-- FAIL CLOSED ON ITS OWN INSTALLATION. A migration that silently did not install the fence would be
-- worse than one that never ran: the deploy would report success and the register would be unfenced.
DO $verify$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE ns.nspname = 'public'
     AND c.relname = 'DecisionProjection'
     AND t.tgname = 'DecisionProjection_4c_iiir_writer_fence'
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND p.proname = 'phase6_4c_iiir_fence_decision_projection_write'
     AND p.proconfig IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION
      '4c-iii-r writer fence did not install (found % matching trigger(s), expected 1). The deploy is refused rather than starting with an unfenced decisions.inbox register.', n;
  END IF;
END
$verify$;

COMMIT;
