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
| Files | 17 |
| Changed lines | 1,141 |
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

Measured on the FIRST head (`0240338`); the corrected head's figures are in the correction
section below, and supersede these where they differ.

- `pnpm check` — **EXIT 0** (web 684/684, API 781/781)
- API integration, focused: `phase5-t7bii-claim-read` **20/20**, `phase5-t5b-certification` **47/47**
- Full API integration suite on a pristine migrated database — **86 files / 1041 tests**, exit 0
- Migration verified applying **from scratch** on a clean database, producing both the column and the widened index

**One boundary stated honestly:** probe h5 exercises the diagnostic's *logic* against real
rows. That it runs at *deploy* time is a property of the migration file, which CI applies
from scratch on every head — I did not stand up a separate deploy-time abort harness for a
nullable additive column whose diagnostic is a safety stop.

---

## Correction round 1 — five Codex findings, and three of them are one root

Findings 1, 3 and 4 are the same defect in three costumes, and it is the root PR #310's
audit names FIRST: **I added the evidence to the COLUMN and stopped there.** Every guard
that already surrounded `SodGrant` — the trigger that freezes its fields, the seal that
judges a consumed one, and the OTHER resolver next door — kept working exactly as if the
new fact did not exist.

That is not a coincidence of three separate oversights. It is one habit: *fix the instance
a finding names, not the class it belongs to.* This table's own migration comments already
record it happening twice before (Task 5's rounds 7→8, Task 6A's round 3), and this unit
managed it again on the artifact introduced to close a finding.

| # | Finding | Fixed as a CLASS, not an instance |
|---|---|---|
| 1 (P1) | `reviewedStatus` outside `phase5_t5_grant_append_only`, so a direct writer could rewrite what an approver reviewed | the column joins the frozen set — the rule ("immutable apart from its one-way consumption") is unchanged, only the field list |
| 3 (P1) | `CommercialPaymentService.resolveSodGrant` ignored the reviewed state | the two near-identical resolvers become **ONE** (`commercial-sod.ts`) read by both §I halves, so the next fact added cannot reach one half and miss the other |
| 4 (P1) | the PostgreSQL seals matched a grant by version alone | ONE constraint trigger on the transition **every** consumption arm passes through — a third target would inherit it rather than need a third copy |
| 2 (P2) | the diagnostic could abort *after* `ADD COLUMN`, making its own instructed retry impossible | `ADD COLUMN IF NOT EXISTS` |
| 5 (P2) | the panel enumerated three of four states, so `stale-review` rendered an empty card | an exhaustive `Record<SodGrantState, …>` over a shared runtime state list — a sixth state without a message is a **compile error** |

### The seal states what is invariant, because the service cannot

The service compares the reviewed state to what is true *now*. The database cannot: by
COMMIT the act has already moved the claim on (a certification leaves the bill `certified`,
not `verified`). So the durable rule is the part that does not move — **a grant may only be
spent from a state its rule can legitimately proceed from** — with the admissible sets in
`phase5_t7biiih_admissible_reviewed_states` and pinned to the shared TypeScript constants by
probe h8. An unknown rule admits nothing: a third §I rule added without teaching this
function is refused rather than waved through.

`ADD COLUMN IF NOT EXISTS` is worth one more sentence, because it looks like caution and is
not: the closing diagnostic deliberately aborts the deploy *after* the column exists, and
instructs the operator to clear the grants and redeploy. Without it that replay dies on
duplicate-column — the migration would have made itself unrepairable by the very diagnostic
that exists to repair it.

### Correction evidence — every probe RED first

| Probe | Reproduced RED at `0240338` |
|---|---|
| h6 — the append-only trigger freezes `reviewedStatus` | the UPDATE **committed** |
| h7 — a certificate cannot rest on a grant recorded at a state it never certified | the bypass **committed**, leaving exactly the state finding 4 describes |
| h8 — the SQL mirror IS the shared TypeScript set | the function did not exist |
| h9 — the column addition is rerunnable | `42701 column "reviewedStatus" already exists` |
| PROBE 25 — a payment authorisation must match the reviewed state | the approval **succeeded** |
| PROBE 26 — an approval cannot rest on a grant recorded at a state it never approved | the bypass **committed** |
| screen — every §I state is legible | `stale-review must SAY something: expected '' to be truthy` |

