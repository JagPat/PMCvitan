#!/usr/bin/env bash
# Schema enforcement — the check must behave correctly ON THE REAL PRODUCTION RUNNER, in every
# database state that runner can meet. Modelled on scripts/t45-production-runner-proof.sh and
# scripts/schedule-b1-baseline-proof.sh: it invokes `scripts/migrate.sh` itself, never a stand-in,
# because the thing under test is the wiring as much as the check. The one stand-in anywhere in this
# file is `prisma` in state I, and only there — stated at that state, with why nothing else will do.
#
# The states, and what each one is FOR:
#
#   A. FRESH/EMPTY — no application tables. The check must report "not applicable" and PASS, so the
#      migrations that CREATE the schema still run. A preflight that failed closed on emptiness
#      would make a first deploy impossible.
#   B. ALREADY-CLEAN — a fully migrated database. Must PASS, and the runner must reach Prisma. This
#      is the precision claim: this repository's invariants ARE triggers, and the whole schema
#      passes.
#   C. DIRTY, TRIGGERS DISABLED, WITH A MIGRATION PENDING. Must ABORT BEFORE PRISMA, name the
#      offending objects, and leave the pending migration NOT RECORDED — a dirty database must
#      never receive a partial migration.
#   D. DIRTY, UNVALIDATED FOREIGN KEY, same pending migration. Same refusal, different clause.
#   D2. DIRTY, TRIGGERS BYPASSED WHOLESALE (`relhastriggers = false`), same pending migration. The
#      third clause, and the one the other two structurally cannot reach: every pg_trigger row
#      survives and every tgenabled still reads 'O', so a per-trigger check reports the table
#      perfectly sealed while PostgreSQL consults none of them. MEASURED before the clause existed:
#      `enforcement verify` returned ok:true over exactly this state.
#   E. REPAIRED — the operator re-enables the triggers and validates the key, and the SAME runner
#      then deploys the pending migration cleanly. A gate that cannot be cleared is a wall.
#   F. ALREADY-CHECKED — the runner re-run over the now-deployed database is a no-op that passes.
#   G. THE POST-DEPLOY SEAM, asked directly. `enforcement verify` must fail on a dirty schema and
#      must fail with exit 4 on an empty one, where `preflight` passes. This is the CLI's own
#      contract, not the wiring — the wiring is state I.
#   H. COUPLING (the PREFLIGHT) — with the preflight block removed from a COPY of migrate.sh, state
#      C is accepted. So a mutation that unwires the preflight fails this script.
#   I. THE POST-DEPLOY SEAM, THROUGH THE RUNNER, on BOTH success paths — and its coupling. A deploy
#      that SUCCEEDS while leaving the schema not enforcing must be refused AFTER Prisma, by the real
#      runner. States C/D cannot reach it (a dirty database is refused before Prisma, which is the
#      point of the preflight), so the state has to be built the other way round: a CLEAN database,
#      and a deploy that dirties it. Reproducing that with a real migration would mean adding a file
#      to a checksum-frozen tree, so `prisma` ALONE is stood in for — migrate.sh runs verbatim, and
#      every verifier it calls is the compiled artifact. Then each of the two post-deploy call sites
#      is neutered in turn in a COPY of migrate.sh and the dirty database must be ACCEPTED again: a
#      mutation that deletes EITHER post-deploy `verify` fails this script.
#
# DESTRUCTIVE for the scratch database only.
set -u

DB="${ENF_PROOF_DB:-pmcvitan_enf_runner}"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
BARE="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
URL="$BARE?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $BARE"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Held aside so a migration is genuinely PENDING while the database is dirty. Without a pending
# migration, "Prisma never started" is unobservable — the deploy would be a no-op either way.
PENDING="20270930000000_schedule_dependency_graph"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

recreate() { psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
             psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null; }
recorded()  { $PSQL -tAc "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '$PENDING'" 2>/dev/null | tr -d '[:space:]'; }

