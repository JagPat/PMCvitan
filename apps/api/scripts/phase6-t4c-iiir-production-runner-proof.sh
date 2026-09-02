#!/usr/bin/env bash
# Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` rebuild must behave correctly ON THE REAL
# PRODUCTION RUNNER, in every database state that runner can meet. Modelled on
# scripts/schema-enforcement-production-runner-proof.sh: it invokes `scripts/migrate.sh` itself,
# never a stand-in, because the thing under test is the wiring as much as the step.
#
# The states, and what each one is FOR:
#
#   STATE A. UNCONFIGURED — a migrated, populated database and NEITHER identity variable set. The
#            runner must exit non-zero AFTER Prisma (migrations are applied; the server would be
#            next) with the JSON verdict `identity-env-missing`, and write NO marker. An unconfigured
#            step must never pass vacuously (review of #513, round 2).
#   STATE B. FRESH — an empty database and the EXPLICIT 0 allowance. Exit 0, `not-applicable`, no
#            marker, no rebuild. A first install must be possible; the allowance is explicit.
#   STATE C. POPULATED, PRODUCTION CONFIG — anchor = a real project, floor 1. Exit 0, `completed`,
#            ONE marker, ONE `projection.rebuild` invocation, ONE active generation per project.
#   STATE D. RE-RUN — the same database again. Exit 0, `already-completed`, still ONE of each.
#   STATE E. WRONG ANCHOR — a populated database whose anchor names no project. Refused
#            (`anchor-absent`), NO marker. This is "the deploy is connected to the wrong database".
#   STATE F. FLOOR ABOVE COUNT — refused (`count-below-minimum`), NO marker.
#   STATE G. CORRUPT GENERATION — a stored row set that contradicts canonical is repaired: the verdict
#            reports corruptBefore ≥ 1 and corruptAfter 0, and the phantom row is gone.
#   STATE H. TWO PROCESSES STARTED TOGETHER — the real compiled CLI launched twice against one fresh
#            populated database: both exit 0, exactly ONE invocation row, ONE marker, ONE active
#            generation per project. (The barrier-CONTROLLED ordering proof — the loser observed
#            waiting on the lock before the winner is released — is
#            test/integration/phase6-t4c-iiir.test.ts; this state proves the same terminal invariant
#            through two real processes.)
#   STATE I. ARTIFACT MISSING — the compiled CLI moved aside. The runner refuses BEFORE Prisma.
#   STATE J. COUPLING — a COPY of migrate.sh with the step's call removed ACCEPTS state A, so a
#            mutation that unwires the step fails this proof.
#
# DESTRUCTIVE for the scratch database only.
set -u

DB="${IIIR_PROOF_DB:-pmcvitan_iiir_runner}"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
BARE="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
URL="$BARE?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $BARE"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="dist/platform/projections/phase6-t4c-iiir.cli.js"
MARKER="phase6.t4c-iiir.rebuild-completed"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

# The step is meant to be configured by the deploy; this proof configures it per state, explicitly.
unset PHASE6_4C_IIIR_ANCHOR_PROJECT_ID PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS

recreate() { psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
             psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null; }
