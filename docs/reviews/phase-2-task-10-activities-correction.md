# Phase 2 Task 10 — Module 4 (Activities) gate CORRECTION — Review Packet

**The Module-4 gate verdict was BLOCKED on ONE architectural finding with three manifestations.**
This is the fix-forward correction, developed from latest `main` @ `5d24d82` (the merged PR #181 —
NOT rolled back) on branch `claude/phase2-task10-activities-correction`, as one focused held PR.
Task-10 finalization (Inbox/Dashboard/Portfolio) remains **not started** per the directive.

| Commit | Increment |
|---|---|
| `ac06b4b` | reproduce-first probes (red at `5d24d82`) + the owner-aligned participants + service wiring |
| `33a5948` | manifest edges, registry/contract pins, readiness-lock classification, the SET NULL coverage table |
| `f224a91` | the idempotent `projection:rebuild` operator command + live diagnostics |
| `9552539` | docs truth (CLAUDE.md + ROADMAP Phase-2 status) + the coverage reseal runbook |
| _(final)_ | e2e-gate fallout (create-schema nullable refs + spec robustness — see below) + this packet |

---

## The finding (owner-aligned invariant, FK side channel)

**Every canonical fact serialized into a module projection must produce an owner-aligned signal when
a foreign command changes that fact — including changes performed by `ON DELETE SET NULL`.**

Three projected columns mutated ONLY through the database FK action, with no owner event:

| Projected column | Deleting command | Pre-correction path | Consumer that went stale |
|---|---|---|---|
| `Drawing.activityId` | `activities.remove` | `Activity` delete → FK nulls the link; `activity.deleted` is a NOOP for drawings | `drawings.inbox` |
| `Drawing.nodeId` | `nodes.remove` | `ProjectNode` delete → FK nulls the filing; `node.removed` is a NOOP for drawings | `drawings.inbox` |
| `SiteMaterial.nodeId` | `nodes.remove` | `ProjectNode` delete → FK nulls the staging place; `node.removed` is a NOOP for daily-log | `daily-log.inbox` |

The staleness mechanics (pinned red by the probes): while the noop delivery is still pending the
generation is non-current and the module query correctly FALLS BACK TO LIVE — so the defect hides.
After the relay drains, the ordered cursor has advanced past the noop, `readServableGeneration`
reports CURRENT, and the base row serves the deleted reference. Silent, indefinite staleness.

## The correction (same shape as the Module-3 lesson, now closing the FK side channel)

- **`DrawingParticipant`** (`apps/api/src/drawings/drawing.participant.ts`, leaf provider):
  `unlinkFromDeletedActivity` and `unfileForDeletedNodes` perform the explicit `updateMany` on the
  DELETING command's transaction BEFORE the owning delete and append `drawing.activity_unlinked` /
  `drawing.unfiled` ONLY when rows actually changed.
- **`DailyLogParticipant`** (`apps/api/src/daily-log/daily-log.participant.ts`):
  `unfileMaterialsForDeletedNodes` explicitly nulls `SiteMaterial.nodeId` for the deleted subtree and
  appends `material.unfiled` when rows changed.
- **`ActivitiesService.remove`** invokes the drawing unlink and **`NodesService.remove`** invokes the
  drawing + daily-log unfiles inside their EXISTING transactions (alongside the Module-3/4
  inspection/activity participants); the extra events dispatch post-commit with the command's events.
- The `ON DELETE SET NULL` FKs are **kept as database backstops** — no schema/migration change; the
  participant update simply reaches the rows first.
- **No consumer changes needed**: `drawings.inbox` dispatches on the `drawing.` prefix and
  `daily-log.inbox` on `dailylog.`/`material.`, so the new signals refresh the bases automatically.
- All three events are **signal-only** in the external-effect catalog (`invalidate: true, push: null`)
  and declared in `DOMAIN_EVENT_TYPES`, the owning manifests' `producesEvents`, and the
  workflow-participant edges (`activities → drawings`; `nodes → drawings, daily-log`), with the
  registry/contract pins updated to exactly these lists.

## Reproduce-first evidence (red at `5d24d82` → green)

`apps/api/test/integration/set-null-owner-signals.test.ts` — four live-PostgreSQL probes, each
asserting the full lifecycle: canonical null after the delete → **before relay drain** the module
query serves `source: 'live'` (fallback correct) → **after full drain** the generation must be
CURRENT **and** the projection-served DTO must equal live (deep equality, signed URLs stripped):

1. Activity delete → `Drawing.activityId` (drawings register, projection + live).
2. Node delete → `Drawing.nodeId`.
3. Node delete → `SiteMaterial.nodeId` (daily-log slice + snapshot slice).
4. Two-project isolation: project A's delete never touches B's generations (B's projection row
   `updatedAt` + DTO byte-identical; both generations still 1).

