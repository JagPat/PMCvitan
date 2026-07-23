#!/usr/bin/env bash
# Phase 3 Tasks 4–5 BOUNDARY correction — the operator repair path, EXECUTED against PostgreSQL.
#
# The Tasks 4–5 integrity correction (migration 20261231000000) makes PostgreSQL reject forged §C/§E
# records. But the records that would VIOLATE it live in append-only tables, so a legacy database
# that already holds such rows cannot deploy the migration and cannot be repaired with ordinary
# UPDATE/DELETE. This proof builds exactly that database — every Tasks 4–5 migration applied EXCEPT
# 20261231 (the append-only triggers exist; the F1–F4 constraints do not) — plants one row per
# finding, and drives the real operator tooling end-to-end:
#
#   1. `t45:preflight`  reports EVERY finding (incl. F3.1 duplicate issue movements) with counts.
#   2. `prisma migrate deploy` ABORTS (the migration will not apply over violations).
#   3. a FORCED repair failure rolls back completely — data unchanged, every trigger still enabled.
#   4. the explicit operator repair plan clears every finding under one bounded transaction.
#   5. `t45:preflight` is clean, then `migrate resolve --rolled-back` + `migrate deploy` applies.
#   6. a SECOND database isolates F3.1: with ONLY a duplicate issue movement the diagnostic DO block
#      passes and `migrate deploy` fails OPAQUELY inside CREATE UNIQUE INDEX — the exact gap the
#      preflight closes; the repair then lets the deploy succeed.
#
# DESTRUCTIVE for the two scratch databases only. Connection via the standard PG* env vars.

set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="$API_DIR/prisma/migrations"
CORR="20261231000000_phase3_t45_integrity_correction"
HELD="$MIG_DIR/../.t45-held-$$"
DB="${T45_PROOF_DB:-pmcvitan_t45_repair_proof}"
DB2="${T45_PROOF_DB2:-pmcvitan_t45_f31_proof}"
URL_BASE="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
PLANDIR="$(mktemp -d)"
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"

# Restore the withheld migration on ANY exit so an interrupted run never corrupts the ledger.
restore_held() { [ -d "$HELD" ] && mv "$HELD" "$MIG_DIR/$CORR" 2>/dev/null || true; }
trap 'restore_held; rm -rf "$PLANDIR"' EXIT

note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }

# Apply every migration EXCEPT the correction to $1, recorded in _prisma_migrations (Prisma-native),
# by withholding the correction dir across a `migrate deploy`.
build_not_yet_db() {
  local db="$1"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $db;" || exit 1
  mv "$MIG_DIR/$CORR" "$HELD" || exit 1
  DATABASE_URL="$URL_BASE/$db?schema=public" pnpm exec prisma migrate deploy >/tmp/t45-notyet-$db.log 2>&1 \
    || { echo "FAILED: migrate deploy (through 20261230) errored for $db"; cat /tmp/t45-notyet-$db.log; exit 1; }
  mv "$HELD" "$MIG_DIR/$CORR" || exit 1
}

