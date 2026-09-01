#!/bin/sh
# Production migration runner (DEP-02): `prisma migrate deploy`, FAIL CLOSED.
#
# A failed migration must fail the deploy — it must never mutate a production
# schema outside the reviewed migration history, so there is deliberately NO
# `db push` fallback here (`db push --accept-data-loss` can drop data).
#
# One recognised special case: a database that predates the migration baseline
# (schema originally created via `prisma db push`, so no _prisma_migrations
# table). `migrate deploy` fails that with P3005 even though the schema itself
# is already current. For that exact error we baseline once — mark every
# migration in prisma/migrations as applied — and retry. Any other failure
# exits non-zero and the container does not start.
set -u

# ── T45 preflight (F3.1 + §C/§E physical-truth diagnostics) — ENFORCED, not documented ──────────
# Run the COMPILED preflight (never tsx) BEFORE `prisma migrate deploy`. It is schema-aware:
#   - a fresh/empty or pre-Task-5 database reports "not applicable" and passes (exit 0), so the
#     migrations that CREATE the §C/§E schema still run;
#   - an eligible database (Task-5 schema present, incl. an already-corrected one) runs the
#     diagnostics; any unrepaired violation — including F3.1 duplicate canonical issue movements,
#     which the migration itself would only surface OPAQUELY inside CREATE UNIQUE INDEX — prints the
#     named report and exits non-zero, so Prisma NEVER starts and migration 20261231 is never
#     recorded as failed. Repair per docs/RUNBOOK.md §T45 (t45:repair), then redeploy.
# The compiled artifact is produced by the image build (`pnpm --filter api build`, see Dockerfile);
# migrate.sh is the production runner, so a missing artifact means a broken build — fail closed.
PREFLIGHT="dist/platform/t45/t45.cli.js"
if [ -f "$PREFLIGHT" ]; then
  echo "[migrate] T45 preflight (compiled artifact): node $PREFLIGHT preflight"
  if ! node "$PREFLIGHT" preflight; then
    echo "[migrate] T45 preflight FAILED — unrepaired §C/§E violations block this deploy."
    echo "[migrate] Repair per docs/RUNBOOK.md §T45 (t45:repair), then redeploy. Prisma was NOT started."
    exit 1
  fi
else
  echo "[migrate] ERROR: compiled T45 preflight ($PREFLIGHT) is missing — the build is incomplete; refusing to deploy."
  exit 1
fi

# ── T2C preflight (Phase 4 Task 2 labour commercial-integrity diagnostics) — ENFORCED ────────────
# Run the COMPILED preflight (never tsx) AFTER the T45 preflight and BEFORE `prisma migrate deploy`.
# It is schema-aware:
#   - a fresh/empty or pre-Task-2 database reports "not applicable" and passes (exit 0), so the
#     migrations that CREATE the labour commercial schema still run;
#   - an eligible database (labour commercial schema present, incl. an already-corrected one) runs the
#     F5/F3/F2.spec/F2.slice/F2.poline/F4 diagnostics; any unrepaired violation — including the
#     F2.poline / F4 shapes that migration 20270205 would only surface OPAQUELY inside
#     ALTER TABLE … ADD CONSTRAINT — prints the named report and exits non-zero, so Prisma NEVER starts
#     and migration 20270205 is never recorded as failed. Repair per docs/RUNBOOK.md §P4T2C (t2c:repair),
#     then redeploy.
# The compiled artifact is produced by the image build; a missing artifact means a broken build — fail closed.
T2C_PREFLIGHT="dist/labour/t2c/t2c.cli.js"
if [ -f "$T2C_PREFLIGHT" ]; then
  echo "[migrate] T2C preflight (compiled artifact): node $T2C_PREFLIGHT preflight"
  if ! node "$T2C_PREFLIGHT" preflight; then
    echo "[migrate] T2C preflight FAILED — unrepaired labour commercial-integrity violations block this deploy."
    echo "[migrate] Repair per docs/RUNBOOK.md §P4T2C (t2c:repair), then redeploy. Prisma was NOT started."
    exit 1
  fi
else
  echo "[migrate] ERROR: compiled T2C preflight ($T2C_PREFLIGHT) is missing — the build is incomplete; refusing to deploy."
  exit 1
