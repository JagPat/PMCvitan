#!/usr/bin/env bash
# Hub #1118 U5m — the production `scripts/migrate.sh` over a database RESTORED WITHOUT ITS LEDGER.
#
# migrate.sh's P3005 baseline path resolves the catalog's earlier owners as applied instead of replaying
# them, on evidence read from the database: a database carrying 4d-ii-a / A7d resolves 4d-i's halves and
# U3; one also carrying Site Visits SV1-a's generation resolves U1, A7a and A7d; one also carrying Hub
# U5m's generation resolves SV1-a's catalog file. Each of those files carries an immutable
# foreign-generation audit that stands down only on 4d-iii's retirement marker or the serving witness
# (writers declared AND a lease), so on a restore that never served, replaying it would abort the deploy.
#
# `upgrade-proof.sh` mirrors the rule over its own replay; only this proof runs the REAL runner on such a
# database. It covers the states that path can present, with no lease:
#   A. THE LEDGER LOST AFTER U5m — every deployed migration ran: migrate.sh must exit 0, resolve the
#      superseded owners (SV1-a's catalog file among them) rather than run them, and EXECUTE U5m's file
#      from ALWAYS_EXECUTE, leaving six generations and U5m's 124 rows;
#   B. THE RULE REMOVED — the same database, with a temp copy of migrate.sh that does not resolve SV1-a's
#      catalog file: the deploy must FAIL on that file (its audit refuses U5m's generation). This is what
#      couples the proof to the rule: delete the rule and state A turns into state B;
#   C. THE LEDGER LOST BEFORE U5m — every migration through 20280125: SV1-a's catalog file must stay
#      PENDING and replay, and U5m's file must then apply, leaving six generations.
#
# DESTRUCTIVE for the scratch databases only.
set -u

DB="${LEDGER_LOST_PROOF_DB:-pmcvitan_ledger_lost}"
TMPL="${DB}_before_u5m"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
BARE="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
URL="$BARE?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $BARE"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SV1A="20280111000000_site_visits_sv1a_catalog"
U5M="20280126000000_hub_catalog_generation"
NEXT="63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }
q()   { psql -X -tA "$BARE" -c "$1" | tr -d '[:space:]'; }

# The restored database BEFORE U5m, built once as a template: every deployed migration through 20280125
# applied in ledger order, each as Prisma applies it (one transaction, stop on error), with no ledger
# table and no lease. Every state copies it; "after" then applies U5m's file and every later one on the
# copy, in ledger order, which is exactly what a database restored after them holds.
build_template() {
  local d s tbare="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$TMPL"
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$TMPL\" WITH (FORCE)" >/dev/null
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$TMPL\"" >/dev/null
  for d in $(ls -d prisma/migrations/*/ | sort); do
    s="$(basename "$d")"; s="${s%%_*}"
    [ "$s" -gt 20280125999999 ] && continue
    psql -v ON_ERROR_STOP=1 -X -q --single-transaction "$tbare" -f "$d/migration.sql" >/tmp/ledger-lost-base.log 2>&1 \
      || { bad "the restored database did not build at $(basename "$d")"; tail -5 /tmp/ledger-lost-base.log; return 1; }
  done
  psql -v ON_ERROR_STOP=1 -X -q "$tbare" -c 'DROP TABLE IF EXISTS "_prisma_migrations"' >/dev/null
}
# $1 = before | after
restored() {
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\" TEMPLATE \"$TMPL\"" >/dev/null || { bad "could not copy the template"; return 1; }
  if [ "$1" = "after" ]; then
    local d s
    for d in $(ls -d prisma/migrations/*/ | sort); do
      s="$(basename "$d")"; s="${s%%_*}"
      [ "$s" -le 20280125999999 ] && continue
      psql -v ON_ERROR_STOP=1 -X -q --single-transaction "$BARE" -f "$d/migration.sql" >/tmp/ledger-lost-base.log 2>&1 \
        || { bad "the restored copy did not apply $(basename "$d")"; tail -5 /tmp/ledger-lost-base.log; return 1; }
    done
  fi
  return 0
}

say "0. the compiled artifacts the production runner requires"
pnpm --filter @vitan/shared build >/tmp/ledger-lost-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/ledger-lost-shared.log; exit 1; }
pnpm --filter api build >/tmp/ledger-lost-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/ledger-lost-api.log; exit 1; }
ok "built"
build_template || exit 1
ok "the restored database before U5m is built once, as a template"

