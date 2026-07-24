#!/usr/bin/env bash
# Phase 4 Task 2 — the PRODUCTION RUNNER enforces the T2C preflight, EXECUTED against PostgreSQL.
#
# Round 2 added the audited `t2c` repair engine + `docs/RUNBOOK.md §P4T2C`, but round 3's finding is
# that production `scripts/migrate.sh` must ENFORCE the T2C preflight (compiled dist artifact, after
# the T45 preflight, before Prisma) exactly as it already enforces T45. This proof runs the ACTUAL
# `scripts/migrate.sh` (built once, using the COMPILED `dist/labour/t2c/t2c.cli.js` — never tsx) over
# the required database states and asserts the schema-aware gate does the right thing in each:
#
#   1. fresh empty database             → preflight "not applicable"; migrate deploy applies all.
#   2. database older than Task 2       → "not applicable" (no LabourPurchaseOrderLine); migrations run.
#   3. clean pre-correction Task-2 DB   → preflight applicable + clean; 20270205 then applies.
#   4. dirty F5 / F3 / F2 / F4 (each)   → preflight NAMES the finding and EXITS non-zero, so migrate.sh
#                                         aborts and 20270205 is NEVER started/recorded; an explicit
#                                         t2c repair (compiled artifact) then lets a rerun deploy clean.
#   5. already-corrected database       → applicable + clean (state=applied); migrate deploy is a no-op.
#
# DESTRUCTIVE for the scratch databases only. Connection via the standard PG* env vars; the dev
# container uses PGUSER=vitan PGPASSWORD=vitan.

set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-vitan}"
export PGPASSWORD="${PGPASSWORD:-vitan}"

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$API_DIR" || exit 1
MIG_DIR="$API_DIR/prisma/migrations"
CORR="20270205000000_phase4_t2_correction"
T2_STAMP=20270201000000      # first Task-2 migration (labour commercial schema)
CORR_STAMP=20270205000000    # the correction
URL_BASE="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
HOLD="$MIG_DIR/../.t2cpr-hold-$$"
PLANDIR="$(mktemp -d)"
FPD="encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex')"
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
T2C_ARTIFACT="dist/labour/t2c/t2c.cli.js"

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
kill_conns() { $PSQL_ADMIN -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true; }

