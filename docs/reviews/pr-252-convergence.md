# PR #252 Review Convergence

## Objective

Converge the Phase-5 planning review. Nineteen heads have received findings; the per-round
sections below run in order, each mapping its findings to their architectural cause, the batched
remedy, and how each is proven. The Termination section carries the running totals and the
current exit route. The two sections immediately below are the round-2 record, written when the
review stood at two heads — `bd0c085` (8) and `cf81ca9` (8), all sixteen correct.

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

**Superseded at round 13.** The STATUS edit is no longer part of this PR — it blocks the
deferral check PR #253 merged, so it moves to a follow-up PR after this one (round-13 section).
F1's fix and its `assessRunnerState` proof travel with it and land there; the state above is the
round-2 record, not a claim about this head's diff.

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

## Round 7 (head `2a0d26c`) — §0b did not work, and why that settles the trajectory

Seven findings, all correct. **Four are §0b closure failures in the very head that introduced
§0b**, which is the decisive fact in this packet:

- §K's edge table omitted `inventory → commercial`, though §E requires `stock.reverse` to call
  `assertAcceptanceReversible` — accept 100, certify, reverse, and the certificate is payable
  against withdrawn evidence.
- The same table omitted `commercial → procurement`, though certification takes the PO-line
  lock — a lock is a transaction-bound call, and reading through `ProcurementQuery` instead
  lets a certificate commit against ordered authority `closeShort` has already moved.
- The sign-constraint row named certification, payment and deductions and missed **vendor claim
  lines** — a live −100 claim plus a 200-unit bill leaves cumulative `BILLED_QTY` at 100 and
  passes bounds 1–2 against 100 accepted.
- A deduction appended after approval breaks bound 4 — the same reducing-append-after-
  consumption rule I had just fixed at measurement corrections and left open at deductions.

The other three: `EFFORT` folds worked-MINUTES and §D compares it to person-SHIFTS, so
`10 ≤ 480` passes from one worker's day (a unit error, in the phase whose §0 exists to stop
exactly that); a pre-certification `stock.reverse` leaves a live claim against zero accepted;
and output-priced labour has **no frozen ordered quantity or rate** in Phase 4 to verify
against — a shape I invented mid-review without checking the ordered side supports it. That one
is removed rather than patched: Phase 5 verifies person-shift-priced labour only, and
output-priced subcontracts need a work-order snapshot that is a procurement change and a later
phase.

**§0b was the wrong instrument and this round proves it.** A hand-authored site list cannot fix
a failure whose cause is my recall: I wrote the closure table and, in the same document, failed
to close four rules. Prose has no compiler, so the only mechanism that closes a rule over its
sites is an executable probe. That is the #253 thesis, arrived at the hard way.

## Round 8 (head `b612f69`) — the recurrence has a name now: a second declaration

Seven findings, all correct. **Four are the same failure and it is not a recall failure — it is
a structural one I can point at.** Round 7 concluded that prose has no compiler and only probes
close a rule over its sites. That was right about VERIFICATION and wrong about the cause. This
round shows the cause precisely: in each of the four, the rule was stated TWICE, one statement
was updated and the other was not, and both continued to look authoritative.

- **§K.** The section OPENED with `workflowParticipants: ['inventory', 'activities']` and CLOSED
  with `['inventory', 'activities', 'procurement']`. Round 7's own correction added
  `procurement` to the closing list only. Two declarations, one section, disagreeing — and the
  opening one is what Task 1 would have read, leaving certification with no transaction-bound
  procurement participant and free to certify against ordered authority `closeShort` has moved.
  A THIRD copy sat in §0b's closure row.
- **Probe 5c.** §D removed output-priced labour in round 7; the probe still demanded both
  contract shapes and output-priced same-UOM checks. An implementer following it would have
  built a shape the plan forbids, or carried a permanently failing test.
- **Probe 4.** §0/§E chose to record an over-bound claim as a `qty-over-accepted` DISPUTE so the
  vendor's real claim stays readable; the probe still said "refused". Satisfying the probe would
  have destroyed the evidence probe 5ac depends on and made the resolution path untestable.
- **`OUTPUT(poLine)`.** Still "consumable exactly once across all lines", a rule whose ONLY
  justification was two output-priced lines sharing one output — the shape round 7 removed. Left
  in, it breaks honest work: a mason line and a helper line both worked to produce the same
  100 sqm, each capped by its own `EFFORT`, and drawing the output down for the first blocks the
  second or pushes a team to fabricate a duplicate output row to bill real attendance. An
  accounting artefact that makes people invent evidence.

The other three are genuine new gaps, not recurrences: `CostHead.code` was non-blank but
EDITABLE, so renaming `CIVIL` to `MEP` moves every recorded budget and commitment fact with no
revision and no evidence it moved; a superseding certificate lowered `CERTIFIED` while the
append-only APPROVAL rows stayed at the old amount (certify ₹100, approve ₹100, supersede to
₹50 → approved ₹100 against a ₹50 net payable, in breach the instant the correction lands); and
"a reversing payment record" is unimplementable under this plan's own rules — payments are
strictly positive so a ₹50 reversal reads ₹150 paid and a negative one is refused by the CHECK.

**The remedy is subtraction, not another list.** Every fix here removes a statement rather than
adding one:

- §K's opening list and §0b's copy are DELETED. The §K edge table is the only declaration, now
  explicit — one row per manifest field, both directions. Probe 5x asserts against the table
  instead of carrying its own subset.
- The probe list gains a rule at the top: **a probe names a SCENARIO and cites the section whose
  rule it exercises; it does not restate the rule.** If a probe and its section disagree, the
  section is right and the probe is the defect. Probes 4, 5c, 5i, 5x are rewritten that way, and
  5g's hard-coded "six sets" becomes "every row of the §0 table" — a count is one more thing
  that goes stale when a set is added.
- The three new gaps are fixed where their rule already lives, so nothing is restated: `PAID` and
  `APPROVED` become §0 SETS (netting reversals; scoped to the live certificate), so bounds 4–5
  and the deduction-insertion guard reference them and no fold restates the netting. `CostHead.code`
  gains a column freeze next to its existing non-blank rule. §F states supersession-carries-its-
  children ONCE and every other mention points at it.
- §0b gains three rows, one of which is the meta-rule: **a rule is stated at exactly one site;
  every other place references it.** A second statement of a rule is a fact with two owners —
  the one thing this project's architecture forbids everywhere else, applied to the plan document
  itself.

**Where this leaves round 7's conclusion.** Probes are still the right verification instrument;
that is unchanged and #253 still stands. But probes could not have caught these four, because
three of the four defects were IN THE PROBES. What catches a second declaration is not testing
it — it is not having one. New probes 5ad/5ae/5af cover the three genuine gaps.

## Round 9 (head `c5f9887`) — the prediction, honoured; and the cap does not do what I said

Eleven findings (eight distinct; three arrived twice), all correct. Round 8 ended with a
falsifiable prediction, so it gets answered before anything else.

