# Phase 2 Task 9 — Projection Switch-Over + Module-Owned Frontend State (decisions) — Review Packet

**Review stop (first frontend migration — a narrow pattern review).** Task 9 moves the FIRST module's
read path off the full live-join snapshot and onto a **rebuildable projection** served by a
**module-owned query with query-time authz**, paired with the module's **frontend cutover** (a
capability-versioned XOR read-ownership) and a **manifest-driven shell/nav** — the pattern Task 10
repeats for the remaining modules. This packet states the pattern, its enforcement, the
behavior-preservation evidence, and the deliberate scoping decisions flagged for the reviewer.

Branch `claude/phase2-task9-decisions-projection` (from `main` @ the PR #167 merge `693d15f`). One PR.

---

## Vision alignment

One project is one site; a projection is a **rebuildable read model, never a new source of truth** —
its rows are derived from the canonical decisions and dropped/rebuilt at will, so no operational fact
gains a second owner. The decision's canonical owner stays the `decisions` module; the projection is
that module's own denormalized read table. **A projection is never an RBAC bypass:** every read
re-applies the same current-role visibility rule as the live snapshot, so a projection can only ever
show a viewer what the live path would. Attributable human approvals, the DomainEvent history, the
outbox deliveries and receipts are all untouched — the projection is layered additively on top. The
migration is additive and forward-only; tenant isolation stays database-enforced; the read cutover is
capability-versioned so the old path keeps working until the flag flips.

---

## 1. The pattern

**A rebuildable projection, swapped in behind a final activation barrier.** (Step 1, `platform/projections/`)

- `ProjectionGeneration(consumer, projectId, generation, status, appliedPosition, cursorStatus)` — the
  serving read-model instance. A raw-SQL **partial unique index** guarantees **at most one `active`
  generation** per `(consumer, projectId)`; status/cursorStatus CHECKs pin the closed sets.
- The relay's new **`dispatchProjection`** applies each ordered `db` projection delivery into the
  **active generation**, advancing its checkpoint **contiguously** (position N+1 waits for N; a `dead`
  earlier position sets `cursorStatus='blocked'` — visible degradation, never a silent skip). A plain
  ordered `db` consumer keeps the single-`ProjectionCursor` path **unchanged**.
- The **`ProjectionRebuilder`** builds a fresh generation from an optional canonical seed + an event
  replay (no lock), then a **final activation barrier**: per project, hold the `ProjectEventStream`
  lock, read the final position **H**, apply through H, and **atomically** activate the new generation
  (`appliedPosition = H`) + retire the old one **before releasing the lock**. Every event allocated
  afterward is `> H` and — because the new generation is now active — is delivered into it, never the
  retired one. Retired-generation cleanup is **decoupled** from the activation path (`dropRetiredGenerations`).
- **Dedup is per generation on `(consumer, generation, streamPosition)`:** a generation has a **single
  writer at any instant** (the rebuilder while `building`, the relay once `active`; the barrier hands
  off in one transaction), so `appliedPosition` contiguity is exactly-once and an event applied by both
  a rebuild replay and a live relay delivery is idempotent.

**The decisions projection + module-owned query.** (Step 2, `decisions/`)

- `DecisionProjection(generationId, projectId, decisionId, status, publishedAt, authorId, dto)` — the
  module's own generation-scoped read table. The `decisions.inbox` ordered projection consumer refreshes
  each decision's row from the **canonical Decision** on every `decision.*` event (a `noop` for
  non-decision events, so the cursor still advances contiguously), storing the exact `DecisionDto` the
  **one shared serializer** (`decision-serialize.ts`) produces — so the projection row is
  **byte-identical to the live snapshot slice by construction**.
- `DecisionsQueryService.projectionSlice` serves the active generation's rows with the **same
  per-viewer authz filter** as `snapshotSlice` (`decisionVisibleToViewer`); `moduleDecisions` is the
  HTTP read (`GET …/decisions`) with a **live fallback** while the projection warms up.

**The frontend cutover (XOR) + manifest-driven shell/nav.** (Steps 3–5, `apps/web/`)

- A capability flag `VITE_DECISIONS_READ` defaults to **`'snapshot'`** (the snapshot slice owns
  `decisions`, unchanged). In **`'moduleQuery'`** the module read owns `decisions` (**XOR**): it is
  fetched **alongside the snapshot under the SAME scope lease**, so it inherits every coordinator
  ordering guarantee, and `applySnapshotCore` **ignores the snapshot's decision slice** even when a
  mutation response still carries it. Explicit `decisionsLoad`/`decisionsSource` states; a failed
  module read exposes an error boundary and **keeps the last-good decisions** (never blanks, never
  silently falls back to the snapshot slice under XOR).
- `GET …/shell` returns identity + `enabledModules` (the single enablement source) + projection
  counts. Nav is filtered by the enabled modules (`enabledScreensFor` + the `SCREEN_MODULE` map);
  empty `enabledModules` applies no filter, so nav never flashes and the local demo is unchanged.

