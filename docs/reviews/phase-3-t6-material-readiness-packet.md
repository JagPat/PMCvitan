# Phase 3 Task 6 — canonical material readiness review packet

**One focused HELD PR.** Base: `main` @ `dfd1c0a` (the merged PR #201 head — Phase 3 Tasks 4–5
independently CLEARED at this commit). Branch: `claude/phase3-task6-readiness`. Delivers Task 6
of the cleared plan (`docs/superpowers/plans/2026-07-20-phase-3-material-readiness.md` §6); does
NOT begin Task 7 and does NOT reopen Tasks 4–5.

## Vision-alignment statement

The Material readiness gate is the third construction pillar (design §3): every site activity
carries four readiness gates — Decision · **Material** · Team · Inspection — and an activity must
not start until its gate reads green. Before Task 6 the Material gate for a pilot activity was a
STORED value with no canonical derivation; this task makes it a **derived** verdict computed from
the inventory/procurement facts the earlier tasks made canonical (reserved stock, issued custody,
and confirmed delivery commitments) — a fact has one canonical owner, and readiness now reads that
owner rather than a hand-set flag. The pilot capability gate keeps this inert for non-pilot
projects (design §D): one project is one site, and a project that has not opted into the material
pilot uses its stored gate untouched — `coverageFor` is never consulted, byte-for-byte the
pre-Task-6 behaviour. Attributable human authority is preserved: a `pmc` override still wins over
any derived reading, and material substitutions are an explicit `pmc`-authored `ApprovedSubstitution`
(revoked by stamping, never deleting). The UI readiness projection is a pure read model — a
rebuild recomputes it from canonical facts and emits **zero** domain events and **zero**
notifications, so a lagging or rebuilt projection can never change what `activities.start` decides.

## What Task 6 delivers (plan §6)

1. **Canonical coverage authority** — `InventoryService.coverageFor(tx, projectId, requirements)`
   (`apps/api/src/inventory/inventory.service.ts`, types in `apps/api/src/inventory/coverage.ts`).
   For each head material requirement it folds the §C ledger under the stock key and returns
   `ready | at-risk | blocked`: covered = **reserved-for-this-activity** stock of a satisfying
   fingerprint **plus issued custody** (the guardrail — issuing reserved stock must never un-ready
   an activity); a shortfall covered by a confirmed delivery commitment is `at-risk`; an
   uncovered shortfall with no commitment is `blocked`. §B satisfaction admits the requirement's
   own `specFingerprint` **or** an ACTIVE `ApprovedSubstitution` target
   (`ProcurementParticipant.coveringCommitments` supplies the commitment side via a LATERAL join
   over issued/partially-received/completed PO versions).

2. **`activities.start` reads coverage in-tx under `lockProjectReadiness`** — the §A worst-wins
   mapping `ready→ok · at-risk→wait · blocked→fail · not-required→na`, an unresolved stored
   mismatch (`gateMaterial==='fail'`) evaluated FIRST (mismatch-first), and a `pmc` override
   unchanged (`readiness.material.source==='override'` skips coverage entirely). The ONE mapping
   function `deriveMaterialReading(coverage, mismatchBlocked)`
   (`apps/api/src/activities/material-readiness.ts`) is shared by start (authority), the read-path
   bake, and the projection consumer — so live == projection == rebuild by construction.

3. **`ApprovedSubstitution`** (`substitutions.service.ts` + `substitutions.controller.ts`,
   `substitution.manage` = `['pmc']`): `approve` server-computes the target fingerprint and
   resolves the requirement's own fingerprint from the head revision; `revoke` is terminal
   (FOR UPDATE, append-in-place stamp). Both take `lockProjectReadiness` and emit
   `substitution.approved` / `substitution.revoked`. Migration
   `20270101000000_phase3_t6_substitutions` adds the table + an immutability trigger
   (delete forbidden, identity columns frozen, only a single complete revocation stamp allowed).

4. **The SIXTH rebuildable projection** — `activities.material-readiness`
   (`material-readiness.projection.ts`): a recompute-only UI read model
   (`MaterialReadinessProjection`, migration `20270102000000_phase3_t6_readiness_projection`),
   registered as the sixth `REBUILDABLE_PROJECTIONS` entry
   (`platform/projections/rebuild-operations.ts`) and an ordered outbox consumer reacting to the
   readiness event set. **§G: it derives NO domain events** — a rebuild recomputes and swaps the
   generation and nothing else. `docs/RUNBOOK.md` updated FIVE → SIX production projections in the
   same PR.

## §A lock-coverage — command enumeration (tripwire extension)

`apps/api/src/common/readiness-lock-coverage.test.ts` gains a COMMAND-LEVEL enumeration
(`SECTION_A_COMMANDS`, **20 commands** across activities/procurement/inventory/daily-log): each
entry extracts the named method body and asserts it takes `lockProjectReadiness`. This closes the
prior file-level tripwire's honest gap (an uncovered NEW command in a file that locks elsewhere is
now a failing test). `purchase-orders.service.ts#defaultDelivery` was the one §A writer missing the
lock — corrected here. **24/24** in the API unit suite.