**The prediction, checked honestly.** I wrote: *"if round 9 again contains a stale-copy
finding, the meta-rule failed too."* It does NOT. No finding here is two copies of a rule
inside the plan disagreeing — the one-site meta-rule held on its own terms, and §K now has a
single edge table which is what let the labour gap be seen as a gap rather than a
contradiction. So by the letter, the prediction is not triggered.

By its spirit it is, and pretending otherwise would be exactly the technicality I said I would
not hide behind. The causes simply MOVED to classes no document rule can close:

- **Three findings are false claims about what Phase 3/4 code actually does**, asserted from
  my memory of it. `labourPurchaseOrderLine` is LABOUR-owned (`labourManifest.ownsModels`), not
  procurement's — my §0 owner column said procurement, and §K's missing labour edges are
  downstream of that one wrong word. `ActivityWorkOutput` carries `ActivityWorkOutput_append_only`
  (BEFORE UPDATE OR DELETE, `20270305000000`) with no supersession path at all — I specified a
  "not superseded" lifecycle the owner module does not have, which would have forced Phase 5 to
  change an Activities operational fact this phase declares out of scope. `PurchaseOrderLine`'s
  CHECK is `taxAmount >= 0 AND freightAmount >= 0` — my §0b sign row demanded strictly positive
  claim tax and freight, which would refuse a bill matching a zero-freight PO EXACTLY. All three
  are now verified against the repository and cited in the plan by migration name.
- **Three are task-SEQUENCING gaps**: Task 4 creates live bills but the dispute transition and
  the acceptance-withdrawal guard were in Task 5, so a Task-4-only deployment has no legal
  outcome for a 101-vs-100 claim; `advance-recovery` capped against a paid-advance fact that
  Task 6 creates; Tasks 1–2 add budget/attribution write routes with no permission to call them.
- **One is a §0b closure failure**, the class round 7 already declared §0b unable to prevent:
  `CommitmentAttribution` is a key that groups money, exactly like `CostHead.code` which round 8
  froze, and it was never added to the seals — so an in-place `CIVIL`→`MEP` update moves recorded
  history with no evidence.
- **One is a defect in the round-8 fix itself.** "Supersession is refused if it would leave
  `PAID > APPROVED`" makes the intended correction impossible: reverse ₹50, supersede to ₹50,
  and `APPROVED` is ₹0 while `PAID` is ₹50 — the guard refuses and skipping it breaks bound 5.
  Fixed as an explicit SEQUENCE (reverse cash in FULL → supersede → re-approve → re-pay),
  because partial cash against an uncertified amount has no legal fold.

None of these is closable by another rule in this document. A false claim about another
module's schema is settled by reading the schema; a sequencing gap is settled by attempting the
task. **So the prediction's conclusion stands: the remainder belongs to probes, not prose.**
Six new probes (5ag–5al) carry exactly these questions into the tasks that can execute them.

### And a correction about the mechanism I built

The round-7 and round-8 packets both said PR #253's `PLAN_REVIEW_ROUND_CAP` is the fix that
bounds this review. Reading `autonomous-review-gate.mjs` again at this head:
`guardAgainstCurrentHeadFinding` runs AFTER `enforceReviewConvergence` and returns
`changes_required` independently. **The deferral trailer satisfies the CONVERGENCE obligation
and does nothing to a current-head finding.** #253's own packet states this correctly — "nothing
here discounts, filters or downgrades a finding, and `codex-current-head` still fails closed on
every current-head finding" — and I then described it to the owner as bounding the review
anyway. It bounds the PAPERWORK past round 3; it does not terminate anything. The only exit
from this loop has always been a head Codex returns clean on, and that is unchanged.

That matters for what to do next, so it is recorded here rather than left as an impression:
**the round cap is not the answer to "this review does not converge." The answer is a smaller
review unit.** This PR is one file, ~1,300 lines, specifying seven tasks' invariants at once —
inside the 1,500-line budget but emphatically not "one architectural concern", and every round
has found real problems in a different one of the seven. Phase 3's and Phase 4's plans cleared
in 2 and 3 rounds because they deferred per-task detail to the tasks. The recommendation for the
owner is in the closing section.


Each still-open question, the probe that adjudicates it, and the task whose review stop settles
it. This is the mapping the deferral requires — not a pointer at the probe list.