## 2. The enforcement

- **Model ownership (machine-checked).** `platform` owns `projectionGeneration` (the generic
  framework table); `decisions` owns `decisionProjection` (its module read model) and read-encapsulates
  it. The DMMF-vs-manifest exactness test, the read-encapsulation check, and the cross-module write
  analyzer are all green — the rebuilder is a documented platform writer; the projection is written and
  read **only** within `decisions`.
- **Contract.** `decisions.projectionSlice` joins the shared `DECISION_QUERIES` + the manifest; the
  contract test pins it. The mutating-route inventory is unchanged (both new routes are GETs).

## 3. Behavior preservation + the barrier invariants (all against live PostgreSQL)

| Property | Evidence |
|---|---|
| The projection slice is **byte-identical** to the live snapshot slice, every role | `decisions-projection.test.ts` — `toEqual` across pmc/client/engineer/contractor |
| Query-time authz holds on the projection (pending hidden from non-pmc/client; drafts author-only) | `decisions-projection.test.ts` |
| **live == rebuild**: a rebuild activates a new generation whose slice equals the live one, **checkpoint == H** | `decisions-projection.test.ts` + `projection.test.ts` |
| A **write held exactly at the activation handoff** lands in the NEW generation (`> H`), never the retired one | `projection.test.ts` (barrier hook + a concurrent emit blocked on the stream lock → position H+1) |
| A **concurrent relay-vs-rebuild** leaves the activated generation with **every event exactly once** | `projection.test.ts` (redelivery of any `≤ H` position into the new generation is a `duplicate`) |
| Contiguous exactly-once live apply; a dead earlier position **blocks** the cursor (never skips) | `projection.test.ts` |
| Frontend **XOR**: the module read owns decisions, the snapshot slice is ignored; a failed read retains last-good | `decisions-module-query.test.ts` |
| Frontend **snapshot mode unchanged** (no module fetch, `decisionsLoad` stays idle) + manifest-nav | `decisions-module-query.test.ts` |

| Gate | Result |
|------|--------|
| `pnpm check` (web + api: lint · typecheck · unit · build) | **exit 0** |
| Web unit | **304 passed** |
| API unit (incl. contract + boundary fixtures) | **542 passed** |
| API integration (live PostgreSQL 16) | **261 passed** |
| `test:e2e:api:legacy` (Playwright over compiled API + PG16) | **20/20** |
| `test:e2e:api:outbox` (sealed cutover, relay sole sender) | **20/20** |
| `apps/api/scripts/upgrade-proof.sh` (both new migrations over the legacy fixture) | **PASSED** |

## 4. Deliberate scoping decisions (flagged for the reviewer)

1. **Capability-versioned frontend cutover, default OFF.** `VITE_DECISIONS_READ` defaults to
   `'snapshot'` — the snapshot slice still owns decisions, so all 298 pre-existing web tests are
   unchanged and the flip to `'moduleQuery'` is a config change once proven in production (mirroring the
   Task-6→PR-C outbox `legacy`→`outbox` cutover). The XOR + module path is fully wired and **tested in
   both modes**; the flag is the seam, not dead code.
2. **Contiguity IS the per-generation dedup — no separate `ProjectionApplied` table.** Because a
   generation has a single writer at any instant (rebuilder while `building`, relay once `active`, the
   barrier handing off in one transaction), `appliedPosition` contiguity realizes exactly-once on
   `(consumer, generation, streamPosition)` without a per-position marker table. The held-write and
   relay-vs-rebuild probes prove it directly.
3. **Command-path latency under `moduleQuery`.** A decision mutation's own snapshot response no longer
   updates `s.decisions` (XOR ignores the snapshot slice); the decision surfaces refresh on the
   mutation's `changed` broadcast, which triggers the combined snapshot+decisions pull. This is the
   correct XOR behavior; the residual is a sub-second refresh beat on the proving path (flag default OFF).
4. **The projection refreshes rows from CURRENT canonical state on each event** (rather than from event
   payloads). This makes the projection trivially equivalent to the live slice and a replay idempotent;
   the reads at query time still touch only the projection rows, so the read path is decoupled from the
   write model as the plan requires.
5. **Retired-generation cleanup is decoupled** from the activation transaction (`dropRetiredGenerations`)
   so it can never race a still-committing relay delivery to a just-retired generation; a retired
   generation is already invisible to serving (reads target the active generation's id).

## 5. Done criteria (Task 9)

The first module runs on a rebuildable projection + a module-owned query with query-time authz; the
shell + nav are manifest-driven; read ownership is XOR (capability-versioned, old path intact);
project-switch/stale-response scenarios are green unchanged (the module read rides the snapshot scope
lease); **live == rebuild**, and the activation barrier holds every event **exactly once with
checkpoint == H**. Held as one draft PR for the narrow first-frontend-migration pattern review before
Task 10 repeats the pattern across the remaining modules.
