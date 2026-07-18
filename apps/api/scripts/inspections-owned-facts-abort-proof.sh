#!/usr/bin/env bash
# Phase 2 Task 10 (Module 3) correction — the inspection-owned-facts migration
# ABORT → REPAIR → REDEPLOY proof.
#
# Builds a database at the point JUST BEFORE this correction's migration (every migration except
# 20261120000000_phase2_inspections_owned_facts), plants a legacy fixture that holds the ONE
# containment gap the composite (inspectionId, inspectionItemId) FK on Media cannot catch — a Media
# evidence row carrying an inspectionItemId but a NULL inspectionId (MATCH SIMPLE disables the FK when
# a member is NULL). To plant it we must first drop the app-era CHECK that normally forbids it, exactly
# modelling a database that predates that guard. Then:
#   1. applies the migration                     → the diagnostic must ABORT (never guess a repair);
#   2. repairs ONLY the offending row (set its inspectionId — the operator's documented repair);
#   3. re-applies the migration                  → must SUCCEED;
#   4. asserts the backfill: activityName copied from the linked Activity, and InspectionEvidence links
#      materialized for BOTH item-level evidence rows (the pre-existing good one + the repaired one).
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_inspections_abort_proof). Connection comes
# from the standard PG* variables; the dev container uses PGUSER=vitan PGPASSWORD=vitan.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

DB="${INSPECTIONS_ABORT_PROOF_DB:-pmcvitan_inspections_abort_proof}"
MIG_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"
MIG="20261120000000_phase2_inspections_owned_facts"

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -q -v ON_ERROR_STOP=1 -d $DB"

echo "=== inspections-abort-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

echo "=== applying every migration EXCEPT the correction ($MIG) ==="
applied=0
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  [ "$name" = "$MIG" ] && continue
  $PSQL -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
  applied=$((applied + 1))
done
echo "applied $applied migrations (the correction held back)"

echo "=== planting a legacy fixture with the un-linkable containment gap ==="
$PSQL <<'SQL' || { echo "fixture failed"; exit 1; }
INSERT INTO "Org" ("id","name","slug") VALUES ('o-iof','IOF Org','iof-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p-iof','o-iof','IOF Site','IO','','Finishing','IO-01','01 Jan 2026','31 Dec 2026',0,0,0);
-- the linked Activity whose name the correction stamps onto the inspection-owned activityName column
INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status")
  VALUES ('ACT-iof','p-iof','Ponding test','Terrace',0,5,'in_progress');
-- an inspection carrying the requirement edge to that Activity, plus one item
INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","submitted","decided","activityId")
  VALUES ('INSP-iof','p-iof','checklist','Waterproofing check','Terrace','21 Jun 2026',false,false,'ACT-iof');
INSERT INTO "InspectionItem" ("id","inspectionId","name","photos")
  VALUES ('IT-iof','INSP-iof','Membrane lapped',1);
-- GOOD item-level evidence (both ids set — exactly what the serializer counted as evidence)
INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy","inspectionId","inspectionItemId")
  VALUES ('M-good','p-iof','inspection','image/png','u','INSP-iof','IT-iof');
-- the un-linkable containment gap: item link with a NULL inspection. The app-era CHECK forbids it, so we
-- drop that guard first to model a database that predates it (or where MATCH SIMPLE let it through).
ALTER TABLE "Media" DROP CONSTRAINT "Media_item_requires_inspection";
INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy","inspectionId","inspectionItemId")
  VALUES ('M-bad','p-iof','inspection','image/png','u',NULL,'IT-iof');
SQL
echo "planted (M-good has both ids; M-bad carries IT-iof with a NULL inspectionId)"

echo ""
echo "=== 1. applying the correction over the containment gap — expect ABORT ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/iof-abort.log 2>&1; then
  echo "FAILED: the migration should have ABORTED on the un-linkable containment gap but succeeded"; exit 1
fi
if grep -q "un-linkable legacy containment" /tmp/iof-abort.log; then
  echo "ok  the diagnostic aborted naming the count (no guessed repair, no discarded data)"
else
  echo "FAILED: the migration aborted for the WRONG reason:"; cat /tmp/iof-abort.log; exit 1
fi
# the single transaction rolled the whole migration back — no half-applied schema survives
survived=$($PSQL -tAc "SELECT to_regclass('public.\"InspectionEvidence\"') IS NOT NULL;")
if [ "$survived" = "t" ]; then echo "FAILED: InspectionEvidence table leaked past the aborted transaction"; exit 1; fi
echo "ok  the aborted migration left no half-applied schema (single-transaction rollback)"

echo ""
echo "=== 2. repairing ONLY the offending row (set its inspectionId — the documented repair) ==="
$PSQL -c "UPDATE \"Media\" SET \"inspectionId\"='INSP-iof' WHERE \"id\"='M-bad';" || exit 1

echo "=== 3. re-applying the correction — expect SUCCESS ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/iof-redeploy.log 2>&1; then
  echo "ok  redeploy succeeded after the row was repaired"
else
  echo "FAILED: redeploy failed after the repair:"; cat /tmp/iof-redeploy.log; exit 1
fi

echo ""
echo "=== 4. asserting the backfill (activityName + InspectionEvidence links) ==="
name=$($PSQL -tAc "SELECT \"activityName\" FROM \"Inspection\" WHERE \"id\"='INSP-iof';")
if [ "$name" = "Ponding test" ]; then
  echo "ok  Inspection.activityName backfilled from the linked Activity ('Ponding test')"
else
  echo "FAILED: expected activityName 'Ponding test' got '$name'"; exit 1
fi
links=$($PSQL -tAc "SELECT string_agg(\"mediaId\", ',' ORDER BY \"mediaId\") FROM \"InspectionEvidence\" WHERE \"inspectionItemId\"='IT-iof';")
if [ "$links" = "M-bad,M-good" ]; then
  echo "ok  InspectionEvidence materialized both item-level evidence rows (M-good + repaired M-bad)"
else
  echo "FAILED: expected evidence links [M-bad,M-good] got [$links]"; exit 1
fi

echo ""
echo "INSPECTIONS ABORT PROOF PASSED: the migration aborts on the un-linkable containment gap, and a repaired fixture redeploys cleanly with activityName + evidence links backfilled."