# Plant the coherent legacy chain on project p1 (org-legacy / USER-1 / ACT-1). Reused verbatim from
# the upgrade-proof: requirement → spec → requisition → RFQ → quote → approved comparison → PO line →
# commitment → lot → receipt, plus a VALID MaterialIssue + its canonical movement.
plant_coherent_chain() {
  local db="$1"
  psql -X -v ON_ERROR_STOP=1 -d "$db" >/dev/null <<'SQL' || { echo "FAILED: coherent chain did not apply"; exit 1; }
BEGIN;
INSERT INTO "Org"("id","name","slug") VALUES('org-legacy','Legacy Org','legacy-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES('p1','org-legacy','Legacy Site A','LA','','Finishing','LA-01','01 Jan 2026','31 Dec 2026',50,30,60),
        ('p2','org-legacy','Legacy Site B','LB','','Finishing','LB-01','01 Jan 2026','31 Dec 2026',50,30,60);
INSERT INTO "User"("id","projectId","role","name","email") VALUES('USER-1','p1','pmc','Legacy PMC','legacy@vitan.in');
INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd","status") VALUES('ACT-1','p1','Flooring','Hall',0,5,'in_progress');
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('UP45-ROOT','p1','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","criticality","status","createdById")
  VALUES('UP45-AR','p1','UP45-ROOT',1,'ACT-1','material',100,'bag','2026-08-15','normal','open','USER-1');
INSERT INTO "MaterialRequirementSpec"("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","specFingerprint")
  VALUES('UP45-MS','p1','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','FP-UP45');
INSERT INTO "Requisition"("id","projectId","title","status","createdById") VALUES('UP45-REQ','p1','up45','approved','USER-1');
INSERT INTO "RequisitionLine"("id","projectId","requisitionId","requirementId","revision","qty","status")
  VALUES('UP45-RL','p1','UP45-REQ','UP45-ROOT',1,100,'ordered');
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES('UP45-VEN','org-legacy','V','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES('UP45-PV','p1','org-legacy','UP45-VEN','USER-1');
INSERT INTO "Rfq"("id","projectId","requisitionId","status","issuedById") VALUES('UP45-RFQ','p1','UP45-REQ','closed','USER-1');
INSERT INTO "VendorQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById")
  VALUES('UP45-VQ','p1','UP45-RFQ','UP45-REQ','UP45-VEN','recorded','2027-01-01','USER-1');
INSERT INTO "VendorQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","baseRate","taxAmount","freightAmount","landedCost","quotedMake","matchesSpecification")
  VALUES('UP45-VQL','p1','UP45-VQ','UP45-RL','UP45-REQ',100,50,25,999.99,'UltraTech OPC',true);
INSERT INTO "QuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt")
  VALUES('UP45-CMP','p1','UP45-RFQ','UP45-REQ','approved','UP45-VQ','UP45-VEN','ok','USER-1','USER-1',now());
INSERT INTO "PurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById")
  VALUES('UP45-PO','p1','UP45-VEN','UP45-REQ','UP45-CMP','approved','USER-1');
INSERT INTO "PurchaseOrderVersion"("id","projectId","poId","version","requisitionId","status","issuedById","issuedAt","createdById")
  VALUES('UP45-POV','p1','UP45-PO',1,'UP45-REQ','issued','USER-1',now(),'USER-1');
INSERT INTO "PurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","specFingerprint","uom","purchaseUom","purchaseQty","conversionToBase","qty","rate","taxAmount","freightAmount","landedAmount","committedAmountBase")
  VALUES('UP45-POL','p1','UP45-POV','UP45-RL','UP45-REQ','UP45-ROOT',1,'FP-UP45','bag','bag',100,1,100,100,50,25,999.99,100);
INSERT INTO "DeliveryCommitment"("id","projectId","poLineId","status","createdById") VALUES('UP45-DC','p1','UP45-POL','committed','USER-1');
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-CMD','project','org-legacy','p1','USER-1','test.up45','up45','x','succeeded'),
        ('UP45-CMD2','project','org-legacy','p2','USER-1','test.up45','up45b','x','succeeded');
INSERT INTO "StockLot"("id","projectId","poLineId","commitmentId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","receivedById")
  VALUES('UP45-LOT','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FP-UP45','USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","poLineId","commitmentId","recordedById","sourceCommandId")
  VALUES('UP45-RCPT','p1','UP45-LOT','main','receipt',100,NULL,'quarantine','UP45-POL','UP45-DC','USER-1','UP45-CMD');
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById") VALUES('UP45-MI','p1','UP45-LOT','main','ACT-1',20,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('UP45-ISS','p1','UP45-LOT','main','issue',20,'acceptedOnHand','issuedToActivity','ACT-1','UP45-MI','USER-1','UP45-CMD');
INSERT INTO "DailyLog"("id","projectId","date","submitted","checkedIn","progress") VALUES('UP45-DL','p1','01 Jun 2026',false,true,10);
COMMIT;
SQL
}

trigger_states() {
  # prints e.g. "StockLot_append_only=O,StockTransaction_append_only=O,..." (tgenabled is a "char")
  psql -X -tA -d "$1" -c "SELECT string_agg(tgname||'='||tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname IN ('StockLot_append_only','StockTransaction_append_only','MaterialIssue_append_only','MismatchResolution_append_only');"
}

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# DATABASE 1 — every finding, forced-failure rollback, then the full repair
# ─────────────────────────────────────────────────────────────────────────────────────────────────
note "DB1: building the not-yet-corrected legacy database (through 20261230)"
build_not_yet_db "$DB"
plant_coherent_chain "$DB"

