# Review packet — one finding-head evidence view

**Replaces PR #260.** Same work; different shape. #260 drew findings on two
consecutive heads, and both rounds landed on the same defect wearing different
clothes, so it is being restructured rather than patched a third time.

## Why #260 is replaced rather than corrected

PR #259 shipped the restructure policy as pure functions. #260 made it durable
and wired it into the gate. Its two review rounds produced eight findings, and
the second round's five were all the same thing:

| Round-2 finding | Site | What it re-derived |
| --- | --- | --- |
| P1 | `publishFindingOutcome` | re-read live comments instead of carrying the crossing head it already knew |
| P2 | `preserveMetrics` | preferred run metrics over the comment's, instead of unioning |
| P2 | `acceptedDeferral` | ran `assessConvergence` on a fresh live read with no floor |
| P2 | `assessRestructure` | the `floorUnreadable` branch pre-empted the deferral |
| P2 | `docs/AUTONOMOUS_LOOP.md` | a second list of the retryable statuses, out of step with the first |

Four sites, one question — *how many finding-bearing heads has this unit had?* —
answered independently at each, every time from a possibly-partial read. Each
answer was individually defensible; the set of them was not, because a partial
read at **any** site silently lowered the count, and each review round found a
different site.

That is the defect class this module was written to stop, reproduced by the
module itself. Patching the four sites would have been a fifth instance of the
pattern. So the answer is produced **once** and passed down.

The one finding that most deserves recording is `preserveMetrics`. Its comment
said:

> This run's own assessment beats whatever the comment recorded earlier: the
> count only ever rises, so the fresher reading is never the smaller one.

That reasoning assumes both reads see the same thing — which is exactly what the
floor exists to reject. Three functions in that file union rather than replace;
this one site preferred, and it was the site that composes the output. The
principle was in my head instead of in the code's shape, and the code shape is
what a review can check.

## The change

```js
export function findingEvidence({ recorded, live, currentHead, currentHeadHasFindings, floorUnreadable })
```

Three sources, unioned:

- the **recorded** floor, which survives partial reads by construction;
- the **live** read, the only thing that sees a head just reviewed;
- the **current head**, when the caller already knows it bears findings.

That last one is the round-2 P1. A caller inside the finding path has *just*
classified a current-head finding; re-reading the API to rediscover that fact can
lose it, and the head it loses is precisely the one that crosses the cap.
Evidence you already hold should never be re-fetched to be believed.

The view also reports `blind`, which replaces the separate `floorUnreadable`
branch: an unreadable floor is a missing **lower** bound, and a lower bound
cannot lower anything, so once the sources in hand reach the limit the hidden
record could only agree. Consumers stop asking "unreadable?" and ask "can the gap
still change the answer?".

Consumers, all taking the one view:

| Consumer | Before | Now |
| --- | --- | --- |
| `assessRestructure` | its own `mergeFindingHeads` + a `floorUnreadable` branch | takes the view; `blind` decides |
| `preserveMetrics` | preferred run metrics | merges both records |
| `publishFindingOutcome` | re-read to rediscover the head | declares `currentHeadHasFindings` |
| `acceptedDeferral` | `assessConvergence` on a fresh live read | passes the view's count through |

`assessConvergence` gained an optional `findingHeadCount`. It takes the **max** of
that and its own live read, so a supplied floor can only ever *raise* the
obligation — no caller can weaken convergence by passing a small number (`V5b`).

The deferral is now asked **before** anything about the floor. The exemption holds
on both sides of the cap — under it there is nothing to exempt, over it the
deferral governs — so no hidden record can change the answer and there is nothing
to be blind about. The old ordering let the blind branch fire first and draft a
head whose outcome was never in doubt.

The runbook's recovery `jq` gains `review: restructure check undecided`. But the
reason that line was missing is that the same fact lives in two files, so `V7`
pins them to each other in both directions: every description the runbook calls
retryable must be retryable in code, and every literal the code compares must
appear in the runbook. The next status added to one and forgotten in the other
fails there.

## Review unit

