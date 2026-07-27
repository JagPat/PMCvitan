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

out=$(npx prisma migrate deploy 2>&1)
code=$?
echo "$out"
[ $code -eq 0 ] && exit 0

if echo "$out" | grep -q "P3005"; then
  echo "[migrate] pre-baseline database detected (P3005) — marking existing migrations as applied"
  for dir in prisma/migrations/*/; do
    name=$(basename "$dir")
    npx prisma migrate resolve --applied "$name" || exit 1
  done
  exec npx prisma migrate deploy
fi

echo "[migrate] migrate deploy failed — refusing to start (no db push fallback in production)"
exit $code