**RED at `5d24d82`** (fix reverted, same harness): all 4 fail with exactly the predicted staleness —
`expected 'ACT-001' to be null`, `expected '<nodeId>' to be undefined` — generation CURRENT, base
stale. **GREEN with the correction**: 4/4 pass.

## The SET NULL coverage table (exhaustive, database-derived)

`apps/api/test/integration/set-null-coverage.test.ts` discovers every `(table, column)` pair an
`ON DELETE SET NULL` action can silently null from **`pg_constraint`** (`confdeltype='n'`,
respecting PostgreSQL 15+ column-list actions via `confdelsetcols`) and requires EXACT equality with
a classification map — a new SET NULL FK, or widening an existing one, fails the tripwire until a
reviewer classifies it. The live constraint surface (8 columns) and its classification:

| Column | Classification |
|---|---|
| `Activity.nodeId` | signal `activity.unfiled` — `ActivityParticipant.unfileForDeletedNodes` (Module 4, already merged) |
| `Inspection.nodeId` | signal `inspection.unfiled` — `InspectionParticipant.unfileForDeletedNodes` (Module 3, already merged) |
| `Drawing.nodeId` | signal `drawing.unfiled` — `DrawingParticipant.unfileForDeletedNodes` (**this correction**) |
| `Drawing.activityId` | signal `drawing.activity_unlinked` — `DrawingParticipant.unlinkFromDeletedActivity` (**this correction**) |
| `SiteMaterial.nodeId` | signal `material.unfiled` — `DailyLogParticipant.unfileMaterialsForDeletedNodes` (**this correction**) |
| `Media.nodeId` | exempt — no module projection serializes it; the snapshot photo layer is a LIVE read |
| `Activity.phaseId` | exempt — Phase and Activity share the activities module; `phase.removed` (the OWNER's own event) refreshes the whole per-project base before the cursor advances |
| `SecurityAuditEvent.actorUserId` | exempt — global append-only security log (auth), never projected; discovered by the tripwire, classified explicitly |
| _(any)_ `projectId` | a dedicated assertion proves NO SET NULL action can null a tenant column (the composite FKs use column-list actions) |

Each signal classification is further asserted to be a real `DOMAIN_EVENT_TYPES` member declared in
the owning module's `producesEvents`.

## Historical repair — the idempotent operator rebuild

Signals fix staleness going FORWARD; a delivery that already recorded a noop is behind the cursor and
no replay revisits it, so pre-correction generations may still serve stale references.

`pnpm --filter api projection:rebuild --operator <identity> --reason <text> [--project <id>]
[--consumer <name>]` (`apps/api/src/platform/projections/projection-rebuild.cli.ts`) rebuilds
`drawings.inbox` + `daily-log.inbox` from canonical for every project (default) through the standard
generation-swap + final-activation-barrier protocol, records per-(project, consumer) BEFORE/AFTER
diagnostics — the serving generation and whether its stored base equals the base recomputed through
the module's own canonical serializer — exits non-zero on any AFTER mismatch, and audits each
invocation as an `OutboxOperatorAction` (`projection.rebuild`). Live-PostgreSQL demonstration
(seeded project with an activity-linked + node-filed drawing and a node-staged material):

| Run | Condition | staleBefore | mismatchesAfter |
|---|---|---|---|
| 1 | fresh state, first generations | 0 | 0 |
| — | FK-only activity + node deletes (the pre-correction write pattern) null all three canonical columns | | |
| 2 | **both consumers' generation 1 detected STALE (`before.match: false`), rebuilt to generation 2** | 2 | **0** |
| 3 | re-run (idempotency) | 0 | 0 |

## External-effect coverage reseal (verified)

This correction changes `effectCoverageVersion()` (three new signal-only entries), so a production
process in `OUTBOX_SENDER_MODE=outbox` must be resealed. The runbook is now in `docs/ROADMAP.md` and
was executed against live PostgreSQL: `outbox:status` (0 pending / 0 dead) → `outbox:seal-external`
in legacy/shadow mode → sealed at coverage
`8dc75364055bd7259c9b95ad4edd234eddb8d15ce6c91332b7fac9caf012e029`, byte-equal to the recomputed
`effectCoverageVersion()`; the outbox-mode e2e gate below then boots against exactly this seal.

## Readiness-lock classification (tripwire-driven)

The file-level readiness coverage tripwire auto-flagged the new `drawing.participant.ts` (it writes
`drawing` rows, a readiness-input table). Classified exempt with the reviewable reason:
`unlinkFromDeletedActivity` touches only drawings of the activity DELETED in the same transaction
(no surviving activity's drawing gate can observe the unlink), and `unfileForDeletedNodes` writes
`Drawing.nodeId`, which is not a readiness input.

## Vision alignment

One fact has one canonical owner: the drawing's governed-activity link and filing place, and the
material's staging place, are drawing-/material-owned facts — this correction makes their EVERY
mutation flow through the owning module's participant with an owner-aligned event, closing the one
side channel (the FK action) that bypassed the owner. Projections remain rebuildable read models,
never sources of truth — the operator command rebuilds them from canonical at will, and the repair
is diagnosed against the module's own serializer, not a parallel read path. No migration; the FKs
stay as tenant-isolation + integrity backstops; attributable human records (operator identity +
reason on every rebuild/seal) are preserved. No user flow changes: deletes behave identically —
their consequences just become visible to the ordered cursors.

## E2e-gate fallout (two additional fixes, both attributed to `5d24d82`, not to this correction)

Running the activities module-read e2e variants for this correction's gate surfaced two defects that
ALSO reproduce at merged main `5d24d82` verbatim (proven by running the identical suite against a
`5d24d82` checkout in this environment before touching anything):

1. **A PR #181 contract defect — planning an activity from the UI without a phase/decision/location
   was a 400.** The web contract (`NewActivityInput`) declares `phaseId/decisionId/nodeId?: string |
   null` and the plan-activity modal sends explicit `null` for unset links; the API's
   `createActivitySchema` used bare `.optional()`, which REJECTS null — so the create POST failed
   validation (network-diagnosed: `RESP 400 POST /projects/ambli/activities`). The UPDATE schema
   already accepted null explicitly ("null clears the link"), and `ActivitiesService.create` already
   normalizes with `?? null` — only the create schema disagreed with its own module's convention.
   Fix: the three reference fields are now `.nullable().optional()` in `createActivitySchema`
   (validation-layer only; no service/DB change). PR #181's packet had deferred these two e2e
   variants to CI, which is how the modal's command path escaped end-to-end exercise.
2. **A spec robustness gap in `activities-module-query.spec.ts`** — the project-switcher dance
   clicked the dropdown option as a single-shot sequence; on this slower container a post-sign-in
   re-render closes the just-opened dropdown and the option never reappears (timeout at the same
   line at `5d24d82`). The spec now waits for hydration (a real project name in the switcher) and
   retries open-and-pick as one `expect(...).toPass()` unit. Test-only.

With both fixes, `test:e2e:api:activities` and `test:e2e:api:activities:outbox` pass **22/22** each
(one more passing test than the base modes — the module-query spec itself).

## Deliberate scoping (flagged for the reviewer)

- `Media.nodeId` gets NO signal event: no module projection serializes it (the snapshot photo layer
  re-reads live per request). The coverage tripwire pins this so it cannot silently change.
- The unit-test factories stub the new participants with `null` returns (no linked/filed rows in
  those scenarios); the real transactional behavior is exercised by the live-PG probes.
- The set-null-owner-signals harness fixes from the red run (the `crewRow` model name, the required
  `swatch` field on addMaterial) apply identically at both SHAs — the red/green comparison used the
  SAME corrected harness with only the two service files reverted to `5d24d82`.
- One integration test failed on the first full-battery run and passed on two consecutive full
  reruns (42 files / 361 tests green twice); the suite contains timing-sensitive live-PG race
  probes. No product code changed between those runs.

## Verification (all green)

| Gate | Result |
|---|---|
| Focused probes at `5d24d82` (fix reverted, same harness) | RED — 4/4 fail with the staleness signature |
| `set-null-owner-signals.test.ts` (with fix) | 4/4 green |
| `set-null-coverage.test.ts` (live `pg_constraint` tripwire) | 3/3 green |
| `pnpm check` (web lint/typecheck/test/build + shared build + api typecheck/test/build) | exit 0 (574 API unit / 396 web unit) |
| Full live-PG integration (`vitest.integration.config.ts`) | 42 files / 361 tests green (×2 consecutive runs) |
| `scripts/upgrade-proof.sh` | PASSED |
| `scripts/inspections-owned-facts-abort-proof.sh` | PASSED |
| `scripts/inspection-evidence-tenant-fk-abort-proof.sh` | PASSED |
| `projection:rebuild` live demonstration | stale generations detected + repaired, 0 mismatches, idempotent |
| Coverage reseal procedure | sealed `8dc75364…` == recomputed `effectCoverageVersion()` |
| `test:e2e:api:legacy` | 21 passed / 5 skipped |
| `test:e2e:api:outbox` | 21 passed / 5 skipped |
| `test:e2e:api:activities` (module read, legacy) | 22 passed / 4 skipped (after the two `5d24d82`-attributed fixes above) |
| `test:e2e:api:activities:outbox` (module read, outbox) | 22 passed / 4 skipped |
| Full API unit suite after the create-schema fix | 574 passed (52 files) |