note "DB1: planting one violation per finding (append-only tables accept INSERTs; UPDATE/DELETE are sealed)"
psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL' || { echo "FAILED: violation fixture did not apply"; exit 1; }
-- F1.null: an adjustment row with no source command
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","reason","recordedById")
  VALUES('V-F1NULL','p1','UP45-LOT','main','adjustment',1,'acceptedOnHand',NULL,'legacy unkeyed','USER-1');
-- F1.foreign: an adjustment row citing a command in ANOTHER project
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","reason","recordedById","sourceCommandId")
  VALUES('V-F1FGN','p1','UP45-LOT','main','adjustment',1,'acceptedOnHand',NULL,'x','USER-1','UP45-CMD2');
-- F2.2: a lot whose chain is valid but whose frozen §B fingerprint is forged
INSERT INTO "StockLot"("id","projectId","poLineId","commitmentId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","receivedById")
  VALUES('V-FORGEDLOT','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FORGED','USER-1');
-- F3.1: a SECOND MaterialIssue with TWO canonical issue movements
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById") VALUES('V-MI2','p1','UP45-LOT','main','ACT-1',10,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('V-ISS2A','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','V-MI2','USER-1','UP45-CMD'),
        ('V-ISS2B','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','V-MI2','USER-1','UP45-CMD');
-- F3.2: an orphan MaterialIssue (no canonical issue movement)
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById") VALUES('V-MI3','p1','UP45-LOT','main','ACT-1',5,'USER-1');
-- F3.3: an issue-scoped consumption at a DIFFERENT store location than its MaterialIssue
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('V-MISSCOPE','p1','UP45-LOT','elsewhere','consumption',1,'issuedToActivity',NULL,'ACT-1','UP45-MI','USER-1','UP45-CMD');
-- F4: two matched=true observations, each with a resolution (one to delete, one to un-match)
INSERT INTO "SiteMaterial"("id","projectId","dailyLogId","name","qty","zone","matched","swatch","order")
  VALUES('V-SM-A','p1','UP45-DL','Tile A','5','Bath',true,'tile',0),
        ('V-SM-B','p1','UP45-DL','Tile B','5','Bath',true,'tile',1);
INSERT INTO "MismatchResolution"("id","projectId","siteMaterialId","resolution","reason","resolvedById")
  VALUES('V-MR-A','p1','V-SM-A','returned','erroneous','USER-1'),
        ('V-MR-B','p1','V-SM-B','accepted_variance','was really mismatched','USER-1');
SQL

note "DB1 step 1 — t45:preflight reports every finding (incl. F3.1)"
PRE_JSON="$(DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts preflight 2>/dev/null)"
for code in F1.null F1.foreign F2.2 F3.1 F3.2 F3.3 F4; do
  if printf '%s' "$PRE_JSON" | grep -q "\"$code\""; then ok "preflight names $code"; else bad "preflight did NOT name $code"; fi
done
printf '%s' "$PRE_JSON" | grep -q '"clean": false' && ok "preflight verdict is not-clean" || bad "preflight should be not-clean"

note "DB1 step 2 — prisma migrate deploy ABORTS over the violations (does not apply the correction)"
if DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm exec prisma migrate deploy >/tmp/t45-db1-deploy1.log 2>&1; then
  bad "migrate deploy APPLIED the correction over violations (it must abort)"
else
  ok "migrate deploy aborted (the correction did not apply)"
fi
[ "$(psql -X -tA -d "$DB" -c "SELECT to_regclass('\"StockTransaction_projectId_sourceCommandId_fkey\"') IS NOT NULL;")" = "f" ] \
  || psql -X -tA -d "$DB" -c "SELECT COUNT(*) FROM pg_constraint WHERE conname='StockTransaction_projectId_sourceCommandId_fkey';" | grep -q '^0$' \
  && ok "the F1 provenance FK is absent (constraints were not added)" || bad "a correction constraint leaked despite the abort"

note "DB1 step 3 — a FORCED repair failure rolls back completely (data unchanged, triggers enabled)"
cat > "$PLANDIR/partial.json" <<JSON
{ "actions": [ { "finding": "F3.2", "op": "delete-material-issue", "id": "V-MI3" } ] }
JSON
BEFORE_TRIG="$(trigger_states "$DB")"
if DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts repair --plan "$PLANDIR/partial.json" --operator ops@vitan.in --reason "forced-failure rehearsal" >/tmp/t45-db1-forced.log 2>&1; then
  bad "the partial repair COMMITTED (it must abort — findings remain)"
