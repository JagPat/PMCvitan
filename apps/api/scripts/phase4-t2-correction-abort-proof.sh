#!/usr/bin/env bash
# Phase 4 Task 2 CORRECTION — the labour commercial-integrity migration ABORT → REPAIR → REDEPLOY proof.
#
# Builds a database at the point JUST BEFORE this correction's migration (every migration except
# 20270205000000_phase4_t2_correction), plants a FULLY coherent labour commercial chain — a
# requisition→quote→APPROVED comparison→PO→commitment whose every identity/provenance is correct —
# except ONE physical-truth violation the correction seals: a PO line whose committedQty (99) exceeds
# its ordered personShiftQty (3) (finding F5, which the old schema's `committedQty >= 0` CHECK allowed).
# Then:
#   1. applies the correction (single transaction)  → the F5 diagnostic must ABORT (never guess a repair);
#   2. asserts no half-applied schema leaked past the rolled-back transaction;
#   3. repairs ONLY the offending row (committedQty := personShiftQty — the documented §P4T2C repair);
#   4. re-applies the correction                     → must SUCCEED (the coherent chain satisfies F2/F3/F4);
#   5. asserts the F5 bound CHECK + the F4 provenance columns are now installed.
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_p4t2c_abort_proof). Connection comes from
# the standard PG* variables; the dev container uses PGUSER=vitan PGPASSWORD=vitan.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-vitan}"
export PGPASSWORD="${PGPASSWORD:-vitan}"

DB="${P4T2C_ABORT_PROOF_DB:-pmcvitan_p4t2c_abort_proof}"
MIG_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"
MIG="20270205000000_phase4_t2_correction"
FPD="encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex')"

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -q -v ON_ERROR_STOP=1 -d $DB"

echo "=== p4t2c-abort-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

echo "=== applying every migration BEFORE the correction ($MIG) ==="
applied=0
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  stamp="${name%%_*}"
  if [ "$name" != "0_init" ] && [ "$stamp" -ge "${MIG%%_*}" ] 2>/dev/null; then continue; fi
  $PSQL -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
  applied=$((applied + 1))
done
echo "applied $applied migrations (the correction held back)"

echo "=== planting a coherent labour commercial chain with ONE F5 violation (committedQty 99 > 3) ==="
$PSQL >/dev/null <<SQL || { echo "fixture failed"; exit 1; }
BEGIN;
INSERT INTO "Org" ("id","name","slug") VALUES ('org-p4c','P4C Org','p4c-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p1','org-p4c','P4C Site','P4','','Structure','P4-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","email","passwordHash") VALUES ('USER-1','p1','pmc','P4C PMC','p4c@vitan.in','h');
INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd") VALUES ('ACT-1','p1','Slab pour','Zone 1',0,5);
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('p1','mason','Mason','USER-1');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','bar-bending','Bar Bending','USER-1');
-- a coherent labour REQUIREMENT (canonical fingerprint + one demand slice)
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES ('REQ-1','p1','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","createdById")
  VALUES ('AR-1','p1','REQ-1',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1');
INSERT INTO "LabourRequirementSpec"("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint")
  VALUES ('LRS-1','p1','REQ-1',1,'mason','bar-bending','day', $FPD);
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ('LDS-1','p1','REQ-1',1,'2026-08-12',3);
-- the reused procurement supplier party
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES ('V-1','org-p4c','Labour Supplier','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES ('PV-1','p1','org-p4c','V-1','USER-1');
-- the commercial chain
INSERT INTO "LabourRequisition"("id","projectId","title","status","createdById","approvedById","approvedAt") VALUES ('REQU-1','p1','crew','approved','USER-1','USER-1',NOW());
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status") VALUES ('RL-1','p1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,'ordered');
INSERT INTO "LabourRfq"("id","projectId","requisitionId","issuedById") VALUES ('RFQ-1','p1','REQU-1','USER-1');
INSERT INTO "SupplierLabourQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById") VALUES ('Q-1','p1','RFQ-1','REQU-1','V-1','recorded','2026-12-31','USER-1');
INSERT INTO "SupplierLabourQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","ratePerPersonShift","shiftPremium","landedPerPersonShift","matchesSpecification") VALUES ('QL-1','p1','Q-1','RL-1','REQU-1',1000,100,1100,true);
INSERT INTO "LabourQuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt") VALUES ('CMP-1','p1','RFQ-1','REQU-1','approved','Q-1','V-1','ok','USER-1','USER-1',NOW());
INSERT INTO "LabourPurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById") VALUES ('PO-1','p1','V-1','REQU-1','CMP-1','approved','USER-1');
INSERT INTO "LabourPurchaseOrderVersion"("id","projectId","poId","version","requisitionId","status","issuedById","issuedAt","createdById") VALUES ('POV-1','p1','PO-1',1,'REQU-1','issued','USER-1',NOW(),'USER-1');
-- the ONE violation: committedQty 99 > personShiftQty 3
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty") VALUES ('POL-1','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,1000,100,3300,99);
INSERT INTO "CapacityCommitment"("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","createdById") VALUES ('CC-1','p1','POL-1',$FPD,'2026-08-12','day',3,'USER-1');
INSERT INTO "CapacityPromise"("id","projectId","commitmentId","seq","promisedDate","recordedById") VALUES ('CP-1','p1','CC-1',1,'2026-08-11','USER-1');
COMMIT;
SQL
echo "planted (POL-1 orders 3 but has committedQty 99 — the F5 violation)"