# Build a database by applying every migration whose stamp is < $2 (empty = all), via Prisma so
# _prisma_migrations is authoritative. Withheld dirs are moved aside for the deploy and restored.
build_db() {
  local db="$1" withhold_from="${2:-}"
  kill_conns "$db"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $db;" >/dev/null || exit 1
  if [ -n "$withhold_from" ]; then
    mkdir -p "$HOLD"
    for d in "$MIG_DIR"/*/; do
      local name stamp; name=$(basename "$d"); stamp="${name%%_*}"
      if [ "$stamp" -ge "$withhold_from" ] 2>/dev/null; then mv "$d" "$HOLD/$name"; fi
    done
  fi
  DATABASE_URL="$URL_BASE/$db?schema=public" pnpm exec prisma migrate deploy >/tmp/t2cpr-build-$db.log 2>&1 \
    || { echo "build_db($db, withhold=${withhold_from:-none}) FAILED"; cat /tmp/t2cpr-build-$db.log; restore_all; exit 1; }
  restore_all
}

clone_db() { # clone_db src dst
  kill_conns "$2"; kill_conns "$1"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $2;" >/dev/null || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $2 TEMPLATE $1;" >/dev/null || exit 1
}

run_migrate_sh() { RUN_OUT="$(DATABASE_URL="$URL_BASE/$1?schema=public" sh scripts/migrate.sh 2>&1)"; RUN_RC=$?; }

q() { psql -X -tA -d "$1" -c "$2" 2>/dev/null; }
corr_applied()  { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$CORR' AND finished_at IS NOT NULL")" = "1" ]; }
corr_absent()   { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '20270205%'")" = "0" ]; }

# The coherent labour commercial chain (project p1 / org-p4c) — reused verbatim from the abort-proof.
plant_coherent_chain() {
  psql -X -v ON_ERROR_STOP=1 -d "$1" >/dev/null <<SQL || { echo "coherent chain did not apply"; exit 1; }
BEGIN;
INSERT INTO "Org" ("id","name","slug") VALUES ('org-p4c','P4C Org','p4c-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p1','org-p4c','P4C Site','P4','','Structure','P4-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","email","passwordHash") VALUES ('USER-1','p1','pmc','P4C PMC','p4c@vitan.in','h');
INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd") VALUES ('ACT-1','p1','Slab pour','Zone 1',0,5);
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('p1','mason','Mason','USER-1');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','bar-bending','Bar Bending','USER-1');
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES ('REQ-1','p1','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","createdById")
  VALUES ('AR-1','p1','REQ-1',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1');
INSERT INTO "LabourRequirementSpec"("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint")
  VALUES ('LRS-1','p1','REQ-1',1,'mason','bar-bending','day', $FPD);
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ('LDS-1','p1','REQ-1',1,'2026-08-12',3);
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES ('V-1','org-p4c','Labour Supplier','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES ('PV-1','p1','org-p4c','V-1','USER-1');
INSERT INTO "LabourRequisition"("id","projectId","title","status","createdById","approvedById","approvedAt") VALUES ('REQU-1','p1','crew','approved','USER-1','USER-1',NOW());
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status") VALUES ('RL-1','p1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,'ordered');
INSERT INTO "LabourRfq"("id","projectId","requisitionId","issuedById") VALUES ('RFQ-1','p1','REQU-1','USER-1');
INSERT INTO "SupplierLabourQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById") VALUES ('Q-1','p1','RFQ-1','REQU-1','V-1','recorded','2026-12-31','USER-1');
INSERT INTO "SupplierLabourQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","ratePerPersonShift","shiftPremium","landedPerPersonShift","matchesSpecification") VALUES ('QL-1','p1','Q-1','RL-1','REQU-1',1000,100,1100,true);
INSERT INTO "LabourQuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt") VALUES ('CMP-1','p1','RFQ-1','REQU-1','approved','Q-1','V-1','ok','USER-1','USER-1',NOW());
INSERT INTO "LabourPurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById") VALUES ('PO-1','p1','V-1','REQU-1','CMP-1','approved','USER-1');
INSERT INTO "LabourPurchaseOrderVersion"("id","projectId","poId","version","requisitionId","status","issuedById","issuedAt","createdById") VALUES ('POV-1','p1','PO-1',1,'REQU-1','issued','USER-1',NOW(),'USER-1');
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty") VALUES ('POL-1','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,1000,100,3300,0);
INSERT INTO "CapacityCommitment"("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","createdById") VALUES ('CC-1','p1','POL-1',$FPD,'2026-08-12','day',3,'USER-1');
INSERT INTO "CapacityPromise"("id","projectId","commitmentId","seq","promisedDate","recordedById") VALUES ('CP-1','p1','CC-1',1,'2026-08-11','USER-1');
COMMIT;
SQL
}

# ── build the COMPILED artifact once (production uses dist, never tsx) ────────────────────────────
note "building the compiled API artifact so dist/labour/t2c/t2c.cli.js (and the T45 CLI) exist"
pnpm --filter @vitan/shared build >/tmp/t2cpr-shared.log 2>&1 || { echo "shared build failed"; cat /tmp/t2cpr-shared.log; exit 1; }
pnpm --filter api build >/tmp/t2cpr-apibuild.log 2>&1 || { echo "api build failed"; tail -20 /tmp/t2cpr-apibuild.log; exit 1; }
[ -f "$T2C_ARTIFACT" ] && ok "compiled T2C preflight artifact present: $T2C_ARTIFACT" || { bad "compiled T2C preflight artifact missing after build"; exit 1; }
[ -f "dist/platform/t45/t45.cli.js" ] && ok "compiled T45 preflight artifact present (migrate.sh runs both)" || { bad "compiled T45 artifact missing"; exit 1; }

# ── Case 1 — fresh empty database ────────────────────────────────────────────────────────────────
note "Case 1 — fresh empty database"
DB=pmcvitan_t2cpr_fresh
kill_conns "$DB"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null; $PSQL_ADMIN -c "CREATE DATABASE $DB;" >/dev/null
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh succeeded on a fresh database" || { bad "migrate.sh failed on a fresh database"; echo "$RUN_OUT" | tail -8; }
echo "$RUN_OUT" | grep -q 'T2C preflight' && ok "the T2C preflight ran (after T45)" || bad "the T2C preflight did not run"
corr_applied "$DB" && ok "the correction migration applied over the fresh database" || bad "the correction did not apply on the fresh database"

# ── Case 2 — database older than Task 2 ──────────────────────────────────────────────────────────
note "Case 2 — database older than Task 2 (labour commercial schema absent)"
DB=pmcvitan_t2cpr_pretask2
build_db "$DB" "$T2_STAMP"
[ "$(q "$DB" "SELECT count(*) FROM information_schema.tables WHERE table_name='LabourPurchaseOrderLine'")" = "0" ] \
  && ok "fixture is genuinely pre-Task-2 (LabourPurchaseOrderLine absent)" || bad "pre-Task-2 fixture unexpectedly has the labour commercial schema"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": false' && ok "T2C preflight reported not-applicable on the pre-Task-2 database" || bad "T2C preflight did not report not-applicable pre-Task-2"
[ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "migrate.sh applied Task 2 + the correction over the pre-Task-2 database" || bad "migrate.sh failed on the pre-Task-2 database"

# ── Base for the clean + dirty cases: pre-correction Task-2 + a coherent chain ───────────────────
note "building the pre-correction Task-2 base (correction withheld) + a coherent labour chain"
BASE=pmcvitan_t2cpr_base
build_db "$BASE" "$CORR_STAMP"
corr_absent "$BASE" && ok "base is pre-correction (20270205 not applied)" || bad "base unexpectedly has the correction"
plant_coherent_chain "$BASE"
FP_HEX="$(q "$BASE" "SELECT $FPD")"

# ── Case 3 — clean pre-correction Task-2 database ────────────────────────────────────────────────
note "Case 3 — clean pre-correction Task-2 database"
DB=pmcvitan_t2cpr_clean
clone_db "$BASE" "$DB"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "T2C preflight reported applicable + clean" || bad "T2C preflight was not applicable+clean on the clean DB"
[ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "migrate.sh applied the correction after a clean T2C preflight" || bad "the correction did not apply after a clean preflight"

# ── Case 4 — dirty F5 / F3 / F2 / F4 (each independently blocks the runner) ───────────────────────
dirty_case() { # dirty_case <label> <code-grep> <fixture-sql> <repair-plan-json>
  local label="$1" codegrep="$2" fixture="$3" plan="$4"
  note "Case 4.$label — dirty $label: migrate.sh names $label and aborts BEFORE Prisma starts"
  local DB="pmcvitan_t2cpr_dirty_$(echo "$label" | tr 'A-Z' 'a-z')"
  clone_db "$BASE" "$DB"
  psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL || { bad "$label fixture failed"; return; }
$fixture
SQL
  run_migrate_sh "$DB"
  [ "$RUN_RC" != "0" ] && ok "migrate.sh exited non-zero (deploy blocked)" || bad "migrate.sh did not block a dirty $label deploy"
  echo "$RUN_OUT" | grep -Eq "$codegrep" && ok "the runner output NAMES $label" || { bad "the runner output did not name $label"; echo "$RUN_OUT" | tail -6; }
  echo "$RUN_OUT" | grep -q "Applying migration" && bad "prisma migrate deploy appears to have started" || ok "prisma migrate deploy was NOT started"
  corr_absent "$DB" && ok "migration 20270205 was NEVER started/recorded" || bad "a 20270205 record exists despite the abort"
  # explicit repair via the compiled artifact, then the SAME runner deploys cleanly
  DATABASE_URL="$URL_BASE/$DB?schema=public" node "$T2C_ARTIFACT" repair --plan "$plan" --operator ops@vitan.in --reason "$label reconciliation" >/tmp/t2cpr-repair-$label.log 2>&1 \
    && ok "the explicit $label repair committed (compiled artifact)" || { bad "the $label repair failed"; cat /tmp/t2cpr-repair-$label.log; }
  run_migrate_sh "$DB"
  echo "$RUN_OUT" | grep -q '"clean": true' && ok "the rerun T2C preflight is now clean" || bad "the rerun preflight is still dirty for $label"
  [ "$RUN_RC" = "0" ] && corr_applied "$DB" && ok "the SAME production runner then applied the correction cleanly" || bad "migrate.sh did not deploy after the $label repair"
  kill_conns "$DB"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || true
}

cat > "$PLANDIR/f5.json" <<JSON
{ "actions": [ { "finding": "F5", "op": "f5-set-committed-qty", "id": "POL-1", "committedQty": 3 } ] }
JSON
dirty_case "F5" 'F5' "UPDATE \"LabourPurchaseOrderLine\" SET \"committedQty\"=99 WHERE \"id\"='POL-1';" "$PLANDIR/f5.json"

cat > "$PLANDIR/f3.json" <<JSON
{ "actions": [ { "finding": "F3", "op": "f3-align-commitment", "id": "CC-2" } ] }
JSON
dirty_case "F3" 'F3' "INSERT INTO \"LabourPurchaseOrderLine\"(\"id\",\"projectId\",\"poVersionId\",\"requisitionLineId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"ratePerPersonShift\",\"shiftPremium\",\"committedAmountBase\",\"committedQty\") VALUES ('POL-2','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,1000,100,3300,0); INSERT INTO \"CapacityCommitment\"(\"id\",\"projectId\",\"poLineId\",\"labourSpecFingerprint\",\"civilDate\",\"shift\",\"personShiftQty\",\"createdById\") VALUES ('CC-2','p1','POL-2','FORGED','2026-08-12','day',3,'USER-1');" "$PLANDIR/f3.json"

cat > "$PLANDIR/f2.json" <<JSON
{ "actions": [ { "finding": "F2", "op": "f2-restore-reqline-identity", "id": "RL-2", "labourSpecFingerprint": "$FP_HEX", "shift": "day", "civilDate": "2026-08-12" } ] }
JSON
dirty_case "F2" 'F2 ABORT|"F2\.' "INSERT INTO \"LabourRequisitionLine\"(\"id\",\"projectId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"status\") VALUES ('RL-2','p1','REQU-1','REQ-1',1,'2026-08-12','day','FORGED',3,'open');" "$PLANDIR/f2.json"

cat > "$PLANDIR/f4.json" <<JSON
{ "actions": [ { "finding": "F4", "op": "f4-align-poline-terms", "id": "POL-3", "ratePerPersonShift": "1000", "shiftPremium": "100" } ] }
JSON
dirty_case "F4" 'F4' "INSERT INTO \"LabourPurchaseOrderLine\"(\"id\",\"projectId\",\"poVersionId\",\"requisitionLineId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"ratePerPersonShift\",\"shiftPremium\",\"committedAmountBase\",\"committedQty\") VALUES ('POL-3','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,500,0,1500,0);" "$PLANDIR/f4.json"

# ── Case 5 — already-corrected database ──────────────────────────────────────────────────────────
note "Case 5 — already-corrected database (through the correction)"
DB=pmcvitan_t2cpr_corrected
build_db "$DB" ""
corr_applied "$DB" && ok "fixture is already corrected (20270205 applied)" || bad "already-corrected fixture missing the correction"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "T2C preflight reported applicable + clean on the already-corrected DB" || bad "T2C preflight not applicable+clean when already corrected"
echo "$RUN_OUT" | grep -q '"state": "applied"' && ok "T2C preflight reported migration state = applied" || bad "T2C preflight did not report state=applied"
[ "$RUN_RC" = "0" ] && ok "migrate.sh is a clean no-op on the already-corrected DB" || bad "migrate.sh failed on the already-corrected DB"

# ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
note "cleanup"
for db in pmcvitan_t2cpr_fresh pmcvitan_t2cpr_pretask2 pmcvitan_t2cpr_base pmcvitan_t2cpr_clean pmcvitan_t2cpr_corrected; do
  kill_conns "$db"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 || true
done

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T2C PRODUCTION-RUNNER PROOF PASSED: scripts/migrate.sh enforces the compiled, schema-aware T2C"
  echo "preflight across fresh, pre-Task-2, clean pre-correction, dirty F5/F3/F2/F4 (each named + 20270205"
  echo "never started + explicit repair then clean redeploy) and already-corrected databases."
else
  echo "T2C PRODUCTION-RUNNER PROOF FAILED: see the assertions above."
fi
exit $FAIL
