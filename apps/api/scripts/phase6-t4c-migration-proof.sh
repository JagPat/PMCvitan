#!/usr/bin/env bash
# Phase 6 unit 4c-i — the MIGRATION's own proof.
#
# `upgrade-proof.sh` proves what the migrated schema does. This proves what the MIGRATION does,
# which is a different set of claims and one that only exists while the file is still being
# written: once it merges it is immutable history, and a diagnostic that ordered its abort wrongly
# cannot be corrected in place.
#
# Five states, each on its own scratch database:
#
#   1. ABORT       — a `consultation` capability row already exists: the migration REFUSES,
#                    naming the project, and neither table is created.
#   2. BARRIER A   — a concurrent `capability:enable` is IN FLIGHT when the migration starts.
#                    The enable lands FIRST; the migration ABORTS. Blocking is OBSERVED in
#                    `pg_stat_activity`, not slept through.
#   3. BARRIER B   — the same race the other way: the migration lands first, and the enable is
#                    then REJECTED by the reservation.
#   4. RETRY       — a PARTIAL apply (killed after the tables exist) COMPLETES on re-run, with
#                    every seal armed. A deploy that stops at "the object already exists" is a
#                    deploy an operator cannot finish.
#   5. CLEAN       — the ordinary path: fresh database, full deploy, ten seals armed, row-free.
#
# States 2 and 3 are the same interleaving from both sides, and each carries a TERMINAL
# assertion: the migration NEVER commits with a `consultation` row present.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$HERE/../prisma/migrations"
MIGRATION="20271101000000_phase6_t4c_consultation"
ADMIN_URL="${PROOF_ADMIN_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
BASE="${PROOF_DB_PREFIX:-pmcvitan_t4c_proof}"
FAIL=0

psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d "$ADMIN_URL" -c "$1" >/dev/null; }
db_url() { echo "${ADMIN_URL%/*}/$1"; }

ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }

