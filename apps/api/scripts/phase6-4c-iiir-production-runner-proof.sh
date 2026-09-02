#!/usr/bin/env bash
# Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` repair must behave correctly ON THE REAL
# PRODUCTION RUNNER, in every database state that runner can meet. Modelled on
# scripts/schema-enforcement-production-runner-proof.sh: it invokes `scripts/migrate.sh` itself,
# never a stand-in, because the thing under test is the wiring as much as the step.
#
# The states, and what each one is FOR:
#
#   A. FRESH/EMPTY — a first deploy. Nothing has ever served `decisions.inbox` here, so the defect's
#      precondition is absent. The step must report NOT APPLICABLE, write NO marker, and let the
#      deploy proceed: a gate a first deploy cannot clear is a wall.
#   A2. POPULATED BUT NEVER SERVED — projects exist, but no `decisions.inbox` generation does. This
#      is every test harness that drives the real migrate.sh over a psql-planted fixture, and it is
#      also a real deployment that has never read the register. Still NOT APPLICABLE, still no
#      marker — and this is the state that keeps this step from coupling every other proof to its
#      configuration.
#   B. IN SERVICE + UNCONFIGURED — the vacuity refusal. A database that HAS served the register,
#      with the two identity variables unset, must ABORT, so an unconfigured step can never pass
#      while claiming a repair.
#   C. POPULATED + WRONG DATABASE — the anchor names no project here. Must ABORT. This is the state
#      a self-count cannot see: `projects === count(Project)` holds on any database.
#   C2. POPULATED + BELOW THE MINIMUM — the second identity clause, ABORTing on a database missing
#      most of its projects.
#   C3. POPULATED + A MINIMUM OF ZERO — a minimum that an empty database satisfies is refused as a
#      misconfiguration, so the vacuity cannot be re-opened through the configuration.
#   D. CONFIGURED AND CORRECT — the repair RUNS, is verified over every project, writes exactly one
#      marker, and the runner exits 0. The precision claim: the gate can be cleared.
#   E. RE-RUN — the same runner over the repaired database SKIPS on the marker and still exits 0,
#      with no second rebuild.
#   E2. RE-RUN, RE-POINTED — the identity check runs even WITH the marker set, so a deploy later
#      pointed at another database still aborts.
#   F. FAILED ATTEMPT — a deliberately broken repair (the marker table made unwritable) must ABORT
#      the deploy, leave NO marker, and the NEXT run must succeed. A failure that recorded itself
#      would silently skip the repair forever.
#   F2. CONFIGURED + NEVER SERVED — the Codex F1 case. A deploy that HAS declared which database it
#      serves, pointed at one that never served the register, must ABORT on the anchor rather than
#      pass as not-applicable: identity is checked on every start, and state A2 above is the branch
#      for an UNCONFIGURED deploy only.
#   F3. THE MARKER IS SEALED — the Codex F2 case. The marker authorizes every later start to skip
#      the repair, so promotion, mutation, deletion and TRUNCATE are each refused by PostgreSQL, and
#      the general audit table keeps its lifecycle.
#   G. COUPLING — with the step removed from a COPY of migrate.sh, state B is ACCEPTED. So a
#      mutation that unwires the step fails this script.
#
# DESTRUCTIVE for the scratch database only.
set -u

DB="${P64CIIIR_PROOF_DB:-pmcvitan_4ciiir_runner}"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
BARE="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
URL="$BARE?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $BARE"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANCHOR="p64ciiir-anchor"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

recreate() { psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
             psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null; }
markers()  { $PSQL -tAc "SELECT count(*) FROM \"OutboxOperatorAction\" WHERE action = 'projection.rebuild.phase6-4c-iii-r'" 2>/dev/null | tr -d '[:space:]'; }
rebuilds() { $PSQL -tAc "SELECT count(*) FROM \"OutboxOperatorAction\" WHERE action = 'projection.rebuild' AND \"operatorIdentity\" = 'deploy'" 2>/dev/null | tr -d '[:space:]'; }
gens()     { $PSQL -tAc "SELECT count(*) FROM \"ProjectionGeneration\" WHERE consumer = 'decisions.inbox' AND status = 'active'" 2>/dev/null | tr -d '[:space:]'; }

