-- Guided site inspections, step 3b (proposal approved by Jagrut, 5 Nov 2026: "checklists show on the site visit"): the
-- database half of "this inspection was walked on this visit". It ships alone, before any server or screen uses it.
--
-- WHAT. One new table, "SiteVisitInspection": an inspection walked during a site visit, who walked it, and when the
-- link was made. One row per inspection ("inspectionId" is the key), so an inspection was walked on at most one visit.
-- A re-inspection is its own inspection and gets its own row when it is walked. Every link is a composite
-- (projectId, x) foreign key, the shape every project-owned link uses, so no writer can put another project's
-- inspection on a visit, or an inspection on another project's visit.
--
-- WHY A LINK TABLE, OWNED BY SITE VISITS. A visit already holds its files through "SiteVisitMedia", a link the
-- site-visits module writes as the media upload's participant. An inspection walked on a visit is held the same way:
-- the site-visits module writes this row as the inspection submit's participant (step 3c), under the visit's row lock,
-- so the inspections module never writes a site-visit table, and "Inspection" itself is not altered.
--
-- THE ROW IS A RECORD. What the database guarantees for every writer, raw SQL included:
--   L1  Stamped. "linkedAt" is the database's receipt time (`site_visits_now()`), whatever the writer sent.
--   L2  Frozen. Nothing in a row changes after it is written: an inspection is never moved to another visit.
--   L3  Never removed on its own. A row goes only with its visit or its inspection (their ON DELETE CASCADE, which runs
--       below trigger depth 1) or its project; a direct DELETE is refused, and TRUNCATE is refused outside the
--       sanctioned test reset, as the other visit tables are.
--
-- WHAT THIS FILE DOES NOT DO. Who may link a walk to a visit, and when (the visitor or someone present on it, while the
-- visit is not closed, in the same transaction as the inspection's submit), is the server unit's rule (step 3c).
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the table: nothing reads or writes it, and no
-- statement of the previous release changes because it exists. Deleting a visit or an inspection (a project's removal)
-- cascades through it below trigger depth 1, which L3 lets through.
--
-- LOCKS WHILE IT RUNS. A new table: its three foreign keys take SHARE ROW EXCLUSIVE on "SiteVisit", "Inspection" and
-- "User" for the length of this short transaction (no rows to validate). No lock is waited for longer than 15 s
-- (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline models
-- the table but not the triggers). IF NOT EXISTS with a shape guard, constraints added when missing, functions replaced,
-- triggers dropped and re-made. Schema-qualified, with a fixed search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."SiteVisitInspection" (
  "projectId"    TEXT NOT NULL,
  "visitId"      TEXT NOT NULL,
  "inspectionId" TEXT NOT NULL,
  "linkedById"   TEXT NOT NULL,
  "linkedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteVisitInspection_pkey" PRIMARY KEY ("inspectionId")
);

-- A table that already stands with another shape (a db-push baseline drifted from schema.prisma) is refused, not kept.
DO $site_visit_inspections$
DECLARE
  c record;
  n integer;
BEGIN
  FOR c IN
    SELECT w.name, w.want_type, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull
      FROM (VALUES ('projectId', 'text'), ('visitId', 'text'), ('inspectionId', 'text'), ('linkedById', 'text'),
                   ('linkedAt', 'timestamp(3) without time zone')) AS w(name, want_type)
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = 'public."SiteVisitInspection"'::regclass AND a.attname = w.name AND NOT a.attisdropped
  LOOP
    IF c.typ IS DISTINCT FROM c.want_type OR c.notnull IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'SiteVisitInspection.% already stands as % (not null: %), not % (not null)', c.name, c.typ, c.notnull, c.want_type;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public."SiteVisitInspection"'::regclass AND attnum > 0 AND NOT attisdropped;
  IF n <> 5 THEN
    RAISE EXCEPTION 'SiteVisitInspection already stands with % columns, not 5', n;
  END IF;
END $site_visit_inspections$;

CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitInspection_projectId_inspectionId_key"
  ON public."SiteVisitInspection"("projectId", "inspectionId");
CREATE INDEX IF NOT EXISTS "SiteVisitInspection_projectId_visitId_idx"
  ON public."SiteVisitInspection"("projectId", "visitId");

DO $site_visit_inspections_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitInspection_projectId_visitId_fkey'
                   AND conrelid = 'public."SiteVisitInspection"'::regclass) THEN
    ALTER TABLE public."SiteVisitInspection" ADD CONSTRAINT "SiteVisitInspection_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES public."SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitInspection_projectId_inspectionId_fkey'
                   AND conrelid = 'public."SiteVisitInspection"'::regclass) THEN
    ALTER TABLE public."SiteVisitInspection" ADD CONSTRAINT "SiteVisitInspection_projectId_inspectionId_fkey"
      FOREIGN KEY ("projectId", "inspectionId") REFERENCES public."Inspection"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'SiteVisitInspection_linkedById_fkey'
                   AND conrelid = 'public."SiteVisitInspection"'::regclass) THEN
    ALTER TABLE public."SiteVisitInspection" ADD CONSTRAINT "SiteVisitInspection_linkedById_fkey"
      FOREIGN KEY ("linkedById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $site_visit_inspections_keys$;

-- L1: the receipt stamp, set on every insert whatever the writer sent.
CREATE OR REPLACE FUNCTION public.site_visits_inspection_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."linkedAt" := public.site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitInspection_insert" ON public."SiteVisitInspection";
CREATE TRIGGER "SiteVisitInspection_insert"
  BEFORE INSERT ON public."SiteVisitInspection"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_inspection_insert();

-- L2: frozen, with no exception.
CREATE OR REPLACE FUNCTION public.site_visits_inspection_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'site-visits: the inspection % walked on visit % is a record and is not changed', OLD."inspectionId", OLD."visitId"
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS "SiteVisitInspection_frozen" ON public."SiteVisitInspection";
CREATE TRIGGER "SiteVisitInspection_frozen"
  BEFORE UPDATE ON public."SiteVisitInspection"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_inspection_frozen();

-- L3: a row goes only with its visit, its inspection or its project. Each is a foreign-key cascade, which runs below
-- trigger depth 1; a direct DELETE is depth 1. TRUNCATE is refused by SV1-a's seal function, which the sanctioned reset
-- disables by name.
CREATE OR REPLACE FUNCTION public.site_visits_inspection_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'site-visits: the inspection % walked on visit % is part of the visit record; it goes only with the visit, the inspection or its project',
      OLD."inspectionId", OLD."visitId";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitInspection_no_delete" ON public."SiteVisitInspection";
CREATE TRIGGER "SiteVisitInspection_no_delete"
  BEFORE DELETE ON public."SiteVisitInspection"
  FOR EACH ROW EXECUTE FUNCTION public.site_visits_inspection_no_delete();

DROP TRIGGER IF EXISTS "SiteVisitInspection_no_truncate" ON public."SiteVisitInspection";
CREATE TRIGGER "SiteVisitInspection_no_truncate"
  BEFORE TRUNCATE ON public."SiteVisitInspection"
  FOR EACH STATEMENT EXECUTE FUNCTION public.site_visits_no_truncate();

COMMIT;
