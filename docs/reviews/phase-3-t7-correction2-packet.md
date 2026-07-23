# Phase 3 — Task 7 correction 2 packet (single-command materials pilot; no browser-side orchestration)

**Base:** `main` @ `248212b4` (the merged PR #206). **Branch:** `claude/phase3-t7-correction2`.
**Directive being served:** *Finish the Phase 3 operational Materials pilot without browser-side multi-command orchestration.* Replace `coverMaterialShortage`'s `Promise.all` fan-out with EXPLICIT, single-command user actions; the SERVER supplies the canonical reservation candidates. This is ONE focused correction from `main`; it does not roll back PR #206, redesign Tasks 1–6, or begin Phase 4. **No domain schema, no migration** (a server read + a single-command frontend over already-cleared facts).

## Vision-alignment statement

The pilot's promise (§25) is *one site running without a separate material spreadsheet, on facts the later phases inherit* — and a correction (PR #206) already made the hub operational. But covering a shortage still fanned out several commands from the browser with `Promise.all`, recreating coverage compatibility from fingerprints client-side and reporting "covered" even when only part of the shortage was addressed. This correction moves the physical truth back to the server: the **server** resolves reservation candidates from current requirements, active substitutions, base-UOM compatibility, lot location and free quantity, and the **browser** dispatches ONE deliberate command per action — reserve an exact `(lot, storeLocation, qty)` candidate, or raise ONE requisition for the residual. Each command is write-ahead to the durable outbox with a stable idempotency key, coalesced while pending, retried under the same key on a lost response, and scope-guarded, so a duplicate click, an uncertain network, or a mid-command project switch never double-applies, strands, or leaks. One fact keeps one owner; the browser never invents coverage.

## Architecture change

- **Server-resolved candidates (new read).** `GET …/projects/:projectId/activities/:activityId/reservation-plan` → `ReservationPlan { activityId, candidates[], residuals[] }`. `ActivitiesQueryService.reservationPlan` (capability-gated, 404 off-pilot) resolves the activity's current requirements + ACTIVE substitutions via `loadCoverageRequirements`, then `InventoryService.reservationCandidatesFor` reuses `coverageFor` for each requirement's shortfall and **conservatively** offers free on-hand stock — matched by acceptable fingerprint AND base UOM, per `(lotId, storeLocation)` — decrementing the shared free pool as it offers, so the SUM of offered reservations across the activity's requirements can never exceed the physical free stock. The uncovered remainder is returned as per-requirement `residuals`.
- **Single-command frontend (no fan-out).** `coverMaterialShortage`'s `Promise.all` and `reserveMaterial` are removed. The store now exposes `loadReservationPlan`, `reserveCandidate(activityId, lotId, storeLocation, qty)`, `raiseRequisition(activityId, title, lines)`, and a storeLocation-carrying `issueMaterial(lotId, storeLocation, activityId, qty)` / `consumeMaterial(issueId, qty)`. Each routes through a `dispatchMaterials` helper → the existing durable **write-ahead outbox** (`runWriteAhead` → `flushOutbox` → `replayOutboxOp`).
- **Reliability plumbing.**
  - *Stable keys* (`lib/materialsKeys.ts`, shared by store + screen + tests): a reservation is keyed by `(lotId, storeLocation, activityId)` per the directive; issue/consume/requisition keys include the quantity / residual content, so an identical repeat coalesces while a genuinely different amount is a distinct command.
  - *storeLocation through reserve AND issue*: `ReserveStockInput`/`IssueStockInput` require `storeLocation`; `foldActivityReservations` now keys by `(activityId, storeLocation)` and carries the location so an issue draws from the exact store the reservation sits in.
  - *Persist-before-send*: every command is written to the durable outbox with its key before the first request (online or offline).
  - *Coalesce / disable-while-pending*: `dispatchMaterials` skips a duplicate whose key is already queued or in `materialsPending`; the screen disables a button whose key is pending.
  - *Lost-response same-key retry*: a transient failure keeps the persisted op; the next flush replays under the SAME key (the ledger applies it once).
  - *Scope-safe*: the flush's existing scope guard skips its materials reconcile when the project moved; `reservationPlans` + `materialsPending` are project-owned (`emptyProjectData`) so they tear down on a switch.
  - *Reconcile after success AND uncertain failure*: a new **materials reconcile hook** in `flushOutbox` clears every resolved (succeeded OR terminally-dropped) materials key from `materialsPending` and reloads the materials bundle + open reservation plans — so a terminal rejection leaves no hidden committed state and refreshes the truth.
  - *Never "covered" for a partial fix*: the browser no longer computes coverage; it offers exactly what the server says is reservable and requisitions the exact residual.

## Required reproduce-first probes → evidence

| # | Probe (directive) | Evidence |
|---|---|---|
| 1 | 100 shortage + 10 free → reserve 10 and requisition the residual 90 | `phase3-t7-reservation-plan.test.ts` **PROBE 1** (candidate qty `10`, residual qty `90`). |
| 2 | Two 80 shortages sharing 100 stock → never reserve more than 100 | `phase3-t7-reservation-plan.test.ts` **PROBE 2** (Σ candidates `100`, residual `60`; conserved pool). |
| 3 | Stock only in "yard-store" → reserve and issue from "yard-store" | `phase3-t7-reservation-plan.test.ts` **PROBE 3** (candidate `storeLocation: 'yard-store'`); `reservations.test.ts` "reservations … at DIFFERENT store locations are kept separate, each with its location" (issue draws from the reserved store). |
| 4 | Approved substitute eligible; same fingerprint with wrong UOM is not | `phase3-t7-reservation-plan.test.ts` **PROBE 4a** (active A→B substitute offered) + **PROBE 4b** (same fingerprint at base UOM `kg` for a `bag` requirement → no candidate, full residual). |
| 5 | Double-click and lost-response retry produce one command execution | `materials.test.ts` **PROBE 5a** (double-click → one `reserveStock`) + **PROBE 5b** (transient failure → the retry replays the SAME key). |
| 6 | Partial/failed request leaves no hidden committed state and refreshes truth | `materials.test.ts` **PROBE 6** (terminal 4xx → outbox drained, `materialsPending` cleared, `materialReadiness` reloaded). |
| 7 | Scope switch during each command → no stale toast/state | `materials.test.ts` **PROBE 7** (a switch mid-command → the flush skips its reconcile; no toast, new scope untouched). |
| 8 | Browser acceptance runs twice consecutively against the same DB, legacy + outbox, without relying on another test's mutations | `materials-pilot.spec.ts` — every browser test provisions its OWN fresh activity + free stock (unique name per run), drives the cover panel → reserve candidate → issue → consume with a visible BLOCKED → READY transition; the shortage panel raises ONE requisition; the §E stock-issues read + INERT non-pilot 404/no-nav proofs are self-contained. Run under `test:e2e:api:allmodules` and `:outbox`. |

## Instruction coverage

1. **Replace the `Promise.all` fan-out with single-command actions** — `coverMaterialShortage`/`reserveMaterial` removed; `reserveCandidate` + `raiseRequisition` (+ `issueMaterial`/`consumeMaterial`) are one command each. ✔
2. **Server supplies canonical candidates** — `reservationPlan` / `reservationCandidatesFor` (requirements + active substitutions + base-UOM + lot location + free qty); the browser never recreates compatibility from fingerprints. ✔
3. **Key reservations by `(lotId, storeLocation, activityId)`** — `reserveKey` (`lib/materialsKeys.ts`). ✔
4. **storeLocation through reserve AND issue** — required inputs; the reservation fold carries the location. ✔
5. **Persist each mutation + key before sending (durable write-ahead/outbox)** — `dispatchMaterials` → `runWriteAhead`. ✔
6. **Duplicate clicks coalesce or disable while pending** — coalesce on the stable key + `materialsPending` disables the button. ✔
7. **Lost/uncertain responses retry with the same key** — the persisted op replays under its key. ✔
8. **Scope-switch/re-auth continuations don't toast or mutate the new scope** — the flush scope guard + project-owned pending/plan state. ✔
9. **Reconcile Materials after success AND uncertain failure** — the flush materials reconcile hook. ✔
10. **Never report "covered" for a partial fix** — the browser offers only server-reservable stock and requisitions the exact residual. ✔

## Gate battery (base `248212b4`)

- `pnpm check` — **EXIT 0** (web lint + typecheck + **422/422** web unit across 39 files + build; API build; shared build).
- API unit — **631/631** across 55 files (in `pnpm check`).
- Integration (live PG) — **510/510** across 57 files (adds `phase3-t7-reservation-plan.test.ts` 6/6). One earlier full-run showed 4 transient shared-state flakes in unrelated outbox files; a clean re-run is 57/57 (and `outbox` passes 46/46 in isolation).
- Backend probes — `phase3-t7-reservation-plan` **6/6**.
- Web probes — `materials.test.ts` (single-command dispatch + PROBE 5a/5b/6/7) + `reservations.test.ts` **26/26** together.
- `upgrade-proof.sh` — **PASSED** (no migration in this correction; the legacy fixture still applies all migrations, the additive read changes nothing, and every F1–F4 forgery rejection survives).
- `test:e2e:api:allmodules` (legacy) — **31/31**; `:outbox` — **31/31** on a clean run. materials-pilot **4/4 in BOTH sender modes** (browser-driven reserve → issue → consume with a visible BLOCKED → READY transition; shortage → ONE requisition; §E read; INERT 404/no-nav). One outbox run flaked on the UNRELATED `project-scope › history preserves scope and screen` browser-history test (retries=0 locally); the materials specs passed 4/4 and a clean re-run is 31/31.

No domain schema, no migration. `ReservationPlan` is an additive shared contract; `reservationCandidatesFor`/`reservationPlan` are read-only; the frontend change is store + screen + a corrected reservation fold.

**This is the narrow Phase-3 re-review stop; Phase 4 does not begin.**
