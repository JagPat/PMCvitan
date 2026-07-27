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
#   7. pre-baseline (P3005) `db push` DB → the raw-SQL seals are ABSENT though the tables exist, so
#                                          the runner leaves 20270225 PENDING instead of resolving it
#                                          as applied, the retried deploy really executes it, and the
#                                          seals are then verified present AND live (forgery rejected).
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
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES ('CMD-1','project','org-p4t3','p1','USER-1','labour.attendance.record','k-1','h-1','succeeded');
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
grep -q 'has no standing on project' /tmp/t3cpr-refuse2.log && ok "the refusal names the reason explicitly" || bad "the refusal message is not explicit"
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

# ── Case 7b — prerequisites PRESENT, correction 3 absent: pending, executed, verified ─────────────
# The legitimate shape the leave-pending path exists for: a database that really ran the deployed
# migrations (the prerequisite guards are installed) but was dumped/restored WITHOUT correction 3's
# objects and without its ledger. Installing the prerequisite raw SQL by hand turns the db-push
# fixture into exactly that. `t3c seals` answers 3 (correction seals missing, prerequisites fine),
# the runner leaves ONLY 20270225 pending, the retried deploy executes it, and the post-deploy check
# proves the objects exist and enforce.
note "Case 7b — prerequisites present, correction 3 absent: left pending and really executed"
# The Task-3 migrations reference ONE function a `db push` database lacks: phase3_immutable_row(),
# defined by the deployed 20261230000000_phase3_t5_stock_flows migration (`db push` reproduces no
# functions). Install that definition VERBATIM from the deployed file — nothing hand-written — so
# the replay of 20270210/20270215 really installs every prerequisite guard.
sed -n '/^CREATE OR REPLACE FUNCTION phase3_immutable_row/,/^\$\$ LANGUAGE plpgsql;/p' \
  prisma/migrations/20261230000000_phase3_t5_stock_flows/migration.sql \
  | psql -X -q -d "$DB" >/tmp/t3cpr-prereq0.log 2>&1 || true
psql -X -q -d "$DB" -f prisma/migrations/20270210000000_phase4_t3_time_capacity/migration.sql >/tmp/t3cpr-prereq1.log 2>&1 || true
psql -X -q -d "$DB" -f prisma/migrations/20270215000000_phase4_t3_correction/migration.sql >/tmp/t3cpr-prereq2.log 2>&1 || true
# The fixture must hold EVERY prerequisite guard the runner's seals check requires. (Asserting a
# single trigger once let an incomplete replay — the missing function above — masquerade as the
# legitimate shape, and every later assertion failed against a fixture that was never built.)
PREREQ_TRIGGERS="LabourAttendance_append_only WorkerAllocation_frozen LabourWorkFact_append_only ApprovedSkillSubstitution_append_only LabourWorkFact_matches_allocation WorkerAllocation_worker_active LabourAttendance_device_bound WorkerAllocation_within_commitment WorkerAllocation_head_live"
MISSING_PREREQ=""
for trg in $PREREQ_TRIGGERS; do
  [ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='$trg' AND tgenabled='O'")" = "1" ] || MISSING_PREREQ="$MISSING_PREREQ $trg"
done
[ -z "$MISSING_PREREQ" ] \
  && ok "ALL nine prerequisite guards installed by replaying the deployed migrations' raw SQL" \
  || { echo "prereq install failed — missing:$MISSING_PREREQ"; tail -5 /tmp/t3cpr-prereq0.log /tmp/t3cpr-prereq1.log /tmp/t3cpr-prereq2.log; bad "could not build the prerequisites-present fixture"; }
[ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='WorkerAllocation_00_project_lock'")" = "0" ] \
  && ok "correction 3's own seals are still absent (only they may be left pending)" \
  || bad "correction-3 seals unexpectedly present"

run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "migrate.sh completed on the prerequisites-present database" || { bad "migrate.sh failed on the prerequisites-present database"; echo "$RUN_OUT" | tail -20; }
echo "$RUN_OUT" | grep -q "seals MISSING" && ok "the runner NOTICED the correction-3 seals were missing" || bad "the runner did not check the correction-3 seals"
echo "$RUN_OUT" | grep -q "skipping resolve --applied for $CORR3" \
  && ok "20270225 was left PENDING instead of being resolved as applied" \
  || bad "20270225 was blanket-resolved as applied without executing"

# The decisive assertion: the objects EXIST afterwards, so the deployment really carries the seals.
for trg in LabourAttendance_reserved_marker WorkerAllocation_00_project_lock; do
  [ "$(q "$DB" "SELECT count(*) FROM pg_trigger WHERE tgname='$trg'")" = "1" ] \
    && ok "seal installed after baseline+deploy: $trg" || bad "seal STILL missing after baseline+deploy: $trg"
done
[ "$(q "$DB" "SELECT count(*) FROM pg_constraint WHERE conname='LabourAttendance_marker_is_revoked'")" = "1" ] \
  && ok "seal installed after baseline+deploy: LabourAttendance_marker_is_revoked" \
  || bad "CHECK STILL missing after baseline+deploy"
corr3_applied "$DB" && ok "20270225 is recorded applied — because it actually ran" || bad "20270225 is not recorded applied"

# …and the seals are real, not just present: a forged marker insert is rejected.
psql -X -q -d "$DB" -c "INSERT INTO \"LabourAttendance\" (\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedAt\",\"recordedById\",\"sourceCommandId\") VALUES ('x','p','w','2026-01-01','day','$MARKER forged', now(), 'u', 'c');" >/dev/null 2>&1 \
  && bad "a forged marker was accepted on the baselined database" \
  || ok "a forged marker is rejected on the baselined database — the seal is live"

# A SECOND run is a clean no-op: the seals are present, so the normal path resolves everything.
run_migrate_sh "$DB"
[ "$RUN_RC" = "0" ] && ok "a repeat migrate.sh run on the baselined database is a clean no-op" || bad "repeat migrate.sh run failed"

# ── cleanup ──────────────────────────────────────────────────────────────────────────────────────
note "cleanup"
for db in pmcvitan_t3cpr_fresh pmcvitan_t3cpr_pretask3 pmcvitan_t3cpr_base pmcvitan_t3cpr_clean pmcvitan_t3cpr_dirty pmcvitan_t3cpr_corrected pmcvitan_t3cpr_dbpush pmcvitan_t3cpr_forged; do
  kill_conns "$db"; $PSQL_ADMIN -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 || true
done

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T3C PRODUCTION-RUNNER PROOF PASSED: scripts/migrate.sh enforces the compiled, schema-aware T3C"
  echo "preflight across fresh, pre-Task-3, clean pre-correction, dirty F1.blank (named + 20270220 never"
  echo "started + fabrication refused + explicit repair then clean redeploy), already-corrected and"
  echo "pre-baseline P3005 databases — the last proving the correction's raw-SQL seals are VERIFIED and"
  echo "really executed rather than blanket-resolved as applied. And the repair MARKS AND REVOKES,"
  echo "preserving the original row, its recorder, its timestamps and a complete before-image. No"
  echo "attendance row is ever deleted."
else
  echo "T3C PRODUCTION-RUNNER PROOF FAILED: see the assertions above."
fi
exit $FAIL
