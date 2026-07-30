# PR #252 Review Convergence

## Objective

Converge the Phase-5 planning review. Two heads received findings — `bd0c085` (8) and
`cf81ca9` (8) — and all sixteen are correct. This head maps them to their one shared
architectural cause, states the batched remedy, and records how each is proven.

## Finding map

| Head | Finding | The question it was really asking |
|---|---|---|
| `bd0c085` | P1 STATUS reopens planning after merge | which task counts as open? |
| `bd0c085` | P2 `accepted − rejected` understates an 80/20 split | which rows count as accepted? |
| `bd0c085` | P1 measurement permitted by status, not bounded by evidence | which rows bound a measurement? |
| `bd0c085` | P1 certification does not lock the inventory evidence | which rows must be locked to read? |
| `bd0c085` | P2 retained bill versions double-count | which rows count as billed? |
| `bd0c085` | P2 bill line not pinned to the PO vendor | which PO lines may a bill claim? |
| `bd0c085` | P2 freight frozen but never compared | which fields count in the triple? |
| `bd0c085` | P2 no measurer exists for material bills in SoD | which actor counts as measurer? |
| `cf81ca9` | P1 bucket balance is not delivery evidence | which rows count as accepted? (again) |
| `cf81ca9` | P2 certification lock order deadlocks against inventory | which order must the locks take? |
| `cf81ca9` | P2 same-UOM cap unsatisfiable for person-shift lines | which cap applies to which contract? |
| `cf81ca9` | P2 labour effort not scoped to the billed line | which effort counts for this line? |
| `cf81ca9` | P2 superseded certificates double-count | which rows count as certified? |
| `cf81ca9` | P2 Task 4 reaches `verified` before §E exists | which task owns the transition? |
| `cf81ca9` | P2 "live" excludes advanced lifecycle states | which rows count as billed? (again) |
| `cf81ca9` | P2 amended PO commitments double-count | which rows count as committed? |

## Architectural cause

Thirteen of the sixteen are the same question — **which rows count?** — asked at a different
site each time and answered locally each time. The plan specified every quantity and amount
by describing *where to look* (a bucket, a table, "earlier lines") instead of first defining
*what constitutes evidence* for that fact family. Each local answer was plausible and each
was wrong in its own direction.

Two sub-shapes recur, and both come from the platform this phase sits on:

- **Amendments retain history.** POs, bills, certificates and budget lines all supersede
  rather than overwrite — a decision made in Phase 3 and reused since. So "every row" is
  never the answer for any of them, and I wrote "every row" for bills, certificates and
  commitments independently.
- **A bucket balance is current state, not evidence of a past event.** The §C ledger's
  `acceptedOnHand` moves on issue and on adjustment, so it cannot answer "what was
  delivered". My round-1 correction traded one wrong accepted-side formula for another
  because I was still reaching for a place to look rather than a set to define.

The remaining three (lock order, vendor pinning, Task 4/5 split) are not that shape and are
fixed directly.

**Why the round-1 correction did not converge:** it fixed eight sites and left the method
that produced them. Four of round 2's findings are on lines round 1 edited. That is the
signal the convergence protocol exists to catch, so this head changes the method.

## Batched remedy

**A new §0 defines six canonical evidence sets once — `ACCEPTED`, `MEASURED`, `EFFORT`,
`BILLED`, `CERTIFIED`, `COMMITTED` — each with its definition and, explicitly, what it must
NOT be and why.** Every §G bound and every side of the §E triple now references a set by
name. The plan states the rule that keeps it honest: *no fold restates a filter inline, and
a fold that cannot be expressed with one of these names means a set is missing.*

That converts thirteen independent judgement calls into one table a reviewer can check, and
makes the next instance a visible omission rather than a silent local answer.

Directly fixed, outside the pattern:

- **Lock order** now matches what inventory already does (`readiness → lot(s) → PO line`),
  because `applyReceiptProgress` is what takes the PO line and every inventory write —
  `receipts.reject` and receipt reversals included — reaches it lot-first. My round-1 order
  inverted that and would have deadlocked certification against a concurrent rejection.
  Commercial adopts the established order rather than asking four cleared modules to migrate.
- **Measurement caps are contract-shaped**: an output-priced line takes a same-UOM quantity
  cap; a person-shift line cites the output as *evidence* and takes its quantity cap from
  `EFFORT(poLine)`, because a same-unit cap between person-shifts and sqm is not merely
  wrong but unsatisfiable — it would refuse valid attended shifts or push teams to fabricate
  outputs to bill.
