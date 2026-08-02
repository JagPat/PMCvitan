# PR #270 — architectural convergence audit (Phase 5 Task 2)

Four finding-bearing heads, thirteen findings. Per `CLAUDE.md`, the corrections are not isolated
patches: this audit names the ROOTS the findings share, and each root leaves a mechanical closure
behind so it cannot recur as a review round.

| Head | Findings | |
|---|---|---|
| `56be595` | 3 | 1×P2 arithmetic, 2×P1 unreachable surface |
| `bc95efe` | 4 | 3×P2 (one arithmetic, one label, one mover), 1×P2 unreachable surface |
| `f28a8fd` | 4 | 3×P2 movers/ordering, 1×P2 read snapshot |
| `13c04cd` | 2 | 2×P2 wrong exception LABEL |

**Rounds 3 and 4 are recorded honestly. Three of round 3's findings are root B recurring, because
round 2's closure for root B was itself the wrong shape. Both of round 4's are root D recurring,
because round 2's FIX for the label problem was also the wrong shape — I moved the decision to the
caller when it should have been derived from the data.** Both are written up in full below rather
than presented as six new patches. Twice now the corrective was one level too shallow, and saying
so plainly is more useful than a longer list of patches.

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
| 8 | `f28a8fd` | P2 | Labour `defaultCapacity` sets `committedQty` to 0 — a fold input — without evaluating, so a defaulted commitment leaves its breach standing | **B** |
| 9 | `f28a8fd` | P2 | Reversing a **receipt** changes `receivedQty` — a fold input on a closed-short line — without evaluating; the acceptance-only branch missed it | **B** |
| 10 | `f28a8fd` | P2 | The amend evaluated after its FIRST of three mutations, reading a state that never existed at commit and writing a permanent false clear/re-raise pair into an append-only register | **B** |
| 11 | `f28a8fd` | P2 | The budget read transaction had no isolation level, so under READ COMMITTED it could report healthy headroom beside the exception just opened for that same head | **C** |
| 12 | `13c04cd` | P2 | A PO amend that RECLASSIFIES a carried line recorded the breach as `commitment` — pointing a PMC at an order that never moved | **D** |
| 13 | `13c04cd` | P2 | The inventory hook hard-coded `acceptance`, so a rejection-reversal breach claimed a delivery that never happened | **D** |

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

The fold itself is corrected at the source rather than at each consumer: `positionsFor` now rounds
exposure ONCE, from the full-precision sum, and derives headroom from that rounded figure — so the
read surface and the exception register consume one already-money-scaled result and cannot
disagree, and `headroom = budget − exposure` holds at PostgreSQL by construction.

### Round 2's closure for root B was the wrong shape — and round 3 proved it

Round 2 closed root B with a `HEADROOM_MOVERS` table: six named SITES, each asserted to evaluate.
Round 3 then found **three more movers that table did not contain** — the labour capacity default,
the receipt reversal, and the amend's ordering.

That is not bad luck. **A hand-kept list of sites is the same mistake as §B's hand-kept list of
three writes, one level up.** I replaced "the section names three writes" with "I name six sites",
and a list is exactly what goes stale when the fold changes. The reviewer's own wording on finding 8
makes the causation plain: `committedQty` became a fold input when the closed-short RELEASE term was
written, and everything that writes it became a mover at that moment — whether or not I noticed.

**Closure B (corrected) — derive the mover set from the fold's INPUTS.**
`FOLD_INPUTS` in `commercial.contract.test.ts` now names each field `positionsFor` consumes and
every write path that can change it:

| fold input | owner | why it moves exposure | writers |
|---|---|---|---|
| `committedAmountBase` | procurement | the obligation itself, entering/leaving with the attribution | the three participant mutations (all eight PO lifecycle sites route through them) |
| `receivedQty` | procurement | a closed-short line releases `qty − receivedQty` | `recordReceipt`, `reject`, `reverse` |
| `ACCEPTED` | inventory | the consumed term; overage raises exposure with nothing released | `accept`, `reverse` |
| `committedQty` | labour | a closed-short labour line releases `personShiftQty − committedQty` | `commitCapacity`, `defaultCapacity` |
| `BUDGET` | commercial | authority down is a breach with no commitment write anywhere | `setBudget` |

