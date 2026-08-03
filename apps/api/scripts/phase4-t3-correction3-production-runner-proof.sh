#!/usr/bin/env bash
# Phase 4 Task 3 correction 3 — the PRODUCTION RUNNER enforces the T3C preflight, and the sanctioned
# repair NEVER deletes an attendance row. EXECUTED against PostgreSQL.
#
# The post-merge review found that `docs/RUNBOOK.md §P4T3C2`'s repair for a blank-`manualReason`
# muster (a) deleted the row, destroying the observation, its recorder and its correction chain, and
# (b) had no enforced preflight at all — the first thing that noticed a dirty database was
# `prisma migrate deploy` failing inside migration 20270220. This proof runs the ACTUAL
# `scripts/migrate.sh` (built once, using the COMPILED `dist/labour/t3c/t3c.cli.js` — never tsx) over
# the required database states and asserts the schema-aware gate does the right thing in each:
#
#   1. fresh empty database              → preflight "not applicable"; migrate deploy applies all.
#   2. database older than Task 3        → "not applicable" (no LabourAttendance); migrations run.
#   3. clean pre-20270220 Task-3 DB      → preflight applicable + clean; 20270220/20270225 then apply.
#   4. dirty F1.blank                    → preflight NAMES F1.blank and EXITS non-zero, so migrate.sh
#                                          aborts and 20270220 is NEVER started/recorded; an explicit
#                                          t3c repair (compiled artifact) then lets a rerun deploy
#                                          clean — AND THE ORIGINAL ROW IS STILL THERE, revoked,
#                                          marked, with its complete before-image in T3CRepairAction.
#   5. fabrication refusal               → a plan naming a HEALTHY row, or an unknown accountable
#                                          user, is REFUSED and rolls everything back (no row edited,
#                                          no evidence table left behind, append-only trigger on).
#   6. already-corrected database        → applicable + clean (state=applied); migrate deploy no-op.
#   8. forged marker (revoked, no evidence) → preflight NAMES F1.marker; deploy refused, 20270220 untouched.
#   7. pre-baseline (P3005) `db push` DB → the §C tables exist but the PREREQUISITE guards do not
#                                          (t3c seals: prerequisite-seals-missing), so the runner
#                                          REFUSES to baseline — nothing is resolved as applied.
#   7b. pre-baseline dump/restore DB     → a really-migrated schema without its ledger: the FULL
#                                          prerequisite inventory verified present, BOTH re-runnable
#                                          corrections' seals absent, so the runner leaves 20270220
#                                          AND 20270225 pending, the retried deploy really executes
#                                          them, and the seals are verified present AND live.
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
CORR2="20270220000000_phase4_t3_correction2"
CORR3="20270225000000_phase4_t3_correction3"
T3_STAMP=20270210000000      # first Task-3 migration (the §C time-capacity schema)
CORR2_STAMP=20270220000000   # the migration whose diagnostic aborts over a blank manual reason
URL_BASE="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
HOLD="$MIG_DIR/../.t3cpr-hold-$$"
PLANDIR="$(mktemp -d)"
MARKER='[invalid-legacy:blank-manual-reason]'
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
T3C_ARTIFACT="dist/labour/t3c/t3c.cli.js"

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
  DATABASE_URL="$URL_BASE/$db?schema=public" pnpm exec prisma migrate deploy >/tmp/t3cpr-build-$db.log 2>&1 \
    || { echo "build_db($db, withhold=${withhold_from:-none}) FAILED"; cat /tmp/t3cpr-build-$db.log; restore_all; exit 1; }
  restore_all
}

clone_db() { # clone_db src dst
  kill_conns "$2"; kill_conns "$1"
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $2;" >/dev/null || exit 1
  $PSQL_ADMIN -c "CREATE DATABASE $2 TEMPLATE $1;" >/dev/null || exit 1
}

run_migrate_sh() { RUN_OUT="$(DATABASE_URL="$URL_BASE/$1?schema=public" sh scripts/migrate.sh 2>&1)"; RUN_RC=$?; }