- **Task 4 stops at `under-verification`.** `verified` is the state whose safety IS the §E
  verdict, so the transition belongs to the task that produces its evidence — and pulling §E
  forward would bypass the Task-5 review stop guarding it.

## Evidence

This is a planning PR: the probes are specified, not yet executed. Every finding above has a
probe in the plan's "Required plan probes" list, and probe 5g makes the §0 table itself
executable — each "must NOT be" cell is a named case with a stated correct total (the 80/20
acceptance, accept-then-issue, adjust-into-bucket, amended bill, advanced-lifecycle bill,
superseded certificate, amended PO commitment).

The one finding that could be proven now was: F1's fixed STATUS was run through the real
`assessRunnerState` over the edited file, returning `task:1` — the state the finding said
was required. `pnpm test:automation` 111/111.

## Invariant audit

Docs-only. No schema, no migration, no code, no dependency, no deployment surface. The
Phase-1–4 facts this plan consumes are unchanged and unre-opened; the corrections narrow
what Phase 5 may claim about them.

## Remaining risk

The §0 sets are stated but not yet typed. Until Task 1 gives them a shared implementation,
"reference the set by name" is a documentation convention a future task could quietly
violate. The mitigation is scheduled rather than assumed: Task 1 ships the six sets as named
query functions in the commercial module, so a later fold must call one or write a filter
that a reviewer can see is not one of them.

Second: `EFFORT(poLine)` requires effort to be consumable exactly once across PO lines,
which is a conservation problem of the same shape as Phase-3's stock allocator and Phase-4's
commitment matcher. The plan names it; it does not yet specify the matcher. Task 3 must, and
its review stop is where that gets checked.

---

## Round 2 — `cbbd60c`

Seven findings on the convergence head. All correct, and three of them (H3, H6, H7) are
gaps in that head itself. That is worth stating plainly rather than filing as routine.

| Finding | Was the §0 method wrong, or applied incompletely? |
|---|---|
| H7 `BILLED` used as both quantity and money | applied incompletely — a set that carries two units is not a set |
| H3 output-priced cap not consumable once | applied incompletely — the cap referenced a raw `Σ ActivityWorkOutput`, i.e. a fold that was never given a name |
| H1 STATUS still says Task 4 delivers `verified` | the plan was corrected and the authoritative file was not |
| H2 approval capped at gross certificate | a bound that never referenced the §H ledger at all |
| H4 manifest declares no participant edge §E requires | two sections of one document disagreeing |
| H5 rejection reachable from certified | a lifecycle arrow that outran the §0 live rule |
| H6 SoD ships one task after certification | same shape as the Task 4/5 split, missed in the same pass |

**H3 and H7 are the method working as designed and me not finishing the job.** §0 states
that "a fold that cannot be expressed with one of these names means a set is missing" — H3
is exactly that case, and I left `Σ ActivityWorkOutput.quantity` inline instead of naming
it. §0 also implies one unit per set; I wrote a single `BILLED` and then used it as both.
The remedy is not a new rule, it is completing the one already stated: `OUTPUT(poLine)` is
now a named consumable set, and `BILLED` is split into `BILLED_QTY` and `BILLED_AMOUNT`.

The other four are a different and simpler failure: **corrections applied to the plan and
not to every place that repeats them.** H1 (STATUS), H4 (§K manifest vs §E), H5 (lifecycle
arrow vs §0), H6 (task table vs §I) are all one document contradicting itself after an
edit. The structural answer is the same as §0's: state a thing once. Where that is not
possible — STATUS must restate the task table for the runner — the correction has to be
applied to both in the same commit, which is what this head does.

### Also fixed

- **Bound 4 is now NET of deductions.** Capping approval at the gross certificate made the
  §H retention ledger decorative: a ₹100 certification with ₹10 retention could approve and
  pay ₹100, recording a withholding that withheld nothing.
- **Rejection stops at `verified`.** Past certification the correction path is a superseding
  certificate and, where money moved, a reversing payment record — never a status flip that
  orphans append-only payable facts while freeing their accepted quantity for a second bill.
- **`commercial.workflowParticipants: ['inventory']`.** §E requires
  `InventoryParticipant.lockAcceptedEvidence`; a manifest declaring no participant edge would
  have had Task 1 ship a contract saying that call cannot happen.

