# PR #345 — convergence audit

**Unit:** give the §G billed-bound check one lock order, so the commercial CI deadlock cannot form.
**Base:** `8175c3e` · **Heads:** `ad72536` → `8cab42f` → `c493c1e` → `bb90db0` (this one)
**Finding-bearing heads:** 2 (`ad72536`, `c493c1e`) · **Findings:** 6, all P2

## The one-line summary

**Every finding has been about the EVIDENCE. None has been about the FIX.**
`20270825000000` — a single `CREATE OR REPLACE` changing two lock clauses from `FOR UPDATE` to
`FOR NO KEY UPDATE` — is byte-for-byte identical across all four heads and has not been questioned
in either review round.

## The heads

| head | what it was | findings | outcome |
| --- | --- | --- | --- |
| `ad72536` | the fix + a three-probe suite | **3** (F1 sleeps, F2 no terminal invariant, F3 labour arm untested) | corrected on `8cab42f` |
| `8cab42f` | round 1 fold | — | superseded by `c493c1e` |
| `c493c1e` | PROBE 4's name/header made to match its own assertion (self-caught on re-read, before Codex saw it) | **3** (R2-1 vacuous PROBE 1, R2-2 wrong bound, R2-3 impossible barrier) | corrected on `bb90db0` |
| `bb90db0` | round 2 fold + this audit | — | current |

## Classification

| finding | class | in the fix, or in the proof? |
| --- | --- | --- |
| F1 — fixed 250 ms sleeps prove nothing about ordering | probe rigour | proof |
| F2 — PROBE 2 asserts a wait, not the bound | probe coverage | proof |
| F3 — the labour lock arm was never exercised | probe coverage | **proof, and it mattered** |
| R2-1 — PROBE 1 could pass without exercising the conflict | probe rigour | proof |
| R2-2 — PROBE 4 tripped the over-ACCEPTED branch, not the ordered bound | probe premise | proof |
| R2-3 — PROBE 4's concurrent interleaving cannot occur | probe premise | proof |

**6 of 6 concern the proof. 0 concern the change.** That is the whole shape of this review.

## The three defects that were real and would have shipped

1. **F3 — a half-tested change.** The migration rewrote the clause on `PurchaseOrderLine` *and* on
   `LabourPurchaseOrderLine`, but every probe passed `p_material` with labour `NULL`. The labour
   clause could have been left at `FOR UPDATE` — the same deadlock, intact — with a green suite.
   Now both arms run every probe, and at the base PROBE 1 fails on **both**.
2. **F1 + R2-1 — a probe that could pass against its own target.** First the holder's lock was
   assumed rather than awaited; then non-blocking was inferred from *"no wait was observed"*, which
   is satisfied just as well by a racing session that never reached PostgreSQL. Both are the same
   error in different clothes: **treating the absence of an observation as an observation.** The
   probe now demands the check COMPLETE while the `FOR KEY SHARE` holder still holds — a positive
   fact that cannot be produced by an experiment that did not run.
3. **R2-2 — a probe measuring the wrong thing.** With no acceptance seeded, ACCEPTED is 0, so both
   claims were disputed by the over-ACCEPTED branch and never touched the ordered bound the probe
   named. It would have passed while the ordered aggregation was broken.

## Two places I corrected my own account, not the code

- **Round 1 explained PROBE 4's behaviour wrongly.** I attributed both bills committing to §E
  disputing rather than refusing. True in general; **not what fired here** — the over-ACCEPTED
  branch did. R2-2 caught it. The wrong explanation is left in this ledger rather than quietly
  replaced, because a review record that only shows the corrected view teaches nothing.
- **`c493c1e` exists because round 1 shipped prose that contradicted its own assertion.** PROBE 4's
  name still said "cannot both commit" after its assertion had been changed to the opposite. Caught
  on re-read before Codex saw it — but it was pushed, and that is the point: the same defect class
  this PR is about, committed inside the PR that is about it.

## The convergence question: is this converging?

Yes, and by a different mechanism than PR #344's.

- Round 1: 3 findings on a 3-probe suite.
- Round 2: 3 findings — **2 of them on PROBE 4, the probe round 1 ADDED.**

The suite was growing faster than it was becoming true. Round 2's answer was therefore not a third
attempt at PROBE 4 but its **removal**, on two independent grounds — it tested the wrong bound, and
its concurrency premise is forbidden by `CommercialBillService.transition()` taking
`lockProjectReadiness` first. Coverage was **verified before deleting**: bound 1 is proven in its
owning suite, `phase5-t4-vendor-bill.test.ts` (PROBE 5h; and the bound-1 seal probe that forces past
every service guard and aborts at COMMIT, with the paired disposition).

## The rule this PR contributes

> After repeated finding-bearing rounds, **reduce surface rather than patch again.**

Stated more usefully: a probe earns its place by testing *what this change changes*. PROBE 4 tested
bound-1 enforcement, which this PR does not touch — the lock **mode** is what it touches. Restating
a rule that already has a canonical statement elsewhere does not add safety; it adds a second,
weaker statement that can drift out of agreement with the first. The file header now records
PROBE 4's absence as a decision with its reasons, so a later reader cannot mistake it for an
oversight and "restore" it.

## Standing evidence

| gate | result at `bb90db0` |
| --- | --- |
| `pnpm check` | EXIT 0 — web 786/786, API 793/793 |
| integration (fresh migrated DB) | 93 files / 1188 tests |
| `upgrade-proof.sh` | PASSED |
| `test:e2e:api` | 31 passed |
| `test:e2e:api:outbox` | 31 passed |
| `api-e2e` in CI on this head | **success — the first clean `api-e2e` on this branch** |

Reproduce-first, re-verified after every rewrite: with `20270420000000`'s original function restored,
**PROBE 1 is RED on both arms** and PROBES 2/3 pass. The preserved conflicts held before the change
as well as after, which is what makes PROBE 1's asymmetry evidence rather than coincidence.

## Nothing is deferred

Every finding from both rounds is answered in code on this head. No question is carried forward, and
no probe is owed. The one item this PR deliberately does **not** fix is named in the PR body and
tracked separately: the **retry poison**, where a failed attempt leaves a live purchase-order line
unmapped to a cost head so Playwright's retry dies in setup and masks the first failure's cause. It
is a distinct defect with its own unit, not an open question about this change.
