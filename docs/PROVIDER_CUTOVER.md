# Vitan PMC — Provider Cutover & Live Validation Runbook

How to flip each external provider from its **dev-stub** to **live**, and validate it against the deployed app. Written so a Claude Code (web) session can execute the agent-doable parts autonomously, with the human-only prerequisites called out explicitly.

Every provider is **env-gated** — no code change or image rebuild is needed to cut over, only environment variables + a redeploy. All three are **API-app runtime vars** (they do **not** touch the web app / `VITE_API_URL`).

- **API app:** `pms-api.vitan.in` · Coolify app uuid `kesk2npohs3vnoroi6tya7x6`
- **Web app:** `pms.vitan.in`
- **Coolify API:** `https://coolify.vitan.in/api/v1`
- **Project id:** `ambli`

> **Facts here are grounded in the code** (`apps/api/src/**`) and verified against the live deployment. POST endpoints return **HTTP 201** (no `@HttpCode` override anywhere).

---

## Current live state (2026-07-04)

| Provider | Gate (both/all required) | State |
|---|---|---|
| **Web push (VAPID)** | `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | ✅ **LIVE** — `/push/public-key` returns the key |
| **Media (S3/R2)** | `S3_ENDPOINT` + `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | 🟡 **DB dev-stub** — bytes in Postgres, served from `/media/:id` |
| **SMS OTP (MSG91)** | `MSG91_AUTH_KEY` + `MSG91_TEMPLATE_ID` | 🟡 **dev-stub** — `AUTH_KEY` set, `TEMPLATE_ID` missing (blocked on DLT) |

`GET /projects/ambli/snapshot` is live (200) and includes `dailyLog.photos` — the 7c-media snapshot field is deployed.

---

## Autonomy model — what an agent can do

