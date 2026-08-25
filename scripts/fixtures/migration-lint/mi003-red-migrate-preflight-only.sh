#!/usr/bin/env bash
# CONSTRUCTED PROBE — the shape at PR #411 head a222e91: the procedure is verified BEFORE the
# deploy and never after. A preflight runs against the database as it WAS, not as the deploy left
# it, so it cannot answer whether the seals are armed NOW.
set -euo pipefail

if ! node "$B1_SEALS" seals; then
  echo "[migrate] Repair per docs/RUNBOOK.md section B1, then redeploy. Prisma was NOT started."
  exit 1
fi

npx prisma migrate deploy || exit 1
exit 0
