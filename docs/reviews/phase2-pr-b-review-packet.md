# Phase 2 Fix-Forward PR B — Durable Outbox — Review Packet

**Plan:** `docs/superpowers/plans/2026-07-16-phase2-fix-forward-pr-b-outbox.md`
**Status:** Aggregate PR B (Tasks 1–5) complete and green. This packet covers the **whole** of PR B — the already-merged Tasks 1–2 (PR #162) plus the follow-up Tasks 3–5 opened for independent Codex review.
**Coordination:** Claude implemented; Codex reviews. This branch is a DRAFT held for that review — do not merge.

---

## 1. Aggregate change coordinates

| Piece | Ref | SHA |
|---|---|---|
| **PR #162** base (main after PR A #161) | `main` | `54cf06f479a539cfab0684f1749d1b7af1c0fc93` |
| **PR #162** head | `claude/phase2-pr-b-durable-outbox` | `75588516f40377db97a41b321c67b9d0266ada7f` |
| **PR #162** merge commit into `main` | `main` | `570502ae1afe81acb1a59e19eba5acf4c63560e1` |
| **Follow-up (this PR)** base | `main` (= #162 merge) | `570502ae1afe81acb1a59e19eba5acf4c63560e1` |
| **Follow-up (this PR)** code head | `claude/phase2-pr-b-outbox-scanner` | `b515f5e` |

The branch tip is the docs-only commit that adds *this* packet, sitting directly on top of the code head `b515f5e`. All gate results below were captured at the code head `b515f5e`.

Follow-up commits (base `570502a` → head `b515f5e`):

| Commit | Task | Summary |
|---|---|---|
| `dda026d` | 3 | continuous `NOT EXISTS` expansion + ordered no-ops + pre-intent external neutralization |
| `81dca67` | 4 | audited dead-letter ops (`outbox:status`/`outbox:retry`) + fail-soft `/health` metrics |
| `b515f5e` | 5 | abort/repair/redeploy proof + platform boundary registration for the three new tables |

Tasks 1–2 (schema, diagnostic migration, total delivery planning, `syncConsumerCatalog`, persisted `dispatchIntent`) are **already on `main`** via PR #162 — they are not re-committed here. This branch adds only Tasks 3–5 on top of them.

---

## 2. Migration

- **Name:** `20261026000000_phase2_outbox_reliability` (landed in PR #162; unchanged on this branch)
- **SHA-256:** `dd32382334684d81a8ae66e171112f7c16169605db247579d13ca99c8bad6e67`
- **Shape:** additive columns + 3 new tables + FK swap + CHECKs, **diagnostic-first**. It:
  1. adds nullable `DomainEvent.dispatchIntent`, `OutboxDelivery.deliveryAction default 'dispatch'`, and a candidate unique key `(eventId, projectId, streamPosition)`;
  2. seeds `socket.invalidation` and `webpush.notify` as version-1 `unordered/external` catalog consumers;
  3. **aborts with counts + samples** if any existing delivery's copied `(projectId, streamPosition)` disagrees with its append-only `DomainEvent` — it never guesses a repair;
  4. replaces the event-only FK with the composite `(eventId, projectId, streamPosition)` FK;
  5. adds the `(consumer, consumerKind)` catalog FK;
  6. adds CHECKs for delivery action, kind/effect pair, and the cutover singleton key;
  7. **leaves every historical payload and event row unchanged.**

---

## 3. Red-at-base → green-at-head probe map

Two kinds of red-at-base signal, both honest TDD reds:

**(a) Behavioral reds — the DB *accepts* the bad shape at base, *rejects/aborts* at head** (Tasks 1–2, merged in #162; re-confirmed here by the abort-proof):

| Probe | At base (`54cf06f`) | At head |
|---|---|---|
| direct-insert a delivery with forged `(projectId, streamPosition)` | accepted (no composite FK) | **rejected** by the composite FK |
| migrate a DB that already holds a forged-coordinate delivery | n/a (no migration) | **aborts** with coordinate-mismatch diagnostic + counts |
| invalid `deliveryAction` value | accepted (no CHECK) | **rejected** by CHECK |
| invalid catalog kind/effect pair | accepted (no table) | **rejected** by CHECK |
| second `OutboxCutoverState` row | accepted | **rejected** by singleton CHECK |

`test/integration/outbox-reliability.test.ts` (5 probes) encodes these; the abort-proof script re-demonstrates the migration abort behaviorally end-to-end.

**(b) Capability reds — the probed symbol/behavior does not exist at base, exists and passes at head** (Tasks 3–4, this follow-up):

| Probe file | Capability exercised | Absent at base |
|---|---|---|
| `test/integration/outbox-scanner.test.ts` | `OutboxRelay.expandMissingDeliveries` invoked by `runOnce` before claiming: late-registered consumer backfilled; two concurrent scanners idempotent; ordered no-op at pos 0 then dispatch at pos 1. (**Corrected in round 1** — see §12: the original "dispatch + no-op mix" and old-instance/crash cases are now explicitly proven; the initial suite used a no-op-only late consumer and did not prove the mix.) | `expandMissingDeliveries` does not exist; `runOnce` never expands |
| `test/integration/outbox-operations.test.ts` | `OutboxOperationsService.status`/`retry`: status aggregates + truncated errors; retry rejects **non-dead / missing**; unordered dead reset; ordered cursor unblocked only when exact-next; one audit row per retry. (**Corrected in round 1** — see §12: the original packet also claimed "inactive / mismatched" rejection; the **inactive** rejection is now explicitly tested, and **coordinate mismatch** is structurally unreachable — the composite `(eventId,projectId,streamPosition)` FK prevents it — so the retry mismatch guard is defense-in-depth, not separately testable.) | `OutboxOperationsService` does not exist |
| `src/platform/outbox/registry.test.ts` | total `deliveryFor` (no null); unordered no-op → `succeeded/noop`; ordered no-op → `pending/noop`; `syncConsumerCatalog` creates rows and rejects kind/effect/version drift; **(round 1)** materialize writes rows only for **active** catalog consumers | total planning + `syncConsumerCatalog` do not exist |
| `src/health.controller.test.ts` (2) | `/health` returns outbox aggregates and stays HTTP 200 with `outboxAvailable:false` when the diagnostic query throws | health has no outbox fields, no fail-soft path |

> **Round-1 correction (Codex BLOCKED verdict).** The row counts and two claims above were revised in the PR B correction round (§12). The original packet stated exact per-file test counts and claimed a dispatch/no-op mix and inactive/mismatched retry rejection that the committed suites did not all prove. §12 records the corrected, executed probe map with red-at-main / green-at-head results.

---

## 4. Gate battery — commands, exit codes, totals

All run at head `b515f5e` against live PostgreSQL 16 (`vitan_pmc_test`). `THROTTLE_DISABLED=true` is set **only** for the HTTP integration/e2e suites (it is the acceptance-harness escape hatch the `ThrottleGuard` honors outside production); the unit suite and `pnpm check` run **without** it so the `ThrottleGuard` unit tests exercise real throttling.

| Command | Exit | Result |
|---|---|---|
| `pnpm --filter api prisma:generate` | 0 | client generated |
| `pnpm --filter api typecheck` | 0 | `tsc --noEmit` clean |
| `pnpm --filter api test` | 0 | **491 passed (491)**, 44 files |
| `pnpm --filter api test:integration` | 0 | **232 passed (232)**, 26 files |
| `bash apps/api/scripts/upgrade-proof.sh` | 0 | UPGRADE PROOF PASSED (legacy meanings survive; row-free capability add) |
| `bash apps/api/scripts/outbox-migration-abort-proof.sh` | 0 | OUTBOX ABORT PROOF PASSED (see §6) |
| `pnpm check` | 0 | web **298 passed (298)** / api **491 passed (491)** — boundary + cross-module graph gates green |
| `git diff --check origin/main...HEAD` | 0 | no whitespace/conflict markers |

The 4 outbox integration suites together contribute **30 passed** (`outbox.test.ts`, `outbox-scanner.test.ts`, `outbox-reliability.test.ts`, `outbox-operations.test.ts`).

---

## 5. Outbox race suite — 10× consecutive

`pnpm exec vitest run --config vitest.integration.config.ts test/integration/outbox.test.ts test/integration/outbox-scanner.test.ts test/integration/outbox-reliability.test.ts test/integration/outbox-operations.test.ts`, run 10 times back-to-back:

```
run 1: OK  | Tests 30 passed (30)
run 2: OK  | Tests 30 passed (30)
run 3: OK  | Tests 30 passed (30)
run 4: OK  | Tests 30 passed (30)
run 5: OK  | Tests 30 passed (30)
run 6: OK  | Tests 30 passed (30)
run 7: OK  | Tests 30 passed (30)
run 8: OK  | Tests 30 passed (30)
run 9: OK  | Tests 30 passed (30)
run 10: OK | Tests 30 passed (30)
=== DONE: 0 failing runs out of 10 ===
```

The race probes use deterministic barriers / condition waits (no fixed `sleep`s): concurrent-scanner idempotency relies on the `@@unique(eventId, consumer)` backstop + P2002-ignore, and ordered progression asserts on cursor/`ProcessedEvent` state, not elapsed time.

---

## 6. Migration abort → repair → redeploy

`apps/api/scripts/outbox-migration-abort-proof.sh` (exit 0):

1. Build a scratch DB with **every migration except** `20261026000000_phase2_outbox_reliability`.
2. Plant a valid append-only `DomainEvent` at `(p-abort, streamPosition 0)` and a delivery whose copied coordinates are forged to `(WRONG-PROJECT, 999)`.
3. Apply PR B `--single-transaction` → **ABORTS** with `coordinates that disagree with their DomainEvent` (no guessed repair). ✔
4. Correct **only** the forged fixture coordinate (the append-only event is never rewritten).
5. Re-apply PR B → **SUCCEEDS**. ✔
6. Assert the repaired delivery survived with `deliveryAction='dispatch'` and coordinates now matching the event (`dispatch|p-abort|0`). ✔

This proves the diagnostic-first invariant: a coordinate contradiction halts the deploy loudly, and only after a human-verified fixture correction does the redeploy proceed — with history intact.

---

## 7. Behavioral evidence per capability

**Catalog (durable consumer contract).** Live `OutboxConsumerCatalog` after a test run:

```
      consumer       | consumerKind | consumerEffect | catalogVersion | active
---------------------+--------------+----------------+----------------+--------
 socket.invalidation | unordered    | external       |              1 | t
 test.projection     | ordered      | db             |              1 | t
 webpush.notify      | unordered    | external       |              1 | t
```

`socket.invalidation` and `webpush.notify` are the migration seed; `test.projection` was persisted by `syncConsumerCatalog` at bootstrap — proving compiled consumers become durable rows before the relay starts, so the `(consumer, consumerKind)` delivery FK always resolves. `syncConsumerCatalog` fails **closed** on kind/effect/version drift (never silently overwrites), so a rolling deploy with a contract change aborts rather than corrupting the catalog.

**Scanner (continuous full-envelope expansion).** `runOnce()` calls `expandMissingDeliveries()` **before** claiming work. For each active catalog row it selects the earliest full `DomainEvent` envelopes lacking its delivery with `NOT EXISTS`, ordered by `(projectId, streamPosition)`, batched (200), resolves the compiled consumer, derives the plan, and inserts with skip-duplicates. Proven: a consumer registered *after* events exist is fully backfilled; two concurrent scanners produce no duplicate rows (unique `(eventId, consumer)` + P2002-ignore); no event or cursor position is ever skipped.

**Ordered no-ops.** An unordered no-op materializes `succeeded/noop` and never invokes a handler. An ordered no-op advances `ProcessedEvent` + `ProjectionCursor` **in the same transaction** but skips the business projection (`if (delivery.deliveryAction === 'dispatch') await consumer.handle(...)`), so an ordered stream never stalls on a position that has no real work. A pre-intent external delivery (null/`noop` intent) is neutralized to `noop/succeeded` **without sending** — no historical notification is ever replayed.

**Retry (audited recovery).** `OutboxOperationsService.retry` accepts **only** a `dead` delivery; re-validates event coordinates and the **active catalog contract**; then in one `FOR UPDATE`-locked transaction resets the row to `pending` (attempts 0, lease/error cleared) and writes one `OutboxOperatorAction`. It **never advances `appliedPosition`**: for an ordered consumer it only clears a `blocked` cursor, and only when the dead row is the cursor's **exact-next** expected position. Nonblank operator identity + reason are required. A dead exact-next row **visibly blocks** the ordered cursor until retried — by design; nothing is silently skipped.

**Health (fail-soft diagnostics).** `/health` returns process uptime + outbox aggregates (`outboxDead`, `outboxBlocked`, `outboxOldestPendingSeconds`) with **no payloads or secrets**. If the diagnostic query throws it returns `outboxAvailable:false` at **HTTP 200** — a diagnostic failure never trips a liveness restart loop. `status()` truncates error strings and never returns event payloads or push-subscription secrets.

---

## 8. Data-preservation confirmation

- **DomainEvent stays append-only.** No PR B code path updates a `DomainEvent`; `dispatchIntent` is written only at emit time on new rows, and legacy rows keep `dispatchIntent = NULL` (→ external no-op, never a replayed push).
- **Existing delivery history unchanged.** The migration adds `deliveryAction` with default `'dispatch'` over existing rows and swaps the FK; it rewrites no `id`, payload, `attempts`, or `status`. Proven by `upgrade-proof.sh` (legacy meanings survive) and the abort-proof (the repaired delivery keeps its identity and history).
- **No replacement / no parallel system.** No app, DB, auth, or frontend replacement; Phase 0/1 and Task 6/7 untouched; additive forward migration only; no second event system or duplicate workflow. Only unordered external consumers run in production today, so `main` stays safe throughout.
- **No secrets in code/tests/docs.** Test connection strings are the local disposable test DB only.

---

## 9. Known operational risks / scope boundaries

1. **`compat.task6` intent (interim).** Until PR C supplies the final per-command catalog key, `emitEvent` persists a compatibility `dispatchIntent` (`effectKey:'compat.task6'`, `coverageVersion:'compat-task6'`) capturing current socket + decision-notification behavior. External dispatch plans derive from this persisted intent; a null-intent legacy event is an external no-op. This is deliberately honest about coverage — it does **not** claim complete cutover; PR C seals the final per-command coverage via `OutboxCutoverState`.
2. **`OutboxCutoverState` declared, not yet enforced.** The singleton table exists for PR C's seal; PR B neither reads nor gates on it.
3. **Bounded scanner passes.** `expandMissingDeliveries` repairs **at most `batchSize` (default 200) events per active consumer per invocation** — a fair, deterministic budget; a very large backlog is closed over successive relay ticks, not in a single tick or a single bootstrap pass. Idempotent and gap-safe, but not instantaneous. (**Round 1** made this real — the original code drained the whole backlog per call; see §12 finding 2.)
4. **Ordered blocking is intentional.** A dead exact-next ordered row halts that project's ordered cursor until an operator retries — no auto-skip. Operators observe this via `/health` (`outboxBlocked`) and `outbox:status`, and recover via `outbox:retry`.

---

## 10. Vision alignment

PR B makes the platform outbox — the shared spine that carries every module's domain events to their consumers — **durable, gap-safe, coordinate-bound, observable, and recoverable without ever mutating a canonical event**. It preserves the project's core invariants: one project is one site (deliveries are bound to their project's event coordinates by FK); operational records never become global (the catalog and audit are platform-kernel infrastructure, not module domain tables); one fact has one canonical owner (the append-only `DomainEvent` remains the sole authority for coordinates — retries and scanners read it, never rewrite it); and attributable human approvals are preserved (operator recovery is audited with a required identity + reason in `OutboxOperatorAction`). Every change is additive and diagnostic-first, proven against live PostgreSQL.

---

## 11. Reproduce

```bash
# from repo root, with PG16 running and vitan_pmc_test present
export DATABASE_URL="postgresql://vitan:vitan@localhost:5432/vitan_pmc_test?schema=public"
export JWT_SECRET="api-e2e-test-secret"

# unit + workspace gates (throttling ENABLED)
pnpm --filter api test
pnpm check

# integration + races (harness escape hatch ON)
export THROTTLE_DISABLED=true
pnpm --filter api test:integration
for i in $(seq 1 10); do pnpm exec --dir apps/api vitest run --config apps/api/vitest.integration.config.ts \
  test/integration/outbox.test.ts test/integration/outbox-scanner.test.ts \
  test/integration/outbox-reliability.test.ts test/integration/outbox-operations.test.ts || break; done

# migration proofs (PG* default to postgres/postgres)
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash apps/api/scripts/upgrade-proof.sh
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash apps/api/scripts/outbox-migration-abort-proof.sh
```

---

## 12. PR B correction round 1 (Codex BLOCKED verdict)

Codex reviewed the merged PR B (this packet's §1–§11) and returned **BLOCKED** with four findings — two runtime corrections and two evidence/documentation corrections. All four were verified reproduce-first against `main @ 4904e116` (the merge of PR #163) before fixing. This section records the correction; it is a **fix-forward** on the merged code — PRs #162/#163 are not rolled back, and **no migration is added** (the `OutboxConsumerCatalog.active` column already exists).

### Findings (all verified real)

| # | Sev | Finding | Verified at `4904e116` |
|---|---|---|---|
| 1 | P1 | Inactive consumers still receive and process work — `materializeDeliveries` and the relay's claim/dispatch never checked durable `catalog.active` (only the scanner did) | deactivate a consumer, emit → **1** delivery row created (expected 0); dispatch runs its handler |
| 2 | P2 | Expansion not actually bounded — `expandMissingDeliveries` looped an inner `for(;;)` until the whole backlog drained; bootstrap awaited the full drain | five owed obligations, `expandMissingDeliveries(2)` returned **5** (expected ≤2) |
| 3 | P2 | Packet claimed probes that did not exist — the scanner's late consumer was no-op-only (no dispatch/no-op mix proven); ops did not prove inactive/mismatched retry rejection | test bodies inspected (`outbox-scanner.test.ts:85`, `outbox-operations.test.ts:63`) |
| 4 | P3 | Stale phase memory — `CLAUDE.md` and `docs/ROADMAP.md` still said Phase 2 was "PLANNING / pending review" | doc lines read |

### Fixes

**Finding 1 — `OutboxConsumerCatalog.active` is now authoritative** (no delete/rewrite of any historical event or delivery):
- `materializeDeliveries` reads the active catalog set **inside the emit transaction** and writes a row only for an active compiled consumer (empty-registry fast path preserved for mocked-prisma unit tests).
- `runOnce` claims only active consumers; `dispatchOne` re-checks `active` and, on a contract deactivated between claim and handle, **releases the lease back to `pending`** (recoverable, never dead-lettered) and returns `skip`.
- Inactive **pending** deliveries survive and resume on reactivation.

**Finding 2 — expansion is bounded**: the inner drain loop is removed; each `expandMissingDeliveries(batchSize)` invocation processes **at most `batchSize` events per active consumer**. Bootstrap performs one bounded pass; later relay ticks continue until `NOT EXISTS` returns nothing.

**Finding 3 — evidence corrected**: §3 and §9 above are revised; the new tests below back every retained claim, and the two unprovable/removed claims (exact per-file counts, coordinate-mismatch retry as a *tested* path) are corrected — coordinate mismatch is structurally prevented by the composite FK (proven by `outbox-reliability` + the abort-proof), so the retry mismatch guard is documented as defense-in-depth.

**Finding 4 — docs corrected**: `CLAUDE.md` and `docs/ROADMAP.md` now state Phase 2 review has cleared, the kernel spine + outbox fix-forward (PR A #161, PR B #162/#163) are merged, this correction is in review, and PR C + the extraction tasks remain.

### Correction probe map — red-at-main (`4904e116`) → green-at-head

| Test (file) | At `main` | At head | Kind |
|---|---|---|---|
| bounded expansion: `expandMissingDeliveries(2)` over 5 owed → ≤2 per call, drains over passes (`outbox-scanner`) | **FAIL** (creates 5) | pass | finding 2 |
| deactivated consumer + new event → no delivery row (`outbox-scanner`) | **FAIL** (creates 1) | pass | finding 1 (materialize) |
| deactivate after creation → no handler, row stays `pending`, reactivation resumes (`outbox-scanner`) | **FAIL** (handler runs, row `succeeded`) | pass | finding 1 (claim/dispatch) |
| materialize writes no row for a registered-but-inactive consumer (`registry.test.ts`, unit) | **FAIL** | pass | finding 1 (unit) |
| late **filtered** consumer gets BOTH a dispatch and a no-op row (`outbox-scanner`) | pass | pass | finding 3 (proof gap) |
| catalog persisted while code absent → repaired by scanner after registration (`outbox-scanner`) | pass | pass | finding 3 (proof gap) |
| retry rejects an **inactive** contract — no reset, no audit row (`outbox-operations`) | pass | pass | finding 3 (proof gap) |

The three finding-1/2 tests are behavioral reds at `main`; the three finding-3 tests are coverage that closes the packet's proof gaps (correct at `main` and head — the scanner/retry guards already behaved correctly; only the *evidence* was missing).

### Correction gate (at correction head, live PostgreSQL 16)

| Command | Exit | Result |
|---|---|---|
| `pnpm --filter api typecheck` | 0 | clean |
| `pnpm --filter api test` (unit) | 0 | **492 passed** (44 files; +1 registry unit test vs the merged head's 491) |
| `pnpm --filter api test:integration` | 0 | **238 passed** (26 files; +6 outbox tests vs the 232 in §4) |
| `pnpm check` | 0 | web **298** + api **492** — boundary + cross-module graph gates green |
| `upgrade-proof.sh` / `outbox-migration-abort-proof.sh` | 0 / 0 | unchanged — no migration added |
| four outbox suites ×10 | — | 0 failing / 10 (**36 passed** per run, up from 30) |

> One gate-only test correction was required: `orgs.service.test.ts`'s `createProject` mock now stubs `tx.outboxConsumerCatalog.findMany` (materialize reads the active set inside the emit tx). No production behavior change.

No data rewritten; `DomainEvent` stays append-only; existing deliveries keep their identity/history; only the delivery-planning + relay + scanner logic changed (plus docs + tests). Exact commands, totals and the 10× log are in the PR body.
