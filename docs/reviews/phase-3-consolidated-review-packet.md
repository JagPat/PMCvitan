# Phase 3 — Material Readiness pilot: consolidated review packet (final review stop)

**One held Task-7 PR.** Base: `main` @ `5b7b8c4` (the merged PR #204 head `d45de9d`; Task 6 CLEARED).
Branch: `claude/phase3-task7`. Task 7 delivers the pilot-gated, module-owned **frontend** surfaces,
the **Shortage Inbox** actions with forecast impact, and the **real-browser live-PostgreSQL pilot
acceptance chain** in BOTH capability states — closing the Phase-3 Material-Readiness pilot. This is
the **final Phase-3 independent review stop.** No new domain schema; no migration. Phase 4 is NOT begun.

## Vision-alignment statement

The pilot's promise (§25) is *one site running without a separate material spreadsheet, on facts the
later phases inherit.* Phase 3 built the fact-owners: demand + readiness judgment with **activities**,
commitments with **procurement**, physical truth with **inventory**, observations with the **daily
log** — each the single canonical owner of its fact, joined only by read at the edges, and command
authority always reading canonical facts under the project readiness lock, never a projection. Task 7
adds the *human surface* over those facts without moving any ownership: the Materials hub renders
seven module-owned reads; the readiness verdict is the SAME `coverageFor` max-flow that authorizes
`activities.start`, projected for the eye; the Shortage Inbox turns a blocked/at-risk requirement into
one actionable card carrying its forecast; and every one of these surfaces is **inert on a non-pilot
project** because it is gated on the per-project `materials` capability (§D), not a global module. One
fact keeps one owner; human authority stays attributable; migrations stayed additive across all seven
tasks; issued documents stay frozen; tenant containment is DB-enforced and adversarially proven. The
pilot leaves one site's material demand, commitments, receipts, custody and readiness answerable from
records — the trust foundation Phases 4 (labour) and 5 (commercial) build on.

## Phase-3 delivery lineage (all tasks)

Phase 3 was built as small vertical PRs, each independently reviewed to GREEN before the next:

| Task | Scope | Merge |
|---|---|---|
| Plan | Material-Readiness pilot plan (round-1 §§A–H + round-2 corrections cleared) | `9a84442` → `88a29fe` |
| 1 | `ProjectCapability` pilot gate (§D); `ActivityRequirement` root + append-only revisions (§F); `MaterialSpecificationRef` technical identity (§B); requirement events (§G) | PR #189 → corrections #190/#191/#192 → CLEARED at `4cc759a` |
| 2 | Procurement — vendors/`ProjectVendor` dual-composite-FK tenancy (§H); requisitions→RFQs→quotes→comparison (§F); requirement→requisition bound-1 | PR #193 |
| 3 | Purchase orders + delivery commitments — versioned PO with PG-frozen line snapshots (§F); `po.*`/`delivery.*` events (§G); requisition→PO bound-2 | PR #194 |
| 2–3 correction | Match-only selection + material gate; purchase-UOM arithmetic; complete-coverage comparison; PG-sealed evidence/provenance; civil-date expiry; F4 DB provenance | PR #195 → #196 → CLEARED at `9520cd4` |
| 4 | Inventory — `StockLot` + append-only `StockTransaction` ledger (§C, no current-qty column); receipts/acceptance; §F bound-3 under concurrency | PR #197 |
| 5 | Reservations/issues/consumption/site-return/wastage/transfer + `MaterialIssue`; §E daily-log read + `MismatchResolution` | (held) |
| 4–5 integrity + boundary | DB-enforced command/receipt/issue/mismatch provenance; idempotency enforcement; executable operator repair; production-runner preflight | PR #199 → #200 → #201 → CLEARED at `dfd1c0a` |
| 6 | Canonical material readiness — `coverageFor` conserved combined-flow; `activities.start` reads coverage in-tx under lock (§A); sixth rebuildable projection | PR #202 → corrections #203/#204 → CLEARED at `5b7b8c4` |
| **7** | **Pilot-gated module-owned frontend + Shortage Inbox forecast + real-browser both-state acceptance chain + this packet** | **THIS held PR** |

## Task 7 — what shipped

**1. Pilot-gated, module-owned frontend surfaces.** The Materials hub (`MaterialsScreen.tsx`) is ONE
screen with seven tabbed panels covering the whole pipeline — **Readiness → Requirements → Procurement
→ Deliveries → Inventory → Reservations → Issues** — each a module-owned read fetched by
`loadMaterials()`. Because Phase-3 data is greenfield (never in the legacy snapshot), the reads are
**module-query-only** (no `VITE_*_READ` XOR flag): the gateway calls
`GET …/activities/material-readiness`, `…/requirements`, `…/requisitions`, `…/pos`, `…/stock`,
`…/stock/issues`. Load states are honest — loading / unavailable+Retry / stale banner — and every read
is scope-guarded (`isCurrentProjectScope`) so an in-flight reply after a project switch or re-auth is
dropped, and torn down via `emptyProjectData`/`emptyModuleReadState`.

**Capability gate (§D).** The Materials nav entry is present ONLY when the active project carries the
`materials` capability. `enabledModules` is registry-global (inventory/procurement are enabled for all
projects), so a *per-project* gate was required: the project shell now returns `capabilities: string[]`
(`materials` iff `CapabilitiesService.isEnabled`), `SCREEN_CAPABILITY` gates the `materials` screen on
it, and `loadMaterials()` is a no-op without it. On a non-pilot project the hub, its reads, and the
Shortage Inbox action are all absent — proven in the browser and at the API.

**2. Shortage Inbox actions + forecast impact (§25).** The readiness read returns a per-requirement
verdict AND a shortage forecast: `blocked → no-supply`; `at-risk → delays-start` when the covering
commitment lands after the planned start, else `covered-in-time`. `selectActionItems` surfaces ONE
`material-shortage` item for a pilot pmc/engineer, worst-first (the backend sorts blocked-before-at-risk,
soonest-needed), red when any impact is hard (blocked / delays-start) else amber, with the worst
forecast in the detail. It jumps to the Materials hub.

**3. Real-browser live-PG acceptance chain.** `materials-pilot.spec.ts` authors the full pipeline over
the API on a DEDICATED pilot project (capability enabled by the operator CLI — the sole §D enable
path) — requirement → requisition → submit → approve → RFQ → vendor → bind → quote → comparison →
approve → PO → issue → delivery commitment → receipt → media → acceptance → stock → reservation →
issue — then drives the Materials hub in a real browser: the readiness summary + both verdicts (one
`READY`, one `BLOCKED`), and each pipeline panel (PO, lot, reservation, issue). The blocked requirement
produces the Shortage Inbox card with its no-supply forecast. The §E stock-issues read surfaces the
issued material with the lot's §B identity joined and custody derived — and it is NOT among the
daily-log's SiteMaterial delivery rows ("an issue is not a delivery").

**4. Both capability states proven.** The same suite proves a second PLAIN project is INERT: no
Materials nav in the browser, and `GET …/activities/material-readiness` returns **404** off-pilot.

## §25 Pilot Acceptance Criteria → evidence (material scope)

| §25 criterion | Evidence |
|---|---|
| one site operates without a separate material spreadsheet | The Materials hub renders requirements→procurement→deliveries→inventory→reservations→issues→readiness for the pilot project from module-owned reads; `materials-pilot.spec.ts` drives it end to end |
| every upcoming Activity has dated resource requirements + accountable owners | `ActivityRequirement` (§F) with DATE `requiredBy` + membership-validated `responsibleId`/`createdById` (Task 1, `4cc759a`) |
| every accepted receipt changes traceable stock through ledger transactions | Append-only `StockTransaction` ledger; buckets derive by fold; no current-qty column (§C, Task 4) |
| every material issue traces to an Activity and location | `MaterialIssue` canonical record + issue-scope trigger (activity+lot+location); §E read `GET …/stock/issues` (Task 5); e2e asserts `issue.activityId` + joined lot identity |
| readiness changes automatically from evidence | `coverageFor` conserved combined-flow folds the ledger to `ready\|at-risk\|blocked`; `activities.start` reads it in-tx under lock (§A, Task 6); the readiness read is the SAME derivation, projected |
| supply shortages produce forecast impact and Inbox actions | `material-readiness` read returns the shortage forecast; `selectActionItems` `material-shortage` card (Task 7); e2e asserts the no-supply card |
| project dashboards contain no manually entered operational counts | Readiness summary + shortage badge derive from the ledger; the nav badge = `materialsView.readiness.shortages.length` |
| cross-project and cross-company access tests pass | Capability gate (§D) 404 off-pilot; the two-projects-one-org inertness proof (Task 1); vendor dual-composite-FK tenancy (§H, Task 2); e2e INERT test + `project-scope.spec.ts` |

Non-material §25 criteria (inspection rejection→corrective work; completion→closing sign-off; weekly
report drafts; commercial-amount tracing to payment) belong to Phases 1 (delivered/cleared) and 4–5
(out of Phase-3 scope), noted here for completeness.

## Eight design decisions §A–§H → evidence

| Decision | Where it lives / how Task 7 honors it |
|---|---|
| **§A** Material-readiness truth + lock protocol | `coverageFor` + `deriveMaterialReading` worst-wins (`ready→ok · at-risk→wait · blocked→fail · na`); the ONE derivation is shared by start / read-bake / projection, so the Task-7 read == the authorizing verdict by construction; command-level §A lock tripwire (22 commands) unchanged |
| **§B** Canonical material identity + units | `MaterialSpecificationRef` technical-identity fingerprint; the readiness read + `MaterialIssue` join the lot's §B identity for display, never copying it into daily-log rows |
| **§C** Stock ledger conservation | Append-only `StockTransaction`; buckets by fold; no current-qty column; the Reservations panel folds the §C ledger by activity, the Inventory panel folds buckets — read-only derivations |
| **§D** Pilot activation | Per-project `ProjectCapability`; shell `capabilities[]` + `SCREEN_CAPABILITY` gate + `loadMaterials` no-op off-pilot; enable ONLY via the operator CLI; e2e proves both states |
| **§E** Daily-Log reconciliation | The §E read is inventory's `stock.issues` (lot identity joined, custody derived, nothing copied); the non-pilot daily-log response is byte-identical; `MismatchResolution` unchanged |
| **§F** Requirement + procurement state machines | Requisition CAS → RFQ → quote → comparison approval → versioned PO → delivery commitment; the Procurement/Deliveries panels render these read-only |
| **§G** Module edges + event catalog | The readiness projection is recompute-only (derives no events); the Task-7 reads add NO events; nav/inbox read the module query contracts, not private persistence |
| **§H** Vendor tenancy + authorization | `Vendor(orgId)`/`ProjectVendor` dual-composite-FK tenancy + the pilot permission matrix; the `material-readiness` GET reuses the `requirement.read` policy (no new role-policy surface) |

## Reproduce-first / behavior evidence (Task 7)

- **API read** — `phase3-t7-readiness-read.test.ts` (live PG, 5/5): READY (reserved ≥ requirement,
  no shortages), BLOCKED + no-supply forecast, AT-RISK/covered-in-time (commitment before planned
  start), AT-RISK/delays-start (commitment after planned start), and INERT (non-pilot 404).
- **Web unit** — `materials.test.ts` (10/10): the nav capability gate (hidden without `materials`,
  shown for pmc+engineer with it, never for client/contractor/consultant); the shortage selector
  (worst-first, red on hard impact, amber on soft, absent with no bundle/off-pilot); `loadMaterials`
  (no-op off-pilot, `ready` on a pilot, error keeps last-good); `loadShell` sets `capabilities` and
  triggers the bundle.
- **Real-browser both-state** — `materials-pilot.spec.ts` (4/4, live PG): PILOT hub renders the
  pipeline + 1 READY / 1 BLOCKED verdict; PILOT shortage Inbox card with the no-supply forecast; PILOT
  §E stock-issues read (issue-not-a-delivery); INERT non-pilot no-nav + 404.

## Verification battery (this PR)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + unit + build, web & api) | **EXIT 0** — web 406/406 (38 files), API 631/631 (55 files) |
| Full live-PG integration suite (`test:integration`) | **502/502 across 56 files** (incl. `phase3-t7-readiness-read` 5/5, all Phase-3 race/ledger/isolation probes) |
| `scripts/upgrade-proof.sh` (additive migrations apply over legacy fixture; F1–F4 forgery rejections survive) | **UPGRADE PROOF PASSED** (EXIT 0 — all migrations applied over the legacy fixture; every provenance forgery ABORT rehearsal survived) |
| `test:e2e:api:allmodules` (legacy sender) | **31/31 passed, EXIT 0** (27 baseline + the 4 `materials-pilot` tests) |
| `test:e2e:api:allmodules:outbox` (outbox sender) | **31/31 passed, EXIT 0** (the 4 `materials-pilot` tests pass in both sender modes) |
| Tripwires (mutating-route count, dispatch-site, §A command-lock, emitter, route-policy, contract) | green within `pnpm check` |

No migration is added; `upgrade-proof.sh` confirms the Phase-3 migration set still applies cleanly and
every Task-1..6 DB invariant survives. Task 7 is pure read + UI surface over already-cleared facts.

_Note on the outbox run:_ one outbox-mode run flaked on three serial, state-dependent `pillar-chain`
inspection-reinspection browser steps (tests 18/19/21 — timing-sensitive async-relay UI with no local
retries, cascading from a single missed submit under concurrent build/relay load); the 4 `materials-pilot`
tests passed in that same run. A clean re-run under lighter load was **31/31** with those three green,
confirming a load-induced flake unrelated to the read-only Task-7 change (which touches no
inspection/notification path).

## File inventory (Task 7)

**Shared** — `packages/shared/src/contracts/activities.ts` (`materialReadiness.get` query +
`MaterialCoverageVerdict`/`ShortageImpact`/`RequirementReadinessRow`/`ShortageForecastRow`/
`MaterialReadinessResult` DTOs); `packages/shared/src/domain/types.ts` (`ScreenKey` gains `materials`).

**API (reads only)** — `activities/activities.query.ts` (`materialReadiness` folds coverage +
forecast); `activities/activities.controller.ts` (`GET material-readiness`, `requirement.read`);
`snapshot/types.ts` + `snapshot/project.controller.ts` (`capabilities[]` on the shell).

**Web** — `screens/MaterialsScreen.tsx`; `store/materials.ts` (`MaterialsView`); `store/store.ts`
(`loadMaterials`, `capabilities`, shell wiring); `store/projectScope.ts` (`materialsLoad`,
`materialsView`, `capabilities`); `store/selectors.ts` (`material-shortage`); `data/apiGateway.ts`
(6 reads + `capabilities`); `data/useApiSync.ts`; `layout/ScreenView.tsx`; `layout/useNavItems.ts`;
`lib/screens.ts` (`SCREEN_CAPABILITY` + `enabledScreensFor(role, modules, capabilities)`).

**Tests** — `apps/api/test/integration/phase3-t7-readiness-read.test.ts`;
`apps/web/tests/materials.test.ts`; `apps/web/tests/e2e-api/materials-pilot.spec.ts` (+ the minimal
`node:child_process` ambient shim in `node-globals.d.ts`).

**Docs** — CLAUDE.md, `docs/ROADMAP.md` (Task-6 CLEARED SHAs + Task-7 state); this packet.

## Out of scope / not begun

Labour readiness (Phase 4); commercial control — budgets, bills, measurement, certification, payments
(Phase 5); portals + vendor-org promotion (Phase 6); accounting (Phase 7). **Phase 4 is NOT begun.**
This is the final Phase-3 review stop.
