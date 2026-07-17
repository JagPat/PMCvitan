# Phase 2 Task 10 — daily-log CORRECTION ROUND 2 — Review Packet

**HELD for the narrow Codex re-review — do not merge.** The independent Codex re-review of the merged
daily-log correction (PR #170) returned **BLOCKED** with **two remaining P1 findings**, both
independently reproduced. This branch is the focused fix-forward — one PR, from current `origin/main` —
that fixes exactly those two. PR #170 is **not** rolled back. **Drawings (module 2) stays blocked** until
this narrow re-review clears.

- **Base:** `origin/main` @ `8f44744de11d9b4d9c5e9b7ef2d983bc45b546f2` (the PR #170 merge).
- **Reviewed head of the BLOCKED round:** `1e090d5` (PR #170's tip); **merge:** `8f44744`.
- **Branch:** `claude/phase2-task10-daily-log-fix2`.
- **Head:** the tip of this branch at push (this packet's own commit is the last one).

| SHA | Finding | Increment |
|---|---|---|
| `1c47d74` | 1 (P1) | write-ahead client outbox for all four daily-log commands |
| `8731cd9` | 2 (P1) | failed module reconcile retains recovery + a Retry on retained last-good |
| _(this commit)_ | — | round-2 correction review packet |

---

## Vision alignment

One project is one site; the daily-log slice is a project operational record that never becomes global.
This round changes no ownership — it closes two ways the extracted module could **lose or hide a
committed human action**: a command whose response is lost must still apply **exactly once** (its
attributable approval preserved under the Task-5 ledger via a durable, key-carrying write-ahead op), and
a committed command whose module-owned read fails to refresh must **surface honest recovery** rather than
strand the user on stale data. Both fixes keep the existing project/user scope-isolation and
terminal-4xx handling; nothing touches persistence, migrations, or tenant enforcement.

---

## Finding 1 (P1) — lost online response lost the idempotency key (`1c47d74`)

**Defect at `8f44744`.** The online command path bypassed the durable outbox: `runRemoteOrQueue` only
queued when OFFLINE and fired a bare network call when online, and `startDailyLog`/`addSiteMaterial` had
no `OutboxOp` at all. If the server committed but its response was lost, the op — and its idempotency
key — was gone; the next attempt minted a fresh UUID, so the two transmitted keys differed and the
command could double-apply. (Codex's probe called `addSiteMaterial` twice after simulated lost responses
and observed two different keys.)

**Fix.** A `runWriteAhead` helper persists the op **and its key** to the durable outbox BEFORE the first
network request, ONLINE or offline, then flushes immediately when online. `flushOutbox` reuses the
persisted key, removes the op only on confirmed success/replay, KEEPS it (with its key) on a transient
failure (network / timeout / unknown / 5xx), and drops it on a terminal 4xx — all under the existing
scope/session guards. It gained an `okMsg` (the command's success toast on a clean flush) and a
serialization guard (per-command flushes never overlap; idempotency makes an overlap harmless anyway).
`apiGateway` gained `startDailyLog` + `addSiteMaterial` `OutboxOp` variants (+ `AddSiteMaterialInput`) and
their replay cases. All four daily-log commands (`start` / `addMaterial` / `flagMismatch` / `submit`) now
route through `runWriteAhead`; a retry always reuses the existing key, never a replacement.

**Red→green.** `apps/web/tests/daily-log-write-ahead.test.ts` (10): for EACH of the four commands, a lost
response retains the op and the retry transmits the **identical** key then removes it once; a reload
re-hydrates the pending op with its key; first-try success removes it exactly once; offline queues then
replays under the same key. These fail on `8f44744` (the online path persisted nothing → the op is
absent and a retry mints a new key).

## Finding 2 (P1) — failed module reconcile cleared recovery and left no Retry (`8731cd9`)

**Defect at `8f44744`.** A post-command reconcile whose `snapshot()` succeeded but whose module
`dailyLog()` failed (→ `null`) made `acceptSnapshot` return `applied`, so the command reconciliation
obligation (`commandAfterSequence`) was cleared UNCONDITIONALLY even though the module-owned read never
refreshed. With last-good data retained, `DailyLogScreen` locked every command but rendered NO Retry —
the user was stranded on stale data with dead controls and no recovery path.

**Fix.**
- **store** (`requestFreshSnapshot`): a command obligation now clears ONLY when the snapshot applied AND
  every REQUIRED module-owned read succeeded (`moduleReadsOk` — a decisions/daily-log read in
  `moduleQuery` mode that came back `null` is a failure). A failed required read RETAINS the obligation;
  recovery stays **bounded** (no auto-loop re-queues it) and the project itself is fresh (no false
  project-level error) — the module read's own `error` state carries the Retry.
- **DailyLogScreen**: when the module read failed but last-good data is retained, render a visible
  stale/unavailable warning + **Retry** (not silent stale data); keep the mutating commands locked; a
  successful Retry applies fresh data, sets `dailyLogLoad='ready'` and re-enables the actions. Retry
  re-runs the scope-guarded `requestFreshSnapshot`, so a switch/re-auth mid-retry mutates nothing in the
  new scope.

**Red→green.** Store — `daily-log-module-query.test.ts`: a snapshot-applies-but-module-read-fails
reconcile keeps last-good + `dailyLogLoad='error'` and a Retry recovers to progress-7; a project switch
during a Retry mutates nothing new-scope. Component — `daily-log-load-states.test.tsx`: error+last-good
shows the warning + Retry with locked actions; Retry re-runs the read and a successful refresh clears the
warning + re-enables the actions. These fail on `8f44744` (the obligation cleared unconditionally and the
screen showed no Retry when last-good was retained).

---

## Verification (all green — this branch head)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **549 passed** |
| Web unit suite | **340 passed** |
| Full integration suite — **freshly recreated** PostgreSQL DB (drop + migrate deploy) | **282 passed** |
| Daily-log focused: `daily-log-{projection,idempotency,isolation}` (live PG) + `daily-log-{write-ahead,module-query,load-states}` (web) | **green** |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | **PASSED** |
| API-backed Playwright — **moduleQuery**, **legacy** sender (incl. lost-response probe) | **22 passed** |
| API-backed Playwright — **moduleQuery**, **outbox** sender (incl. lost-response probe) | **22 passed** |
| New lost-response browser/API probe (`daily-log-lost-response.spec.ts`) | **passed both senders** |

CI runs the same battery on head and merge; the branch's Actions run is linked from the PR.

**HELD — do not merge.** Drawings (module 2) remains blocked until this narrow Codex re-review clears the
two findings.