fi

# ── T3C preflight (Phase 4 Task 3 §C attendance-integrity diagnostics) — ENFORCED ────────────────
# Run the COMPILED preflight (never tsx) AFTER the T2C preflight and BEFORE `prisma migrate deploy`.
# It is schema-aware:
#   - a fresh/empty or pre-Task-3 database reports "not applicable" and passes (exit 0), so the
#     migrations that CREATE the §C attendance schema still run;
#   - an eligible database (LabourAttendance.manualReason present, incl. a fully-corrected one) runs
#     the F1.blank / F1.marker diagnostics; any unrepaired violation prints the named report and exits
#     non-zero, so Prisma NEVER starts and migrations 20270220 / 20270225 are never recorded as
#     failed. Repair per docs/RUNBOOK.md §P4T3C2 (t3c:repair — which MARKS AND REVOKES, and never
#     deletes an attendance row), then redeploy.
# The compiled artifact is produced by the image build; a missing artifact means a broken build — fail closed.
T3C_PREFLIGHT="dist/labour/t3c/t3c.cli.js"
if [ -f "$T3C_PREFLIGHT" ]; then
  echo "[migrate] T3C preflight (compiled artifact): node $T3C_PREFLIGHT preflight"
  if ! node "$T3C_PREFLIGHT" preflight; then
    echo "[migrate] T3C preflight FAILED — unrepaired §C attendance violations block this deploy."
    echo "[migrate] Repair per docs/RUNBOOK.md §P4T3C2 (t3c:repair), then redeploy. Prisma was NOT started."
    exit 1
  fi
else
  echo "[migrate] ERROR: compiled T3C preflight ($T3C_PREFLIGHT) is missing — the build is incomplete; refusing to deploy."
  exit 1
fi

# ── Schema enforcement preflight — EVERY trigger fires, EVERY foreign key is validated ──────────
# Run the COMPILED check (never tsx) AFTER the three preflights and BEFORE `prisma migrate deploy`,
# and AGAIN after a successful deploy (below). Unlike those three it asks nothing about a
# particular migration's data: it states two CLOSED properties of the whole application schema —
# no trigger is disabled, no foreign key is unvalidated — so it needs no list of expected objects
# to keep in step with, and a seal installed by a migration written after this file is covered the
# day it lands.
#
# It is schema-aware in the only way this question can be: a fresh or empty database has no
# application tables, reports "not applicable" and passes here, so the migrations that CREATE the
# schema still run. Any database that HAS tables is eligible — there is no version gate, because
# the property is true of every schema at every version.
#
# WHY BEFORE PRISMA: a dirty database must never receive a partial migration. A migration applied
# over switched-off seals writes rows nothing validated, and every later deploy sees a complete
# ledger and re-reads nothing.  MEASURED on PG 16.13: with a table's triggers disabled by
# `ALTER TABLE ... DISABLE TRIGGER ALL`, an INSERT of an orphaned row COMMITTED while
# `pg_constraint.convalidated` stayed true — so a check that reads only `convalidated` (as the
# prerequisite guards in 20270225000000 do) cannot see this, and this one can.
# The compiled artifact is produced by the image build; a missing artifact means a broken build — fail closed.
ENF_CHECK="dist/platform/enforcement/enforcement.cli.js"
if [ -f "$ENF_CHECK" ]; then
  echo "[migrate] schema enforcement preflight (compiled artifact): node $ENF_CHECK preflight"
  if ! node "$ENF_CHECK" preflight; then
    echo "[migrate] schema enforcement preflight FAILED — a trigger does not fire or a foreign key was never validated."
    echo "[migrate] Repair per docs/RUNBOOK.md §ENF, then redeploy. Prisma was NOT started."
    exit 1
  fi
else
  echo "[migrate] ERROR: compiled schema enforcement check ($ENF_CHECK) is missing — the build is incomplete; refusing to deploy."
  exit 1
fi

