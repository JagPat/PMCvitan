# Phase 5 Task 7B-iii-c-i — the verification chain (§E/§F)

Branch `claude/phase5-task7b-iii-c-i`, from `main` `2671744`.

## Vision alignment

One project is one site, and one fact has one canonical owner. A vendor's claim is
a record someone will be paid against, so §E puts the three-way check between the
claim and the money: measured/received evidence, the ordered terms, and the amount
claimed. This unit surfaces the two commands that run that check — nothing more.

The alignment decision worth naming is what is **absent**. Neither command takes a
verdict as input. §E derives the triple server-side on every call, and `verify`
records what the check found; a form offering a verdict would be inventing one and
attaching a human's name to a machine's conclusion — or worse, letting the human
overwrite it silently. What the screen contributes is *when the transition may be
offered*, and nothing about *what it concludes*.

The second is **who**. `commercial.verify` is pmc-only, and it is the first
commercial permission an `engineer` holding `commercial.bill` does not have. The
actor who lodges and submits a claim cannot verify it. That separation is this
unit's subject, and the probes treat it as such rather than as a formality.

## Scope

| | |
|---|---|
| Files | 12 |
| Changed lines | ~780 |
| Budget | 20 files / 1,500 lines — inside, marker not used |
| Schema / migration | none |
| New server behaviour | none (two inline literals replaced by the shared constants the services now read) |

### Why 7B-iii-c was split first

The scheduled unit was five actions: `begin-verification` · `verify` · `certify` ·
`certificates/supersede` · `bills/sod-grant`. 7B-iii-b cost 25 findings over seven
heads for a scoping error, and the rule it bought is *split along the dependency,
then walk each half end to end — the test is not "is this coherent code" but "can
a user finish something with only this".*

Applied here:

- **7B-iii-c-i (this unit)** — `begin-verification` → `verify`. Both read the §E
  triple 7B-ii-a already serves, neither takes an operator input, neither touches a
  certificate. End to end: a submitted claim reaches a recorded verdict and lands in
  `verified` or `disputed`. That is a finishable thing.
- **7B-iii-c-ii** — `certify` · `sod-grant` · `supersede`. `certify`'s one blocking
  failure mode is separation of duties, and `sod-grant` is its remedy. Shipping them
  apart would be the 7B-iii-b mistake again: a button whose only failure the user has
  no way to clear.

7B-iii-c-ii also needs contract work before its guard can be written. SoD state is
not exposed in any DTO — `CertificateDto.sodException` records the exception on an
*already-created* certificate, which is the wrong end of the transaction — and the
server rule has three distinct refusals (no grant; a granter who has since lost pmc
standing; a grant made against an earlier claim version). That is 7B-iii-e's root
applied *before* the code rather than after it.

## Invariant matrix

| # | Invariant | Where it is enforced | Probe |
|---|---|---|---|
| 1 | A transition is offered only where the **service** admits it | `BILL_BEGIN_VERIFICATION_FROM` / `BILL_VERIFY_FROM` in `@vitan/shared`, read by `commercial-bill.service.ts` **and** `commercial-verification.service.ts` **and** the screen | `commercial-verification.test.ts` — the per-status table + two source tripwires; `commercial-screen.test.tsx` — "offers each transition exactly where the SERVER admits it" |
| 2 | A control never acts on a claim copy that may be **older** than another read's | `arbitrateBillCopy` in `lib/billLifecycle.ts`, called by the Claims tab **and** the Certification tab | "reads the ARBITRATED status, not the claim copy it renders" |
| 3 | Two reads that **cannot be ordered** decide nothing | same, ambiguity branch — equal stamp + differing status, and an unparseable stamp | "EQUAL stamp + DIFFERING status is undecidable"; "an UNPARSEABLE stamp orders nothing"; "refuses BOTH transitions while the two reads are undecidable" |
| 4 | One claim is one constrained resource: no two transitions in flight | `commercialWriteBlocked`, deriving the conflicting set from the **key shape** | "a pending transition blocks EVERY other transition on the same claim, both directions" |
| 5 | Authority is checked where the command is **durable**, not only where it is shown | `COMMERCIAL_OP_PERMISSION` in `dispatchCommercial` + `mayVerify` on the screen | "an ENGINEER queues nothing"; "is ABSENT for an engineer" |
| 6 | A key clears only on the read that makes its effect **visible** | `readClearsKey`, per-read ownership + the hoisted `observedWrite` | the three stale/fresh read probes |

## The two structural corrections

Both are in this unit's own blast radius. Neither is a drive-by.

### 1. The arbitration rule is now shared, because this unit adds the second surface

PR #306 spent rounds 4–7 arriving at how to choose between the claim-list copy of a
bill's status and the per-claim bundle's copy. The answer: compare the server's own
`statusChangedAt`, and where that cannot order them — equal stamp, differing status,
which `new Date()` at millisecond precision makes reachable — refuse to decide,
show the list copy, and disable the claim's transitions until a fresh read resolves it.

That rule lived as an expression inside the Claims tab's row map. This unit puts
transition controls on the **Certification** tab, which renders `claim.bill` — the copy
that can be the older one. Gating on it alone would have offered "Begin verification"
on a claim the list already shows as `under-verification`, and the write-ahead outbox
would have reported that saved before a terminal 409 dropped it.

