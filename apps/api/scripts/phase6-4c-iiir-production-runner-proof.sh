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
#   F3. THE MARKER IS SEALED — the marker authorizes every later start to skip the repair, so
#      FORGED CREATION, promotion, mutation, deletion and TRUNCATE are each refused by PostgreSQL,
#      and the general audit table keeps its lifecycle.
#   F4. A CLONE OF PRODUCTION — the dataset checks all PASS (the same anchor project, the same
#      count, because those travel with the data) and the deploy is refused anyway, on the cluster
#      `system_identifier` that `pg_dump` does not carry.
#   F7. AN UNSEALED MARKER — a partial restore drops the INSERT GATE. The deploy must refuse on the
#      seal check, and the documented `seals repair` must both restore the seals and INVALIDATE the
#      marker that lived through the gap, so the next deploy earns a new one instead of skipping.
#   F9. THE ADOPTION ABORT — the ledger row is lost AND a seal is gone, so the marker cannot be
#       vouched for. Drives the documented recovery end to end, including the `migrate resolve
#       --rolled-back` step without which the redeploy dead-ends at P3009.
#   F8. A LOST LEDGER ROW — the seal migration re-runs over a database whose seals and marker are
#      both intact and must ADOPT that marker, so restore recovery is not an eternal abort.
#   F10. THE DRAIN IS NOT DECLARED — the deploy has not stated that every process older than the
#       4c-ii serializer is stopped, or has stated it against the wrong release. Both must ABORT,
#       and both must abort with a marker ALREADY present: the declaration is required on every
#       start, not only on the one that repairs.
#   F11. THE WRITER FENCE IS MISSING — `20271126000000`'s trigger is dropped. The deploy must
#       ABORT naming the fence, and deploy again once it is restored.
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
# The release floor the repair requires a deployment to DECLARE it has drained to. Compiled into the
# step, so this is the ONE correct value and any other is refused rather than interpreted; every
# invocation below that declares an identity declares this too, because a deploy that does not is
# refused before it reaches whatever that state is actually probing.
DRAIN="5fcc2a58"
# The cluster this proof's scratch database lives on. Read live, so the CORRECT configuration is
# always true here and the mismatch state can supply a deliberately wrong one.
sysid() { $PSQL -tAc "SELECT system_identifier FROM pg_control_system()" | tr -d '[:space:]'; }
# The DATABASE within that cluster. The cluster identifier is shared by every database in it, so a
# restore into a sibling database carries the same one — this is the half that separates them.
dboid() { $PSQL -tAc "SELECT oid FROM pg_database WHERE datname = current_database()" | tr -d '[:space:]'; }
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
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — identity comes from OUTSIDE the connection" \
                 || { bad "migrate.sh accepted a wrong database"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q 'anchor-absent' && ok "the refusal NAMES the absent anchor" || bad "the refusal did not name anchor-absent"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"

say "C2. configured with a minimum the database cannot meet"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=99 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a database missing most of its projects aborts" \
                 || bad "migrate.sh accepted a database below the configured minimum"
printf '%s\n' "$OUT" | grep -q 'below-minimum' && ok "the refusal NAMES the clause" || bad "the refusal did not name below-minimum"
[ "$(markers)" = "0" ] && ok "and no marker was written" || bad "a marker was written despite the refusal"

say "C3. configured with a minimum of ZERO — the vacuity, re-opened through configuration"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=0 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a minimum an empty database satisfies is a misconfiguration" \
                 || bad "migrate.sh accepted a minimum of zero"
printf '%s\n' "$OUT" | grep -q 'minimum-invalid' && ok "the refusal NAMES the clause" || bad "the refusal did not name minimum-invalid"

# ══ D. CONFIGURED AND CORRECT ═════════════════════════════════════════════════════════════════
say "D. configured correctly — the repair RUNS, is verified, and the deploy proceeds"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 — the gate can be cleared" \
                || { bad "migrate.sh refused a correctly configured repair (exit $RC)"; printf '%s\n' "$OUT" | tail -30; }
printf '%s\n' "$OUT" | grep -q '"action": "repaired"' && ok "and the step reports REPAIRED" || bad "the step did not report repaired"
[ "$(markers)" = "1" ] && ok "exactly ONE marker was written" || bad "expected exactly one marker, found $(markers)"
[ "$(rebuilds)" = "1" ] && ok "exactly ONE projection.rebuild invocation was recorded" || bad "expected one invocation, found $(rebuilds)"
[ "$(gens)" = "2" ] && ok "one active decisions.inbox generation per project (2)" || bad "expected 2 active generations, found $(gens)"