### Convergence status

The §0 method is not being abandoned — round 2 produced no finding that contradicts it, and
two findings were instances of it not being carried through. Three rounds of findings on a
document with no executable surface is, however, itself a signal: these are exactly the
defects the plan's own probes are written to catch, and after this head the cheapest place
to find the next one is Task 1's code, not another prose round.

Gates: `pnpm test:automation` 111/111.

---

## Round 3 — `22175f8`

Seven findings, all correct. No finding contradicted §0; five were folds or guards §0's own
rule should have caught and I had not written down, and two were fresh concurrency/arithmetic
gaps.

| Finding | Shape |
|---|---|
| I5 no `BUDGET(costHead)` live set, though §J has a budget bucket | a fold with no named set — the §0 rule, again |
| I2 `COMMITTED` gross, so committed and received-not-billed overlap | a set defined without asking what the bucket it feeds must mean |
| I7 `MEASURED` unbounded below; −150 correction strands the line | a set with no floor |
| I3 tax/freight compared whole against partial bills | two amounts with no named cumulative fold |
| I1 measurement reads activity status unlocked | lock-after-read — the same class as F4 and G2 |
| I4 approval limits per row, so ₹100 splits into two ₹50s | a ceiling applied to the wrong aggregate |
| I6 post-certification acceptance reversal leaves a payable bill with zero accepted | the missing REVERSE channel |

**I6 is the one that mattered most.** §E made certification lock the accepted evidence, which
closes the race in one direction only: inventory does not depend on commercial, so
`stock.reverse` commits freely afterwards and leaves a certified, payable bill whose
`ACCEPTED` is zero. The fix is the channel this codebase already uses for exactly this shape —
`inventory.workflowParticipants` gains `commercial`, and the reversal asks
`CommercialParticipant.assertAcceptanceReversible` in its own transaction, which refuses
while a live certificate depends on the quantity and names it. That is `assertMediaDisposable`
applied to money: evidence a payable fact rests on cannot be withdrawn while the fact stands.

New sets: `BUDGET`, `BILLED_TAX`, `BILLED_FREIGHT`. `COMMITTED` is redefined as OUTSTANDING
and `MEASURED` gains a floor at zero. Probes 5j–5p cover every finding.

## Where this review stands, stated with numbers

Four finding-bearing heads: 8, 8, 7, 7 — thirty findings, every one correct, none yet
contradicted by a later round. The rate is not declining, and the plan has no executable
surface, so nothing here can be proven RED→GREEN; each round can only be answered with more
prose.

That is not an argument that the review is wrong — it has caught real defects, several of
which would have cost a migration to fix after Task 1. It is an argument about where the next
one is cheapest to find. Every finding in rounds 2–3 is a case the plan's own probe list now
names: 5g–5p are executable the moment Task 1 exists, and would have failed RED for I2, I3,
I5, I7 and both races. A plan is a hypothesis about invariants; probes are how it gets tested.

The recommendation, for the record and not as a unilateral action: after this head, take
Task 1 — which ships the six §0 sets as named query functions — and let the probes adjudicate
the remainder. The gate decides whether this head is clean; the runner does not get to
declare its own plan finished.

Gates: `pnpm test:automation` 111/111.

---

## Round 4 — `f38a93e`

Nine findings, all correct. The rate went **up**: 8, 8, 7, 7, 9.

Two are the same defect applied to one side and not its mirror, which is worth naming because
it is now a repeated authoring failure and not bad luck:

| Finding | The mirror I missed |
|---|---|
| P1 labour evidence unprotected after certification | round 3 added the material reversal channel and stopped there. Activities can supersede a cited output and `revertSignOff` can withdraw a sign-off, both after certification, leaving the certificate payable against evidence that no longer stands. `activities.workflowParticipants` now gains `commercial` too. |
| P1 reversal guard compares aggregates, not rows | `assertAcceptanceReversible(poLineId, qty)` lets the evidence be SWAPPED: certify 100 against acceptance A by user X, accept another 100 by user Y, reverse A — aggregate still 100, reversal passes, and the certificate now rests on rows and an actor the §E triple and §I SoD rule never saw. Certification now freezes WHICH rows it consumed, and the guard takes row identity. |

The other seven are set-definition precision, all in §0 or the bounds that read it:

- `COMMITTED` subtracted `rate × ACCEPTED` while `committedAmountBase` includes tax and
  freight, stranding ₹150 of a ₹1,150 line in `committed` after full acceptance — now the
  prorated LANDED amount, and a labour line reduces by measured person-shifts at the frozen
  rate.