| Access the agent has | What it can do |
|---|---|
| **(a) No credentials** | Only READ prod: run the [validation script](#validation-script) to report each provider's stub/live state. Cannot flip anything. |
| **(b) Coolify API token only** | Resolve the app uuid, set/replace env vars, and redeploy — but with no correct values it can only perform the **rollback** (blank the gating vars + redeploy) and re-run read-side validation. Cannot mark a var "secret" (UI-only) or read boot logs (no logs endpoint in the API). |
| **(c) Coolify token + provider values** | Full env-set + redeploy + read-side validation, autonomously. **VAPID and R2 are fully agent-verifiable end-to-end.** MSG91's true end-to-end proof (an SMS arriving) and VAPID's (a notification arriving) are **human-only** — the agent can only confirm the server *accepted* the send / serves the key. |

**Human-only prerequisites no agent can produce:** the DLT registration + MSG91 account/keys, the Cloudflare account + R2 bucket + API token, and a real browser granting notification permission.

---

## Coolify API mechanics (verified on this instance)

Pass the token whole (`<id>|<secret>`). **Never commit it.** Export it:

```bash
export COOLIFY_TOKEN='<paste the Coolify API token>'
export CO='https://coolify.vitan.in/api/v1'
export APP='kesk2npohs3vnoroi6tya7x6'      # the pms-api.vitan.in application
```

**List applications** (resolve the uuid if it ever changes):
```bash
curl -sS "$CO/applications" -H "Authorization: Bearer $COOLIFY_TOKEN" \
  | python3 -c "import sys,json;[print(a['uuid'],a['name'],a['fqdn']) for a in json.load(sys.stdin)]"
```

**Create an env var** — the single-create endpoint accepts **`key,value,is_preview,is_literal`** only (this instance **rejects `is_build_time`** on create with `"This field is not allowed."`). Always use `is_literal:true` for pasted secrets so Coolify never `$`-interpolates them:
```bash
curl -sS -X POST "$CO/applications/$APP/envs" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"NAME","value":"VALUE","is_preview":false,"is_literal":true}'
# → {"uuid":"..."} on success
```
Use `PATCH …/envs` (flat body `{key,value}`) to update an **existing** key. (A bulk `PATCH …/envs/bulk` with `{"data":[…]}` exists but **before using it on prod, confirm it upserts and does not delete unlisted keys** — the app also holds `DATABASE_URL`/`JWT_SECRET`. Per-var POST/PATCH is the safe default.)

**Redeploy** (runtime-var change → `force=false` is fine and fast; the container is recreated and re-reads `process.env`):
```bash
curl -sS -G "$CO/deploy" --data-urlencode "uuid=$APP" --data-urlencode "force=false" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
# → {"deployments":[{"message":"... deployment queued.","deployment_uuid":"..."}]}
```
Then **poll** `GET https://pms-api.vitan.in/push/public-key` (or the relevant validation) until it flips — a rebuild takes ~1–3 min. Editing a var **without** a redeploy does nothing to the running container.

---

## Provider 1 — Web Push (VAPID) ✅ DONE

Cut over on 2026-07-04 via the Coolify API. Keypair was generated with `npx web-push generate-vapid-keys` (or `web-push.generateVAPIDKeys()`), then set as three env vars + redeploy + verified `/push/public-key` returns the exact public key.

**Env vars (set):**
| Name | Notes |
|---|---|
| `VAPID_PUBLIC_KEY` | base64url, ~87 chars. Must match what the client subscribes with. |
| `VAPID_PRIVATE_KEY` | **secret**, ~43 chars. |
| `VAPID_SUBJECT` | `mailto:jp@vitan.in` — must be a `mailto:` or `https:` URI. |

**Validate:** `curl -sS https://pms-api.vitan.in/push/public-key` → non-empty `{"key":"…"}`.

⚠️ **Crash-loop risk:** `webpush.setVapidDetails()` runs in the `PushService` **constructor**, so a malformed key or a non-`mailto:`/`https:` subject throws **at boot** and takes down the *entire* API (OTP, media, snapshot too), not just push. After any VAPID change, confirm `GET /projects/ambli/snapshot` still returns 200. **Rollback:** blank both VAPID vars (`PATCH …/envs` value `""`) + redeploy.

**Human-only:** actual delivery. A user must visit `pms.vitan.in`, grant notification permission (subscribes via the SW → `POST /projects/ambli/push/subscribe`), then any notification-bearing mutation (approve a decision, decide an inspection, flag a mismatch, complete an activity) fires a real push.

**Note:** the API can set the value but **cannot** flip Coolify's "secret/hidden" flag for `VAPID_PRIVATE_KEY` — that's a dashboard toggle (cosmetic; doesn't affect function).

---

## Provider 2 — Media storage (Cloudflare R2 / S3)

Flips `StorageService` from keeping bytes in Postgres (served from `/media/:id`) to writing them into an S3-compatible bucket (`Media.url` becomes an absolute bucket URL).

**Live gate (code):** all four of `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` non-empty.

### Human steps (Cloudflare — an agent cannot do these)
1. Create a Cloudflare account (if none) and open **R2**. Create a bucket, e.g. `vitan-media`.
2. **R2 → Manage R2 API Tokens → Create API Token**, permission **Object Read & Write** (scope to the bucket). Copy the **Access Key ID** and **Secret Access Key** (shown once).
3. Note the **S3 API endpoint**: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (R2 → bucket → Settings, or the token page).
4. For the app to *display* photos, reads must be public: enable the bucket's **public r2.dev URL** or attach a **custom domain** (e.g. `media.vitan.in`). That public base → `S3_PUBLIC_BASE`. Without it, uploads succeed but `<img>` URLs won't load.

### Env vars
| Name | Example | Notes |
|---|---|---|
| `S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` | R2 S3 API endpoint. |
| `S3_BUCKET` | `vitan-media` | |
| `S3_ACCESS_KEY_ID` | `…` | **secret.** ⚠️ exact name — *not* `S3_ACCESS_KEY`. |
| `S3_SECRET_ACCESS_KEY` | `…` | **secret.** ⚠️ exact name — *not* `S3_SECRET_KEY`. |
| `S3_REGION` | `auto` | R2 uses `auto`. |
| `S3_PUBLIC_BASE` | `https://pub-….r2.dev` or `https://media.vitan.in` | Read URL base; defaults to `<S3_ENDPOINT>/<S3_BUCKET>` (usually **not** publicly readable) if unset — set it explicitly. |

### Agent cutover (access level c)
Set the six vars via `POST …/envs` (each `is_literal:true`), then `deploy?force=false`, then run the validation below.

### Validation (agent-doable, but see safety note)
```bash
API=https://pms-api.vitan.in
TOK=$(curl -sS -X POST $API/auth/session -H 'Content-Type: application/json' \
      -d '{"role":"pmc","projectId":"ambli"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
# 1x1 png (decodes to 70 bytes)
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
curl -sS -X POST $API/projects/ambli/media -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d "{\"kind\":\"progress\",\"mime\":\"image/png\",\"data\":\"$PNG\"}"
```
- **STUB:** `{"id":"…","url":"/media/…"}` — **relative** URL (DB).
- **LIVE (R2):** `{"id":"…","url":"https://…"}` — **absolute** bucket URL. Then `curl -sSI <that url>` → HTTP 200, `content-type: image/png`. (For the stub, `curl -sSI $API/media/<id>` → 200, `content-length: 70`.)

**Failure modes:** wrong endpoint/region → send fails; token lacks write → 403; `S3_PUBLIC_BASE` unset/private → uploads OK but images 403 in the UI; wrong var names (`S3_ACCESS_KEY` vs `S3_ACCESS_KEY_ID`) → gate silently stays false, no error.

**Rollback:** blank `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (or all four) + redeploy → back to DB stub.

⚠️ **Prod side effects:** every validation upload writes a durable `media` row under `projectId=ambli, kind=progress`, fires a realtime `changed` (connected clients refetch), and — in **live** mode — puts a real object in the R2 bucket. There is **no DELETE endpoint** (`MediaController` is POST + GET only), so test artifacts are removable **only** via the DB / bucket console. The earlier probe already left `media` id `cmr5rf3160001n33ty72mq2an` in prod. Use a maintenance window or accept the test pixel in the gallery.

---

## Provider 3 — SMS OTP (MSG91)

Flips `SmsService` from the in-memory dev stub (returns the code in `devCode`) to MSG91 v5 (real SMS).

**Live gate (code):** `MSG91_AUTH_KEY` **and** `MSG91_TEMPLATE_ID` both non-empty (trimmed). `MSG91_SENDER_ID` is **optional and NOT part of the gate**. The code calls, with header `authkey: <MSG91_AUTH_KEY>`:
- Send: `POST https://control.msg91.com/api/v5/otp?template_id=<TID>&mobile=<91XXXXXXXXXX>&otp_length=4&otp_expiry=5[&sender=<SENDER_ID>]`
- Verify: `GET https://control.msg91.com/api/v5/otp/verify?otp=<code>&mobile=<mobile>`

The template must therefore be a **4-digit OTP, 5-minute** validity, using the DLT `##OTP##` variable.

### Human steps (the DLT chain is the blocker — days of external approval)
1. **DLT Principal Entity (PE) ID** — register the company on a TRAI DLT portal (Jio/Vilpower/Airtel/Vi) with KYC → 19-digit Entity ID. *Everything below waits on this.*
2. **DLT header (6-char sender)** — register + approval, ~24h to sync → this is `MSG91_SENDER_ID`.
3. **DLT content template** — an OTP/Service template containing `##OTP##`, 4-digit / 5-min → DLT Template ID.
4. **MSG91 account** — map the PE-ID, header, and template inside MSG91 → MSG91 issues its **OTP Template ID** (~24-hex) → `MSG91_TEMPLATE_ID`.
5. **MSG91 Auth Key** — Settings → API/Auth Key → `MSG91_AUTH_KEY` (already set on the app).
6. **Whitelist the server's outbound IP** in MSG91 security. Confirm the *actual* egress IP empirically from the API host (`curl ifconfig.me`) — do not assume — and add it (account for multiple / IPv6).

### Agent cutover (access level c)
Set `MSG91_TEMPLATE_ID` (and optionally `MSG91_SENDER_ID`) via `POST …/envs`; `MSG91_AUTH_KEY` already exists (update with `PATCH …/envs` if it changed). Redeploy `force=false`. Then validate.

### Validation
```bash
API=https://pms-api.vitan.in
curl -sS -X POST $API/auth/otp/request -H 'Content-Type: application/json' \
  -d '{"phone":"<REAL_TEST_NUMBER>","projectId":"ambli"}'
```
- **STUB:** `{"sent":true,"live":false,"devCode":"1234"}` (HTTP 201) — `live:false` + a devCode.
- **LIVE:** `{"sent":true,"live":true}` (HTTP 201) — `live:true`, **no** `devCode`, and a real SMS is sent. Capture the **body** — an HTTP-code-only check can't tell stub from live (both 201). A `503` means MSG91 *rejected* the send (bad key/template/whitelist).

**Human-only:** completing **verify** in live mode — the agent can't read the SMS. `POST /auth/otp/verify {phone,code,projectId}` → 201 `{token,role:"engineer",…}`. ⚠️ Each live `/auth/otp/request` sends a **real, billed** SMS — never use the sample number `9876543210` live; use a controlled handset.

**Failure modes:** sender not DLT-approved / template mismatch / server IP not whitelisted → `503`; `MSG91_TEMPLATE_ID` blank → silently stays stub.

**Rollback:** blank `MSG91_TEMPLATE_ID` + redeploy → back to stub.

---

## Safety & housekeeping

- **`ALLOW_DEV_AUTH` sequencing.** Headless R2 validation needs a JWT, obtained via `POST /auth/session` (dev auth), which is currently **enabled** in prod (a standalone note: this permits passwordless persona switching). If you set `ALLOW_DEV_AUTH=false`, do it **after** R2 validation, or hand the agent a real JWT — otherwise `/auth/session` returns 403 and headless media validation is impossible.
- **Rotate the Coolify API token** after the cutovers if it was shared in plaintext (Coolify → Keys & Tokens → revoke, create a fresh one scoped `write`+`deploy`).
- **Secret flag** on env values is a **dashboard-only** toggle; the API sets values but can't mark them hidden.
- **Test media rows** are irreversible via the API — clean up via the Postgres/R2 console if desired (e.g. the probe's `cmr5rf3160001n33ty72mq2an`).
- **Single-replica assumption:** stub OTP verify keys the code in a per-process `Map`; it only works with one API replica and if the process doesn't restart between request and verify.

## Validation script

`scripts/validate-live.sh` runs all read-side checks and prints a stub/live verdict per provider (no credentials needed; creates one test media row — see the safety note). Run it any time to see current state:

```bash
bash scripts/validate-live.sh
```
