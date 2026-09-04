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
  target text;
BEGIN
  declared := current_setting('vitan.decisions_inbox_catalog_version', true);
  IF declared IS NOT NULL AND declared = '2' THEN
    RETURN NULL;
  END IF;
  -- DELETE IS FENCED TOO (Codex on `6b3ff9e6`). An undeclared writer that REMOVES a row leaves the
  -- generation incomplete without changing any row that survives, so an insert/update-only fence
  -- reads it as untouched: with the checkpoint at the stream head, `readServableGeneration` then
  -- serves a register that silently hides the deleted decision. That is the same completeness
  -- defect `projection-rebuild-upgrade.test.ts` exists for, arriving by a different door. On DELETE
  -- the row being written no longer has a NEW, so the generation comes from OLD.
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD."generationId" ELSE NEW."generationId" END;
  -- Stamp ONCE. The relay holds this generation row FOR UPDATE for the duration of its own
  -- transaction (`lockActiveGeneration`), so this UPDATE never waits on anyone else and never
  -- deadlocks: it is the same row, already locked by the transaction we are running inside.
  UPDATE "ProjectionGeneration"
     SET "fencedAt" = now()
   WHERE "id" = target AND "fencedAt" IS NULL;
  RETURN NULL;
END;
$fence$;

DROP TRIGGER IF EXISTS "DecisionProjection_4c_iiir_writer_fence" ON "DecisionProjection";
CREATE TRIGGER "DecisionProjection_4c_iiir_writer_fence"
AFTER INSERT OR UPDATE OR DELETE ON "DecisionProjection"
FOR EACH ROW EXECUTE FUNCTION phase6_4c_iiir_fence_decision_projection_write();

-- THE STAMP IS EVIDENCE, SO IT IS SEALED (Codex on `6b3ff9e6`). A stamp any writer can clear is not
-- evidence: `UPDATE "ProjectionGeneration" SET "fencedAt" = NULL` returned the generation to
-- servable, and the legacy-shaped rows with it — measured. Once set, the stamp cannot be cleared or
-- moved. The legitimate reset is a REBUILD, which builds a NEW generation and leaves this one
-- retired, so nothing correct needs to unset it. Every other column stays freely updatable: the
-- relay's `appliedPosition`/`cursorStatus` and the rebuilder's activation swap do not touch it.
CREATE OR REPLACE FUNCTION phase6_4c_iiir_fence_stamp_sealed()
RETURNS trigger
LANGUAGE plpgsql
AS $sealed$
BEGIN
  IF OLD."fencedAt" IS NOT NULL
     AND (NEW."fencedAt" IS NULL OR NEW."fencedAt" <> OLD."fencedAt") THEN
    RAISE EXCEPTION
      'the 4c-iii-r writer-fence stamp on generation % is append-only: it records that a session which did not declare this release''s serializer wrote into it, and clearing it would make those rows servable again. Rebuild the projection instead — that builds a new generation.',
      OLD."id";
  END IF;
  RETURN NEW;
END;
$sealed$;

DROP TRIGGER IF EXISTS "ProjectionGeneration_4c_iiir_fence_stamp_sealed" ON "ProjectionGeneration";
CREATE TRIGGER "ProjectionGeneration_4c_iiir_fence_stamp_sealed"
BEFORE UPDATE ON "ProjectionGeneration"
FOR EACH ROW EXECUTE FUNCTION phase6_4c_iiir_fence_stamp_sealed();

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
     AND ((c.relname = 'DecisionProjection'
           AND t.tgname = 'DecisionProjection_4c_iiir_writer_fence'
           AND p.proname = 'phase6_4c_iiir_fence_decision_projection_write'
           AND t.tgtype = 29)                       -- ROW(1) + INSERT(4) + DELETE(8) + UPDATE(16), AFTER
       OR (c.relname = 'ProjectionGeneration'
           AND t.tgname = 'ProjectionGeneration_4c_iiir_fence_stamp_sealed'
           AND p.proname = 'phase6_4c_iiir_fence_stamp_sealed'
           AND t.tgtype = 19))                      -- ROW(1) + BEFORE(2) + UPDATE(16)
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgqual IS NULL                           -- no WHEN predicate can narrow either of them
     AND p.proconfig IS NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION
      '4c-iii-r writer fence did not install (found % of the 2 required triggers). The deploy is refused rather than starting with an unfenced — or an unsealed — decisions.inbox register.', n;
  END IF;
END
$verify$;

COMMIT;
