# Phase 0 Review Packet

Evidence package for the independent (Codex) review of the Phase 0 trust foundation
([plan](../superpowers/plans/2026-07-12-phase-0-trust-foundation.md) ·
[spec](../superpowers/specs/2026-07-12-modular-construction-control-platform-design.md)).
Baseline commands were run on 2026-07-12; the remediation re-runs on 2026-07-13
(see Verification). Timestamps are UTC.

## Revisions

- Base revision (`git merge-base origin/main HEAD`): `75101583428da2da60a9b2840875e02f1d0bb557` (merge of PR #87)
- Task 8 head: `bc90390f4490844211c856d669e86abc3c85ef59` — merged into `main` as `aa7b12c` ([PR #88](https://github.com/JagPat/PMCvitan/pull/88))
- **Reviewed / effective head**: `main` at `e4d879d7275b505894013f1642a1e38f96c154cc`
  (merge of [PR #95](https://github.com/JagPat/PMCvitan/pull/95)) — the immutable tree
  the round-3 gate reviewed. The one remaining round-3 finding is documentation-only
  and is fixed by the docs-only correction PR this packet revision ships in.
- Remediation PRs — heads and merges recorded separately (a **head** is the reviewed
  branch tip; a **merge** is the immutable merge commit on `main`):

  | PR | Round | Scope | Head | Merge |
  |---|---|---|---|---|
  | [#89](https://github.com/JagPat/PMCvitan/pull/89) | 1 | scope/session pinning (findings 1, 3, 6) | `80fe22d69f448d28cd23bf7fea53aac72ffe7f85` | `988007e85793cd6f1105c984ca984b0d100406c7` |
  | [#90](https://github.com/JagPat/PMCvitan/pull/90) | 1 | live authorization on global routes (finding 2) | `8b8e47ae57615d1b69b6bf69c826389cb66a0c9d` | `4d8fc00f6fa48dd9c5be80a4612940867e816cdc` |
  | [#91](https://github.com/JagPat/PMCvitan/pull/91) | 1 | database tenant constraints (finding 4) | `f1039258face5f821a858783eb6407a897522301` | `8510579f91f1f19a08133e5d4fa0db30a18816f9` |
  | [#92](https://github.com/JagPat/PMCvitan/pull/92) | 1 | canonical dates + evidence (findings 5, 7) | `a1a82961fc91e08515096cdc4c0e95c436719deb` | `5e3b827bf39bf48ce81fb8049fc408c65b8be629` |
  | [#93](https://github.com/JagPat/PMCvitan/pull/93) | 2 | outbox final-replay scope guard (R2 finding 1) | `9c99770dc6bca2f60510d18951e446b039a3a551` | `aefe9b09068b175eee4218a3e1914c6d54cf4ffd` |
  | [#94](https://github.com/JagPat/PMCvitan/pull/94) | 2 | merged-window validation (R2 finding 2) | `9378dc7febcf20ad0134d9cce67d1c51c812f1ef` | `bea314c9fe51467a92c53cc3217974ed6b87e2f5` |
  | [#95](https://github.com/JagPat/PMCvitan/pull/95) | 2 | seed canonical dates + packet refresh (R2 findings 3, 4) | `3dc2ed6408eb8f90231d174f236b969530698693` | `e4d879d7275b505894013f1642a1e38f96c154cc` |
- PRs/commits by task:
  1. Task 1 — [PR #81](https://github.com/JagPat/PMCvitan/pull/81) · `ab7969a` docs: install phase zero execution guardrails
  2. Task 2 — [PR #82](https://github.com/JagPat/PMCvitan/pull/82) · `8a0fa6b` fix: make project scope transitions atomic
  3. Task 3 — [PR #83](https://github.com/JagPat/PMCvitan/pull/83) · `96133a9` fix: guard project routes and async responses
  4. Task 4 — [PR #84](https://github.com/JagPat/PMCvitan/pull/84) · `bf721a2` security: enforce live project access
  5. Task 5 — [PR #85](https://github.com/JagPat/PMCvitan/pull/85) · `f445995` security: enforce project-owned references
  6. Task 6 — [PR #86](https://github.com/JagPat/PMCvitan/pull/86) · `5be3cdb` refactor: establish real project dates
  7. Task 7 — [PR #87](https://github.com/JagPat/PMCvitan/pull/87) · `25406a3` fix: make api mode reflect only live project data
  8. Task 8 — [PR #88](https://github.com/JagPat/PMCvitan/pull/88) · `bc90390` test: prove phase zero project isolation

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
  - `20260902000000_phase0_project_integrity/migration.sql` — sha256 `bf2b7b9362442892946173516d92880b551bbd705b58ef8d6b9d8819ffc1ab09`
  - `20260903000000_phase0_real_dates/migration.sql` — sha256 `da19c04b8305d91ac97f0586bc5303d5bb0f860b210aa3808d0e618a4030fb45`
  - `20260905000000_phase0_tenant_constraints/migration.sql` (remediation round 1) — sha256 `eee06929c7776873eef4324ad0a11b1313b1d223efce99118fa85bb3ca193e74`
- Diagnostic query output (seeded acceptance DB `pmcvitan_e2e`, 2026-07-12T22:13Z):

  ```text
  cross-project Media.decisionId: 0
  cross-project Drawing.activityId: 0
  cross-project Activity.decisionId: 0
  unparseable Project.projStart: 0
  unparseable DailyLog.date: 0
  ```

- Fresh-database result: `prisma migrate deploy` onto empty `pmcvitan_e2e` — all **21** migrations applied (`0_init` through `20260905000000_phase0_tenant_constraints`), exit 0 (re-run 2026-07-13, local; the same runs green in the CI `api` and `api-e2e` jobs).
- Existing-data-copy result (Task 6, 2026-07-12): all migrations except `real_dates` applied, legacy-shape demo rows inserted via SQL, then `prisma migrate deploy` — exit 0 with every backfill asserted (ambli anchor `2026-06-01`, ACT-31 `2026-07-05→2026-07-12`, `logDate 2026-07-03`, loose inspection dates left NULL). Corrupt-copy refusal: a project with `projStart='July 3rd, 2026'` aborts deploy with `phase0_real_dates: 1 Project.projStart value(s) unparseable — fix by hand before migrating` (non-zero exit).
- Rollback boundary: restore the prior application build and keep the additive schema; constraints are never auto-reverted after dependent writes — repairs are operator-reviewed forward migrations. Frontend Tasks 2/3/7 roll back as one compatible group. (Documented in `docs/DEPLOY.md` → "Phase 0 release runbook".)

## Security and Tenancy Evidence

- Removed membership: integration `live project access (integration) › rejects a previously issued token after membership removal` + acceptance `removed membership revokes token` (same unexpired JWT: 200 before removal → 403 after; re-login 401) — both pass.
- Archived project: integration `live project access (integration) › rejects access to an archived project` — passes.
- Cross-project route: integration `live project access (integration) › tenant isolation: a project-B member's token cannot read project A (and vice versa)` + acceptance `non-member is forbidden` (API `GET /projects/test-empty-site/snapshot` → 403, `POST /auth/switch` → 403; UI never offers or requests Project B) — both pass.
- Cross-project reference: integration `project reference integrity (database constraints) › PostgreSQL rejects a drawing in project B pointing at project A records (P2003)` (+ the media variant, the same-project control, and `deleting an activity unlinks referencing drawings`) + acceptance `cross-project reference is rejected` (a Project B drawing naming Project A's `ACT-31` → 400, no row created) — all pass.
- Org owner path: integration `live project access (integration) › allows an org owner to operate an active project in the same org as pmc (no membership row)` — passes.

## Verification

Task 8 baseline (2026-07-12): `pnpm check` exit 0 (web 163 / api 278 unit tests);
integration 13/13; acceptance 8/8; CI green on head `bc90390`
(<https://github.com/JagPat/PMCvitan/actions/runs/29211240865> pull_request,
<https://github.com/JagPat/PMCvitan/actions/runs/29211218437> push).

Post-remediation re-run (2026-07-13, round-2 branch):

- `pnpm check` — exit 0: web lint + typecheck + **170** unit tests + build; api generate + typecheck + **286** unit tests + build.
- `pnpm --filter api test:integration` — exit 0: **20/20** on PostgreSQL 16 (`pmcvitan_test`), including the 4 merged-window probes.
- `pnpm test:e2e:api` — exit 0: **9/9** scenarios (`project-scope.spec.ts` + `canonical-dates.spec.ts`) against the compiled API + freshly migrated/seeded PostgreSQL (`pmcvitan_e2e`), 17.7s.
- `git diff --check` — clean (no whitespace errors).
- CI (all jobs incl. `api-e2e` green on the remediation heads):
  - round 1 head `a1a8296` (PR #92): <https://github.com/JagPat/PMCvitan/actions/runs/29213398781>
  - PR #93 head `9c99770`: <https://github.com/JagPat/PMCvitan/actions/runs/29219617947>; merge `aefe9b0`: <https://github.com/JagPat/PMCvitan/actions/runs/29219971930>
  - PR #94 head `9378dc7`: <https://github.com/JagPat/PMCvitan/actions/runs/29220714291>; merge `bea314c`: <https://github.com/JagPat/PMCvitan/actions/runs/29220773372>
  - PR #95 head `3dc2ed6`: <https://github.com/JagPat/PMCvitan/actions/runs/29221000340>; merge `e4d879d` — the reviewed final `main`: <https://github.com/JagPat/PMCvitan/actions/runs/29221303631>

## Independent Review — Round 1 (Codex) and Remediation

The independent Codex review of PR #88 did **not** clear the gate (7 findings; full
review attached to [PR #88](https://github.com/JagPat/PMCvitan/pull/88#issuecomment-4953051607)).
Every finding was verified against the code and remediated in four focused PRs on
branch `claude/vitan-pmc-design-epa2rp`:

| Findings | Remediation | Proof |
|---|---|---|
| 1 (outbox replay), 3 (unguarded raw-DTO replies), 6 (session identity not in scope) | [PR #89](https://github.com/JagPat/PMCvitan/pull/89), head `80fe22d`, merged `988007e` | `apps/web/tests/scope-identity.test.ts` (6 scenarios, failing-first) |
| 2 (removed member kept global-delete access) | [PR #90](https://github.com/JagPat/PMCvitan/pull/90), head `8b8e47a`, merged `4d8fc00` | `test/integration/global-route-authz.test.ts` (reproduced 200 → fixed 403) |
| 4 (node/phase/material single-column FKs) | [PR #91](https://github.com/JagPat/PMCvitan/pull/91), head `f103925`, merged `8510579` + migration `20260905000000_phase0_tenant_constraints` | `test/integration/tenant-constraints.test.ts` (raw-SQL forgeries rejected; controls pass); corrupt-copy refusal proven |
| 5 (date validation/writes), 7 (evidence gaps) | [PR #92](https://github.com/JagPat/PMCvitan/pull/92), head `a1a8296`, merged `5e3b827` + this packet | contract tests (impossible dates, reversed windows, junk time zones → 400); phases now write real dates |

## Independent Review — Round 2 (Codex) and Remediation

The round-2 review (recorded on [PR #92](https://github.com/JagPat/PMCvitan/pull/92))
verified findings 2, 3, 4 and 6 as corrected but kept Phase 0 **blocked** on four
findings. Each was reproduced first with the review's own probes, then fixed:

| R2 finding | Remediation | Reproduce-first proof |
|---|---|---|
| 1 (P1) — a project switch during the FINAL queued outbox op bypassed the pre-iteration scope check; normal reconciliation replaced and persisted the new project's queue as empty | [PR #93](https://github.com/JagPat/PMCvitan/pull/93), merged `aefe9b0`: `flushOutbox` re-checks (scope, session token) after the loop; any movement persists the remainder under the ORIGINAL scope key and leaves the new scope untouched | `scope-identity.test.ts` › "a switch during the FINAL queued op never clobbers the new scope queue" — red before (B's queue replaced/persisted empty), green after |
| 2 (P1) — mixed ISO/offset creates and partial updates validated each representation separately; the merged window could persist reversed (phase `2026-08-01→2026-06-01` 201; activity same; partial update `2026-08-01→2026-01-01` 200) | [PR #94](https://github.com/JagPat/PMCvitan/pull/94), merged `bea314c`: phase/activity create assert the RESOLVED window, activity update asserts the MERGED result; also fixed a start-only PATCH silently clearing the stored end date (per-edge spreads) | `test/integration/merged-window.test.ts` — the three review probes verbatim vs live PostgreSQL, all red before (reversed windows persisted) and 400-not-persisted after, + an end-date-not-cleared regression |
| 3 (P2) — the seed bypassed canonical dates: fresh migrate+seed left null anchors on both projects, null phase/activity dates, null `logDate` | [PR #95](https://github.com/JagPat/PMCvitan/pull/95), head `3dc2ed6`, merged `e4d879d`: the seed derives civil dates the way the services do (ambli anchor `2026-06-01`, window to `2026-09-30`, phase/activity planned+actual dates, `logDate 2026-07-03`, `inspectionDate` with derived display, anchor on the empty fixture); `ensure-accounts`' demo backfill fills a null anchor create-only and its phase upsert carries dates | `tests/e2e-api/canonical-dates.spec.ts` — reads the seeded snapshots over the real stack; red against the old seed (all fields null, matching the review), green now. Harness note: the suite's 15 real sign-ins hit the login limiter exactly; the harness sets `THROTTLE_DISABLED`, honored only outside production (unit-tested both ways) |
| 4 (P3) — this packet was stale (old head, 20 vs 21 migrations, pre-remediation totals, no immutable remediation SHAs/CI evidence) | [PR #95](https://github.com/JagPat/PMCvitan/pull/95) refreshed the packet; the round-3 review found that refresh still described the pre-merge branch state, so the docs-only correction PR this revision ships in completes it | — |

## Independent Review — Round 3 (Codex)

Round 3 reviewed remote `main` at `e4d879d7275b505894013f1642a1e38f96c154cc` (the
merge of PR #95) in a clean detached worktree — full result recorded on
[PR #95](https://github.com/JagPat/PMCvitan/pull/95#issuecomment-4954456632).
**Verdict: not cleared, documentation-only.** All three round-2 runtime findings
are closed and no P0/P1/P2 code, security, tenancy, date, migration or correctness
defect remains. Independent verification on that head: `pnpm check` (web 170/170,
api 286/286), PostgreSQL integration 20/20, API-backed Playwright 9/9,
final-merge CI all four jobs green; live probes confirmed the outbox final-op
guard, the reversed/partial merged-window rejections (with the valid start-only
PATCH preserving its end date), the canonical seed dates, immediate token
invalidation on membership removal, raw-SQL cross-project forgery rejection, and
the legacy-copy backfill + corrupt-date migration refusal.

The single remaining finding is THIS PACKET: it still described the pre-merge
branch state ("PR iii"), named `bea314c` instead of the reviewed head, labelled
PR head SHAs as merge SHAs, and omitted PR #95/final-`main` CI evidence. The
docs-only correction PR carrying this revision fixes exactly that — no runtime
changes — and per the round-3 result, packet/history verification plus green CI
on that correction is sufficient to clear the gate; no further runtime
remediation round is required.

## Known Residual Risks

| Risk | Owner | Follow-up |
|---|---|---|
| The web session token is memory-only: a refresh returns to the sign-in gate (deep links survive re-auth, proven by `deep link survives token switch`). Deliberate for Phase 0; session persistence is a product decision. | PMCvitan maintainer | Evaluate refresh-token/session persistence in a later phase |
| The seeded demo password (`vitan123` default) also protects the `test-*` fixture users; the seed is dev/test-only and must never run against production (runner refuses without an explicit `DATABASE_URL`). | PMCvitan maintainer | Rotate/disable demo credentials before any shared staging environment |
| `apps/api` `start:dev` (tsx watch) cannot boot Nest DI (decorator metadata); dev serving uses the compiled `node dist/main.js` (as the acceptance harness does). | PMCvitan maintainer | Fix or replace the `start:dev` script in a later housekeeping change |