And critically, the table is **pinned against the read contract it derives from**: the test parses
`MaterialCommittedLine` and fails if the fold gains a field that `FOLD_INPUTS` neither names nor
classifies as frozen. Teaching the fold to read something new now fails at the desk until its
writers are named and made to evaluate. That is the difference between a list and a derivation.

Proven RED: reverting all four round-3 fixes fails exactly four assertions —
`recordReceipt`, `defaultCapacity`, the amend deferral, and the read isolation.

### Ordering is part of the rule (finding 10)

Finding 10 is root B in the time dimension: not *whether* a mover evaluates, but *when*. An amend is
ONE act made of THREE mutations — carry forward, attribute fresh, release dropped — and evaluating
after the first reads a state that exists at no instant of the committed transaction. Because the
exception register is **append-only**, the false clear it writes can never be removed; the history
would permanently record a headroom recovery that never happened.

So the three participant mutations now take an optional deferral sink: with one, touched heads
accumulate and nothing is evaluated; the caller settles once, over the union, when every mutation of
the act is applied. Without one they evaluate immediately, which is correct for a single-mutation
act — **the default stays the safe one and only a multi-step caller opts in.** Both `replaceOnAmend`
sites (material and labour) are pinned to pass the sink to all three calls and to settle exactly
once.

---

## Root D — the label must be DERIVED from what moved, not supplied by who noticed (findings 5, 12, 13)

`raisedBy` is the durable explanation a human reads months later on an **append-only** row. A
wrong-but-plausible label is therefore worse than a vague one: nobody can correct it, and it sends
the reader looking for an event that never happened.

Round 2's finding 5 was the first instance — every replacement stamped `reattribution`, so an
amended order looked like a reclassification. **My fix was to let the CALLER name the label.** Round
4 found both remaining halves of that being wrong:

- **Finding 12.** One amend can re-size some lines and RECLASSIFY others, so no single caller-level
  label is true for the whole call. The caller cannot know; only the row can.
- **Finding 13.** The inventory hook hard-coded `acceptance` for every inventory-side evaluation.
  Reversing a *rejection* moves `receivedQty` with nothing accepted anywhere, so the row claimed a
  delivery that did not exist.

Both are the same shape as root B: I replaced a wrong constant with a *parameter*, when the answer
was always derivable from the data. That is the second time in this PR the corrective was one level
too shallow, and it is worth naming as a pattern rather than a coincidence.

**Closure D.**

- `replaceAttribution` no longer ACCEPTS a `raisedBy`; it derives one **per row** from
  `active.costHeadCode !== code` and attaches it to that row's heads. The contract test asserts both
  the derivation and the *absence* of the parameter, so the round-2 shape cannot come back.
- The deferral sink carries `{code, raisedBy}` rather than a bare code, and the settle groups by
  label — so one amend can legitimately raise `reattribution` on one head and `commitment` on
  another. Where a head is touched by both, `reattribution` wins: it is the more specific claim and
  the one a PMC cannot reconstruct from the PO alone.
- `receipt_progress` joins the mover set (and the `raisedBy` CHECK), because moving `receivedQty` is
  genuinely a different event from accepting goods. The inventory reversal path picks its label from
  `target.type`, not from which branch it is in.

Proven RED: hard-coding the label back in either place fails three assertions.

---

## Root C — a multi-owner read needs one snapshot (finding 11)

The budget read folds four owners' tables across several statements. Under PostgreSQL's default
READ COMMITTED **each statement takes its own snapshot**, so a PO issue committing mid-read returns
healthy headroom beside the exception it just opened for that same head — a page that contradicts
itself, and that nobody can reconcile against the register.

This is a distinct root, not root B: nothing here is a missing mover: every writer did its job. The
defect is that the *reader* never asked for a consistent view of what they wrote.

**Closure C.** `readBudget` runs at `RepeatableRead`, and the contract test pins it there. The read
still takes no `lockProjectReadiness` — it reports, it decides nothing, and blocking every budget
page-load behind the lock that serializes the PO lifecycle would make reporting contend with the
site's own writes. One snapshot is enough to make every figure in a response true at one instant; a
read that is one commit stale is honest, a read that delayed a purchase order would not be.

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