q() { psql -X -tA -d "$1" -c "$2" 2>/dev/null; }
corr2_applied() { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$CORR2' AND finished_at IS NOT NULL")" = "1" ]; }
corr3_applied() { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$CORR3' AND finished_at IS NOT NULL")" = "1" ]; }
corr2_absent()  { [ "$(q "$1" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '20270220%'")" = "0" ]; }

# A minimal COHERENT §C attendance chain (project p1 / org-p4t3). Everything a LabourAttendance row
# needs: org, project, pmc user, trade/skill, worker, and the command that recorded the muster.
plant_attendance_chain() {
  psql -X -v ON_ERROR_STOP=1 -d "$1" >/dev/null <<'SQL' || { echo "attendance chain did not apply"; exit 1; }
BEGIN;
INSERT INTO "Org" ("id","name","slug") VALUES ('org-p4t3','P4T3 Org','p4t3-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p1','org-p4t3','P4T3 Site','P4','','Structure','P4-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","email","passwordHash") VALUES ('USER-1','p1','pmc','P4T3 PMC','p4t3@vitan.in','h');
INSERT INTO "User" ("id","projectId","role","name","email","passwordHash") VALUES ('USER-2','p1','pmc','P4T3 Owner','p4t3o@vitan.in','h');
-- A revocation must be attributed to someone with STANDING on the project (an active membership,
-- or owner/admin of its org) — a user row alone is not accountability. USER-2 is the plan's revoker.
INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('MEM-1','p1','USER-1','pmc','active');
INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('MEM-2','p1','USER-2','pmc','active');
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('p1','mason','Mason','USER-1');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','bar-bending','Bar Bending','USER-1');
INSERT INTO "Worker"("id","projectId","name","tradeCode","activeFrom","createdById")
  VALUES ('W-1','p1','Ramesh','mason','2026-01-01','USER-1');
INSERT INTO "WorkerSkill"("projectId","workerId","skillCode") VALUES ('p1','W-1','bar-bending');
-- reserved-then-completed IN ONE TRANSACTION: the receipt protocol is DB-sealed
-- (20270425000000_platform_command_receipt_seal), and a directly minted `succeeded` row — or one
-- completed by a later transaction — is exactly the forgery that seal refuses.
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES ('CMD-1','project','org-p4t3','p1','USER-1','labour.attendance.record','k-1','h-1','reserved');
UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='ATT-1', "completedAt"=now()
 WHERE "id"='CMD-1';
COMMIT;
SQL
}

# ── build the COMPILED artifact once (production uses dist, never tsx) ────────────────────────────
note "building the compiled API artifact so dist/labour/t3c/t3c.cli.js exists"
pnpm --filter @vitan/shared build >/tmp/t3cpr-shared.log 2>&1 || { echo "shared build failed"; cat /tmp/t3cpr-shared.log; exit 1; }
pnpm --filter api build >/tmp/t3cpr-apibuild.log 2>&1 || { echo "api build failed"; tail -20 /tmp/t3cpr-apibuild.log; exit 1; }
[ -f "$T3C_ARTIFACT" ] && ok "compiled T3C preflight artifact present: $T3C_ARTIFACT" || { bad "compiled T3C preflight artifact missing after build"; exit 1; }
for a in dist/platform/t45/t45.cli.js dist/labour/t2c/t2c.cli.js; do
  [ -f "$a" ] && ok "compiled preflight artifact present: $a (migrate.sh runs all three)" || { bad "compiled artifact missing: $a"; exit 1; }
done

# ── Case 1 — fresh empty database ────────────────────────────────────────────────────────────────
note "Case 1 — fresh empty database"
DB=pmcvitan_t3cpr_fresh
kill_conns "$DB"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null; $PSQL_ADMIN -c "CREATE DATABASE $DB;" >/dev/null
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh succeeded on a fresh database" || { bad "migrate.sh failed on a fresh database"; echo "$RUN_OUT" | tail -8; }
echo "$RUN_OUT" | grep -q 'T3C preflight' && ok "the T3C preflight ran (after T45 and T2C)" || bad "the T3C preflight did not run"
corr3_applied "$DB" && ok "the round-3 correction migration applied over the fresh database" || bad "20270225 did not apply on the fresh database"

# ── Case 2 — database older than Task 3 ──────────────────────────────────────────────────────────
note "Case 2 — database older than Task 3 (no §C attendance schema)"
DB=pmcvitan_t3cpr_pretask3
build_db "$DB" "$T3_STAMP"
[ "$(q "$DB" "SELECT count(*) FROM information_schema.tables WHERE table_name='LabourAttendance'")" = "0" ] \
  && ok "fixture is genuinely pre-Task-3 (LabourAttendance absent)" || bad "pre-Task-3 fixture unexpectedly has the attendance schema"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q 'T3C diagnostics not applicable' && ok "T3C preflight reported not-applicable on the pre-Task-3 database" || bad "T3C preflight did not report not-applicable pre-Task-3"
[ "$RUN_RC" = "0" ] && corr3_applied "$DB" && ok "migrate.sh applied Task 3 + both corrections over the pre-Task-3 database" || bad "migrate.sh failed on the pre-Task-3 database"

# ── Base for the clean + dirty cases: pre-20270220 Task-3 + a coherent attendance chain ──────────
note "building the pre-20270220 Task-3 base (corrections 2+3 withheld) + a coherent attendance chain"
BASE=pmcvitan_t3cpr_base
build_db "$BASE" "$CORR2_STAMP"
corr2_absent "$BASE" && ok "base is pre-correction-2 (20270220 not applied)" || bad "base unexpectedly has 20270220"
plant_attendance_chain "$BASE"

# ── Case 3 — clean pre-correction Task-3 database ────────────────────────────────────────────────
note "Case 3 — clean pre-correction Task-3 database"
DB=pmcvitan_t3cpr_clean
clone_db "$BASE" "$DB"
psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL || bad "the coherent manual muster did not apply"
INSERT INTO "LabourAttendance"("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
  VALUES ('ATT-OK','p1','W-1','2026-08-10','day','device battery dead at gate','USER-1','CMD-1');
SQL
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "T3C preflight reported applicable + clean" || bad "T3C preflight was not applicable+clean on the clean DB"
[ "$RUN_RC" = "0" ] && corr3_applied "$DB" && ok "migrate.sh applied both corrections after a clean T3C preflight" || bad "the corrections did not apply after a clean preflight"
[ "$(q "$DB" "SELECT \"manualReason\" FROM \"LabourAttendance\" WHERE \"id\"='ATT-OK'")" = "device battery dead at gate" ] \
  && ok "the healthy muster is untouched by the upgrade" || bad "the healthy muster changed during the upgrade"

# ── Case 4 — dirty F1.blank blocks the runner, and the repair PRESERVES the row ───────────────────
note "Case 4 — dirty F1.blank: migrate.sh names it and aborts BEFORE Prisma starts"
DB=pmcvitan_t3cpr_dirty
clone_db "$BASE" "$DB"
psql -X -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL || bad "the blank-reason fixture did not apply"
INSERT INTO "LabourAttendance"("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId")
  VALUES ('ATT-BLANK','p1','W-1','2026-08-10','day','   ','2026-08-10 06:15:00+00','USER-1','CMD-1');
SQL
BEFORE_RECORDED_AT="$(q "$DB" "SELECT \"recordedAt\" FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")"
run_migrate_sh "$DB"
[ "$RUN_RC" != "0" ] && ok "migrate.sh exited non-zero (deploy blocked)" || bad "migrate.sh did not block the dirty deploy"
echo "$RUN_OUT" | grep -q 'F1.blank' && ok "the runner output NAMES F1.blank" || { bad "the runner output did not name F1.blank"; echo "$RUN_OUT" | tail -8; }
echo "$RUN_OUT" | grep -q 'ATT-BLANK' && ok "the runner output identifies the offending row" || bad "the runner output does not identify the row"
echo "$RUN_OUT" | grep -q "Applying migration" && bad "prisma migrate deploy appears to have started" || ok "prisma migrate deploy was NOT started"
corr2_absent "$DB" && ok "migration 20270220 was NEVER started/recorded" || bad "a 20270220 record exists despite the abort"

note "Case 5 — the repair REFUSES to fabricate, and rolls back completely"
cat > "$PLANDIR/healthy.json" <<JSON
{ "actions": [ { "finding": "F1.blank", "op": "f1-mark-invalid-legacy", "id": "ATT-OK-NOT-HERE", "revokedById": "USER-2", "revokeReason": "r" } ] }
JSON
DATABASE_URL="$URL_BASE/$DB?schema=public" node "$T3C_ARTIFACT" repair --plan "$PLANDIR/healthy.json" --operator ops@vitan.in --reason "bogus" >/tmp/t3cpr-refuse1.log 2>&1
[ $? -ne 0 ] && ok "a plan naming a nonexistent row is REFUSED" || bad "a plan naming a nonexistent row was accepted"
cat > "$PLANDIR/badusr.json" <<JSON
{ "actions": [ { "finding": "F1.blank", "op": "f1-mark-invalid-legacy", "id": "ATT-BLANK", "revokedById": "NO-SUCH-USER", "revokeReason": "r" } ] }
JSON
DATABASE_URL="$URL_BASE/$DB?schema=public" node "$T3C_ARTIFACT" repair --plan "$PLANDIR/badusr.json" --operator ops@vitan.in --reason "bogus" >/tmp/t3cpr-refuse2.log 2>&1
[ $? -ne 0 ] && ok "a plan naming an unknown accountable user is REFUSED (never fabricated)" || bad "an unknown revokedById was accepted"
grep -q 'has no attendance-revoke standing on project' /tmp/t3cpr-refuse2.log && ok "the refusal names the reason explicitly" || bad "the refusal message is not explicit"
[ "$(q "$DB" "SELECT \"manualReason\" FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "   " ] \
  && ok "the refused repairs left the row byte-for-byte unchanged" || bad "a refused repair modified the row"
[ "$(q "$DB" "SELECT to_regclass('\"T3CRepairAction\"') IS NOT NULL")" = "f" ] \
  && ok "a rolled-back repair left NO evidence table behind" || bad "a rolled-back repair left the evidence table behind"
[ "$(q "$DB" "SELECT tgenabled FROM pg_trigger WHERE tgname='LabourAttendance_append_only'")" = "O" ] \
  && ok "the append-only trigger is still enabled after the rollbacks" || bad "the append-only trigger was left disabled"

note "Case 4 (cont.) — the sanctioned repair marks and revokes, and NEVER deletes"
cat > "$PLANDIR/repair.json" <<JSON
{ "actions": [ { "finding": "F1.blank", "op": "f1-mark-invalid-legacy", "id": "ATT-BLANK", "revokedById": "USER-2",
  "revokeReason": "the original justification was never recorded; raise a replacement muster if this presence is real" } ] }
JSON
DATABASE_URL="$URL_BASE/$DB?schema=public" node "$T3C_ARTIFACT" repair --plan "$PLANDIR/repair.json" --operator ops@vitan.in --reason "P4T3C3 retire pre-20270220 blank musters" >/tmp/t3cpr-repair.log 2>&1 \
  && ok "the explicit repair committed (compiled artifact)" || { bad "the repair failed"; cat /tmp/t3cpr-repair.log; }
[ "$(q "$DB" "SELECT count(*) FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "1" ] \
  && ok "THE ORIGINAL ROW IS STILL THERE — the repair deleted nothing" || bad "the repair deleted the attendance row"
[ "$(q "$DB" "SELECT \"recordedById\" FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "USER-1" ] \
  && ok "the original recorder attribution survives" || bad "the recorder attribution was lost"
[ "$(q "$DB" "SELECT \"recordedAt\" FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "$BEFORE_RECORDED_AT" ] \
  && ok "the original recordedAt survives verbatim" || bad "recordedAt changed"
[ "$(q "$DB" "SELECT \"revokedAt\" IS NOT NULL AND \"revokedById\"='USER-2' FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "t" ] \
  && ok "the row is REVOKED and attributed — it can contribute no active presence" || bad "the repaired row is still live"
[ "$(q "$DB" "SELECT \"manualReason\" LIKE '$MARKER%' FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "t" ] \
  && ok "the reserved invalid-legacy marker is in place" || bad "the marker was not written"
[ "$(q "$DB" "SELECT \"beforeImage\"->>'manualReason' FROM \"T3CRepairAction\" WHERE \"rowId\"='ATT-BLANK'")" = "   " ] \
  && ok "the COMPLETE before-image preserves the original blank bytes" || bad "the before-image does not carry the original value"
[ "$(q "$DB" "SELECT \"operator\" FROM \"T3CRepairAction\" WHERE \"rowId\"='ATT-BLANK'")" = "ops@vitan.in" ] \
  && ok "the repair evidence names the operator" || bad "the repair evidence has no operator"
[ "$(q "$DB" "SELECT tgenabled FROM pg_trigger WHERE tgname='LabourAttendance_append_only'")" = "O" ] \
  && ok "the append-only trigger was re-enabled and verified before commit" || bad "the append-only trigger is not enabled after the repair"

note "Case 4 (cont.) — the SAME production runner now deploys cleanly"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"clean": true' && ok "the rerun T3C preflight is now clean" || { bad "the rerun preflight is still dirty"; echo "$RUN_OUT" | tail -8; }
[ "$RUN_RC" = "0" ] && corr3_applied "$DB" && ok "the SAME production runner then applied both corrections cleanly" || bad "migrate.sh did not deploy after the repair"
[ "$(q "$DB" "SELECT count(*) FROM \"LabourAttendance\" WHERE \"id\"='ATT-BLANK'")" = "1" ] \
  && ok "the retired muster is STILL queryable after the upgrade" || bad "the retired muster vanished during the upgrade"
# and once 20270225 is in, the marker is unforgeable and a marked row can never be left live
psql -X -q -d "$DB" -c "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES ('ATT-FORGE','p1','W-1','2026-08-20','day','$MARKER forged','USER-1','CMD-1');" >/tmp/t3cpr-forge.log 2>&1
[ $? -ne 0 ] && ok "a forged invalid-legacy marker is REJECTED after the correction applies" || bad "a forged marker was accepted"

# ── Case 6 — already-corrected database ──────────────────────────────────────────────────────────
note "Case 6 — already-corrected database (through both corrections)"
DB=pmcvitan_t3cpr_corrected
build_db "$DB" ""
corr3_applied "$DB" && ok "fixture is already corrected (20270225 applied)" || bad "already-corrected fixture missing the correction"
run_migrate_sh "$DB"
echo "$RUN_OUT" | grep -q '"applicable": true' && echo "$RUN_OUT" | grep -q '"clean": true' \
  && ok "T3C preflight reported applicable + clean on the already-corrected DB" || bad "T3C preflight not applicable+clean when already corrected"
echo "$RUN_OUT" | grep -q '"state": "applied"' && ok "T3C preflight reported migration state = applied" || bad "T3C preflight did not report state=applied"
[ "$RUN_RC" = "0" ] && ok "migrate.sh is a clean no-op on the already-corrected DB" || bad "migrate.sh failed on the already-corrected DB"

# ── Case 8 — a FORGED marker (revoked, but with no repair evidence) blocks the deploy ─────────────
# Until 20270225 installs the reserving trigger, a direct writer can insert a marked row and fill in
# the revocation triple, because that is what a real repair looks like. A revoked-only test would
# bless it forever as an audited operator repair while no before-image has ever existed. The
# diagnostic therefore demands the matching `T3CRepairAction` row for the repair id the marker
# embeds — and here there is no evidence table at all, which is decisive: no repair has ever run.
note "Case 8 — a forged marker with no repair evidence"
DB=pmcvitan_t3cpr_forged
clone_db pmcvitan_t3cpr_base "$DB"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL || { bad "could not plant the forged marker"; }
INSERT INTO "LabourAttendance"
  ("id","projectId","workerId","civilDate","shift","manualReason","recordedAt","recordedById","sourceCommandId","revokedAt","revokedById","revokeReason")
VALUES ('ATT-FORGED','p1','W-1','2026-08-10','day',
        '$MARKER repair=00000000-0000-0000-0000-000000000000; looks official', now(), 'USER-1','CMD-1',
        now(),'USER-1','looks like a repair');
SQL
[ "$(q "$DB" "SELECT to_regclass('\"T3CRepairAction\"') IS NULL")" = "t" ] \
  && ok "no repair has ever run here — there is no evidence table" || bad "the forged fixture unexpectedly has an evidence table"

run_migrate_sh "$DB"
[ "$RUN_RC" != "0" ] && ok "migrate.sh REFUSED to deploy over the forged marker" || bad "migrate.sh deployed over a forged marker"
echo "$RUN_OUT" | grep -q 'F1.marker' && ok "the runner output NAMES F1.marker" || bad "the runner did not name F1.marker"
echo "$RUN_OUT" | grep -q 'ATT-FORGED' && ok "the runner output identifies the forged row" || bad "the runner did not identify the forged row"
corr2_absent "$DB" && ok "migration 20270220 was NEVER started/recorded" || bad "20270220 was recorded despite the forged marker"

# ── Case 7 — PRE-BASELINE (P3005) `db push` database: REFUSED, never silently reconciled ──────────
# A schema created by `prisma db push` has no `_prisma_migrations`, so `migrate deploy` answers
# P3005 and the runner would baseline. But `db push` reproduces only what schema.prisma MODELS: it
# creates NONE of the raw-SQL guards — not just correction 3's, but the PREREQUISITES from
# 20270210/20270215 (`WorkerAllocation_head_live` among them, the guard that refuses an allocation
# against a CANCELLED requirement under the root lock). Those migrations CREATE TABLE, so they cannot
# be left pending to re-run the way correction 3 can, and resolving them as applied records guards
# that do not exist — correction 3 CREATE OR REPLACEs head_live's FUNCTION but never creates the
# TRIGGER, so nothing downstream would ever notice. An earlier round left only 20270225 pending here
# and exited 0, which was exactly that hole (the round-3g review's finding K). The runner now REFUSES
# to baseline this shape: which schema it actually is becomes a human judgement.
note "Case 7 — pre-baseline (P3005) database created by db push is REFUSED"
DB=pmcvitan_t3cpr_dbpush
kill_conns "$DB"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" >/dev/null; $PSQL_ADMIN -c "CREATE DATABASE $DB;" >/dev/null
DATABASE_URL="$URL_BASE/$DB?schema=public" pnpm exec prisma db push --skip-generate --accept-data-loss >/tmp/t3cpr-dbpush.log 2>&1 \
  || { echo "db push failed"; tail -20 /tmp/t3cpr-dbpush.log; bad "could not build the pre-baseline fixture"; }

# The premise, stated as an assertion rather than assumed: the tables are there, the guards are not.
[ "$(q "$DB" "SELECT to_regclass('\"LabourAttendance\"') IS NOT NULL")" = "t" ] \
  && ok "db push created the §C tables (so the preflight considers this database eligible)" \
  || bad "db push did not create LabourAttendance"
[ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname IN ('WorkerAllocation_00_project_lock','WorkerAllocation_head_live')")" = "0" ] \
  && ok "db push created NEITHER the correction-3 seals NOR the prerequisite guards (the exact hazard)" \
  || bad "db push unexpectedly created raw-SQL triggers"
[ "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\"" 2>/dev/null)" = "" ] \
  && ok "no _prisma_migrations ledger — migrate deploy will answer P3005" \
  || bad "the db-push fixture already has a migration ledger"

run_migrate_sh "$DB"
[ "$RUN_RC" != "0" ] && ok "migrate.sh REFUSED to baseline the db-push database" || { bad "migrate.sh baselined a db-push database whose prerequisite guards do not exist"; echo "$RUN_OUT" | tail -20; }
echo "$RUN_OUT" | grep -q "P3005" && ok "the P3005 baseline branch was taken" || bad "the P3005 branch was not taken"
echo "$RUN_OUT" | grep -q "prerequisite-seals-missing" && ok "the refusal NAMES the prerequisite-seals state" || bad "the refusal did not name prerequisite-seals-missing"
echo "$RUN_OUT" | grep -q "Refusing to baseline" && ok "the runner refused rather than resolving migrations that never ran" || bad "no explicit refusal in the output"
[ "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\"" 2>/dev/null)" = "" ] \
  && ok "NOTHING was resolved as applied — the ledger is still absent" \
  || bad "the runner recorded migrations as applied before refusing"

# ── Case 7b — prerequisites PRESENT, corrections absent: pending, executed, verified ──────────────
# The legitimate shape the leave-pending path exists for: a database that really ran the deployed
# migrations (every prerequisite guard is installed) but was dumped/restored WITHOUT the two
# re-runnable corrections' objects and without its `_prisma_migrations` ledger. A CLONE of the
# migrated pre-correction base minus that ledger IS that database — nothing is hand-installed, so it
# carries the FULL raw-SQL prerequisite inventory (triggers, the inline CHECKs, the partial uniques,
# the composite FKs) exactly as the deployed migrations created it. A db-push-plus-replay fixture
# cannot stand in here any more: the 20270210 CHECKs are inline in CREATE TABLE, which fails over an
# existing table, so the replayed fixture would be missing them and round 3h's full-inventory seals
# check would (rightly) answer 5 for it. `t3c seals` answers 3 naming BOTH corrections in
# `pendingMigrations` (20270220's CHECK is its own pending layer), the runner leaves exactly those
# two pending, the retried deploy executes them in order, and the post-deploy check proves the
# objects exist and enforce.
note "Case 7b — prerequisites present, corrections absent: left pending and really executed"
DB=pmcvitan_t3cpr_restored
clone_db "$BASE" "$DB"
psql -X -q -d "$DB" -c 'DROP TABLE "_prisma_migrations";' >/dev/null 2>&1
[ "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\"" 2>/dev/null)" = "" ] \
  && ok "the migration ledger is gone — migrate deploy will answer P3005" \
  || bad "could not remove the migration ledger from the restored fixture"
# The premise, asserted: the full prerequisite inventory is here (it came from the real migrations)…
PREREQ_TRIGGERS="LabourAttendance_append_only WorkerAllocation_frozen LabourWorkFact_append_only ApprovedSkillSubstitution_append_only LabourWorkFact_matches_allocation WorkerAllocation_worker_active LabourAttendance_device_bound WorkerAllocation_within_commitment WorkerAllocation_head_live"
MISSING_PREREQ=""
for trg in $PREREQ_TRIGGERS; do
  [ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='$trg' AND tgenabled='O'")" = "1" ] || MISSING_PREREQ="$MISSING_PREREQ $trg"
done
[ -z "$MISSING_PREREQ" ] \
  && ok "all nine prerequisite guard triggers present on the restored fixture" \
  || bad "restored fixture is missing prerequisite triggers:$MISSING_PREREQ"
[ "$(q "$DB" "SELECT count(*) FROM pg_constraint WHERE conname='WorkerAllocation_release_attribution_check'")" = "1" ] \
  && ok "the inline prerequisite CHECKs are present (a db-push replay could never install these)" \
  || bad "restored fixture is missing the inline prerequisite CHECKs"
[ "$(q "$DB" "SELECT count(*) FROM pg_indexes WHERE indexname='WorkerAllocation_live_slice_key'")" = "1" ] \
  && ok "the partial-unique prerequisite keys are present" || bad "restored fixture is missing the partial uniques"
[ "$(q "$DB" "SELECT count(*) FROM pg_constraint WHERE conname='WorkerAllocation_commitment_fkey'")" = "1" ] \
  && ok "the composite-FK prerequisites are present" || bad "restored fixture is missing the composite FKs"
# …and BOTH corrections' objects are absent (only they may be left pending).
[ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='WorkerAllocation_00_project_lock'")" = "0" ] \
  && ok "correction 3's own seals are absent" || bad "correction-3 seals unexpectedly present"
[ "$(q "$DB" "SELECT count(*) FROM pg_constraint WHERE conname='LabourAttendance_manual_reason_non_blank'")" = "0" ] \
  && ok "correction 2's CHECK is absent (its own pending layer under round 3h)" \
  || bad "correction-2 CHECK unexpectedly present"

run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh completed on the restored database" || { bad "migrate.sh failed on the restored database"; echo "$RUN_OUT" | tail -20; }
echo "$RUN_OUT" | grep -q "seals MISSING" && ok "the runner NOTICED the correction seals were missing" || bad "the runner did not check the correction seals"
echo "$RUN_OUT" | grep -q "skipping resolve --applied for $CORR3" \
  && ok "20270225 was left PENDING instead of being resolved as applied" \
  || bad "20270225 was blanket-resolved as applied without executing"
echo "$RUN_OUT" | grep -q "skipping resolve --applied for $CORR2" \
  && ok "20270220 was left PENDING too — its CHECK is its own pending layer" \
  || bad "20270220 was blanket-resolved as applied without executing"

# The decisive assertion: the objects EXIST afterwards, so the deployment really carries the seals.
for trg in LabourAttendance_reserved_marker WorkerAllocation_00_project_lock; do
  [ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='$trg'")" = "1" ] \
    && ok "seal installed after baseline+deploy: $trg" || bad "seal STILL missing after baseline+deploy: $trg"
done
[ "$(q "$DB" "SELECT count(*) FROM pg_constraint WHERE conname='LabourAttendance_marker_is_revoked'")" = "1" ] \
  && ok "seal installed after baseline+deploy: LabourAttendance_marker_is_revoked" \
  || bad "CHECK STILL missing after baseline+deploy"
[ "$(q "$DB" "SELECT convalidated FROM pg_constraint WHERE conname='LabourAttendance_manual_reason_non_blank'")" = "t" ] \
  && ok "20270220's CHECK installed VALIDATED after baseline+deploy — because it actually ran" \
  || bad "20270220's CHECK missing or NOT VALID after baseline+deploy"
corr2_applied "$DB" && ok "20270220 is recorded applied — because it actually ran" || bad "20270220 is not recorded applied"
corr3_applied "$DB" && ok "20270225 is recorded applied — because it actually ran" || bad "20270225 is not recorded applied"

# …and the seals are real, not just present: a forged marker insert is rejected. Every referenced
# row (p1/W-1/USER-1/CMD-1) exists in the planted chain, so the ONLY thing refusing this insert is
# the reserved-marker trigger — not an incidental FK.
psql -X -q -d "$DB" -c "INSERT INTO \"LabourAttendance\" (\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedAt\",\"recordedById\",\"sourceCommandId\") VALUES ('x','p1','W-1','2026-01-01','day','$MARKER forged', now(), 'USER-1', 'CMD-1');" >/dev/null 2>&1 \
  && bad "a forged marker was accepted on the baselined database" \
  || ok "a forged marker is rejected on the baselined database — the seal is live"

# A SECOND run is a clean no-op: the seals are present, so the normal path resolves everything.
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "a repeat migrate.sh run on the baselined database is a clean no-op" || bad "repeat migrate.sh run failed"

# ── Case 9 — ORDINARY success path: a hollowed prerequisite body fails the deploy CLOSED ──────────
# `prisma migrate deploy` proves the LEDGER is complete, not that the physical guards enforce.
# `CREATE OR REPLACE FUNCTION` preserves a function's identity, so on a fully-migrated database a
# no-op `phase4_t3_skill_substitution_append_only` — right name, right trigger, right tgtype,
# enforcing NOTHING — used to ride the ordinary success path straight to exit 0: nothing was
# pending, nothing re-ran, and the runner never re-asked `t3c seals`. The post-deploy verification
# must catch it, name it, and refuse the deploy.
note "Case 9 — ordinary path: hollowed prerequisite trigger body is refused by the post-deploy seal verification"
DB=pmcvitan_t3cpr_hollow
build_db "$DB"
psql -X -q -d "$DB" -c "CREATE OR REPLACE FUNCTION phase4_t3_skill_substitution_append_only() RETURNS trigger AS \$\$ BEGIN RETURN NEW; END; \$\$ LANGUAGE plpgsql;" >/dev/null \
  || { bad "could not hollow the skill-substitution body"; }
run_migrate_sh "$DB"
[ "$RUN_RC" != "0" ] && ok "migrate.sh REFUSES the ordinary deploy over a hollowed body (rc=$RUN_RC)" \
  || bad "migrate.sh exited 0 over a hollowed skill-substitution body — the ordinary path is not verified"
echo "$RUN_OUT" | grep -q "ApprovedSkillSubstitution_append_only" \
  && ok "the refusal NAMES the unenforcing seal (ApprovedSkillSubstitution_append_only)" \
  || bad "the refusal does not name the seal"
echo "$RUN_OUT" | grep -q "seal verification FAILED" \
  && ok "the refusal states the ledger-complete-but-guard-hollow diagnosis" \
  || bad "the refusal does not state the diagnosis"
# Restore the canonical body BYTE-EXACTLY from the compiled generated module — the same runner then
# passes: the check is precise, not merely strict.
node -e "
const { T3C_CANONICAL_FN_BODIES } = require('./dist/labour/t3c/t3c-canonical-fn-bodies.generated.js');
const body = T3C_CANONICAL_FN_BODIES.phase4_t3_skill_substitution_append_only[0].body;
process.stdout.write('CREATE OR REPLACE FUNCTION phase4_t3_skill_substitution_append_only() RETURNS trigger AS \$canon\$' + body + '\$canon\$ LANGUAGE plpgsql;');
" > /tmp/t3cpr-restore-skill-fn.sql || bad "could not extract the canonical body from the compiled module"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/t3cpr-restore-skill-fn.sql >/dev/null \
  || bad "could not restore the canonical skill-substitution body"
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "with the canonical body restored the SAME runner deploys cleanly (precision, not just strictness)" \
  || bad "migrate.sh still refuses after the canonical body was restored"

# ── Case 10 — P3005 body-only-stale: `pendingMigrations` is PARSED, the label grep is dead ───────
# A really-migrated dump/restore can carry 20270220's CHECK while `phase4_t3_attendance_append_only`
# is still bound to the 20270210 body. `correctionSeals()` deliberately attributes that heal to
# 20270225 ALONE (`pendingMigrations`), because re-running 20270220 over its own existing CHECK
# fails the whole deploy — but its JSON also names the stale layer as
# `phase4_t3_attendance_append_only@20270220…` in `correction2Missing`, and the runner's old
# whole-output grep saw that label, left 20270220 pending anyway, and the retry aborted on the
# already-existing constraint. The runner must resolve 20270220 as applied, execute ONLY 20270225,
# and the in-block heal then makes the body canonical.
note "Case 10 — P3005 body-only-stale: only the ATTRIBUTED migration is left pending"
DB=pmcvitan_t3cpr_stale
build_db "$DB"
psql -X -q -d "$DB" -c 'DROP TABLE "_prisma_migrations";' >/dev/null 2>&1
node -e "
const { T3C_CANONICAL_FN_BODIES } = require('./dist/labour/t3c/t3c-canonical-fn-bodies.generated.js');
const layers = T3C_CANONICAL_FN_BODIES.phase4_t3_attendance_append_only;
const base = layers.find((l) => l.layer.startsWith('20270210'));
process.stdout.write('CREATE OR REPLACE FUNCTION phase4_t3_attendance_append_only() RETURNS trigger AS \$stale\$' + base.body + '\$stale\$ LANGUAGE plpgsql;');
" > /tmp/t3cpr-stale-attendance-fn.sql || bad "could not extract the 20270210 body from the compiled module"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/t3cpr-stale-attendance-fn.sql >/dev/null \
  || bad "could not regress the attendance append-only body"
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh completes the P3005 body-only-stale baseline (rc=0)" \
  || { bad "migrate.sh failed on the body-only-stale P3005 database (rc=$RUN_RC)"; echo "$RUN_OUT" | tail -20; }
echo "$RUN_OUT" | grep -q "skipping resolve --applied for $CORR3" \
  && ok "20270225 was left pending (the attributed healing layer really executes)" \
  || bad "20270225 was not left pending"
echo "$RUN_OUT" | grep -q "skipping resolve --applied for $CORR2" \
  && bad "20270220 was left pending off a correction2Missing LABEL — the retry would abort on its existing constraint" \
  || ok "20270220 was resolved as applied — the label in correction2Missing no longer fools the runner"
STALE_MD5=$(q "$DB" "SELECT md5(p.prosrc) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgname = 'LabourAttendance_append_only' AND t.tgrelid = '\"LabourAttendance\"'::regclass AND NOT t.tgisinternal")
CANON_MD5=$(node -e "
const { createHash } = require('crypto');
const { T3C_CANONICAL_FN_BODIES } = require('./dist/labour/t3c/t3c-canonical-fn-bodies.generated.js');
const l = T3C_CANONICAL_FN_BODIES.phase4_t3_attendance_append_only.find((x) => x.layer.startsWith('20270220'));
process.stdout.write(createHash('md5').update(l.body).digest('hex'));
")
[ "$STALE_MD5" = "$CANON_MD5" ] \
  && ok "the executed 20270225 healed the body to the canonical correction-2 text (md5 verified)" \
  || bad "the attendance append-only body is still stale after the baseline deploy ($STALE_MD5 != $CANON_MD5)"

# ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
note "cleanup"
for db in pmcvitan_t3cpr_fresh pmcvitan_t3cpr_pretask3 pmcvitan_t3cpr_base pmcvitan_t3cpr_clean pmcvitan_t3cpr_dirty pmcvitan_t3cpr_corrected pmcvitan_t3cpr_dbpush pmcvitan_t3cpr_restored pmcvitan_t3cpr_forged pmcvitan_t3cpr_hollow pmcvitan_t3cpr_stale; do
  kill_conns "$db"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 || true
done

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T3C PRODUCTION-RUNNER PROOF PASSED: scripts/migrate.sh enforces the compiled, schema-aware T3C"
  echo "preflight across fresh, pre-Task-3, clean pre-correction, dirty F1.blank (named + 20270220 never"
  echo "started + fabrication refused + explicit repair then clean redeploy), already-corrected and"
  echo "pre-baseline P3005 databases — a db-push schema is REFUSED (prerequisite guards absent), and a"
  echo "really-migrated dump/restore has BOTH re-runnable corrections' raw-SQL seals VERIFIED and really"
  echo "executed rather than blanket-resolved as applied. The ORDINARY success path verifies the full"
  echo "seal set after every deploy — a ledger-complete database carrying a hollowed prerequisite"
  echo "trigger body is refused by name, and the canonical body deploys cleanly. And the repair MARKS"
  echo "AND REVOKES, preserving the original row, its recorder, its timestamps and a complete"
  echo "before-image. No attendance row is ever deleted."
else
  echo "T3C PRODUCTION-RUNNER PROOF FAILED: see the assertions above."
fi
exit $FAIL
