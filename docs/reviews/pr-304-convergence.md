# PR #304 convergence audit — the write-ahead window, again

Five finding-bearing heads (`d6d4f6e`, `9fa54c7`, `9d755f2`, `bed5a1f`, `6726b2c`). **Twenty-three
findings, ten P1**, on a unit whose product surface is six buttons.

**This audit ends by splitting the unit, which is the conclusion it should have reached earlier.**
The review lifecycle reports 5 finding-bearing heads against a limit of 5, and the finding pattern
had been saying the same thing for three rounds: every round's defect was inside the previous
round's fix, and the fixes kept alternating between two workflows that share files and share
nothing else.

Five of round 1's seven are ONE root — one PR #302 already named and I had already written down:
*the form was written as though the server were the only guard.* Three of round 2's five are inside
round 1's own fixes.

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

## Round 2 — five more, and three of them are inside round 1's fixes

| # | P | Finding |
|---|---|---|
| N1 | P1 | M1's reconcile reloaded the claim, but `loadCommercial()` still rebuilt the WHOLE pending set from the empty outbox on the FASTER money read — so the key cleared before the register did, reopening the window M1 closed |
| N2 | P1 | M2's lodge form serialized every line as `poLineId`, so a labour claim could not be lodged at all |
| N3 | P1 | The measurement form rendered only from `claim.measurements`, which is keyed off the LIVE version — so a newly lodged draft could never be measured, and Submit disputes it for missing evidence, and a disputed claim is still not live |
| N4 | P2 | The lodge form accepted any non-blank document date; `2026-02-31` is well-shaped and impossible |
| N5 | P2 | Lodging a duplicate of a live claim already ON SCREEN was offered, then refused by the server's duplicate index |

**N1 is root L again, and this time about my own probe.** The M1 probe asserted the claim reloads
were CALLED. The finding is about WHEN the key clears — a property those calls exist to produce, and
one the probe never touched. A call is not an outcome, and the review found the gap between them.
The pending set is now partitioned by what each write changes: money keys clear when the money
applies, claim keys when the claim does.

**N3 is the most interesting of the five**, because nothing in it is a wrong line of code. Lodging
works, measuring works, submitting works — and the sequence *lodge → measure → submit* is
unreachable, because measurement rows come from the live version and a draft has none. Each part was
right and the workflow was circular. Unit-level correctness does not compose into a usable path, and
no probe of an individual control would ever have said so.

## Round 3 — four findings, three of which the review and I found independently

| # | P | Found by | Finding |
|---|---|---|---|
| O1 | P1 | me | The pending partition was not a partition: a claim BUNDLE read released `com:bill:` (a lodge), whose visible truth is the claim LIST — the same list the lodge form's duplicate guard reads. Both protections dropped at once |
| O2 | P1 | **both** | With two claims open, an UNRELATED claim's bundle released a `com:meas:` key. N1 exactly, one resource over |
| O3 | P1 | **both** | N3's own fix surfaced a control whose EFFECT no read carries: the claim bundle reports registers only for a LIVE version, so a measurement taken on the lodged draft N3 made measurable stayed invisible |
| O4 | P2 | Codex | The lodge path always sent a SINGLETON `lines` array. The vendor's document number is the frozen duplicate key and amendment is not surfaced, so every line after the first on a multi-line invoice had no path into the claim |

O1–O3 came out of the standing re-read against this document's own carry-forwards while CI was
still running. Codex then reported O2 and O3 independently, in the same terms — which is the useful
part of the coincidence: the carry-forwards found what an independent reviewer found, so they are
doing the work they were written to do. O1 it did not report and O4 I did not find.

**O4 is root N a third time, and the cleanest example of it yet.** Lodging worked. Every probe of
lodging passed. And a vendor invoice covering two purchase-order lines could not be recorded,
because one line was enough to create a claim and not enough to record THAT claim — with the
duplicate key frozen and amendment deliberately unsurfaced, the second line had nowhere to go. The
form now collects the line SET, because the claim is the invoice, not a row of it.