deploy_base() { DATABASE_URL="$URL" npx prisma migrate deploy >/tmp/iiir-base.log 2>&1 || { cat /tmp/iiir-base.log; echo "base deploy failed"; exit 1; }; }
seed() { $PSQL <<'SQL'
INSERT INTO "Org"("id","name","slug") VALUES('iiir-org','IIIR Org','iiir-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES('iiir-p1','iiir-org','IIIR Site 1','I1','','Planning','I1-01','01 Jan 2026','31 Dec 2026',0,0,0),
        ('iiir-p2','iiir-org','IIIR Site 2','I2','','Planning','I2-01','01 Jan 2026','31 Dec 2026',0,0,0);
SQL
}
q() { $PSQL -tAc "$1" | tr -d '[:space:]'; }
markers()     { q "SELECT count(*) FROM \"OutboxOperatorAction\" WHERE action = '$MARKER'"; }
invocations() { q "SELECT count(*) FROM \"OutboxOperatorAction\" WHERE action = 'projection.rebuild'"; }
active()      { q "SELECT count(*) FROM \"ProjectionGeneration\" WHERE consumer = 'decisions.inbox' AND \"projectId\" = '$1' AND status = 'active'"; }
verdict()     { printf '%s' "$1" | grep -o '{"outcome":"[^}]*' | tail -1; }
run_runner()  { OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?; }

[ -f "$ARTIFACT" ] || { echo "compiled artifact $ARTIFACT missing — run 'pnpm --filter api build' first"; exit 1; }

say "STATE A — unconfigured: refused after Prisma with identity-env-missing, no marker"
recreate; deploy_base; seed
run_runner
[ "$RC" -ne 0 ] && ok "runner exited non-zero ($RC)" || bad "runner accepted an UNCONFIGURED step (rc=$RC)"
echo "$OUT" | grep -q '"code":"identity-env-missing"' && ok "verdict names identity-env-missing" || bad "verdict did not name identity-env-missing: $(verdict "$OUT")"
echo "$OUT" | grep -q 'No pending migrations\|migrations found' && ok "Prisma ran before the step (the schema is at head)" || bad "Prisma did not run before the step"
[ "$(markers)" = "0" ] && ok "no marker written" || bad "a marker was written on refusal"

say "STATE B — fresh (empty) database with the explicit 0 allowance: not-applicable, no marker"
recreate; deploy_base
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=fresh PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=0 run_runner
[ "$RC" -eq 0 ] && ok "runner exited 0" || bad "runner refused a fresh install with the explicit allowance (rc=$RC): $(verdict "$OUT")"
echo "$OUT" | grep -q '"outcome":"not-applicable"' && ok "verdict is not-applicable" || bad "verdict is not not-applicable: $(verdict "$OUT")"
[ "$(markers)" = "0" ] && ok "no marker written" || bad "a marker was written over an empty database"
[ "$(invocations)" = "0" ] && ok "no rebuild invoked" || bad "a rebuild ran over an empty database"

say "STATE C — populated, production config: completed once"
recreate; deploy_base; seed
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 run_runner
[ "$RC" -eq 0 ] && ok "runner exited 0" || bad "runner refused a correctly configured deploy (rc=$RC): $(verdict "$OUT")"
echo "$OUT" | grep -q '"outcome":"completed"' && ok "verdict is completed" || bad "verdict is not completed: $(verdict "$OUT")"
[ "$(markers)" = "1" ] && ok "exactly one marker" || bad "marker count $(markers)"
[ "$(invocations)" = "1" ] && ok "exactly one rebuild invocation" || bad "invocation count $(invocations)"
[ "$(active iiir-p1)" = "1" ] && [ "$(active iiir-p2)" = "1" ] && ok "one active decisions.inbox generation per project" || bad "active generations: p1=$(active iiir-p1) p2=$(active iiir-p2)"

say "STATE D — re-run: already-completed, still one of each"
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 run_runner
[ "$RC" -eq 0 ] && ok "runner exited 0" || bad "re-run refused (rc=$RC): $(verdict "$OUT")"
echo "$OUT" | grep -q '"outcome":"already-completed"' && ok "verdict is already-completed" || bad "verdict is not already-completed: $(verdict "$OUT")"
[ "$(markers)" = "1" ] && [ "$(invocations)" = "1" ] && ok "still exactly one marker and one invocation" || bad "markers=$(markers) invocations=$(invocations)"

say "STATE E — wrong anchor (the wrong database): refused, no marker"
recreate; deploy_base; seed
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=some-other-deployments-project PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 run_runner
[ "$RC" -ne 0 ] && ok "runner exited non-zero ($RC)" || bad "runner accepted a wrong anchor"
echo "$OUT" | grep -q '"code":"anchor-absent"' && ok "verdict names anchor-absent" || bad "verdict: $(verdict "$OUT")"
[ "$(markers)" = "0" ] && [ "$(invocations)" = "0" ] && ok "no marker, no rebuild" || bad "markers=$(markers) invocations=$(invocations)"

say "STATE F — floor above the live count: refused, no marker"
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=50 run_runner
[ "$RC" -ne 0 ] && ok "runner exited non-zero ($RC)" || bad "runner accepted a floor above the count"
echo "$OUT" | grep -q '"code":"count-below-minimum"' && ok "verdict names count-below-minimum" || bad "verdict: $(verdict "$OUT")"
[ "$(markers)" = "0" ] && ok "no marker written" || bad "a marker was written"

say "STATE G — a corrupt generation is repaired"
recreate; deploy_base; seed
# build a generation first (the operator CLI, standalone), then plant a stored row for a decision
# that does not exist: stored ≠ canonical, which diagnoses as 'corrupt'
DATABASE_URL="$URL" node dist/platform/projections/projection-rebuild.cli.js --operator proof --reason seed --consumer decisions.inbox >/tmp/iiir-seed.log 2>&1 || { cat /tmp/iiir-seed.log; bad "seeding rebuild failed"; }
GEN="$(q "SELECT id FROM \"ProjectionGeneration\" WHERE consumer='decisions.inbox' AND \"projectId\"='iiir-p1' AND status='active'")"
$PSQL -c "INSERT INTO \"DecisionProjection\"(\"id\",\"generationId\",\"projectId\",\"decisionId\",\"status\",\"dto\",\"updatedAt\") VALUES (gen_random_uuid(),'$GEN','iiir-p1','phantom-v1-row','pending','{}'::jsonb, now())"
$PSQL -c "DELETE FROM \"OutboxOperatorAction\"" # the seeding CLI's ledger rows are not the unit's
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 run_runner
[ "$RC" -eq 0 ] && ok "runner exited 0" || bad "runner refused over a corrupt generation (rc=$RC): $(verdict "$OUT")"
echo "$OUT" | grep -q '"corruptBefore":[1-9]' && ok "verdict reports corruptBefore ≥ 1" || bad "verdict did not report corruption: $(verdict "$OUT")"
echo "$OUT" | grep -q '"corruptAfter":0' && ok "verdict reports corruptAfter 0" || bad "verdict: $(verdict "$OUT")"
NEWGEN="$(q "SELECT id FROM \"ProjectionGeneration\" WHERE consumer='decisions.inbox' AND \"projectId\"='iiir-p1' AND status='active'")"
[ "$NEWGEN" != "$GEN" ] && ok "a NEW generation is active" || bad "the corrupt generation is still the active one"
[ "$(q "SELECT count(*) FROM \"DecisionProjection\" WHERE \"generationId\"='$NEWGEN' AND \"decisionId\"='phantom-v1-row'")" = "0" ] && ok "the phantom row is gone from the served register" || bad "the phantom row survives"