say "A. THE LEDGER LOST AFTER U5m — every deployed migration ran, no lease"
restored after || exit 1
shape=$(q "SELECT (SELECT count(DISTINCT \"coverageVersion\") FROM \"ExternalEffectCatalog\")::text || '/' || (SELECT count(*) FROM \"ReleaseLease\")::text || '/' || (to_regclass('public._prisma_migrations') IS NULL)::text")
[ "$shape" = "6/0/true" ] && ok "six generations, no lease, no ledger ($shape)" || bad "unexpected restored shape: $shape (expected 6/0/true)"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 on the restored database" || { bad "migrate.sh exited $RC"; printf '%s\n' "$OUT" | tail -25; }
for line in "this database CARRIES Phase 6 4d-ii-a / A7d" "this database CARRIES Site Visits SV1-a's catalog generation" \
            "this database CARRIES Hub U5m's catalog generation" "resolving $SV1A as applied" "leaving $U5M pending"; do
  printf '%s\n' "$OUT" | grep -qF "$line" && ok "the runner said: $line" || bad "the runner did not say: $line"
done
after=$(q "SELECT (SELECT count(DISTINCT \"coverageVersion\") FROM \"ExternalEffectCatalog\")::text || '/' || (SELECT count(*) FROM \"ExternalEffectCatalog\" WHERE \"coverageVersion\" = '$NEXT')::text || '/' || (SELECT applied_steps_count::text FROM _prisma_migrations WHERE migration_name = '$SV1A' AND finished_at IS NOT NULL) || '/' || (SELECT applied_steps_count::text FROM _prisma_migrations WHERE migration_name = '$U5M' AND finished_at IS NOT NULL)")
[ "$after" = "6/124/0/1" ] \
  && ok "six generations, U5m's 124 rows; SV1-a's catalog file RESOLVED (0 steps), U5m's EXECUTED (1 step) ($after)" \
  || bad "unexpected state after the deploy: $after (expected 6/124/0/1)"

say "B. THE RULE REMOVED — the same restored database, a copy of migrate.sh without it"
restored after || exit 1
MUT="$(mktemp)"
sed "s|^  T4D_HUB_SUPERSEDED=\"$SV1A\"\$|  T4D_HUB_SUPERSEDED=\"\"|" scripts/migrate.sh > "$MUT"
if cmp -s scripts/migrate.sh "$MUT"; then
  bad "the mutation did not apply: migrate.sh no longer declares T4D_HUB_SUPERSEDED=\"$SV1A\""
else
  MOUT="$(DATABASE_URL="$URL" sh "$MUT" 2>&1)"; MRC=$?
  [ "$MRC" != "0" ] && ok "without the rule the deploy FAILS (exit $MRC)" || bad "without the rule the deploy still exited 0 — the proof is not coupled to the rule"
  # Prisma reports a RAISE inside the file's own transaction only as "current transaction is aborted",
  # naming the migration; the refusal's own text is asserted by upgrade-proof.sh's direct replay.
  printf '%s\n' "$MOUT" | grep -q "migration_name=\"$SV1A\"" \
    && ok "and it fails on SV1-a's catalog file, the one the rule resolves" \
    || { bad "the failure does not name $SV1A"; printf '%s\n' "$MOUT" | tail -10; }
fi
rm -f "$MUT"

say "C. THE LEDGER LOST BEFORE U5m — every migration through 20280125, no lease"
restored before || exit 1
shape=$(q "SELECT count(DISTINCT \"coverageVersion\")::text FROM \"ExternalEffectCatalog\"")
[ "$shape" = "5" ] && ok "five generations before the deploy" || bad "unexpected generations before the deploy: $shape (expected 5)"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0" || { bad "migrate.sh exited $RC"; printf '%s\n' "$OUT" | tail -25; }
for line in "does not carry Hub U5m's catalog generation" "leaving $SV1A pending" "leaving $U5M pending"; do
  printf '%s\n' "$OUT" | grep -qF "$line" && ok "the runner said: $line" || bad "the runner did not say: $line"
done
after=$(q "SELECT (SELECT count(DISTINCT \"coverageVersion\") FROM \"ExternalEffectCatalog\")::text || '/' || (SELECT count(*) FROM \"ExternalEffectCatalog\" WHERE \"coverageVersion\" = '$NEXT')::text || '/' || (SELECT applied_steps_count::text FROM _prisma_migrations WHERE migration_name = '$SV1A' AND finished_at IS NOT NULL)")
[ "$after" = "6/124/1" ] \
  && ok "SV1-a's catalog file REPLAYED (1 step) and U5m applied: six generations, 124 rows ($after)" \
  || bad "unexpected state after the deploy: $after (expected 6/124/1)"

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$TMPL\" WITH (FORCE)" >/dev/null
printf '\n'
[ "$FAIL" = "0" ] && { echo "ledger-lost runner proof: PASSED"; exit 0; }
echo "ledger-lost runner proof: FAILED"; exit 1
