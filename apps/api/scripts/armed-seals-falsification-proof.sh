#!/usr/bin/env bash
# ARMED SEALS — the falsification proof.
#
# A verifier is only worth what it REFUSES. This drives the REAL `scripts/migrate.sh` over a
# ledger-complete database, tampers one enforcement object at a time by each mechanism that leaves
# an object present-but-not-enforcing, and asserts the runner refuses and NAMES it — then restores
# and asserts the runner passes again, so the check is proven PRECISE and not merely strict.
#
# This is the discipline `schedule-b1-baseline-proof.sh` already uses (`tamper_and_expect_refusal`),
# applied to the unscoped verifier. It is also how the two live defects below were found: by
# execution, not by reading SQL. The four review units that tried to read it are retired — see
# docs/MIGRATION_INVARIANTS.md.
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_armed_seals).
# Connection comes from the standard PG* variables; defaults suit the CI postgres:16 service.
set -u

DB="${ARMED_SEALS_DB:-pmcvitan_armed_seals}"
PGHOST="${PGHOST:-localhost}"; PGUSER="${PGUSER:-postgres}"; PGPORT="${PGPORT:-5432}"
ADMIN="postgres://$PGUSER@$PGHOST:$PGPORT/postgres"
URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DB"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $URL"
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; FAIL=1; }

cd "$(dirname "$0")/.." || exit 1

# A misspelled helper that vanishes onto stderr while the run still reports PASSED is the exact
# failure this script exists to prevent, turned on itself. upgrade-proof.sh learned that the hard
# way; the trap is a FILE because bash runs command_not_found_handle in a subshell.
TRAP_FILE="$(mktemp)"
command_not_found_handle() { echo "missing command: $1" >>"$TRAP_FILE"; return 127; }

echo "[armed-seals] building a ledger-complete database: $DB"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null
DATABASE_URL="$URL" npx prisma migrate deploy >/tmp/armed-seals-deploy.log 2>&1 \
  || { echo "the migration ledger did not apply"; tail -20 /tmp/armed-seals-deploy.log; exit 1; }

# The baseline matters as much as any refusal: a checker that refuses everything proves nothing.
BASE_OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; BASE_RC=$?
[ "$BASE_RC" = "0" ] \
  && ok "an untampered ledger-complete database deploys clean (exit 0)" \
  || { bad "the runner refused an intact database (exit $BASE_RC)"; printf '%s\n' "$BASE_OUT" | tail -12; }

# A scan that finds nothing because it LOOKED at nothing would pass vacuously, so the count is
# asserted rather than trusted — the same reason upgrade-proof.sh traps missing helpers.
CONSIDERED="$(DATABASE_URL="$URL" node dist/platform/seals/seals.cli.js armed 2>/dev/null \
  | sed -n 's/.*"considered": \([0-9]*\).*/\1/p')"
[ "${CONSIDERED:-0}" -gt 500 ] \
  && ok "the verifier considered $CONSIDERED enforcement objects" \
  || bad "the verifier considered only '${CONSIDERED:-0}' objects — it is not seeing the schema"

tamper_and_expect_refusal() {
  local label="$1" needle="$2" tamper="$3" restore="$4"
  $PSQL -c "$tamper" >/dev/null 2>&1 || { bad "$label: the tamper itself failed to apply"; return; }
  local out rc
  out="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; rc=$?
  if [ "$rc" = "0" ]; then
    bad "$label: the runner exited 0 over a tampered database — the deploy would have been reported good"
  else
    ok "$label: the runner REFUSED (exit $rc)"
    printf '%s\n' "$out" | grep -q "$needle" \
      && ok "$label: and named the object — $needle" \
      || { bad "$label: the refusal did not name '$needle'"; printf '%s\n' "$out" | tail -8; }
  fi
  $PSQL -c "$restore" >/dev/null 2>&1 || bad "$label: the restore failed — later results are unreliable"
  out="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; rc=$?
  [ "$rc" = "0" ] \
    && ok "$label: and passes again once repaired (precise, not merely strict)" \
    || { bad "$label: still refusing after repair (exit $rc)"; printf '%s\n' "$out" | tail -8; }
}

# F1 — a DISABLED trigger: what `ALTER TABLE … DISABLE TRIGGER` and a bad restore leave. These two
# seals are the MEASURED gap this whole unit closes: before it, this runner exited 0 on exactly this.
tamper_and_expect_refusal "F1 disabled trigger" 'DecisionOption_kind_selectable_ins' \
  'ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_kind_selectable_ins"' \
  'ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_kind_selectable_ins"'

# F2 — a foreign key blinded by DISABLE TRIGGER ALL. `conname`, `contype`, `conrelid`, `confrelid`
# and `convalidated` are ALL unchanged; only the internal RI triggers move. This is the shape the
# guard at 20270225000000_phase4_t3_correction3:167 reads and cannot see.
tamper_and_expect_refusal "F2 blinded foreign key" 'LabourWorkFact' \
  'ALTER TABLE "LabourWorkFact" DISABLE TRIGGER ALL' \
  'ALTER TABLE "LabourWorkFact" ENABLE TRIGGER ALL'

# F3 — a constraint added NOT VALID and never validated: it enforces nothing for rows already there.
tamper_and_expect_refusal "F3 NOT VALID constraint" 'probe_not_valid' \
  'ALTER TABLE "DecisionOption" ADD CONSTRAINT "probe_not_valid" CHECK ("optionKey" <> '"'"'__never__'"'"') NOT VALID' \
  'ALTER TABLE "DecisionOption" DROP CONSTRAINT "probe_not_valid"'

# F4 — `relhastriggers = false`: every trigger row survives intact and PostgreSQL skips all of them.
# A verifier that enumerates pg_trigger and stops there reports this table fully sealed.
tamper_and_expect_refusal "F4 relhastriggers bypass" 'DecisionOption' \
  'UPDATE pg_class SET relhastriggers = false WHERE oid = '"'"'public."DecisionOption"'"'"'::regclass' \
  'UPDATE pg_class SET relhastriggers = true WHERE oid = '"'"'public."DecisionOption"'"'"'::regclass'

if [ -s "$TRAP_FILE" ]; then bad "a helper was missing during the run:"; cat "$TRAP_FILE"; fi
rm -f "$TRAP_FILE"

echo
[ "$FAIL" = "0" ] && { echo "[armed-seals] PASSED"; exit 0; } || { echo "[armed-seals] FAILED"; exit 1; }
