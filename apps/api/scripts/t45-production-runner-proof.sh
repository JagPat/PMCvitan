#!/usr/bin/env bash
# Phase 3 Tasks 4–5 — the PRODUCTION RUNNER enforces the T45 preflight, EXECUTED against PostgreSQL.
#
# The finding: production `scripts/migrate.sh` ran `prisma migrate deploy` directly, so the F3.1
# preflight was documented but never enforced in the real Coolify path. This proof runs the ACTUAL
# `scripts/migrate.sh` (built once, using the COMPILED `dist/platform/t45/t45.cli.js` — never tsx)
# over six database states and asserts the schema-aware gate does the right thing in each:
#
#   1. fresh empty database            → preflight "not applicable"; migrate deploy applies all.
#   2. database older than Task 5      → "not applicable" (no MaterialIssue / issueId); migrations run.
#   3. clean database through 20261230 → preflight applicable + clean; 20261231 then applies.
#   4. already-corrected database      → applicable + clean (state=applied); migrate deploy is a no-op.
#   5. P3005 pre-baseline database     → preflight clean; migrate deploy P3005 → baseline → succeeds.
#   6. dirty F3.1 database             → preflight NAMES F3.1 + both tx ids and EXITS non-zero, so
#                                        migrate.sh aborts and 20261231 is NEVER started/recorded as
#                                        failed; an explicit repair then lets a rerun deploy cleanly.
#
# DESTRUCTIVE for the scratch databases only. Connection via the standard PG* env vars.

set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$API_DIR" || exit 1
MIG_DIR="$API_DIR/prisma/migrations"
CORR="20261231000000_phase3_t45_integrity_correction"
T5_STAMP=20261230000000      # first Task-5 migration (issueId + MaterialIssue)
CORR_STAMP=20261231000000    # the correction
URL_BASE="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
HOLD="$MIG_DIR/../.t45-pr-hold-$$"
PLANDIR="$(mktemp -d)"
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PREFLIGHT_ARTIFACT="dist/platform/t45/t45.cli.js"

restore_all() {
  if [ -d "$HOLD" ]; then
    for d in "$HOLD"/*/; do [ -d "$d" ] && mv "$d" "$MIG_DIR/$(basename "$d")"; done
    rmdir "$HOLD" 2>/dev/null || true
  fi
}
trap 'restore_all; rm -rf "$PLANDIR"' EXIT

note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }

# Build a database by applying every migration whose stamp is < $2 (empty = all), via Prisma so
# _prisma_migrations is authoritative. Withheld dirs are moved aside for the deploy and restored.
build_db() {
  local db="$1" withhold_from="${2:-}"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $db;" >/dev/null || exit 1
  local moved=0
  if [ -n "$withhold_from" ]; then
    mkdir -p "$HOLD"
    for d in "$MIG_DIR"/*/; do
      local name stamp; name=$(basename "$d"); stamp="${name%%_*}"
      if [ "$stamp" -ge "$withhold_from" ] 2>/dev/null; then mv "$d" "$HOLD/$name"; moved=$((moved+1)); fi
    done
  fi
  DATABASE_URL="$URL_BASE/$db?schema=public" pnpm exec prisma migrate deploy >/tmp/t45pr-build-$db.log 2>&1 \
    || { echo "build_db($db, withhold=${withhold_from:-none}) FAILED"; cat /tmp/t45pr-build-$db.log; restore_all; exit 1; }
  restore_all
}

# Run the REAL production migration runner against $1; captures output in $RUN_OUT, exit in $RUN_RC.
run_migrate_sh() {
  RUN_OUT="$(DATABASE_URL="$URL_BASE/$1?schema=public" sh scripts/migrate.sh 2>&1)"; RUN_RC=$?
}

q() { psql -X -tA -d "$1" -c "$2" 2>/dev/null; }
corr_applied()  { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$CORR' AND finished_at IS NOT NULL")" = "1" ]; }
corr_absent()   { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '20261231%'")" = "0" ]; }