**O3 is the one worth reading.** Round 2's N3 finding was "the workflow is circular"; the fix made
the measurement form reachable on a draft. Walking the same workflow ONE STEP FURTHER — the engineer
presses Measure — the register still says nothing, because the bundle speaks only for a live
version. So the round-2 fix moved the dead end rather than removing it, and the honest reading is
that carry-forward 5 (*walk the workflow end to end*) was applied to the step the finding named and
stopped there. A control is finished when its effect is visible, not when its form renders.

The structural answer is the one the domain was already pointing at: a measurement register belongs
to the LABOUR PO LINE, not to a claim. So the line's own route serves it, and the claim query is not
asked to speak for a version it correctly refuses to speak for.

**O1 and O2 are one root with N1**, and the shape is worth naming precisely. N1 split the pending set
in two — money keys, claim keys — and "a claim read" turned out not to be one thing. Three reads
serve this hub, and each write becomes visible in exactly one of them. Ownership is now stated per
READ rather than per family, with the read carrying what it actually landed, and the three
hand-written copies of the rebuild collapsed into one `releaseCommercialKeys` — three copies being
how `com:bill:` came to be released by two different reads in the first place.

### And a probe that passed for the wrong reason, caught by mutation

O1's first version waited on `commercialClaimLoad['bill-1'] === 'ready'` — a condition its own setup
had already satisfied. It asserted before the read it is about had landed, and it passed under the
mutation that reintroduces the defect. Only the mutation run distinguished it from a real probe.

That is the third time this session a probe has been green for a neighbouring reason, and the
common thread is now clear enough to state: **the synchronisation is part of the claim.** A probe
that waits on the wrong signal is not a weaker probe, it is a different one.

## Round 4 — three more, and the P1 is inside round 3's fix

| # | P | Finding |
|---|---|---|
| P1 | P1 | Round 3 RELEASED `com:meas:` on the line-register read and RENDERED the claim bundle's copy. On a live claim the bundle map is populated, so the register read could land, clear the key, and re-enable Measure over a stale register — the defect round 3 existed to fix, with its two halves reading different things |
| P2 | P2 | Only a SUCCESSFUL register read releases that line's key, and a failed one had no way back: the row stayed disabled after connectivity returned |
| P3 | P2 | Lodge lines carried only quantity and rate, so a material invoice's tax and freight defaulted to zero server-side — the claim certified and paid at its base amount, silently disagreeing with the document it represents |

**Four consecutive rounds where the finding was inside the previous round's fix** (N1←M1, O3←N3,
P1←O3). That is the number worth staring at, not the total.

The P1 says something the previous three roots each said one layer up. N1: keys must clear with the
truth on screen. O1/O2: name WHICH read carries that truth. And now: **the read that releases a key
and the read that renders its value must be the same read** — round 3 got the release right and left
the render pointing at the old source, so the two halves disagreed and the button won.

The fix is subtraction rather than precedence. The Measurements tab now has ONE source, the line's
own register; the claim bundle's map is no longer consulted there at all. Both are `registerIn`
server-side, so nothing is lost — the second copy was only ever a second opinion, and a second
opinion is what made "which one do we render" a question that could be answered wrongly. This is
CLAUDE.md's *one fact, one canonical owner* applied on the client.

**P2 is the cost of that discipline, and worth stating because it is a real trade.** Making one read
authoritative means a failure of that read now holds a button. Round 3 shipped the authority without
the recovery path, so a transient failure disabled a row permanently. Authority and recoverability
arrive together or the first one is a hazard.

**P3 is root N again** — four instances now. Lodging worked, the multi-line fix worked, and the
amounts were wrong: a claim for ₹5,000 of material plus ₹900 tax and ₹250 freight lodged as ₹5,000.
Nothing refused it, because the server's default for an omitted amount is zero and zero is a legal
amount. The quietest defects in this PR have all been the ones where every layer said yes.

## Round 5 — four findings, and the decision to split

