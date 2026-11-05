-- Guided site inspections, step 1 of 5 (proposal https://claude.ai/artifact/XgdBmLn211SuJpMoTT5cUv; Jagrut's yes
-- 5 Nov 2026; Board ask #1094 6653010462). A database change shipped alone, before any server code reads or writes it.
-- Nothing is backfilled: every existing checklist item keeps its plain name and shows as it does today.
--
-- WHY. A checklist item today is only a name ("Cover blocks"). A guided walk tells the person on site what to look at,
-- what good work looks like, and what to record as proof, so each issued item now carries that guidance, and each
-- checklist a work type ("RCC slab", "Waterproofing") named as Hub's stages and BOQ groups name it.
--
-- WHAT. On "InspectionItem", six nullable columns:
--   "lookAt"      what to look at, one plain sentence;
--   "passRule"    what good looks like (the pass rule);
--   "recordKind"  the recording the item asks for: 'photo', 'video' or 'voice';
--   "recordCount" how many, 1 to 10;
--   "recordWhen"  when it is required: 'always' (a pass needs it too) or 'fail' (only a fail needs it);
--   "recordHint"  an optional hint on how to take it ("hold a tape against the steel").
-- On "Inspection", one nullable column, "workType".
-- Three CHECKs:
--   "InspectionItem_guidance_text": "lookAt" and "passRule", when given, hold more than whitespace (the full ASCII set,
--     E' \t\n\x0B\f\r') and are at most 500 characters;
--   "InspectionItem_record_spec": the record spec is whole or absent: kind, count and when all NULL (and then no hint),
--     or all three set (each named NOT NULL, since a NULL inside the second branch would let a partial spec pass) to
--     allowed values; a hint, when given, holds more than whitespace and is at most 300 characters;
--   "Inspection_work_type_text": "workType", when given, holds more than whitespace and is at most 64 characters.
-- One trigger, "InspectionItem_guidance_fixed": an issued item's guidance and record spec are what the checklist asked,
-- so once an item row exists no UPDATE changes them (setting a column to its own value passes). A pass is judged against
-- the rule it was issued with; changing the rule after the walk would rewrite what the pass meant. Library templates are
-- edited in the library, never on issued items. The trigger guards UPDATE only: nothing deletes an item today, and an item
-- with proof photos cannot be deleted (Media's NO ACTION key). Every writer that issues items (create, re-inspection,
-- project set-up from a template) must therefore write the guidance in the same INSERT; it can never be added later.
-- A trigger column list pins those columns' types: a later file that changes one drops and re-creates this trigger.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names any of these columns: its inserts leave them NULL,
-- which every CHECK accepts, and its item updates (state, photos, note, result, swatch, rejected) set none of them, so the
-- trigger (BEFORE UPDATE OF the guarded columns only) never fires for them. No existing trigger on "Inspection" or
-- "InspectionItem" reads a whole row or these columns.
--
-- LOCKS WHILE IT RUNS. The file first takes ACCESS EXCLUSIVE on "Inspection" and then "InspectionItem", in one LOCK
-- TABLE, parent before child as the app writes them (an inspection, then its items), so a checklist being issued during
-- the deploy waits instead of deadlocking with it (gap-check: child-first ADD COLUMN deadlocked against a live create).
-- Both are held until COMMIT, so inspection reads and writes wait for the whole file. Each CHECK validates in one pass where every row is
-- NULL; today's tables are small. No lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT. The columns are added when missing; a column already standing under
-- any of these names must be of this file's nullable type, or the file stops with an error rather than keep it. The
-- CHECKs are dropped and added again on every run, so the tables end with exactly these definitions, validated against
-- every row. The trigger function is CREATE OR REPLACE and the trigger is dropped and created again. A db-push baseline
-- models the columns but not the CHECKs or the trigger, so the file is on `scripts/migrate.sh`'s ALWAYS_EXECUTE.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true);

LOCK TABLE public."Inspection", public."InspectionItem" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "workType" TEXT;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "lookAt" TEXT;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "passRule" TEXT;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "recordKind" TEXT;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "recordCount" INTEGER;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "recordWhen" TEXT;
ALTER TABLE public."InspectionItem" ADD COLUMN IF NOT EXISTS "recordHint" TEXT;

DO $inspection_guidance$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT n.tbl, n.name, n.want, a.atttypid::regtype::text AS typ, a.attnotnull AS notnull, a.atthasdef AS hasdef
      FROM (VALUES ('InspectionItem', 'lookAt', 'text'), ('InspectionItem', 'passRule', 'text'),
                   ('InspectionItem', 'recordKind', 'text'), ('InspectionItem', 'recordCount', 'integer'),
                   ('InspectionItem', 'recordWhen', 'text'), ('InspectionItem', 'recordHint', 'text'),
                   ('Inspection', 'workType', 'text')) AS n(tbl, name, want)
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = pg_catalog.format('public.%I', n.tbl)::regclass AND a.attname = n.name AND NOT a.attisdropped
  LOOP
    IF c.typ IS DISTINCT FROM c.want OR c.notnull OR c.hasdef THEN
      RAISE EXCEPTION '%.% already stands as % (not null: %, default: %), not a nullable % column without a default',
        c.tbl, c.name, c.typ, c.notnull, c.hasdef, c.want;
    END IF;
  END LOOP;
END $inspection_guidance$;

ALTER TABLE public."InspectionItem"
  DROP CONSTRAINT IF EXISTS "InspectionItem_guidance_text",
  ADD CONSTRAINT "InspectionItem_guidance_text" CHECK (
    ("lookAt" IS NULL
     OR (pg_catalog.btrim("lookAt", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("lookAt") <= 500))
    AND ("passRule" IS NULL
     OR (pg_catalog.btrim("passRule", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("passRule") <= 500)));

ALTER TABLE public."InspectionItem"
  DROP CONSTRAINT IF EXISTS "InspectionItem_record_spec",
  ADD CONSTRAINT "InspectionItem_record_spec" CHECK (
    ("recordKind" IS NULL AND "recordCount" IS NULL AND "recordWhen" IS NULL AND "recordHint" IS NULL)
    OR ("recordKind" IS NOT NULL AND "recordCount" IS NOT NULL AND "recordWhen" IS NOT NULL
        AND "recordKind" IN ('photo', 'video', 'voice')
        AND "recordCount" BETWEEN 1 AND 10
        AND "recordWhen" IN ('always', 'fail')
        AND ("recordHint" IS NULL
             OR (pg_catalog.btrim("recordHint", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("recordHint") <= 300))));

ALTER TABLE public."Inspection"
  DROP CONSTRAINT IF EXISTS "Inspection_work_type_text",
  ADD CONSTRAINT "Inspection_work_type_text" CHECK (
    "workType" IS NULL
    OR (pg_catalog.btrim("workType", E' \t\n\x0B\f\r') <> '' AND pg_catalog.char_length("workType") <= 64));

CREATE OR REPLACE FUNCTION public.inspection_item_guidance_fixed() RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW."lookAt" IS DISTINCT FROM OLD."lookAt"
     OR NEW."passRule" IS DISTINCT FROM OLD."passRule"
     OR NEW."recordKind" IS DISTINCT FROM OLD."recordKind"
     OR NEW."recordCount" IS DISTINCT FROM OLD."recordCount"
     OR NEW."recordWhen" IS DISTINCT FROM OLD."recordWhen"
     OR NEW."recordHint" IS DISTINCT FROM OLD."recordHint" THEN
    RAISE EXCEPTION 'inspection item % keeps the guidance it was issued with; it is never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS "InspectionItem_guidance_fixed" ON public."InspectionItem";
CREATE TRIGGER "InspectionItem_guidance_fixed"
  BEFORE UPDATE OF "lookAt", "passRule", "recordKind", "recordCount", "recordWhen", "recordHint"
  ON public."InspectionItem"
  FOR EACH ROW EXECUTE FUNCTION public.inspection_item_guidance_fixed();

COMMIT;