# ══ E. RE-RUN ═════════════════════════════════════════════════════════════════════════════════
say "E. the same runner again — the marker makes it a no-op"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0" || { bad "the re-run exited $RC"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q '"action": "skipped-marker-present"' && ok "and SKIPPED on the marker" || bad "the re-run did not skip"
[ "$(rebuilds)" = "1" ] && ok "no second rebuild ran" || bad "a second rebuild ran despite the marker ($(rebuilds))"
[ "$(gens)" = "2" ] && ok "and no second generation was activated" || bad "generations changed on a skipped run ($(gens))"

say "E2. the marker does NOT excuse identity — the same repaired database, re-pointed"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID=another-production-project \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
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
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
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
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
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
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
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
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && [ "$(markers)" = "1" ] && ok "the repair ran and wrote its marker" \
                || { bad "could not establish a marker for state F3 (rc=$RC, markers=$(markers))"; printf '%s\n' "$OUT" | tail -20; }
$PSQL >/dev/null 2>&1 <<SQL
INSERT INTO "OutboxOperatorAction"("id","action","operatorIdentity","reason") VALUES ('p64-ordinary','retry','op','ordinary');
SQL
refused() { # $1 = label, $2 = SQL that must be rejected, $3 = expected message fragment
  out=$($PSQL -c "$2" 2>&1)
  case "$out" in *"$3"*) ok "$1" ;; *) bad "$1 — got: $(printf '%s' "$out" | head -1)" ;; esac
}
refused "a marker row cannot be INSERTED outside the repair transaction" \
  "INSERT INTO \"OutboxOperatorAction\"(\"id\",\"action\",\"operatorIdentity\",\"reason\") VALUES ('p64-forged','projection.rebuild.phase6-4c-iii-r','someone','forged')" \
  "written only by the repair step"
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