- bound 3 capped a certificate against `BILLED_AMOUNT(poLine)`, so two live ₹100 bills on one
  line let a ₹150 certificate through — now a bill-scoped set.
- `EFFORT` matched fingerprint and slice but not the funding PO line, so two vendors sharing a
  fingerprint on one day could consume each other's work facts — now joined through
  `WorkerAllocation → CapacityCommitment → LabourPurchaseOrderLine`.
- attribution was revocable to nothing, dropping a live obligation out of every forecast — now
  an atomic replacement with exactly one active attribution per live PO line version.
- deduction rows were not append-only and were absent from §F's seal list, so dropping a
  retention row raised net payable with no release.
- reason columns were presence-only, not non-blank — the discipline Phase-4 Task 5 already
  established.

Probes 5q–5v cover each.

## Round 5 (head `ade50eb`) — five findings, and a correction to this packet's own reasoning

Five P2s, all correct, and — this matters — **not the same kind of finding as rounds 2–4.**
Rounds 2–4 were dominated by "the plan does not yet say how X is handled", which is true of
every plan at some depth. Round 5 is five concrete defects with definite right answers:

- **`COMMITTED` added back what it had just subtracted.** The definition read "MINUS the
  portion already consumed or released … plus the released remainder of a closed-short
  version", so a ₹100 PO closed short before any receipt reported ₹100 outstanding for an
  obligation the practice had explicitly cancelled. The clause is deleted and the close-short
  rule stated: a released remainder is subtracted once and never added back. Probe 5w.
- **The manifest declared one participant edge where the prose required four.** §D requires a
  measurement to read `Activity.status = done` under the activity row lock through
  `ActivityParticipant`; §E requires locking cited outputs; §C requires an amendment to
  supersede the attribution in the same transaction that issues the new PO version. §K
  declared only `workflowParticipants: ['inventory']`. Task 1 following the manifest literally
  would take the unlocked `ActivitiesQuery` fallback §D itself proves unsafe, and would have
  no channel at all for the atomic re-attribution — so amending a live ₹100 PO would drop the
  whole obligation out of every forecast until some later commercial command. §K now states
  the complete edge table: `commercial.workflowParticipants: ['inventory', 'activities']`, and
  `procurement`/`activities` each gain `commercial` as INBOUND participant edges (write
  channels, not `dependsOn` — commercial is still a sink in the read graph, and participant
  edges are cycle-exempt by the cleared `activities → labour` precedent). Probes 5x, 5y.
- **A bill could be amended after certification.** §0 removes a superseded version from
  `BILLED_AMOUNT(bill)`, so certifying a ₹100 bill and amending it to ₹50 leaves the
  certificate, approval and payment rows standing against a claim that is no longer live —
  simultaneously in breach of bound 3 and payable. Amendment is now CAS-restricted to
  `submitted`/`verified`/`disputed`; after certification the path is the one §F already had,
  supersede the certificate first. Probe 5z.
- **`SodException` was required to be written but never sealed.** It is the evidence that makes
  an otherwise forbidden certification valid, and an override whose approver or reason can be
  edited afterwards is indistinguishable from no override. It now carries the trusted-evidence
  seals: append-only at PG, immutable rule/actor/approver/reason with the complete non-blank
  CHECK, written in the override's own transaction, and FK-bound to the one fact it authorizes
  rather than standing as a reusable waiver. Probe 5aa.

**This packet's earlier reasoning needs a correction.** Rounds 2–4 argued that a plan finding
"can only be answered with more prose"; round 5 shows that is not true of every plan finding.
A wrong formula, a manifest that contradicts its own prose, a missing lifecycle guard and a
missing seal all have single right answers, and fixing them made the plan strictly more
correct — not merely longer. The bounded-review argument holds for the "specify further" class
and not for this one, and PR #253 was written to add an obligation rather than to suppress
anything precisely because that distinction cannot be drawn mechanically. Had #253's cap been
live at round 4, these five would still have had to be answered: a deferral names the probe
and the task, it does not close a finding.

## Round 6 (head `8354a5f`) — ten findings, and the one that names them all

Ten P2s. Nine are mechanism defects with definite right answers; one (the `CostHead` non-blank
CHECK) is specify-further and also correct and one line. So the round-4 commitment to REPORT a
sixth round rather than correct it does not apply — it was scoped to a round whose findings are
all "the plan should also specify X", and invoking it here would be using an escape written for
a different case.

