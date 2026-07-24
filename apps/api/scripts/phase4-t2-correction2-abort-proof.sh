#!/usr/bin/env bash
# Phase 4 Task 2 correction ROUND 2 — the labour commercial-integrity migration
# ABORT → REPAIR → REDEPLOY proof, run INDEPENDENTLY for EACH finding F5, F3, F2, F4.
#
# The round-1 proof exercised F5 only, with a raw-UPDATE repair. This proof drives the REAL operator
# tooling (`t2c:preflight` + `t2c:repair`) end-to-end, once per finding, on an independent database:
#
#   base : every migration EXCEPT 20270205000000_phase4_t2_correction, applied via `prisma migrate
#          deploy` (recorded in _prisma_migrations), plus a fully COHERENT labour commercial chain.
#   per finding (F5, F3, F2, F4):
#     0. clone `base` (TEMPLATE) and plant EXACTLY ONE violation of that finding;
#     1. `t2c:preflight`      → names the finding, verdict not-clean, exit 3;
#     2. `prisma migrate deploy` → ABORTS naming the finding (the correction does not apply);
#     3. `t2c:repair --plan`  → ONE bounded tx: before-image evidence, MINIMAL trigger disable,
#        operator-authored fix (never fabricates provenance), re-enable+verify, in-tx re-diagnose,
#        commit-or-rollback;
#     4. `t2c:preflight`      → clean;
#     5. `migrate resolve --rolled-back` + `migrate deploy` → the correction applies;
#     6. assert the F2..F5 seals are installed and the repaired row is now coherent.
#
# DESTRUCTIVE for the two scratch databases only (default base/clone below). Connection via the
# standard PG* env vars; the dev container uses PGUSER=vitan PGPASSWORD=vitan.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-vitan}"
export PGPASSWORD="${PGPASSWORD:-vitan}"

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="$API_DIR/prisma/migrations"
CORR="20270205000000_phase4_t2_correction"
HELD="$MIG_DIR/../.t2c-held-$$"
BASE="${P4T2C2_BASE_DB:-pmcvitan_p4t2c2_base}"
CLONE="${P4T2C2_CLONE_DB:-pmcvitan_p4t2c2_clone}"
URL_BASE="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
FPD="encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex')"
PLANDIR="$(mktemp -d)"
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
CLI="src/labour/t2c/t2c.cli.ts"

restore_held() { [ -d "$HELD" ] && mv "$HELD" "$MIG_DIR/$CORR" 2>/dev/null || true; }
trap 'restore_held; rm -rf "$PLANDIR"' EXIT

note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }

kill_conns() { $PSQL_ADMIN -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true; }

preflight_json() { DATABASE_URL="$URL_BASE/$CLONE?schema=public" pnpm -s exec tsx "$CLI" preflight 2>/dev/null; }
run_repair() { DATABASE_URL="$URL_BASE/$CLONE?schema=public" pnpm -s exec tsx "$CLI" repair --plan "$1" --operator ops@vitan.in --reason "$2"; }

# ── build the coherent base (correction withheld across the deploy so it is NOT applied) ───────────
note "building base '$BASE' (all migrations except the correction) + a coherent labour chain"
kill_conns "$BASE"
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $BASE;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $BASE;" || exit 1
mv "$MIG_DIR/$CORR" "$HELD" || exit 1
DATABASE_URL="$URL_BASE/$BASE?schema=public" pnpm exec prisma migrate deploy >/tmp/p4t2c2-base-deploy.log 2>&1 \
  || { echo "FAILED: base migrate deploy (through the migration before the correction) errored"; cat /tmp/p4t2c2-base-deploy.log; exit 1; }
mv "$HELD" "$MIG_DIR/$CORR" || exit 1

