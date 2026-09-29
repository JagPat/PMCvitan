-- Phase 6 task 4d unit 4d-ii-a / A7c — `decisions.inbox` v3: the DURABLE contract version and the
-- writer fence that reads it (the plan's §D: "the two changed consumers' DURABLE contract versions
-- bumped ... `decisions.inbox` (2 → 3) — with the `OutboxConsumerCatalog` rows ... migrated in
-- 4d-ii's OWN catalog-data migration (the 4c-ii precedent, `20271116000000_phase6_t4c_ii_rollout_fence`)";
-- the staging document's A7 note: "A7c, `decisions.inbox` v3: ... `catalogVersion` 3, the writer
-- fence's GUC and function; the `ProjectionGeneration` row; `ALWAYS_EXECUTE`").
--
-- WHY A MIGRATION AT ALL (the `20271205000000_inspections_inbox_v2_assignee` precedent). This unit
-- changes one COMPILED number, and `syncConsumerCatalog` refuses to reinterpret a persisted consumer
-- row silently: it CREATEs a missing row and ASSERTs an existing one, never UPDATEs. Without this file
-- every upgraded process aborts at bootstrap with `contract drift for 'decisions.inbox'`. The compiled
-- contract and the persisted version land in the same deployment or one of them is wrong.
--
-- WHAT THE VERSION IS FOR. Version 2 (4c-ii) declared the consultation fold. Since then the stored
-- `DecisionDto` changed MEANING without a version of its own: `approvalCycle` counts FINALIZED
-- approvals only (A4a), a non-`standard` change request names its `origin` (A5e), the status set
-- admits `awaiting_countersign` and the holder a forward installs is re-derived from the canonical row
-- on every fold (A8a's commands write them). A generation a version-2 serializer built, or that a
-- still-running version-2 relay goes on writing, can hold rows this release would not produce — a
-- cycle a provisional approval already advanced, a rejection served as a plain change, an awaiting
-- decision read as approved — and nothing on the rows says so. Stamping 3 makes such a generation
-- non-servable (`readServableGeneration` refuses `catalogVersion < catalogVersionFor`), so the module
-- read falls back to the CANONICAL live slice, which is always current and always carries every
-- field. Nothing is lost and no repair step is required — the ordinary `projection:rebuild` stamps a
-- fresh generation at 3 and the projection resumes serving. Existing `ProjectionGeneration` rows keep
-- the version they were BUILT at (20271116000000 backfilled the column and installed the stamp): a
-- row rewritten to 3 here would claim a serializer that never wrote it, so none is touched.
--
-- THE WRITER FENCE MOVES WITH IT. `20271126000000` stamps `ProjectionGeneration.fencedAt` when a
-- session that has not declared THIS release's serializer writes a `DecisionProjection` row — and it
-- read the declaration as the literal `'2'`. Left as it was, a previous-release relay declaring `2`
-- would go on writing its rows into a live generation unfenced while this release's writer, declaring
-- `3`, would be stamped as the intruder: the fence pointed the wrong way. Both fence functions are
-- therefore RE-ISSUED here with `'3'`, bodies otherwise byte-identical to 20271126000000's (the
-- `$fence$` / `$truncate$` literals below are what `verifyWriterFence` compares `prosrc` against —
-- `inbox-repair-seals.ts` reads them from THIS file, the latest re-issue, and the stamp seal's from the
-- original). A version-2 declaration now stamps exactly as an undeclared write does, which is the
-- drain: the still-running previous release marks the generation the moment it touches it, every
-- reader (both releases refuse a fenced generation) falls back to canonical, and the next deploy's
-- repair rebuilds.
--
-- ORDERING. `migrate.sh` applies this before the new processes start, so an already-running
-- previous-release worker keeps serving canonical reads (its projection reads fall back the moment
-- its own writes fence the generation), and it can never come back after a restart. `ALWAYS_EXECUTE`
-- lists this file for the same reason it lists 20271126000000: a P3005 baseline replays the fence's
-- installing migration, which re-issues the `'2'` bodies, and only a later file on the same list can
-- re-issue the `'3'` ones — the ledger order stands (the A4a and A7a precedent). Guarded on the version
-- it moves FROM, so a re-run is a no-op rather than a second bump, and a database whose consumers were
-- never registered (a fresh install, where `syncConsumerCatalog` will CREATE the row at the compiled
-- version) is untouched. `webpush.notify`'s bump is A7d's, with the catalog change it belongs to.
--
-- No table, column, trigger or index changes; the catalog row's `catalogVersion` is the one data
-- move. The A6b rules trigger admits it (it freezes `registeredAt`, gates the mirror pair and seals
-- the rule columns; the version is the contract `syncConsumerCatalog` asserts and this file owns).

UPDATE "OutboxConsumerCatalog" SET "catalogVersion" = 3
 WHERE "consumer" = 'decisions.inbox' AND "catalogVersion" = 2;

-- ── the writer fence, re-issued to read this release's declaration ──────────────────────────────
-- EVERY RELATION BELOW IS SCHEMA-QUALIFIED and the functions carry NO `SET` (their `proconfig` must
-- stay NULL) — the two properties 20271126000000 states and `verifyWriterFence` checks.
CREATE OR REPLACE FUNCTION phase6_4c_iiir_fence_decision_projection_write()
RETURNS trigger
LANGUAGE plpgsql
AS $fence$
DECLARE
  declared text;
  target text;
BEGIN
  declared := current_setting('vitan.decisions_inbox_catalog_version', true);
  IF declared IS NOT NULL AND declared = '3' THEN
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
  UPDATE public."ProjectionGeneration"
     SET "fencedAt" = now()
   WHERE "id" = target AND "fencedAt" IS NULL;

  -- A ROW THAT MOVES BETWEEN GENERATIONS LEAVES ITS SOURCE (Codex on `de9fa3b7`). An UPDATE that
  -- rewrites "generationId" REMOVES the decision from the old generation just as surely as a
  -- DELETE, and stamping only the destination leaves the source caught-up and incomplete — the
  -- read path then serves a register missing that decision. Moving it to a generation id that does
  -- not exist is the sharpest form: the destination stamp updates nothing at all.
  IF TG_OP = 'UPDATE' AND NEW."generationId" IS DISTINCT FROM OLD."generationId" THEN
    UPDATE public."ProjectionGeneration"
       SET "fencedAt" = now()
     WHERE "id" = OLD."generationId" AND "fencedAt" IS NULL;
  END IF;
  RETURN NULL;
END;
$fence$;

CREATE OR REPLACE FUNCTION phase6_4c_iiir_fence_decision_projection_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $truncate$
DECLARE
  declared text;
BEGIN
  declared := current_setting('vitan.decisions_inbox_catalog_version', true);
  IF declared IS NOT NULL AND declared = '3' THEN
    RETURN NULL;
  END IF;
  UPDATE public."ProjectionGeneration" g
     SET "fencedAt" = now()
   WHERE g."fencedAt" IS NULL
     AND EXISTS (SELECT 1 FROM public."DecisionProjection" d WHERE d."generationId" = g."id");
  RETURN NULL;
END;
$truncate$;

-- FAIL CLOSED ON ITS OWN INSTALLATION. The triggers stay as 20271126000000 created them (this file
-- replaces bodies, never triggers), but a deploy that recorded this migration with the fence still
-- reading `'2'`, a trigger gone, or a catalog row left at 2 would report success and serve the wrong
-- thing on the next start — so each is asserted here, in the migration's own transaction.
DO $verify$
DECLARE
  n integer;
  stale integer;
  v_write text;
  v_truncate text;
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
           AND t.tgtype = 29)
       OR (c.relname = 'DecisionProjection'
           AND t.tgname = 'DecisionProjection_4c_iiir_writer_fence_truncate'
           AND p.proname = 'phase6_4c_iiir_fence_decision_projection_truncate'
           AND t.tgtype = 34)
       OR (c.relname = 'ProjectionGeneration'
           AND t.tgname = 'ProjectionGeneration_4c_iiir_fence_stamp_sealed'
           AND p.proname = 'phase6_4c_iiir_fence_stamp_sealed'
           AND t.tgtype = 19))
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgqual IS NULL
     AND p.proconfig IS NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION
      '4d-ii-a A7c: the decisions.inbox writer fence is not standing as 20271126000000 installed it (found % of the 3 required triggers). The deploy is refused rather than starting with an unfenced — or an unsealed — decisions.inbox register.', n;
  END IF;

  SELECT p.prosrc INTO v_write FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'phase6_4c_iiir_fence_decision_projection_write';
  SELECT p.prosrc INTO v_truncate FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'phase6_4c_iiir_fence_decision_projection_truncate';
  IF v_write IS NULL OR position('declared = ''3''' IN v_write) = 0
     OR v_truncate IS NULL OR position('declared = ''3''' IN v_truncate) = 0 THEN
    RAISE EXCEPTION
      '4d-ii-a A7c: the decisions.inbox writer fence does not read this release''s declaration (3) after the re-issue — a version-2 relay would write unfenced and this release''s writer would be stamped. The deploy is refused.';
  END IF;

  SELECT count(*) INTO stale FROM "OutboxConsumerCatalog"
   WHERE "consumer" = 'decisions.inbox' AND "catalogVersion" <> 3;
  IF stale <> 0 THEN
    RAISE EXCEPTION
      '4d-ii-a A7c: the persisted decisions.inbox contract is not at version 3 after this migration — syncConsumerCatalog would refuse every upgraded process at startup. The deploy is refused.';
  END IF;
END
$verify$;
