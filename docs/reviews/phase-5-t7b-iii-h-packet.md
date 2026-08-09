# Phase 5 Task 7B-iii-h — a §I grant records the state it was justified against

Branch `claude/phase5-task7b-iii-h`, from `main` `8e33f2c`.

## Vision alignment

§I's exception exists so a two-person site can operate without the separation-of-duties
rule being quietly relaxed: the override is legitimate *because* it writes an
attributable record of who authorised what, and why. **That record has to carry evidence
of what it was justified against, or it is not a justification — it is a permission
slip.** This unit closes the gap between those two things.

## Scope

| | |
|---|---|
| Files | 8 |
| Changed lines | 285 |
| Budget | 20 files / 1,500 lines — inside |
| Schema / migration | `SodGrant.reviewedStatus` (nullable) + `20270705000000`, additive and diagnostic-first |

### Split before writing

Re-applying the parked §I surface plus its three findings measured at **~18 files /
~1,300 lines** — near both ceilings, on a unit whose predecessor (#310) hit the review
head limit at five finding-bearing heads. So it was split *before* any code, on the seam
that has worked twice in this phase (7B-ii-a/7B-ii-b): **each half provable by one kind
of evidence.**

- **7B-iii-h (this unit) — the server.** Live-PG integration tests.
- **7B-iii-g — the client surface** (picker, form, and R5-1's pending-transition block in
  the screen *and* the dispatcher). Store and render tests.

The dependency runs h → g: the client cannot pin what the contract does not carry.

## The defect

`SodGrant` pinned the claim **version**. One version walks
`submitted → under-verification → verified` **without changing id**, so an authorisation
given before the §E verdict existed survived into `verified` and could be spent to
certify a verdict its approver never reviewed. The version says *which* claim; it does
not say *what was true* about it.

The fix records the reviewed state on the grant **and re-checks it where the authority
is spent**. A check at issue proves nothing at consumption, which is where the authority
is actually exercised — that asymmetry is the whole finding.

`stale-review` joins `grantState`, kept distinct from `approver-lost-standing` because
the two need different remedies: one needs re-authorising against what is true now, the
other needs a different pmc.

## The migration refuses to guess

Additive and **nullable**, with no back-fill. Filling a legacy row with the bill's
*current* status would fabricate evidence that an approver saw something they may never
have seen — on the exact register whose purpose is attributable human authorisation.

So legacy rows keep NULL, `resolveGrant` treats NULL as **unusable** (the safe
direction), and a closing `DO` block **stops the deploy** on any unconsumed legacy grant
rather than silently revoking live authority. Consumed grants are history and unaffected —
they already did their work under the old rule.

## The gap my own fix created, found by probing the legal path

Asking *"does re-authorising restore it?"* — the question rule 3 exists to force — showed
that a `stale-review` grant could **never be replaced**: the live-scope unique index did
not know the new way a row becomes inert.

The index's own comment already records this lesson. Codex round 9 added `approverId` to
its scope for exactly the same reason:

> the stale row is inert rather than dangerous … what the index must not do is let that
> inert row block a valid one.

`reviewedStatus` creates a second way to be inert, so it joins the same scope. Without it
the remedy for a stale review is unreachable — worse than the hole it closes.

## PR #310's four rules, asked up front

| Rule | Applied here |
|---|---|
| 1 — fix the class, not the instance | the reviewed-state check lives at **resolution**, where every consumer passes, rather than only at the one call site the finding named |
| 2 — never approximate a server authority decision | the **excused actor's** `commercial.certify` standing is checked at the COMMAND, not just hidden in a picker: a grant is an authority between two people and both are now modelled |
| 3 — probe what the fix must preserve | every probe asserts the legal path; h2 asserts re-authorisation **restores** the grant, which is what surfaced the index gap |
| 4 — one contract per threat model | the pins are REQUIRED at the HTTP boundary; `GrantSodExceptionCommand` carries the weaker internal shape for the 121 in-process callers |

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | a grant naming someone who cannot certify is an authority that can never be exercised — recorded, displayed, and refused by a different rule when used | checked at the command via `hasProjectRoleStanding` under `FOR UPDATE`; probe h3, RED when the guard is removed |
| civil-time-lifecycle | one version spans the whole §E lifecycle, so a version pin does not identify what was reviewed | `reviewedStatus` recorded and re-checked at resolution; probe h2 (authorise at `submitted`, verify, refuse, re-authorise, allow), RED when resolution ignores the record |
| concurrency-idempotency | a re-authorisation after the state moves must be a new command, not an idempotent replay, and must not be blocked by the inert row it replaces | the pins change the request hash; `reviewedStatus` joins the live-scope unique index; h2 exercises both |
| data-integrity-conservation | back-filling a legacy grant would fabricate an approver's review | nullable, no back-fill, NULL treated as unusable; probe h5 — the diagnostic fires on an unconsumed grant and is quiet without one |
| offline-reconciliation | n/a in this half — no client, no outbox surface. R5-1's pending-transition block is 7B-iii-g | stated rather than implied |
| ui-server-parity | a boundary weakened so in-process callers compile skips the guard where the risk lives | `grantSodExceptionSchema` requires the pins; `GrantSodExceptionCommand` is the internal shape; probe h4 |

## Evidence

| Mutation | Probe that went RED |
|---|---|
| the reviewed state is not RECORDED (`reviewedStatus: null`) | h1, and 6b/6c/6d/6e — the whole preflight family |
| resolution ignores the recorded state (checked at issue only) | h2 |
| the excused actor's certify standing is not checked at the command | h3 |

- `pnpm check` — **EXIT 0** (web 684/684, API 781/781)
- API integration, focused: `phase5-t7bii-claim-read` **20/20**, `phase5-t5b-certification` **47/47**
- Full API integration suite on a pristine migrated database — **86 files / 1041 tests**, exit 0
- Migration verified applying **from scratch** on a clean database, producing both the column and the widened index

**One boundary stated honestly:** probe h5 exercises the diagnostic's *logic* against real
rows. That it runs at *deploy* time is a property of the migration file, which CI applies
from scratch on every head — I did not stand up a separate deploy-time abort harness for a
nullable additive column whose diagnostic is a safety stop.

**One cleared fixture changed:** Task-5's `R9` granted to a stranger merely as "a different
actor". A stranger holds no membership and so cannot certify, which this unit's command now
refuses at issue, so the fixture names a certifier — keeping the probe about the consume
seal it is titled for.