# A scratch database carrying every migration EXCEPT 4c-i — the state a real deploy is in when
# 4c-i starts.
build_base() {
  local db="$1"
  psql_admin "DROP DATABASE IF EXISTS $db;"
  psql_admin "CREATE DATABASE $db;"
  local d
  for d in $(ls -d "$MIG_DIR"/*/ | sort); do
    [ "$(basename "$d")" = "$MIGRATION" ] && continue
    psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$(db_url "$db")" -f "$d/migration.sql" >/dev/null 2>&1 \
      || { bad "base build: $(basename "$d") did not apply to $db"; return 1; }
  done
}

seed_project() {
  psql -X -q -v ON_ERROR_STOP=1 -d "$(db_url "$1")" >/dev/null <<'SQL'
INSERT INTO "Org" ("id","name","slug") VALUES ('org-mp','Proof Org','proof-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
VALUES ('mp-p1','org-mp','Proof Site','MP','','Finishing','MP-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","email") VALUES ('mp-u1','mp-p1','pmc','Proof PMC','mp@vitan.in');
SQL
}

apply_4ci() { psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$(db_url "$1")" -f "$MIG_DIR/$MIGRATION/migration.sql"; }

seals_armed() {
  psql -X -tAc "SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN (
    'ProjectCapability_t4c_consultation_reserved','DecisionApprovalRevision_no_truncate',
    'DecisionConsultation_t4c_insert_seal','DecisionConsultation_t4c_result_bound',
    'DecisionConsultation_t4c_append_only','DecisionConsultation_t4c_no_truncate',
    'DecisionConsultationResponse_t4c_insert_seal','DecisionConsultationResponse_t4c_result_bound',
    'DecisionConsultationResponse_t4c_append_only','DecisionConsultationResponse_t4c_no_truncate')" \
    -d "$(db_url "$1")" 2>/dev/null | tr -d ' '
}

tables_exist() {
  psql -X -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('DecisionConsultation','DecisionConsultationResponse')" \
    -d "$(db_url "$1")" 2>/dev/null | tr -d ' '
}

# ── STATE 1 — the diagnostic-first ABORT ─────────────────────────────────────────────────────
echo "=== STATE 1: a pre-enabled \`consultation\` capability ABORTS the migration ==="
DB1="${BASE}_abort"
build_base "$DB1" || exit 1
seed_project "$DB1"
psql -X -q -v ON_ERROR_STOP=1 -d "$(db_url "$DB1")" \
  -c "INSERT INTO \"ProjectCapability\" (\"projectId\",\"capability\",\"enabledById\") VALUES ('mp-p1','consultation','mp-u1');" >/dev/null

out=$(apply_4ci "$DB1" 2>&1)
if [ $? -eq 0 ]; then
  bad "STATE 1: the migration COMMITTED with the gate already open"
elif printf '%s' "$out" | grep -q 'already carry the RESERVED `consultation` capability'; then
  if printf '%s' "$out" | grep -q 'mp-p1'; then
    ok "STATE 1: the migration ABORTS and NAMES the project holding the row"
  else
    bad "STATE 1: the migration aborted but did not name the project"
  fi
else
  bad "STATE 1: the migration failed for the wrong reason — $(printf '%s' "$out" | tail -2)"
fi
[ "$(tables_exist "$DB1")" = "0" ] && ok "STATE 1 terminal: neither consultation table was created" \
  || bad "STATE 1 terminal: the abort left tables behind ($(tables_exist "$DB1"))"

# ── STATE 2 — the barrier, enable FIRST ──────────────────────────────────────────────────────
echo ""
echo "=== STATE 2: a concurrent enable in flight — it lands first, the migration ABORTS ==="
DB2="${BASE}_race_a"
build_base "$DB2" || exit 1
seed_project "$DB2"

# session A holds an uncommitted enable, keeping ROW EXCLUSIVE on ProjectCapability
FIFO=$(mktemp -u); mkfifo "$FIFO"
( printf 'BEGIN;\nINSERT INTO "ProjectCapability" ("projectId","capability","enabledById") VALUES (%s);\n' "'mp-p1','consultation','mp-u1'"
  cat "$FIFO" ) | psql -X -q -v ON_ERROR_STOP=1 -d "$(db_url "$DB2")" >/dev/null 2>&1 &
HOLDER=$!
sleep 1

# session B starts the migration; its FIRST statement is `CREATE TRIGGER`, which needs ACCESS
# EXCLUSIVE on ProjectCapability and therefore WAITS on A.
apply_4ci "$DB2" >/tmp/t4c-race-a.log 2>&1 &
MIGRATOR=$!

blocked=0
for _ in $(seq 1 100); do
  n=$(psql -X -tAc "SELECT COUNT(*) FROM pg_stat_activity WHERE datname='$DB2' AND wait_event_type='Lock'" -d "$ADMIN_URL" | tr -d ' ')
  [ "${n:-0}" -gt 0 ] && { blocked=1; break; }
  sleep 0.1
done
[ "$blocked" = "1" ] && ok "STATE 2: the migration WAITS for the in-flight enable (observed in pg_stat_activity)" \
  || bad "STATE 2: the migration did not wait — the audit could read past a concurrent enable"

exec 3>"$FIFO"; printf 'COMMIT;\n\\q\n' >&3; exec 3>&-
wait "$HOLDER" 2>/dev/null
wait "$MIGRATOR"; mig_rc=$?
rm -f "$FIFO"

if [ "$mig_rc" -ne 0 ] && grep -q 'already carry the RESERVED `consultation` capability' /tmp/t4c-race-a.log; then
  ok "STATE 2: with the enable committed first, the migration ABORTS naming the project"
else
  bad "STATE 2: expected an abort naming the project — $(tail -2 /tmp/t4c-race-a.log)"
fi
[ "$(tables_exist "$DB2")" = "0" ] && ok "STATE 2 terminal: the migration NEVER committed with a consultation row present" \
  || bad "STATE 2 terminal: the migration committed despite the row"

# ── STATE 3 — the same race, migration FIRST ─────────────────────────────────────────────────
echo ""
echo "=== STATE 3: the migration lands first — the concurrent enable is then REJECTED ==="
DB3="${BASE}_race_b"
build_base "$DB3" || exit 1
seed_project "$DB3"
apply_4ci "$DB3" >/dev/null 2>&1 || bad "STATE 3: the migration did not apply to a clean base"

out=$(psql -X -v ON_ERROR_STOP=1 -d "$(db_url "$DB3")" \
  -c "INSERT INTO \"ProjectCapability\" (\"projectId\",\"capability\",\"enabledById\") VALUES ('mp-p1','consultation','mp-u1');" 2>&1)
if [ $? -eq 0 ]; then
  bad "STATE 3: the late enable was ACCEPTED — the reservation does not cover the dark window"
elif printf '%s' "$out" | grep -q 'capability is RESERVED'; then
  ok "STATE 3: the late enable is REJECTED by the reservation"
else
  bad "STATE 3: the enable failed for the wrong reason — $(printf '%s' "$out" | tail -2)"
fi
# and by the other door, since `capability` is a mutable key with no freeze trigger
psql -X -q -d "$(db_url "$DB3")" -c "INSERT INTO \"ProjectCapability\" (\"projectId\",\"capability\",\"enabledById\") VALUES ('mp-p1','materials','mp-u1');" >/dev/null 2>&1
out=$(psql -X -v ON_ERROR_STOP=1 -d "$(db_url "$DB3")" \
  -c "UPDATE \"ProjectCapability\" SET \"capability\"='consultation' WHERE \"projectId\"='mp-p1';" 2>&1)
printf '%s' "$out" | grep -q 'capability is RESERVED' \
  && ok "STATE 3: RE-KEYING an existing row into \`consultation\` is rejected too" \
  || bad "STATE 3: the UPDATE door is open — $(printf '%s' "$out" | tail -2)"
[ "$(psql -X -tAc "SELECT COUNT(*) FROM \"ProjectCapability\" WHERE \"capability\"='consultation'" -d "$(db_url "$DB3")" | tr -d ' ')" = "0" ] \
  && ok "STATE 3 terminal: no project carries the reserved capability" \
  || bad "STATE 3 terminal: a consultation capability row exists"

# ── STATE 4 — the PARTIAL-APPLY retry ────────────────────────────────────────────────────────
echo ""
echo "=== STATE 4: a partial apply COMPLETES on re-run, with every seal armed ==="
DB4="${BASE}_retry"
build_base "$DB4" || exit 1
CUT=$(grep -n '^-- 6\. THE REQUEST INSERT ELIGIBILITY SEAL' "$MIG_DIR/$MIGRATION/migration.sql" | cut -d: -f1)
PARTIAL=$(mktemp); head -n $((CUT - 2)) "$MIG_DIR/$MIGRATION/migration.sql" > "$PARTIAL"
psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$(db_url "$DB4")" -f "$PARTIAL" >/dev/null 2>&1 \
  && ok "STATE 4: the partial apply (through the table creation) succeeded" \
  || bad "STATE 4: the partial apply failed"
rm -f "$PARTIAL"
[ "$(seals_armed "$DB4")" -lt 10 ] && ok "STATE 4: the partial state is genuinely incomplete ($(seals_armed "$DB4")/10 seals)" \
  || bad "STATE 4: the prefix already armed every seal — the retry proves nothing"
apply_4ci "$DB4" >/tmp/t4c-retry.log 2>&1 \
  && ok "STATE 4: the FULL migration re-runs over the partial state without stopping at an existing object" \
  || bad "STATE 4: the retry failed — $(tail -3 /tmp/t4c-retry.log)"
[ "$(seals_armed "$DB4")" = "10" ] && ok "STATE 4 terminal: all ten seals armed after the retry" \
  || bad "STATE 4 terminal: expected 10 armed seals, found $(seals_armed "$DB4")"

# ── STATE 5 — the ordinary path ──────────────────────────────────────────────────────────────
echo ""
echo "=== STATE 5: the clean deploy ==="
DB5="${BASE}_clean"
build_base "$DB5" || exit 1
apply_4ci "$DB5" >/dev/null 2>&1 && ok "STATE 5: the migration applies to a clean base" \
  || bad "STATE 5: the migration did not apply cleanly"
[ "$(seals_armed "$DB5")" = "10" ] && ok "STATE 5: all ten seals armed" || bad "STATE 5: $(seals_armed "$DB5")/10 seals armed"
[ "$(psql -X -tAc "SELECT (SELECT COUNT(*) FROM \"DecisionConsultation\") + (SELECT COUNT(*) FROM \"DecisionConsultationResponse\")" -d "$(db_url "$DB5")" | tr -d ' ')" = "0" ] \
  && ok "STATE 5: the tables land ROW-FREE — the migration invents nothing" \
  || bad "STATE 5: the migration wrote rows"
# the migration is fully re-runnable, not merely retry-safe from a partial state
apply_4ci "$DB5" >/dev/null 2>&1 && ok "STATE 5: the migration replays cleanly over its own completed state" \
  || bad "STATE 5: the migration is not re-runnable"

for db in "$DB1" "$DB2" "$DB3" "$DB4" "$DB5"; do psql_admin "DROP DATABASE IF EXISTS $db;" 2>/dev/null || true; done

echo ""
if [ "$FAIL" = "0" ]; then
  echo "PHASE 6 4c-i MIGRATION PROOF PASSED: abort, both race orderings, partial-apply retry, and the clean deploy."
else
  echo "PHASE 6 4c-i MIGRATION PROOF FAILED: see the assertions above."
fi
exit $FAIL
