# Phase 5 Task 2 — budget, `COMMITTED`, and the over-budget exception (review packet)

**Branch** `claude/phase5-task2` · **base** `main` `edb7f08` · **PR** #270
**Convergence audit** `docs/reviews/pr-270-convergence.md` (three finding-bearing heads, eleven
findings, three roots, three mechanical closures — including the honest record that round 2's
closure for root B was itself the wrong shape, which is why round 3 found three more of it)

## Vision alignment

Money follows the site; it does not command it. This task gives the practice the one number a PMC
cannot get from any existing surface — *how much of this cost head is already spent or owed* — and
flags it when the answer exceeds the plan. It **gates nothing**: no purchase order, receipt or
activity is refused because a budget is breached, because stopping site supply over a planning
number is the wrong failure mode (§B). `commercial` stays a SINK — no readiness verdict consults it
in either direction, and §D keeps the whole surface absent off-pilot.

The task adds exactly one new *plan* fact (`BudgetLine`) and one *observation* (`BudgetException`).
Every exposure figure is FOLDED from facts that already exist, read through each fact's OWNING
module. **No committed amount is copied anywhere.**

## What ships

| §  | Thing | Where |
|---|---|---|
| §B | `BudgetLine` — versioned, immutable, one live chain per head, `amount >= 0` | `20270405000000_phase5_t2_budget` |
| §B | `BudgetException` — a lifecycle observation with ONE permitted transition (`open → cleared`), one open row per head | `20270410000000_phase5_t2_budget_exception` |
| §B | `commercial.budget.set` — one command for v1 and every revision; supersede-and-append atomically, no-op revisions refused | `commercial-budget.service.ts` |
| §B | raise-or-clear in the SAME transaction, from every write the fold's inputs make a mover | `commercial-budget.service.ts#evaluate` |
| §C/§0 | `COMMITTED(costHead)` — OUTSTANDING obligation, folded through `ProcurementQuery`/`LabourQuery`/`InventoryQuery` | `commercial-budget.query.ts` |
| §J | received-not-billed, and `headroom = BUDGET − Σ exposure` | `commercial-budget.query.ts` |
| §J | `GET …/commercial/budget` — every head's position worst-first with any OPEN exception | `commercial.controller.ts` |

### The `COMMITTED` definition, and why it is OUTSTANDING

```
COMMITTED = Σ committedAmountBase over attributions whose PO version is LIVE
            − the CONSUMED portion − the RELEASED portion, CLAMPED AT ZERO
```

A ₹100 PO accepted but unbilled would otherwise sit in `committed` AND in received-not-billed at
once, forecasting a ₹200 obligation from a ₹100 order. The buckets must PARTITION the money.

`committedAmountBase = rate × qty + tax + freight`, so for `ACCEPTED ≤ qty` the consumed commitment
exactly equals the value received — **exposure is conserved by acceptance**, and the money simply
changes bucket. That identity is why probe 5bm can assert `committed + receivedNotBilled == 100`
through a full acceptance, and why the acceptance hook (below) only ever fires on overage.

The LABOUR branch has no consumption term: `Measurement` does not exist until Task 3, so a live
labour PO reads its gross amount. That is stated in the code, not hidden.

## Invariant matrix

<!-- review-size: justified-large -->

| # | Invariant | Enforced by | Proof |
|---|---|---|---|
| 1 | **One project = one site.** Budgets, exceptions and every fold input are project-scoped; cross-project references are unrepresentable | same-project composite FKs on `BudgetLine`/`BudgetException` → `CostHead(projectId, code)` | `upgrade-proof.sh` — cross-tenant budget line and invented-head exception both rejected |
| 2 | **Operational records never become global.** Nothing here writes an org-scoped row; the `Vendor` party is read, never extended | schema — every new table carries `projectId` | probe §D: an off-pilot project has zero rows and 404s on both the write and the read |
| 3 | **One fact, one canonical owner.** The committed amount is read from the PO-line snapshot through its OWNING module; commercial stores no amount | `ProcurementQuery`/`LabourQuery`/`InventoryQuery`; `commercial.dependsOn` | `cross-module-graph.test.ts` (no foreign reads from commercial services); probe 5bw |
| 4 | **Attributable human approvals preserved.** Every budget version and every exception carries its actor; supersession requires a complete stamp; nothing is editable or deletable | `BudgetLine_append_only`, `BudgetException_lifecycle`, `*_supersede_complete` CHECKs | `upgrade-proof.sh` — 10 forgeries rejected; the two permitted transitions accepted |
| 5 | **Additive migrations.** Two new tables, no column dropped, no existing migration touched | migrations are `CREATE`-only with `IF NOT EXISTS` guards and a closing row-free ABORT | `upgrade-proof.sh` — both tables exist and are ROW-FREE over the legacy fixture |
| 6 | **Tenant isolation proven against PostgreSQL.** Not service-level validation — the database refuses | composite FKs + partial uniques + CHECKs + triggers | `upgrade-proof.sh` executes 25 Task-2 assertions on the MIGRATED legacy database |

## Scope note — what `headroom` sums today

§J's exposure has six buckets; four of them (`BILLED_AMOUNT`, certified, paid, retention) need
Tasks 4–6 facts that do not exist yet. Headroom therefore sums the buckets that EXIST at this task
— `COMMITTED` and received-not-billed — and Tasks 4–6 add the billing buckets with the facts they
measure. Probe 5bm asserts only the claim that is RED against `BUDGET − COMMITTED` today; the limit
is stated here rather than left for a reader to discover.