| | |
| --- | --- |
| Base SHA | `503b10c` (`main`) |
| Replaces | #260 |
| Concern | one: a single authoritative finding-head evidence view, and the gate that consumes it |
| Migrations | none |
| Product surface | none — `scripts/`, `AGENTS.md`, `docs/` |

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | None — no auth, membership, org or project scoping touched. The gate acts only on its own PR under the existing trusted-workflow identity | No route, policy, guard or tenancy code in the diff |
| civil-time-lifecycle | `nextMetrics` stamps `firstSeenAt`/`elapsedMinutes`; if elapsed time gated, a slow review would become a deadline that pressures rushed heads | Elapsed time stays telemetry — only the head count gates (`L11`/`L11b`, unchanged). `mergeRecordedMetrics` keeps the **earliest** `firstSeenAt` |
| concurrency-idempotency | The precondition runs more than once per run and across reruns; no read may lower a crossed count | `E2`, `E2b`, `E2c`, `V1`, `V4`. The view unions; `setLifecycleMetrics` merges; `preserveMetrics` merges |
| data-integrity-conservation | The finding record is what is conserved; a partial read, a dropped block, a duplicate comment or a preferring writer destroys it | `V1` (partial read cannot hide a head), `V3` (crossing head survives a partial re-read), `V4` (smaller run reading cannot rewrite a larger floor), `E4` (both sticky paths paginate), `V2`/`E7` (unreadable ≠ absent) |
| offline-reconciliation | None — no client outbox, IndexedDB or replay path touched | No `apps/web` source in the diff |
| ui-server-parity | None — no UI or API surface changed | Diff is `scripts/` + `AGENTS.md` + `docs/` |

## Verification

`scripts/review-lifecycle-enforcement.test.mjs` — **26/26**.

Round-2 probes:

| Probe | What it pins |
| --- | --- |
| `V1` | the view unions recorded + live + the known crossing head; a clean head is never invented |
| `V2` | `blind` only where the gap could still change the answer |
| `V3` | a partial re-read cannot let the crossing head buy another correction round |
| `V4` | a smaller run reading cannot rewrite a larger recorded floor downward |
| `V5` | `assessConvergence` accepts a durable floor |
| `V5b` | a supplied floor can only raise the obligation, never excuse a head |
| `V5c` | the **gate** passes the floor to the deferral consult |
| `V6` | a deferred unit is not blocked by an unreadable floor |
| `V7` | runbook and code agree on what is retryable, in both directions |

### Discrimination — each fix reverted in turn

| Reverted | Probes that failed |
| --- | --- |
| funnel stops carrying the crossing head | `V3` |
| `preserveMetrics` prefers again | `E2c`, `V4` |
| deferral consult drops the floor | `V5c` |
| blind branch pre-empts the deferral | `E7`, `E8`, `E8b`, `V6` |
| runbook omits the undecided status | `V7` |
| — restored — | **26/26** |

**`V5c` exists because the first attempt was not discriminating.** `V5` proves
`assessConvergence` *can* take a floor, which is not the same as the gate handing
it one — with the wiring reverted, the suite still passed. That is a probe testing
itself, the same error made once before in this lineage, and it is recorded here
rather than quietly repaired. `V5c` drives `enforceRestructure` and fails when the
wiring is removed.

| Gate | Result |
| --- | --- |
| focused suite | **26/26** |
| `scripts/review-lifecycle.test.mjs` (part-1 policy) | **20/20**, unchanged by the refactor |
| `pnpm test:automation` | **197/197** |
| `pnpm check` | **EXIT 0** (web 543/543, API 680/680) |
| Migrations | none |

## Carried forward from #260 — nothing dismissed

Every finding from both #260 rounds is resolved here, not dropped. Round 1's
three (the post-review cap re-check, the live-evidence exception on an unreadable
floor, and preserving docs-only probe deferrals) are carried in full; round 2's
five are the subject of this restructure. Restructuring moves where a finding is
answered, never whether it is.

## Honest notes

- `E5` is a **structural** pin: it asserts the precondition ordering as written in
  the source, not as executed. The behavioural half is `E1`/`E1b`/`V3`.
- `E8b`/`V5c` derive their phase from `deferralPhases(loadStatusDocument())` — the
  same source the gate reads — so they track `docs/STATUS.md` rather than pinning
  a phase number that legitimately changes.
- The threshold is unchanged at five finding-bearing heads. The owner's review-size
  directive replaces it with a three-head code rule; that reconciliation belongs to
  that PR, and leaving two caps disagreeing is exactly the collision part 1 removed
  the docs/code classifier to avoid.
