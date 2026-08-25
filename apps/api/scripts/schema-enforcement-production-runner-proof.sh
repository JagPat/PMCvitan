#!/usr/bin/env bash
# Schema enforcement — the check must behave correctly ON THE REAL PRODUCTION RUNNER, in every
# database state that runner can meet. Modelled on scripts/t45-production-runner-proof.sh and
# scripts/schedule-b1-baseline-proof.sh: it invokes `scripts/migrate.sh` itself, never a stand-in,
# because the thing under test is the wiring as much as the check.
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
#   E. REPAIRED — the operator re-enables the triggers and validates the key, and the SAME runner
#      then deploys the pending migration cleanly. A gate that cannot be cleared is a wall.
#   F. ALREADY-CHECKED — the runner re-run over the now-deployed database is a no-op that passes.
#   G. THE POST-DEPLOY SEAM, asked directly. `enforcement verify` must fail on a dirty schema and
#      must fail with exit 4 on an empty one, where `preflight` passes. Stated honestly: this step
#      invokes the second migrate.sh call site directly rather than through the runner, because
#      synthesising a migration that disables a seal and fails to restore it would mean adding a
#      migration to a checksum-frozen tree. The wiring itself is asserted in step H.
#   H. COUPLING — with the preflight block removed from a COPY of migrate.sh, state C is accepted.
#      So a mutation that unwires this check fails this script.
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
for a in dist/platform/t45/t45.cli.js dist/labour/t2c/t2c.cli.js dist/labour/t3c/t3c.cli.js \
         dist/activities/b1/b1.cli.js dist/platform/enforcement/enforcement.cli.js; do
  [ -f "$a" ] || { bad "compiled migrate.sh artifact missing: $a"; exit 1; }
done
ok "every compiled artifact migrate.sh runs is present, including dist/platform/enforcement/enforcement.cli.js"

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

# ══ E. REPAIRED ═══════════════════════════════════════════════════════════════════════════════
say "E. the operator repairs it, and the SAME runner then deploys"
$PSQL -c 'ALTER TABLE "Activity" VALIDATE CONSTRAINT "Activity_enf_probe_fkey"' >/dev/null
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
$PSQL -c 'ALTER TABLE "Activity" ENABLE REPLICA TRIGGER ALL' >/dev/null 2>&1 \
  || $PSQL -c 'ALTER TABLE "Activity" DISABLE TRIGGER ALL' >/dev/null
OUT="$(DATABASE_URL="$URL" node dist/platform/enforcement/enforcement.cli.js verify 2>&1)"; RC=$?
[ "$RC" = "3" ] && ok "verify REFUSES a schema whose seals stopped firing (exit 3) — a migration that disables something and fails to restore it does not pass" \
                || bad "verify returned $RC on a dirty schema (expected 3)"
$PSQL -c 'ALTER TABLE "Activity" ENABLE TRIGGER ALL' >/dev/null
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
OUT="$(DATABASE_URL="$URL" sh "$UNWIRED" 2>&1)"; RC=$?
rm -f "$UNWIRED"
if [ "$RC" = "0" ] || [ "$(recorded)" = "1" ]; then
  ok "the unwired runner did NOT refuse state C — so the refusal above came from this check and not from something else"
else
  bad "state C was refused even with the enforcement preflight unwired; the coupling is not proven"
  printf '%s\n' "$OUT" | tail -20
fi
$PSQL -c 'ALTER TABLE "Activity" ENABLE TRIGGER ALL' >/dev/null 2>&1

say "cleanup"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
[ "$FAIL" = "0" ] && { printf '\nPASSED — schema enforcement behaves correctly on the real production runner in every state.\n'; exit 0; }
printf '\nFAILED — see the lines marked FAILED above.\n'; exit 1