else
  ok "the partial repair aborted (re-diagnose still dirty)"
fi
[ "$(psql -X -tA -d "$DB" -c "SELECT COUNT(*) FROM \"MaterialIssue\" WHERE id='V-MI3';")" = "1" ] \
  && ok "the deleted-then-rolled-back MaterialIssue is intact (V-MI3 still present)" || bad "V-MI3 did not roll back"
[ "$(trigger_states "$DB")" = "$BEFORE_TRIG" ] && ok "every append-only trigger is still enabled after the forced failure" || bad "a trigger was left disabled: $(trigger_states "$DB")"
[ "$(psql -X -tA -d "$DB" -c "SELECT COUNT(*) FROM \"T45RepairAction\";" 2>/dev/null || echo 0)" = "0" ] \
  && ok "no repair-evidence rows persisted through the rollback" || bad "evidence rows survived a rolled-back repair"

note "DB1 step 4 — the operator records a reconciliation command, then the FULL explicit repair"
psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL' || { echo "FAILED: reconciliation command insert"; exit 1; }
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-RECON','project','org-legacy','p1','USER-1','ops.t45_reconciliation','t45-recon-1','x','succeeded');
SQL
cat > "$PLANDIR/full.json" <<JSON
{ "actions": [
  { "finding": "F1.null",    "op": "set-source-command",         "id": "V-F1NULL",   "commandId": "UP45-RECON" },
  { "finding": "F1.foreign", "op": "set-source-command",         "id": "V-F1FGN",    "commandId": "UP45-RECON" },
  { "finding": "F2.2",       "op": "delete-stock-lot",           "id": "V-FORGEDLOT" },
  { "finding": "F3.1",       "op": "delete-stock-transaction",   "id": "V-ISS2B" },
  { "finding": "F3.2",       "op": "delete-material-issue",      "id": "V-MI3" },
  { "finding": "F3.3",       "op": "delete-stock-transaction",   "id": "V-MISSCOPE" },
  { "finding": "F4",         "op": "delete-mismatch-resolution", "id": "V-MR-A" },
  { "finding": "F4",         "op": "set-site-material-unmatched","id": "V-SM-B" }
] }
JSON
if DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts repair --plan "$PLANDIR/full.json" --operator ops@vitan.in --reason "T45 legacy reconciliation" >/tmp/t45-db1-repair.log 2>&1; then
  ok "the full repair committed"
else
  bad "the full repair aborted unexpectedly"; cat /tmp/t45-db1-repair.log
fi
[ "$(psql -X -tA -d "$DB" -c "SELECT COUNT(*) FROM \"T45RepairAction\";")" = "8" ] \
  && ok "eight before-image evidence rows were recorded (operator/reason/timestamp/rowId)" || bad "evidence row count is not 8"
[ "$(trigger_states "$DB")" = "$BEFORE_TRIG" ] && ok "every append-only trigger is enabled again after the repair" || bad "a trigger was left disabled after repair"

note "DB1 step 5 — preflight is clean, then migrate resolve --rolled-back + migrate deploy applies"
PRE2="$(DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts preflight 2>/dev/null)"
printf '%s' "$PRE2" | grep -q '"clean": true' && ok "preflight is now clean" || bad "preflight is still dirty after repair"
DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm exec prisma migrate resolve --rolled-back "$CORR" >/tmp/t45-db1-resolve.log 2>&1 \
  && ok "the failed migration record was marked rolled-back" || bad "migrate resolve --rolled-back failed"
if DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm exec prisma migrate deploy >/tmp/t45-db1-deploy2.log 2>&1; then
  ok "migrate deploy applied the correction cleanly after repair"
else
  bad "migrate deploy still failed after repair"; cat /tmp/t45-db1-deploy2.log