psql -X -v ON_ERROR_STOP=1 -d "$BASE" >/dev/null <<SQL || { echo "FAILED: coherent chain did not apply"; exit 1; }
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
-- POL-1 COHERENT: committedQty 0 (within the ordered 3), rate/premium from QL-1, slice from RL-1
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty") VALUES ('POL-1','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,1000,100,3300,0);
INSERT INTO "CapacityCommitment"("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","createdById") VALUES ('CC-1','p1','POL-1',$FPD,'2026-08-12','day',3,'USER-1');
INSERT INTO "CapacityPromise"("id","projectId","commitmentId","seq","promisedDate","recordedById") VALUES ('CP-1','p1','CC-1',1,'2026-08-11','USER-1');
COMMIT;
SQL

FP_HEX="$(psql -X -tA -d "$BASE" -c "SELECT $FPD;")"
[ -n "$FP_HEX" ] && ok "base built; canonical fingerprint = ${FP_HEX:0:16}…" || { echo "FAILED: could not read fingerprint"; exit 1; }

# clone base, then run one INDEPENDENT abort→repair→redeploy cycle.
clone_base() {
  kill_conns "$CLONE"; kill_conns "$BASE"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $CLONE;" || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $CLONE TEMPLATE $BASE;" || exit 1
}

# run_cycle <FINDING-LABEL> <abort-grep> <plan.json> — steps 1..5 shared across findings.
run_cycle() {
  local label="$1" abortgrep="$2" plan="$3"
  note "$label — step 1: t2c:preflight names the finding (verdict not-clean, exit 3)"
  local pj; pj="$(preflight_json)"
  printf '%s' "$pj" | grep -q '"clean": false' && ok "preflight verdict is not-clean" || bad "preflight should be not-clean"
  printf '%s' "$pj" | grep -Eq "$abortgrep" && ok "preflight names the finding ($abortgrep)" || { bad "preflight did not name the finding"; printf '%s\n' "$pj"; }

  note "$label — step 2: prisma migrate deploy ABORTS naming the finding"
  if DATABASE_URL="$URL_BASE/$CLONE?schema=public" pnpm exec prisma migrate deploy >/tmp/p4t2c2-deploy1.log 2>&1; then
    bad "migrate deploy APPLIED the correction over the violation (it must abort)"
  else
    grep -Eq "$abortgrep" /tmp/p4t2c2-deploy1.log && ok "migrate deploy aborted naming the finding" || { bad "deploy aborted for the WRONG reason"; cat /tmp/p4t2c2-deploy1.log; }
  fi
  [ "$(psql -X -tA -d "$CLONE" -c "SELECT COUNT(*) FROM pg_constraint WHERE conname='LabourPurchaseOrderLine_committed_le_person_check';")" = "0" ] \
    && ok "no correction constraint leaked past the aborted deploy" || bad "a correction constraint leaked despite the abort"

  note "$label — step 3: t2c:repair applies the operator plan (evidence + minimal disable + re-verify)"
  if run_repair "$plan" "$label reconciliation" >/tmp/p4t2c2-repair.log 2>&1; then
    ok "repair committed"
  else
    bad "repair aborted unexpectedly"; cat /tmp/p4t2c2-repair.log
  fi
  [ "$(psql -X -tA -d "$CLONE" -c "SELECT COUNT(*) FROM \"T2CRepairAction\";" 2>/dev/null || echo 0)" -ge "1" ] \
    && ok "durable before-image evidence rows were recorded" || bad "no repair-evidence rows persisted"
  # every labour-commercial immutability trigger is enabled again after the repair
  local dis; dis="$(psql -X -tA -d "$CLONE" -c "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('LabourPurchaseOrderLine_frozen','CapacityCommitment_lifecycle_only') AND tgenabled<>'O';")"
  [ "$dis" = "0" ] && ok "the frozen/lifecycle triggers are re-enabled after the repair" || bad "a trigger was left disabled after repair"

  note "$label — step 4: t2c:preflight is now clean"
  preflight_json | grep -q '"clean": true' && ok "preflight is clean after repair" || bad "preflight still dirty after repair"

  note "$label — step 5: migrate resolve --rolled-back + migrate deploy applies the correction"
  DATABASE_URL="$URL_BASE/$CLONE?schema=public" pnpm exec prisma migrate resolve --rolled-back "$CORR" >/tmp/p4t2c2-resolve.log 2>&1 || true
  if DATABASE_URL="$URL_BASE/$CLONE?schema=public" pnpm exec prisma migrate deploy >/tmp/p4t2c2-deploy2.log 2>&1; then
    ok "migrate deploy applied the correction cleanly after repair"
  else
    bad "migrate deploy still failed after repair"; cat /tmp/p4t2c2-deploy2.log
  fi
  [ "$(psql -X -tA -d "$CLONE" -c "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('LabourPurchaseOrderLine_committed_le_person_check','CapacityCommitment_poLine_identity_fkey','LabourRequisitionLine_spec_identity_fkey','LabourPurchaseOrderLine_quote_provenance_fkey');")" = "4" ] \
    && ok "the F2/F3/F4/F5 seals are installed (4/4)" || bad "the correction did not fully install"
}