| Open question | Probe | Settled by |
|---|---|---|
| Does `COMMITTED` stay ≥ 0 when overage is accepted, at both clamp sites? | probe 5w | phase-5-task-2 |
| Is the §K edge set exactly as declared, inbound and outbound, with an acyclic `dependsOn`? | probe 5x | phase-5-task-1 |
| Is a live PO line ever unattributed, at all four lifecycle sites (issue/amend/cancel/close-short)? | probe 5y, 5u | phase-5-task-1 |
| Does `COMMITTED` READ those attributions, including the activation backfill? | probe 5bu | phase-5-task-2 |
| Can a bill be amended after certification? | probe 5z | phase-5-task-5 |
| Is a `SodException` immutable, single-use, and written in the override's transaction? | probe 5aa | phase-5-task-5 |
| Does an unresolved `disputed` claim leave the live folds so its correction can be submitted? | probe 5ac | phase-5-task-5 |
| Is `EFFORT` normalised to person-shifts before any cap compares it? | probe 5c, 5s | phase-5-task-3 |
| Is a reducing append refused/disputed at every site a downstream fact consumes it? | probe 5j, 5ab | phase-5-task-5 |
| Is claim QUANTITY positive while tax/freight are NON-negative (a zero-freight PO is billable), both capped at frozen authority? | probe 5l, 5ag, 5ab | phase-5-task-4 |
| Does every declared deduction type reduce the approval cap? | probe 5m, 5ab | phase-5-task-6 |
| Do the certification locks match inventory's and procurement's existing order without deadlock? | probe 5b, 5j | phase-5-task-5 |
| Is `live == projection == rebuild` for the cash forecast? | probe 10 | phase-5-task-7 |
| Does superseding a certificate carry its approvals and reverse paid cash, atomically? | probe 5ad | phase-5-task-6 |
| Does `PAID` net reversals, and does PG refuse negative payment and reversal rows? | probe 5ae | phase-5-task-6 |
| Is `CostHead.code` frozen after write, with reclassification only via a new head? | probe 5af | phase-5-task-1 |
| Is `OUTPUT` a predicate — do two lines measure against one output, each capped by its own `EFFORT`? | probe 5i, 5c | phase-5-task-3 |
| Is claim tax/freight non-negative rather than positive, so a zero-freight PO can be billed? | probe 5ag | phase-5-task-4 |
| Does superseding a PAID certificate require full cash reversal first, with bound 5 true at every step? | probe 5ah | phase-5-task-6 |
| Is a re-attribution append-only with a frozen reason, so a reclassification leaves evidence? | probe 5ai | phase-5-task-2 |
| Do the dispute transition and acceptance-withdrawal guard exist in the task that first creates a live bill? | probe 5ak | phase-5-task-4 |
| Can a read-only commercial member mutate budget or attribution? | probe 5al | phase-5-task-1 |
| Is `CostHead.code` unique per project, so a budget and its attribution meet in one head? | probe 5am | phase-5-task-1 |
| Does an acceptance reversal dispute the MINIMUM set that restores the aggregate bound? | probe 5an | phase-5-task-4 |
| Is cross-vendor bill-to-PO-line pinning refused by PostgreSQL, not the service? | probe 5ao | phase-5-task-4 |
| Is every reason column this phase adds non-blank at PG, enumerated from the schema? | probe 5ap | phase-5-task-5 |
| Is there exactly one live budget chain per `(projectId, costHead)`, with `amount >= 0`? | probe 5aq | phase-5-task-2 |
| Does attribution authority follow the WRITE rather than the route, so PO-issue authority alone cannot attribute? | probe 5ar | phase-5-task-1 |
| Is cumulative `MEASURED` capped at the ORDERED person-shift quantity, and released by an amendment? | probe 5as | phase-5-task-3 |
| Is the consumption set frozen with `(rowId, consumedQty)` on BOTH the acceptance and measurement sides? | probe 5at | phase-5-task-5 |
| Is a labour bill line's tax/freight refused at PG, given Phase 4 froze no ordered side to compare? | probe 5au | phase-5-task-4 |
| Is `disputed` terminal, with correction only by a superseding version? | probe 5av | phase-5-task-5 |
| Does supersession re-state the deductions on the new certificate? | probe 5aw | phase-5-task-5 |
| Does the vendor-pinning migration backfill from the PO chain and ABORT on any line it cannot resolve? | probe 5ax | phase-5-task-4 |
| Is payment status re-derived after a reversal rather than left stale? | probe 5ba | phase-5-task-6 |
| Are approvals sign-constrained, so a negative approval cannot offset a limit or drop below `PAID`? | probe 5az | phase-5-task-6 |
| Does certification take ONE ascending lock order over every PO line the bill touches? | probe 5bb | phase-5-task-5 |
| Do the SIX EXPOSURE buckets partition the money as residuals at both ends of the chain, with `budget` reported as authority outside the partition? | probe 5bc, 5bm | phase-5-task-7 |
| Does enabling the capability attribute every pre-existing live PO line (ROWS), or refuse naming it? | probe 5bd | phase-5-task-1 |
| Do both structural tables parse from ONE contiguous table each? | probe 5be | phase-5-task-1 |
| Is exact decimal arithmetic used on both sides — `Prisma.Decimal` server, `lib/decimal.ts` browser? | probe 5ay | phase-5-task-7 |
| Is a live PO line's attribution unrepresentable as an in-place edit, not merely once superseded? | probe 5ai | phase-5-task-1 |
| Do all FOUR labour lifecycle sites attribute, including cancel and close-short? | probe 5aj (attribution half) | phase-5-task-1 |
| Does certifying a LABOUR bill take the labour PO-line lock, under a barrier against close-short? | probe 5aj (certification half) | phase-5-task-5 |
| Is a deduction refused after an approval it would invalidate — the fourth §0b withdrawal site? | probe 5ab | phase-5-task-6 |
| Does a bill line name exactly one PO line at PG, neither zero nor two? | probe 5bf | phase-5-task-4 |
| Is there a frozen vendor-document key that makes a duplicate claim unrepresentable? | probe 5bg | phase-5-task-4 |
| Does supersession carry retention RELEASES with the deductions, so nothing is clawed back? | probe 5bh | phase-5-task-5 |
| Is `PAID` floored at zero, so a reversal cannot exceed the cash paid? | probe 5ae | phase-5-task-6 |
| Does an attribution name exactly one PO line, with no amount column to copy into? | probe 5bi | phase-5-task-1 |
| Is `budget` reported as AUTHORITY, with only the six exposure buckets partitioning the money? | probe 5bm | phase-5-task-7 |
| Does the status derivation tell unapproved payable from approved-not-paid, never inventing an approval? | probe 5bn | phase-5-task-6 |
| Does labour close-short refuse to move the ordered line below what is already MEASURED? | probe 5bo | phase-5-task-3 |
| Is cumulative advance recovery capped at the advance actually PAID? | probe 5bp | phase-5-task-6 |
| Is `NET_PAYABLE` floored at zero by a guard on the DEDUCTION, not only on the approval? | probe 5br | phase-5-task-5 |
| Does a zero-net certificate reach a terminal status rather than stranding? | probe 5bs | phase-5-task-6 |
| Can a VERIFIED uncertified claim be disputed when its evidence is withdrawn? | probe 5bt | phase-5-task-5 |
| Does the over-budget exception fire from commitments AND budget revisions AND re-attributions? | probe 5bq | phase-5-task-2 |
| Does the duplicate-document index release on `rejected`/`resolved` so a corrected resubmission is possible? | probe 5bj | phase-5-task-4 |
| Does a retention release re-derive payment status, so `paid` cannot stand with cash owed? | probe 5bk | phase-5-task-6 |
| Does a reducing measurement dispute uncertified claims and refuse only against a certificate? | probe 5bl | phase-5-task-4 |

## Round 10 (head `c5f9887` → `d3d9945`) — the prediction fired, and this section was missing

Seven findings. Six correct and fixed: a `UNIQUE (projectId, code)` on `CostHead`; the §F
full-reversal payment bullet; output supersession removed from §E; the acceptance-reversal
dispute rule; the complete reason-column list; and probes 5am–5ap.

One was verifiably FALSE — a P1 claiming the PR lacked large-review-unit scope evidence. The
`review-scope` job had already PASSED on this exact head after the `justified-large` marker was
added to the PR body: run 30516875427, job 90788612886, against the pre-marker failure at job
90788370524. It is also out of a review's scope by `AGENTS.md` ("do not review CI state"),
because the trusted gate evaluates it before promotion and fails closed. Dismissed with that
evidence, which is the first dismissal in 86 findings.

**The round-8 prediction fired.** Round 8 committed to this: if a later round again contains a
stale-copy finding, the one-site meta-rule failed too, and the next step is not another document
change. Round 9 had none. Round 10 had three, and two were in round 9's own edits.

**A defect in this packet, found while writing round 11.** The Termination section below says
round 10's false finding was "dismissed above with the passing check-run cited" — and until this
edit there was no round-10 section above it to dismiss anything. The evidence existed (it is in
the round-10 commit message) but the packet asserted a location that did not contain it. A packet
that cites itself incorrectly is the same defect class it is documenting, so it is recorded here
rather than quietly back-filled.

## Round 11 (head `d3d9945`) — six findings, and the corrective discipline that was missing

All six correct, all fixed:

