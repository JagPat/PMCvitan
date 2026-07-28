# Phase 4 Task 5 — Daily-Log labour reconciliation (§E) + planned-vs-actual + productivity (§I)

- **Plan:** `docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md`, Task 5
- **Base:** `main` `861b622` (Phase 4 Task 4 merged through the exact-head gate — a fresh clean
  Codex +1 on PR #242; the plan's mandatory post-Task-4 review stop is satisfied)
- **Branch:** `claude/phase4-task5` (PR #245)
- **Migration:** ONE additive `20270305000000_phase4_t5_reconciliation` (3 tables; composite FKs
  incl. `(projectId, sourceCommandId)` provenance; kind/quantity/non-blank CHECKs; append-only
  triggers via the cleared `phase3_immutable_row()`; a closing DO block ABORTS if any of the three
  tables holds a row — legacy DBs upgrade row-free)

## 1. What ships

**§E — mismatch facts.** `LabourMismatch` is a labour-owned, append-only site OBSERVATION
(`kind: wrong_trade | shortfall`, per `(activityId, civilDate, shift)`, `wrong_trade` naming the
worker, `shortfall` structurally forbidden from naming one — the discriminated zod refinement plus
the DB `kind` CHECK). Recording is a pmc/engineer command (`labour.mismatch.record`) on the command
ledger under `lockProjectReadiness`; the activity target is validated through the cycle-exempt
`ActivityParticipant.labourTarget` edge and the worker reference is project-contained (composite
FK). The observation is NEVER edited: resolution is a SEPARATE pmc-only
(`labour.mismatch.resolve`) register row, `LabourMismatchResolution`, UNIQUE per observation —
a second resolve is a deterministic 409 at the service and unrepresentable at PostgreSQL.

**§E — the derived Team gate reads the facts first.** `deriveTeamReading`'s mismatch parameter
(seamed `false` in Task 4) is now real: both seams — `activities.start`'s in-tx `teamReading` and
the read-path bake — pass `LabourQuery.unresolvedMismatchActivityIds(...)`, so an unresolved
observation is a first-match §A `fail` BEFORE coverage, even when every slice is present AND
worked. The facts protect the start, not the stored state: a hostile status reset cannot start the
activity.

**§E — the operational block + banner handover.** `blockForLabourMismatch` moves ONLY
`not_started`/`in_progress` to `blocked` with the `Crew ≠ allocated` banner (`awaiting_signoff`
keeps its pending completion claim, `done` is history, an already-blocked activity keeps its
current banner) and emits the activities-owned `activity.labour_blocked` signal so the schedule
projection observes the transition. `clearLabourMismatchBlock` restores by recorded work state and
emits ONE `activity.labour_unblocked`, ONLY once no unresolved observation remains for the
activity. `clearMaterialMismatchBlock` now consults labour truth through the declared
activities → labour query edge: a material resolution on an activity that STILL carries an
unresolved labour dispute RE-ASSERTS the labour banner (status stays `blocked`, `gateMaterial`
falls back to `wait` — never a fabricated ok) instead of silently dropping the dispute.

**§E — the presence read.** `labour.presence` (GET, `labour.read`, 404 off-pilot) is the §E
Daily-Log surface: that civil date's per-worker musters with worker identity JOINED from the
labour register (copied nowhere) + the UNRESOLVED mismatch observations only (the API fails
closed — a resolved observation never re-enters the active list). The daily-log module is
UNTOUCHED, so the non-pilot daily-log response stays byte-identical and the legacy aggregate
`CrewRow` steppers remain display-only (a hostile 99-count stepper changes no labour truth).

**§I — measured output + productivity.** `ActivityWorkOutput` is an ACTIVITIES-owned immutable
fact (`quantity > 0`, non-blank `uom`, optional same-project photo evidence via a `Media`
composite FK; `activities.recordOutput`, pilot-gated, pmc/engineer/contractor). A cited photo is
not deletable — the media delete tx invokes `ActivityParticipant.assertMediaDisposable` (the
inventory/labour pattern). Productivity is the DERIVED join composed on the Activities side (the
`ActivityWorkOutput` owner, per the round-3 module-graph ruling): `labourProductivity` reads
Labour's effort through the new `LabourQuery.effortFor` (worked-minutes grouped per
`(activity, civilDate, shift)`) and reports per-slice
`plannedPersonShifts / presentWorkers / workedMinutes / outputs / productivityPerHour`
(`quantityPerHour = Σ quantity ÷ workedHours` per UOM; zero effort → `null`, never a division by
zero or a fabricated rate). Labour never reads `ActivityWorkOutput`; Labour stays a LEAF.

**Events.** `labour_mismatch.recorded` / `labour_mismatch.resolved` (labour-owned) and
`activity.labour_blocked` / `activity.labour_unblocked` / `activity_output.recorded`
(activities-owned) join the shared catalog, the sealed external-effect catalog
(`invalidate: true, push: null` — signal-only), and their manifests' `producesEvents`. The
activities projection dispatches on the `activity.*` prefix, so the block transitions refresh it
with no consumer change.

## 2. Tripwires advanced in the same PR

- `cross-module-graph.test.ts`: MODEL_OWNER +3 (`labourMismatch`/`labourMismatchResolution` →
  labour, `activityWorkOutput` → activities); dispatch sites 77→80 (activities.service 7→8,
  labour-capacity.service 7→9); mutating routes 144→147; CONTROLLER_ROUTES +3 signatures.
- `boundary.test.ts`: declared route total 144→147.
- `readiness-lock-coverage.test.ts`: SECTION_A_COMMANDS 32→34 (`recordMismatch`,
  `resolveMismatch` — both lock-first). `recordOutput` is deliberately NOT lock-protected:
  measured output feeds no gate (productivity is a derived read).
- `module-registry.test.ts`: labour `ownsModels`/`readEncapsulated` 25→27.
- `activities.contract.test.ts`: expected `ownsModels` + `activityWorkOutput`.
- `media.service.test.ts`: the third disposability participant (activities) stubbed + pinned.
- `apps/web/tests/policy.test.ts`: +`labour.mismatch.record` (pmc/engineer),
  +`labour.mismatch.resolve` (pmc), +`activity.output.record` (pmc/engineer/contractor).

## 3. Reproduce-first tests

`apps/api/test/integration/phase4-t5-reconciliation.test.ts` — **14/14** live-PG:

1. §D off-pilot — mismatch record/resolve, presence, output, productivity all 404.
2. §E mismatch-first — present+worked coverage `ok` → one observation → derived `fail`
   (reason names the mismatch); HOSTILE status reset → `start` still refused naming `team`;
   pmc resolution → `ok` → start succeeds.
3. §E contract — the wrong_trade/shortfall × workerId zod refinement (both directions).
4. §E authority — engineer records (keyed replay appends exactly ONE row), engineer resolve 403,
   pmc resolve attributed.
5. §E register — second resolve 409; the observation row byte-identical before/after; exactly one
   register row.
6. §E/§I seals — UPDATE and DELETE rejected by PostgreSQL on all three tables.
7. §E presence — joined worker identity; UNRESOLVED-only; CrewRow 99-count stepper changes no
   labour truth (musters still 2, gate still `fail`).
8. §E handover — material block → labour dispute → material resolved FIRST → labour banner
   re-asserted (`blocked` / `gateMaterial: wait` / `Crew ≠ allocated`) → labour resolved →
   restored.
9. §E lifecycle — `awaiting_signoff` never operationally moved (derived gate still fails);
   `in_progress` blocks and restores to `in_progress`.
10. §E race, start-first — under the deterministic readiness-lock barrier: start refused on the
    FACT, the later resolve clears, a fresh start succeeds.
11. §E race, resolve-first — the start serialized behind it sees the closed register and succeeds.
12. §G projection — `activity.labour_blocked`/`unblocked` each emitted exactly once; the
    caught-up activities projection shows BOTH transitions.
13. §I effort + productivity — `effortFor` groups 480+240→720; 12 m³ ÷ 12 h → `1.000000`/h with
    planned/present pinned; zero-effort output → `null`.
14. §I evidence — cited photo delete 409 (row survives), uncited photo deletes, cross-project
    evidence refused (400) before the composite-FK backstop.

## 4. Gate battery

- `pnpm check` EXIT 0 (web 432/432; api 680/680; builds clean).
- FULL integration suite on a pristine migrated DB — recorded in §7 below.
- `upgrade-proof.sh` PASSED: the 3 tables ROW-FREE over the legacy fixture; seals/uniques/CHECKs
  installed; a coherent mismatch→resolution + output chain ACCEPTED (seals precise, not merely
  strict); 15 hostile statements rejected (second resolution, orphan resolution, all six
  UPDATE/DELETE append-only probes, blank note/uom, alien kind, zero quantity, forged
  activity/worker/media/command references); every prior Phase-1..Phase-4-T4 rejection surviving.
- `test:e2e:api:allmodules` + `:outbox` — recorded in §7 below (the external-effect catalog hash
  changes with the five new entries; the e2e harness reseals, and production reseals at deploy per
  the runbook).
- Harness: the three tables joined `prisma/seed.ts`'s reset TRUNCATE (append-only triggers block
  `deleteMany`; their FKs would otherwise block the media/activity/worker wipes). Sibling
  integration TRUNCATE lists need no change — every list containing `CommandExecution` is
  `CASCADE`.