echo ""
echo "=== 1. applying the correction over the F5 violation — expect ABORT ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/p4t2c-abort.log 2>&1; then
  echo "FAILED: the migration should have ABORTED on the F5 violation but succeeded"; exit 1
fi
if grep -q "F5 ABORT" /tmp/p4t2c-abort.log; then
  echo "ok  the diagnostic aborted naming finding F5 (no guessed repair, no discarded data)"
else
  echo "FAILED: the migration aborted for the WRONG reason:"; cat /tmp/p4t2c-abort.log; exit 1
fi
leaked=$($PSQL -tAc "SELECT COUNT(*) FROM pg_constraint WHERE conname='LabourPurchaseOrderLine_committed_le_person_check';")
if [ "$leaked" != "0" ]; then echo "FAILED: the F5 CHECK leaked past the aborted transaction"; exit 1; fi
leaked2=$($PSQL -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='LabourPurchaseOrderLine' AND column_name='selectedQuoteLineId';")
if [ "$leaked2" != "0" ]; then echo "FAILED: the F4 provenance columns leaked past the aborted transaction"; exit 1; fi
echo "ok  the aborted migration left no half-applied schema (single-transaction rollback)"

echo ""
echo "=== 2. repairing ONLY the offending row (committedQty := personShiftQty — the §P4T2C repair) ==="
$PSQL -c "UPDATE \"LabourPurchaseOrderLine\" SET \"committedQty\"=\"personShiftQty\" WHERE \"id\"='POL-1';" || exit 1

echo "=== 3. re-applying the correction — expect SUCCESS ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$MIG/migration.sql" >/tmp/p4t2c-redeploy.log 2>&1; then
  echo "ok  redeploy succeeded after the row was repaired (F2/F3/F4 backfills resolved on the coherent chain)"
else
  echo "FAILED: redeploy failed after the repair:"; cat /tmp/p4t2c-redeploy.log; exit 1
fi

echo ""
echo "=== 4. asserting the F5 bound + the F4 provenance backfill are installed ==="
check=$($PSQL -tAc "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('LabourPurchaseOrderLine_committed_le_person_check','CapacityCommitment_poLine_identity_fkey','LabourRequisitionLine_spec_identity_fkey','LabourPurchaseOrderLine_quote_provenance_fkey');")
if [ "$check" = "4" ]; then echo "ok  the F2/F3/F4/F5 constraints are installed (4/4)"; else echo "FAILED: expected 4 correction constraints, got $check"; exit 1; fi
prov=$($PSQL -tAc "SELECT \"selectedQuoteLineId\"||'|'||\"selectedQuoteId\"||'|'||\"comparisonId\" FROM \"LabourPurchaseOrderLine\" WHERE \"id\"='POL-1';")
if [ "$prov" = "QL-1|Q-1|CMP-1" ]; then echo "ok  the F4 provenance backfilled from the coherent chain (QL-1|Q-1|CMP-1)"; else echo "FAILED: expected provenance QL-1|Q-1|CMP-1 got '$prov'"; exit 1; fi

echo ""
echo "P4T2C ABORT PROOF PASSED: the migration aborts on the F5 violation, and a repaired coherent chain redeploys cleanly with the F2..F5 seals installed and F4 provenance backfilled."
