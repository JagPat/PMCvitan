#!/usr/bin/env bash
# Vitan PMC — dev-auth lockdown safety checker.
#
# Turns the manual "Lockout guard" from docs/GO_LIVE.md into a runnable check.
# The lockdown itself is an env flip in Coolify (ALLOW_DEV_AUTH=false +
# VITE_ALLOW_DEV_AUTH=false, redeploy) — this script does NOT flip anything. It
# tells you whether it is SAFE to flip, and whether a flip actually took.
#
# Two modes:
#   (default)  READINESS — run BEFORE locking down. Confirms a real office
#              sign-in already works, so the flip won't lock everyone out.
#   --verify   POST-FLIP — run AFTER locking down. Confirms dev auth is now 403
#              AND the office admin can still sign in. Non-zero exit on failure.
#
# Real sign-in is probed with email+password (the recommended channel — the
# accounts ensure-accounts seeds). Supply the credential at runtime; nothing is
# committed:
#   ADMIN_EMAIL     office admin email      (default pmc@vitan.in)
#   ADMIN_PASSWORD  its password            (SEED_DEMO_PASSWORD on prod; required
#                                            to certify readiness / verify login)
#   API             API base                (default https://pms-api.vitan.in)
#   PROJECT         project id for probes   (default ambli)
#
# Usage:
#   ADMIN_PASSWORD=... bash scripts/lockdown-check.sh            # before flip
#   ADMIN_PASSWORD=... bash scripts/lockdown-check.sh --verify   # after flip
#
# Exit codes: 0 = good (safe / verified) · 1 = not safe / verification failed
#             · 2 = indeterminate (network error or ADMIN_PASSWORD missing).
set -uo pipefail

API="${API:-https://pms-api.vitan.in}"
PROJECT="${PROJECT:-ambli}"
ADMIN_EMAIL="${ADMIN_EMAIL:-pmc@vitan.in}"
MODE="readiness"
[ "${1:-}" = "--verify" ] && MODE="verify"

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }

# POST $1=path $2=json-body → prints "HTTP_CODE<newline>BODY"
post() {
  curl -sS -m 20 -o /tmp/vitan_lockdown_body.json -w '%{http_code}' \
    -X POST "$API$1" -H 'Content-Type: application/json' -d "$2" 2>/dev/null
  local rc=$?
  echo
  cat /tmp/vitan_lockdown_body.json 2>/dev/null
  return $rc
}

echo "=== Vitan PMC dev-auth lockdown check ($MODE) — $API ==="

# ---- Probe 1: dev-auth state (POST /auth/session) --------------------------
dev_code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' \
  -X POST "$API/auth/session" -H 'Content-Type: application/json' \
  -d "{\"role\":\"pmc\",\"projectId\":\"$PROJECT\"}" 2>/dev/null)
case "$dev_code" in
  200) dev_state="OPEN";   echo "DEV-AUTH : OPEN  (POST /auth/session → 200 — ALLOW_DEV_AUTH is on)";;
  403) dev_state="LOCKED"; echo "DEV-AUTH : LOCKED (POST /auth/session → 403 — ALLOW_DEV_AUTH is off)";;
  000|"") dev_state="ERR"; echo "DEV-AUTH : ERROR (no response from $API — is it reachable?)";;
  *)   dev_state="?";      echo "DEV-AUTH : ?     (POST /auth/session → HTTP $dev_code)";;
esac

# ---- Probe 2: real office sign-in (POST /auth/login) -----------------------
login_state="SKIP"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "LOGIN    : SKIP  (set ADMIN_PASSWORD to test $ADMIN_EMAIL email+password sign-in)"
else
  login_resp=$(post /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  login_code=$(printf '%s' "$login_resp" | head -1)
  login_tok=$(printf '%s' "$login_resp" | tail -n +2 | jqget token)
  if [ "$login_code" = "200" ] && [ -n "$login_tok" ]; then
    login_state="WORKS"; echo "LOGIN    : WORKS (POST /auth/login as $ADMIN_EMAIL → token — real sign-in is live)"
  elif [ "$login_code" = "401" ]; then
    login_state="FAIL";  echo "LOGIN    : FAIL  (401 — account not seeded or wrong password. Run: pnpm --filter api ensure-accounts)"
  elif [ "$login_code" = "000" ] || [ -z "$login_code" ]; then
    login_state="ERR";   echo "LOGIN    : ERROR (no response from $API)"
  else
    login_state="FAIL";  echo "LOGIN    : FAIL  (POST /auth/login → HTTP $login_code)"
  fi
fi

echo "---"

# ---- Verdict ---------------------------------------------------------------
if [ "$MODE" = "verify" ]; then
  # Post-flip: dev auth MUST be locked, and the office admin MUST still get in.
  if [ "$dev_state" != "LOCKED" ]; then
    echo "RESULT   : ✗ NOT LOCKED — dev auth still answers (state=$dev_state). Set ALLOW_DEV_AUTH=false and redeploy the API."
    exit 1
  fi
  if [ "$login_state" = "WORKS" ]; then
    echo "RESULT   : ✓ LOCKED & SAFE — dev auth is 403 and $ADMIN_EMAIL can still sign in."
    exit 0
  fi
  if [ "$login_state" = "SKIP" ]; then
    echo "RESULT   : ⚠ LOCKED, sign-in UNVERIFIED — set ADMIN_PASSWORD and re-run to confirm nobody is locked out."
    exit 2
  fi
  echo "RESULT   : ✗ LOCKOUT RISK — dev auth is off but $ADMIN_EMAIL cannot sign in (login=$login_state). Re-open (ALLOW_DEV_AUTH=true) or seed accounts NOW."
  exit 1
fi

# Readiness (pre-flip): a real office sign-in must already work.
if [ "$dev_state" = "LOCKED" ]; then
  echo "note     : dev auth is already LOCKED on this API."
fi
case "$login_state" in
  WORKS) echo "RESULT   : ✓ SAFE TO LOCK DOWN — $ADMIN_EMAIL signs in with email+password. Flip ALLOW_DEV_AUTH=false + VITE_ALLOW_DEV_AUTH=false, redeploy, then re-run with --verify."; exit 0;;
  SKIP)  echo "RESULT   : ⚠ CANNOT CERTIFY — set ADMIN_PASSWORD (the office password / SEED_DEMO_PASSWORD) and re-run before locking down."; exit 2;;
  ERR)   echo "RESULT   : ⚠ CANNOT CERTIFY — API unreachable; resolve connectivity and re-run."; exit 2;;
  *)     echo "RESULT   : ✗ NOT SAFE — no working office sign-in yet. Seed accounts first: pnpm --filter api ensure-accounts (or AUTO_ENSURE_ACCOUNTS=true). Do NOT lock down."; exit 1;;
esac
