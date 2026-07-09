# Vitan PMC — Dev-Auth Lockdown

How the passwordless **"Viewing as" persona switch** (dev auth) is gated, and how to
flip the live app from open **demo mode** to **locked-down real-auth-only**.

Dev auth is the endpoint `POST /auth/session {role}` → a full scoped JWT for that
persona, with no credentials. It's exactly what the demo persona switcher uses. In
production it's an open door: anyone who POSTs `{"role":"pmc"}` gets a PMC token.

This change makes dev auth **secure by default** and adds the frontend machinery to
run the app as a real authenticated product. It is a *mechanism* — the live switch is
two env vars, documented below, so it can be flipped the moment every role has a
working real sign-in.

---

## The two flags (must agree)

| Layer | Env var | Where | Effect when **not** `true` |
|---|---|---|---|
| **API** | `ALLOW_DEV_AUTH` | API app (`pms-api.vitan.in`) runtime | `POST /auth/session` → **403** |
| **Web** | `VITE_ALLOW_DEV_AUTH` | Web app (`pms.vitan.in`) **build-time** | persona switcher hidden; the shell is gated behind the sign-in screen; no auto dev-connect |

Both are **secure by default**: dev auth is ON only when the value is exactly the
string `"true"`. Unset, `"false"`, `"1"`, `"TRUE"` → all OFF.

Web-only nuance: with **no** API configured (`VITE_API_URL` unset — the pure local
`pnpm dev` demo), there's no backend to authenticate against and local sign-in never
mints a token, so `DEV_AUTH` stays **on** regardless — the seeded demo keeps working.
The gate only ever engages on a real deployment (`VITE_API_URL` set).

---

## Current state (2026-07-06)

The code is **secure by default**. To keep the live app working as a demo until every
role has a real sign-in, both apps are **explicitly opted in**:

- API app: `ALLOW_DEV_AUTH=true`
- Web app: `VITE_ALLOW_DEV_AUTH=true`

So today the deployed app behaves exactly as before (persona switcher, dev auth) — but
now that behavior is *opt-in*, not the default. **Removing the two vars = lockdown.**

### Blocker before flipping to locked

Verified on prod: a hard lockdown right now would lock out **PMC / client / contractor**,
because only the engineer path has a working real sign-in:

| Role sign-in | Path | Status |
|---|---|---|
| Engineer | phone OTP → provisioned engineer | ✅ works (Telegram Gateway is live) |
| PMC / client / contractor | email + password | ❌ `POST /auth/login` → 401 (demo accounts **not seeded** on the live DB) |
| PMC / client / contractor | email OTP | 🟡 needs an account (invite-only, below) **and** SMTP; with no SMTP the code is shown on-screen (stub) — not a real gate |
| PMC / client / contractor | Google sign-in | ⏳ needs an account (invite-only) + `GOOGLE_CLIENT_ID` |

So finish **one** of these first, then flip:

1. **Create the office accounts** on the live DB — run the non-destructive
   `pnpm --filter api ensure-accounts` (upserts `pmc@ / client@ / contractor@vitan.in`
   with `SEED_DEMO_PASSWORD`; **safe on prod** — unlike `seed.ts`, it wipes nothing).
   Password login then works; **or**
2. **Configure Zoho SMTP** (`SMTP_HOST/PORT/SECURE/USER/PASS/FROM`) so email OTP delivers
   a real code — combined with the accounts from (1) this is a real gate; **or**
3. **Enable Google sign-in** (`GOOGLE_CLIENT_ID` + `VITE_GOOGLE_CLIENT_ID`) — again against
   the accounts from (1).

### Self-signup trust model (`AUTH_ALLOW_SIGNUP`)