# ══ F4. A CLONE OF PRODUCTION ═════════════════════════════════════════════════════════════════
say "F4. every DATASET check passes but the cluster is a different one — must ABORT"
OTHER=$(( $(sysid) + 1 ))
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$OTHER" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a restore of production carries the anchor, not the cluster identity" \
                 || { bad "a deploy configured for another cluster was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'system-identity-mismatch' && ok "the refusal NAMES the clause" || bad "the refusal did not name system-identity-mismatch"
printf '%s\n' "$OUT" | grep -q 'different PostgreSQL cluster' && ok "and says plainly that this is a different cluster" || bad "the refusal did not explain the cause"
# …and it is PRECISE, not merely strict: the true identifier is accepted on the same database.
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the SAME database with its true cluster identity is accepted" \
                || { bad "the correct cluster identity was refused (exit $RC)"; printf '%s\n' "$OUT" | tail -20; }

# ══ F5. A RESTORE INTO A SIBLING DATABASE ON THE SAME CLUSTER ═════════════════════════════════
# The restore F4 cannot see. `pg_restore` of production into a second database BESIDE it carries the
# same anchor, the same count and the SAME cluster identifier — every check state F4 makes. Only the
# database's own identity separates them. Simulated exactly by keeping this database and configuring
# the OID of a different one, which is what such a restore produces.
say "F5. every check up to the CLUSTER passes but the DATABASE within it is another one — must ABORT"
OTHER_DB=$(( $(dboid) + 1 ))
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" \
       PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$OTHER_DB" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a sibling restore shares the cluster identity, not the database" \
                 || { bad "a deploy configured for another database on this cluster was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'database-identity-mismatch' && ok "the refusal NAMES the clause" || bad "the refusal did not name database-identity-mismatch"
printf '%s\n' "$OUT" | grep -q 'the DATABASE within it is not' && ok "and distinguishes the database from the cluster" || bad "the refusal did not explain the cause"

# ══ F6. A PARTIAL IDENTITY CONFIGURATION ══════════════════════════════════════════════════════
# The deploy that keeps most of its identity and loses one variable. Nothing-set is the fresh-install
# exemption every other harness relies on; SOMETHING-set is a declaration and is honoured in full.
say "F6. four of the five deployment declarations set — a partial declaration must ABORT, not fall back to unconfigured"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a partial declaration is never treated as no declaration" \
                 || { bad "a partially configured deploy was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'identity-unconfigured' && ok "the refusal NAMES the clause" || bad "the refusal did not name identity-unconfigured"
printf '%s\n' "$OUT" | grep -q 'PHASE6_4C_IIIR_EXPECTED_DATABASE_OID' && ok "and names the variable that is missing" || bad "the refusal did not name the missing variable"

# ══ F7. AN UNSEALED MARKER ════════════════════════════════════════════════════════════════════
# A partial restore drops one of the marker seals. Every migration stays recorded, so `migrate
# deploy` has nothing to re-run and the generic enforcement check cannot see a trigger that is
# simply ABSENT from the inventory. Without the seal verification the repair would then trust — or
# a later start would skip on — a marker that nothing protected.
say "F7. a marker seal is MISSING — the repair must refuse before it trusts any marker"
$PSQL -q -c 'DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction"' >/dev/null
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a complete ledger is not a working seal" \
                 || { bad "a deploy over an unsealed marker was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'marker seals are NOT INTACT' && ok "the refusal NAMES the unsealed marker" || bad "the refusal did not name the seal failure"
printf '%s\n' "$OUT" | grep -q 'OutboxOperatorAction_4c_iiir_marker_insert_gated' && ok "and names the trigger that is gone" || bad "the refusal did not name the missing trigger"
# …and the RECOVERY is a real, retry-safe command whose exit status is ASSERTED (Codex on
# `e8b6d8c`). This state's database has a GENUINE marker, so re-running the migration would now hit
# its own diagnostic and abort — the previous version of this step discarded that failure and passed
# only because PostgreSQL had kept the pre-abort DDL, which is not a recovery. The compiled
# `seals repair` reinstalls the canonical seals and verifies afterwards.
#
# AND IT INVALIDATES THE MARKER (Codex round 10, finding 1). The seal that was gone here is the
# INSERT GATE, and the row seal never sees an INSERT — so throughout that window ANY writer holding
# the application's own database role could have inserted a marker of its own. The genuine marker is
# no longer distinguishable from one of those, so preserving it would reinstall the gate AROUND a
# possible forgery and let the next deploy skip an unrepaired database on its word. Nothing is lost:
# the marker is not the repair, and the next start simply earns a new one.
REPAIR_OUT="$(DATABASE_URL="$URL" node dist/platform/projections/inbox-repair.cli.js seals repair 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the seal repair command SUCCEEDED (exit 0) with a genuine marker present" \
                || { bad "the documented seal repair failed (exit $RC)"; printf '%s\n' "$REPAIR_OUT" | tail -20; }
printf '%s\n' "$REPAIR_OUT" | grep -q '"sealed": true' && ok "and it verifies the seals it restored" || bad "the repair did not verify a sealed result"
printf '%s\n' "$REPAIR_OUT" | grep -q '"markersInvalidated": 1' && ok "and it REPORTS the marker it could not vouch for" \
                                                                 || { bad "the repair did not report an invalidated marker"; printf '%s\n' "$REPAIR_OUT" | tail -20; }
[ "$(markers)" = "0" ] && ok "the marker is INVALIDATED — the insert gate was the seal that was gone, so a marker could have been inserted freely" \
                       || bad "a marker that lived through an insert-gate gap was preserved ($(markers))"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "with the seal reinstalled the SAME runner deploys — the check is precise, not merely strict" \
                || { bad "a correctly sealed database was refused (exit $RC)"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q '"action": "repaired"' && ok "and it EARNED a fresh marker rather than skipping on the invalidated one" \
                                                       || { bad "the deploy did not repair after the marker was invalidated"; printf '%s\n' "$OUT" | tail -20; }
[ "$(markers)" = "1" ] && ok "so the database ends sealed, repaired, and marked once" || bad "expected exactly one marker after the recovery, found $(markers)"

# ══ F8. THE COMPLETED SEAL MIGRATION RE-RUNS ═══════════════════════════════════════════════════
# A restore or a ledger repair can lose this migration's `_prisma_migrations` row while the triggers
# and a genuine marker survive; `migrate deploy` then re-runs the file over a database that already
# has both. Its adoption test must ACCEPT that marker — it was written under a demonstrably
# enforcing seal — rather than aborting forever on a database nothing is wrong with. This is the
# positive half of Codex round 10 finding 2; the refusals are in `phase6-4c-iiir-inbox-repair.test.ts`.
say "F8. the completed seal migration RE-RUNS over a sealed database carrying a genuine marker"
[ "$(markers)" = "1" ] || bad "state F8 needs the genuine marker state F7 left behind"
$PSQL -q -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name = '20271125000000_phase6_4c_iiir_marker_seal'" >/dev/null
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh re-applied the seal migration and deployed (exit 0)" \
                || { bad "a re-run over a correctly sealed, correctly marked database was refused (exit $RC)"; printf '%s\n' "$OUT" | tail -30; }
[ "$(markers)" = "1" ] && ok "and the genuine marker was ADOPTED, not destroyed" || bad "the re-run did not preserve the genuine marker ($(markers))"
printf '%s\n' "$OUT" | grep -q '"action": "skipped-marker-present"' && ok "so the step still skips on it" || bad "the step did not skip on the adopted marker"

# ══ F9. THE ADOPTION ABORT, AND THE RECOVERY IT DOCUMENTS ═════════════════════════════════════
# F8 is the case the adoption test ACCEPTS. This is the case it REFUSES: the ledger row is lost AND
# a forgery-relevant seal is gone, so the marker on the database cannot be vouched for and the
# migration aborts inside its own transaction.
#
# The abort is only half the story. Prisma RECORDS the failed attempt even though the transaction
# rolled the schema back, so a recovery of "repair the seals, then redeploy" dead-ends at P3009 --
# the operator stuck at exactly the moment the message is meant to help. `pr-277-convergence.md`
# records this repository learning that once already, for §CMDR. This drives the whole documented
# sequence end to end (Codex on `37e3c34`).
say "F9. the adoption test ABORTS, and the documented recovery actually recovers"
[ "$(markers)" = "1" ] || bad "state F9 needs the genuine marker state F8 left behind"
$PSQL -q -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name = '20271125000000_phase6_4c_iiir_marker_seal'" >/dev/null
$PSQL -q -c 'DROP TRIGGER "OutboxOperatorAction_4c_iiir_marker_insert_gated" ON "OutboxOperatorAction"' >/dev/null
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — an unvouchable marker is not adopted" \
                 || { bad "the adoption test accepted a marker written through an insert-gate gap"; printf '%s\n' "$OUT" | tail -20; }
# The migration's OWN message is swallowed: the file is one explicit BEGIN/COMMIT, so the RAISE
# aborts the transaction and Prisma surfaces `current transaction is aborted` instead. That is why
# migrate.sh repeats the recovery itself when a failure names this migration — asserted here,
# because an operator who cannot see the recovery does not have one.
printf '%s\n' "$OUT" | grep -q 'migrate resolve --rolled-back 20271125000000' && ok "and the runner SURFACES the resolve step the migration's own message cannot" \
                                                                || { bad "the failure did not surface 'migrate resolve --rolled-back'"; printf '%s\n' "$OUT" | tail -20; }

# the seals come back and the unvouchable marker goes with them…
REPAIR_OUT="$(DATABASE_URL="$URL" node dist/platform/projections/inbox-repair.cli.js seals repair 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the documented seal repair SUCCEEDED (exit 0)" \
                || { bad "the documented seal repair failed (exit $RC)"; printf '%s\n' "$REPAIR_OUT" | tail -20; }

# …and WITHOUT the resolve, the redeploy dead-ends at P3009. This is the step whose omission the
# repository has already paid for once, so it is asserted rather than described.
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "redeploying WITHOUT the resolve is still refused — the failed record blocks it" \
                 || { bad "a redeploy without the documented resolve unexpectedly succeeded"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'P3009' && ok "and it is P3009 — exactly the dead end the recovery must clear" \
                                        || { bad "the blocked redeploy was not P3009"; printf '%s\n' "$OUT" | tail -20; }

# …then the documented resolve, and the SAME runner deploys.
RESOLVE_OUT="$(DATABASE_URL="$URL" npx --no-install prisma migrate resolve --rolled-back 20271125000000_phase6_4c_iiir_marker_seal 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "the documented 'migrate resolve --rolled-back' SUCCEEDED (exit 0)" \
                || { bad "the documented resolve failed (exit $RC)"; printf '%s\n' "$RESOLVE_OUT" | tail -20; }
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "and THEN the same runner deploys — the documented recovery is complete end to end" \
                || { bad "the fully documented recovery still could not deploy (exit $RC)"; printf '%s\n' "$OUT" | tail -30; }
printf '%s\n' "$OUT" | grep -q '"action": "repaired"' && ok "and it EARNED a fresh marker rather than skipping on the invalidated one" \
                                                       || { bad "the deploy did not repair after the recovery"; printf '%s\n' "$OUT" | tail -20; }

# ══ F10. THE DRAIN IS NOT DECLARED ════════════════════════════════════════════════════════════
# The state Codex named on `88ea82c`: the repair returned success on the strength of an immediate
# post-commit re-read, while the drain that actually closes the window lived only in the runbook. It
# is a PRECONDITION now, so a deploy that has not declared it cannot start — proven here through the
# real runner rather than the step in isolation, and proven with a marker ALREADY on the database
# (F9 left one), because the declaration is required on every start, not only the one that repairs.
say "F10. the legacy-worker drain is not declared — must ABORT, even with a marker present"
[ "$(markers)" = "1" ] || bad "state F10 expects the marker state F9 left behind"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — an undeclared drain is not a deployable state" \
                 || { bad "a deploy that never declared the drain was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE' && ok "and NAMES the declaration it is missing" \
                                                                        || { bad "the refusal did not name the drain declaration"; printf '%s\n' "$OUT" | tail -20; }

# A declaration naming SOME OTHER release is the shape a stale procedure produces: nothing looks
# missing, but the floor it commits to is below the one that matters. Refused by name.
say "F10b. the drain is declared to the WRONG release — must ABORT rather than be interpreted"
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="0000000" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — a declaration below the required floor is not a drain" \
                 || { bad "a declaration naming another release was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'drain-release-mismatch' && ok "the refusal NAMES the clause" \
                                                         || { bad "the refusal did not name drain-release-mismatch"; printf '%s\n' "$OUT" | tail -20; }
[ "$(markers)" = "1" ] && ok "and neither refusal wrote a marker — the one on the database is still F9's" \
                       || bad "a refusing start changed the marker count"

# ══ F11. THE WRITER FENCE IS MISSING ══════════════════════════════════════════════════════════
# `20271126000000` is what stops an ALREADY-RUNNING previous-release relay from having its v1 rows
# SERVED. A restore, a manual `DROP TRIGGER`, or a partially applied migration can leave it off while
# every other check on this path still reports healthy — so the runner asks on every start, through
# the same `seals` call that verifies the marker seals, and refuses without it.
say "F11. the decisions.inbox writer fence is dropped — the deploy must ABORT"
$PSQL -q -c 'DROP TRIGGER "DecisionProjection_4c_iiir_writer_fence" ON "DecisionProjection"' >/dev/null
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" != "0" ] && ok "migrate.sh REFUSED (exit $RC) — an unfenced register is not a deployable state" \
                 || { bad "a deploy over a dropped writer fence was accepted"; printf '%s\n' "$OUT" | tail -20; }
printf '%s\n' "$OUT" | grep -q 'WRITER FENCE' && ok "and the refusal NAMES the fence" \
                                              || { bad "the refusal did not name the writer fence"; printf '%s\n' "$OUT" | tail -20; }
# …and the restore is THE MIGRATION ITSELF, replayed, rather than a hand-copied CREATE TRIGGER.
# A duplicated statement here drifts the moment the migration changes — measured: this restore was
# written with the pre-DELETE mask and, once the fence grew a DELETE arm, it recreated a trigger of
# tgtype=21 that the verifier then (correctly) refused, failing the proof on its own fixture. The
# file is re-runnable by construction (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
# DROP TRIGGER IF EXISTS before each CREATE) and its closing DO block re-verifies the result, so
# replaying it cannot drift from what a real deploy installs. This is the same lesson the coupling
# mutation below already learned twice: never hand-copy what the thing under test owns.
$PSQL -q -v ON_ERROR_STOP=1 -f "prisma/migrations/20271126000000_phase6_4c_iiir_writer_fence/migration.sql" >/dev/null
OUT="$(DATABASE_URL="$URL" PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="$ANCHOR" \
       PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=2 PHASE6_4C_IIIR_EXPECTED_SYSTEM_IDENTIFIER="$(sysid)" PHASE6_4C_IIIR_DRAINED_MINIMUM_RELEASE="$DRAIN" PHASE6_4C_IIIR_EXPECTED_DATABASE_OID="$(dboid)" \
       sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "and with the fence back the SAME runner deploys — the refusal was the fence and nothing else" \
                || { bad "the runner still refused after the fence was restored (exit $RC)"; printf '%s\n' "$OUT" | tail -20; }

# ══ G. COUPLING ═══════════════════════════════════════════════════════════════════════════════
say "G. coupling — with the step removed from a COPY, the unconfigured database is ACCEPTED"
recreate
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)" || bad "could not re-establish the schema for state G"
plant || exit 1
serve || exit 1
COPY="$(mktemp)"
# STRUCTURAL, not a line count. Two rounds running, a `skip=N` mutation silently stopped matching
# when the block it removes changed length — once matching nothing (the proof then "proved" coupling
# by deleting zero lines) and once leaving a dangling `fi`. This deletes from the invocation through
# its trailing echo, whatever the block grows into.
awk '/^  if ! repair_out="\$\(node "\$INBOX_REPAIR"\)"; then$/ {drop=1}
     drop && /^  echo "\$repair_out"$/ {drop=0; next}
     drop {next} {print}' scripts/migrate.sh > "$COPY"
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
