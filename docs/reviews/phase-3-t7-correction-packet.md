# Phase 3 — Task 7 correction packet (operational pilot + readiness correctness)

**Base:** `main` @ `c642da3` (the merged PR #205). **Branch:** `claude/phase3-t7-correction`.
**Verdict being corrected:** the Task-7 independent review returned **BLOCKED NARROWLY — PHASE 3 NOT YET CLEARED** (Tasks 1–6 remain valid; PR #205 is additive and needs no rollback). This is ONE focused correction from `main`; it does not modify or redesign Tasks 1–6 and does not begin Phase 4.

## Vision-alignment statement

The pilot's promise (§25) is *one site running without a separate material spreadsheet, on facts the later phases inherit.* Task 7's first cut rendered those facts but did not let a user OPERATE on them, and its readiness projection counted the wrong unit and mis-dated a forecast. This correction makes the Materials hub **operational** — reserve, issue, consume, and a shortage's corrective all run through the existing Task 4/5/procurement commands under their existing authority and idempotency — and makes the readiness view **canonically correct**: totals are counted per ACTIVITY (stock is activity-reserved), forecasts measure the covering delivery against the EARLIEST need date, reservations fold the ledger (reversals included) with exact decimal arithmetic, and an older refresh can never overwrite a newer one. One fact keeps one owner; no schema, no migration (read + UI + a corrected read projection over already-cleared facts).

## Findings → resolution → evidence

| # | Sev | Finding | Resolution | Reproduce-first evidence (RED @ `c642da3` → GREEN) |
|---|---|---|---|---|
| 1 | P1 | The frontend is observational, not operational; the "browser acceptance chain" authored everything over the API, omitted consumption, and never proved a browser-driven readiness transition. | A **minimum operational pilot workflow** over existing commands: the Materials hub reserves on-hand stock to an activity, issues it to site, and records consumption; the shortage's corrective raises a requisition (or reserves covering stock). The e2e now sets up procurement→acceptance as a FIXTURE only, then DRIVES reserve → issue → consume in the browser with a visible readiness change. | `materials-pilot.spec.ts` "PILOT operational: the browser RESERVES on-hand stock (BLOCKED → READY), ISSUES it, and records CONSUMPTION" — browser-driven through consumption, both sender modes. |
| 2 | P1 | An older `loadMaterials()` refresh can overwrite newer material data (no same-scope request ordering). | **Latest-request ownership**: each `loadMaterials()` claims a monotonic token; only the newest same-project load may write the view or change its load state. An older success/failure that resolves late is dropped. | `materials.test.ts` "an OLDER load that resolves LATE never overwrites a NEWER result" + "an OLDER load that FAILS late never overwrites a NEWER success" (RED without the token guard). |
| 3 | P2 | Per-requirement shortage counts are not canonical — Task 6 assigns ONE activity verdict to every requirement; Task 7 counted those rows as separate shortages. | Readiness + shortage TOTALS are now **per ACTIVITY** (`MaterialReadinessResult.activities`, `summary` counts activities, `shortages` is one row per affected activity). The per-requirement `requirements` rows remain supporting detail, never independent shortages. | `phase3-t7-readiness-read.test.ts` "FINDING 3: one activity with two short requirements is ONE shortage; totals are per activity" (3 requirements → 2 activities → 2 shortages; summary `{blocked:2,total:2}`). |
| 4 | P2 | Forecasts can call a late delivery "covered in time" — the target used `plannedStartDate ?? requiredBy`, ignoring an earlier `requiredBy`. | The forecast measures against the **earliest applicable need date** = `min(plannedStartDate, requiredBy)` (per-activity: min across its requirements). A commitment after `requiredBy` is never `covered-in-time`, even when it precedes the planned start. | `phase3-t7-readiness-read.test.ts` "FINDING 4: a commitment after requiredBy is delays-start even when it PRECEDES the planned start" (requiredBy 08-15, planned 09-30, commitment 09-15 → `delays-start`, was `covered-in-time`). The existing covered-in-time test was rewritten to a legal scenario (requiredBy after the commitment). |
| 5 | P2 | Reversed reservations remain visible — the fold totalled only `reservation`/`reservation_release` and used lossy `Number`. | `foldActivityReservations` folds the **§C `fromBucket`/`toBucket` movements** (reversals + issues included) with **exact decimal arithmetic** (`lib/decimal.ts`, BigInt fixed-point). A reversed reservation nets to zero and is not shown. | `reservations.test.ts` "a reservation REVERSED shows NO active reservation", "an issue … leaves no active reservation", "folds a lossy-precision quantity EXACTLY (Number() would corrupt it)". |

## Instruction coverage

1. **Minimum operational pilot workflow** — reserve / issue / consume + shortage corrective (raise requisition, or reserve covering stock), all through the existing Task 4/5/procurement endpoints with stable idempotency keys. No new domain tables. ✔
2. **Shortage action → corrective command** — `coverMaterialShortage` reserves matching free stock when on hand, else raises a requisition; the Materials Readiness panel surfaces the button, and the Inbox item links to it. ✔
3. **Latest-request ownership** on `loadMaterials` — older successes AND failures are dropped. ✔
4. **Activity-level readiness + shortage totals** — `activities` roll-up; `summary` and `shortages` per activity; requirements remain supporting detail. ✔
5. **Forecast against the earliest need date** — `min(plannedStartDate, requiredBy)`; late-vs-requiredBy is never covered-in-time. ✔
6. **Reservations from ledger `fromBucket`/`toBucket`, reversals included, exact decimals** — `foldActivityReservations`. ✔
7. **Browser-driven command steps through consumption + a visible readiness change** — API used only for fixture setup and independent assertions; the non-pilot no-navigation/404 proof is kept. ✔
8. **Reproduce-first probes for all five findings, packet updated, full legacy/outbox battery, stop for one narrow re-review** — this packet; battery below. ✔

## Scope / non-goals

Read + UI + a corrected read projection only. **No domain schema; no migration.** No change to the pilot capability gate, the `coverageFor` max-flow authority (`activities.start` still reads the same canonical coverage), or any cleared Task-1..6 invariant. The `material-readiness` read is still a live canonical read (never a projection), capability-gated (404 off-pilot).

## Verification battery

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + unit + build) | **EXIT 0** — web 417/417 (39 files), API 631/631 (55 files) |
| Full live-PG integration (`test:integration`) | **504/504 across 56 files** (+2 reproduce-first probes vs the merged 502) |
| `scripts/upgrade-proof.sh` | **PASSED** (no migration; all migrations apply over the legacy fixture and every F1–F4 forgery rejection survives) |
| `test:e2e:api:allmodules` (legacy) | **31/31, EXIT 0** (materials-pilot 4/4) |
| `test:e2e:api:allmodules:outbox` | **31/31, EXIT 0** (materials-pilot 4/4) |

_Honest note on flake: one legacy e2e run failed a single UNRELATED browser-history test (`project-scope.spec.ts:109 › history preserves scope and screen`, a `page.goBack()` URL-timing assertion) with materials-pilot 4/4 passing; a clean re-run was 31/31. This is the known browser-navigation flake class, unrelated to the read + UI + query change._

## File inventory

- **Shared contract:** `packages/shared/src/contracts/activities.ts` — `ActivityReadinessRow`, `ActivityShortageRow`, `MaterialReadinessResult.activities`, activity-level `summary`/`shortages`.
- **Backend read:** `apps/api/src/activities/activities.query.ts` — activity roll-up + earliest-need forecast (findings 3, 4).
- **Frontend:** `apps/web/src/lib/decimal.ts` (new), `apps/web/src/lib/reservations.ts` (new), `apps/web/src/screens/MaterialsScreen.tsx` (operational actions + activity summary + reversal-aware decimal fold), `apps/web/src/store/store.ts` (`loadMaterials` latest-request ownership + `reserveMaterial`/`issueMaterial`/`consumeMaterial`/`coverMaterialShortage`), `apps/web/src/data/apiGateway.ts` (operational command methods).
- **Tests:** `apps/api/test/integration/phase3-t7-readiness-read.test.ts` (findings 3, 4 probes + corrected covered-in-time), `apps/web/tests/materials.test.ts` (finding 2 race + operational actions + activity-level shortage), `apps/web/tests/reservations.test.ts` (finding 5 probes), `apps/web/tests/e2e-api/materials-pilot.spec.ts` (browser-driven operational chain, finding 1/7).
