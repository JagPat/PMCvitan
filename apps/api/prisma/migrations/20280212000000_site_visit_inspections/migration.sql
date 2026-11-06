-- Guided site inspections, step 3b (proposal approved by Jagrut, 5 Nov 2026: "checklists show on the site visit"): the
-- database half of "this inspection was walked on this visit". It ships alone, before any server or screen uses it.
--
-- WHAT. One new table, "SiteVisitInspection": an inspection walked during a site visit, who linked it (their id, the role
-- they acted in and their name as they stood), and when the link was made. One row per inspection ("inspectionId" is the key), so an inspection was walked on at most one visit.
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
--   L4  Who, as they stood (the Board's SV2 scope: an observation "carries the actor's name and role"). The writer names
--       the role the linker acts in ("linkedByRole"); the insert checks that they hold it on the project, refuses an
--       archived project, and copies their account name into "linkedByName", through SV1-a's
--       `site_visits_standing_name`, exactly as a visit's file freezes its adder. A later rename or role change does not
--       rewrite who linked the walk.
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
-- LOCKS WHILE IT RUNS. A new table: its three foreign keys need SHARE ROW EXCLUSIVE on "User", "Inspection" and
-- "SiteVisit". All three are taken by ONE LOCK TABLE statement before any change, so the file never holds one while it
-- waits for another, and no later statement needs a stronger lock on any of them; they are held to COMMIT of this short
-- transaction (an empty table: no rows to validate). No lock is waited for longer than 15 s (lock_timeout, this
-- transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline models
-- the table but not the triggers). IF NOT EXISTS with a shape guard, constraints added when missing, functions replaced,
-- triggers dropped and re-made. Schema-qualified, with a fixed search_path.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

LOCK TABLE public."User", public."Inspection", public."SiteVisit" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public."SiteVisitInspection" (
  "projectId"    TEXT NOT NULL,
  "visitId"      TEXT NOT NULL,
  "inspectionId" TEXT NOT NULL,
  "linkedById"   TEXT NOT NULL,
  "linkedByRole" TEXT NOT NULL,
  "linkedByName" TEXT NOT NULL DEFAULT '',
  "linkedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SiteVisitInspection_pkey" PRIMARY KEY ("inspectionId")
);

-- A table that already stands with another shape (a db-push baseline drifted from schema.prisma) is refused, not kept:
-- its columns (type, NOT NULL, count) and its primary key.
DO $site_visit_inspections$
DECLARE
  c record;
  n integer;
  pk text;
BEGIN
  FOR c IN
    SELECT w.name, w.want_type, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull
      FROM (VALUES ('projectId', 'text'), ('visitId', 'text'), ('inspectionId', 'text'), ('linkedById', 'text'),
                   ('linkedByRole', 'text'), ('linkedByName', 'text'),
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
  IF n <> 7 THEN
    RAISE EXCEPTION 'SiteVisitInspection already stands with % columns, not 7', n;
  END IF;
  SELECT pg_catalog.string_agg(a.attname, ',' ORDER BY a.attname) INTO pk
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
   WHERE k.conrelid = 'public."SiteVisitInspection"'::regclass AND k.contype = 'p';
  IF pk IS DISTINCT FROM 'inspectionId' THEN
    RAISE EXCEPTION 'SiteVisitInspection already stands with primary key (%), not (inspectionId)', pk;
  END IF;
END $site_visit_inspections$;

-- L4's shape, re-issued on every run, with the whitespace set the SV1-a shape checks use
ALTER TABLE public."SiteVisitInspection"
  DROP CONSTRAINT IF EXISTS "SiteVisitInspection_shape_check",
  ADD CONSTRAINT "SiteVisitInspection_shape_check" CHECK (
    btrim("linkedByRole", E' \t\n\x0B\f\r') <> ''
    AND btrim("linkedByName", E' \t\n\x0B\f\r') <> ''
  );

CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitInspection_projectId_inspectionId_key"
  ON public."SiteVisitInspection"("projectId", "inspectionId");
CREATE INDEX IF NOT EXISTS "SiteVisitInspection_projectId_visitId_idx"
  ON public."SiteVisitInspection"("projectId", "visitId");

-- A key standing under the right name with another delete action or other columns is replaced, not kept.
DO $site_visit_inspections_keys$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitInspection"'::regclass
               AND conname = 'SiteVisitInspection_projectId_visitId_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'c' AND confrelid = 'public."SiteVisit"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("projectId", "visitId") REFERENCES "SiteVisit"("projectId", id)%')) THEN
    ALTER TABLE public."SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_projectId_visitId_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitInspection"'::regclass
               AND conname = 'SiteVisitInspection_projectId_inspectionId_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'c' AND confrelid = 'public."Inspection"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("projectId", "inspectionId") REFERENCES "Inspection"("projectId", id)%')) THEN
    ALTER TABLE public."SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_projectId_inspectionId_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public."SiteVisitInspection"'::regclass
               AND conname = 'SiteVisitInspection_linkedById_fkey'
               AND NOT (contype = 'f' AND confdeltype = 'r' AND confrelid = 'public."User"'::regclass
                        AND pg_catalog.pg_get_constraintdef(oid) LIKE 'FOREIGN KEY ("linkedById") REFERENCES "User"(id)%')) THEN
    ALTER TABLE public."SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_linkedById_fkey";
  END IF;
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

-- L4 then L1: the linker's standing and frozen name, then the receipt stamp (read after the locks are held), set on every
-- insert whatever the writer sent. The standing function locks the linker's registers, the project row and their
-- identity, the order a visit's file takes them in; step 3c's writer takes the visit row before this insert.
CREATE OR REPLACE FUNCTION public.site_visits_inspection_insert() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."linkedByName" := public.site_visits_standing_name(NEW."projectId", NEW."linkedById", NEW."linkedByRole", 'linker of an inspection');
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
