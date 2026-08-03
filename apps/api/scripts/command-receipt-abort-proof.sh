#!/usr/bin/env bash
# Platform — the command-receipt seal's ABORT → REPAIR → REDEPLOY proof.
#
# `20270425000000_platform_command_receipt_seal` runs a diagnostic BEFORE installing its trigger and
# ABORTS on either shape `executeCommand` cannot produce: a terminal receipt with no completion
# time, or a failed receipt carrying a result. The first head of that migration only WARNED, on the
# reasoning that neither shape could satisfy a provenance seal falsely — which was wrong, because
# §E's join reads `status`, `commandType` and `resultRef` and never reads `completedAt`.
#
# An abort is only worth anything if it actually fires and the documented repair actually clears it,
# so this drives both, once per shape, on an independent database:
#
#   base : every migration EXCEPT the seal, applied via `prisma migrate deploy`.
#   per shape (A = terminal-without-completion, B = failed-with-result,
#              D = succeeded-without-result, the shape round 2 added to the trigger and round 3
#                  found missing from this diagnostic):
#     0. clone `base` (TEMPLATE) and plant EXACTLY ONE row of that shape;
#     1. `prisma migrate deploy` → ABORTS naming BOTH counts and pointing at §CMDR; the seal's
#        trigger is NOT installed and the migration is NOT recorded;
#     2. the §CMDR repair — DELETE the row — succeeds, because nothing cites it;
#     3. `prisma migrate deploy` → applies; the trigger is installed.
#   plus C: a receipt a FACT depends on. The §CMDR repair is REFUSED by PostgreSQL (ON DELETE NO
#        ACTION on the citing row), which is the runbook's second outcome and the reason the repair
#        is safe: it cannot silently orphan a recorded fact.
#
# DESTRUCTIVE for the two scratch databases only. Connection via the standard PG* env vars.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="$API_DIR/prisma/migrations"
SEAL="20270425000000_platform_command_receipt_seal"
HELD="$MIG_DIR/../.cmdr-held-$$"
BASE="${CMDR_BASE_DB:-pmcvitan_cmdr_base}"
CLONE="${CMDR_CLONE_DB:-pmcvitan_cmdr_clone}"
URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT"
FAIL=0

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"

restore_held() { [ -d "$HELD" ] && mv "$HELD" "$MIG_DIR/$SEAL" 2>/dev/null || true; }
trap 'restore_held' EXIT

ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }
psq()  { psql -X -q -v ON_ERROR_STOP=1 -d "$URL/$CLONE" "$@"; }

cd "$API_DIR"

# ── base: every migration EXCEPT the seal ─────────────────────────────────────────────────────
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS \"$CLONE\"" -c "DROP DATABASE IF EXISTS \"$BASE\"" -c "CREATE DATABASE \"$BASE\""
mv "$MIG_DIR/$SEAL" "$HELD"
DATABASE_URL="$URL/$BASE" pnpm exec prisma migrate deploy >/dev/null 2>&1 \
  || { bad "base ledger (without the seal) did not apply"; restore_held; exit 1; }
restore_held
ok "base database holds every migration EXCEPT the seal"

# The minimal tenant a receipt hangs off. Written with ON_ERROR_STOP, so a schema drift here fails
# the proof loudly instead of leaving the planted row silently absent (which would make every abort
# assertion below pass by proving nothing).
tenant() {
  psq <<'SQL'
INSERT INTO "Org"("id","name","slug") VALUES('cmdr-org','CMDR','cmdr');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct","timeZone","scheduleStartDate")
  VALUES('cmdr-p','cmdr-org','P','P','','x','P','a','b',0,0,0,'Asia/Kolkata',now());
INSERT INTO "User"("id","projectId","role","name","email") VALUES('cmdr-user','cmdr-p','pmc','U','cmdr@example.com');
SQL
}