So the rule moved to `lib/billLifecycle.ts` as `arbitrateBillCopy` +
`transitionOffered`, and both surfaces call it. `transitionOffered` deliberately
carries **both** terms — the admissible set and the ambiguity — because the ambiguity
term is precisely the part a second control forgets, and there is now nowhere else to
ask. One rule cannot disagree with itself.

Extracting it also surfaced a case the inline version answered silently: an
unparseable `statusChangedAt` makes `Date.parse` return `NaN`, every comparison false,
and the code falls through to whichever copy it names last. That is deciding anyway,
by a different route. It is now reported as undecidable.

**Still deferred, and still named:** a monotonic per-bill lifecycle version from the
server is the durable fix for the equal-stamp ambiguity. Refusing to decide is sound
without it. It is a schema change and belongs in its own unit.

### 2. `observedWrite` is hoisted — and what that is and is not, stated plainly

Codex's Q-a finding on PR #306: a read may only release a coalesce key if it could
have *observed* the write. A per-resource token orders reads against each other and
says nothing about causality. The fix landed as a field on the `lineRegister` variant
of `CommercialRead` — which made causality a property of **one read** rather than of
reading. The `money`, `bills` and `claim` variants carried no causality term at all,
and `com:billtx:` keys — the ones this unit adds two more of — are released by
`bills` and `claim`.

It is now a required field on every variant. The compiler is the enforcement.

**What this is not.** I wrote a store-level probe to reproduce the gap: hold a claim
read across a settling `begin-verification`, assert the key survives. **It passed with
the guard mutated out.** The reason is that the flush reconcile unconditionally
re-reads the money, the claim list and every open claim after any commercial write
settles, which bumps each per-resource token; the held read then loses *ownership* and
applies nothing at all. On today's four read paths the two defences overlap, and a
probe through the store cannot separate them.

So the probe is relabelled as the ownership probe it actually is (and verified RED
against the ownership guard), the causality rule is pinned where it *is* decidable —
at `readClearsKey` — and the hoist is presented as what it is: a type-level invariant
for the next read path that does not go through the reconcile (a socket handler, a
manual Retry, a fifth resource), not a fix for a defect I can demonstrate today.

## Evidence

### Reproduce-first, mutation-verified

Every probe below was verified RED by removing exactly its own mechanism, and the
mechanism restored before the next mutation. A probe that survives its own mutation
is measuring something else — which is how the store-level causality probe above was
caught.

| Mutation | Probes that went RED |
|---|---|
| `arbitrateBillCopy` breaks the equal-stamp tie toward the claim copy | "EQUAL stamp + DIFFERING status is undecidable"; "a transition is offered only where the SERVER admits it, and never while ambiguous" |
| drop the hoisted `observedWrite` guard (register's own retained) | the three stale/fresh read probes |
| restate the conflict verb list instead of deriving it from key shape | "a pending transition blocks EVERY other transition on the same claim" |
| drop the two `commercial.verify` permission entries | "an ENGINEER queues nothing" |
| drop the two op types from `COMMERCIAL_OUTBOX_OP_TYPES` | "replays each queued command…and reconciles the claim after"; "the two op types are commercial ops" |
| service restates `from: ['submitted']` instead of the shared set | "`commercial-bill.service` guards begin-verification with the SHARED constant" |
| Certification gates on the claim copy alone | "reads the ARBITRATED status"; "refuses BOTH transitions while undecidable" |
| drop the `mayVerify` authority gate | "is ABSENT for an engineer" |
| drop disable-while-pending on the chain | "disables the whole chain while ANY transition on this claim is pending" |
| `verify` offered from the begin-verification set | "offers each transition exactly where the SERVER admits it"; "reads the ARBITRATED status" |
| drop the per-resource ownership token on the claim read | "a SUPERSEDED read applies nothing and releases nothing" |

### Gates

- `pnpm check` — **EXIT 0** (web 675/675 across 45 files, API 780/780 across 57 files, lint + typecheck + both builds clean)
- `commercial-verification.test.ts` **18/18**, `commercial-screen.test.tsx` **59/59**, `commercial.test.ts` unchanged and green
- API integration, focused: `phase5-t4-vendor-bill` · `phase5-t5a-verification` ·
  `phase5-t6b-status-derivation` · `phase5-t7bii-claim-read` **122/122**;
  `phase5-t1-commercial` · `commercial-catalog-closure` **43/43**
- Full API integration suite on a pristine migrated database — see the PR body for the run
- No migration, so `upgrade-proof.sh` is not applicable
- Browser e2e (`e2e`, `api-e2e`) runs in CI; the local Chromium build does not match the pinned Playwright revision

## What is deliberately not here

- **`certify`, `sod-grant`, `supersede`** — 7B-iii-c-ii, for the reason above.
- **`amend`** — wired in the gateway and the store since 7B-iii-b, still not surfaced;
  an amendment carries a full replacement line set and belongs with the claim-editing
  surface, not a transition row.
- **A dispute action** — there is deliberately no `dispute` route. §E is explicit that
  an exception does not auto-reject and a dispute is never a decision someone takes
  directly: it is what `verify` records when the check finds one.