| Finding | The defect | Fix |
|---|---|---|
| §0 table | prose interrupted the Markdown table twice, so `CERTIFIED`/`APPROVED`/`COMMITTED` were not rows of it — and probe 5g enumerates "every row of that table" | both prose blocks moved BELOW the table; all 13 sets are now one contiguous table |
| §E labour billed side | ordered froze `ratePerPersonShift + shiftPremium`; billed compared `quantity × rate`, so a ₹100+₹20 line verifies against ₹1,000 not ₹1,200 | billed uses the SAME combined frozen terms |
| §G reversal participant | disputing "only claims individually over-bound" cannot enforce an AGGREGATE bound: accept 100, bill 60+40, reverse 20 → each ≤ 80, fold 100 > 80 | dispute against the fold, newest-first by `(submittedAt, id)`, stopping when the bound holds |
| probe 5c | required superseding an `ActivityWorkOutput` that Phase 4 made append-only | replaced with the existence test §0 defines + the sign-off path (5k) that really exists |
| probe 5ad | a ₹50 reversal before superseding a ₹100 paid certificate leaves `PAID` ₹50 > `APPROVED` ₹0 | the FULL ₹100 reversal, with the complete legal sequence spelled out |
| Task 4 scope | Task 3 ships measurement corrections with only a zero floor; Task 4 is the first task with live bills but named only the acceptance guard | Task 4 ships BOTH withdrawal guards; the §D live-claim floor lands with the first live bill |

**The corrective discipline, which is what round 10 actually got wrong.** Applying §0b's
own site-closure rule to these six turned up THREE MORE stale statements of the
output-supersession assumption that Codex had not flagged — §D's re-check rationale, §E's setup
sentence, and the probe-coverage list ("all four withdrawal paths"), plus probe 5q. So that one
rule had SIX written statements and FOUR were stale.

The mechanism is now exact, and it is not the one round 8 named. Round 8 said the defect is *a
rule with two written statements*. True, but incomplete: **the second statement keeps being
created by the correction itself.** Round 10 "removed output supersession from §E" by appending
`**Output supersession is NOT one of these paths**` immediately after a sentence that still
asserted Activities *can* supersede the output. The paragraph then contradicted itself, and every
other site kept the old claim.

So the rule is not "state it once" — it is **a correction DELETES or REWRITES the superseded
sentence; it never annotates it.** Annotation feels safer because nothing is lost, and it is
strictly worse: the stale claim stays readable and authoritative-looking, and the next reader (or
the next task) can follow either one. This head rewrites all four sites instead of negating them.
That is also exactly how #253 round 9 was closed — a stale comment deleted rather than left
standing beside its replacement.

**What this says about the plan, stated plainly.** Twelve finding-bearing heads and 92 findings
on one 1,700-line document specifying seven tasks. Five of round 11's six findings are per-task
mechanism detail — a formula in a verification table, two probes' worked arithmetic, one task's
scope row. Those are the things a RED probe settles in one run and prose cannot settle at all.
The recommendation carried since round 8 stands and is now better evidenced: keep §0, §0b, §K,
§L, §M, the task table and the probe list in the phase plan, and let each task PR author its own
§B/§C/§E/§F/§G/§H/§I mechanism detail where a failing test can adjudicate it. Phase 3 and Phase 4
cleared in 2 and 3 rounds by doing exactly that. That is an owner decision because splitting
wrongly could drop reviewed architecture, so it is recorded, not acted on unilaterally.

## Round 12 (head `4fcedd6`) — twelve findings, and ten were already-decided rules

All twelve correct. The count is the highest of any round on this PR, and the composition is the
important part: **ten of the twelve are a rule §0 or §I already decided, applied at one site and
missing at another.** Only two are genuinely new mechanism.

| Finding | Already-decided rule it missed | Fix |
|---|---|---|
| one live budget chain per cost head | §0 defines `BUDGET` as "the LIVE version only" — which presupposes one chain | partial unique on the live root + `amount >= 0` |
| attribution authority on participant writes | §I decides authority per WRITE; the participant path was unnamed | `CommercialParticipant.attribute` enforces `commercial.attribute` |
| measurement uncapped by ordered qty | §D bounds evidence; only `EFFORT` was stated | cumulative `MEASURED ≤ ordered personShiftQty` unless amended |
| acceptance consumption by row only | protects too much | set carries `(rowId, consumedQty)` |
| measurement consumption unfrozen | the same rule, other side | identical `(rowId, consumedQty)` freeze |
| labour tax/freight with no ordered side | Phase 4 froze none, and §0 puts Phase-4 edits out of scope | Phase 5 refuses them at PG (`CHECK = 0`) |
| `disputed → under-verification` | §0 already says "re-enters the fold only as a NEW live version" | resolution supersedes; disputed is terminal |
| supersession drops deductions | §0 scoped APPROVALS to the live certificate | deductions re-stated on the new certificate |
| deduction/release permissions absent | §H makes those rows attributable | `commercial.deduct` + `commercial.release` |
| `Prisma.Decimal` in the frontend | not implementable — the web package has no Prisma | server `Prisma.Decimal`, browser `lib/decimal.ts` |
| vendor-pinning backfill (NEW) | — | diagnostic-first backfill from the PO chain before the FK |
| — | — | probes 5aq–5ay pin all of the above |

**What the composition says.** Round 11 named the mechanism: a correction that ANNOTATES rather
than REWRITES leaves the stale statement standing. Round 12 shows the other half of the same
problem — a rule can be stated correctly in §0 and simply never reach the section that needs it.
Round 11's rule ("rewrite, never annotate") governs corrections. It says nothing about a rule
that was right the first time and was never propagated. That is what §0b's site-closure table was
for, and §0b has now failed at this twice, because a prose table of sites is itself prose: it
cannot be checked, and nothing fails when a site is missing.

**This is the argument for the split, made by the findings themselves.** Ten of twelve are
"§0 decided X; section Y does not know". In a plan that states each decision once and hands
per-task mechanism to the task PR, §0 IS the single statement and the task's own probe is what
checks the propagation — a RED test, not a reader. The recommendation carried since round 8 has
not changed, and this round is its strongest evidence: 13 heads, 104 findings, no declining rate,
and the defect class is now precisely "one decision, many uncheckable restatements".

## Round 13 (head `a7aa5fd`) — six findings, and the class did not change

All six correct, and all six are round 12's composition again: a rule already decided, not
carried to a site that needed it.

| Finding | Already-decided rule it missed | Fix |
|---|---|---|
| payment status stale after reversal | §0 makes `PAID` a fold; a status column is a cache of it | re-derived under CAS after reversal (probe 5ba) |
| Tasks 6–7 are prose, not table rows | round 12 fixed the §0 table's contiguity — at ONE of the document's two tables | execution table contiguous, 7 rows (probe 5be) |
| per-line lock order, not per-bill | §A already fixes one ascending order per lock protocol | ONE ascending order over every PO line the bill touches, before per-line work (probe 5bb) |
| approvals missing from the sign list | §H's STRICTLY POSITIVE list named every other row kind | approvals added (probe 5az) |
| `capability:enable` silent on live PO lines | §L requires attribution for anything the pilot claims | attributes every live PO line or refuses naming them (probe 5bd) |
| §J buckets read as gross totals | §0 defines each bucket as a residual | `approved = APPROVED − PAID`, etc. (probe 5bc) |