## 5. Explicitly NOT in this PR (per the plan)

- Task 6 (§J frontend surfaces + the pilot acceptance chain + the consolidated Phase-4 packet)
  does NOT begin here.
- No daily-log module change of any kind (§E is served by labour-owned reads; the legacy snapshot
  and CrewRow shapes are untouched).
- No change to the Task-4 coverage/forecast authority, the seventh projection, or any migration
  that has reached `main` (all prior migration bytes unchanged).

## 6. Vision alignment

§25's site truth requires that a disagreement between what the site SAYS happened and what the
system EXPECTED is a first-class, attributable fact — never a silent overwrite. Task 5 gives the
labour pillar exactly what §E gave materials: the observation is immutable, the resolution is a
separate pmc-authored register row, the derived Team gate fails first on the open dispute, and
the operational block hands over between material and labour banners without ever dropping a
dispute. §I makes productivity an honest DERIVED join of two owned fact families (output ÷
effort) rather than a stored number anyone could type.

## 7. Codex WIP-round findings (head `f4e6ab1`) — folded in-branch

Codex reviewed the WIP checkpoint `f4e6ab1` (services/schema/contracts, before the test suite)
and returned six findings; all six are fixed in this branch (checkpoint `4802d9a` + the suite
commit), each covered by the §3 probes:

