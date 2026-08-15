# PR #338 — convergence audit (Cloud Agent development environment)

Owed at the second finding-bearing head. Infra-only diff: four files (`.cursor/environment.json`,
three shell scripts). No domain schema, no migrations, no module boundaries.

| head | role | findings | outcome |
|---|---|---|---|
| `a293a93` | initial environment + install/start scripts | 8 (4 P1, 4 P2) | corrected on `df236aa` |
| `df236aa` | round-1 batch (seed sentinel, CORS, DATABASE_URL sync, psql path, Playwright deps) | 4 (1 P1, 3 P2) | corrected on `09c6bb3` |
| `09c6bb3` | round-2 batch (`cloud-agent-env.sh`, seed gating, safe .env writes, masked errors) | GATE: `convergence_required` | this head |

Round 1's review was delivered twice against the same SHA (timeout retry) — one head, two
deliveries, counted once.

## Round 1 — three consumers of one connection string, checked one at a time

Eight findings, and the pattern is uniform: the environment has **install** (build artifacts),
**start** (migrate/seed/bootstrap), and **runtime terminals** (API + web), each touching
`DATABASE_URL` and `apps/api/.env` independently. Each finding is a place where one consumer
was aligned while another was not.

- **Seed sentinel used schema, not data** — `to_regclass('Project')` is true after the first
  migration with zero rows; the demo project `ambli` is now the sentinel (`SEED_PROJECT_ID`).
- **CORS copied from `.env.example`** — production origins blocked localhost preview; generated
  dev `.env` sets `CORS_ORIGINS=""` (Nest allows localhost when empty).
- **Prisma generate before `.env`** — install runs `ensure_api_env` (writes `DATABASE_URL` and
  exports it) before `prisma:generate`.
- **Postgres assumed present** — start bootstraps local `vitan`/`vitan_pmc` only on the default
  disposable URL; external URLs connect via `psql` with no host-cluster role creation.
- **API terminal clobbered Cursor secrets** — terminal preserves `PRE_DB` from the environment
  after sourcing `.env`; start syncs the resolved URL into `.env` via `set_env_var`.
- **Playwright without OS deps** — install uses `playwright install --with-deps chromium` (CI parity).
- **Role checks via Unix socket** — local bootstrap runs only when `DATABASE_URL` equals the
  default; external TCP/Cloud SQL URLs skip `sudo -u postgres` entirely.
- **Compiled API vs `start:dev`** — **accepted residual**: Nest decorator metadata is unreliable
  under `tsx watch` in this monorepo; the environment matches `playwright.api.config.ts` and CI
  e2e (compiled `dist/main.js`). Agents editing API code must rebuild (`pnpm --filter api build`)
  or re-run install — documented here, not probed, because hot-reload would trade one failure mode
  for the documented CI/e2e mismatch.

## Round 2 — destructive operations and string mechanics

Four findings on the round-1 head, one level deeper: **borrowed machinery's own contracts**.

- **Destructive seed on external DB** — `seed.ts` TRUNCATEs the whole repository; seed now runs
  only on the default local URL or with explicit `CLOUD_AGENT_ALLOW_SEED=true`.
- **psql URL mangling** — `psql_database_url` strips only Prisma's `schema=` query param;
  `sslmode`, socket `host=`, and other libpq options survive.
- **sed `&` corruption in `.env`** — `set_env_var` uses Python line replacement, not `sed`.
- **Credentials in error output** — unreachable-DB errors log `database_url_log_label` (host/port/db)
  instead of the full URI.

Shared helpers moved to `scripts/cloud-agent-env.sh` so install and start cannot drift.

## The rule this audit adds

Round 1's failure: wiring one lifecycle phase without enumerating every other reader of the same
value. Round 2's failure: **reusing an existing script pattern (copy `.env.example`, `sed`, table
existence, unconditional seed) borrows its entire contract** — including destructive side effects
and string-escape semantics. For environment bootstrap, enumerate every phase that reads or writes
each secret/config key before shipping.

## Finding → remedy → regression surface

| finding | root cause | remedy | regression |
|---|---|---|---|
| schema-level seed skip | migration creates empty `Project` table | `ambli` row sentinel | manual start on fresh DB |
| CORS blocks preview | `.env.example` production origins | `CORS_ORIGINS=""` in `ensure_api_env` | browser `auth/session` preflight |
| prisma generate fails clean | no `.env` at install time | `ensure_api_env` before generate | `cloud-agent-install.sh` on clean clone |
| Postgres missing | no install provision step | local bootstrap in start; env build installs PG | fresh Ubuntu VM |
| terminal DB mismatch | `.env` overwrote secret | `PRE_DB` preservation in `environment.json` | Cursor secret `DATABASE_URL` |
| Playwright launch fail | browser only, no libs | `--with-deps chromium` | `core-loop` e2e |
| socket vs TCP role check | `sudo postgres psql` not on service URL | gate local bootstrap to default URL only | compose/external Postgres |
| seed wipes staging | unconditional seed | `seed_permitted` + opt-in flag | external DB startup |
| psql SSL dropped | naive `?` truncation | Python URL parse, strip `schema` only | Cloud SQL / SSL URLs |
| empty-host URI broken | `urlunsplit` drops `//` netloc | emit `postgresql:///dbname?...` form | Cloud SQL socket URLs |
| dev auth on external DB | `ensure_api_env` always wrote dev JWT/ALLOW_DEV_AUTH | dev defaults only on default local URL; external requires `JWT_SECRET` | staging token forgery |
| psql schema mismatch | stripped `schema=` without `search_path` | `psql_tc` sets `search_path` from Prisma param | non-public schema sentinel |
| partial seed skip | early `ambli` row before seed finishes | sentinel `test-drawing-a` (late seed row) | interrupted seed restart |
| `.env` corruption | `sed` `&` metacharacter | Python `set_env_var` | multi-param `DATABASE_URL` |
| secret in logs | full URL in `echo` | `database_url_log_label` | failed external connect |
| compiled API stale | `start` not `start:dev` | **documented** trade-off; matches CI e2e | API source edits need rebuild |

## Remaining risk (honest)

- **Compiled API**: backend edits are not hot-reloaded; this is intentional alignment with CI.
  Re-run `pnpm --filter api build` or the install script after API changes.
- **Postgres on fresh images**: relies on the environment build installing PostgreSQL 16 (validated
  on the draft build `bld-20260814-…`); images without PG still fail at start with a clear message.
- **Round-1 P1 on install line 16** (create `.env` before generate): **CLOSED** on `09c6bb3` —
  `ensure_api_env` precedes `prisma:generate`; verified on clean clone without pre-existing `.env`.

## Status

Thirteen distinct findings across three finding-bearing heads (8 + 4 + 1 post-convergence), plus
round 5 on head `d296fea` (auth safeguards, Prisma schema/search_path, seed-completion sentinel).
All findings are corrected in the scripts; the compiled-API choice remains a documented trade-off.

Review-Convergence: complete