# A coupling step is only evidence if its mutation LANDED: an `awk` that matches nothing produces an
# identical copy, the unmutated runner refuses as it should, and the step would read as proven while
# nothing was tested.
mutated() { if cmp -s "$1" scripts/migrate.sh; then
              bad "the coupling mutation matched nothing in migrate.sh — the step below would prove nothing"; return 1
            fi; return 0; }

# Two projects, one of them the configured anchor. Written with psql rather than the seed so the
# proof depends on nothing but the migrated schema. This is the HARNESS shape: rows exist, but no
# application has run, so `decisions.inbox` has never been served here.
plant() {
  $PSQL >/dev/null <<SQL || { bad "could not plant the fixture"; return 1; }
INSERT INTO "Org"("id","name","slug") VALUES ('p64ciiir-org','Proof Org','p64ciiir-org') ON CONFLICT DO NOTHING;
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
VALUES ('$ANCHOR','p64ciiir-org','Anchor','ANC','','Planning','ANC-01','01 Jan 2026','31 Dec 2026',0,0,0),
       ('p64ciiir-second','p64ciiir-org','Second','SEC','','Planning','SEC-01','01 Jan 2026','31 Dec 2026',0,0,0)
ON CONFLICT DO NOTHING;
SQL
  return 0
}

# The IN-SERVICE shape: a database that has actually served the register carries a `decisions.inbox`
# generation per project it has read. That — not the presence of projects — is the defect's
# precondition, and it is what makes the step applicable.
serve() {
  $PSQL >/dev/null <<SQL || { bad "could not put the fixture in service"; return 1; }
INSERT INTO "ProjectionGeneration"("id","consumer","projectId","generation","status","cursorStatus","catalogVersion","updatedAt")
VALUES ('p64ciiir-g1','decisions.inbox','$ANCHOR',1,'active','live',1,now()),
       ('p64ciiir-g2','decisions.inbox','p64ciiir-second',1,'active','live',1,now())
ON CONFLICT DO NOTHING;
SQL
  return 0
}

say "0. the compiled artifacts the production runner requires"
pnpm --filter @vitan/shared build >/tmp/p64-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/p64-shared.log; exit 1; }
pnpm --filter api build >/tmp/p64-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/p64-api.log; exit 1; }
# DERIVED from migrate.sh, not listed here, so a verifier added to the runner cannot go untested.
ARTIFACTS="$(grep -o 'dist/[A-Za-z0-9/_.-]*\.js' scripts/migrate.sh | sort -u)"
echo "$ARTIFACTS" | grep -q 'dist/platform/projections/inbox-repair.cli.js' \
  && ok "migrate.sh names the compiled 4c-iii-r artifact" \
  || bad "migrate.sh does not name dist/platform/projections/inbox-repair.cli.js — the step is not wired"
for a in $ARTIFACTS; do [ -f "$a" ] || { bad "compiled migrate.sh artifact missing: $a"; exit 1; }; done
ok "every compiled artifact migrate.sh names is present"

# ══ A. FRESH/EMPTY ════════════════════════════════════════════════════════════════════════════
say "A. a fresh, empty database — a first deploy, with the step UNCONFIGURED"
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 — a first deploy is not walled off by a gate it cannot clear" \
                || { bad "migrate.sh exited $RC on a fresh database"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q '"action": "not-applicable"' \
  && ok "and the step reported NOT APPLICABLE: nothing has ever served the register here" \
  || bad "the step did not report not-applicable on an empty database"
[ "$(markers)" = "0" ] && ok "NO marker was written, so a later populated start still repairs" \
                       || bad "a marker was written on a database with nothing to repair"