## The headroom movers, derived from the fold's inputs

§B's rule is "the exception is raised from EVERY write that can move headroom". **Which writes
those are is not a judgement call — it is a function of what the fold READS.** Round 2 answered it
with a hand-kept list of six sites and round 3 found three more, so the mover set is now derived:
`FOLD_INPUTS` in `commercial.contract.test.ts` names each field `positionsFor` consumes and every
write path that changes it, and is PINNED against the `MaterialCommittedLine` read contract, so a
fold that starts reading a new field fails at the desk until its writers are named.

| fold input | why it moves exposure | writers |
|---|---|---|
| `committedAmountBase` | the obligation itself, entering/leaving with the attribution | the three participant mutations (all eight PO lifecycle sites route through them) |
| `receivedQty` | a closed-short line releases `qty − receivedQty` | `recordReceipt`, `reject`, `reverse` |
| `ACCEPTED` | the consumed term; overage raises exposure with nothing released | `accept`, `reverse` |
| `committedQty` (labour) | a closed-short labour line releases `personShiftQty − committedQty` | `commitCapacity`, `defaultCapacity` |
| `BUDGET` | authority down breaches with no commitment write anywhere | `setBudget` |

**Ordering is part of the rule.** An amend is ONE act made of THREE mutations, so its budget effect
is evaluated ONCE at the end over the union of touched heads. Evaluating between them reads a state
that existed at no instant of the committed transaction, and the register is append-only, so the
resulting clear/re-raise pair would be permanent evidence of a recovery that never happened.

The four exception LABELS the movers produce:

| Mover | Why | Site |
|---|---|---|
| `budget_revision` | authority down — a ₹100 budget cut to ₹50 against a ₹90 PO breaches with **no commitment write anywhere** | `setBudget` |
| `commitment` | exposure up (issue/amend/close-short) or freed (cancel) — eight PO lifecycle sites, all through one participant | `CommercialParticipant` |
| `reattribution` | exposure moves BETWEEN heads — raises on the target, clears on the source | `commercial.service#reattribute` |
| `acceptance` | §G authorises accepting more than `qty`, §J values the overage at the frozen rate, and **no commitment is released against it** — the receipt itself raises exposure | `receipts.accept`, and the reversal of one |

`acceptance` was found by Codex on head `bc95efe` and belongs to §B's rule rather than extending it;
the convergence audit records why the enumeration went stale and how it is now mechanically closed.

## Evidence

| Gate | Result |
|---|---|
| `pnpm check` | **EXIT 0** — web 543/543, API 708/708, build clean |
| Full integration suite, pristine migrated DB | **74 files / 740 tests passed** |
| `phase5-t2-budget.test.ts` | **13/13** — 5am/5af, 5aq, 5bu, 5bw, 5bm, 5bq, acceptance-overage, closed-short receipt reversal, amend-evaluates-once, sub-cent, unbudgeted, authority/idempotency, read surface, §D |
| `upgrade-proof.sh` | **PASSED** — both tables ROW-FREE over the legacy fixture; a coherent budget chain ACCEPTED (the seals are precise, not merely strict); 14 Task-2 forgeries rejected; every prior Phase-1…Phase-5-T1 rejection surviving |
| `commercial.contract.test.ts` | **18/18**, and proven RED against every defect it closes — reverting all four round-3 fixes fails exactly four assertions |

### Reproduce-first, per finding

| Finding | RED before | GREEN after |
|---|---|---|
| Received overage over-valued (₹1,265 vs ₹1,250) | fold reused `consumed` | separate rate + clamped tax/freight calculation |
| Fold was dead code | no caller | `evaluate` called from all four movers |
| No budget write path | `BUDGET` always null | `commercial.budget.set` |
| Acceptance never evaluated | probe: overage raises no exception | probe passes; `HEADROOM_MOVERS` pins the site |
| Amend stamped `reattribution` | caller could not name the mover | `raisedBy` is a required parameter |
| Sub-cent headroom aborts the write | decision on full precision | exposure rounded ONCE at the fold |
| `commercial.budget` unreachable | no route | `GET …/commercial/budget`; closure A pins it |
| Labour default leaves a stale breach | probe: default frees the remainder, exception stands | `defaultCapacity` evaluates; `FOLD_INPUTS` pins it |
| Receipt reversal leaves a stale breach | probe: closed-short reversal frees ₹100, exception stands | every `receivedQty` writer evaluates |
| Amend writes a false clear/re-raise pair | probe: one exception becomes cleared + re-raised | deferral sink; one settle at the end |
| Read can contradict itself | no isolation level | `RepeatableRead`, pinned by the contract test |

## Tripwires advanced in this PR

`cross-module-graph.test.ts` (MODEL_OWNER +`budgetLine`/`budgetException`, commercial controller
routes), `readiness-lock-coverage.test.ts` (`SECTION_A_COMMANDS` 36 → 37), `commercialManifest`
(`ownsModels`/`readEncapsulated`/`routes`), `inventoryManifest` (the declared commercial
participant edge now carries a Task-2 call), the seed reset and the suite TRUNCATE lists.

## Not in this PR

Task 3 (`Measurement` and the labour consumption term), Tasks 4–6 (bills, certification, payment,
the remaining §J exposure buckets), and any frontend surface. The §L activation-authority question
recorded on PR #268 remains open and unacted-on.