# ── B1 seal verifier (schedule dependency graph) — declared here, RUN AFTER the deploy ──────────
# Not a preflight. `20270930000000_schedule_dependency_graph` completes its own install and proves
# every object before it lifts its write barrier, so there is nothing useful to ask BEFORE Prisma
# runs. The question this answers is the one a complete ledger cannot: are those guards still there
# and still firing on a database that has been in service? A failed restore's
# `ALTER TABLE ... DISABLE TRIGGER ALL`, or a `CREATE OR REPLACE FUNCTION` that kept a seal's
# identity and hollowed its body, leaves every migration applied and nothing to re-run — MEASURED:
# with `ActivityDependency_frozen` and `ActivityDependency_no_delete` disabled this runner exited 0,
# after which an UPDATE and a DELETE against the immutable evidence row both committed.
# It re-executes the MIGRATION'S OWN inventory, extracted from the file, so there is no second list
# to drift. A missing artifact means a broken build — fail closed, as with the three preflights; and
# so does a `prisma/migrations` tree the verifier cannot read, since `prisma migrate deploy` needs
# that tree anyway and a verifier that cannot find its question must not answer "sealed".
B1_SEALS="dist/activities/b1/b1.cli.js"
if [ ! -f "$B1_SEALS" ]; then
  echo "[migrate] ERROR: compiled B1 seal verifier ($B1_SEALS) is missing — the build is incomplete; refusing to deploy."
  exit 1
fi

out=$(npx prisma migrate deploy 2>&1)
code=$?
echo "$out"
if [ $code -eq 0 ]; then
  # ORDINARY success path — verify the full T3C seal set before reporting the deploy good.
  # `prisma migrate deploy` proves the LEDGER is complete, not that the physical guards enforce:
  # `CREATE OR REPLACE FUNCTION` preserves a function's identity, so a hollowed trigger body (e.g. a
  # no-op `phase4_t3_skill_substitution_append_only`) survives a ledger-backed upgrade — every
  # migration is already applied, nothing re-runs, and without this check the runner exited 0 while
  # an approved skill substitution stayed rewritable. `t3c seals` verifies canonical function-BODY
  # identity, CHECK expressions, VALID/READY unique keys and FK mappings; after a full deploy the
  # only acceptable answer is 0 (sealed). Anything else fails CLOSED with the named objects.
  if ! node "$T3C_PREFLIGHT" seals; then
    echo "[migrate] ERROR: 'prisma migrate deploy' succeeded but the T3C seal verification FAILED — the ledger is complete while a physical guard is missing, disabled or not the canonical body."
    echo "[migrate] This deploy is NOT good. Repair per docs/RUNBOOK.md §P4T3C3, then redeploy."
    exit 1
  fi
  # The same question for the schedule dependency graph. Exit 4 ("no ActivityDependency") is a
  # failure HERE too and not a pass: after a successful deploy that table must exist, so its absence
  # means the deploy did not do what the ledger now claims it did.
  if ! node "$B1_SEALS" seals; then
    echo "[migrate] ERROR: 'prisma migrate deploy' succeeded but the schedule B1 seal verification FAILED — the ledger is complete while a dependency-graph guard is missing, disabled, hollowed or unowned."
    echo "[migrate] This deploy is NOT good. Repair per docs/RUNBOOK.md section B1, then redeploy."
    exit 1
  fi
  # And the whole-schema question, asked again now that the deploy has finished. A migration that
  # disables a trigger to do its work and fails to restore it leaves every migration applied and
  # nothing to re-run — the ledger is complete and the seal is off. Exit 4 ("no application tables")
  # is a failure HERE too and not a pass: after a successful deploy the schema must exist.
  if ! node "$ENF_CHECK" verify; then
    echo "[migrate] ERROR: 'prisma migrate deploy' succeeded but schema enforcement verification FAILED — the ledger is complete while a trigger does not fire or a foreign key is unvalidated."
    echo "[migrate] This deploy is NOT good. Repair per docs/RUNBOOK.md §ENF, then redeploy."
    exit 1
  fi
  exit 0
fi

