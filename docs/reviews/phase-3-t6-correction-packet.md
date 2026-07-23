# Phase 3 Task 6 — canonical readiness correction review packet (F1–F4)

**One consolidated HELD PR.** Base: `main` @ `ec595d1` (the merged PR #202 head). Branch:
`claude/phase3-t6-correction`. Corrects the four correctness gaps the Task-6 review found in the
merged canonical readiness calculation; no rollback. Does NOT begin Task 7. Because Materials is
capability-gated, non-pilot projects are unaffected.

## Vision-alignment statement

The Material readiness gate must reflect PHYSICAL truth: an activity is ready only when its
material is actually, exclusively there. The merged Task 6 derived the gate but four ways of
over-counting or under-observing that truth survived — the same stock satisfying two requirements,
a substitution outliving the spec it was approved against, "any commitment" standing in for "enough
inbound", and two lifecycle transitions that removed inbound coverage without telling the
projection. This correction makes the derivation CONSERVED (one unit, one requirement),
SPEC-BOUND (a substitution follows the requirement's current specification), QUANTITATIVE (inbound
is summed against the real shortfall), and COMPLETE (every coverage-changing command is
readiness-locked and event-bearing, so live == projection == rebuild). One fact still has one
canonical owner; attributable `pmc` authority over substitutions is unchanged; the pilot gate keeps
all of this inert for non-pilot projects.

## Reproduce-first

`apps/api/test/integration/phase3-t6-correction.test.ts` — **10/10**. RED at merged `main`
`ec595d1` (8 defect probes failed for the exact defect: F1 double-count 200/400; F2 ready-not-blocked
after revision + two winners on concurrent approval; F3 at-risk-not-blocked for a 10-unit
commitment; F4 fulfil-before-receipt accepted + a stale projection after close-short/fulfil), 2
at-both regression guards passed. GREEN after the correction (10/10).

## Findings & corrections

**F1 (P1) — the same physical stock counted repeatedly.** `coverageFor` totalled the full
reserved/issued pool independently for each requirement, so two 100-unit requirements sharing 100
units both read ready. FIX: a CONSERVED per-activity allocator (`allocateStock`, a max-flow:
`source → pool(cap=supply) → requirement(if acceptable) → sink(cap=demand)`). Every reserved or
issued unit satisfies at most one requirement; exact fingerprints and overlapping substitution
edges are handled deterministically (Edmonds-Karp, sorted node/edge insertion). When simultaneous
full coverage is feasible the flow saturates every demand edge (all ready); otherwise at least one
requirement is short in every allocation, so the worst-wins activity verdict is correct regardless
of which one is flagged. Probes: two same-spec 100-unit requirements + 100 stock cannot start
(covered total is exactly 100); 200 covers both.

**F2 (P1) — substitutions not bound to the current specification.** `activeTargets` ignored
`fromFingerprint` and the loader applied every active target to the current revision, so an A→B
approval kept satisfying a requirement after it was revised A→C; duplicate active approvals were
also allowed. FIX: `activeTargets` carries `fromFingerprint`; the loader admits a substitute target
only while its `fromFingerprint` equals the CURRENT head fingerprint. Forward migration
`20270103000000_phase3_t6_correction` adds a PARTIAL UNIQUE index on
`(projectId, requirementId, fromFingerprint, toFingerprint) WHERE "revokedAt" IS NULL` (diagnostic-first:
aborts on any pre-existing duplicate active pair), so a second active row is unrepresentable;
`approve` translates the violation to a Conflict. Revoked rows are excluded → they survive as
history and re-approval after revocation is allowed. Probes: A→B stops applying after A→C; a
concurrent duplicate has exactly one winner and revoking it leaves zero active.

**F3 (P2) — any commitment treated as covering the whole shortfall.** `coveringCommitments`
returned only existence/date, so a 10-unit commitment made a 100-unit shortage `at-risk`. FIX: it
now returns, per pin, `{ promisedDate, outstanding = ordered − received }` (positive only);
`coverageFor` accumulates by promised date and classifies `at-risk` ONLY once cumulative inbound
reaches the ACTUAL shortfall — dated at the promise that first covers it — else `blocked`. Probes:
a 10-unit commitment → `blocked`; a full-shortfall commitment → `at-risk` at its promised date.

**F4 (P2) — coverage-changing transitions bypassing the projection.** `deliveries.fulfill` took no
readiness lock, could fulfil a commitment with zero receipts, and emitted no event; `pos.closeShort`
locked but emitted no event. Both remove inbound coverage. FIX: `fulfillDelivery` now takes
`lockProjectReadiness`, refuses a commitment whose PO line has `receivedQty == 0`, and emits
`delivery.fulfilled`; `closeShort` emits `po.closed_short`. Both event types join the shared
`DOMAIN_EVENT_TYPES`, the external-effect catalog, the procurement manifest `producesEvents`, and
the readiness projection's `READINESS_EVENTS`, so the projection re-derives after either transition
(live == projection == rebuild, and a rebuild still emits zero events). The §A command-level
lock-coverage tripwire (`readiness-lock-coverage.test.ts`) enumerates both (20 → 22). Probes:
fulfil-before-receipt refused; after close-short and after fulfil, `stored == live` (and a rebuild
emits nothing); both transitions serialize against `activities.start` in both orderings.

## Gates (actual exit codes)

- `pnpm check` — **EXIT 0** (API unit **631/631** / 55 files — +2 §A command tripwire cases; web unit
  **396/396** / 37 files). Three mechanical unit pins updated for the two new dispatching commands
  (`purchase-orders.service.ts` dispatch 6→8; total dispatch sites 58→60; procurement manifest event
  list).
- Full live-PG integration battery — **EXIT 0, 495/495 across 55 files** (adds the 10-probe
  correction suite; the existing t6 readiness/races/projection suites and phase3-purchase-orders
  updated for the corrected semantics + the new fulfil-receipt precondition).
- `scripts/upgrade-proof.sh` — **UPGRADE PROOF PASSED** (migration `20270103…` applies over the
  legacy fixture; all F1–F4 database forgery rejections from the prior tasks survive).
- Race probes — `phase3-t6-start-races` + the F4 fulfil-vs-start serialized race, **10×/10 green**.
- `test:e2e:api:allmodules` — **27/27**; `test:e2e:api:allmodules:outbox` — **27/27**.

## Scope / non-goals

Corrects Task 6 only (findings F1–F4). No rollback; no Task-7 work; no change to the pilot gate. One
additive migration (`20270103000000_phase3_t6_correction`). Files: `inventory/inventory.service.ts`
(allocator + coverageFor), `procurement/procurement.participant.ts` (coveringCommitments),
`procurement/purchase-orders.service.ts` (fulfil/closeShort), `activities/{substitutions.service,
coverage-requirements, material-readiness.projection}.ts`, `platform/external-effects.ts`,
`procurement/procurement.manifest.ts`, shared `platform/events.ts`, the tripwire + pin tests, and the
reproduce-first correction suite.

## Review protocol

HELD draft PR from `main` @ `ec595d1`. **STOP for the narrow re-review.** Do not begin Task 7. Do
not enable or rely on Phase 3 material readiness for live projects until this correction clears.