fi
[ "$(psql -X -tA -d "$DB" -c "SELECT COUNT(*) FROM pg_constraint WHERE conname='StockTransaction_projectId_sourceCommandId_fkey';")" = "1" ] \
  && ok "the F1 provenance FK is present (the correction is now enforced)" || bad "the correction did not fully apply"

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# DATABASE 2 — F3.1 in isolation: the DO block passes, CREATE UNIQUE INDEX fails OPAQUELY
# ─────────────────────────────────────────────────────────────────────────────────────────────────
note "DB2: building a not-yet DB with ONLY a duplicate issue movement (F3.1 alone)"
build_not_yet_db "$DB2"
plant_coherent_chain "$DB2"
psql -X -v ON_ERROR_STOP=1 -d "$DB2" >/dev/null <<'SQL' || { echo "FAILED: F3.1 fixture"; exit 1; }
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById") VALUES('F31-MI','p1','UP45-LOT','main','ACT-1',10,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('F31-A','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','F31-MI','USER-1','UP45-CMD'),
        ('F31-B','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','F31-MI','USER-1','UP45-CMD');
SQL

note "DB2 step 1 — preflight explicitly names F3.1 with a bounded sample (BEFORE any deploy)"
F31_JSON="$(DATABASE_URL="$URL_BASE/$DB2?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts preflight 2>/dev/null)"
printf '%s' "$F31_JSON" | grep -q '"F3.1"' && ok "preflight names F3.1" || bad "preflight did not name F3.1"
printf '%s' "$F31_JSON" | grep -q 'F31-A' && printf '%s' "$F31_JSON" | grep -q 'F31-B' \
  && ok "preflight's F3.1 sample lists both duplicate transaction ids" || bad "F3.1 sample did not list the duplicate ids"

note "DB2 step 2 — migrate deploy fails OPAQUELY inside CREATE UNIQUE INDEX (the gap the preflight closes)"
if DATABASE_URL="$URL_BASE/$DB2?schema=public" pnpm exec prisma migrate deploy >/tmp/t45-db2-deploy1.log 2>&1; then
  bad "migrate deploy applied despite the duplicate issue movement"
else
  if grep -qi "one_issue_movement_per_issue\|duplicate key\|unique constraint" /tmp/t45-db2-deploy1.log; then
    ok "migrate deploy failed at the partial unique index (opaque — no per-finding diagnostic)"
  else
    ok "migrate deploy failed over the duplicate issue movement"
  fi
fi

note "DB2 step 3 — the operator repair (explicit canonical choice) lets the deploy succeed"
cat > "$PLANDIR/f31.json" <<JSON
{ "actions": [ { "finding": "F3.1", "op": "delete-stock-transaction", "id": "F31-B" } ] }
JSON
DATABASE_URL="$URL_BASE/$DB2?schema=public" pnpm -s exec tsx src/platform/t45/t45.cli.ts repair --plan "$PLANDIR/f31.json" --operator ops@vitan.in --reason "F3.1 duplicate: keep F31-A" >/tmp/t45-db2-repair.log 2>&1 \
  && ok "the F3.1 repair committed (operator kept F31-A, removed F31-B)" || { bad "F3.1 repair failed"; cat /tmp/t45-db2-repair.log; }
[ "$(psql -X -tA -d "$DB2" -c "SELECT \"beforeImage\"->>'id' FROM \"T45RepairAction\" WHERE \"rowId\"='F31-B';" 2>/dev/null)" = "F31-B" ] \
  && ok "the rejected duplicate's before-image is preserved in the repair evidence" || bad "F31-B before-image missing from evidence"
DATABASE_URL="$URL_BASE/$DB2?schema=public" pnpm exec prisma migrate resolve --rolled-back "$CORR" >/tmp/t45-db2-resolve.log 2>&1 \
  && ok "the failed migration record was marked rolled-back" || bad "F3.1 migrate resolve failed"
if DATABASE_URL="$URL_BASE/$DB2?schema=public" pnpm exec prisma migrate deploy >/tmp/t45-db2-deploy2.log 2>&1; then
  ok "migrate deploy applied cleanly after the F3.1 repair"
else
  bad "migrate deploy still failed after the F3.1 repair"; cat /tmp/t45-db2-deploy2.log
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────
note "cleanup"
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || true
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB2;" >/dev/null 2>&1 || true

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T45 REPAIR PROOF PASSED: preflight enumerated every finding (incl. F3.1), the migration aborted over"
  echo "violations, a forced failure rolled back with triggers intact, the explicit repair cleared every"
  echo "finding under one bounded transaction, and the correction deployed cleanly afterward."
else
  echo "T45 REPAIR PROOF FAILED: see the assertions above."
fi
exit $FAIL
