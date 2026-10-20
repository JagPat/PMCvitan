#!/usr/bin/env bash
# Vitan PMC — live provider-state validator.
# Reports whether each external provider is on its dev-stub or live, against the
# deployed API. Reads only by default. Two checks have side effects and run only
# when asked:
#   --otp    asks the API to send an OTP, which is a real SMS once MSG91 is live;
#   --media  uploads ONE test photo to the ambli project (remove it afterwards
#            with DELETE /media/<id>; see docs/PROVIDER_CUTOVER.md).
# Exits 1 when a check that was asked for fails or cannot run.
#
# Usage: bash scripts/validate-live.sh [--otp] [--media]
set -uo pipefail

API="${API:-https://pms-api.vitan.in}"
PROJECT="${PROJECT:-ambli}"
RUN_MEDIA=0
RUN_OTP=0
FAILED=0
for arg in "$@"; do
  case "$arg" in
    --media) RUN_MEDIA=1;;
    --otp) RUN_OTP=1;;
    *) echo "unknown option: $arg (use --otp and/or --media)" >&2; exit 2;;
  esac
done

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }

echo "=== Vitan PMC live validation — $API ==="

# 1) Web push (VAPID)
key=$(curl -sS -m 15 "$API/push/public-key" | jqget key)
if [ -n "$key" ]; then echo "PUSH   : LIVE  (public-key served: ${key:0:16}…)"
else echo "PUSH   : STUB  (public-key empty — VAPID not set)"; fi

# 2) SMS OTP (MSG91) — read the live/devCode discriminator. Only with --otp: once MSG91 is live
#    the request sends a real SMS.
if [ "$RUN_OTP" = "1" ]; then
otp=$(curl -sS -m 15 -X POST "$API/auth/otp/request" -H 'Content-Type: application/json' \
      -d "{\"phone\":\"9999900000\",\"projectId\":\"$PROJECT\"}")
live=$(printf '%s' "$otp" | jqget live)
dev=$(printf '%s' "$otp" | jqget devCode)
if [ "$live" = "True" ] || [ "$live" = "true" ]; then echo "OTP    : LIVE  (live:true, no devCode — real SMS sent!)"
else echo "OTP    : STUB  (live:false, devCode:$dev)"; fi
else
  echo "OTP    : skipped (pass --otp to test; it sends a real SMS once MSG91 is live)"
fi

# 3) Snapshot (auth read path) — needs dev auth (ALLOW_DEV_AUTH) for the token
tok=$(curl -sS -m 15 -X POST "$API/auth/session" -H 'Content-Type: application/json' \
      -d "{\"role\":\"pmc\",\"projectId\":\"$PROJECT\"}" | jqget token)
if [ -z "$tok" ]; then
  echo "SNAP   : n/a   (no dev-auth token — ALLOW_DEV_AUTH may be off)"
else
  snap=$(curl -sS -m 15 -o /tmp/vitan_snap.json -w "%{http_code}" \
         "$API/projects/$PROJECT/snapshot" -H "Authorization: Bearer $tok")
  photos=$(python3 -c "import json;print('photos' in json.load(open('/tmp/vitan_snap.json')).get('dailyLog',{}))" 2>/dev/null)
  echo "SNAP   : HTTP $snap (dailyLog.photos present: $photos)"
fi

# 4) Media storage (R2 vs DB stub) — only with --media (writes a test row)
if [ "$RUN_MEDIA" = "1" ] && [ -n "${tok:-}" ]; then
  PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  m=$(curl -sS -m 20 -X POST "$API/projects/$PROJECT/media" -H "Authorization: Bearer $tok" \
      -H 'Content-Type: application/json' -d "{\"kind\":\"progress\",\"mime\":\"image/png\",\"data\":\"$PNG\"}")
  url=$(printf '%s' "$m" | jqget url)
  id=$(printf '%s' "$m" | jqget id)
  # Both modes return the same relative `/media/…` path, so the mode is read from what that path
  # answers: the DB stub serves the bytes (200); R2 redirects (302) to a signed GET on the
  # S3_ENDPOINT host. Plain GETs throughout: the signed link is bound to GET, and R2 refuses HEAD on it.
  # Nothing secret is printed: the `?t=` file token is cut from the path, and the signed link (its
  # host names the account, its query the access key id) is never echoed, only its status.
  path=${url%%\?*}
  case "$url" in
    /media/*)
      first=$(curl -sS -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' "$API$url")
      code=${first%% *}; signed=${first#* }
      if [ "$code" = "200" ]; then
        echo "MEDIA  : STUB  (DB — $path served directly, HTTP 200)"
      elif [ "$code" = "302" ] && case "$signed" in *X-Amz-Signature=*) true;; *) false;; esac; then
        got=$(curl -sS -m 20 -o /dev/null -w '%{http_code} %{content_type}' "$signed")
        # LIVE only when the signed read itself works: a key that can write but not read
        # (no Object Read) still uploads and redirects, but every image then fails to load.
        case "$got" in
          "200 image/png"*) echo "MEDIA  : LIVE  (R2 — $path → 302 to a signed link; signed GET answered: $got)";;
          *) echo "MEDIA  : FAIL  (R2 — $path → 302 to a signed link, but the signed GET answered '$got', not 200 image/png)"; FAILED=1;;
        esac
      else
        echo "MEDIA  : FAIL  (unexpected answer from $path: HTTP $code, not 200 or a 302 to a signed link)"; FAILED=1
      fi;;
    *) echo "MEDIA  : FAIL  (the upload answered no /media/ path)"; FAILED=1;;
  esac
  echo "         (created test media id: $id — remove it with DELETE /media/$id as a PMC)"
elif [ "$RUN_MEDIA" = "1" ]; then
  echo "MEDIA  : FAIL  (--media asked, but no dev-auth token, so the storage check did not run)"; FAILED=1
else
  echo "MEDIA  : skipped (pass --media to test; writes a durable test row)"
fi

echo "=== done ==="
exit "$FAILED"
