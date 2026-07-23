# Phase 3 Task 6 — canonical readiness correction round 2 review packet (composition defects)

**One consolidated HELD PR.** Base: `main` @ `c910320` (the merged PR #203 head). Branch:
`claude/phase3-t6-correction2`. Corrects the two compositional defects the narrow re-review of the
merged correction (PR #203) found; no rollback. Does NOT begin Task 7. Because Materials is
capability-gated, non-pilot projects are unaffected.

## Vision-alignment statement

The Material readiness gate must reflect PHYSICAL truth, and it must COMPOSE that truth correctly.
PR #203 made each individual truth right — one unit per requirement, spec-bound substitutions,
quantitative inbound, event-borne lifecycle — but two ways of composing them survived. First,
"fulfilled" was decided on `receivedQty > 0` rather than the ordered quantity, so a single unit
could terminalize a hundred-unit commitment and silently erase the outstanding balance from inbound
coverage. Second, physical stock and inbound commitments were decided in SEPARATE stages — physical
allocated first, inbound inspected after — so which requirement a shared pool happened to serve
(an arbitrary requirement-id order) could flip the activity between `blocked` and `at-risk`. This
correction makes fulfilment HONEST (no outstanding committed quantity) and the readiness derivation
CONSERVED-AND-COMBINED (one max-flow network over physical pools + dedicated inbound, whose flow
value — and therefore the verdict — is invariant to requirement id / creation order). One fact still
has one canonical owner; attributable `pmc` authority is unchanged; the pilot gate keeps all of this
inert for non-pilot projects.

## Reproduce-first (probes RED at `c910320`)

Two probes were added to `apps/api/test/integration/phase3-t6-correction.test.ts` FIRST and shown
RED at merged `main` `c910320` (10 prior probes passed, the 2 new ones failed — `Tests 2 failed | 10
passed`):

- **F6 (finding 1)** — a 100-bag commitment fulfilled after receiving only 1 unit: `fulfillDelivery`
  resolved (`status: 'fulfilled'`) where a refusal (409) was expected. RED.
- **F5 (finding 2)** — two same-spec 100-bag requirements on one activity + 100 shared reserved bags
  + a 100-bag commitment on ONE requirement: the aggregate read `fail` (blocked) when the committed
  requirement held the smaller requirement-id, and the per-requirement verdicts were mixed
  (ready + blocked) — not the order-invariant `wait` (at-risk) the feasible plan admits. RED.

GREEN after the correction (**12/12**).

## Findings & corrections

**Finding 1 (P1) — a partial receipt can falsely fulfil the entire commitment.** `fulfillDelivery`
gated on `receivedQty > 0`, so a one-per-line 100-unit commitment could be marked `fulfilled` after
1 unit — terminalizing it and dropping the outstanding 99 from inbound coverage. FIX
(`purchase-orders.service.ts`): fulfilment now requires NO outstanding committed quantity —
`receivedQty >= qty` (the PO line's ordered quantity); otherwise it refuses with the outstanding
balance in the message. A partial delivery stays `committed`/`revised`, or the PO is closed short
with a reason. Probes: 1/100 refused, 99/100 refused, 100/100 fulfils; `phase3-purchase-orders`
updated to fully receive before fulfilling.

**Finding 2 (P2) — physical stock and inbound commitments allocated in separate stages.** `coverageFor`
ran a physical-only max-flow FIRST (`allocateStock`), then inspected per-requirement inbound —
so a shared physical pool served whichever requirement the deterministic flow reached first (an
arbitrary requirement-id order), and the activity could read `blocked` or `at-risk` depending on
which requirement happened to also hold a commitment. FIX (`inventory.service.ts`): ONE conserved
COMBINED-FLOW decision per activity over a single network — physical supply pools connect to EVERY
compatible requirement (fungible; reverse residual edges let physical move AWAY from a
commitment-covered requirement), inbound quantities are dedicated `source → requirement` edges pinned
to their requirement revision. Two max-flows decide the verdict from ORDER-INVARIANT flow values:
physical-only saturates every demand → `ready`; physical + all inbound saturates it → `at-risk`;
otherwise → `blocked`. The verdict is uniform across the activity's requirements (worst-wins
reproduces it), so BOTH the aggregate and the per-requirement verdict are invariant under
requirement-id and creation-order permutations. Chronological commitment accumulation is preserved:
inbound is added in promised-date order and the network re-solved, so the at-risk covering date is
the EARLIEST date at which the combined network first satisfies demand. `coveredQty` reports
physical-only coverage (never inbound). Probe F5 reproduces `at-risk` under BOTH orderings (committed
requirement = smaller AND larger requirement-id); the conserved 100 bags are still counted at most
once.

## Gates (actual exit codes)

- `pnpm check` — **EXIT 0** (API unit **631/631** / 55 files; web unit **396/396** — no unit pins
  changed: `fulfillDelivery` still takes the readiness lock and emits `delivery.fulfilled`, so the §A
  command tripwire (22), dispatch-site and manifest pins are unchanged).
- Full live-PG integration battery — **497/497 across 55 files** (+2 for the F5/F6 composition probes;
  the F4 fulfil-projection probe rewritten to a legal 100/100 fulfil + projection-consistency case).
- `scripts/upgrade-proof.sh` — **UPGRADE PROOF PASSED** (no migration added this round; all prior
  F1–F4 database forgery rejections survive over the legacy fixture).
- Race probes — `phase3-t6-start-races` + `phase3-t6-correction` (incl. the F4 fulfil-vs-start
  serialized race, both orderings), **10×/10 green** (17 tests per run).
- `test:e2e:api:allmodules` — **27/27**; `test:e2e:api:allmodules:outbox` — **27/27**.

## Scope / non-goals

Corrects the two composition defects only. No rollback; no Task-7 work; no change to the pilot gate;
NO migration (pure service logic + tests). Files: `inventory/inventory.service.ts` (combined-flow
`maxFlowCoverage` + `coverageFor`), `procurement/purchase-orders.service.ts` (`fulfillDelivery`
guard), and the reproduce-first probes + two updated existing tests
(`phase3-t6-correction.test.ts`, `phase3-purchase-orders.test.ts`).

## Review protocol

HELD draft PR from `main` @ `c910320`. **STOP for the mechanical re-review.** Do not begin Task 7. Do
not enable or rely on Phase 3 material readiness for live projects until this correction clears.

## Review outcome — CLEARED

Merged as **PR #204** (head `d45de9d`, merge `main` `5b7b8c4`). The independent re-review returned
**GREEN SIGNAL — PHASE 3 TASK 6 CLEARED** at `5b7b8c4`, with no P0/P1/P2 findings: partial receipts
at `1/100` and `99/100` cannot fulfil a commitment while `100/100` succeeds; the combined max-flow
conserves physical stock, keeps inbound requirement-bound, reroutes shared stock correctly and
produces an order-independent activity verdict; the earliest covering delivery date remains
chronological. Independently verified on live PostgreSQL (correction suite 12/12; adjacent readiness/
race/projection/PO suites 28/28; readiness-lock tripwire 26/26), `pnpm check` (web 396/396, API
631/631, production builds successful), and all 10 GitHub checks passed. Task 6 is not reopened
absent a direct Task-7 regression. Task 7 authorized.
