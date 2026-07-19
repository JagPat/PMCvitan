#!/usr/bin/env bash
# Phase 2 Task 10 (Module 3) correction round 2, F1 — the InspectionEvidence tenant-FK migration
# ABORT → REPAIR → REDEPLOY proof.
#
# Builds a database at the point JUST BEFORE the round-2 migration (every migration except
# 20261125000000_phase2_inspection_evidence_tenant_fk), plants a CROSS-PROJECT evidence link — a
# project-A InspectionEvidence row whose mediaId belongs to project B, which the ORIGINAL id-only
# FK (20261120000000, untouched) permits — then:
#   1. applies the round-2 migration            → the diagnostic must ABORT naming the count + ids;
#   2. repairs ONLY the forged link (delete it — cross-tenant garbage; the operator's documented repair);
#   3. re-applies the migration                 → must SUCCEED;
#   4. asserts the composite FK now REJECTS a fresh cross-project link, ACCEPTS a same-project one,
#      and that no forged row persists.
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_evidence_fk_abort_proof). Connection
# comes from the standard PG* variables; the dev container uses PGUSER=vitan PGPASSWORD=vitan.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

DB="${EVIDENCE_FK_ABORT_PROOF_DB:-pmcvitan_evidence_fk_abort_proof}"
MIG_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"
MIG="20261125000000_phase2_inspection_evidence_tenant_fk"

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -q -v ON_ERROR_STOP=1 -d $DB"

echo "=== evidence-fk-abort-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

echo "=== applying every migration EXCEPT the round-2 tenant FK ($MIG) ==="
applied=0
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  [ "$name" = "$MIG" ] && continue
  $PSQL -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
  applied=$((applied + 1))
done
echo "applied $applied migrations (the round-2 tenant FK held back)"

echo "=== planting a CROSS-PROJECT evidence link the id-only FK permits ==="
$PSQL <<'SQL' || { echo "fixture failed"; exit 1; }
INSERT INTO "Org" ("id","name","slug") VALUES ('o-efk','EFK Org','efk-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p-efk-a','o-efk','EFK Site A','EA','','Finishing','EA-01','01 Jan 2026','31 Dec 2026',0,0,0),
         ('p-efk-b','o-efk','EFK Site B','EB','','Finishing','EB-01','01 Jan 2026','31 Dec 2026',0,0,0);
-- project A's inspection + item (the link's inspection side is containment-valid)
INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","submitted","decided")
  VALUES ('INSP-efk-a','p-efk-a','checklist','A checklist','GF','01 Jul 2026',false,false);
INSERT INTO "InspectionItem" ("id","inspectionId","name","photos")
  VALUES ('IT-efk-a','INSP-efk-a','A item',0);
-- media in EACH project (B's is the forgery target; A's proves the repaired FK still accepts same-project)
INSERT INTO "Media" ("id","projectId","kind","mime","uploadedBy")
  VALUES ('M-efk-a','p-efk-a','inspection','image/png','u'),
         ('M-efk-b','p-efk-b','inspection','image/png','u');
-- the FORGED link: project A evidence referencing project B's media — the id-only FK accepts this
INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId")
  VALUES ('IE-forged','p-efk-a','INSP-efk-a','IT-efk-a','M-efk-b');
SQL
echo "planted (IE-forged: projectId p-efk-a, mediaId M-efk-b of p-efk-b)"

echo ""
echo "=== 1. applying the round-2 migration over the forged link — expect ABORT ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/efk-abort.log 2>&1; then
  echo "FAILED: the migration should have ABORTED on the cross-project link but succeeded"; exit 1
fi
if grep -q "media of ANOTHER project" /tmp/efk-abort.log && grep -q "IE-forged" /tmp/efk-abort.log; then
  echo "ok  the diagnostic aborted naming the count AND the affected id (no guessed repair)"
else
  echo "FAILED: the migration aborted for the WRONG reason:"; cat /tmp/efk-abort.log; exit 1
fi
# the single transaction rolled everything back — the OLD id-only FK is still in place
def=$($PSQL -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='InspectionEvidence_media_fkey';")
case "$def" in
  *'FOREIGN KEY ("mediaId")'*) echo "ok  the aborted migration left the original id-only FK intact (single-transaction rollback)";;
  *) echo "FAILED: unexpected FK state after abort: $def"; exit 1;;
esac

echo ""
echo "=== 2. repairing ONLY the forged link (delete it — cross-tenant garbage) ==="
$PSQL -c "DELETE FROM \"InspectionEvidence\" WHERE \"id\"='IE-forged';" || exit 1

echo "=== 3. re-applying the migration — expect SUCCESS ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/efk-redeploy.log 2>&1; then
  echo "ok  redeploy succeeded after the forged link was removed"
else
  echo "FAILED: redeploy failed after the repair:"; cat /tmp/efk-redeploy.log; exit 1
fi

echo ""
echo "=== 4. adversarial assertions on the repaired database ==="
# a fresh cross-project link must be REJECTED by the composite FK
if $PSQL -c "INSERT INTO \"InspectionEvidence\" (\"id\",\"projectId\",\"inspectionId\",\"inspectionItemId\",\"mediaId\") VALUES ('IE-forge2','p-efk-a','INSP-efk-a','IT-efk-a','M-efk-b');" >/tmp/efk-forge2.log 2>&1; then
  echo "FAILED: a cross-project link was ACCEPTED after the migration"; exit 1
fi
grep -q "violates foreign key constraint" /tmp/efk-forge2.log || { echo "FAILED: rejection was not the FK:"; cat /tmp/efk-forge2.log; exit 1; }
echo "ok  a fresh cross-project link is rejected by the composite FK"
# a same-project link must still be ACCEPTED
$PSQL -c "INSERT INTO \"InspectionEvidence\" (\"id\",\"projectId\",\"inspectionId\",\"inspectionItemId\",\"mediaId\") VALUES ('IE-ok','p-efk-a','INSP-efk-a','IT-efk-a','M-efk-a');" || { echo "FAILED: a same-project link was rejected"; exit 1; }
echo "ok  a same-project link is accepted"
# no forged row persists
count=$($PSQL -tAc "SELECT COUNT(*) FROM \"InspectionEvidence\" ie JOIN \"Media\" m ON m.\"id\"=ie.\"mediaId\" WHERE ie.\"projectId\" <> m.\"projectId\";")
if [ "$count" = "0" ]; then echo "ok  zero cross-project links persist"; else echo "FAILED: $count cross-project link(s) persist"; exit 1; fi

echo ""
echo "EVIDENCE TENANT-FK ABORT PROOF PASSED: the migration aborts naming the forged link, a repaired fixture redeploys, and the composite FK rejects cross-project references while accepting same-project ones."