# Reuse the coherent legacy chain (project p1 / org-legacy / USER-1 / ACT-1) — only used by case 6.
plant_coherent_chain() {
  psql -X -v ON_ERROR_STOP=1 -d "$1" >/dev/null <<'SQL' || { echo "coherent chain did not apply"; exit 1; }
BEGIN;
INSERT INTO "Org"("id","name","slug") VALUES('org-legacy','Legacy Org','legacy-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES('p1','org-legacy','Legacy Site A','LA','','Finishing','LA-01','01 Jan 2026','31 Dec 2026',50,30,60);
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
  VALUES('UP45-CMD','project','org-legacy','p1','USER-1','test.up45','up45','x','succeeded');
INSERT INTO "StockLot"("id","projectId","poLineId","commitmentId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","receivedById")
  VALUES('UP45-LOT','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FP-UP45','USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","poLineId","commitmentId","recordedById","sourceCommandId")
  VALUES('UP45-RCPT','p1','UP45-LOT','main','receipt',100,NULL,'quarantine','UP45-POL','UP45-DC','USER-1','UP45-CMD');
COMMIT;
SQL
}

# ── build the COMPILED artifact once (production uses dist, never tsx) ────────────────────────────
note "building the compiled API artifact (pnpm --filter api build) so dist/platform/t45/t45.cli.js exists"
pnpm --filter @vitan/shared build >/tmp/t45pr-shared.log 2>&1 || { echo "shared build failed"; cat /tmp/t45pr-shared.log; exit 1; }
pnpm --filter api build >/tmp/t45pr-apibuild.log 2>&1 || { echo "api build failed"; tail -20 /tmp/t45pr-apibuild.log; exit 1; }
[ -f "$PREFLIGHT_ARTIFACT" ] && ok "compiled preflight artifact present: $PREFLIGHT_ARTIFACT" || { bad "compiled preflight artifact missing after build"; exit 1; }

# ── Case 1 — fresh empty database ────────────────────────────────────────────────────────────────
note "Case 1 — fresh empty database"
DB=pmcvitan_t45pr_fresh
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null; $PSQL_ADMIN -c "CREATE DATABASE $DB;" >/dev/null
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh succeeded on a fresh database" || { bad "migrate.sh failed on a fresh database"; echo "$RUN_OUT" | tail -8; }
echo "$RUN_OUT" | grep -q '"applicable": false' && ok "preflight reported not-applicable (no §C/§E schema yet)" || bad "preflight did not report not-applicable on a fresh DB"
corr_applied "$DB" && ok "the correction migration applied over the fresh database" || bad "the correction did not apply on the fresh database"

# ── Case 2 — database older than Task 5 (built through Task 4) ────────────────────────────────────
note "Case 2 — database older than Task 5 (through 20261226)"
DB=pmcvitan_t45pr_pretask5
build_db "$DB" "$T5_STAMP"
[ "$(q "$DB" "SELECT count(*) FROM information_schema.tables WHERE table_name='MaterialIssue'")" = "0" ] \
  && ok "fixture is genuinely pre-Task-5 (MaterialIssue absent)" || bad "pre-Task-5 fixture unexpectedly has MaterialIssue"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": false' && ok "preflight reported not-applicable on the pre-Task-5 database" || bad "preflight did not report not-applicable pre-Task-5"
[ "$RUN_RC" = "0" ] && ok "migrate.sh applied Task 5 + the correction over the pre-Task-5 database" || bad "migrate.sh failed on the pre-Task-5 database"
corr_applied "$DB" && ok "the correction migration applied over the pre-Task-5 database" || bad "the correction did not apply pre-Task-5"

# ── Case 3 — clean database through 20261230 ─────────────────────────────────────────────────────
note "Case 3 — clean database through 20261230 (correction withheld)"
DB=pmcvitan_t45pr_clean
build_db "$DB" "$CORR_STAMP"
corr_absent "$DB" && ok "the correction is not yet applied (clean through 20261230)" || bad "the correction unexpectedly present"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "preflight reported applicable + clean" || bad "preflight was not applicable+clean on the clean DB"
[ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "migrate.sh applied the correction after a clean preflight" || bad "the correction did not apply after a clean preflight"

# ── Case 4 — already-corrected database ──────────────────────────────────────────────────────────
note "Case 4 — already-corrected database (through the correction)"
DB=pmcvitan_t45pr_corrected
build_db "$DB" ""
corr_applied "$DB" && ok "fixture is already corrected (20261231 applied)" || bad "already-corrected fixture missing the correction"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "preflight reported applicable + clean on the already-corrected DB" || bad "preflight not applicable+clean when already corrected"
echo "$RUN_OUT" | grep -q '"state": "applied"' && ok "preflight reported migration state = applied" || bad "preflight did not report state=applied"
[ "$RUN_RC" = "0" ] && ok "migrate.sh is a clean no-op on the already-corrected DB" || bad "migrate.sh failed on the already-corrected DB"

# ── Case 5 — P3005 pre-baseline database ─────────────────────────────────────────────────────────
note "Case 5 — P3005 pre-baseline database (schema present, no _prisma_migrations)"
DB=pmcvitan_t45pr_p3005
build_db "$DB" ""
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c 'DROP TABLE "_prisma_migrations";' >/dev/null || { bad "could not drop _prisma_migrations for the P3005 fixture"; }
[ "$(q "$DB" "SELECT to_regclass('\"_prisma_migrations\"') IS NULL")" = "t" ] && ok "fixture is genuinely pre-baseline (no _prisma_migrations)" || bad "P3005 fixture still has _prisma_migrations"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "preflight ran clean over the P3005 schema (migrationState robust to the missing ledger)" || bad "preflight failed over the P3005 fixture"
echo "$RUN_OUT" | grep -q "P3005" && ok "the P3005 baseline path engaged (preserved)" || bad "the P3005 baseline path did not engage"
[ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "migrate.sh baselined and the correction is recorded applied" || bad "the P3005 baseline path did not complete"

# ── Case 6 — dirty F3.1 database (the production-runner proof, requirement #4) ────────────────────
note "Case 6 — dirty F3.1: migrate.sh names F3.1 + both tx ids and aborts BEFORE Prisma starts"
DB=pmcvitan_t45pr_f31
build_db "$DB" "$CORR_STAMP"
plant_coherent_chain "$DB"
psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<'SQL' || { echo "F3.1 seed failed"; exit 1; }
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById") VALUES('F31-MI','p1','UP45-LOT','main','ACT-1',10,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('F31-A','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','F31-MI','USER-1','UP45-CMD'),
        ('F31-B','p1','UP45-LOT','main','issue',10,'acceptedOnHand','issuedToActivity','ACT-1','F31-MI','USER-1','UP45-CMD');
SQL
run_migrate_sh "$DB"
[ "$RUN_RC" != "0" ] && ok "migrate.sh exited non-zero (deploy blocked)" || bad "migrate.sh did not block a dirty F3.1 deploy"
echo "$RUN_OUT" | grep -q '"F3.1"' && ok "the runner output NAMES F3.1" || bad "the runner output did not name F3.1"
echo "$RUN_OUT" | grep -q 'F31-A' && echo "$RUN_OUT" | grep -q 'F31-B' \
  && ok "the F3.1 report lists BOTH duplicate transaction ids" || bad "the F3.1 report did not list both tx ids"
echo "$RUN_OUT" | grep -qi "migrate deploy\|Applying migration" && bad "prisma migrate deploy appears to have started" || ok "prisma migrate deploy was NOT started"
corr_absent "$DB" && ok "migration 20261231 was NEVER started/recorded (no _prisma_migrations row)" || bad "a 20261231 migration record exists despite the abort"

note "Case 6 (cont.) — explicit repair, then the SAME runner deploys cleanly"
cat > "$PLANDIR/f31.json" <<JSON
{ "actions": [ { "finding": "F3.1", "op": "delete-stock-transaction", "id": "F31-B" } ] }
JSON
DATABASE_URL="$URL_BASE/$DB?schema=public" node "$PREFLIGHT_ARTIFACT" repair --plan "$PLANDIR/f31.json" --operator ops@vitan.in --reason "F3.1 duplicate: keep F31-A" >/tmp/t45pr-repair.log 2>&1 \
  && ok "the explicit repair committed (compiled artifact)" || { bad "the F3.1 repair failed"; cat /tmp/t45pr-repair.log; }
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"clean": true' && ok "the rerun preflight is now clean" || bad "the rerun preflight is still dirty"
[ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "the SAME production runner then applied the correction cleanly" || bad "migrate.sh did not deploy after the repair"

# ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
note "cleanup"
for db in pmcvitan_t45pr_fresh pmcvitan_t45pr_pretask5 pmcvitan_t45pr_clean pmcvitan_t45pr_corrected pmcvitan_t45pr_p3005 pmcvitan_t45pr_f31; do
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 || true
done

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T45 PRODUCTION-RUNNER PROOF PASSED: scripts/migrate.sh enforces the compiled, schema-aware T45"
  echo "preflight across all six database states — fresh, pre-Task-5, clean, corrected, P3005 and a"
  echo "dirty F3.1 database (named report + both tx ids, 20261231 never started, explicit repair then"
  echo "a clean redeploy through the same runner)."
else
  echo "T45 PRODUCTION-RUNNER PROOF FAILED: see the assertions above."
fi
exit $FAIL