The office channels (**email OTP** and **Google**) are **invite-only by default**: an
unknown identity with no matching account is **rejected** (`401` "ask your PMC to add
you"), so a stranger can't mint a writable engineer account and hollow out the lockdown.
Create accounts with `ensure-accounts` (above). Set `AUTH_ALLOW_SIGNUP=true` to restore
open self-provisioning (unknown email/Google → a new engineer). **Phone OTP always
provisions engineers** regardless — a phone is the on-site engineer-onboarding signal.

---

## Activate the lockdown (once a role's sign-in works)

Env-only, no code change. On the Coolify instance (`https://coolify.vitan.in/api/v1`,
API app uuid `kesk2npohs3vnoroi6tya7x6`):

0. **Pre-flight (don't skip)** — confirm a real office sign-in already works, so the
   flip can't lock everyone out:
   ```
   ADMIN_PASSWORD='<office password>' bash scripts/lockdown-check.sh
   ```
   Exit 0 / **✓ SAFE TO LOCK DOWN** means `pmc@vitan.in` signs in with email+password.
   Anything else → seed accounts first (`pnpm --filter api ensure-accounts`) and do **not** flip.
1. **API** — set `ALLOW_DEV_AUTH=false` (or delete it) and redeploy the API app.
   Verify: `curl -s -o /dev/null -w '%{http_code}' -X POST https://pms-api.vitan.in/auth/session -H 'content-type: application/json' -d '{"role":"pmc","projectId":"ambli"}'` → **403**.
2. **Web** — set `VITE_ALLOW_DEV_AUTH=false` (or delete it) and redeploy the web app
   (build-time var → a rebuild is required). Verify: visit `pms.vitan.in` → the sign-in
   screen ("Who are you?") is shown, no "Viewing as" switcher.
3. **Post-flip verify** — confirm dev auth is off *and* the office admin can still get in:
   ```
   ADMIN_PASSWORD='<office password>' bash scripts/lockdown-check.sh --verify
   ```
   Exit 0 / **✓ LOCKED & SAFE**. A **✗ LOCKOUT RISK** here means real sign-in broke —
   re-open (`ALLOW_DEV_AUTH=true`) immediately and fix accounts before retrying.

To roll back to demo mode: set both to `true` and redeploy.

---

## Production hardening (recommended env on the API app)

The production image sets `NODE_ENV=production`, which turns on auth hardening
(`apps/api/src/config.ts`). These **degrade safely** if unset — the API logs a loud
warning and uses a secure fallback rather than crashing — but set them for full
hardening:

| Env | When set | If unset in prod (fail-soft) |
|---|---|---|
| `JWT_SECRET` | Token signing secret (long random; rotatable). | Warns + derives a **stable, non-public** secret from `DATABASE_URL`. Sessions reset if the DB URL changes — so set this explicitly. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API (e.g. `https://pms.vitan.in`); no wildcard. | Warns + **reflects the request origin** (functional; the API is bearer-token based). |
| `AUTH_ALLOW_PHONE_SIGNUP` | `true` enables on-site phone onboarding. | Default **off**: an unknown phone is rejected instead of auto-provisioning a site engineer. |

Dev auth stays off unless `ALLOW_DEV_AUTH=true` (above); the office email/Google
channels stay invite-only unless `AUTH_ALLOW_SIGNUP=true`.

---

## What the code does

- **`apps/api/src/auth/auth.controller.ts`** — `/auth/session` throws `ForbiddenException`
  unless `ALLOW_DEV_AUTH === 'true'`.
- **`apps/web/src/data/apiGateway.ts`** — exports `DEV_AUTH` (the web flag, with the
  no-API fallback above).
- **`apps/web/src/data/useApiSync.ts`** — injects the gateway **always** (so the sign-in
  screen can call the public `/auth/*` endpoints even before a session); only auto
  dev-connects when `DEV_AUTH`.
- **`apps/web/src/layout/AppShell.tsx` + `AuthGate.tsx`** — when `!DEV_AUTH && !sessionToken`,
  renders the full-screen sign-in gate instead of the console.
- **`LeftRail.tsx` / `TopBar.tsx`** — persona switcher shown only when `DEV_AUTH`;
  otherwise a "Signed in as … / Sign out" control (store action `signOut`).
