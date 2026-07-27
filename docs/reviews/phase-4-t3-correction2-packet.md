# Phase 4 Task 3 — correction round 2 review packet

**Verdict answered:** BLOCKED NARROWLY on PR #225. Fix-forward; #225 is NOT rolled back and no
deployed migration is edited.

## Exact SHAs

| What | SHA |
| --- | --- |
| Task 3 merge (PR #224) | `cb589dd` (head `ce33391`) |
| Correction round 1 base | `cb589dd` |
| Correction round 1 head (PR #225) | `1641e9c` |
| **Correction round 1 merge (PR #225)** | **`e7e8744`** |
| **This correction — base** | **`e7e8744`** |
| This correction — branch | `claude/phase4-task3-correction2` |

The round-1 merge tree (`e415116d`) is byte-identical to its reviewed head `1641e9c`. Every probe
below was run RED at `e7e8744` before any fix was written.

## Deployed migrations left byte-for-byte unchanged

`20270210000000_phase4_t3_time_capacity` and `20270215000000_phase4_t3_correction` are untouched.
One new additive, diagnostic-first migration: `20270220000000_phase4_t3_correction2`.

---

## Finding 1 — manual muster integrity

`manualReason` was added by `20270215000000`, but the append-only trigger it relies on was installed
by `20270210000000` and freezes an **explicit column list written before the column existed**. Two
holes followed, and both let an unevidenced presence claim become invisible again:

- the one field carrying the entire justification for a manual muster was freely rewritable after the
  fact — the recorded exception could be replaced with a different story at any time;
- nothing rejected a blank reason, which satisfies the `IS NOT NULL` arm of
  `LabourAttendance_trusted_evidence` while asserting nothing at all.

**Fix.** `phase4_t3_attendance_append_only` is REPLACED (same function, same trigger) with
`manualReason` in the frozen identity/evidence set, and a new
`LabourAttendance_manual_reason_non_blank` CHECK rejects a blank reason. The ONE permitted
transition is preserved exactly: a single revocation stamp on a not-yet-revoked row, after which the
row is terminal and the original reason survives verbatim.

**On the trim set — a deliberate deviation from the directive's literal text.** The directive says
`btrim(manualReason) = ''`. PostgreSQL's one-argument `btrim(text)` strips **spaces only**, so a
reason of one tab or one newline would pass that rule unchanged. My own probe caught this: the
space-only case was rejected while the tab case was accepted. The constraint therefore trims an
explicit whitespace set — see **R1** below, where the re-review completed it to the full ASCII
whitespace class. This is stricter than the directive read literally and is the rule the finding
actually asks for; it is called out here rather than applied silently.

**Probes** (`test/integration/phase4-t3-correction2.test.ts`):

| Probe | At `e7e8744` | After |
| --- | --- | --- |
| 1a — direct `UPDATE` of `manualReason` | **RED** (`resolved "1"` — one row rewritten) | rejected, original text intact |
| 1b — `INSERT` with whitespace-only reason (`''`, spaces, tab, newline, VT, FF, mixed) | **RED** (`resolved "1"`) | all seven rejected |
| 1c — device muster, manual muster, one-time revocation, revoked-is-terminal | green | green (precision guard, not just strictness) |

---

## Finding 2 — evidence deletion ordering

`MediaService.remove` called `storage.remove` **before** the transaction that decides whether the
delete is permitted. A participant refusal — labour presence evidence, inventory ledger evidence —
therefore left the database row intact with its bytes already gone: an append-only fact still citing
evidence that no longer existed, which is exactly what the append-only rule exists to prevent.

**Fix.** Storage is the LAST step and only on the success path. All authorization and disposability
checks and the row delete commit first; by then the database no longer references the object, so a
failed cleanup is a harmless orphan and never fails a committed delete. No new module architecture:
one statement moved, plus the comment explaining why the order is load-bearing.

**Probes** (`src/media/media.service.test.ts`, 4 new; 3 RED at `e7e8744`):

| Probe | At `e7e8744` | After |
| --- | --- | --- |
| a LABOUR refusal on a row **with** `storageKey` → `storage.remove` zero calls | **RED** (`Number of calls: 1`) | zero calls; row and object intact; no event dispatched |
| an INVENTORY refusal likewise | **RED** | zero calls |
| success path: DB delete strictly precedes object cleanup (`invocationCallOrder`) | **RED** (`expected 58 to be less than 52`) | ordered correctly |
| a failed bucket cleanup does not fail a committed delete | green | green (regression guard) |

---

## Finding 3 — cancellation/allocation serialization

`RequirementsService.revise/cancel` serialize on the `ActivityRequirementRoot` row (`lockRootHead`
takes it `FOR UPDATE`). The allocation guard read the current head with a **plain SELECT** and took
no lock, so the two writers were mutually blind: under READ COMMITTED neither could see the other's
uncommitted work and both committed — a cancelled requirement carrying an active allocation, the
exact incoherent state Task 4 would read as Team-gate truth.

**Fix.** `phase4_t3c_allocation_head_live` now takes the SAME root lock **before** reading the head.
Lock first, then read — the row lock is what makes the status authoritative rather than a snapshot
that may already be stale. A raw INSERT that bypasses the service still cannot skip its own trigger.

**Probes — deterministic two-session barriers, both orderings, no sleep-only synchronization:**

Each probe uses two gates. Gate 1 makes the stated ordering a *fact*: session B is not dispatched
until session A's write has actually executed and holds the root lock. (Without it the probe silently
tests nothing — `$transaction` must acquire a connection and BEGIN before its body runs, so the other
side can win outright. My first draft had this defect and the reproduction exposed it.) Gate 2 is a
condition-based poll of `pg_stat_activity` for a backend genuinely `Lock`-waiting on the expected
statement, observed on a third connection.

| Probe | At `e7e8744` | After |
| --- | --- | --- |
| 3a — raw allocation first, canonical `requirements.cancel` second | **RED**: `barrier timeout … %ActivityRequirementRoot%FOR UPDATE%` — the cancel never blocked | cancel blocks, then refuses with 409; head `open`, 1 active allocation |
| 3b — cancel first, raw allocation second | **RED**: `barrier timeout … %INSERT INTO "WorkerAllocation"%` — the allocation never blocked | allocation blocks, then sees the cancelled head and is rejected; head `cancelled`, 0 allocations |

Both probes assert the terminal invariant explicitly: **a cancelled head never coexists with an
active allocation**, and exactly one semantic outcome wins.

Session A in 3b replicates in SQL exactly what `cancel` writes — the same root lock, then a
cancellation revision copying the head's neutral columns and labour detail verbatim, so the
type↔detail correspondence trigger and the deferred demand seal both hold. It is a legal cancelled
head, not a forgery. Raw rather than the service call because the transaction must stay OPEN across
session B's attempt, and a service call commits atomically and cannot be paused.

---

---

## Re-review round (Codex on `b4f42f1`) — two P2 findings, both accepted and fixed

Both were defects in code THIS correction introduced, so they are fixed in place rather than
deferred; `20270220000000` is not yet merged or deployed, and the two deployed migrations remain
byte-for-byte unchanged.

### R1 — the whitespace set was incomplete (and then wrong)

The reviewer noted `btrim(x, E' \t\r\n')` strips neither VERTICAL TAB nor FORM FEED, so a
`\v`-only reason still passed. Correct.

Fixing it surfaced a second, worse bug **in my fix**: I first wrote the set as `E' \t\n\v\f\r'`,
but **PostgreSQL escape strings have no `\v` escape** — an unrecognized escape drops the backslash,
so the stored set contained the LETTER `v` and still no vertical tab. That is strictly worse than
the original: a `manualReason` of `"v"` would have been treated as blank. The probe caught it, and
inspecting the stored `pg_get_constraintdef` confirmed it byte-for-byte:

```
btrim("manualReason", '  <TAB> <LF> v')      -- ascii 118 = the letter v
```

The set is now `E' \t\n\x0B\f\r'`, verified by reading the bytes back out of the live constraint:
`32 9 10 11 12 13` — space, tab, LF, VT, FF, CR. Both the CHECK and the abort diagnostic use it, as
does `docs/RUNBOOK.md §P4T3C2`. Probe 1b covers `''`, spaces, tab, newline, **VT, FF**, and a mixed
run; the upgrade-proof hostile insert now sends `E'\t\n\x0B\f '`.

### R2 — inverse lock order between the raw and canonical allocation paths

The reviewer found a genuine deadlock. Verified against the live database rather than by reading:

```
BEFORE INSERT triggers on WorkerAllocation, in NAME (= firing) order:
  WorkerAllocation_frozen
  WorkerAllocation_head_live          ← root lock
  WorkerAllocation_within_commitment  ← commitment lock
```

So the insert takes **root → commitment**, while `LabourCapacityService.allocate` locked the
commitment first and only reached the root inside its own insert — **commitment → root**. A raw
insert holding the root and waiting on the commitment, against a canonical allocate holding the
commitment and waiting on the root, is a lock cycle; PostgreSQL breaks it by aborting one
*otherwise-valid* allocation.

`requirementHead` now takes the `ActivityRequirementRoot` lock FIRST, so every path requests the two
rows in the same order and the loser simply waits — the same reasoning as the existing
ascending-`workerId` crew rule. It also strengthens the read: the head status can no longer change
under the command, because a concurrent revise/cancel serializes on that very row.

Two new probes drive both orderings against a quantity-1 commitment and assert the refusal is on the
**§F bound**, never `40P01`:

| Probe | Result |
| --- | --- |
| raw allocation holds the root → canonical allocate follows | canonical loses on the bound, not a deadlock; 1 active allocation |
| canonical allocate commits → raw allocation follows | raw refused by the bound-3 trigger, not a deadlock; 1 active allocation |

## Gates

| Gate | Result |
| --- | --- |
| `pnpm check` | **EXIT 0** — web 432/432, API 659/659, build clean |
| New probes `phase4-t3-correction2.test.ts` | **7/7** (4 RED at `e7e8744` → GREEN; +2 lock-order probes from the re-review) |
| New probes `media.service.test.ts` | 20/20 in file (4 new; 3 RED at `e7e8744` → GREEN) |
| PR #225 tests retained | `phase4-t3-correction.test.ts` 5/5 + `phase4-t3-time-capacity.test.ts` 17/17 = **22/22** |
| F3 quantity-1 race | **10/10 consecutive** |
| Full live-PG integration | **68 files / 590 tests** |
| `upgrade-proof.sh` | **PASSED** — 4 new hostile rejections (the whitespace one now sends VT + FF) (rewrite a recorded reason; blank reason as spaces; blank reason as tab/newline; second revocation stamp) **and** the one-time revocation stamp still ACCEPTED, so the seal is precise rather than merely strict. Every prior Phase-1..Phase-4-T3C rejection survives. |
| `test:e2e:api:allmodules` | **31/31** |
| `test:e2e:api:outbox` | **25/25** |

**Reported honestly, twice over.**

*Integration:* the first full run (before the re-review fixes) showed 4 failures across 2 files,
immediately after several isolated suite runs against the same database — the documented
leftover-data collision pattern here. Two subsequent runs were clean, and the post-fix run is
68 files / 590 tests. I did not capture the failing file names in that first run, so it is recorded
as an observation, not a diagnosis.

*e2e:* the first `allmodules` run after the re-review fixes showed 4 failures — the same
`pillar-chain.spec.ts` trio (`:231`, `:261`, `:319`) investigated and documented on PR #225 as a
pre-existing flake reproducible on `main`, plus `daily-log-lost-response.spec.ts:29`, another
timing-sensitive spec already noted in this repo. Two immediate re-runs were **31/31**. None of the
four touches labour, allocation, attendance, or work facts.

## Operator path

`docs/RUNBOOK.md §P4T3C2` — the ONE abortable diagnostic (blank `manualReason`), why there is no
automatic repair (only the recorder knows why there was no device; inventing a reason would be worse
than the blank), and the revoke → re-record → remove-blank-rows → redeploy sequence. The finding-3
change alters a function, touches no rows, and cannot abort.

## Boundary and scope

No module gains a synchronous read of another's tables. Labour stays a LEAF. Tasks 1–2 untouched. No
frontend, no Team gate, no coverage read. **Task 4 does not begin until an explicit GO.**