**Five of the ten are sites I left broken while fixing an identical sibling in round 5.** That
is the finding that matters:

| Round-5 fix | Sibling site it missed |
|---|---|
| procurement→commercial channel for amend/cancel/close-short | `pos.issue` — a newly issued PO is live and unattributed, so `COMMITTED` reads ₹0 for a real order |
| `COMMITTED` released-remainder arithmetic | no clamp — overage acceptance drives it to −₹10 and offsets other cost heads |
| `activities` participant edge for MEASUREMENT | certification reads the same sign-off status without the same lock |
| `MEASURED` floored at zero | not floored at live consumption — −50 after a certified 100 breaks bound 2 after the payable fact exists |
| `SodException` sealed | still scheduled one task after the rule that needs it |

The remaining five are ordinary defects: `disputed` staying live so a dispute blocks its own
resolution; the pro-rata tax cap scaling past frozen authority on overage units; deduction
amounts unconstrained so `-10` inflates net payable; `other` declared in §H and absent from the
`NET_PAYABLE` fold; the blank cost-head code.

### The remedy: §0b, a rule → site closure table

Ten more local edits would reproduce the cause. The plan now carries **§0b** — each rule stated
once with its COMPLETE site list, and the row IS the acceptance criterion for any task touching
any site in it. Eight rows: attribution lifecycle (four sites), status-under-lock (three),
evidence withdrawal (four), frozen-amount clamps (two), append-only sign constraints (three),
enum-member-in-fold, non-blank text (two), rule-ships-with-its-exception-record. Probe 5ab is
one probe per row rather than one per finding.

This is the third layer of the same cause. #252 round 1: "which rows count?" answered locally at
each fold — remedied by §0's named sets. #253: "which paths count?" answered by whichever field
was nearest — remedied by two definitions. Round 6: "which SITES does this rule bind?" answered
by whichever site the finding pointed at. Named sets stopped me writing the wrong fold; they did
not stop me writing the right fold in one place and not the other. §0b is the site-level
counterpart.

## Termination, and what happens next

Seven finding-bearing heads: 8, 8, 7, 7, 9, 5, 10 — fifty-nine findings, every one correct and
none contradicted by a later round. Round 3's packet recorded the recommendation to hand the
remainder to probes; the owner approved it and asked for the process to be fixed so this does
not recur.

That fix is **PR #253** (`Review-Deferred-To-Probes`), which bounds a docs-only review at
`PLAN_REVIEW_ROUND_CAP = 3` finding-bearing heads and requires the remaining questions to be
converted into named probes plus the task that settles them. It is under review now. The gate
reads `main`'s copy of its scripts, so the deferral is not yet enforceable here — which is
precisely why this head fixes all nine rather than asserting an exit it cannot yet take.

The deferral ledger for this plan is the probe list itself: 5g–5ac are executable the moment
Task 1 exists, and every finding from rounds 2–6 maps to one of them. Once #253 merges, this
PR closes through that route with `Review-Deferred-To-Probes: phase-5-task-1`.

Round 4's packet said I would report rather than answer a sixth PROSE round. Neither round 5
nor round 6 was that: mechanism defects with right answers, so answering them was correct and
the commitment did not apply. It still stands for its actual case — a round whose findings are
all "the plan should also specify X" gets reported, not another correction. **What I will not
do is invoke it against a round of real defects because the round number matches.**

**No deferral trailer on this head.** Every finding is FIXED here, and claiming a deferral
while fixing everything would misdescribe what happened.

An honest note on the trend, since the earlier rounds' framing was about an unbounded review:
the finding counts have not fallen (8, 8, 7, 7, 9, 5, 10) but their KIND has narrowed, from
"which rows count?" architecture in round 1 to a wrong sign on a deduction column in round 6.
Round 6's real content is not ten separate problems; it is one problem — I fix instances, not
classes — and §0b is the structural answer. Whether that holds is a question the next round
answers, not this packet.

`origin/main` was merged into this branch on the round-5 head (PR #254, ranged pnpm
overrides); the branch was `behind`, not conflicted.

Gates: `pnpm test:automation` 111/111 — the count is unchanged from round 4 because #253's
probes live on its own branch and have not merged. Docs-only diff, so no product surface is
touched; `pnpm check` is unchanged by construction.
