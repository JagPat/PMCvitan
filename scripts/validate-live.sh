#!/usr/bin/env bash
# Vitan PMC — live provider-state validator.
# Reports whether each external provider is on its dev-stub or live, against the
# deployed API. Read-only by default. Pass --media to also run the media
# round-trip (writes ONE durable test row to the ambli project — see
# docs/PROVIDER_CUTOVER.md, no DELETE endpoint exists).
#
# Usage: bash scripts/validate-live.sh [--media]
set -uo pipefail

API="${API:-https://pms-api.vitan.in}"
PROJECT="${PROJECT:-ambli}"
RUN_MEDIA=0
[ "${1:-}" = "--media" ] && RUN_MEDIA=1

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }

echo "=== Vitan PMC live validation — $API ==="

# 1) Web push (VAPID)
key=$(curl -sS -m 15 "$API/push/public-key" | jqget key)
if [ -n "$key" ]; then echo "PUSH   : LIVE  (public-key served: ${key:0:16}…)"
else echo "PUSH   : STUB  (public-key empty — VAPID not set)"; fi

# 2) SMS OTP (MSG91) — read the live/devCode discriminator (no SMS side effect in stub)
otp=$(curl -sS -m 15 -X POST "$API/auth/otp/request" -H 'Content-Type: application/json' \
      -d "{\"phone\":\"9999900000\",\"projectId\":\"$PROJECT\"}")
live=$(printf '%s' "$otp" | jqget live)
dev=$(printf '%s' "$otp" | jqget devCode)
if [ "$live" = "True" ] || [ "$live" = "true" ]; then echo "OTP    : LIVE  (live:true, no devCode — real SMS sent!)"
else echo "OTP    : STUB  (live:false, devCode:$dev)"; fi

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
  case "$url" in
    https://*) echo "MEDIA  : LIVE  (R2 — absolute url: $url)";;
    /media/*)  echo "MEDIA  : STUB  (DB — relative url: $url)";;
    *)         echo "MEDIA  : ?     (unexpected: $m)";;
  esac
  echo "         (created test media id: $id — irreversible via API)"
elif [ "$RUN_MEDIA" = "1" ]; then
  echo "MEDIA  : skipped (no token)"
else
  echo "MEDIA  : skipped (pass --media to test; writes a durable test row)"
fi

echo "=== done ==="