# A coupling step is only evidence if its mutation LANDED. `sed`/`awk` that match nothing produce an
# identical copy, the unmutated runner refuses as it should, and the step would read as proven when
# nothing was tested. So every mutated copy is compared against the original first.
mutated() { # $1 = mutated copy — fails the proof if it is byte-identical to scripts/migrate.sh
  if cmp -s "$1" scripts/migrate.sh; then
    bad "the coupling mutation matched nothing in migrate.sh — the step below would prove nothing"; return 1
  fi; return 0
}

HOLD=""
restore_pending() { [ -n "$HOLD" ] && [ -d "$HOLD/$PENDING" ] && mv "$HOLD/$PENDING" "prisma/migrations/$PENDING"
                    [ -n "$HOLD" ] && rmdir "$HOLD" 2>/dev/null; HOLD=""; return 0; }
# Deploy everything EXCEPT the held migration, so it stays pending for the dirty-state steps.
deploy_all_but_pending() {
  HOLD="$(mktemp -d)"; mv "prisma/migrations/$PENDING" "$HOLD/$PENDING"; trap restore_pending EXIT
  DATABASE_URL="$URL" npx prisma migrate deploy >/tmp/enf-base.log 2>&1 || {
    restore_pending; trap - EXIT; bad "the base migration set did not apply"; tail -20 /tmp/enf-base.log; return 1; }
  restore_pending; trap - EXIT; return 0
}

say "0. the compiled artifacts the production runner requires"
pnpm --filter @vitan/shared build >/tmp/enf-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/enf-shared.log; exit 1; }
pnpm --filter api build >/tmp/enf-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/enf-api.log; exit 1; }
# DERIVED from migrate.sh, not listed here. A hand-written list is only as complete as the day it
# was written, so a sixth verifier added to the runner would go untested behind a five-entry list.
ARTIFACTS="$(grep -o 'dist/[A-Za-z0-9/_.-]*\.js' scripts/migrate.sh | sort -u)"
[ -n "$ARTIFACTS" ] || { bad "migrate.sh names no compiled artifact — this step would prove nothing"; exit 1; }
for a in $ARTIFACTS; do [ -f "$a" ] || { bad "compiled migrate.sh artifact missing: $a"; exit 1; }; done
ok "every compiled artifact migrate.sh names is present: $(echo $ARTIFACTS)"

# ══ A. FRESH/EMPTY ════════════════════════════════════════════════════════════════════════════
say "A. a fresh, empty database"
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 on an empty database" || { bad "migrate.sh exited $RC on a fresh database"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q "schema enforcement preflight" \
  && ok "the enforcement preflight ran" || bad "the enforcement preflight did not run"
printf '%s\n' "$OUT" | grep -q "fresh or empty database" \
  && ok "and reported NOT APPLICABLE rather than clean, so the schema-building migrations still ran" \
  || bad "an empty database was not reported as not-applicable"
[ "$(recorded)" = "1" ] && ok "the full migration set deployed" || bad "the migration set did not deploy on the fresh path"

# ══ B. ALREADY-CLEAN ══════════════════════════════════════════════════════════════════════════
say "B. the same database, now fully migrated and coherent"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 — a coherent schema is ACCEPTED, so the check is precise and not merely strict" \
                || { bad "migrate.sh exited $RC on a clean migrated database"; printf '%s\n' "$OUT" | tail -30; }
COUNTS=$($PSQL -tAc "SELECT (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                              JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')::text
                        || '/' || (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                              JOIN pg_namespace n ON n.oid=c.relnamespace
                             WHERE n.nspname='public' AND NOT (t.tgenabled='O' OR t.tgenabled='A'))::text" | tr -d '[:space:]')
ok "measured on the accepted database: triggers/non-enforcing = $COUNTS"

# ══ C. DIRTY — TRIGGERS DISABLED, A MIGRATION PENDING ═════════════════════════════════════════
say "C. a dirty database — a table's triggers switched off — with $PENDING pending"
recreate
deploy_all_but_pending || exit 1
[ "$(recorded)" = "0" ] && ok "$PENDING is PENDING" || bad "$PENDING is not pending; state C cannot be measured"
$PSQL -c 'ALTER TABLE "Activity" DISABLE TRIGGER ALL' >/dev/null
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC)" || bad "migrate.sh accepted a database whose triggers do not fire"
printf '%s\n' "$OUT" | grep -q "schema enforcement preflight FAILED" \
  && ok "the enforcement preflight is what refused it" || bad "the refusal did not come from the enforcement preflight"
