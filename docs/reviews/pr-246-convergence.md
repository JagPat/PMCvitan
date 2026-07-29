# PR #246 Review Convergence

## Objective
Converge the Phase 4 Task 6 (§J Labour frontend) review: map every finding-bearing head to its
architectural cause and batched remedy, close the last open finding, and show the remaining risk
is bounded. Full per-finding detail (probes, exact code paths, battery numbers) lives in
`docs/reviews/phase-4-t6-frontend-packet.md` §§5–18; this audit is the cross-round synthesis.

## Finding Map
| Head | Round — findings | Architectural cause → batched remedy and proof |
| --- | --- | --- |
| `d538c15` | R1 — 6 | Browser-derived eligibility/counts + demo dates → server-rule helpers (`labourSelection` mirrors §A/§B coverage), project-timezone civil dates, pmc-only muster, `capabilitiesKnown` deep-link gate; 12 probes RED→GREEN |
| `17fc0f0` | R2 — 7 | Stale/over-broad client offers → committed-only + active-window + booked-worker + full-slice filters, socket + timezone-delivery labour refresh; 11 probes RED→GREEN |
| `0172dc2` | R3 — 6 | Replay after head drift trusted execution-time state → `originRevision` PIN (server 409) + sourced-count stop + residual-only raises + civil-day stamps + future-work block; pin suite born RED→GREEN |
| `c1f4c40` | R4 — 4 | Client arithmetic/identity gaps → rejected-requisition residuals, late-promise refusal, full numeric parse, revision-keyed coalesce identity |
| `8ef0c52` | R5 — 3 | Pending ops invisible to guards → slice-wide in-flight counting; held roster keys (one per form until confirmed); worked-release bookings |
| `8a4b3ef` | R6 — 5 | Reservation guards ignored revision + pending draws → revision-scoped fullness, mustered exclusion, pending-draw commitment reservation, held bind keys, cumulative-minutes cap |
| `b2beb4c` | R7 — 3 | Work entry raced its allocation lifecycle → released-allocation refusal (server 409), per-(date,shift) pending bookings, allocation-wide work-pending disable |
| `0a35642` | R8 — 4 | Key lifecycle conflated identity with truth → signature-keyed roster maps, keys retained until the fresh bundle APPLIES, stale-revision bookings ignored, verify-the-basis (server 409 on revoked/unknown substitution authority) |
| `b6956d6` | R9 — 1 | Stale-revision draw over-reserved → pending draws filtered to the current head (same rule as fullness/bookings) |
| `a46e350` | R10 — 5 | Revocation/lifecycle gaps → substitution revocation RELEASES the rows it alone authorized (server), dead-demand work disable, onboard keys spent on rendered truth, bind keys survive reconcile failure, per-device bind reservation |
| `a343fc9` | R11 — 7 | Success→reload gap + unverified identity → retained-key parsers keep reservations until truth renders, live-demand work recheck (server 409), worker-identity seal (server 400), moved-activity staleness, muster civil-date de-dupe, in-hub release corrective |
| `19106d7` | R12 — 3 | Substitution vs supplier identity + swallowed failures → head-native drawdown seal (server 400), retryable live-demand recheck (HttpException-only catch), surfaced shell failure (unavailable+Retry via `loadShell` fallback) |
| `6853ac5` | R13 — 1 | Retained keys lost command metadata → `labourPendingInputs` retains the FULL allocate input per retained key (commitment draw stays reserved through the gap); parser fallback pinned |
| `635899d` | R14 — 1 | Held bind keys never distinguished refusal from loss → a TERMINAL bind rejection (404/409, via `isTerminalOutboxError`) clears the device reservation; transient + post-commit reconcile failures still retain the key; probe RED→GREEN |

## Architectural Convergence
The 46 findings across 14 heads reduce to five systemic causes, each now closed by an invariant
rather than a point patch:
1. **Server authority, client guidance** — every §A/§B/§F rule the hub renders is re-verified at
   the authority: head pinning (R3), eligibility basis (R8), worker identity (R11), head-native
   drawdown (R12), live-demand work recheck (R11/R12). A hostile or stale client can annoy the
   server; it cannot corrupt coverage, drawdown, or effort facts.
2. **One reservation invariant for the offline outbox** — an allocate/work command holds its FULL
   reservation (worker booking, slice fullness, commitment draw) from dispatch until the module
   truth is ON SCREEN, scoped to the current head revision (R5–R9, R11, R13). The `labourPending`
   keys + `labourPendingInputs` register are the single mechanism; hydration rebuilds both from
   the durable queue.
3. **One held-key lifecycle for direct roster commands** — one idempotency key per form
   signature, spent only on rendered truth, retained through reconcile failure, cleared on
   terminal refusal (R5, R6, R8, R10, R14). Replay is exactly-once; a refused command frees its
   reservation for correction.
4. **Project civil time everywhere** — musters, onboarding stamps, work-entry day checks and the
   presence read all use the project timezone (R1, R3, R11), matching the server clock.
5. **Honest load states** — capability/shell failures surface as unavailable+Retry instead of
   dead loading screens (R1, R12); stale results never overwrite newer ones.

## Remaining Risk
No open finding. The residual corner — a retained reservation whose input record is lost by a
reload INSIDE the success→reload gap — degrades to the round-11 conservative parser (worker still
booked; commitment conservatively re-offerable) and is pinned by a dedicated probe. Server seals
make every such client-side degradation at worst a deterministic 409, never silent corruption.

## Verification
- R14 probe RED at `635899d` (1 failed | 70 passed) → GREEN 71/71; full web labour suites 105/105.
- `origin/main` (`d7758db`, PR #247 orchestration change) merged in cleanly — no product overlap.
- Full battery on the correction head: `pnpm check` EXIT 0 (web 542/542, API unit 680/680);
  integration 72 files / 702 tests on a pristine migrated DB; `upgrade-proof.sh` PASSED; e2e
  `allmodules` 35/35 and `:outbox` 35/35 (one first-run failure on the documented
  `daily-log-lost-response` visibility flake — no labour surface — clean on the single deciding
  re-run).
