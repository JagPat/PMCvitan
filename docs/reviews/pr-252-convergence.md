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