printf '%s\n' "$OUT" | grep -q "tgenabled=D" && ok "the diagnostic NAMES the non-enforcing state" || bad "no named tgenabled state in the diagnostic"
printf '%s\n' "$OUT" | grep -q 'FOREIGN KEY' && ok "and ATTRIBUTES internal triggers to the foreign keys they implement" \
  || bad "internal triggers were not attributed to their foreign keys"
printf '%s\n' "$OUT" | grep -q "docs/RUNBOOK.md" && ok "and points at the runbook" || bad "the diagnostic does not point at the runbook"
printf '%s\n' "$OUT" | grep -q "Prisma was NOT started" && ok "the runner says Prisma was not started" || bad "the runner did not say Prisma was not started"
[ "$(recorded)" = "0" ] && ok "and $PENDING is STILL NOT RECORDED — no partial migration reached a dirty database" \
                        || bad "the pending migration was recorded despite the refusal"

# ══ D. DIRTY — AN UNVALIDATED FOREIGN KEY ═════════════════════════════════════════════════════
say "D. the second clause — an unvalidated foreign key, same pending migration"
$PSQL -c 'ALTER TABLE "Activity" ENABLE TRIGGER ALL' >/dev/null
$PSQL -c 'ALTER TABLE "Activity" ADD CONSTRAINT "Activity_enf_probe_fkey"
            FOREIGN KEY ("projectId") REFERENCES "Project"("id") NOT VALID' >/dev/null
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC)" || bad "migrate.sh accepted a NOT VALID foreign key"
printf '%s\n' "$OUT" | grep -q "Activity_enf_probe_fkey" && ok "the diagnostic NAMES the unvalidated key" || bad "the unvalidated key was not named"
[ "$(recorded)" = "0" ] && ok "and $PENDING is still not recorded" || bad "the pending migration was recorded despite the refusal"

# ══ D2. DIRTY — TRIGGERS BYPASSED WHOLESALE ═══════════════════════════════════════════════════
say "D2. the third clause — relhastriggers = false, which a per-trigger check cannot see"
$PSQL -c 'ALTER TABLE "Activity" VALIDATE CONSTRAINT "Activity_enf_probe_fkey"' >/dev/null
$PSQL -c 'UPDATE pg_class SET relhastriggers = false WHERE oid = '"'"'public."Activity"'"'"'::regclass' >/dev/null
# Proof the other clauses are blind to it, not merely quiet: every trigger on the table still reads
# as an enforcing state, so clause 1 has nothing to report.
OFF="$($PSQL -t -A -c 'SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = '"'"'public."Activity"'"'"'::regclass AND NOT (t.tgenabled = '"'"'O'"'"' OR t.tgenabled = '"'"'A'"'"')')"
[ "$OFF" = "0" ] && ok "every trigger on the table still reads ENABLED — clause 1 sees nothing here" \
                 || bad "the tamper also disabled triggers ($OFF), so this state does not isolate the clause"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC)" || bad "migrate.sh accepted a table whose triggers are bypassed"
printf '%s\n' "$OUT" | grep -q "relhastriggers" && ok "the diagnostic NAMES the bypass" || bad "the bypass was not named"
printf '%s\n' "$OUT" | grep -q '"Activity"' && ok "and NAMES the table" || bad "the bypassed table was not named"
[ "$(recorded)" = "0" ] && ok "and $PENDING is still not recorded" || bad "the pending migration was recorded despite the refusal"
$PSQL -c 'UPDATE pg_class SET relhastriggers = true WHERE oid = '"'"'public."Activity"'"'"'::regclass' >/dev/null

# ══ E. REPAIRED ═══════════════════════════════════════════════════════════════════════════════
say "E. the operator repairs it, and the SAME runner then deploys"
# Both prior dirty states are now repaired: D2 validated the key and restored the flag above.
$PSQL -c 'ALTER TABLE "Activity" VALIDATE CONSTRAINT "Activity_enf_probe_fkey"' >/dev/null 2>&1 || true
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 after the repair — the gate can be cleared" \
                || { bad "migrate.sh still refused after repair (exit $RC)"; printf '%s\n' "$OUT" | tail -25; }