if echo "$out" | grep -q "P3005"; then
  echo "[migrate] pre-baseline database detected (P3005) — marking existing migrations as applied"

  # A pre-baseline database was created by `prisma db push`, which reproduces ONLY what schema.prisma
  # models. Migration 20270225000000 creates nothing Prisma models — two functions, two triggers and
  # a CHECK constraint, all raw SQL — so such a database can hold `LabourAttendance.manualReason`
  # (looking eligible and row-clean to the preflight above) while carrying none of the seals.
  # Blanket-resolving it as applied would record the correction as installed forever without ever
  # running it, leaving production permanently without the reserved-marker trigger and the allocation
  # project lock. So ASK the database first, and when the seals are absent leave that one migration
  # PENDING for the retried `migrate deploy` to actually execute — everything it creates is
  # raw-SQL-only, so it applies cleanly over a db-push schema, and its diagnostic-first DO block still
  # aborts on dirty data exactly as on any other database.
  T3C_CORRECTION2="20270220000000_phase4_t3_correction2"
  T3C_CORRECTION="20270225000000_phase4_t3_correction3"
  SKIP_T3C_CORRECTION=0
  SKIP_T3C_CORRECTION2=0

  # Migrations that must EXECUTE on this path rather than be recorded as applied.
  #
  # The loop below baselines a pre-baseline database by resolving every migration as applied, which
  # is right for the ones whose schema that database already has. It is wrong for a migration whose
  # objects it cannot possibly have — and silently so: `schema.prisma` describes tables, columns and
  # foreign keys, so a later `prisma db push`-shaped reconciliation can produce those, but it cannot
  # produce a trigger or a CHECK. Resolving such a migration as applied leaves the ledger
  # permanently claiming guards that never ran, which is the one failure mode a baseline must not
  # have: it is indistinguishable from success.
  #
  # The T3C entries above decide this from a live probe, because those migrations may or may not
  # have run. These are decided statically, because they cannot have: a pre-baseline database
  # predates them. Leaving them pending costs nothing when they have somehow already been applied —
  # `20270920000000_decision_option_kinds` is written idempotently and re-applies as a no-op.
  #
  # `20270930000000_schedule_dependency_graph` is written to be re-run, and it is stated here
  # rather than discovered in production. That file COMPLETES ITS OWN INSTALL of
  # "ActivityDependency": every object is created only if absent, and an object that is present is
  # compared by DEFINITION first — so a run that died part-way is finished by the next one, which
  # is what re-running this script does. It ABORTS only over an object it did not install (a column
  # contract that differs, a missing or altered CHECK, a same-named index or seal with another
  # definition, or an INCOMPLETE install whose table already holds rows), and the abort NAMES that
  # object and points at docs/RUNBOOK.md section B1. ROWS ALONE ARE NOT A REFUSAL: a COMPLETE
  # install that has been in service replays as a no-op, which is the only populated state a real
  # re-deploy meets. The last-resort repair is cheap because the table is NEW: it exists in no
  # released schema, no service writes it, and it holds ZERO ROWS everywhere.
  # `scripts/schedule-b1-baseline-proof.sh` runs THIS runner through all five states (install where
  # the table is absent; abort-then-repair over a table this migration did not build; COMPLETION of
  # a genuine partial apply; refusal over a populated INCOMPLETE table; and a no-op replay over a
  # populated COMPLETE one), and CI runs that proof in the required `api` job.
  #
  # The entry is still right. `schema.prisma` can describe neither a CHECK nor a trigger, so
  # baselining that migration WITHOUT running it would record guards that never existed —
  # indistinguishable from success. Left pending so the deploy really executes it.
  #
  # `20271015000000_phase6_t4b_decider` (phase-6 4b, round-8 Codex F3) is the same shape: its
  # enum values, columns and FK a db-push database already has, but its substance is RAW SQL —
  # the §B.2 standing primitives, the 4b seal-trigger network (lifecycle, option floor, holder
  # guards, TRUNCATE seals, frozen chains) and the diagnostic zero-holder audit — none of which
  # `schema.prisma` can describe. Resolving it as applied on this path would enable 4b service
  # writes against a database WITHOUT the seals every service invariant assumes. Every statement
  # in that file is re-runnable (ADD VALUE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
  # duplicate_object-guarded constraints, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS +
  # CREATE, and a DROP NOT NULL that no-ops), so leaving it pending costs nothing when it has
  # somehow already run; its audit DO block aborts only over a register already in the
  # zero-holder state — exactly the diagnostic-first refusal this path must keep.
  #
  # 20271120000000_phase6_t4c_iii_enablement is here for the same reason. `schema.prisma` models
  # only ONE of its objects — the `ProjectCapability.project` cascade FK. The three trigger
  # functions, the three triggers and the every-project backfill are raw, so a `prisma db push`
  # baseline produces a database with the modeled FK and NONE of the transition. Resolving it as
  # applied would skip them permanently: existing and future projects would carry no `consultation`
  # row (the enablement this unit exists to establish), and any attribution that did appear would
  # stay freely rewritable, because the preservation seal that freezes it was never installed. The
  # generic enforcement verifier deliberately keeps no expected-object list, so nothing downstream
  # would notice. Every statement in the file is re-runnable — DROP ... IF EXISTS, a
  # DROP CONSTRAINT IF EXISTS before the ADD, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
  # before each CREATE TRIGGER, and a backfill with ON CONFLICT DO NOTHING — so leaving it pending
  # costs nothing when it has somehow already run, and its closing DO block still refuses to commit
  # unless every project carries the row.
  ALWAYS_EXECUTE="20270930000000_schedule_dependency_graph