Two things about h7/PROBE 26 stated plainly rather than buried. They disable **one named
trigger** inside a transaction and re-enable it before that transaction ends, so the seal is
restored on the way out or the DDL rolls back with the abort. That is not a shortcut around
a service check — it is the *only* way to reach the state the finding describes, because the
service refuses to create it and `SodGrant_append_only` refuses to edit a consumed grant at
all. A database seal exists for exactly that writer, so that is the writer the probe uses.
`SET CONSTRAINTS ALL IMMEDIATE` is load-bearing too: PostgreSQL will not ALTER a table with
pending trigger events.

**Gates on the corrected head:** `pnpm check` **EXIT 0** (web 685/685, API 781/781); the full
API integration suite on a pristine migrated database; `upgrade-proof.sh` **PASSED**, with the
whole ledger re-applied from scratch and four new §I assertions (a live grant may record any
state; rewriting it is refused; spending one recorded at `submitted` is refused; spending a
legacy NULL one is refused) — each pinned to the message of the seal it names, so none can
pass because a different seal refused it first.

**One boundary stated honestly, again.** The upgrade proof covers the seal's **certificate**
arm. Reaching the **approval** arm there needs a coherent grant→exception→approval chain, and
that legacy fixture's only approval is one §I permits outright — so an assertion would be
refused by the biconditional first and prove nothing about the seal it names. PROBE 26 proves
that arm against live PostgreSQL instead. This is the same reasoning the script already
records for §G bound 5's approval-scoped half.

**One equivalence claimed as an equivalence, not a fix.** `grantSodException` now chooses the
excused actor's required permission BY RULE (`commercial.approve-payment` for the payment
half) instead of always asking about `commercial.certify`. Both resolve to `pmc` today, so
this changes no behaviour — it stops a future divergence in one policy from silently
validating the wrong one, which is the same correction-did-not-travel-to-the-sibling shape
this file has now paid for three times.

**One cleared fixture changed:** Task-5's `R9` granted to a stranger merely as "a different
actor". A stranger holds no membership and so cannot certify, which this unit's command now
refuses at issue, so the fixture names a certifier — keeping the probe about the consume
seal it is titled for.

---

## Correction round 2 — three findings, and the deferral that came due

Full audit: `docs/reviews/pr-312-convergence.md`. Three roots, only one of them new.

| # | Finding | Fix |
|---|---|---|
| R2-2 (P1) | a RECYCLED status label revives a spent-past authorisation | `VendorBill.lifecycleVersion` — a monotonic per-claim counter, bumped by a trigger, recorded on the grant and the second term of every reviewed identity |
| R2-1 (P2) | the legacy diagnostic counted EVERY unconsumed grant, so its own instructed repair aborted the retry | the predicate is `reviewedStatus IS NULL` — which is what "legacy" actually means |
| R2-3 (P2) | the live-version lookup sat above the bill lock | the lock comes first, and the version is read under it |

### R2-2 is the carried deferral, paid

§F **derives** the payment status from the folds, and the derivation returns to labels it
has left. Certify ₹100 withholding ₹10 → `certified`; approve and pay the ₹90 → `paid`;
release ₹5 → `certified` again. An authorisation given at the first `certified`, when
nothing was approved, matches the label at the second — by which time ₹90 has been
authorised and has left the practice.

JagPat's directive on PR #306 had already named the general form ("expose a monotonic server
lifecycle version, or treat … as ambiguous"), and it was carried as a deferral. Codex reached
the same requirement independently. Two independent readers naming one missing primitive is
the signal to stop deferring it, so `lifecycleVersion` ships here.

**It is bumped by a trigger, not by the services.** There are six writers of
`VendorBill.status` across four services; a line in each is precisely the instruction this
PR's audit is about nobody remembering. The same trigger refuses any direct write of the
column, so a stale pin cannot be made to match by moving the claim rather than the
authorisation.

`reviewedLifecycleVersion` joins the append-only frozen set and the live-scope unique index
for the reasons already written into both — and in the index it is **load-bearing rather than
symmetric**: a re-authorisation after a recycle carries the identical status, so without the
counter in the scope the inert row would collide with its own legitimate replacement, and the
fix for the hole would have created the deadlock the index exists to prevent. PROBE 27's legal
path is what proves that half.