[ "$(recorded)" = "1" ] && ok "and $PENDING is now recorded — it really deployed" || bad "the pending migration did not deploy after repair"

# ══ F. ALREADY-CHECKED ════════════════════════════════════════════════════════════════════════
say "F. re-running over the deployed database is a clean no-op"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 on the already-checked database" || { bad "re-run exited $RC"; printf '%s\n' "$OUT" | tail -25; }

# ══ G. THE POST-DEPLOY SEAM ═══════════════════════════════════════════════════════════════════
say "G. the post-deploy invocation — 'verify' — asked directly"
OUT="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js verify 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "verify accepts the deployed database" || { bad "verify rejected a clean deployed database (exit $RC)"; printf '%s\n' "$OUT" | tail -15; }
# The dirty state used here is REPLICA, not DISABLED, deliberately: `R` is the state that looks
# enabled and is inert, so it is the one worth driving through the real artifact. The trigger is
# discovered rather than named — a hard-coded name silently stops testing anything the day that
# object moves, and `ENABLE REPLICA TRIGGER` takes ONE trigger name (there is no `ALL` form, which
# an earlier head of this script got wrong: the invalid statement failed, a `||` fallback quietly
# disabled the table's triggers instead, and this step passed while measuring `D` and reporting `R`
# — the exact defect shape this whole unit exists to refuse, in the proof of the unit).
PAIR="$($PSQL -tAF'|' -c "SELECT c.relname, t.tgname FROM pg_trigger t
                            JOIN pg_class c ON c.oid = t.tgrelid
                            JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND NOT t.tgisinternal
                           ORDER BY c.relname, t.tgname LIMIT 1" | tr -d '[:space:]')"
R_TABLE="${PAIR%%|*}"; R_TRIGGER="${PAIR##*|}"
if [ -z "$R_TABLE" ] || [ -z "$R_TRIGGER" ] || [ "$R_TABLE" = "$PAIR" ]; then
  bad "found no user trigger to drive the replica-state probe with (got '$PAIR')"
else
  # No `||` fallback and no swallowed stderr: an ALTER that does not do what it says must be loud.
  $PSQL -c "ALTER TABLE \"$R_TABLE\" ENABLE REPLICA TRIGGER \"$R_TRIGGER\"" >/dev/null || bad "could not set $R_TABLE.$R_TRIGGER to replica"
  STATE="$($PSQL -tAc "SELECT t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                        WHERE c.relname = '$R_TABLE' AND t.tgname = '$R_TRIGGER'" | tr -d '[:space:]')"
  # Assert the state we MEANT to create really exists, so this step can never again pass while
  # measuring something else.
  [ "$STATE" = "R" ] && ok "$R_TABLE.$R_TRIGGER is at tgenabled=R — enabled-looking and inert on an origin connection" \
                     || bad "expected tgenabled=R on $R_TABLE.$R_TRIGGER, found '$STATE'"
  OUT="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js verify 2>&1)"; RC=$?
  [ "$RC" = "3" ] && ok "verify REFUSES it (exit 3) — a migration that disables something and fails to restore it does not pass" \
                  || bad "verify returned $RC on a replica-state schema (expected 3)"
  printf '%s\n' "$OUT" | grep -q "$R_TRIGGER" && ok "and NAMES the offending trigger" || bad "the diagnostic did not name $R_TRIGGER"
  printf '%s\n' "$OUT" | grep -q "session_replication_role" \
    && ok "explaining that replica state does not fire for the application" || bad "the diagnostic did not explain the replica state"
  $PSQL -c "ALTER TABLE \"$R_TABLE\" ENABLE TRIGGER \"$R_TRIGGER\"" >/dev/null
  OUT="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js verify 2>&1)"; RC=$?
  [ "$RC" = "0" ] && ok "and accepts it again once restored to origin" || bad "verify returned $RC after restoring $R_TRIGGER (expected 0)"
