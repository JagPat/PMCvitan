# Phase 2 Task 10 — daily-log module CORRECTION — Review Packet

**HELD for Codex review — do not merge.** This is the focused correction round for the daily-log
module (PR #169, merged at `main` `a5531015`). An independent review found **5 findings (3 P1, 2 P2)**
against the merged module; this branch fixes all five, on its own branch, one held draft PR. **Drawings
(module 2) does not start until this correction clears.**

- **Base:** `main` @ `a5531015e0e7d4cd1754e289e127c1a6bdb13494` (the PR #169 merge).
- **Branch:** `claude/phase2-task10-daily-log-fix`.
- **Head:** the tip of this branch at push (this packet's own commit is the last one).

| SHA | Finding | Increment |
|---|---|---|
| `a20a9a8` | 1 (P1) | projection serving safety — a servability gate on the projection read |
| `169feec` | 3 (P1) | command idempotency — the four commands onto the Task-5 ledger (backend) |
| `c0940a0` | 3 (P1) | command idempotency — keys threaded from the web store + outbox (frontend) |
| `98fc74f` | 2 (P1) | module-aware post-command reconciliation |
| `4037723` | 4 (P2) | honest daily-log load states |
| `57621d9` | 5 (P2) | single shared module HTTP result type |
| `2eb41df` | 5 (P2) | module read isolation probes + API-backed moduleQuery e2e |
| _(this commit)_ | — | correction review packet |

---

## Vision alignment

One project is one site; the daily-log slice (attendance, crew, materials, progress) is a **project
operational record** that never becomes global. This correction changes no ownership: `dailyLog`/
`crewRow`/`siteMaterial` stay owned by the `daily-log` module, and every cross-module read still goes
through its query contract. It makes the extraction **honest and safe** where the review found it was
not: the rebuildable projection is a read model that **never serves stale-as-authoritative** data (it
falls back to canonical when it cannot prove itself current); the four commands **preserve exactly one
attributable human approval** under retry (the Task-5 idempotency ledger, matching decisions); and the
module-owned read is refreshed after every committed command **under the captured project/session
scope**, so a stale continuation can never write into another project or identity. Migrations remain
additive and forward-only; tenant isolation stays database-enforced; the read cutover stays
capability-versioned (default `snapshot`, unchanged).

---

## Finding 1 (P1) — projection serving safety (`a20a9a8`)

**Defect at `a5531015`.** `projectionSlice` served the active generation's row whenever one existed. A
generation bootstrapped by an **unrelated no-op** (e.g. `project.created`) is `active` and caught-up but
has **no `DailyLogProjection` row** — so the read returned an **empty slice as authoritative projection
data**, hiding real canonical daily-log data. A generation whose checkpoint **lagged** a just-committed
write, or a **blocked** generation, likewise served stale rows as current.

**Fix.** A new `readServableGeneration(client, consumer, projectId)` (platform/projections/generation.ts)
returns a generation ONLY when it is healthy (`cursorStatus='live'`), caught up to the project's
committed stream head (`appliedPosition >= head`), AND (checked by the caller) its row exists.
`projectionSlice` returns `generation: null` otherwise; `moduleDailyLog` then falls back to the canonical
live slice, which is always current.

**Red→green.** `test/integration/daily-log-projection.test.ts` adds four reproduce tests that FAIL against
the base behavior and pass now: legacy canonical data + a no-op bootstraps an active generation → serves
**live** (progress 33 visible), not the empty projection; no-log + no-op → live/empty; a lagging
checkpoint (a committed second write not yet applied) → live (newest canonical); a blocked generation →
live. The pre-existing byte-identity and live==rebuild tests stay green.

## Finding 3 (P1) — command idempotency (`169feec` backend, `c0940a0` frontend)

**Defect at `a5531015`.** The four daily-log commands (`start`/`addMaterial`/`flagMismatch`/`submit`) took
**no idempotency key** — a lost-response retry created a second day's log, a duplicate material, a
duplicate mismatch flag/notification, or a duplicate submission + audit, unlike decisions which already
run on the Task-5 `CommandExecution` ledger.

**Fix.** All four migrate onto `executeCommand(prisma, {scope, actor, commandType, idempotencyKey,
requestHash, run})` (reserve→run→receipt in one `$transaction`), mirroring decisions: the same key +
payload replays the committed result exactly once; a different payload under the same key is a truthful
**409**; concurrent duplicates resolve to a single winner via the partial-unique receipt; the receipt is
**actor-scoped**; unkeyed callers keep working (legacy path, no receipt). `start` re-checks its
"previous log submitted" precondition under `lockProjectReadiness` inside the transaction, so two
concurrent keyed starts cannot open two logs. The controller reads `Idempotency-Key`; the web store
generates one key per action and threads it into BOTH the online call and the queued outbox op.

**Red→green.** `test/integration/daily-log-idempotency.test.ts` (NEW, live PG, 6 tests): start replay
(one log/event/audit/receipt); two concurrent same-key starts → one log; addMaterial replay + a
different-payload 409; the same key from two actors → two independent executions; submit replay; the
legacy no-key path writes no receipt. `daily-log.contract.test.ts` pins the key as each command's trailing
argument; `store.api.test.ts` pins the key travels with the store action.

## Finding 2 (P1) — module-aware post-command reconciliation (`98fc74f`)

**Defect at `a5531015`.** Under module ownership (`VITE_DAILYLOG_READ=moduleQuery`) a command's own
snapshot response carries **no module slice** (the store leaves `dailyLog`/`materials` untouched to
preserve the XOR). `consumeSnapshotResult` only reconciled on `superseded`, so an `applied` command left
`s.dailyLog` **stale** until an unrelated background refresh — a committed material/start/submit was
invisible.

**Fix.** `consumeSnapshotResult` now schedules the scope-guarded reconcile after ANY committed command
(`applied` OR `superseded`) whenever a read surface is module-owned, so `requestFreshSnapshot` refetches
the module-owned read under the SAME **captured scope** (threaded through all four command-path callers).
Finding-1's servability gate makes a lagging/blocked projection fall back to canonical, so the change is
never hidden. `scheduleReconcile` drops a continuation whose scope has moved — a stale reply mutates
nothing (data / load-state / toast) in a new scope. Pure `snapshot` mode is unchanged (no extra pull).

**Red→green.** `apps/web/tests/daily-log-module-query.test.ts` adds 7 store race tests: applied command
(the command slice never lands; the module read is refreshed), superseded command (still reconciles),
socket-before-projection (live canonical fallback served), projection-before-socket (caught-up projection
served), project switch and same-project re-auth (the stale continuation mutates nothing in the new
scope), and the snapshot-mode gate (no extra reconcile).

## Finding 4 (P2) — honest daily-log load states (`4037723`)

**Defect at `a5531015`.** Under module ownership the daily-log read is a separate async surface, but a
still-loading or failed module read was rendered as the empty **"No daily log started"** state, and a
scope change left the previous project's `dailyLogLoad='ready'` over now-blank data (`emptyProjectData()`
reset the data but not the read meta).

**Fix.** `projectScope.emptyModuleReadState()` tears the decisions + daily-log read meta down alongside
`emptyProjectData()` at every scope teardown (project switch, same-project re-auth, sign-out).
`DailyLogScreen` (moduleQuery only) renders "Loading today's log…" while idle/loading and an
unavailable + **Retry** boundary on error BEFORE the null empty state; "No daily log started" now appears
only after a read has SUCCEEDED with null; a failed read that retains last-good shows the log with its
mutating commands (start / add-material / flag / submit) **locked** until the read settles. Snapshot mode
is untouched (`dailyLogLoad` stays idle → no gate fires).

**Red→green.** `apps/web/tests/daily-log-load-states.test.tsx` (NEW, 11 tests): loading / idle / error+Retry
/ ready-null / error-with-last-good-locked / loading-with-last-good-locked / ready-enabled component
states, 2 snapshot-mode no-regression, and 2 store teardown (sign-out + switch reset the read meta
synchronously).

## Finding 5 (P2) — single shared module HTTP result + isolation/e2e (`57621d9`, `2eb41df`)

**Defect at `a5531015`.** The module HTTP result was declared twice — an inline object type on the API's
`moduleDailyLog` and a duplicate `ModuleDailyLog` interface in the web gateway — free to drift; and the
module read had no cross-tenant / lifecycle acceptance coverage beyond the byte-identity + rebuild tests.

**Fix.** `@vitan/shared` defines `DailyLogModuleResult` ONCE (the complete `GET …/daily-log` result:
slice + `source` + `generation`, with `swatch` as the open wire string); the API annotates
`moduleDailyLog` with it (a compile-time contract assertion pins the return type), and the web gateway's
`ModuleDailyLog` becomes an alias of it (dup interface removed) — the store narrows the wire views to its
`SwatchKey` DTO at the one module→store boundary.

**Isolation + lifecycle (live PG).** `test/integration/daily-log-isolation.test.ts` (NEW, 7 tests):
cross-project (a query never leaks another project's slice), cross-org + same-org-non-member + removed
membership (`GET …/daily-log` → 403, membership-authoritative), rebuild-while-writing (a post-catch-up
write lags → live fallback → a rebuild catches head), relay-vs-rebuild (draining a still-pending delivery
after a rebuild keeps the served slice == live, no double-apply), and legacy-upgraded-data (a legacy
project reads live, then the projection after an upgrade). The lagging/blocked fallbacks stay in
daily-log-projection.test.ts (finding 1).

**API-backed moduleQuery e2e.** The Playwright API config forwards `VITE_DAILYLOG_READ` from
`E2E_DAILYLOG_READ`; new scripts `test:e2e:api:modulequery[:outbox]`. `tests/e2e-api/daily-log-module-query.spec.ts`
(runs only under moduleQuery) proves the XOR path end-to-end over the real stack: the module read owns
the daily-log surface, `addMaterial` carries an `Idempotency-Key`, and the post-command reconcile
refetches the module read so the committed material appears without a reload. **Green in BOTH sender
modes.**

---

## Verification (all green — this branch head)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **549 passed** |
| Web unit suite | **326 passed** |
| Full integration suite (live PostgreSQL) | **282 passed** |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | **PASSED** |
| Demo Playwright (`pnpm --filter web test:e2e`) | **21 passed** |
| API-backed Playwright — snapshot mode, **legacy** sender | **20 passed, 1 skipped** (moduleQuery spec skips) |
| API-backed Playwright — snapshot mode, **outbox** sender | **20 passed, 1 skipped** |
| API-backed Playwright — **moduleQuery**, **legacy** sender | **21 passed** |
| API-backed Playwright — **moduleQuery**, **outbox** sender | **21 passed** |

CI runs the same battery; the branch's Actions run is linked from the PR.

**HELD — do not merge.** Per the one-module-per-PR review stop, drawings (module 2) does not start until
this daily-log correction clears Codex review.
