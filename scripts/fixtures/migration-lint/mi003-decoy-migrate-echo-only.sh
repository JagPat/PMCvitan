#!/usr/bin/env bash
# CONSTRUCTED PROBE — not a historical extract.
# Proves: MI-003 requires an INVOCATION, not a mention (Codex finding F1 against head c6e9ff17).
#
# TWO procedures are named after `prisma migrate deploy` succeeds. §OTHER is genuinely verified —
# its token stands in the failure branch of a command that RUNS something. "section B1" is named
# only by an `echo`, which is an executable line too, and that is the whole finding: at head
# c6e9ff17 the rule stripped COMMENT lines and then asked whether the token appeared in the
# remaining text after the deploy. It did. So a migration whose seals were never re-checked was
# reported GREEN by the mere presence of the sentence that says what to do when they fail.
set -euo pipefail

out=$(npx prisma migrate deploy 2>&1)
code=$?
echo "$out"
if [ $code -eq 0 ]; then
  if ! node "$OTHER_SEALS" seals; then
    echo "[migrate] ERROR: the §OTHER seal verification failed."
    echo "[migrate] Repair per docs/RUNBOOK.md §OTHER, then redeploy."
    exit 1
  fi
  echo "[migrate] If the dependency-graph guards look wrong, repair per docs/RUNBOOK.md section B1."
  exit 0
fi
exit 1