fi
recreate
OUT="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js preflight 2>&1)"; RCP=$?
OUT2="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js verify 2>&1)"; RCV=$?
[ "$RCP" = "0" ] && ok "on an EMPTY database preflight passes (exit 0)" || bad "preflight returned $RCP on an empty database"
[ "$RCV" = "4" ] && ok "while verify FAILS with exit 4 — after a successful deploy the schema must exist" \
                 || bad "verify returned $RCV on an empty database (expected 4)"

# ══ H. COUPLING ═══════════════════════════════════════════════════════════════════════════════
say "H. coupling — with the preflight unwired from a COPY of migrate.sh, state C is accepted"
recreate
deploy_all_but_pending || exit 1
$PSQL -c 'ALTER TABLE "Activity" DISABLE TRIGGER ALL' >/dev/null
UNWIRED="$(mktemp)"
# Remove only the preflight invocation, leaving the rest of the runner intact.
sed 's|if ! node "$ENF_CHECK" preflight; then|if false; then|' scripts/migrate.sh > "$UNWIRED"
mutated "$UNWIRED" && ok "the preflight invocation really was removed from the copy"
OUT="$(DATABASE_URL="$URL" sh "$UNWIRED" 2>&1)"; RC=$?
rm -f "$UNWIRED"
if [ "$RC" = "0" ] || [ "$(recorded)" = "1" ]; then
  ok "the unwired runner did NOT refuse state C — so the refusal above came from this check and not from something else"
else
  bad "state C was refused even with the enforcement preflight unwired; the coupling is not proven"
  printf '%s\n' "$OUT" | tail -20
fi
$PSQL -c 'ALTER TABLE "Activity" ENABLE TRIGGER ALL' >/dev/null 2>&1

# ══ I. THE POST-DEPLOY SEAM, THROUGH THE REAL RUNNER ══════════════════════════════════════════
# The state under test is a deploy that SUCCEEDS and leaves the schema not enforcing. The preflight
# cannot produce it — it refuses a dirty database before Prisma — so the database is CLEAN here and
# the DEPLOY is what dirties it. `prisma` alone is stood in for, to synthesise that without adding a
# migration to a checksum-frozen tree; migrate.sh is executed verbatim and every verifier it invokes
# is the real compiled artifact.
PROBE_FK='Activity_postdeploy_probe_fkey'
DIRTY_SQL="ALTER TABLE \"Activity\" ADD CONSTRAINT \"$PROBE_FK\" FOREIGN KEY (\"projectId\") REFERENCES \"Project\"(\"id\") NOT VALID"
clean_probe_fk() { $PSQL -c "ALTER TABLE \"Activity\" DROP CONSTRAINT IF EXISTS \"$PROBE_FK\"" >/dev/null 2>&1; }

make_shim() { # $1 = ordinary | p3005 — prints the directory to put first on PATH
  d="$(mktemp -d)"
  cat > "$d/npx" <<SHIM
#!/bin/sh
# Stands in for \`prisma migrate deploy\` ONLY. On the p3005 run the FIRST deploy answers P3005 so
# migrate.sh takes its baseline branch; the deploy that then SUCCEEDS leaves the schema dirty, which
# is the state no ledger can show and the post-deploy call exists to catch.
if [ "\$1" != "prisma" ]; then echo "enf-shim: unexpected npx \$*" >&2; exit 127; fi
case "\$2 \$3" in
  "migrate resolve") exit 0 ;;
  "migrate deploy")
    n=\$(cat "$d/calls" 2>/dev/null || echo 0); n=\$((n + 1)); echo "\$n" > "$d/calls"
    if [ "$1" = "p3005" ] && [ "\$n" = "1" ]; then
      echo "Error: P3005 The database schema is not empty."
      exit 1
    fi
    psql -v ON_ERROR_STOP=1 -X -q "$BARE" -c '$DIRTY_SQL' >/dev/null || exit 1
    echo "No pending migrations to apply."
    exit 0 ;;
  *) echo "enf-shim: unexpected npx \$*" >&2; exit 127 ;;
esac
SHIM
  chmod +x "$d/npx"; printf '%s' "$d"
}

run_dirtying_deploy() { # $1 = ordinary|p3005 ; $2 = runner to execute — sets OUT / RC
  clean_probe_fk
  d="$(make_shim "$1")"
  OUT="$(PATH="$d:$PATH" DATABASE_URL="$URL" sh "$2" 2>&1)"; RC=$?
  rm -rf "$d"
}

