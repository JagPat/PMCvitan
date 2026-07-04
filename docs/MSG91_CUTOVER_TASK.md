# TASK — Cut over MSG91 phone-OTP to live (autonomous)

A self-contained task card for a Claude Cowork / Claude Code session to execute once the DLT prerequisites are done. It flips SMS OTP from the dev-stub to live MSG91 v5, entirely via the Coolify API, and validates it — no dashboard, no code change. Detail/background: [`PROVIDER_CUTOVER.md`](./PROVIDER_CUTOVER.md).

**Goal:** `POST /auth/otp/request` on `pms-api.vitan.in` returns `{"sent":true,"live":true}` (no `devCode`) and a real SMS is delivered.

---

## Preconditions (do not start until ALL are true)

- [ ] **DLT done:** Principal Entity (PE) ID registered, a **6-char header** approved, and a **content template** approved that contains the `##OTP##` variable and is a **4-digit OTP with 5-minute validity** (the code hard-codes `otp_length=4&otp_expiry=5`).
- [ ] **MSG91 mapped:** the PE-ID, header, and template imported into MSG91, yielding an **MSG91 OTP Template ID** (~24-hex).
- [ ] **Server IP whitelisted** in MSG91 security for the API's real outbound IP (confirm it, don't assume — see step 5).
- [ ] The operator can **receive an SMS** on a real, consented **test phone** to complete verify (verify is human-only).

## Inputs (the human provides these at run time — never commit them)

| Input | Where it goes | Notes |
|---|---|---|
| `COOLIFY_TOKEN` | Coolify API auth | Coolify API token with `write`+`deploy` scope. Secret. |
| `MSG91_TEMPLATE_ID` | new API env var | The MSG91 OTP Template ID. **Required** — half the live gate. |
| `MSG91_SENDER_ID` | new API env var | The approved 6-char header (e.g. `VITANP`). Optional in code, but needed for delivery unless the template has a default header. |
| `MSG91_AUTH_KEY` | existing API env var | Already set. Only update it if it changed/rotated. |
| `TEST_PHONE` | validation only | A real 10-digit number you control. **Never** use the sample `9876543210` live — every live request sends a real, billed SMS. |

## Constants (this deployment)

```bash
export CO='https://coolify.vitan.in/api/v1'
export APP='kesk2npohs3vnoroi6tya7x6'          # the pms-api.vitan.in application
export API='https://pms-api.vitan.in'
export COOLIFY_TOKEN='<paste>'                 # from the human
```

---

## Steps

### 1. Preflight — confirm it's currently STUB
```bash
bash scripts/validate-live.sh    # expect: OTP : STUB (live:false, devCode:…)
```
If it already says `OTP : LIVE`, stop — nothing to do.

### 2. Set the env vars (create new; PATCH only if updating an existing key)
`MSG91_TEMPLATE_ID` and `MSG91_SENDER_ID` are new → create with POST. (`MSG91_AUTH_KEY` already exists; only touch it if it changed, using `PATCH $CO/applications/$APP/envs` with `{"key":"MSG91_AUTH_KEY","value":"…"}`.)
```bash
setenv() {  # create a new env var
  curl -sS -X POST "$CO/applications/$APP/envs" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"key\":\"$1\",\"value\":\"$2\",\"is_preview\":false,\"is_literal\":true}"
  echo " <= $1"
}
setenv MSG91_TEMPLATE_ID '<the-msg91-template-id>'
setenv MSG91_SENDER_ID   '<the-6char-header>'
```
> The single-create endpoint accepts only `key,value,is_preview,is_literal` (it **rejects** `is_build_time`). Marking the value "secret/hidden" is a dashboard-only toggle the API can't set — flag it for the human (cosmetic).

### 3. Redeploy (runtime var → `force=false`, fast) and capture the deployment id
```bash
DU=$(curl -sS -G "$CO/deploy" --data-urlencode "uuid=$APP" --data-urlencode "force=false" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['deployments'][0]['deployment_uuid'])")
echo "deployment_uuid=$DU"
```

### 4. Wait for the deploy to finish (poll status; ~1–3 min)
```bash
for i in $(seq 1 28); do
  st=$(curl -sS "$CO/deployments/$DU" -H "Authorization: Bearer $COOLIFY_TOKEN" \
       | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))")
  echo "status=$st"; case "$st" in finished|success) break;; failed|error|cancelled*) echo FAILED; break;; esac; sleep 15
done
```

### 5. (If not already done) confirm the API's real outbound IP for MSG91 whitelisting
```bash
# Ask the human to run this on the API host (Coolify → Terminal) and whitelist the result in MSG91:
#   curl -s ifconfig.me ; echo
```

### 6. Validate the live send (agent-doable) — read the BODY, not just the status code
```bash
curl -sS -X POST "$API/auth/otp/request" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\",\"projectId\":\"ambli\"}"
```
- **SUCCESS (LIVE):** `{"sent":true,"live":true}` — `live:true`, **no** `devCode`. A real SMS is on its way. ✅ Cutover done.
- **Still STUB:** `{"sent":true,"live":false,"devCode":"…"}` — the gate is false. Recheck that BOTH `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` are non-empty on the app and that the redeploy finished. (POST returns HTTP **201** in both cases — do not gate on status code.)
- **`503`:** MSG91 rejected the send — bad auth key, template mismatch, sender not DLT-approved, or IP not whitelisted. Report the body.

### 7. Complete verify — HUMAN-ONLY
The agent cannot read the SMS. The human reads the 4-digit code, then:
```bash
curl -sS -X POST "$API/auth/otp/verify" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\",\"code\":\"<code-from-sms>\",\"projectId\":\"ambli\"}"
# expect HTTP 201: {"token":"…","role":"engineer","projectId":"ambli","name":"Site Engineer"}
```

---

## Success criteria
- `bash scripts/validate-live.sh` (with a real number) shows `OTP : LIVE`, **and**
- an SMS arrives, **and** step 7 returns a 201 engineer token.

## Rollback (instant, safe)
```bash
curl -sS -X PATCH "$CO/applications/$APP/envs" -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' -d '{"key":"MSG91_TEMPLATE_ID","value":""}'
curl -sS -G "$CO/deploy" --data-urlencode "uuid=$APP" --data-urlencode "force=false" -H "Authorization: Bearer $COOLIFY_TOKEN"
```
Blanking `MSG91_TEMPLATE_ID` + redeploy drops OTP back to the dev-stub with no code change.

## Autonomy boundary
- **Agent (with `COOLIFY_TOKEN` + the MSG91 values):** steps 1–4, 6 — sets env, redeploys, and confirms the server *accepted* a live send (`live:true`). Fully autonomous.
- **Human-only:** the DLT chain, the MSG91 account/keys, IP whitelisting (step 5), and reading the SMS to complete verify (step 7).

## Safety
- Every live `/auth/otp/request` sends a **real, billed** SMS and is rate-limited — use only a controlled `TEST_PHONE`, never the sample number.
- Then **rotate `COOLIFY_TOKEN`** if it was shared in plaintext.
