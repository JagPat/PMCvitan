# Vitan PMC — Going Live (real sign-in + dev-auth lockdown)

Everything below is **ops + credentials only** — the auth mechanism (email+password,
email-OTP, Google, phone-OTP via Telegram) is fully built, tested, and deployed. Going
live means: make a real sign-in work for the office roles, then turn **off** the
passwordless dev-auth persona switcher. See [`AUTH_LOCKDOWN.md`](./AUTH_LOCKDOWN.md) for how
the switch works and [`ORGS.md`](./ORGS.md) for accounts/memberships.

> **Lockout guard.** Never flip `ALLOW_DEV_AUTH=false` before a real sign-in works on
> prod — otherwise no one can get in. The steps below make real sign-in work *first*.
> Automate the guard: `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh` must print
> **✓ SAFE TO LOCK DOWN** before you flip, and `… --verify` must print **✓ LOCKED & SAFE**
> after. See [`AUTH_LOCKDOWN.md`](./AUTH_LOCKDOWN.md#activate-the-lockdown-once-a-roles-sign-in-works).

## Recommended: email + password (no external service)

The simplest way to go live. Office accounts (`pmc@ / client@ / contractor@vitan.in`) get a
password; everyone signs in on the email+password screen.

1. **Seed the office accounts on prod** — pick one:
   - **Automatic (turnkey):** set `AUTO_ENSURE_ACCOUNTS=true` and `SEED_DEMO_PASSWORD=<a strong password>` on the **API** app in Coolify, then redeploy. Boot runs the non-destructive `ensure-accounts` (idempotent; never clobbers an existing password unless you change `SEED_DEMO_PASSWORD`). Unset `AUTO_ENSURE_ACCOUNTS` again once seeded if you prefer.
   - **Manual (one-off):** in the API container shell — `SEED_DEMO_PASSWORD=<pw> pnpm --filter api ensure-accounts`.
   - Custom roster: set `ACCOUNTS_JSON='[{"role":"pmc","name":"Ar. Vitan","email":"pmc@vitan.in"}, …]'`.
2. **Verify** you can sign in at the deployed web app with `pmc@vitan.in` + the password (dev-auth is still on, so you can compare against the persona switch). Or check it from the shell: `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh` → **✓ SAFE TO LOCK DOWN**.
3. **Lock down** — on the **API** app set `ALLOW_DEV_AUTH=false`; on the **web** app set `VITE_ALLOW_DEV_AUTH=false`; redeploy both. The persona switcher disappears and the app is gated behind the sign-in screen. Confirm: `ADMIN_PASSWORD='<pw>' bash scripts/lockdown-check.sh --verify` → **✓ LOCKED & SAFE**.

Rollback: set both flags back to `true` (or unset) and redeploy — the persona switcher returns immediately.

## Alternative channels (need a credential)

- **Email OTP (Zoho):** set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` on the API (a Zoho **app password**, not the mailbox password). Users then get a code by email — no password to manage. Invite-only unless `AUTH_ALLOW_SIGNUP=true`, so seed the accounts (step 1) first. Then lock down (step 3).
- **Google sign-in:** create an OAuth **Web** client (Google Cloud console), add the web origin to its authorized origins, and set `VITE_GOOGLE_CLIENT_ID` on the web app. The Google button renders automatically. Same invite-only rule — seed the accounts first. Then lock down.
- **Phone OTP (Telegram, engineers):** already live via the Telegram Gateway; a phone sign-in provisions a site-engineer account. (Free-test delivery is limited to the registered number until the Gateway is fully provisioned.)

## After go-live — security hygiene

- **Rotate the Coolify API token** (Coolify → Settings → API tokens) — the one used this session was shared in plaintext.
- **Revoke + reissue the Telegram bot token** in BotFather (`/revoke`), then update `TELEGRAM_BOT_TOKEN` on the API.
- Keep all secrets in Coolify env vars — never commit them.