# ── F5 — committedQty > personShiftQty ────────────────────────────────────────────────────────────
note "FINDING F5 — a PO line whose committedQty (99) exceeds the ordered personShiftQty (3)"
clone_base
psql -X -v ON_ERROR_STOP=1 -d "$CLONE" -c "UPDATE \"LabourPurchaseOrderLine\" SET \"committedQty\"=99 WHERE \"id\"='POL-1';" >/dev/null || bad "F5 fixture failed"
cat > "$PLANDIR/f5.json" <<JSON
{ "actions": [ { "finding": "F5", "op": "f5-set-committed-qty", "id": "POL-1", "committedQty": 3 } ] }
JSON
run_cycle "F5" 'F5' "$PLANDIR/f5.json"
[ "$(psql -X -tA -d "$CLONE" -c "SELECT \"committedQty\" FROM \"LabourPurchaseOrderLine\" WHERE id='POL-1';")" = "3" ] \
  && ok "F5 repaired: committedQty set to the ledger truth (3)" || bad "F5 committedQty not repaired"

# ── F3 — a commitment whose slice identity differs from its PO line ────────────────────────────────
note "FINDING F3 — a commitment (CC-2) whose fingerprint differs from its PO line (POL-2)"
clone_base
psql -X -v ON_ERROR_STOP=1 -d "$CLONE" >/dev/null <<SQL || bad "F3 fixture failed"
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty") VALUES ('POL-2','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,1000,100,3300,0);
INSERT INTO "CapacityCommitment"("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","createdById") VALUES ('CC-2','p1','POL-2','FORGED','2026-08-12','day',3,'USER-1');
SQL
cat > "$PLANDIR/f3.json" <<JSON
{ "actions": [ { "finding": "F3", "op": "f3-align-commitment", "id": "CC-2" } ] }
JSON
run_cycle "F3" 'F3' "$PLANDIR/f3.json"
[ "$(psql -X -tA -d "$CLONE" -c "SELECT \"labourSpecFingerprint\"='$FP_HEX' FROM \"CapacityCommitment\" WHERE id='CC-2';")" = "t" ] \
  && ok "F3 repaired: CC-2 aligned to its PO line's canonical fingerprint" || bad "F3 commitment not aligned"

# ── F2 — a requisition line whose fingerprint is not the pinned spec's ─────────────────────────────
note "FINDING F2 — a requisition line (RL-2) carrying a forged fingerprint (not the pinned spec's)"
clone_base
psql -X -v ON_ERROR_STOP=1 -d "$CLONE" >/dev/null <<SQL || bad "F2 fixture failed"
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status") VALUES ('RL-2','p1','REQU-1','REQ-1',1,'2026-08-12','day','FORGED',3,'open');
SQL
cat > "$PLANDIR/f2.json" <<JSON
{ "actions": [ { "finding": "F2", "op": "f2-restore-reqline-identity", "id": "RL-2", "labourSpecFingerprint": "$FP_HEX", "shift": "day", "civilDate": "2026-08-12" } ] }
JSON
run_cycle "F2" 'F2 ABORT|"F2\.' "$PLANDIR/f2.json"
[ "$(psql -X -tA -d "$CLONE" -c "SELECT \"labourSpecFingerprint\"='$FP_HEX' FROM \"LabourRequisitionLine\" WHERE id='RL-2';")" = "t" ] \
  && ok "F2 repaired: RL-2 restored to the pinned spec's fingerprint" || bad "F2 requisition line not restored"