say "STATE H — two real processes started together: exactly one rebuild, both succeed"
recreate; deploy_base; seed
export PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1
( DATABASE_URL="$URL" node "$ARTIFACT" >/tmp/iiir-h1.out 2>/tmp/iiir-h1.err; echo $? >/tmp/iiir-h1.rc ) &
( DATABASE_URL="$URL" node "$ARTIFACT" >/tmp/iiir-h2.out 2>/tmp/iiir-h2.err; echo $? >/tmp/iiir-h2.rc ) &
wait
unset PHASE6_4C_IIIR_ANCHOR_PROJECT_ID PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS
RC1="$(cat /tmp/iiir-h1.rc)"; RC2="$(cat /tmp/iiir-h2.rc)"
[ "$RC1" = "0" ] && [ "$RC2" = "0" ] && ok "both processes exited 0" || { bad "exit codes $RC1 / $RC2"; cat /tmp/iiir-h1.err /tmp/iiir-h2.err; }
OUTCOMES="$(cat /tmp/iiir-h1.out /tmp/iiir-h2.out | grep -o '"outcome":"[a-z-]*"' | sort | tr '\n' ' ')"
echo "$OUTCOMES" | grep -q '"completed"' && echo "$OUTCOMES" | grep -q '"already-completed"' && ok "one completed, one already-completed ($OUTCOMES)" || bad "outcomes: $OUTCOMES"
[ "$(invocations)" = "1" ] && ok "exactly one rebuild invocation across both processes" || bad "invocation count $(invocations)"
[ "$(markers)" = "1" ] && ok "exactly one marker" || bad "marker count $(markers)"
[ "$(active iiir-p1)" = "1" ] && [ "$(active iiir-p2)" = "1" ] && ok "one active generation per project" || bad "active generations: p1=$(active iiir-p1) p2=$(active iiir-p2)"

say "STATE I — compiled artifact missing: refused BEFORE Prisma"
recreate  # NOT deployed: if Prisma ran, migrations would be recorded
mv "$ARTIFACT" "$ARTIFACT.held"
PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=iiir-p1 PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 run_runner
mv "$ARTIFACT.held" "$ARTIFACT"
[ "$RC" -ne 0 ] && ok "runner refused ($RC)" || bad "runner deployed without the compiled step"
echo "$OUT" | grep -q "phase-6 4c-iii-r deploy-time rebuild ($ARTIFACT) is missing" && ok "named the missing artifact" || bad "did not name the missing artifact"
[ "$(q "SELECT count(*) FROM pg_tables WHERE tablename = '_prisma_migrations'" 2>/dev/null || echo 0)" = "0" ] && ok "Prisma never started (no migration ledger)" || bad "Prisma ran despite the missing artifact"

say "STATE J — coupling: a runner with the step's call removed ACCEPTS the unconfigured state"
recreate; deploy_base; seed
MUT="$(mktemp)"; sed '/run_iiir || exit 1/d' scripts/migrate.sh > "$MUT"
if cmp -s "$MUT" scripts/migrate.sh; then bad "the coupling mutation matched nothing in migrate.sh — this state would prove nothing"; else
  OUT="$(DATABASE_URL="$URL" sh "$MUT" 2>&1)"; RC=$?
  [ "$RC" -eq 0 ] && ok "the UNWIRED runner accepted state A (so the wiring is what refuses it)" || bad "the unwired runner still refused (rc=$RC) — the proof is not measuring the wiring"
fi
rm -f "$MUT"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "phase6 4c-iii-r production-runner proof: PASSED — scripts/migrate.sh runs the deploy-time decisions.inbox rebuild once, identity-checked, fail-closed"
  exit 0
else
  echo "phase6 4c-iii-r production-runner proof: FAILED — see the lines marked FAILED"
  exit 1
fi
