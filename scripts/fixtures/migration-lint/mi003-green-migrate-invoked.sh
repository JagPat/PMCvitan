#!/usr/bin/env bash
# CONSTRUCTED PROBE — the shape PR #412 head 96c9cc4 added, reduced to its essentials.
# Proves: MI-003 clears when the procedure token stands in the failure branch of a real invocation
# on the deploy success path — `node "$B1_SEALS" seals`, which is what T45, T2C and T3C already did.
set -euo pipefail

out=$(npx prisma migrate deploy 2>&1)
code=$?
echo "$out"
if [ $code -eq 0 ]; then
  if ! node "$B1_SEALS" seals; then
    echo "[migrate] ERROR: the schedule B1 seal verification FAILED."
    echo "[migrate] This deploy is NOT good. Repair per docs/RUNBOOK.md section B1, then redeploy."
    exit 1
  fi
  exit 0
fi
exit 1
