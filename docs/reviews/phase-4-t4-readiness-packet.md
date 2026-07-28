# Phase 4 Task 4 — canonical labour coverage + the derived Team gate + combined readiness + the seventh projection (§A/§G)

Review packet for the MANDATORY narrow review stop after Task 4 (plan instruction 12), before
Daily-Log reconciliation (Task 5) and frontend integration (Task 6).

- Base: `origin/main` `93fe2c3` (Task 3 cleared through the exact-head gate as PR #230 → `main`
  `33d37a3`; the STATUS flip merged as PR #237 → `9264de4`; the orchestrator direct-merge fix
  merged as PR #238 → `93fe2c3`).
- Branch: `claude/phase4-task4` (held draft PR).
- Plan: `docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md` §A/§B/§C/§D/§G, Task 4 of
  the Required Execution Order.
- Tasks 1–3 are NOT reopened; no deployed migration is altered (all prior migration bytes frozen).

## 1. What ships

**Execution truth (§A) — `LabourCoverageService.coverageFor(tx, projectId, requirements, asOf)`**
(`apps/api/src/labour/labour-coverage.service.ts`). A pure READ of Labour-owned §C facts on the
CALLER's transaction, evaluated per `(civilDate, shift)` demand slice at the project-timezone
civil date `asOf` (the injected clock — never `new Date()`). The §A execution first-match table is
implemented literally:

| row | condition | verdict |
|---|---|---|
| 3 | `asOf` precedes the earliest demand slice | `wait` (window not begun) |
| 4 | any slice `< asOf` with `max(present, worked) < personShiftQty` | `fail` (overdue) |
| 5 | every due-today slice covered by present-or-worked AND every past slice fulfilled | `ok` |
| 6 | due-today allocated in full but not fully mustered | `wait` (muster pending) |
| 7 | due-today under-allocated | `fail` |

Rows 3–4 close the vacuous-ready path: an empty due-today set reaches `ok` only after they decline
to fire (a wholly-past fulfilled window, or a mid-window civil date the demand does not name).
Worked person-shifts count as satisfied capacity (`max(present, worked)`), so deploying an
allocated crew — or releasing its allocations after the work — never un-readies the activity.
Satisfaction admits an allocation whose `labourSpecFingerprint` ∈ `acceptableFingerprints` (the
head fingerprint plus every ACTIVE `ApprovedSkillSubstitution` target whose `fromFingerprint`
still equals the head — the T6-F2 rule verbatim), for the head's shift, regardless of the pinned
`originRevision` — the §C compatible-revision carry-forward.

**Forecast truth (§A) — `forecastFor(tx, projectId, requirements)`**: presence never consulted.
Per slice: `max(allocated, worked)` covers → `ready`; else a LIVE commitment
(`status ∈ {committed, revised}`) for the SAME `(civilDate, shift)` slice of an acceptable
fingerprint, with remaining undrawn quantity (per-commitment draw-down via
`WorkerAllocation.capacityCommitmentId`) and a latest arrival promise not after the slice date,
covers the shortfall → `at-risk` dated at the covering promise; else `blocked`. Worst-wins across
slices; the two tables differ ONLY in whether presence is required.

**`deriveTeamReading`** (`apps/api/src/labour/team-readiness.ts`) — the §A Team-gate map, the
sibling of `deriveMaterialReading`, Labour-owned so every import of it is the declared
`activities → labour` read edge: mismatch-first (the labour-mismatch FACT family is Task 5 — every
caller passes `false` now; the parameter fixes the seam so Task 5 changes no signature), `na` on
zero requirements, else worst-wins `fail > wait > ok`. Overrides are layered by the caller
(`GateOverride{gate:'team'}` already existed and is unchanged).

**`activities.start` (§A)** — after the material block, the same shape:
`if (readiness.team.source !== 'override' && isEnabled(projectId, LABOUR_CAPABILITY, tx))
readiness.team = teamReading(tx, projectId, a, today)`. Evaluated in-tx under
`lockProjectReadiness`, so a concurrent allocation/release/attendance/revision/commitment write
lands strictly before (start observes it) or strictly after (it waits). Material × Team compose
worst-gate: material-ok/labour-blocked refuses naming team, and vice versa.

**Gate replacement (§A/F6)** — when `labour` is enabled the stored team flag is neither writable
nor read: `activities.update` rejects a team-flag patch (409), `activities.create` rejects an
explicit non-default value, and a hostile stored 'ok' written beneath the service cannot start an
under-allocated activity (proven). Off-pilot, the stored stub stays byte-identical — writable and
driving `start` exactly as before Phase 4.

**Read-path bake** — `ActivitiesQueryService.bakeInputs` resolves per-activity labour EXECUTION
coverage on a labour-pilot project (undefined off-pilot) and `bakeActivities` derives the team
gate from it exactly like the material bake (`activities-serialize.ts`), with the `gt` display
flag tracking the derived gate under the pilot — live and read agree by the one-function
construction.

**The requirement snapshots** — `loadLabourCoverageRequirements`
(`apps/api/src/activities/labour-coverage-requirements.ts`): Activities reads ITS OWN
`ActivityRequirement` heads (`type='labour'`, open) and routes the Labour-owned detail through the
query contract — `LabourRequirementQuery.detailsFor` (spec + slices) and the NEW
`activeSkillTargets` (active substitution edges) — never a Prisma include (F1 read encapsulation).
Activities passes these snapshots INTO the labour authority (§G): Labour never reads Activities
persistence.

**The SEVENTH rebuildable projection (§G)** — `labour.readiness`
(`apps/api/src/labour/labour-readiness.projection.ts` + the `LabourReadinessProjection` table,
migration `20270301000000_phase4_t4_labour_readiness`, additive, no FKs/triggers/data — legacy
DBs upgrade row-free). Recompute-only forecast truth; its requirements come from the labour-owned
read-model: `foldLabourRequirementHeads` folds the consumed Activities-owned `requirement.*`
event PAYLOADS (each carries the discriminated `type`, head `revision`, `status`, `activityId`
and the complete `labourSpecRef` incl. demand slices) from the platform `DomainEvent` envelope in
stream order — the FIRST payload-sourced read-model in the codebase, and the reason Labour stays a
LEAF. Subscription set: `requirement.*`, `skill_substitution.*`, `capacity.*`, `allocation.*`,
`labour_work.recorded` (attendance events deliberately absent — forecast never consults
presence). Registered as the NINTH ordered consumer (`outbox.bootstrap.ts` +
`bindLabourReadinessDeps`), the SEVENTH `REBUILDABLE_PROJECTIONS` entry, the CLI factory, RUNBOOK
six→seven, and the init delivery pin 32→36 (4 events × 9 consumers). A rebuild emits ZERO domain
events and ZERO notifications. The `labour.readiness` GET (`GET …/projects/:id/labour/readiness`,
`labour.read`, 404 off-pilot) serves the same dto through the ONE shared
`computeLabourReadinessDto` — live == projection == rebuild by construction.

**The LEAF module graph (§G, round 3)** — `labour.consumesEvents` becomes
`['requirement.created','requirement.revised','requirement.cancelled']` (the first non-empty
`consumesEvents` in the registry; validated `unknown-event`/`dangling-consume`; NOT a `dependsOn`
edge). `activities.dependsOn`/`workflowParticipants` already carried `labour` (Task-1 correction
F1); `labour.dependsOn` stays `[]`. The new §G ACCEPTANCE test (`module-registry.test.ts`) pins
the exact labour/activities edge sets + the consumed-events triple, runs Kahn's topological sort
over the LIVE manifests (labour sorts before activities), and proves the RED fixture: substituting
the round-2 cyclic `labour.dependsOn: ['activities','decisions','procurement']` raises `cycle`
and makes the graph unsortable. Reality note: `labour.workflowParticipants` is
`['procurement','activities','orgs']` — the plan's §G table predates the Task-3 `orgs`
participant edge (the t3c revoker-standing channel); the test pins reality.

## 2. Tripwires advanced in the same PR

- §A lock-coverage `SECTION_A_COMMANDS` 29→32 (`labour.commitment.commit/revise/default` — they
  already took the lock in Task 2; the enumeration now pins it).
- `module-registry.test.ts`: read-encapsulated pin 24→25 (`labourReadinessProjection` joins
  `ownsModels` + `readEncapsulated`); the §G acceptance test above.
- `boundary.test.ts`: `activityRequirement` stub delegate + the INVERSE coupling fixture — a
  labour file delegate-reading `ActivityRequirement` yields exactly one `cross-module-read` owned
  by `activities` (the read the payload-sourced read-model must never perform).
- `cross-module-graph.test.ts`: `labourReadinessProjection` in `MODEL_OWNER`;
  `labour/labour-coverage.service.ts` triaged (`domain: labour, foreign: {}, dispatch: 0` — pure
  reads, no events).
- `project-initialization-atomicity` delivery pin `4 × 9 = 36`; the rebuild-audit suites'
  consumer lists gain `labour.readiness` (six→seven).
- `upgrade-proof.sh`: the `LabourReadinessProjection` table exists and is ROW-FREE over the
  legacy DB.
- 48+ shared-DB TRUNCATE lists + `prisma/seed.ts` extended with `LabourReadinessProjection`.

## 3. Reproduce-first tests

`apps/api/test/integration/phase4-t4-labour-readiness.test.ts` — **16/16** live-PG:

1. §D off-pilot: stored team stub writable + drives start; readiness read 404.
2. §A gate replacement: update/create rejected on-pilot; hostile stored 'ok' not read.
3. §A row 3 before-window `wait` + start refused.
4. §A row 4 overdue `fail`; worked past window `ok` (non-vacuous) + start allowed.
5. §A rows 5–7: fail → wait (muster pending, incl. partial muster) → ok → start.
6. Forecast vs execution: allocation alone ready/wait; the GET read agrees.
7. Forecast blocked → at-risk dated at the covering promise (full Task-2 commercial chain) →
   default → blocked.
8. Carry-forward: responsible-only preserves; headcount increase preserves + `1 of 2` shortfall;
   trade revision strands (stale active allocation still holds the worker).
9. Substitution re-satisfies a stranded allocation; revocation ends it.
10. Combined worst-gate: refusal names `team:` then `material:`; both-ok starts.
11. Race release-vs-start, BOTH orderings (deterministic advisory-lock barrier).
12. Race attendance-vs-start, BOTH orderings.
13. Race revision-vs-start, BOTH orderings.
14. Cross-gate: a material requirement command and a labour allocation park in the SAME
    advisory-lock queue and complete in enqueue order.
15. §G projection: live == projection == rebuild; cancel leaves the fold; rebuild emits ZERO
    events + notifications.
16. §G lag: a stale `ready` projection cannot start a stranded activity; the live recompute shows
    `blocked`.

## 4. Gate battery

- `pnpm check` EXIT 0 — automation 31/31, web 432/432, API 678/678 (+ the §G acceptance test,
  the inverse boundary fixture, and the three lock-coverage rows).
- Full integration on a PRISTINE migrated DB: **70 files / 670 tests** (+16 for this suite; the
  two rebuild-audit pins updated six→seven consumers are the only pre-existing tests touched).
- `upgrade-proof.sh` PASSED (all migrations over the legacy fixture; the new projection table
  row-free; every prior Phase-1..Phase-4-T3 forgery rejection surviving).
- `test:e2e:api:allmodules` **31/31** and `:outbox` **25/25** (one `allmodules` run flaked on the
  documented `project-scope` browser-history step — no labour surface — clean on re-run).
- NO change to any deployed migration; ONE new additive migration (`20270301000000`).

## 5. Explicitly NOT in this PR (per the plan)

- Task 5: `LabourMismatch` facts + `labour.resolveMismatch` + the Daily-Log per-worker read +
  `LabourWorkFact` exposure via `LabourQuery.effortFor` + `ActivityWorkOutput` + productivity.
  The mismatch-first `fail` row is seamed (`deriveTeamReading(coverage, mismatchBlocked)`) with
  `false` at every call site until the fact family exists.
- Task 6: the Labour hub, Schedule/DailyLog/Team/Inbox surfaces, `labour-shortage` cards, the
  browser acceptance chain.

## 6. Vision alignment

Phase 4 Task 4 gives the Team gate the same canonical, transactional, lock-protected discipline
the Material gate received in Phase 3 Task 6: command authority reads canonical §C facts under
the ONE project readiness lock (never a projection), execution and forecast truth are split
deterministic first-match tables differing only in presence, the pilot is provably inert
off-capability, Labour stays a LEAF whose requirement truth arrives by consumed event payloads,
and every conclusion a reviewer must trust is either DB-sealed (Tasks 1–3) or reproduced by a
red-first probe in this packet.

## 7. Codex round-1 correction (5 findings on head `09db0a5`)

The exact-head Codex review of `09db0a54b2` raised five P2 findings. Each was reproduced RED at
`09db0a5` by a new probe in `phase4-t4-labour-readiness.test.ts` (the `ROUND-1` block) before the
fix; every prior Task-4 test is retained unchanged. No deployed migration is touched — the ONLY
migration edit is to `20270301000000`, which exists solely on this held PR.

- **F1 — retry-safe migration.** `20270301000000_phase4_t4_labour_readiness` used bare
  `CREATE TABLE` / `CREATE UNIQUE INDEX`, so a crash after the table was created but before
  Prisma recorded the migration left an unrerunnable partial apply. Both statements now carry
  `IF NOT EXISTS`. Probe: every statement of the migration file re-applied verbatim against an
  already-migrated database is a no-op (RED: `relation already exists`).
- **F2 — conserved commitment residuals.** `forecastFor` recomputed each requirement's remaining
  commitment quantity from per-requirement counts, so ONE quantity-1 commitment could mark TWO
  same-slice shortfalls `at-risk`, and a draw-down by one requirement's allocation was invisible
  to every other requirement. Committed person-shifts are now CONSERVED: drawn quantity is
  project-wide (`groupBy` over ALL active allocations naming the commitment), and the undrawn
  remainder is assigned by a deterministic matching — requirement-slices in canonical
  `(activityId, requirementId, civilDate)` order, earliest-promise supplies first, augmenting
  reroutes (a coverable shortfall is never refused while a compatible rearrangement exists, so
  overlapping substitution sets cannot cause false `blocked`), all-or-nothing per slice (a slice
  the pool cannot fully cover consumes nothing). Verdicts are a pure, caller-order-invariant
  function of the facts (§G: live == projection == rebuild). Probe: two one-person shortfalls +
  one quantity-1 commitment → exactly one `at-risk`, one `blocked`; after requirement A's
  allocation draws the commitment, B flips to `blocked` (the draw is spent globally).
- **F3 — present ∪ worked as distinct people.** Execution satisfaction used
  `max(present, worked)`, so a two-person slice covered by one mustered worker plus a DIFFERENT
  worker's delivered work fact read 1-of-2 and blocked the start. `countsFor` now counts the
  UNION of distinct worker ids: `covered = |present ∪ worked|` for §A rows 4–5 (surfaced on
  `LabourSliceCoverageDto.covered`) and `|allocated ∪ worked|` as the sourced quantity for rows
  6–7 and the forecast. Probe: worker A mustered + worker B worked → execution `ok`; releasing
  B after the work keeps the forecast `ready` (one active allocation + one delivered shift).
- **F4 — allocations bound to the head's activity.** Coverage matched allocations by requirement
  id + fingerprint + slice only, so revising a requirement onto a DIFFERENT activity let the new
  activity's Team gate count the crew still FK-pinned to the previous activity. `countsFor` now
  also requires `allocation.activityId === head.activityId` — a moved requirement strands the old
  activity's allocations (and their work facts) exactly like a fingerprint strand; the §C
  carry-forward is unchanged when the activity is unchanged. Probe: allocate + muster on activity
  A, revise the requirement onto activity B → B is `fail` (under-allocated) and forecast
  `blocked`, never `ok` on A's crew.
- **F5 — only drawable commitments forecast.** `forecastFor` admitted
  `status ∈ {committed, revised}`, but the allocation command (and its
  `WorkerAllocation_within_commitment` DB trigger, both cleared in Task 3) draw down ONLY
  `committed` rows — a `revised` commitment was §A cover that could never convert into execution
  capacity. The forecast now reads `status = 'committed'` alone. Probe: `reviseCapacity` flips
  the at-risk slice to `blocked`, and the same-commitment allocation attempt 409s (ground truth
  pinned in the same test).

Correction-round battery (all first-run, no re-kicks): `pnpm check` EXIT 0 (web 432/432, API
678/678); full integration on a PRISTINE migrated DB **70 files / 675 tests** (+5 ROUND-1
probes; zero pre-existing tests modified); `upgrade-proof.sh` PASSED (the guarded migration
applies over the legacy fixture, table row-free); `test:e2e:api:allmodules` **31/31** and
`:outbox` **25/25**.

## 8. Codex round-2 correction (3 findings on the late `38e5c42` review) + the main merge

Codex's timed-out attempt for `38e5c42` landed late with three P2 findings. The gate's exact-head
rule discards stale-head evidence — and its FRESH review of `e8b1c4a` (identical app code)
returned a clean +1 — but the three defects are REAL: each was reproduced RED at `e8b1c4a` (the
`ROUND-2` probes) before fixing, so they do not ride to merge silently. The same push carries the
conflict-bot-directed merge of `origin/main` (PRs #241/#243 — orchestrator scripts only, zero
app code), which was required regardless: the branch was behind and no verdict could merge it.

- **R2-A — only drawable commitments forecast.** `acceptableFingerprints` (head + active
  substitution targets) governed committed-capacity matching, but the allocation command (and
  its DB trigger) draw ONLY the head fingerprint — a substitution widens what an existing
  ALLOCATION may satisfy (§B), never what a commitment can be drawn for. Supply matching now
  uses the new explicit `LabourCoverageRequirement.headFingerprint` (set by both loaders).
  Probe: head revised A→B + a B→A substitution + an A commitment → allocation 400s (ground
  truth) and the forecast is `blocked`, never `at-risk`.
- **R2-B — delivered draws stay consumed.** The project-wide drawn count admitted only
  `status='active'` allocations, so releasing an allocation whose WORK FACT still sources its
  requirement freed the commitment to cover a second shortfall — one delivered supplier
  person-shift counted twice. Drawn now counts allocations that are active OR carry ≥1 work
  fact. Probe distinguishes both sides: a workless release FREES the draw (the allocation
  command may re-draw it — Task-3 semantics preserved, one at-risk + one blocked), while a
  delivered-then-released draw keeps requirement A `ready` (worked guardrail) and requirement B
  `blocked`.
- **R2-C — heads resolve before activity scoping.** `loadLabourCoverageRequirements` filtered by
  `activityId` in SQL before choosing the max revision, so a requirement revised onto a NEW
  activity left its stale revision as an "open head" on the OLD activity — gating A on demand B
  now owns. Heads are now folded PROJECT-WIDE, then scoped by the activity that owns the head.
  Probe: after the move, activity A's Team gate is `na` and B carries the real `fail`.

Correction-round battery (all first-run): `pnpm check` EXIT 0 (automation 52/52, web 432/432,
API 678/678); full integration on a PRISTINE migrated DB **70 files / 678 tests** (+3 ROUND-2
probes); `upgrade-proof.sh` PASSED; `test:e2e:api:allmodules` **31/31** and `:outbox` **25/25**.
NO migration change in this round (`20270301000000` retains only its round-1 guards).
