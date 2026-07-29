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