# ══ A2. POPULATED BUT NEVER SERVED ════════════════════════════════════════════════════════════
say "A2. the same database with PROJECTS planted, but the register never served — the harness shape"
plant || exit 1
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 — a fixture-planted database needs no configuration for this step" \
                || { bad "migrate.sh exited $RC over a planted-but-never-served database"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q '"action": "not-applicable"' \
  && ok "and it is STILL not-applicable: projects alone are not the defect's precondition" \
  || bad "a database that never served the register was not reported not-applicable"
[ "$(markers)" = "0" ] && ok "no marker was written, so a later in-service start still repairs" \
                       || bad "a marker was written for a database with nothing to repair"

# ══ B. IN SERVICE + UNCONFIGURED ══════════════════════════════════════════════════════════════
say "B. the same database, now IN SERVICE (a decisions.inbox generation exists), still UNCONFIGURED"
serve || exit 1
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — an unconfigured step cannot pass vacuously" \
                 || { bad "migrate.sh accepted an unconfigured repair on a database in service"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q 'identity-unconfigured' && ok "the refusal NAMES the cause" || bad "the refusal did not name identity-unconfigured"
printf '%s\n' "$OUT" | grep -q 'PHASE6_4C_IIIR_ANCHOR_PROJECT_ID' && ok "and NAMES the variables to set" || bad "the refusal did not name the variables"
printf '%s\n' "$OUT" | grep -q 'docs/RUNBOOK.md' && ok "and points at the runbook" || bad "the refusal does not point at the runbook"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"

# ══ C. WRONG DATABASE ═════════════════════════════════════════════════════════════════════════
say "C. configured for a DIFFERENT database — the anchor names no project here"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=some-other-production-project \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — identity comes from OUTSIDE the connection" \
                 || { bad "migrate.sh accepted a wrong database"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q 'anchor-absent' && ok "the refusal NAMES the absent anchor" || bad "the refusal did not name anchor-absent"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"

say "C2. configured with a minimum the database cannot meet"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=99 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a database missing most of its projects aborts" \
                 || bad "migrate.sh accepted a database below the configured minimum"
printf '%s\n' "$OUT" | grep -q 'below-minimum' && ok "the refusal NAMES the clause" || bad "the refusal did not name below-minimum"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"

say "C3. configured with a minimum of ZERO — the vacuity, re-opened through configuration"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=0 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a minimum an empty database satisfies is a misconfiguration" \
                 || bad "migrate.sh accepted a minimum of zero"
printf '%s\n' "$OUT" | grep -q 'minimum-invalid' && ok "the refusal NAMES the clause" || bad "the refusal did not name minimum-invalid"

# ══ D. CONFIGURED AND CORRECT ═════════════════════════════════════════════════════════════════
say "D. configured correctly — the repair RUNS, is verified, and the deploy proceeds"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 — the gate can be cleared" \
                || { bad "migrate.sh refused a correctly configured repair (exit $RC)"; printf '%s\n' "$OUT" | tail -30; }
printf '%s\n' "$OUT" | grep -q '"action": "repaired"' && ok "and the step reports REPAIRED" || bad "the step did not report repaired"
[ "$(markers)" = "1" ] && ok "exactly ONE marker was written" || bad "expected exactly one marker, found $(markers)"
[ "$(rebuilds)" = "1" ] && ok "exactly ONE projection.rebuild invocation was recorded" || bad "expected one invocation, found $(rebuilds)"
[ "$(gens)" = "2" ] && ok "one active decisions.inbox generation per project (2)" || bad "expected 2 active generations, found $(gens)"