## Acceptance evidence (reproduce-first, live PG)

`phase3-t6-readiness.test.ts` — **8/8** — the §A mapping end-to-end: `na` (no requirement),
`blocked→fail` (no stock, no commitment), `at-risk→wait` (shortfall covered only by a commitment),
`ready→ok` (reserved ≥ required), the **ISSUED-counts-as-coverage guardrail** (issuing the reserved
stock keeps the activity startable), **mismatch-first** (an unresolved site mismatch is `fail` even
with full coverage), **substitution** (a different-spec stock covers only while an active
substitution exists), and **§D inertness** (a non-pilot project uses the STORED gate — coverage is
never consulted).

`phase3-t6-start-races.test.ts` — **5/5** — ALL §A both-ordering races vs `activities.start`:
reservation release, audited stock adjustment, requirement revision, substitution revocation, and
issue (issued stock still counts — never un-readies). Each proves the two commands serialize on the
per-project advisory lock and the start verdict follows the committed canonical state in both
orderings.

`phase3-t6-projection.test.ts` — **3/3** — **live == projection** (relay-applied projection equals
the canonical §A recompute); **live == projection == rebuild, and a rebuild emits ZERO domain
events + ZERO notifications**; and **projection lag NEVER changes a start verdict** (a stale `ready`
projection cannot start a now-`blocked` activity — start reads canonical under the lock, not the
read model).

## §10 — upgrade / rebuild evidence

- `projection-rebuild-operations.test.ts` and `projection-rebuild-upgrade.test.ts` extended
  FIVE → SIX consumers; the sixth (`activities.material-readiness`) participates in the
  checkpoint-aware operator rebuild and the legacy-generation upgrade-path probe pattern (a
  caught-up/lagging/rebuilt generation is classified correctly and the default operator run
  rebuilds it with no derived event).
- `apps/api/scripts/upgrade-proof.sh` — **UPGRADE PROOF PASSED** — both Task-6 migrations
  (`20270101…` substitutions, `20270102…` readiness projection) apply over the representative
  pre-Phase-1 legacy fixture, wrote NO rows (pure additive capability), and every earlier legacy
  meaning (Tasks 1–5 constraints, the F1–F4 forgery rejections) survives verbatim.

## Gates (actual exit codes)

- `pnpm check` — **EXIT 0** (API unit **629/629** / 55 files; web unit **396/396** / 37 files).
- Full live-PG integration battery — **EXIT 0, 485/485 across 54 files** (adds the 16 Task-6
  integration tests: readiness 8 + races 5 + projection 3).
- `scripts/upgrade-proof.sh` — **EXIT 0, UPGRADE PROOF PASSED**.
- `test:e2e:api:allmodules` — **27/27, EXIT 0**; `test:e2e:api:allmodules:outbox` — **27/27, EXIT 0**
  (the outbox path drains the relay, so the eighth consumer's delivery materialization is exercised
  end-to-end).

### Integration-harness note (Task-6-attributable, mechanical)

`ApprovedSubstitution` FK-references `ActivityRequirementRoot`, which the Phase-3 suites and the
destructive seed TRUNCATE in cleanup. PostgreSQL refuses to truncate a parent still referenced by
an unlisted child, so the new table was added to the seven pre-existing Phase-3 TRUNCATE lists
(`test/integration/phase3-*.test.ts`) and both seed wipe statements (`prisma/seed.ts`) — the three
new t6 suites already listed it. Separately, the sixth projection registers
`activities.material-readiness` as the EIGHTH ordered outbox consumer, so project-initialization's
four events now yield 4×8 = 32 deliveries (was 28): `project-initialization-atomicity.test.ts`
updated. These are test/seed-harness corrections only — no production code changed for them.

## Scope / non-goals

Delivers Task 6 only. No frontend surfaces / pilot Inbox actions (Task 7). No change to Tasks 4–5
production code or constraints. Files: schema + 2 additive migrations; `inventory/coverage.ts`,
`inventory.service.ts#coverageFor`; `procurement.participant.ts#coveringCommitments`,
`purchase-orders.service.ts` (defaultDelivery lock); `activities/{substitutions.service,
substitutions.controller, material-readiness, coverage-requirements, material-readiness.projection}.ts`,
`activities.service.ts` (start integration); `platform/{capabilities.service, external-effects,
outbox/outbox.bootstrap, projections/rebuild-operations, projections/projection-rebuild.cli}.ts`;
`contracts.ts`; shared `platform/events.ts` + `domain/policy.ts`; tests + `docs/RUNBOOK.md`.

## Review protocol

HELD draft PR from `main` @ `dfd1c0a`. **STOP for the independent review at the plan's post-Task-6
review boundary.** Do not begin Task 7.
