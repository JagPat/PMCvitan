# Vitan PMC — Going Live (real sign-in + dev-auth lockdown)

Everything below is **ops + credentials only** — the auth mechanism (email+password,
email-OTP, Google, phone-OTP via Telegram) is fully built, tested, and deployed. Going
live means: make a real sign-in work for the office roles, then turn **off** the
passwordless dev-auth persona switcher. See [`AUTH_LOCKDOWN.md`](./AUTH_LOCKDOWN.md) for how
the switch works and [`ORGS.md`](./ORGS.md) for accounts/memberships.

> **Lockout guard.** Passwordless dev-auth (`POST /auth/session`) is now **hard-disabled
> whenever `NODE_ENV=production`** — regardless of `ALLOW_DEV_AUTH` (P1-4: it hands out a
> full role token to anyone, so it must never be reachable in prod). The API image sets
> `NODE_ENV=production`, so on prod **real sign-in must work before anyone can get in** —
> there is no persona-switch fallback. Make email+password work first (Step 1 below).
> `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh` should print **✓ SAFE TO LOCK
> DOWN** before you rely on it. See [`AUTH_LOCKDOWN.md`](./AUTH_LOCKDOWN.md#activate-the-lockdown-once-a-roles-sign-in-works).

> **OTP needs a real provider in production.** With `NODE_ENV=production`, the email- and
> phone-OTP endpoints **fail closed (503)** when no SMTP / SMS provider is configured —
> they will NOT return the code in the response (P1-1: doing so would let anyone read a
> known user's code and sign in as them). Email-OTP works once SMTP is set (it is, via
> Zoho); phone-OTP needs MSG91 / Fast2SMS / Telegram before site engineers can use it.
> Until then engineers sign in by email (password or email-OTP).

## Step 0 — recommended production env

The API image runs with `NODE_ENV=production`, which turns on auth hardening. These
**degrade safely** if unset (the API logs a warning and uses a secure fallback — it
will **not** crash), but set them on the **API** app for full hardening:

| Env | Value | If unset (fail-soft) |
|---|---|---|
| `JWT_SECRET` | a long random string (`openssl rand -hex 32`) | Derives a stable secret from `DATABASE_URL` (never the public default). **Setting/changing it invalidates existing sessions** — everyone re-signs-in once. |
| `CORS_ORIGINS` | `https://pms.vitan.in` (comma-separated for more) | Reflects the request origin (functional; bearer-token API). Set to lock down cross-origin. |
| `AUTH_ALLOW_PHONE_SIGNUP` | `true` to keep phone onboarding | Default **off** in prod: an unknown phone is rejected instead of auto-provisioning an engineer. Known numbers always sign in. |
| `WORKER_ENROLL_SECRET` | a secret embedded in the site QR | Unset ⇒ `POST /auth/worker/token` is open (QR onboarding needs no secret). Set it to require the QR's `enrollSecret`, locking worker minting down. Either way the endpoint is rate-limited and rejects unknown/archived projects. |

See [`AUTH_LOCKDOWN.md`](./AUTH_LOCKDOWN.md#production-hardening-recommended-env-on-the-api-app). Then continue below.

## Recommended: email + password (no external service)

The simplest way to go live. Office accounts (`pmc@ / client@ / contractor@vitan.in`) get a
password; everyone signs in on the email+password screen.

1. **Seed the office accounts on prod** — pick one:
   - **Automatic (turnkey):** set `AUTO_ENSURE_ACCOUNTS=true` and `SEED_DEMO_PASSWORD=<a strong password ≥ 10 chars>` on the **API** app in Coolify, then redeploy. Boot runs the **create-only** `ensure-accounts`: it creates the office accounts that are missing (with `SEED_DEMO_PASSWORD`) and leaves every existing account completely untouched — an existing password is **never** reset OR back-filled by a redeploy, and a `removed` team member is never re-activated (P1-5). There is **no default password**: if `SEED_DEMO_PASSWORD` is unset, new office accounts are created *without* a password (they use email-OTP or a deliberate reset) rather than a guessable default. (To set/reset a live password, do it deliberately, not via a deploy.) It also **backfills project memberships** for any pre-membership legacy account (e.g. an engineer who signed in by phone-OTP before this change), so nobody loses access when the legacy auth fallback is retired. Keep it on for the deploy that ships the org-access fix; unset it again afterwards if you prefer.
   - **Manual (one-off):** in the API container shell — `SEED_DEMO_PASSWORD=<pw> pnpm --filter api ensure-accounts`.
   - Custom roster: set `ACCOUNTS_JSON='[{"role":"pmc","name":"Ar. Vitan","email":"pmc@vitan.in"}, …]'`.
2. **Verify** you can sign in at the deployed web app with `pmc@vitan.in` + the password (dev-auth is still on, so you can compare against the persona switch). Or check it from the shell: `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh` → **✓ SAFE TO LOCK DOWN**.
3. **Lock down** — on the **API** app set `ALLOW_DEV_AUTH=false`; on the **web** app set `VITE_ALLOW_DEV_AUTH=false`; redeploy both. The persona switcher disappears and the app is gated behind the sign-in screen. Confirm: `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh --verify` → **✓ LOCKED & SAFE**.

Rollback: set both flags back to `true` (or unset) and redeploy — the persona switcher returns immediately.

## Alternative channels (need a credential)

- **Email OTP (Zoho):** set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` on the API (a Zoho **app password**, not the mailbox password). Users then get a code by email — no password to manage. Invite-only unless `AUTH_ALLOW_SIGNUP=true`, so seed the accounts (step 1) first. Then lock down (step 3).
- **Google sign-in:** create an OAuth **Web** client (Google Cloud console), add the web origin to its authorized origins, and set `VITE_GOOGLE_CLIENT_ID` on the web app. The Google button renders automatically. Same invite-only rule — seed the accounts first. Then lock down.
- **Phone OTP (Fast2SMS — recommended for site staff):** real SMS to any Indian mobile via the **DLT-exempt `otp` route**, so it reaches the whole workforce (no Telegram needed). Sign up at [fast2sms.com](https://fast2sms.com), add credit, copy the **Dev API** key, and set `FAST2SMS_API_KEY` on the API. Takes priority over Telegram automatically; a phone sign-in provisions a site-engineer account. This is the way to make phone sign-in work team-wide.
- **Phone OTP (Telegram, engineers):** live via the Telegram Gateway — but it only reaches users who **have Telegram**, and a free/unactivated Gateway account only texts its own registered number. Use it as a free fallback; prefer Fast2SMS for real coverage.

## After go-live — security hygiene

- **Rotate the Coolify API token** (Coolify → Settings → API tokens) — the one used this session was shared in plaintext.
- **Revoke + reissue the Telegram bot token** in BotFather (`/revoke`), then update `TELEGRAM_BOT_TOKEN` on the API.
- Keep all secrets in Coolify env vars — never commit them.