# ══ E. RE-RUN ═════════════════════════════════════════════════════════════════════════════════
say "E. the same runner again — the marker makes it a no-op"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0" || { bad "the re-run exited $RC"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q '"action": "skipped-marker-present"' && ok "and SKIPPED on the marker" || bad "the re-run did not skip"
[ "$(rebuilds)" = "1" ] && ok "no second rebuild ran" || bad "a second rebuild ran despite the marker ($(rebuilds))"
[ "$(gens)" = "2" ] && ok "and no second generation was activated" || bad "generations changed on a skipped run ($(gens))"

say "E2. the marker does NOT excuse identity — the same repaired database, re-pointed"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=another-production-project \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a later misconfiguration cannot serve" \
                 || bad "a re-pointed deploy was accepted because the marker was already set"
printf '%s\n' "$OUT" | grep -q 'anchor-absent' && ok "the refusal NAMES the absent anchor" || bad "the refusal did not name anchor-absent"

# ══ F. A FAILED ATTEMPT LEAVES NO MARKER ══════════════════════════════════════════════════════
say "F. a repair that FAILS aborts the deploy, records nothing, and the next run succeeds"
# Rebuild the state from scratch, then make the rebuild fail for ONE project in a way the step
# cannot mistake for success. `ProjectionRebuildOperations.run` catches per (project, consumer) and
# CONTINUES, so this is the real shape of a partial failure: the run finishes, and one project's
# register is still unrepaired.
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)" || { bad "could not re-establish the schema"; printf '%s\n' "$OUT" | tail -20; }
plant || exit 1
serve || exit 1
$PSQL >/dev/null <<SQL || bad "could not install the failure probe"
CREATE FUNCTION p64ciiir_fail() RETURNS trigger LANGUAGE plpgsql AS \$\$
BEGIN
  IF NEW."projectId" = '$ANCHOR' THEN
    RAISE EXCEPTION 'p64ciiir probe: this project cannot be rebuilt';
  END IF;
  RETURN NEW;
END \$\$;
CREATE TRIGGER p64ciiir_fail BEFORE INSERT ON "ProjectionGeneration"
  FOR EACH ROW EXECUTE FUNCTION p64ciiir_fail();
SQL
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — 'ran' is not 'succeeded'" \
                 || { bad "migrate.sh accepted a repair that failed for a project"; printf '%s\n' "$OUT" | tail -30; }
printf '%s\n' "$OUT" | grep -q 'rebuild-not-verified' && ok "the refusal NAMES the criterion" || bad "the refusal did not name rebuild-not-verified"
printf '%s\n' "$OUT" | grep -q "$ANCHOR" && ok "and NAMES the offending project" || bad "the refusal did not name the offending pair"
[ "$(markers)" = "0" ] && ok "NO marker was written, so the deploy fails closed and the next start retries" \
                       || bad "a marker was written for a repair that did not succeed"
$PSQL >/dev/null <<SQL || bad "could not remove the failure probe"
DROP TRIGGER p64ciiir_fail ON "ProjectionGeneration";
DROP FUNCTION p64ciiir_fail();
SQL
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the NEXT run succeeded — a failed attempt is retried, never skipped" \
                || { bad "the retry after the repair still failed (exit $RC)"; printf '%s\n' "$OUT" | tail -30; }
[ "$(markers)" = "1" ] && ok "and the marker is now set" || bad "the successful retry did not write the marker"

# ══ F2. CONFIGURED + NEVER SERVED ═════════════════════════════════════════════════════════════
say "F2. a CONFIGURED deploy pointed at a database that never served the register — must ABORT"
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)" || bad "could not re-establish the schema for state F2"
plant || exit 1
# deliberately NOT `serve` — projects exist, the register never has
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=some-other-production-project \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — identity is asserted BEFORE applicability" \
                 || { bad "a configured deploy passed as not-applicable without checking its anchor"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'anchor-absent' && ok "the refusal NAMES the absent anchor" || bad "the refusal did not name anchor-absent"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"
# …and the branch it guards still works for the case it exists for
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the same database UNCONFIGURED is still not-applicable — a first deploy is not walled off" \
                || bad "an unconfigured deploy over a never-served database was refused"

