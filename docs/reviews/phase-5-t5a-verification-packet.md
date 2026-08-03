# Phase 5 Task 5A — §E three-way verification

## Why this is 5A and not Task 5

Task 5 as planned is verification + certification + §G bound 3 + the §H deduction ledger + the §I
SoD rule. Built as one unit it measured **15 files / 2,333 lines before its controller, tripwires or
a single probe** — over the plan's own 1,500-line review budget, and heading for roughly 3,500.

An external review flagged it, and PR #274 had just demonstrated the cost: an over-budget unit took
six finding-bearing heads and 23 corrections. So Task 5 is split into three increments, each ONE
architectural concern:

| | Concern | Contents |
|---|---|---|
| **5A** (this PR) | *Does this claim match the evidence?* | the §E triple, the exception kinds, the `verified` arrow |
| 5B | *Authorise money against verified evidence.* | certification, frozen consumption sets, §G bound 3, §I SoD, both certificate-refusal arms |
| 5C | *Withhold from authorised money.* | the §H deduction ledger, releases, the `NET_PAYABLE` floor |

**The plan's post-Task-5 STOP applies after 5C**, when payment authority is fully in place. It is
not weakened by the split — it is moved to the end of the same scope.

## What ships

§E carried into the plan **VERBATIM** from `claude/phase5-planning` `a4d469b`, per the plan's own
rule that a task PR reaching its section carries the text forward rather than re-deriving it.
Byte-equality asserted programmatically.

- `CommercialVerificationService.computeTriple` — per claim line: ORDERED (the frozen PO-line
  snapshot), ACCEPTED or MEASURED (the §0 set by name), BILLED (the live fold). Every side is a §0
  set referenced by name; not one filter is restated, because §E says restating them "is exactly the
  drift that produced two rounds of findings".
- The **pro-rata tax and freight cap**: the frozen line-level amount scaled by
  `min(BILLED_QTY, qty) / qty`, §A rounding applied once. A 50-unit bill against a 100-unit PO
  carrying ₹1,800 tax legitimately claims ₹900 — comparing against the whole figure disputes an
  honest partial bill, comparing neither lets two 50-unit bills each claim the whole ₹1,800.
- Six exception kinds, including `freight-mismatch` (freight is COMPARED, not merely carried) and
  the service-side half of `duplicate-claim` — the same units under a DIFFERENT vendor document
  number, which the live-document index permits and the quantity bound catches only once the second
  claim exceeds what arrived.
- **ONE new arrow**: `under-verification → verified`. `certified` stays closed until 5B ships the
  certificate that is its evidence. No new table, no new column — the migration replaces one
  trigger function body.
- Both ordered-side locks now return the FROZEN commercial terms from the same locked read. A second
  read is a second snapshot, and §E's whole point is that every side of the triple is taken under
  one lock.

## Invariant matrix

| Invariant | Risk in this change | Verification |
| --- | --- | --- |
| authorization-tenancy | A new verdict surface that moves a claim's status | `commercial.verify` is pmc-only and pre-existing; the §D/§I probe proves engineer and contractor are refused and that a never-activated project has no surface at all |
| civil-time-lifecycle | Opening a §F arrow | Exactly one arrow opens; PROBE A proves `verified → certified` is still refused at PostgreSQL |
| concurrency-idempotency | The triple reads four modules' evidence | Every PO line the bill touches is locked in ONE ascending order over the whole bill before any per-line work — the Phase-4 Task-3 crew-allocation guardrail applied to money. A per-line lock is that guardrail's missed site |
| data-integrity-conservation | A verdict that disagrees with the folds it is derived from | Every side is a §0 set by name; the verdict is recomputed on every call and stored nowhere |
| offline-reconciliation | None — no client surface | §M frontend is Task 7 |
| ui-server-parity | None — no UI | — |

## Two things recorded rather than smoothed over

**The quantity arms of §E's verdict are unreachable through any service path in this tree, and
PROBE B says so.** I wrote a probe expecting to observe `qty-over-accepted` at verification and it
kept reading `matched`. The reason is that the invariant already holds: Task 4's bounds dispute an
over-accepted claim at SUBMISSION, and its withdrawal guard disputes a live claim the moment
evidence moves under it — and a disputed claim leaves every billed fold, so by the time verification
could see an excess there is nothing left in the fold to exceed anything. PROBE B therefore asserts
the invariant that makes the arms a backstop, rather than asserting an exception that only appears
once the invariant is already broken. The arms stay in the implementation: §E requires the verdict
to be complete, and a backstop deleted because it looks unreachable is how the unreachable becomes
reachable.

**The `min` clamp's overage arm is not exercised, and PROBE G says that too.** The clamp only
differs from a raw ratio once billing exceeds the ordered quantity, which needs `approvedOverage` —
frozen at PostgreSQL and set only at issuance or amendment through Phase-3 machinery. PROBE G proves
what it can reach (the cap is the frozen amount, never scaled above it) and states the gap instead
of leaving a probe that passes while proving nothing.

Both are the same discipline this phase keeps re-learning: run the RED proof rather than assuming
it, and when a probe cannot reach its case, say so in the probe.

## Defects found and fixed while building this

- A **mutable instance field on a Nest singleton** holding per-request SoD state. Two concurrent
  certifications would have read each other's override, and one needing no exception could acquire
  one. The value now travels with the call. (The SoD code itself lands in 5B; the fix travels with
  it.)
- A **duplicate `assertWorkEvidenceRevisable`** — Task 3 already shipped one, so the second would
  have been the same rule at two sites, which is the drift §0b exists to prevent. The real guard is
  extended in 5B instead.
- A **self-referencing certificate lineage column** (`supersededByCertificateId` set to the
  certificate's own id), flagged by external review as missing an FK. The deeper problem was a
  column whose only writer could never be correct, so it is removed rather than FK'd: lineage is the
  ordered certificate chain on the bill. If an explicit link is wanted it belongs in 5B, where a
  same-transaction replacement path would give it a real writer.

## Gates

- `pnpm check` **EXIT 0** — web 42 files/543 tests, API 56 files/720 tests, builds clean
- Focused `phase5-t5a-verification.test.ts` **11/11** on live PostgreSQL
- Migration applies from a **from-scratch** `migrate deploy`, not only as an incremental patch
- Tripwires advanced in the same PR: mutating routes 157 → 158, the commercial controller's ordered
  route signatures, the command/query site tables, the service triage and the manifest route list

## Files

14 changed, 1,276 lines — **within the 20-file / 1,500-line budget**. Roughly a sixth is the §E
carry-forward into the plan.