1. **Projection freshness** — the block transition emitted no activity-owned signal, so a
   servable schedule projection kept serving the pre-block status. Fixed:
   `activity.labour_blocked` (+ the existing `activity.labour_unblocked`) in the participant,
   catalog + manifest entries; probe 12.
2. **Banner handover** — a material clear could drop a still-unresolved labour dispute. Fixed:
   `clearMaterialMismatchBlock` re-asserts via `unresolvedMismatchActivityIds`; probe 8.
3. **Provenance FKs** — `(projectId, sourceCommandId)` composite FKs to `CommandExecution` on all
   three tables (upgrade-proof forged-command rejection).
4. **Presence fails closed** — resolved observations excluded (`resolution: { is: null }`);
   probe 7.
5. **Non-blank CHECKs** — `btrim(..., E' \t\n\x0B\f\r')` on note/resolution/reason/uom/note
   (upgrade-proof blank probes).
6. **Lifecycle preservation** — `blockForLabourMismatch` moves only `not_started`/`in_progress`;
   probe 9.

Battery for that checkpoint head (`4802d9a`): `pnpm check` EXIT 0 (web 432/432, api 680/680);
full integration **71 files / 692 tests** on a pristine migrated DB; `upgrade-proof.sh` PASSED;
`test:e2e:api:outbox` 25/25; `test:e2e:api:allmodules` 30/31 (the one failure was the documented
timing-sensitive `drawings-module-query` acknowledge spec — no labour surface; re-run green in
§8's battery).

## 8. Codex attempt-2 findings (head `4802d9a`) — fixed in this branch

Codex's second review (of the checkpoint head, before the test suite landed) returned five
findings; each is fixed here with its own probe:

1. **F-A (P1, labour block transition not conditional)** — `blockForLabourMismatch` read the
   status without a row lock and updated by id only; `activities.complete` does NOT take the
   readiness lock, so a completion committed between the read and the write was overwritten with
   `blocked` and the sign-off claim lost on resolution. FIX: the transition is a CAS —
   `updateMany` guarded on `status IN ('not_started','in_progress')` (and the clear guarded on
   `status='blocked' AND block='Crew ≠ allocated'`), re-evaluated under the row lock; zero rows →
   no transition, no signal. PROBE (deterministic, RED at `4802d9a`): a held Activity row lock
   admits the mismatch command only AFTER `awaiting_signoff` commits — the claim SURVIVES, no
   `activity.labour_blocked` is emitted, the observation is still recorded, and the derived gate
   still fails on the FACT.
2. **F-B (P2, SQL seals for shift + kind↔worker)** — rows written outside the HTTP zod schemas
   could carry `shift='swing'`, a shortfall naming a worker, or a wrong_trade naming none, and
   the append-only triggers make bad evidence unrepairable. FIX (the unmerged `20270305` edited
   in place): `LabourMismatch_shift_check` / `ActivityWorkOutput_shift_check`
   (`shift IN ('day','night')`, the Task-3 vocabulary) + `LabourMismatch_kind_worker_check`
   (`wrong_trade ⟺ workerId NOT NULL`). Upgrade-proof: four new hostile inserts rejected on the
   migrated legacy DB.
3. **F-C (P2, undeclared Media→Activities participant edge)** — the delete path called
   `ActivityParticipant.assertMediaDisposable` but `mediaManifest.workflowParticipants` omitted
   `activities`. FIX: declared (+ the module-registry expected-participants pin).
4. **F-D (P2, unpublished activity-owned events)** — `activity.labour_blocked` /
   `activity.labour_unblocked` / `activity_output.recorded` were emitted but absent from
   `activitiesManifest.producesEvents`. FIX: declared (+ the contract-test pin), so the registry
   never claims the outbox holds events no module produces.
5. **F-E (P2, float productivity arithmetic)** — per-UOM sums and the ÷hours ran in `number`,
   corrupting the exact `Decimal(18,6)` scale at large magnitudes. FIX: `Prisma.Decimal`
   end-to-end, formatted to 6 decimals only at the wire. PROBE (RED at `4802d9a`):
   `123456789012.345678` over exactly one worked hour comes back byte-exact (float64 yields
   `…345673`).

Reproduce-first `phase4-t5-reconciliation.test.ts` is now **15/15** (the §3 fourteen + the F-A
race probe, with the F-E case folded into the §I productivity probe). Focused pins re-run green:
`activities.contract` / `module-registry` / `cross-module-graph` / `boundary` / `media.service`
149/149; `upgrade-proof.sh` PASSED (19 Task-5 hostile statements now rejected).

Battery results for the FINAL head:

- `pnpm check` EXIT 0 — automation suite, web 432/432, api 680/680, both builds clean.
- Full integration: **71 files / 693 tests, all passing** on a pristine migrated DB.
- `upgrade-proof.sh` PASSED (incl. the four round-2 hostile inserts).
- `test:e2e:api:allmodules` **31/31** (the earlier `drawings-module-query` flake clean on this
  run) and `test:e2e:api:outbox` **25/25**.
