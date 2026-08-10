# Phase 5 Task 7B-iii-d — deduct, approve, pay (the payer's authority chain)

## What this unit is

The last of the four 7B-iii units, and the point where money leaves. Six commands on the Payments
tab: record and release a withholding, approve, pay, reverse, and pay an advance.

## Review unit

- **Base SHA:** `de9fbb6`
- **Changed files / changed lines:** 6 / ~700 — **within both budgets, one unit**
- **Schema:** none. No migration, no API change. Client surface over already-cleared server facts.

## The one fact that shaped every key

**All six commands are §F FOLD SOURCES.** A withholding moves `NET_PAYABLE`; an approval moves
`APPROVED`; a payment and a reversal move `PAID`. §F derives the claim's status from those three
folds, and 7B-iii-h made the claim's monotonic revision advance on **every write that touches any of
them**.

That is not a fact about status labels. It means **any of the six invalidates a queued `approve`**,
because an approval PINS `lifecycleVersion` and the server refuses it if the claim has moved. R5-1
was this shape one unit ago for §I grants; here it is the general case, so the conflict rule is
written from the fold rather than from a verb list.

## Each key names its action; the conflict rule names its resource

This repository's rule, at its fifth instance. Getting the resources right *is* the design:

| Command | Key | Constrained resource | Why |
|---|---|---|---|
| record deduction | `com:deduct:<bill>` | the CLAIM | a withholding draws on certified headroom (§G bound 3) |
| release deduction | `com:release:<deduction>` | the WITHHOLDING | two releases race one unreleased balance; different withholdings are independent |
| approve | `com:approve:<bill>` | the CLAIM | approvals race one net payable (§G bound 4) |
| record payment | `com:pay:<approval>` | the APPROVAL | §G bound 5 caps paid at what **that** approval authorised |
| reverse | `com:payrev:<payment>` | the PAYMENT | two reversals race one paid amount |
| pay advance | `com:advance:<vendor>` | the VENDOR | an advance names no claim, so it conflicts with none |

The advance being claim-independent is **asserted, not assumed** — "it is money, so it must
conflict" is the plausible wrong answer, and a probe pins it.

### The half the key alone cannot see, stated rather than hidden

`commercialWriteBlocked` matches on key shape, so it can see a pending deduction or approval on a
claim (both keyed by bill) but **not** a pending payment or reversal (keyed by approval and payment).
Only the screen holds the claim's own approval and payment ids, so it closes that half. The division
is documented in `isClaimMoneyPending` and probed from both sides — a rule that silently cannot see
two of its six members would be worse than one that says so.

## Six distinct permissions, asked separately

`commercial.deduct` · `.deduct.release` · `.approve-payment` · `.record-payment` ·
`.reverse-payment` · `.pay-advance` — verified from the controller decorators. All resolve to `pmc`
today and are still named separately in `COMMERCIAL_OP_PERMISSION` and on the screen, exactly as
`certify` and `sod.grant` are: the policy is the source, not a copy of its current answer, and a
later widening of one must not silently widen five.

**The 7B-iii-g F6 lesson is carried:** no control derives authority client-side. Each asks `may()`
for its own permission and the durable dispatcher re-checks it.

## Evidence

| Probe | What it holds |
|---|---|
| a pending fold write BLOCKS an approval, whichever fold it moves | the general rule, over deduction / transition / approval, plus the dispatcher refusing |
| …but a fold write on ANOTHER claim blocks nothing here | the rule is claim-scoped, not global |
| a withholding yields to a transition and **not** to an approval | approving does not change what may be withheld — the conflict is not invented |
| release, pay and reverse are keyed by the row they draw down | different rows independent, same row coalesced |
| an advance is vendor-scoped and conflicts with no claim | the plausible wrong answer, refuted |
| every one of the six settles on the claim read that carries its ledger | and a row the read did **not** carry is not settled by it |
| each command takes its OWN permission | an engineer holds none of the six |
| screen: will not approve while any fold write is in flight, **and says why** | the same rule, from the UI side |
| screen: …including a payment or reversal, whose keys name a child row | the half the key cannot see |
| screen: payment names its authorisation, reversal names its payment | §G bound 5's structure in the form |
| screen: the whole surface is absent for a role holding none of the six | absent, not merely disabled |

## Two things the build caught that are worth recording

1. **`BillPaymentLedgerDto` has no `payments` field** — payments hang off the `PaymentApprovalDto`
   that authorised them, which *is* §G bound 5's structure. I had assumed the flatter shape; the
   contract corrected both the screen and my fixture.