| # | P | Finding | Half |
|---|---|---|---|
| Q-a | P1 | A line-register read that STARTED BEFORE the write committed could still release the measurement key. The per-line token orders reads against each other; it says nothing about whether a read observed the write | §D |
| Q-b | P2 | Tax/freight stayed live when the entry was switched to a labour line, and the server refuses a labour claim line carrying either | §F |
| Q-c | P2 | The measure form validated shape only, while the register on screen already proved the quantity exceeded the line's remaining authority | §D |
| Q-d | P2 | A negative correction larger than the row's remaining net contribution was queued, though the rows on screen prove the server's floor refuses it | §D |

Three of the four are §D. One is §F. That is the split, and it is visible in the whole history:

| Half | Findings |
|---|---|
| §D — measure a labour PO line | M1, M5, M7, N1, N3, O2, O3, P1, P2, Q-a, Q-c, Q-d |
| §F — lodge and progress a claim | M2, M3, M4, M6, N2, N4, N5, O1, O4, P3, Q-b |

Two workflows, two independent chains of reasoning, one PR. They shared files and a key namespace
and nothing a reviewer holds in their head at once — so each round I fixed one half while the other
half's context was cold. **Q-a is the clearest evidence:** it is a causality bug about read ordering
that has no counterpart on the §F side, arriving in round 5 of a unit whose §F half was already
settled.

So PR #304 is now the **§F half alone** — lodge, submit, reject, and the value rules — with Q-b
fixed. The §D half moves to its own unit with Q-a, Q-c and Q-d unfixed and named, where it gets a
review budget that has not already been spent.

The honest note: this split was available at scoping time. "The engineer's six writes" is not one
workflow, it is two, and counting writes instead of workflows is what hid that. **Scope by the
question a reviewer has to answer, not by the actor who performs the actions.**

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
4. **A call is not an outcome.** Probing that a refresh was DISPATCHED says nothing about when the
   thing it refreshes becomes visible — which is the only part a user experiences. (N1, root L.)
5. **Walk the workflow end to end, not control by control.** N3 was three correct controls composing
   into an unreachable sequence; every unit-level probe passed. (Root N's sharper form.)
6. **Verify a finding's example against the code, not just its claim.** M6 was a real defect with a
   wrong illustration; pinning the illustration would have encoded a behaviour the server lacks.
7. **A control is finished when its EFFECT is visible, not when its form renders.** N3 made the
   measurement form reachable on a draft; O3 is the next step of the same walk, where the effect
   was not. (Root N, sharper still.)
8. **"Clears with the truth on screen" needs to name WHICH truth.** Partitioning keys by write
   family is not enough when several reads carry different parts of it — state ownership per read,
   and have the read carry what it landed. (N1 → O1/O2.)
9. **Enumerate the CARDINALITY too, not just the actions.** Root N asked whether each action has a
   surface; O4 is the same question one level down — whether the surface handles the real shape of
   the thing. One line was a surface for lodging and not a surface for an invoice.
10. **The read that RELEASES a control and the read that RENDERS its value must be the same read.**
   Where two sources exist, delete one rather than ranking them — a precedence rule is a question
   that can be answered wrongly later. (P1.)
11. **Authority and recoverability ship together.** Making one read authoritative means its failure
   now holds a control; without a way back that is a permanent disable, not a safe default. (P2.)
12. **A default is not a confirmation.** An omitted amount defaulting to zero looks identical to a
   document that says zero, and no layer will object. (P3.)
13. **Scope by the question a reviewer has to answer, not by the actor performing the actions.**
   One actor's six writes were two workflows; sharing a screen and a key namespace is not sharing a
   review. Five rounds alternated between them, each fixing one half with the other's context cold.
14. **When the round's findings sort cleanly into two buckets, that is the split telling you where
   it is.** Rounds 3–5 each did; the tally above only made it legible in retrospect.
15. **A read's token orders reads against each other and says nothing about causality.** Knowing a
   read is the NEWEST is not knowing it observed the write. (Q-a — carried into the §D unit.)
16. **A probe's synchronisation is part of its claim.** O1 waited on a condition its own setup had
   satisfied, so it asserted before the read under test had landed — and passed under the mutation.
   Mutation-run every probe, including the ones written to catch your own findings.