### Correction-2 evidence

| Probe | Reproduced RED at `a805d47` |
|---|---|
| PROBE 27 — a recycled label does not revive a spent-past authorisation | the approval **succeeded**; with the version term mutated out of `reviewHolds` it succeeds again, so the probe is load-bearing on the fix and not on its neighbours |
| PROBE 28 — the counter is monotonic across every status writer, unmoved by non-status writes, and not rewindable | the column did not exist |
| h5 — the diagnostic is quiet with a well-formed live grant | it **fired**, aborting the replay its own remedy instructs |
| h10 — the live version is read under the bill lock | the read was 664 characters ABOVE the lock |

**Gates on this head:** `pnpm check` EXIT 0 (web 685/685, API 781/781); the full API integration
suite on a pristine migrated database; `upgrade-proof.sh` PASSED with the whole ledger applied
from scratch; the migration verified applying from scratch on a clean database.

---

## Correction round 3 — the counter tracked the label, and the label is not the money

Four P1s, one sentence. Full audit: `docs/reviews/pr-312-convergence.md`.

| # | Finding | Fix |
|---|---|---|
| R3-1 (P1) | the counter advanced only on §F status transitions, so a retention release moving ₹90 → ₹95 left it unmoved | it is now the claim's COMMERCIAL REVISION — one trigger on each of the **six** tables feeding §F's three folds, enumerated and asserted by PROBE 30 |
| R3-4 (P1) | the command compared version/status and then recorded the DATABASE'S CURRENT revision as "what was reviewed" | `lifecycleVersion` is REQUIRED at the boundary, compared under the bill lock, and the **approver's** pin is what gets persisted |
| R3-2 (P1) | the consume seal never compared revisions, so a claim returning to `verified` later still satisfied it | the ACT records the revision it was performed at (`BillCertificate`/`PaymentApproval`), and the seal requires the two frozen columns equal |
| R3-3 (P1) | the aborting diagnostic ran before the guards, so the legacy path could commit the evidence columns with neither the widened index nor the freeze installed | every guard is installed first; h11 pins the ordering against the file itself |

**Why §F's label cannot carry this.** Its first two arms are `NET_PAYABLE = PAID` and
`APPROVED = 0`, so a claim with nothing approved reads `certified` at any payable at all. A
release raises what is owed and moves no label. The reviewed identity therefore has to advance
on **anything a reviewer would have seen**, which is what the six fold triggers give it.

**One correction to round 2's own reasoning, stated because it was written down.** That packet
argued the DB seal *could not* compare revisions, since by COMMIT the act has moved the claim
on. The premise was true and the conclusion did not follow: the act can carry what it saw. It
does now.

### Correction-3 evidence

| Probe | Reproduced RED at `81aa65c` |
|---|---|
| PROBE 29 — a release that moves the money but not the label staleness the authorisation | the approval **succeeded** |
| PROBE 30 — all six fold sources move the reviewed identity | only `BillCertificate` did, via its status transition |
| h11 — guards installed before the aborting diagnostic | the index was 1,844 characters BELOW the abort |
| h12 — the approver pins the revision they reviewed | the boundary accepted a grant with no revision pin, and the server recorded its own |

**Gates on this head:** `pnpm check` EXIT 0 (web 685/685, API 781/781); focused
`phase5-t7bii-claim-read` + `phase5-t6a-payments` **57/57**; full API integration on a pristine
migrated database; `upgrade-proof.sh` **PASSED** — which caught the new fold trigger joining
`PaymentReversal`'s exhaustively-enumerated trigger set, exactly as that assertion intends.

**Two things stated rather than implied.** (1) h10 is a STRUCTURAL probe of the read order, and
the interleaving Codex describes is **not reachable today** — `grantSodException` and `amend`
both take `lockProjectReadiness` and are already serialized. What was wrong is that the pin's
correctness rested on a lock taken elsewhere for another reason; that is worth fixing and it is
not the same as having closed a live hole. (2) The DB consume seal still checks the admissible
reviewed *state* and not the lifecycle version, because at COMMIT the act being sealed has
already moved the claim on. The division is the one this phase has used throughout — the seal
states what is invariant, the service states what is fresh — and PROBE 27 is where the
freshness rule is proven.