plant_and_run() {  # $1 = label, $2 = SQL planting the row, $3 = the id to repair
  $PSQL_ADMIN -c "DROP DATABASE IF EXISTS \"$CLONE\"" -c "CREATE DATABASE \"$CLONE\" TEMPLATE \"$BASE\"" >/dev/null
  tenant || { bad "$1: the tenant fixture did not apply"; return; }
  psq -c "$2" || { bad "$1: the planted row was not inserted — the abort below would prove nothing"; return; }

  local out
  out=$(DATABASE_URL="$URL/$CLONE" pnpm exec prisma migrate deploy 2>&1)
  if printf '%s' "$out" | grep -q 'docs/RUNBOOK.md §CMDR'; then
    ok "$1: the migration ABORTS naming the shape and pointing at §CMDR"
  else
    bad "$1: the migration did not abort with the §CMDR diagnostic"
    printf '%s\n' "$out" | tail -5
  fi
  local installed
  installed=$(psq -tAc "SELECT COUNT(*) FROM pg_trigger WHERE tgname='CommandExecution_receipt_protocol' AND NOT tgisinternal")
  [ "$installed" = "0" ] && ok "$1: the seal is NOT installed over unresolved rows" \
                         || bad "$1: the seal was installed despite the abort"
  local applied
  applied=$(psq -tAc "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='$SEAL' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
  [ "$applied" = "0" ] && ok "$1: the migration is NOT recorded as successfully applied" \
                       || bad "$1: the migration was recorded as applied despite aborting"

  # the §CMDR repair: DELETE, never invent
  if psq -c "DELETE FROM \"CommandExecution\" WHERE \"id\"='$3'" >/dev/null 2>&1; then
    ok "$1: the §CMDR repair (DELETE) succeeds — nothing cited the row"
  else
    bad "$1: the §CMDR repair was refused"
  fi
  # Prisma records the ABORTED migration as failed and refuses to continue until the operator
  # marks it rolled back — the same three-state handling §T45.1 documents. §CMDR says so too, and
  # this proves the documented sequence rather than a shorter one that would not work in production.
  DATABASE_URL="$URL/$CLONE" pnpm exec prisma migrate resolve --rolled-back "$SEAL" >/dev/null 2>&1 \
    || bad "$1: `migrate resolve --rolled-back` was refused"
  DATABASE_URL="$URL/$CLONE" pnpm exec prisma migrate deploy >/dev/null 2>&1 \
    && ok "$1: the seal applies after the repair" \
    || bad "$1: the seal did not apply after the repair"
  installed=$(psq -tAc "SELECT COUNT(*) FROM pg_trigger WHERE tgname='CommandExecution_receipt_protocol' AND NOT tgisinternal")
  [ "$installed" = "1" ] && ok "$1: the trigger is installed on the repaired database" \
                         || bad "$1: the trigger is missing after a clean deploy"
}

# ── A: a terminal receipt with no completion time — the shape §E's join would have trusted ──────
plant_and_run "shape A (terminal, no completion time)" \
  "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\",\"resultRef\")
     VALUES('cmdr-A','project','cmdr-org','cmdr-p','cmdr-user','commercial.bill.verify','cmdr-a','x','succeeded','FORGED-VERDICT')" \
  'cmdr-A'

# ── B: a failed receipt carrying a result — provenance for something that did not happen ────────
plant_and_run "shape B (failed, carrying a result)" \
  "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\",\"resultRef\",\"completedAt\")
     VALUES('cmdr-B','project','cmdr-org','cmdr-p','cmdr-user','commercial.bill.verify','cmdr-b','x','failed','FORGED-VERDICT',now())" \
  'cmdr-B'

# ── D: a SUCCEEDED receipt with no result — the shape the diagnostic was missing (Codex round-3) ─
#
# Round 2 taught the trigger that a succeeded command must record what it produced, and left the
# pre-trigger diagnostic checking only the two older shapes. So an upgraded database could carry a
# `succeeded` receipt with a NULL `resultRef`, the seal would install over it, and a retry would
# read `prior.resultRef ?? ''` — reporting success and suppressing the command that would have
# produced the entity. Both sites now ask ONE predicate, and this proves it over the diagnostic.
plant_and_run "shape D (succeeded, no result)" \
  "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\",\"completedAt\")
     VALUES('cmdr-D','project','cmdr-org','cmdr-p','cmdr-user','commercial.bill.verify','cmdr-d','x','succeeded',now())" \
  'cmdr-D'

# ── C: the repair's SECOND outcome — a receipt a recorded FACT depends on ───────────────────────
#
# §CMDR says the DELETE is self-diagnosing: it removes a receipt nothing rests on and is REFUSED
# for one a fact cites, which tells the operator they have found a fact resting on a receipt no
# command produced. That refusal is what makes "just delete it" a safe instruction, so it is proven
# rather than asserted.
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS \"$CLONE\"" -c "CREATE DATABASE \"$CLONE\" TEMPLATE \"$BASE\"" >/dev/null
tenant || bad "shape C: the tenant fixture did not apply"
psq <<'SQL' || bad "shape C: the citing-fact fixture did not apply — the refusal below would prove nothing"
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status","resultRef")
  VALUES('cmdr-C','project','cmdr-org','cmdr-p','cmdr-user','labour.substitution.approve','cmdr-c','x','succeeded','FORGED');
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('cmdr-root','cmdr-p','cmdr-user');
INSERT INTO "ApprovedSkillSubstitution"("id","projectId","requirementId","fromFingerprint","toFingerprint","reason","approvedById","sourceCommandId")
  VALUES('cmdr-fact','cmdr-p','cmdr-root','FP-A','FP-B','substitute approved','cmdr-user','cmdr-C');
SQL
if psq -c "DELETE FROM \"CommandExecution\" WHERE \"id\"='cmdr-C'" >/dev/null 2>&1; then
  bad "shape C: deleting a receipt a recorded fact cites was ALLOWED — the repair could orphan a fact"
else
  ok "shape C: deleting a receipt a recorded FACT cites is REFUSED by PostgreSQL (the §CMDR second outcome)"
fi

$PSQL_ADMIN -c "DROP DATABASE IF EXISTS \"$CLONE\"" -c "DROP DATABASE IF EXISTS \"$BASE\"" >/dev/null

if [ "$FAIL" = "0" ]; then
  echo "COMMAND-RECEIPT ABORT PROOF PASSED: every incoherent shape aborts before the seal is installed, the §CMDR repair clears each one, and a receipt a fact depends on cannot be deleted."
else
  echo "COMMAND-RECEIPT ABORT PROOF FAILED"
  exit 1
fi