# The two post-deploy call sites, neutered one at a time. `awk` rather than `sed` because the two
# lines are byte-identical and only their ORDER distinguishes them.
neuter_verify() { # $1 = 1 (ordinary path) | 2 (P3005 path) -> prints the mutated runner
  awk -v want="$1" -v pat='if ! node "$ENF_CHECK" verify; then' \
    'index($0, pat) > 0 { c++; if (c == want) $0 = substr($0, 1, index($0, pat) - 1) "if false; then" } { print }' \
    scripts/migrate.sh
}

say "I. a deploy that SUCCEEDS while leaving the schema dirty — the ORDINARY post-deploy path"
recreate
DATABASE_URL="$URL" sh scripts/migrate.sh >/tmp/enf-i-base.log 2>&1 || { bad "the clean baseline deploy for state I failed"; tail -20 /tmp/enf-i-base.log; }
run_dirtying_deploy ordinary scripts/migrate.sh
[ "$RC" != "0" ] && ok "migrate.sh REFUSED the deploy (exit $RC)" || bad "migrate.sh reported a successful deploy over a schema the deploy left not enforcing"
printf '%s\n' "$OUT" | grep -q "schema enforcement preflight FAILED" \
  && bad "the PREFLIGHT refused it — this step must exercise the POST-DEPLOY call, not the preflight" \
  || ok "the preflight passed, so the database was clean when Prisma started"
printf '%s\n' "$OUT" | grep -q "schema enforcement verification FAILED" \
  && ok "and the ORDINARY post-deploy call is what refused it" || bad "the refusal did not come from the ordinary post-deploy verify"
printf '%s\n' "$OUT" | grep -q "$PROBE_FK" && ok "the diagnostic NAMES what the deploy left behind" || bad "the post-deploy diagnostic did not name the object"

say "I.2 the same question on the P3005 BASELINE path, which resolves migrations without running them"
run_dirtying_deploy p3005 scripts/migrate.sh
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC)" || bad "the baseline path reported a good deploy over a dirty schema"
printf '%s\n' "$OUT" | grep -q "pre-baseline database detected (P3005)" \
  && ok "the baseline branch really was taken" || bad "the P3005 branch was not taken; this step measures nothing"
printf '%s\n' "$OUT" | grep -q "schema enforcement is not intact after baseline + deploy" \
  && ok "and the P3005 post-deploy call — a DIFFERENT call site — is what refused it" \
  || bad "the refusal did not come from the P3005 post-deploy verify"

say "I.3 coupling — with ONLY the ordinary post-deploy verify removed from a COPY, the dirty deploy is accepted"
COPY1="$(mktemp)"; neuter_verify 1 > "$COPY1"
if mutated "$COPY1"; then
  run_dirtying_deploy ordinary "$COPY1"
  [ "$RC" = "0" ] && ok "the unwired runner reported the deploy GOOD — so the refusal above came from that call and nothing else" \
                  || { bad "state I was still refused with the ordinary post-deploy verify removed; the coupling is not proven"; printf '%s\n' "$OUT" | tail -20; }
fi
rm -f "$COPY1"

say "I.4 coupling — and with ONLY the P3005 post-deploy verify removed, the baseline path accepts it too"
COPY2="$(mktemp)"; neuter_verify 2 > "$COPY2"
if mutated "$COPY2"; then
  run_dirtying_deploy p3005 "$COPY2"
  [ "$RC" = "0" ] && ok "the unwired baseline path reported the deploy GOOD — deleting EITHER post-deploy call now fails this proof" \
                  || { bad "state I.2 was still refused with the P3005 post-deploy verify removed; the coupling is not proven"; printf '%s\n' "$OUT" | tail -20; }
fi
rm -f "$COPY2"
clean_probe_fk

say "cleanup"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
[ "$FAIL" = "0" ] && { printf '\nPASSED — schema enforcement behaves correctly on the real production runner in every state.\n'; exit 0; }
printf '\nFAILED — see the lines marked FAILED above.\n'; exit 1