20270920000000_decision_option_kinds
20271015000000_phase6_t4b_decider
20271120000000_phase6_t4c_iii_enablement"
  if [ -f "$T3C_PREFLIGHT" ]; then
    SEALS_OUT=$(node "$T3C_PREFLIGHT" seals 2>&1)
    seals_code=$?
    echo "$SEALS_OUT"
    case $seals_code in
      0)
        echo "[migrate] T3C correction seals present — resolving $T3C_CORRECTION2 and $T3C_CORRECTION as applied with the rest"
        ;;
      3)
        # BOTH corrections are re-runnable diagnostic-first migrations, and the seals JSON's
        # `pendingMigrations` names exactly the ones whose physical objects are absent. Leaving
        # ONLY 20270225 pending while 20270220's CHECK was missing resolved that migration as
        # applied over a database without its constraint — a raw write could then store a blank
        # manualReason forever on a database Prisma swears is corrected.
        #
        # `pendingMigrations` is parsed PRECISELY, never grepped out of the whole output: the JSON
        # also carries per-layer labels like `phase4_t3_attendance_append_only@20270220…` in
        # `correction2Missing`, and in the body-only-stale case `correctionSeals()` deliberately
        # attributes the heal to 20270225 ALONE (rerunning 20270220 over its existing CHECK fails
        # the whole deploy). A whole-output grep saw the label, left 20270220 pending anyway, and
        # the retry aborted on the already-existing constraint instead of letting 20270225 heal.
        echo "[migrate] T3C correction seals MISSING on this pre-baseline database — leaving the reported migrations pending so they really apply"
        PENDING_MIGRATIONS=$(echo "$SEALS_OUT" | node -e '
          let t = "";
          process.stdin.on("data", (d) => (t += d));
          process.stdin.on("end", () => {
            const start = t.indexOf("{");
            const end = t.lastIndexOf("}");
            if (start < 0 || end <= start) return;
            try {
              const j = JSON.parse(t.slice(start, end + 1));
              for (const m of j.pendingMigrations || []) console.log(m);
            } catch {}
          });
        ')
        if printf '%s\n' "$PENDING_MIGRATIONS" | grep -qx "$T3C_CORRECTION"; then SKIP_T3C_CORRECTION=1; fi
        if printf '%s\n' "$PENDING_MIGRATIONS" | grep -qx "$T3C_CORRECTION2"; then SKIP_T3C_CORRECTION2=1; fi
        if [ "$SKIP_T3C_CORRECTION" -eq 0 ] && [ "$SKIP_T3C_CORRECTION2" -eq 0 ]; then
          echo "[migrate] ERROR: t3c seals exited 3 but named no pending migration — refusing to baseline on an unreadable answer."
          exit 1
        fi
        ;;
      5)
        # The §C TABLES are here but the §C GUARDS from 20270210000000 / 20270215000000 are not —
        # the `prisma db push` signature. Those migrations CREATE TABLE, so they cannot be left
        # pending to re-run the way correction 3 can, and resolving them as applied would record
        # triggers that do not exist: `WorkerAllocation_head_live` among them, the guard that refuses
        # an allocation against a CANCELLED requirement under the root lock. Correction 3 replaces
        # that trigger's FUNCTION but never creates the TRIGGER, so nothing downstream would notice.
        # Reconciling a db-push database is a judgement about which objects are really missing, so
        # this fails closed. See docs/RUNBOOK.md §P4T3C3.
        echo "[migrate] ERROR: pre-baseline database has the §C tables but NOT the §C guards (t3c seals: prerequisite-seals-missing)."
        echo "[migrate] Migrations 20270210000000 / 20270215000000 create those triggers in raw SQL, which \`prisma db push\` does not reproduce."
        echo "[migrate] Baselining them as applied would record guards that do not exist. Refusing to baseline. See docs/RUNBOOK.md §P4T3C3."
        exit 1
        ;;
      4)
        # The §C attendance schema is not here at all. A pre-baseline database is one whose SCHEMA
        # already exists without a migration ledger; if that schema predates Task 3, resolving every
        # migration as applied would record dozens of migrations that never ran and leave Prisma's
        # ledger describing tables the application does not have. There is no safe automatic answer
        # — the correct baseline point is a judgement about which schema this actually is — so this
        # fails closed rather than guessing. See docs/RUNBOOK.md §P4T3C3.
        echo "[migrate] ERROR: pre-baseline database has NO §C attendance schema (t3c seals: prerequisite-schema-absent)."
        echo "[migrate] This database predates Phase 4 Task 3, so baselining every migration as applied would record"
        echo "[migrate] migrations that never ran. Refusing to baseline. See docs/RUNBOOK.md §P4T3C3."
        exit 1
        ;;
      *)
        echo "[migrate] ERROR: t3c seals exited $seals_code (unexpected) — refusing to baseline."
        exit 1
        ;;
    esac
  else
    echo "[migrate] ERROR: compiled T3C preflight ($T3C_PREFLIGHT) is missing — cannot verify correction-3 seals; refusing to baseline."
    exit 1
  fi

  for dir in prisma/migrations/*/; do
    name=$(basename "$dir")
    if [ "$SKIP_T3C_CORRECTION" -eq 1 ] && [ "$name" = "$T3C_CORRECTION" ]; then
      echo "[migrate] skipping resolve --applied for $name (it will be executed by the deploy below)"
      continue
    fi
    if [ "$SKIP_T3C_CORRECTION2" -eq 1 ] && [ "$name" = "$T3C_CORRECTION2" ]; then
      echo "[migrate] skipping resolve --applied for $name (it will be executed by the deploy below)"
      continue
    fi
    if printf '%s\n' "$ALWAYS_EXECUTE" | grep -qx "$name"; then
      echo "[migrate] leaving $name pending so its raw guards really apply (baseline cannot have them)"
      continue
    fi
    npx prisma migrate resolve --applied "$name" || exit 1
  done

  npx prisma migrate deploy || exit 1

  # Fail closed if the seals STILL are not there: Prisma now considers every migration applied, so a
  # missing object at this point would go unnoticed forever. Exit 4 ("no §C schema") is a failure
  # HERE too and not a pass — after a successful deploy those tables must exist, so their absence
  # means the deploy did not do what the ledger now claims it did.
  if ! node "$T3C_PREFLIGHT" seals; then
    echo "[migrate] ERROR: T3C correction-3 seals are not installed and enforcing after baseline + deploy — refusing to start."
    exit 1
  fi
  if ! node "$B1_SEALS" seals; then
    echo "[migrate] ERROR: the schedule B1 guards are not installed and enforcing after baseline + deploy — refusing to start."
    echo "[migrate] See docs/RUNBOOK.md section B1."
    exit 1
  fi
  # The baseline path resolves migrations as applied without running them, so it is the path most
  # able to leave the ledger claiming guards the schema does not have. Ask the schema directly.
  if ! node "$ENF_CHECK" verify; then
    echo "[migrate] ERROR: schema enforcement is not intact after baseline + deploy — refusing to start."
    echo "[migrate] See docs/RUNBOOK.md §ENF."
    exit 1
  fi
  exit 0
fi

echo "[migrate] migrate deploy failed — refusing to start (no db push fallback in production)"
exit $code