**The second finding is this packet's own remedy failing to propagate.** Round 12's fix was to
make the §0 table contiguous, because prose interleaved into a table makes rows invisible to a
reader scanning it. I fixed that table. This document has two tables of that kind, and I did not
look at the other one. One round later the identical defect was found in the execution table.
There is no better illustration of the class: the rule was correct, freshly written, and mine, and
it still did not reach the second site.

### The same defect, in the gate, authored by me

PR #253 — the mechanism built to bound this review — merged while this head was in flight. It
added a rule I wrote: past the round cap a docs-only review owes a probe deferral, and a PR that
edits `docs/STATUS.md` cannot have that deferral's phase verified, because the gate runs from the
trusted default branch and reads `main`'s STATUS, which is not the PR's own phase truth.

This PR edited `docs/STATUS.md`. I wrote that rule knowing this PR was open and did not check it
against this PR's composition, so the mechanism intended to close this review made it
unmergeable instead. Verified rather than assumed, by running the merged gate over this PR's real
file list and `main`'s real STATUS:

- pre-subtraction composition (STATUS in the diff) → `allowed = false`, blocked on exactly that
  clause;
- after subtraction → `allowed = true`;
- with the deferral trailer removed → `allowed = false`, so the check is live, not vacuous.

The remedy is the one the gate's own message names: **land the STATUS change separately.** The
Now-block flip and the Phase-5 task table leave this PR and go to a follow-up PR after it merges,
which is how every prior phase transition has landed (Task 3's flip was PR #237). `main`'s STATUS
already records `next_task: phase-5-planning`, so `deferralPhases` yields `[5]` and
`phase-5-task-1` is a verifiable target with no STATUS edit needed here.

Two consequences worth stating plainly. The earlier F1 and H1 fixes in this packet were STATUS
fixes; they are no longer in this PR and move with it — the packet should not claim a fix it does
not contain. And the fix here is subtraction, which is the same shape as round 8's: the head that
closes a propagation defect removes a copy rather than adding a rule about copies.

### The split is approved

The recommendation carried since round 8 — keep §0, §0b, §K, §L, §M, the task table and the probe
list in the phase plan, and move §B/§C/§E/§F/§G/§H/§I per-task mechanism into each task's own PR —
was put to the owner with this round's evidence and **approved**. It ships as ONE separate PR after
this one merges, moving text **verbatim** rather than rewriting it, so no reviewed decision is
dropped in the move. It is not folded into this head: restructuring the document under review
would invalidate the review in progress.

## Round 14 (head `56006de`) — eleven findings, and four were corrections that stopped short

All eleven correct. The composition is the same as rounds 12 and 13, with a sharper edge: **four
of the eleven are a fix from an earlier round of THIS review, applied at one site and not at every
site the same rule governs.** Not new mechanism missed — my own remedies left half-finished.

| Finding | The round that half-fixed it | Fix |
|---|---|---|
| §J `certified-payable` subtracts approvals from GROSS `CERTIFIED` | round 13 made `approved`/`paid` residuals and left the pre-certification buckets raw | all six buckets defined as residuals in one table; `NET_PAYABLE − APPROVED` |
| §J `received-not-billed` is a raw accepted value | same round, same table, the other end | accepted/measured **−** live `BILLED_AMOUNT` (probe 5bc extended) |
| supersession re-states deductions but not RELEASES | round 12 stated the rule for deduction rows only | releases re-scoped in the same transaction; both halves of the fold share one scope (probe 5bh) |
| §C attribution seal fires only once SUPERSEDED | round 12 wrote the seal narrower than the bug it described | DELETE always refused; UPDATE refused except stamping an ACTIVE row superseded (probe 5ai, RED against the old spelling) |
| §0b names `ActivityWorkOutput` supersession as a withdrawal path | the output-supersession cleanup corrected §0/§D/§K and not §0b | row lists only paths that exist — an impossible closure site cannot be closed, so it converts a criterion into an excuse |
| the closure probe covers 3 of §0b's 4 withdrawal sites | the fourth site was added to §0b and not to the probe | deduction-after-approval driven end to end: refusal under the bill lock, supersede→re-approve as the representable path, pre-approval deduction still permitted |
| the labour probe covers issue/amend, not cancel/close-short | §0b names four lifecycle sites; the labour twin covered two | all four, with `COMMITTED` asserted at ₹0 after cancel and ₹40 after close-short |
| the deferral ledger replaced by a pointer at the probe list | round 13, in this packet | real ledger rows restored for 5aq–5bh |
| a bill line's PO reference has FKs but no XOR | new | PG CHECK: exactly one of material/labour, `type` must agree (probe 5bf) |
| `duplicate-claim` named with no identity to detect it | new | frozen `vendorBillNumber` + partial unique per `(project, vendor, number)`, Task-2's one-quote shape; service verdict for what the index cannot see (probe 5bg) |
| `PAID` has no non-negative floor in the rule text | new | the refusal stated in §H under the bill lock, not only in probe 5ae |

**What four half-finished fixes say that twelve fresh defects would not.** Rounds 12 and 13
diagnosed the class as "a rule decided once, not propagated to every site". This round shows the
same failure one level in: when I fix a propagation defect, the FIX propagates incompletely too. I
corrected the §J buckets and stopped at the two I had been shown; corrected deduction scoping and
stopped at deductions; wrote a seal for the case the finding named rather than the case the
paragraph above it described. Each time the reviewer's example became the specification, and the
rule it was an example OF went unapplied.

That is a specific, nameable habit, and it has a specific remedy: **when a finding names a site,
fix the RULE and then enumerate the sites it governs from the document, not from the finding.**
Round 13's §0-table lesson was the same shape ("this document has two such tables") and I recorded
it as a one-off rather than as this. It is not a one-off. The §J fix here enumerates all six
buckets in a table so a seventh cannot be added without a row; the deduction fix states that both
halves of the fold always share one scope; the attribution seal is stated as the general
append-only shape with its one exception rather than as a list of refused cases.

The remaining four are ordinary new mechanism, and one of them — `duplicate-claim` — is worth
noting as the §0b failure in its purest form: an exception KIND was named in a verdict enum with no
identity anywhere that could detect it, so every bound would have passed for both copies of one
invoice and Task 4 would have had to invent the predicate the plan declared.

## Round 15 (head `badd6e1`) — seven findings, three of them defects round 14 introduced

All seven correct. Round 14's own lesson was "fix the rule, then enumerate its sites from the
document" — and three of these seven are round 14 failing that test in the act of writing it.

| Finding | Origin | Fix |
|---|---|---|
| **P1** the restored deferral ledger maps questions to the WRONG probes | round 14, mine | rows 5aq–5ax rebuilt from each probe's own text; mapping then verified mechanically |
| `CommitmentAttribution`'s freeze list names an `amount` column | round 14, mine | the row carries NO amount — §C already said "the amount is not copied" |
| the attribution needs the same XOR seal as a bill line | round 14, mine | `CHECK ((poLineId IS NULL) <> (labourPoLineId IS NULL))` (probe 5bi) |
| the duplicate index keys on "non-cancelled", a state §F has no arrow for | new | predicate is `NOT IN ('rejected','resolved')` — the lifecycle's own terminals (probe 5bj) |
| a retention release after `paid` leaves the status stale | new | derivation is against `NET_PAYABLE`, not `APPROVED`; `deductions.release` re-derives under CAS (probe 5bk) |
| a reducing measurement is refused by any live claim, certified or not | new | DISPUTE uncertified claims newest-first, refuse only against a certificate — §G's material disposition at the measurement site (probe 5bl) |
| the capability ships in Task 1, the attribution table in Task 2 | round 13, mine | the table, its seals, the participant and the activation backfill move to Task 1; Task 2 owns the lifecycle |

**The P1 is the worst kind of error I have made on this PR**, and it is worth being precise about
why. Round 14 restored the deferral ledger because a pointer at the probe list "answers only the
middle term". I then wrote the rows by mapping round 12's findings, in the order I had listed them,
onto probe letters in the order they appear — and never opened the probes. So `5aq` (budget
uniqueness) was labelled as the labour tax/freight question, and seven rows after it were shifted
by one. The ledger was not merely wrong: it pointed review at probes that cannot adjudicate the
questions beside them, which is worse than the pointer it replaced, because a pointer is honestly
vague and a wrong citation looks like evidence.

The remedy is not care. It is that I now derive the mapping instead of asserting it: every row's
probe id is extracted from the plan and checked to exist, and every probe in the 5aq–5bl range is
checked to have a row. That run reports **45 ledger rows, every probe reference defined, no probe
without a row.** The same mechanical habit caught the round-14 bucket-table and set-count defects
before they shipped; it should have been applied to the ledger in the same pass.

**The other two round-14 defects are the propagation class inside a propagation fix.** I added the
bill-line XOR rule and did not carry it to `CommitmentAttribution`, which has the identical
nullable-alternatives shape one section earlier — and the consequence is sharper there: one row
standing for two obligations means superseding the material side silently un-attributes a live
labour line, so `COMMITTED` drops for work still owed. And while rewriting §C's freeze list I
included an `amount` column, twenty lines below the sentence "the amount is not copied" — creating
the second committed-amount ledger §C exists to forbid. Neither is a subtle mechanism; both are
what happens when a rule is restated in a second place instead of read from the first.

The Task-1/Task-2 sequencing finding is round 13's: probe 5bd requires enabling the capability to
attribute every pre-existing live PO line, and the task table put the attribution table a task
later. Two independent statements about the same thing, contradicting; the fix names which one
moves and why either escape would be worse.

## Round 16 (head `637ef71`) — eight findings, five of them my own fixes reaching one surface

All eight correct. The class is now precise enough to name exactly: **a rule in this plan lives on
three coupled surfaces — the §-section prose, the probe that adjudicates it, and the ledger row that
schedules it — and my corrections keep landing on one or two of the three.**

| Finding | Surfaces the round-15 fix reached | Fix |
|---|---|---|
| probe 5bg still requires a resubmission after `cancellation` | prose only (§F predicate corrected) | the probe names `rejected`/`resolved` |
| probe 5ai still demands rejecting an UPDATE of `amount` | prose only (§C column removed) | the probe drops it and says why |
| ledger row settles deduction-after-approval at Task 5 | prose + probe | Task 6, where approval exists |
| ledger row asks whether tax/freight are POSITIVE | prose + probe (5ag made them non-negative) | quantity positive, tax/freight non-negative |
| Task 1 enables the capability; the forward attribution hooks are Task 2 | backfill only | Task 1 owns the forward hooks too |
| `budget` = `BUDGET − COMMITTED` double-counts downstream money | new | budget is AUTHORITY; only the six exposure buckets partition (probe 5bm) |
| `NET_PAYABLE > APPROVED` derives `approved-for-payment` with `APPROVED = 0` | new | a three-fold table that never invents an approval (probe 5bn) |
| labour close-short can reduce ordered below MEASURED | new | `assertOrderedNotBelowMeasured` on the close-short/amend path (probe 5bo) |

**Two of the new three are my round-14/15 fixes overshooting rather than undershooting**, which is
worth separating from the propagation defects. The §J budget row was wrong twice in opposite
directions — raw `BUDGET` double-counts, `BUDGET − COMMITTED` also double-counts because `COMMITTED`
is already only the outstanding remainder — and the answer was not a third subtraction but noticing
that budget is a CEILING, not an exposure state. The payment derivation fixed a status that
understated cash by writing one that overstates authority: a release with no approval anywhere moved
the bill into the post-approval state. Both came from patching the arithmetic named in the finding
instead of asking what the quantity IS.

### The three-surface coupling is now mechanically checked

Round 15 built a verifier for the ledger's probe references after mis-mapping eight rows. It checked
that every reference RESOLVES — which is why rounds 15 and 16 have no undefined references — and
nothing about whether a probe still asks for something the prose withdrew. So the same class simply
moved one surface over. The verifier now also checks:

1. every ledger probe reference is defined, and every probe in range has a ledger row (round 15);
2. no probe uses a term the plan declares does not exist, judged per sentence so that RECORDING a
   correction ("never a `cancelled` one, which §F does not define") is not itself flagged;
3. no probe demands PG reject an UPDATE of `amount` on `CommitmentAttribution` — a construct check,
   because rule 2 cannot catch it: that sentence carries an unrelated negation, so tone is not a
   usable signal and the construct has to be matched directly.

Run against the reviewed head `637ef71` it reports **both probe defects, RED**; against this head,
**clean**. Rule 3 exists because writing rule 2 and testing it honestly showed it missing one of the
two — and the first version of rule 2 missed BOTH, because I wrote the forbidden term as `cancelled`
while the actual defect said `cancellation`. The RED fixture caught that, which is the whole reason
to build the fixture from the real head instead of hand-editing a plausible one.

## Round 17 (head `c0cc9d8`) — seven findings, and the P1 was a claim I had made six times

All seven correct. Four are round-16 fixes that reached the prose and not the probe or ledger —
the same three-surface class, sixth consecutive round.

| Finding | Origin | Fix |
|---|---|---|
| **P1** the trailer names `phase-5-task-1` while the ledger defers to Tasks 1–7 | rounds 11–16, mine | the trailer names `phase-5-task-7`, the last stop that settles the ledger |
| probe 5bk expects `approved-for-payment` on release-after-payment | round 16, mine | `certified` — the row of the table round 16 wrote in the same commit |
| probe 5bc still sums SEVEN buckets to exposure | round 16, mine | the six exposure buckets sum; `budget` asserted separately as authority |
| the 5aj ledger row settles at Task 2; certification is Task 5 | round 16's move of the attribution half to Task 1 | split into attribution (Task 1) and certification-lock (Task 5) rows |
| the over-budget exception fires only on commitments | new | also on budget revision and re-attribution, recomputing source AND target (probe 5bq) |
| the advance-recovery cap has no probe | new | probe 5bp: ₹150 against a ₹100 paid advance refused, ₹100 permitted, +₹1 refused |
| `received-not-billed` is not on `BILLED_AMOUNT`'s money basis | new | prorated landed for materials, frozen rate + premium for labour — citing §0's `COMMITTED` basis rather than restating one |

**The P1 deserves more than a table row.** Rounds 11 through 16 all carried
`Review-Deferred-To-Probes: phase-5-task-1`, and every one of those heads also carried a ledger
deferring questions to Tasks 2 through 7. The trailer's meaning is fixed by AGENTS.md — the review
stop that SETTLES the deferred questions — so for six heads I asserted that a Task-1 stop
adjudicates payment-status and cash-forecast questions whose probes cannot run until Tasks 6 and 7.
The gate could not catch it: it validates that the value names a task in an active phase, which
`phase-5-task-1` does. Round 15's verifier could not catch it either, because I built it to check
that probe references RESOLVE, and this is a claim about WHEN.

It is arithmetic — max of a column — so it is now checked. Run against `c0cc9d8` the verifier
reports `deferral names task 1 but the ledger's last settling task is 7`, RED; here it reports
`task 7 == ledger max`. Adding a Task-7 row without moving the trailer now fails.

Two smaller things worth recording rather than smoothing over. Fixing the checker exposed that it
had been reading **48 of the packet's 57 ledger rows** — my new rows carry a parenthetical
(`probe 5aj (attribution half)`) and the row pattern did not allow one, so nine rows were silently
outside every check including the new one. A checker that quietly skips input is the same defect it
exists to catch, and it was mine, introduced in the same round as the check. And the orphan-scan
range still ended at `5bo` while the probes had reached `5bq` — a hardcoded bound going stale,
which is precisely what probe 5g warns about and what round 15's `5be` count already taught. Both
corrected; the row parser now tolerates qualifiers and the range follows the letters.

### Round 17 addendum — three more findings on the same head, arriving after the correction

Three further comments landed on `c0cc9d8` AFTER I had pushed round 17's correction. They belong to
that head's count, not to a new one: `c0cc9d8` received ten findings, not seven. All three were
verified still present in the round-17 tree and fixed on the same head as this addendum.

| Finding | Fix |
|---|---|
| a ₹150 penalty on a ₹100 certificate drives `NET_PAYABLE` to −₹50 | the floor is a guard on the DEDUCTION, refusing any row that would exceed the live certificate's withholdable balance (probe 5br) |
| a zero-net certificate can never leave `certified` | `NET_PAYABLE = PAID → paid` is evaluated FIRST; with strictly-positive approval and payment rows, no legal row could otherwise advance it (probe 5bs) |
| the withdrawal guard disputes a `verified` claim, but §F has no such arrow | `verified → disputed` added, with the reason: rejection judges the claim, a dispute says its evidence moved (probe 5bt) |

The zero-net defect is mine from round 16 — the same table, ordered so that its guard against
inventing an approval strands a bill with nothing left to pay. Fixing the overstatement created an
understatement two arms away, which is the round-16 "overshooting rather than undershooting" note
recurring inside the same table.

**On timing, stated plainly:** a Codex review of `52f6049` was already in flight when these arrived.
Pushing supersedes it and costs a review round. I pushed anyway, because all three are verified
correctness defects in the plan text and a clean verdict on `52f6049` would have queued auto-merge
with them still in. Spending a round is recoverable; merging a status table that permanently strands
a settled bill is not.

## Round 18 (head `3233aa4`) — seven findings, and all seven trace to one seam I drew

All seven correct, and this round is different in a useful way: they are not seven independent
propagation misses. **Four of them, plus part of a fifth, come from a single decision — the
Task-1/Task-2 boundary I drew in round 16** — and once that seam is corrected they resolve together.

Round 16 put the `CommitmentAttribution` table, its seals, the participant, the activation backfill
and the forward lifecycle hooks in Task 1, and left the `COMMITTED` fold and the over-budget
exception in Task 2. That split looked like "write the facts / read the facts". It is not a
boundary a review stop can sit on:

- probe 5bd asserted `COMMITTED(costHead)` at the Task-1 tree, which has no fold to answer with;
- Task 1 shipped a revisable `BudgetLine` while the exception that reports its breach was a task
  away, so revising a live budget from ₹100 to ₹50 against a ₹90 attributed PO produced −₹40 of
  headroom **with nothing in the tree able to say so** — a budget you can revise but whose breach
  nothing reports is worse than no budget, because the number looks authoritative;
- the ledger still sent the live-PO-line attribution question to Task 2 after the hooks moved to
  Task 1, so a Task-1 PR could omit the amend/cancel/close-short hook with no stop obliged to catch it.

**The fix is to move the seam, not to patch across it.** `BudgetLine` moves to Task 2 and joins the
fold and the exception, because authority is only meaningful against the obligation it measures:
Task 1 is "every live PO line is attributed to a cost head, from whenever the capability is on"
(`CostHead` yes, budget no, so no headroom to be silent about), and Task 2 is "budget authority
exists and is compared against committed obligation" — fold, exception and Inbox action together,
verifiable by its own probes. Probe 5bd splits into the ROW assertion at Task 1 and 5bu, the
`COMMITTED`-reads-the-backfill assertion, at Task 2.

I considered merging Tasks 1 and 2 instead — the other coherent answer — and rejected it: it would
renumber five tasks across roughly sixty prose references and sixty ledger rows, which is the
highest-risk edit available given that multi-site propagation is this review's recurring failure.
Moving one model between two adjacent tasks achieves the same coherence with a bounded diff.

The remaining three are ordinary:

| Finding | Fix |
|---|---|
| `received-not-billed` scaled the WHOLE landed amount by `ACCEPTED / qty`, over-valuing overage | tax and freight clamped at frozen authority (`min(ACCEPTED, qty)`), overage at rate only unless an amendment freezes more — the §E billed-side cap, on the received side |
| the measurement correction floor was aggregate-only | the frozen `(measurementId, consumedQty)` set is checked FIRST; the A/B/−A case leaves aggregate `MEASURED` intact while the certificate silently re-hosts onto unevaluated rows |
| two bill-dependent probes were deferred to tasks with no bill | 5bt → Task 5 (needs `verified`), 5bl → Task 4 (needs a `VendorBill`) |

One housekeeping note: I first numbered the new Task-2 probe `5bd′`, which the ledger verifier cannot
parse — a primed identifier in a mechanically-checked document is a trap for the next round. Renamed
`5bu` before pushing.

## Termination, and what happens next

Nineteen finding-bearing heads: 8, 8, 7, 7, 9, 5, 10, 7, 7, 11, 7, 6, 12, 6, 11, 7, 8, 10, 7 — **one
hundred and fifty-three** findings. One hundred and fifty-two were correct; round 10's scope-evidence P1 is the only verifiably false one, dismissed
in the round-10 section above with the passing check-run cited. (The round-7 packet said "sixty-six" for the
first eight heads; that list sums to 61. My arithmetic, corrected here rather than carried
forward — a packet that miscounts its own evidence is not evidence.) Round 3's packet recorded
the recommendation to hand the remainder to probes; the owner approved it and asked for the
process to be fixed so this does not recur.

That fix is **PR #253** (`Review-Deferred-To-Probes`), which bounds a docs-only review at
`PLAN_REVIEW_ROUND_CAP = 3` finding-bearing heads and requires the remaining questions to be
converted into named probes plus the task that settles them. **It merged at `a16e68c`, and this
head is the first to run against it** — `origin/main` is merged into this branch here, so the
gate the workflow runs is the merged one.

The deferral ledger is the **table above**, and it now covers every round through this one. Round
13 replaced it with a sentence pointing at the plan's probe list, which is not a ledger: the
mapping a reviewer needs is question → probe → settling task, and a probe list answers only the
middle term. Rounds 12 and 13 added probes 5aq–5be with no ledger rows at all, so their open
questions were unreadable from the packet — the obligation is trailer AND ledger, and the pointer
quietly discharged half of it. The table carries real rows for all of them, plus the four this
round adds. This head closes through that route with
`Review-Deferred-To-Probes: phase-5-task-7`, verified against the merged gate rather than
asserted (see the round-13 section: allowed with the trailer, refused without it).

**Why task 7 and not task 1.** Rounds 11–16 named `phase-5-task-1`, and that was wrong for a
reason worth stating rather than quietly editing: the trailer names the review stop that SETTLES
the deferred questions, and the ledger above defers questions to every task from 1 to 7 — payment
status at Task 6, the cash forecast at Task 7. Naming Task 1 claimed the whole ledger was
adjudicated at a stop where most of its probes cannot even run, which would let the loop treat
payment and forecast questions as settled before the code that could break them exists. A ledger
spanning several stops is discharged at the LAST of them, so the trailer names Task 7 — the final
stop, where §M and the pilot acceptance chain close the phase. The alternative the finding offers,
restricting the ledger to Task-1 questions, would be worse: it would delete the schedule for
twenty-odd real open questions to make one trailer true.

This is now checked, not remembered: the verifier asserts the trailer's task equals the maximum
task in the ledger, so adding a Task-7 row without moving the trailer fails.

Round 4's packet said I would report rather than answer a sixth PROSE round. Neither round 5
nor round 6 was that: mechanism defects with right answers, so answering them was correct and
the commitment did not apply. It still stands for its actual case — a round whose findings are
all "the plan should also specify X" gets reported, not another correction. **What I will not
do is invoke it against a round of real defects because the round number matches.**

**The deferral trailer, and what it does and does not claim.** Rounds 3–10 carried no trailer,
on the reasoning that claiming a deferral while fixing every finding would misdescribe the head.
Rounds 11–16 carried `Review-Deferred-To-Probes: phase-5-task-1`; round 17 corrected the VALUE to `phase-5-task-7` (the round-17 section records why that was a P1 and how it is now checked). What follows is about what the trailer CLAIMS, which the correction does not change. The two positions are
compatible once the claim is stated precisely: the trailer says the plan's REMAINING OPEN
questions are settled at Task 1's review stop — which is what the ledger above records — not that
any round's findings went unanswered. Every finding was fixed on the head that received it. From
this head the trailer IS load-bearing: #253 is merged, the gate reads it, and the round-13
section records the run that proves the clause fires. What the trailer still does not do is buy
an exit — `guardAgainstCurrentHeadFinding` runs after convergence and fails closed on every
current-head finding, so the only way this PR merges is a head Codex returns clean on. This
paragraph replaces the round-10 and round-11 wording rather than sitting beside it, per round
11's own rule.

An honest note on the trend, since the earlier rounds' framing was about an unbounded review:
the finding counts have not fallen (8, 8, 7, 7, 9, 5, 10, 7, 7, 11, 7, 6, 12, 6, 11, 7, 8, 10, 7) but their KIND has narrowed and
round 8 finally names the mechanism. Rounds 1–6 read as "I fix instances, not classes." Round 7
read as "prose has no compiler." Round 8 is more specific and more actionable than either: **the
recurring defect is a rule with two written statements, and every one of them was created by a
previous correction adding a copy instead of moving the single source.** §0b's new meta-rule
targets exactly that, and unlike §0b's original rows it is enforced by SUBTRACTION — this head
deletes three duplicate declarations rather than adding a fourth checklist.

Round 9 answered that prediction: no stale-copy finding recurred, so the meta-rule held on its
own terms — and the causes moved to three classes prose cannot close (false claims about other
modules' code, task sequencing, and an incomplete §0b site list). The round-9 section records
the reasoning and the correction to what I claimed the round cap does.

**The recommendation, now approved.** The owner approved the split after round 12 (recorded in
the round-13 section): §0, §0b, §K, §L, §M, the task table and the probe list stay in the phase
plan; §B/§C/§E/§F/§G/§H/§I per-task mechanism moves into each task's own PR, text carried
verbatim, as ONE separate PR after this one merges. The reasoning below is what was put to them
and is kept as the record of why.

Nine rounds of correct findings on one
document is not a reviewer problem and it is not (mostly) a carelessness problem — it is a
review-unit problem. This PR specifies seven tasks' invariants in one file, so every round finds
a real defect in a different one, and the deferral cap I built does not and cannot stop that
(it gates convergence paperwork, never a finding). The structural fix is the rule this repo
already has and this PR violates in spirit: ONE architectural concern per review unit.

Concretely: keep §0 (the canonical sets), §0b, §K (the module graph), §L (pilot), §M (frontend),
the task table and the probe list in the phase plan — the parts that are settled, cross-cutting,
and small — and move §B/§C/§E/§F/§G/§H/§I per-task detail into the task PR that implements it,
where code and probes answer the questions instead of prose. That is what Phase 3 and Phase 4
did, and their plans cleared in two and three rounds. This head still fixes all six of its own
findings as written; the split moves text, it does not answer findings.

`origin/main` was merged into this branch on the round-5 head (PR #254, ranged pnpm overrides)
and again on this head (PR #253 the bounded-review mechanism, PR #254, PR #249). Both times the
branch was `behind`, not conflicted — the two merges touched no file this PR changes.

Gates: `pnpm test:automation` **119/119** (111 before the merge; #253's eight probes arrive with
it). The PR's cumulative diff is two documentation files, so no product surface is touched and
`pnpm check` is unchanged by construction.
