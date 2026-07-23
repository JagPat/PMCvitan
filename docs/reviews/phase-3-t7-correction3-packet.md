# Phase 3 — Task 7 correction 3 packet (reservation-plan lifecycle: operation identity, candidate aggregation, plan generations, uncertain-failure truth)

**Base:** `main` @ `a1d78807` (the merged PR #207). **Branch:** `claude/phase3-t7-correction3`.
**Directive being served:** the BLOCKED-NARROWLY re-review of PR #207 (reviewed base `248212b4`, head `7abfb565`, merge `a1d78807`) — *PR #207 is genuine progress, do NOT roll back; four focused defects remain in the reservation-plan lifecycle.* This is ONE focused correction from `main`; it does not roll back PR #207, change Tasks 1–6, add a migration, or begin Phase 4. **No domain schema, no migration** (a corrected server read projection + a corrected client outbox lifecycle over already-cleared facts). This is one correction round, not another architectural redesign.

## Vision-alignment statement

The pilot's promise (§25) is *one site running without a separate material spreadsheet, on facts the later phases inherit.* PR #207 correctly moved coverage compatibility to the server and made each browser action ONE durable command — but its reliability plumbing conflated an operation's ATTEMPT identity (what a retry must reuse so a lost response replays exactly once) with a RESOURCE identity (a deterministic key derived from the target). That single conflation produced four physical-truth defects: a legitimate second reserve of the same lot could not execute, two candidates from one lot could collide, a slow stale reservation plan could overwrite a newer one, and an uncertain network failure left the material view un-refreshed. This correction separates the two identities — a fresh per-action idempotency key that a retry reuses unchanged, and a deterministic coalesce key that only dedupes an equivalent action WHILE pending — aggregates candidates to match the activity-level physical reserve, gives each activity's reservation plan a newest-wins generation, and refreshes material truth after every attempt (success, drop, OR uncertain failure). One fact keeps one owner; a duplicate click still runs once; a legitimate repeat still runs; and a partial or uncertain fix is never reported as covered.

## The four findings → resolution

### Finding 1 (directive #1) — separate operation identity from pending-action coalescing

- **Defect.** PR #207 keyed every materials command by a permanent, target-derived key and used that ONE key both as the durable idempotency key AND as the coalesce/disable identity. A permanent key identifies a RESOURCE, not a command ATTEMPT: after a reserve resolved, a legitimate second reserve of the same `(activityId, lotId, storeLocation)` re-used the same idempotency key and the ledger deduped it to nothing; and because the planner offered per-requirement candidates, two candidates from one lot shared one key and collided.
- **Fix.** The two identities are split (`apps/web/src/lib/materialsKeys.ts`, `apiGateway.ts` `OutboxOp`, `store.ts`):
  - the **idempotency key** is a FRESH `newIdempotencyKey()` minted ONCE per deliberate user action, persisted on the outbox op, reused unchanged on every retry/reload (so a lost response replays exactly once), and DIFFERENT for the next legitimate action after this one resolves;
  - the **coalesce key** (`reserveCoalesceKey` / `issueCoalesceKey` / `consumeCoalesceKey` / `requisitionCoalesceKey`) is a deterministic identity used ONLY to dedupe an equivalent action WHILE it is still pending (double-click, or a reload that finds the op still queued). Once the action resolves it leaves `materialsPending`, so a later identical legitimate action dispatches afresh.
  - `dispatchMaterials` coalesces on `coalesceKey`; `materialsPending` holds coalesce keys; `hydrateOutbox` reconstructs the pending coalesce keys from the persisted ops (their own idempotency keys are untouched).

### Finding 2 (directive #2, with #5) — unambiguous, executable candidate identity

- **Defect.** `stock.reserve` is ACTIVITY-level (`input: (lotId, storeLocation, activityId, qty)`), never requirement-attributed. The planner returned one candidate PER requirement, so two requirements drawing from the same lot produced two candidates with the same `(lot, store, activity)` — a single coalesce identity two commands could not both use.
- **Fix.** `InventoryService.reservationCandidatesFor` now AGGREGATES the greedy allocation onto the pool and emits ONE candidate per `(lotId, storeLocation)` that received an allocation, with the summed quantity — the exact shape of the single activity-level reserve command. The `ReservationCandidate` contract drops `requirementId`/`revision`; `activities.query.ts` maps candidates straight through and labels only the residuals from the requirement spec. Conservation is unchanged — the shared free pool is still decremented as it is allocated, so the summed offer never exceeds physical free.

### Finding 3 (directive #3) — per-activity reservation-plan generations (newest-wins)

- **Defect.** `loadReservationPlan` had no request ownership. The post-command reconcile reloads every open plan; a slow earlier request that resolved after a newer one could overwrite the fresh plan with stale candidates.
- **Fix.** A per-activity monotonic generation (`reservationPlanSeq`): each `loadReservationPlan(activityId)` claims the next generation; the response may write `reservationPlans[activityId]` ONLY if it is still the newest for that activity AND the project scope is unchanged. A slow older request is dropped.

### Finding 4 (directive #4) — uncertain-failure retains the op AND refreshes truth, with no success toast

- **Defect.** The flush's materials reconcile ran only when a materials key was RESOLVED (succeeded or terminally dropped). A transient/uncertain failure kept the op but performed ZERO material reconciliation — so if the server had actually committed despite the lost response, the view stayed stale.
- **Fix.** `flushOutbox` tracks `materialsAttempted` — true whenever ANY materials op was attempted (succeeded, dropped, OR transient-failed). The reconcile hook now fires on `materialsAttempted`: it clears only RESOLVED coalesce keys from `materialsPending` (a still-pending transient-failed op keeps its coalesce key, so its button stays disabled while it retries), and — scope-guarded — reloads the materials bundle + every open reservation plan. No success toast on a transient failure: `consumeSnapshotResult` announces the ok message only on an APPLIED snapshot, and a transient failure applies none.

## Required acceptance (from the directive) → evidence

| Acceptance criterion | Evidence |
|---|---|
| Two 80-unit reqs sharing one 100-unit lot execute the full 100 without coalescing/409 | `phase3-t7-reservation-plan.test.ts` **PROBE 2 (directive #2)** — ONE candidate `{storeLocation:'main', qty:'100'}`, residual `60`; the aggregated activity-level reserve executes the whole 100 as a single command. |
| Two identical legitimate actions separated by a confirmed completion use different ledger keys | `materials.test.ts` **DIRECTIVE #1 / acceptance** — reserve → flush (outbox empty, pending cleared) → reserve again → `key2 !== key1`. |
| Double-click while pending → one operation | `materials.test.ts` **PROBE 5a** — a double-click dispatches exactly ONE `reserveStock`. |
| Lost-response retries retain the original operation key | `materials.test.ts` **PROBE 5b** — a transient failure replays the SAME idempotency key on the next flush. |
| Newer reservation plans cannot be overwritten by older responses | `materials.test.ts` **DIRECTIVE #3** — a slow OLD plan resolving after a fast NEW plan does not overwrite it (qty stays `20`). |
| Uncertain failure retains the operation and refreshes truth (no success toast) | `materials.test.ts` **DIRECTIVE #4** — a transient `TypeError` keeps `outbox` + `materialsPending` at length 1, calls `materialReadiness` (truth refreshed), and shows no `/reserved/i` toast. |
| A substitute candidate displays the substitute lot identity | `phase3-t7-reservation-plan.test.ts` **PROBE 4a (directive #5)** — an active A→B substitute is offered, labelled `cement · acc · opc 53` (the ACC substitute lot), NOT the UltraTech requirement spec. |
| Full existing battery green | See the gate battery below. |

## Reproduce-first probes → evidence (all RED at `a1d78807` → GREEN)

| # | Probe | Where |
|---|---|---|
| 1 | 100 shortage + 10 free → one candidate `qty 10` (no `requirementId`), residual `90` | `phase3-t7-reservation-plan.test.ts` PROBE 1 |
| 2 | Two 80 reqs + one 100 lot → ONE `qty 100` candidate, residual `60` (finding 1/2 acceptance) | `phase3-t7-reservation-plan.test.ts` PROBE 2 (directive #2) |
| 3 | Stock only in a non-default store → candidate AT that location | `phase3-t7-reservation-plan.test.ts` PROBE 3 |
| 4 | Active substitute offered with the SUBSTITUTE lot identity; wrong base UOM not eligible | `phase3-t7-reservation-plan.test.ts` PROBE 4a (directive #5) + PROBE 4b |
| 5 | Two legitimate reserves separated by a confirmed completion → DIFFERENT idempotency keys | `materials.test.ts` DIRECTIVE #1 / acceptance |
| 6 | A newer reservation plan is not overwritten by an older slow response | `materials.test.ts` DIRECTIVE #3 |
| 7 | A transient failure retains the op + refreshes truth, no success toast | `materials.test.ts` DIRECTIVE #4 |
| 8 | Double-click coalesces to one command; lost response replays the SAME key | `materials.test.ts` PROBE 5a / 5b (unchanged, still green under the split) |

## Gate battery (base `a1d78807`)

- `pnpm check` — **EXIT 0** (web lint + typecheck + **425/425** web unit across 39 files + build; API build; shared build). Web unit is +3 over correction 2's 422 (the three new finding tests).
- API unit — **631/631** across 55 files (in `pnpm check`).
- Integration (live PG, serial, fresh migrated DB) — **510/510** across 57 files (`phase3-t7-reservation-plan.test.ts` 6/6). NOTE: a full run over a DB polluted by a prior isolated backend run showed 4 leftover-data collisions in unrelated files (`decisions-projection`, `outbox` — `Unique constraint failed on (id)` / a pre-existing seal); those two files pass 30/30 in isolation, and a clean full run over a freshly-migrated DB (exactly as CI provisions) is 510/510.
- Backend probes — `phase3-t7-reservation-plan` **6/6**.
- Web probes — `materials.test.ts` + `reservations.test.ts` **29/29** together.
- `upgrade-proof.sh` — **PASSED** (no migration in this correction; the legacy fixture still applies all migrations, the additive read/lifecycle changes write no rows, and every F1–F4 forgery rejection survives).
- `test:e2e:api:allmodules` (legacy) — **31/31**; `test:e2e:api:outbox` — **25/25**. materials-pilot **4/4 in BOTH sender modes** (browser-driven reserve candidate → issue → consume with a visible BLOCKED → READY transition; shortage → ONE requisition; §E read; INERT 404/no-nav). One earlier `allmodules` run flaked on the documented timing-sensitive inspection steps (`inspections-module-query` project-switcher 60s timeout + the ordered `pillar-chain` reject/reinspection/negatives cascade — none touched by this materials/reservations change); a clean re-run is 31/31.

No domain schema, no migration. `ReservationCandidate` is a narrowed additive shared contract; `reservationCandidatesFor`/`reservationPlan` remain read-only; the frontend change is the store outbox lifecycle + the keys module + the screen call sites.

## What this correction does NOT touch

- No rollback of PR #207 (the single-command server-candidate architecture stands; this corrects its lifecycle).
- No change to Tasks 1–6 (the canonical readiness calculation, the §C ledger, procurement/PO/inventory invariants are untouched).
- No migration (read projection + client lifecycle only).
- Phase 4 does not begin. This is the narrow Phase-3 re-review stop.
