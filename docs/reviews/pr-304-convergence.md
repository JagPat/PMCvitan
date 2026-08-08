# PR #304 convergence audit — the write-ahead window, again

Two finding-bearing heads (`d6d4f6e` and this correction's predecessor lineage). **Seven findings,
two P1.** Five of the seven are one root, and it is a root PR #302 already named and I already wrote
down: *the form was written as though the server were the only guard.*

That is the uncomfortable part. #302's audit says it in as many words. Then this PR put five new
controls in front of a durable, write-ahead outbox that accepts what the server will refuse.

## Every finding, in one table

| # | P | Finding |
|---|---|---|
| M1 | P1 | The reconcile reloaded the money position but not the claim, so a successful measurement cleared `commercialPending` while the register on screen was still pre-command — a second click appended the same measurement again |
| M2 | P1 | `recordVendorBill` was wired through gateway, store and keys and never surfaced, so the engineer's workflow could not create the claims it exists to process |
| M3 | P2 | Submit was offered for every claim status; the server admits `draft` only |
| M4 | P2 | Reject was offered for every claim status; the server admits five |
| M5 | P2 | The correction delta was checked non-blank; the contract requires a NON-ZERO signed decimal, ≤6dp |
| M6 | P2 | The bill coalesce key trimmed, while the server's live-duplicate index normalizes case and inner whitespace |
| M7 | P2 | `commercialWriteBlocked` gave conflict semantics to bill transitions only, so two correction deltas for one measurement both entered the outbox |

## Root M (recurrence of #302's root) — a control is a promise the outbox keeps

**M3, M4, M5, M6, M7.** Every one puts something into the durable outbox that the server will
refuse. The write-ahead design is what turns that from a validation nit into a lie: the op is
persisted *before* it is sent, the user is told "saved, will sync", and reconnect drops it with a
terminal 400 or 409. Nothing on screen ever said it failed.

#302's audit already stated this and I applied it to the three controls in front of me. Six controls
later it needed stating again — which is root F (*enumerate the instances*) meeting root M
(*the outbox keeps the promise a control makes*). The two compose into the rule this PR should have
started from:

> **Before adding a control, ask what the server refuses — and if the answer is a set, get the set.**

That is now mechanical rather than remembered. `BILL_SUBMITTABLE_FROM` and `BILL_REJECTABLE_FROM`
live in `@vitan/shared` and the SERVICE reads them for its own `from:` lists, so the screen cannot
offer a transition the service does not admit without the service changing too.
`CORRECTION_DELTA` and `normalizedBillNumber` join `MONEY_STRING`/`QUANTITY_STRING` on the same
principle. Five copies of "what the server accepts" became five shared functions.

**M7 is the sharpest of the five** because the guard already existed on the screen. `dispatchCommercial`
had conflict semantics for bill transitions and exact-equality for everything else, so the screen
disabled a second correction and the dispatcher accepted it. A screen guard the durable layer does
not share is J1's lesson unlearned in the same file that learned it.

## Root N (new) — wiring is not shipping

**M2.** `recordVendorBill` had a gateway method, an op type, a coalesce key, a store thunk, an
authority mapping and a replay case. Everything except a button. The unit is called *"measure and
lodge a claim"* and it could not lodge a claim.

What makes this worth a root rather than an oversight: the PR body *declared* an unsurfaced action —
`amendVendorBill`, deliberately, with a reason — which reads as evidence that surfacing had been
audited. It had not. One unsurfaced action was a decision and the other was a gap, and stating the
first made the second harder to see, not easier.

The defence is the same shape as root F's: **enumerate the actions and check each against a
surface**, rather than checking the ones you happen to think of. Six actions, six answers.

## And one correction to a finding, made carefully

M6's review comment illustrated the defect with `V-1` and `v 1`. Under the server's actual rule —
strip all whitespace, then lowercase — those normalize to `v-1` and `v1`, which the server also
treats as different claims. The finding is right; its example is not. The probe therefore pins
`V-1` ≡ ` v-1 ` (case and padding) and `V- 1` ≡ `v-1` (inner whitespace), because a test written
from the illustration would have pinned behaviour the server does not have.

Taking a finding seriously means implementing what is true, not what is quoted.

## What carries forward

1. **A control is a promise the write-ahead outbox keeps.** Before adding one, ask what the server
   refuses; if the answer is a set, import the set rather than restating it. (Root M.)
2. **A guard on the screen that the dispatcher does not share is not a guard.** The durable layer is
   where the promise is made. (M7, and J1 before it.)
3. **Enumerate the actions against surfaces before claiming a workflow ships.** Declaring one
   deliberate omission does not audit the others — it disguises them. (Root N.)
4. **Verify a finding's example against the code, not just its claim.** M6 was a real defect with a
   wrong illustration; pinning the illustration would have encoded a behaviour the server lacks.
