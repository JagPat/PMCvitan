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
