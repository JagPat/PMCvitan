# Phase 0 Review Packet

Evidence package for the independent (Codex) review of the Phase 0 trust foundation
([plan](../superpowers/plans/2026-07-12-phase-0-trust-foundation.md) ·
[spec](../superpowers/specs/2026-07-12-modular-construction-control-platform-design.md)).
All commands were run on 2026-07-12 against this branch; timestamps are UTC.

## Revisions

- Base revision (`git merge-base origin/main HEAD`): `75101583428da2da60a9b2840875e02f1d0bb557` (merge of PR #87)
- Head revision: the commit `test: prove phase zero project isolation` on branch `claude/vitan-pmc-design-epa2rp` — it is the head SHA of the Task 8 PR (a file cannot embed its own commit hash; take it from `git rev-parse HEAD` / the PR page)
- PRs/commits by task:
  1. Task 1 — [PR #81](https://github.com/JagPat/PMCvitan/pull/81) · `ab7969a` docs: install phase zero execution guardrails
  2. Task 2 — [PR #82](https://github.com/JagPat/PMCvitan/pull/82) · `8a0fa6b` fix: make project scope transitions atomic
  3. Task 3 — [PR #83](https://github.com/JagPat/PMCvitan/pull/83) · `96133a9` fix: guard project routes and async responses
  4. Task 4 — [PR #84](https://github.com/JagPat/PMCvitan/pull/84) · `bf721a2` security: enforce live project access
  5. Task 5 — [PR #85](https://github.com/JagPat/PMCvitan/pull/85) · `f445995` security: enforce project-owned references
  6. Task 6 — [PR #86](https://github.com/JagPat/PMCvitan/pull/86) · `5be3cdb` refactor: establish real project dates
  7. Task 7 — [PR #87](https://github.com/JagPat/PMCvitan/pull/87) · `25406a3` fix: make api mode reflect only live project data
  8. Task 8 — this PR · `test: prove phase zero project isolation`

## Vision Alignment

- User decisions improved:
  - the **PMC** switching between sites always operates on exactly one project's records — a decision issued, an inspection reviewed or a member removed lands on the site on screen, never a stale one (Tasks 2, 3);
  - the **client** approving a decision sees only their own project's facts — a blank project shows honest absence, never Ambli sample photos, fixed counts or a fake "report generated" success (Task 7);
  - the **site engineer** records attendance, materials and progress against real calendar days in the site's time zone — "latest daily log" is chosen by the civil day, correct across month/year boundaries (Task 6);
  - a **removed team member** loses access on their very next request, not at token expiry (Task 4).
- Canonical fact owners: the `Project` row owns identity and the schedule anchor (`scheduleStartDate`); each operational record (`Decision`, `Activity`, `Inspection`, `DailyLog`, `Drawing`, `Media`) is owned by exactly one project via `projectId`; the civil-date DATE columns are the canonical dates and legacy display strings/int offsets are derived compatibility artifacts; `Membership` (+ org role) is the canonical access grant, re-checked live per request.
- Information flows protected: server snapshot → store (generation-guarded, never a stale project's reply); decision status → activity Decision gate (derived live, never stored); membership change → next-request authorization (live re-check); URL ↔ store (an actual URL change is a navigation request; a store-initiated switch rewrites the stale URL — no ping-pong, proven by `history preserves scope and screen`).
- Human approvals preserved: client consent stays an attributable decision approval (`Decision.approver` + `DecisionEvent`, untouched by Phase 0); technical acceptance stays the PMC's inspection decide; certification/payment authority is not modelled yet — Phase 0 introduced no surrogate for any human approval.

## Schema and Migration Evidence

- Migrations (Phase 0):
  - `20260902000000_phase0_project_integrity/migration.sql` — sha256 `bf2b7b9362442892…`
  - `20260903000000_phase0_real_dates/migration.sql` — sha256 `da19c04b8305d91a…`
- Diagnostic query output (seeded acceptance DB `pmcvitan_e2e`, 2026-07-12T22:13Z):

  ```text
  cross-project Media.decisionId: 0
  cross-project Drawing.activityId: 0
  cross-project Activity.decisionId: 0
  unparseable Project.projStart: 0
  unparseable DailyLog.date: 0
  ```

- Fresh-database result: `prisma migrate deploy` onto empty `pmcvitan_e2e` — all 20 migrations applied, exit 0 (2026-07-12, local; the same runs green in the CI `api` and `api-e2e` jobs).
- Existing-data-copy result (Task 6, 2026-07-12): all migrations except `real_dates` applied, legacy-shape demo rows inserted via SQL, then `prisma migrate deploy` — exit 0 with every backfill asserted (ambli anchor `2026-06-01`, ACT-31 `2026-07-05→2026-07-12`, `logDate 2026-07-03`, loose inspection dates left NULL). Corrupt-copy refusal: a project with `projStart='July 3rd, 2026'` aborts deploy with `phase0_real_dates: 1 Project.projStart value(s) unparseable — fix by hand before migrating` (non-zero exit).
- Rollback boundary: restore the prior application build and keep the additive schema; constraints are never auto-reverted after dependent writes — repairs are operator-reviewed forward migrations. Frontend Tasks 2/3/7 roll back as one compatible group. (Documented in `docs/DEPLOY.md` → "Phase 0 release runbook".)

## Security and Tenancy Evidence

- Removed membership: integration `live project access (integration) › rejects a previously issued token after membership removal` + acceptance `removed membership revokes token` (same unexpired JWT: 200 before removal → 403 after; re-login 401) — both pass.
- Archived project: integration `live project access (integration) › rejects access to an archived project` — passes.
- Cross-project route: integration `live project access (integration) › tenant isolation: a project-B member's token cannot read project A (and vice versa)` + acceptance `non-member is forbidden` (API `GET /projects/test-empty-site/snapshot` → 403, `POST /auth/switch` → 403; UI never offers or requests Project B) — both pass.
- Cross-project reference: integration `project reference integrity (database constraints) › PostgreSQL rejects a drawing in project B pointing at project A records (P2003)` (+ the media variant, the same-project control, and `deleting an activity unlinks referencing drawings`) + acceptance `cross-project reference is rejected` (a Project B drawing naming Project A's `ACT-31` → 400, no row created) — all pass.
- Org owner path: integration `live project access (integration) › allows an org owner to operate an active project in the same org as pmc (no membership row)` — passes.

## Verification

- `pnpm check` — 2026-07-12T22:12:02Z, exit 0: web lint + typecheck + **163** unit tests + build; api generate + typecheck + **278** unit tests + build.
- `pnpm --filter api test:integration` — 2026-07-12T22:13:13Z, exit 0: **13/13** on PostgreSQL 16 (`pmcvitan_test`).
- `pnpm test:e2e:api` — 2026-07-12T22:13:34Z, exit 0: **8/8** scenarios (`project-scope.spec.ts`) against the compiled API + seeded PostgreSQL (`pmcvitan_e2e`), 17.1s.
- `git diff --check` — clean (no whitespace errors).
- CI run URL: the `web`, `e2e`, `api` and new `api-e2e` checks on the Task 8 PR (link on the PR page once CI completes; all four are required evidence for the Phase 0 gate).

## Known Residual Risks

| Risk | Owner | Follow-up |
|---|---|---|
| The web session token is memory-only: a refresh returns to the sign-in gate (deep links survive re-auth, proven by `deep link survives token switch`). Deliberate for Phase 0; session persistence is a product decision. | PMCvitan maintainer | Evaluate refresh-token/session persistence in a later phase |
| The seeded demo password (`vitan123` default) also protects the `test-*` fixture users; the seed is dev/test-only and must never run against production (runner refuses without an explicit `DATABASE_URL`). | PMCvitan maintainer | Rotate/disable demo credentials before any shared staging environment |
| `apps/api` `start:dev` (tsx watch) cannot boot Nest DI (decorator metadata); dev serving uses the compiled `node dist/main.js` (as the acceptance harness does). | PMCvitan maintainer | Fix or replace the `start:dev` script in a later housekeeping change |