# ══ F3. THE MARKER IS SEALED ══════════════════════════════════════════════════════════════════
say "F3. the repair marker is immutable at PostgreSQL — forge, edit, delete, truncate"
serve || exit 1
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && [ "$(markers)" = "1" ] && ok "the repair ran and wrote its marker" \
                || { bad "could not establish a marker for state F3 (rc=$RC, markers=$(markers))"; printf '%s\n' "$OUT" | tail -20; }
$PSQL >/dev/null 2>&1 <<SQL
INSERT INTO "OutboxOperatorAction"("id","action","operatorIdentity","reason") VALUES ('p64-ordinary','retry','op','ordinary');
SQL
refused() { # $1 = label, $2 = SQL that must be rejected, $3 = expected message fragment
  out=$($PSQL -c "$2" 2>&1)
  case "$out" in *"$3"*) ok "$1" ;; *) bad "$1 — got: $(printf '%s' "$out" | head -1)" ;; esac
}
refused "an ordinary audit row cannot be PROMOTED into the marker" \
  "UPDATE \"OutboxOperatorAction\" SET action='projection.rebuild.phase6-4c-iii-r' WHERE id='p64-ordinary'" \
  "cannot be re-keyed into the 4c-iii-r repair marker"
refused "the genuine marker cannot be EDITED" \
  "UPDATE \"OutboxOperatorAction\" SET reason='forged' WHERE action='projection.rebuild.phase6-4c-iii-r'" \
  "repair marker is immutable"
refused "the marker cannot be DELETED" \
  "DELETE FROM \"OutboxOperatorAction\" WHERE action='projection.rebuild.phase6-4c-iii-r'" \
  "never deleted"
refused "TRUNCATE, which no row trigger sees, is refused" \
  "TRUNCATE \"OutboxOperatorAction\"" \
  "never truncated"
$PSQL >/dev/null 2>&1 <<SQL
UPDATE "OutboxOperatorAction" SET reason='edited' WHERE id='p64-ordinary';
DELETE FROM "OutboxOperatorAction" WHERE id='p64-ordinary';
SQL
[ "$($PSQL -tAc "SELECT count(*) FROM \"OutboxOperatorAction\" WHERE id='p64-ordinary'" | tr -d '[:space:]')" = "0" ] \
  && ok "and the seal is PRECISE — the general audit table keeps its lifecycle" \
  || bad "an ordinary audit row could not be edited and deleted; the seal is too broad"
[ "$(markers)" = "1" ] && ok "the marker survived every attempt" || bad "the marker did not survive ($(markers))"

# ══ G. COUPLING ═══════════════════════════════════════════════════════════════════════════════
say "G. coupling — with the step removed from a COPY, the unconfigured database is ACCEPTED"
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)" || bad "could not re-establish the schema for state G"
plant || exit 1
serve || exit 1
COPY="$(mktemp)"
awk '/^  if ! node "\$INBOX_REPAIR"; then$/ {skip=5} skip>0 {skip--; next} {print}' scripts/migrate.sh > "$COPY"
if mutated "$COPY"; then
  OUT="$(DATABASE_URL="$URL" sh "$COPY" 2>&1)"; RC=$?
  [ "$RC" = "0" ] && ok "the unwired runner accepted it — so the refusal in state B came from THIS step and nothing else" \
                  || { bad "state B was still refused with the step removed; the coupling is not proven"; printf '%s\n' "$OUT" | tail -20; }
  [ "$(markers)" = "0" ] && ok "and the unwired runner repaired nothing" || bad "the unwired runner still wrote a marker"
fi
rm -f "$COPY"

say "cleanup"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null
[ "$FAIL" = "0" ] && { printf '\n4c-iii-r production-runner proof: PASSED\n'; exit 0; }
printf '\n4c-iii-r production-runner proof: FAILED — see the lines marked FAILED above.\n'; exit 1