# ── F4 — a PO line whose rate/premium are not from the comparison-selected quote line ─────────────
note "FINDING F4 — a PO line (POL-3) whose rate/premium (500/0) match no selected quote line"
clone_base
psql -X -v ON_ERROR_STOP=1 -d "$CLONE" >/dev/null <<SQL || bad "F4 fixture failed"
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty") VALUES ('POL-3','p1','POV-1','RL-1','REQU-1','REQ-1',1,'2026-08-12','day',$FPD,3,500,0,1500,0);
SQL
cat > "$PLANDIR/f4.json" <<JSON
{ "actions": [ { "finding": "F4", "op": "f4-align-poline-terms", "id": "POL-3", "ratePerPersonShift": "1000", "shiftPremium": "100" } ] }
JSON
run_cycle "F4" 'F4' "$PLANDIR/f4.json"
[ "$(psql -X -tA -d "$CLONE" -c "SELECT \"ratePerPersonShift\"=1000 AND \"shiftPremium\"=100 AND \"committedAmountBase\"=3300 FROM \"LabourPurchaseOrderLine\" WHERE id='POL-3';")" = "t" ] \
  && ok "F4 repaired: POL-3 rate/premium aligned to QL-1 (committedAmountBase re-derived to 3300)" || bad "F4 PO line terms not aligned"

# ── F-neg — the engine REFUSES a fabricating plan (operator-supplied identity must be real) ────────
note "F-neg — a repair supplying a FORGED fingerprint is refused (no fabrication) and rolls back"
clone_base
psql -X -v ON_ERROR_STOP=1 -d "$CLONE" -c "INSERT INTO \"LabourRequisitionLine\"(\"id\",\"projectId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"status\") VALUES ('RL-9','p1','REQU-1','REQ-1',1,'2026-08-12','day','FORGED',3,'open');" >/dev/null || bad "F-neg fixture failed"
cat > "$PLANDIR/fneg.json" <<JSON
{ "actions": [ { "finding": "F2", "op": "f2-restore-reqline-identity", "id": "RL-9", "labourSpecFingerprint": "STILL-FORGED", "shift": "day", "civilDate": "2026-08-12" } ] }
JSON
if run_repair "$PLANDIR/fneg.json" "fabrication attempt" >/tmp/p4t2c2-fneg.log 2>&1; then
  bad "the fabricating repair COMMITTED (it must refuse — the supplied identity is not the pinned spec's)"
else
  ok "the fabricating repair was refused (rolled back)"
fi
[ "$(psql -X -tA -d "$CLONE" -c "SELECT \"labourSpecFingerprint\" FROM \"LabourRequisitionLine\" WHERE id='RL-9';")" = "FORGED" ] \
  && ok "RL-9 is unchanged (the refused repair rolled back — no partial write)" || bad "RL-9 was mutated by the refused repair"
[ "$(psql -X -tA -d "$CLONE" -c "SELECT COUNT(*) FROM \"T2CRepairAction\";" 2>/dev/null || echo 0)" = "0" ] \
  && ok "no evidence rows persisted through the rolled-back refusal" || bad "evidence survived a refused repair"

# ── cleanup ───────────────────────────────────────────────────────────────────────────────────────
kill_conns "$CLONE"; kill_conns "$BASE"
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $CLONE;" >/dev/null 2>&1 || true
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $BASE;" >/dev/null 2>&1 || true

echo ""
if [ "$FAIL" = "0" ]; then
  echo "P4T2C2 ABORT PROOF PASSED: F5, F3, F2 and F4 each independently ABORT the correction, are"
  echo "repaired by the audited t2c operator engine (evidence + minimal trigger disable + re-verify),"
  echo "and REDEPLOY cleanly with the F2..F5 seals installed; a fabricating plan is refused + rolled back."
  exit 0
else
  echo "P4T2C2 ABORT PROOF FAILED — see the FAILED lines above."
  exit 1
fi
