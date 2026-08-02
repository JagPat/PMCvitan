# PR #270 — architectural convergence audit (Phase 5 Task 2)

Two finding-bearing heads, seven findings. Per `CLAUDE.md`, the third head is not another isolated
patch: this audit names the ROOTS the seven findings share, and each root leaves a mechanical
closure behind so it cannot recur as a review round.

| Head | Findings | |
|---|---|---|
| `56be595` | 3 | 1×P2 arithmetic, 2×P1 unreachable surface |
| `bc95efe` | 4 | 3×P2 (one arithmetic, one label, one mover), 1×P2 unreachable surface |

---

## The seven findings

| # | Head | Sev | Finding | Root |
|---|---|---|---|---|
| 1 | `56be595` | P2 | Received-not-billed reused `consumed`, scaling the whole landed amount past `qty` — ₹1,265 for a ₹1,250 truth | **B** |
| 2 | `56be595` | P1 | The headroom fold was dead code — no exception writer called it | **A** |
| 3 | `56be595` | P1 | `BudgetLine` shipped with no production write path — `BUDGET(costHead)` could only ever be null | **A** |
| 4 | `bc95efe` | P2 | Accepted overage moves headroom, but `receipts.accept` never evaluates — the breach never opens and its reversal never clears | **B** |
| 5 | `bc95efe` | P2 | PO amend/close-short exceptions were stamped `reattribution` — pointing a PMC at a reclassification that never happened | **B** |
| 6 | `bc95efe` | P2 | A sub-cent negative headroom is written to `Decimal(18,2)`, PostgreSQL rounds it to `0.00`, and the `headroom < 0` CHECK then ABORTS the write that was merely reporting a rounding artefact | **B** |
| 7 | `bc95efe` | P2 | `commercial.budget` declared in `COMMERCIAL_QUERIES` with no route — the read the Inbox action needs was unreachable | **A** |

---

## Root A — an incomplete head is not a review head (findings 2, 3, 7)

Three of the seven are one sentence in different words: **something was declared but nothing could
reach it.** A fold with no caller. A table with no command. A query with no route.

None of these is a design defect. They are all the same process defect: I opened PR #270 while the
task was still mid-build, and the orchestrator auto-promotes any green draft to Codex. The reviewer
was doing its job correctly each time — it reported that the work was unfinished, because it was.
That cost both review rounds, and it is mine, not the reviewer's.

The honest correction is not "be more careful". A declaration that nothing reaches is exactly the
kind of thing a machine notices reliably and a human notices late, so:

**Closure A — `apps/api/src/commercial/commercial.contract.test.ts`.** Every entry in
`COMMERCIAL_COMMANDS` must name a real `executeCommand` site with that exact `commandType`; every
entry in `COMMERCIAL_QUERIES` must name a real `@Get` route on the controller; and both must equal
the manifest's own lists, so there is ONE declaration rather than two that can drift. Declaring the
next surface without building it now fails in `pnpm check`, at the desk, with no database.

Proven RED: renaming `@Get('commercial/budget')` produces
*"commercial.budget is declared in COMMERCIAL_QUERIES but no Get('commercial/budget') exists —
clients cannot read what the manifest promises"*.

---

## Root B — a fold change is a mover-set change (findings 1, 4, 5, 6)

The other four are not four accidents. They are four consequences of consuming the fold's output
without re-deriving what each consumer actually needs from it.

§B states the rule as **"the exception is raised from EVERY write that can move headroom"**, and
then names three writes — a commitment, a budget revision, a re-attribution — because those were
the writes that existed when the section was written. My implementation copied the three and lost
the rule. So when finding 1's fix changed the received-value calculation, it changed *which writes
can move headroom* — and nothing re-derived the set. Finding 4 is that gap, and Codex named the
causation exactly: *"fresh evidence in this head is the added `rate.mul(acceptedQty)` overage
valuation, which makes acceptance itself a headroom-moving write."*

The arithmetic here is worth stating, because it is what makes finding 4 real rather than
theoretical. `committedAmountBase = rate × qty + tax + freight`, so for `ACCEPTED ≤ qty` the
commitment consumed is exactly the value received: the buckets hand the money to each other and
**exposure is conserved**. Overage breaks the symmetry deliberately — §G authorises the extra
units, §J values them at the frozen rate, and no commitment is released against them. A ₹100 order
accepted at 110 units exposes ₹110 against a ₹100 budget with no purchase-order write anywhere.
That is new obligation created at the receipt, and §B's rule already required it to raise.

Findings 5 and 6 are the same shape at two other consumers:

- **5 — the LABEL was not derived from the caller.** `replaceAttribution` serves two different acts
  (the PO amend/close-short lifecycle, and the standalone reclassification) and stamped both
  `reattribution`. An exception explains itself only if the label is the truth.
- **6 — the TEST was not derived at the scale the fact is stored at.** The breach decision ran on
  full-precision arithmetic while the row it writes is `Decimal(18,2)`. A third of a paisa is not a
  breach, and treating it as one does not merely mis-report — PostgreSQL rounds `-0.003` to `0.00`,
  the `headroom < 0` CHECK rejects the row, and the *legitimate* budget revision aborts with a 500.

**Closure B — the same contract test.** A `HEADROOM_MOVERS` table enumerates all six sites that can
change `BUDGET − Σ exposure` and asserts each re-evaluates inside its own transaction, and pins the
four labels against the `raisedBy` CHECK in the migration. The list is no longer the rule's only
home. Adding a mover without evaluating now fails here.

Proven RED: removing the `evaluateBudgetForLine` call from `receipts.accept` produces
*"acceptance (inventory/inventory.service.ts#accept) can move headroom but never re-evaluates —
§B requires raise-or-clear in the SAME transaction"*.

The fold itself is corrected at the source rather than at each consumer: `positionsFor` now rounds
exposure ONCE, from the full-precision sum, and derives headroom from that rounded figure — so the
read surface and the exception register consume one already-money-scaled result and cannot
disagree, and `headroom = budget − exposure` holds at PostgreSQL by construction.

---

## What did NOT change

- Task 1 is not reopened. `CostHead`/`CommitmentAttribution`, their seals and the activation
  backfill are untouched; the round-2 corrections are additive on top.
- The merged migrations are untouched. `20270405000000` is byte-for-byte unchanged;
  `20270410000000` is UNMERGED and part of this PR, so its `raisedBy` CHECK is edited in place
  rather than amended by a second migration — one table, one migration.
- No readiness verdict moves. Commercial remains a SINK: nothing gates on a budget, and the
  acceptance hook raises a flag without ever refusing the acceptance.

## Open owner decision (unchanged, non-blocking)

Whether §L activation should become an ordinary authenticated command rather than an operator CLI
remains recorded in `docs/STATUS.md` and `docs/reviews/pr-268-convergence.md`. It does not block
this task and has not been acted on.