2. **A blanket rename collided with `labourKeys.ts`.** `releaseCoalesceKey` already existed there
   for labour allocations; mine is now `deductionReleaseCoalesceKey`. The collision was real (esbuild
   caught it) and the first fix damaged the labour call site — caught by its own suite, and the
   reason the name is now specific rather than generic.

Reads on the payer surface are defensive (`?? []`) even though the contract requires the arrays:
this bundle arrives over the network, and a partial body on a **money** surface must degrade to "no
controls offered", never to a thrown render that takes the whole ledger off screen.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | six permissions is six chances to model authority client-side, or to collapse them into one answer | each control asks `may()` for its own permission; `COMMERCIAL_OP_PERMISSION` maps all six so the DURABLE dispatcher refuses; an engineer queues none of the six |
| civil-time-lifecycle | an approval pins `lifecycleVersion`, and every one of these six moves it | the fold-conflict rule, probed over each fold and from both the rule and the screen |
| concurrency-idempotency | keying an action on the wrong resource either drops a legitimate second action or lets two race one bound | one key per resource, per the table above; independence and coalescing both asserted; a fresh idempotency key per action with a deterministic coalesce key |
| data-integrity-conservation | none — no schema, no migration, no server change; §G bounds 3/4/5 are the server's and already cleared | the diff touches no `apps/api/src` and no `prisma/` |
| offline-reconciliation | a key with no release path leaves a control stuck after its command settles | all six release on the claim read that carries their ledger, and only for the rows that read actually returned |
| ui-server-parity | the screen disabling and the dispatcher refusing must not disagree | both call `commercialWriteBlocked`; the screen closes the child-key half the rule documents it cannot see |

## Verification

- [x] `pnpm check` EXIT 0 — web 714/714, API 781/781.
- [x] No schema, migration, or API change.

---

## Correction round 1 — seven findings, and four of them are one mistake made four times

| # | Finding | Fix |
|---|---|---|
| F1 (P1) | an approval was **not** blocked by a pending `com:release:` — `isClaimMoneyPending` cannot map a release key back to its bill, and the screen closed only the payment and reversal thirds of the child-keyed division | the rule takes the claim's child ids and matches **all three** child-keyed commands; the screen supplies withholdings alongside approvals and payments |
| F2 (P2) | `penalty` and `other` require a reason server-side; the form enabled without one | reads the shared `DEDUCTION_TYPES_REQUIRING_REASON`, so a fifth type added there is covered without editing the form |
| F3 (P2) | `com:advance:<vendor>` had **no release path at all** — no read could name it, so the key was set and never cleared | released by the claim read, which carries the vendor |
| F4 (P2) | approve enabled with no live payable (`approvable` null or zero) | gated on `approvable`, and null is treated as "nothing to approve against", not zero |
| F5 (P2) | a payment could exceed its approval's remaining | capped at `amount − paid` for the selected approval |
| F6 (P2) | a reversal could exceed its payment's remaining | capped at `amount − reversed` for the selected payment |
| F7 (P2) | a release could exceed the withholding's unreleased balance | capped at `unreleased` for the selected withholding |

### The shared root, stated plainly

**F4–F7 are one mistake made four times: every control validated SHAPE and none validated
BALANCE**, while the bundle already on screen carried the figure. "Is this a number?" is not "is
there this much left?". The server refuses the overdraw, so the write-ahead outbox reported the
command saved and then dropped it — the write-ahead lie this screen guards against everywhere else,
reintroduced on the one surface where the number is money leaving.

Comparison is in **paise**, via a shared `within`/`minus` pair: `0.1 + 0.2` is not `0.3`, and money
that rounds is money that goes missing.

### Two findings are gaps in rules I wrote myself

Worth recording separately, because they are not new ideas being learned:

- **F1** — the first head *documented* that `commercialWriteBlocked` cannot see child-keyed
  commands and that the screen closes that half, then closed **two thirds of it**. Releases were
  left out because I was thinking about the payment ledger. A rule that names its own blind spot
  still has to cover the whole of it.
- **F3** — this is **7B-iii-g's F2 recurring on a key I added one unit later**. That finding was
  "a key with no release path is not pending, it is stuck"; I fixed it for `com:sodgrant:` and did
  not sweep it for the six keys introduced here. The checkable form is now explicit: *every new
  coalesce key needs a settling read named in the same change.*

**Gates:** `pnpm check` EXIT 0 — web 721/721, API 781/781.
