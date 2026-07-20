# Phase 2 — Platform Modularization — CONSOLIDATED Review Packet (final Phase-2 review stop)

Phase 2 gave the existing modules explicit ownership, typed command/query contracts, a canonical
audit + `DomainEvent` envelope with gap-safe per-project ordering, a command-idempotency ledger, a
durable per-consumer transactional outbox with a single lease-coordinated external sender behind an
audited coverage seal, rebuildable generation-swapped projections with a final activation barrier,
five extracted modules behind read-encapsulated persistence, module-owned frontend queries under
XOR read-ownership — and, in this finalization, the three cross-cutting surfaces proven end-to-end
over the module contracts, the hardened operator repair path, and the production cutover runbook.
No user flow changed. The application remains one deployable modular monolith.

**Branch:** `claude/phase2-task10-finalize` (from `main` @ `2c4d4ee`), merged as PR #183 @ `main`
`c94aee3`. The final independent review returned **BLOCKED narrowly** with ONE production
upgrade-path finding (P1); its focused fix-forward correction is §10 (branch
`claude/phase2-finalize-correction` from `main` @ `c94aee3`). **This packet is the evidence record
for the final independent Phase-2 review.**

## 1. Immutable SHA record

### Merged Phase-2 PRs (all independently reviewed and cleared)

| Increment | PR(s) | Merge SHA of the last round |
|---|---|---|
| Task 1 — characterization + dependency matrix + command inventory (+ correction) | #146–#150 era (Task-1 packet) | recorded in `phase2-projection-matrix.md` |
| Tasks 2–7 — shared package, audit attribution, event envelope, ledger, outbox (+ Task 6/7 fix-forward #161) | #151–#161 | `0b8ce6e` (#161) |
| PR B — durable outbox hardening + correction | #162, #163, #164 | `be2d8f6` (#164) |
| PR C — external-effect catalog, single sender, cutover seal, boundary enforcement, dual-mode acceptance | #165, #166 | `7095a48` (#166) |
| Task 8 — decisions command/query contract | #167 | `693d15f` |
| Task 9 — projections + generation swap + activation barrier + module-owned decisions read | #168 | `70b224e` |
| Task 10 Module 1 — daily-log (+ corrections) | #169, #170–#173 | `1bf4719` (#173) |
| Task 10 Module 2 — drawings (+ corrections) | #174, #175–#177 | `3a1cbf3` (#177) |
| Task 10 Module 3 — inspections (+ owned-facts corrections) | #178, #179–#180 | `161e574` (#180) |
| Task 10 Module 4 — activities | #181 | `5d24d82` |
| Module-4 gate correction — ON DELETE SET NULL owner signals | #182 | `2c4d4ee` |
| Task 10 finalization — cross-cutting surfaces + operator hardening + runbook + this packet | #183 | `c94aee3` |

### The #183 finalization commits (merged @ `c94aee3`)

| Commit | Increment |
|---|---|
| `6319fe6` | checkpoint-aware, attributable operator rebuild (`ProjectionRebuildOperations`) + deterministic live-PG concurrent-write coverage |
| `704b2cf` | decisions servability discipline + shell live-fallback + weightless-draft `countPending` + `test:e2e:api:allmodules(:outbox)` + `cross-cutting-surfaces.spec.ts` + `docs/RUNBOOK.md` + docs truth |
| `92973aa` | decisions projection completeness (full-refresh consumer + hollow-generation guard) + switcher spec hardening |
| `f12c515` | this packet (consolidated for the final review stop) |

### The final-review P1 correction (this PR — §10)

| Commit | Increment |
|---|---|
| `6e4d105` | all-five operator rebuild registry + decisions row-set diagnostic + reproduce-first upgrade probe (RED @ `c94aee3`) + state coverage |
| _(final)_ | RUNBOOK all-five rebuild step + this packet section |

## 2. Migration record (additive, forward-only; checksums from `_prisma_migrations`)

| Migration | SHA-256 checksum |
|---|---|
| `20261015000000_phase2_event_envelope` | `8f9570720b49060763f73caf4876dc7b5fec1709a5b536993ae0aa47c231e700` |
| `20261016000000_phase2_command_ledger` | `810df5119395216442444143175129f3ce8225f2fb0ba9a5c7982e895270229d` |
| `20261020000000_phase2_outbox` | `a1dc76cab41e5fbd9d033e0c03aba81687b4a6d9015dbf445d3801f4591ffb16` |
| `20261025000000_phase2_module_boundaries` | `99dfdc6f0bd36cd15d37172b036828080201767b5f9715c255bdbc3ce6c16c0b` |
| `20261026000000_phase2_outbox_reliability` | `dd32382334684d81a8ae66e171112f7c16169605db247579d13ca99c8bad6e67` |
| `20261027000000_phase2_outbox_cutover_seal` | `255e36d7fe27e192173190ee5318b64b6049587c9575fb8d6f29e1042a5433b7` |
| `20261101000000_phase2_projection_generations` | `22cd2ab5635190d410ace2c3a2bd3114fe376d43ff04464adf10e48c556da278` |
| `20261102000000_phase2_decision_projection` | `c343d5cbef81aa1a6321e091b5617af4c2bd77cf16c8db3430b7a7b4bf2fb29c` |
| `20261103000000_phase2_daily_log_projection` | `3c62690c67e3d6739c8f63aab41ed16079c3312959bb87afe398a4acca688872` |
| `20261104000000_phase2_drawings_projection` | `1520e28fe46f64d4b96e560c7a606ed57cbd936808df819ec484a32f38614e3a` |
| `20261110000000_phase2_inspections_projection` | `9f19ea32dfc5af3a54782ed82df1e614481fba745f91590d5d77259374639201` |
| `20261120000000_phase2_inspections_owned_facts` | `601eb0152812ca0bc18f553c54fa927f0e5254910088be342c46f5476af92047` |
| `20261125000000_phase2_inspection_evidence_tenant_fk` | `e2fc12c99d002d5979b260b3bccaa4bc24660a8afcde1e1a83466d26c399f8e3` |
| `20261130000000_phase2_activities_projection` | `b2c269dde10460bca05786dfbb2666f16281d0fe811a76cfc905dfeecd43fc4f` |

This finalization adds **no migration**. `scripts/upgrade-proof.sh` (green below) migrates a
representative legacy fixture through the full chain and asserts legacy meaning survives; the two
abort-proof scripts prove the diagnostic migrations refuse un-repairable fixtures.

## 3. The three cross-cutting surfaces (the Task-10 done criterion)

They are NOT separate cross-module projection bases — a base serializing foreign-owned facts is
exactly the silently-stale class the Module-3/4 correction rounds eliminated. Each surface COMPOSES
module-owned reads, each of which serves from its module's rebuildable projection when the
generation is SERVABLE (healthy + caught-up + materialized) and from the byte-identical live slice
otherwise:

- **Inbox ("For You") + Dashboard** compose CLIENT-SIDE over the module-read-fed store slices —
  the plan's "module-owned frontend query boundaries replacing the single store + full snapshot".
  Under `test:e2e:api:allmodules(:outbox)` every one of the five module GETs serves the session
  (request-level pin), and the pending-decisions figure agrees byte-for-byte across the decisions
  module read, the Inbox action item and the Dashboard tile (`cross-cutting-surfaces.spec.ts`).
- **Portfolio** composes SERVER-SIDE over the module query contracts —
  `activities.statusCounts` + `inspections.openInspectionCount` + RBAC-gated
  `decisions.countPending` (`orgs.service.ts`); the boundary analyzer forbids any direct
  cross-module ORM read (no read waivers exist), and the e2e pins the per-card pending stat equal
  to the module-read count.
- The only Dashboard input outside module contracts is the **photos tile** (Media) — platform-owned,
  live-read by design (no module projection serializes Media; the standing exemption from the
  SET NULL coverage table).

**Finalization findings fixed (each attributed to `main` @ `2c4d4ee` by running the identical suite
there first):**

1. **Decisions projection INCOMPLETENESS** — the Task-9 consumer refreshed only the event's
   decision, so a generation lazily bootstrapped over pre-stream rows served a partial register as
   complete (observed at base: the Decision Log rendered 2 decisions; seeded `DL-014` hidden). The
   consumer now full-refreshes the project's decision set on every applied event.
2. **Decisions projection HOLLOWNESS** — noop deliveries advance the checkpoint, so a generation
   bootstrapped purely by foreign events became servable with zero rows (observed at base under
   all-modules: the module read served an empty register while seeded decisions existed). The read
   now cross-checks canonical existence when the projection is empty and falls back to live.
3. **Decisions currency discipline** — `projectionSlice` used a plain active-generation lookup; it
   now applies the same `readServableGeneration` gating as the other four modules, and the shell
   summary count moved onto the projection-or-live `moduleDecisions` read so lag can never zero it.
4. **Weightless-draft violation in Portfolio** — `countPending` counted author-private DRAFTS
   (status pending, unpublished), leaking a private draft into every PMC/client member's portfolio
   card while shell/dashboard/inbox all excluded it. It now counts published pending only.

## 4. Operator hardening (the three directive items)

`ProjectionRebuildOperations` (`apps/api/src/platform/projections/rebuild-operations.ts`; the CLI
only parses args):

- **Checkpoint-aware diagnostics, race-free** — each (project, consumer) diagnosis runs in one
  transaction holding the project's `ProjectEventStream` lock (the row every event allocation
  locks), so the head is frozen while the stored base is compared against the module's own
  canonical serializer. States: `none | blocked | lagging | current-match | corrupt`.
- **Post-barrier lag is never corruption** — a checkpoint trailing the committed head means the
  read path is already refusing the generation and serving live; only a generation the read path
  WOULD serve whose base contradicts canonical is `corrupt`.
- **Deterministic live-PG concurrent-write test**
  (`test/integration/projection-rebuild-operations.test.ts`, 4 probes): lag reported as lag with a
  provably stale base while the read serves live; a served contradiction repaired by one run; a
  write held at the activation barrier (the test-only `barrierHook` fires while the stream lock is
  held) provably lands > H, reads as lag, drains to `current-match` with live == projection; an
  injected per-pair failure recorded without aborting the rest.
- **Attributable partial runs** — the invocation is audited (`OutboxOperatorAction`,
  `projection.rebuild`) BEFORE any work; every (project, consumer) attempt records its own
  `projection.rebuild.result` outcome row (resulting generation + state, or the error).

## 5. Production runbook

[`docs/RUNBOOK.md`](../RUNBOOK.md) — the gated cutover: **drain all old instances → deploy in
legacy/shadow sender mode → `projection:rebuild` for all projects and both rebuildable consumers →
inspect the checkpoint-aware diagnostics (`ok: true`; `lagging` is healthy) → `outbox:status`
(0 dead / 0 blocked) → `outbox:seal-external` with operator identity + reason →
`OUTBOX_SENDER_MODE=outbox` → restart → verify health + projection readiness.** Every step is
audited (`OutboxOperatorAction`); staying in legacy/shadow is always safe.

## 6. live == projection == rebuild (explicit evidence)

- **Per module** (live-PG suites, all green in this battery): `decisions-projection.test.ts`,
  `daily-log` / `drawings` / `inspections` / `activities` projection + idempotency suites — each
  proves the module read served from a current generation equals the live slice byte-for-byte and
  that a REBUILD from canonical reproduces it (generation-swap + activation barrier), including
  under the barrier-held concurrent write and two-project isolation.
- **Owner-aligned signals** (`set-null-owner-signals.test.ts`) — every foreign mutation of a
  projected canonical fact (including `ON DELETE SET NULL`) reaches the owning cursor; after drain,
  generation CURRENT and projection == live.
- **Coverage exhaustiveness** (`set-null-coverage.test.ts`) — every silently-nullable column
  classified against live `pg_constraint`; no SET NULL action can null a tenant column.
- **Operator repair** (`projection-rebuild-operations.test.ts` + the Module-4 correction's live
  demonstration) — corrupt/stale generations detected only when SERVED, repaired to
  `current-match`, idempotent re-runs, lag drains clean with the concurrent write included.
- **Cross-cutting** (`cross-cutting-surfaces.spec.ts` under all-modules ×2 sender modes) — the
  composed surfaces agree with the module-read-served counts end-to-end in a real browser.

## 7. Verification (all green; CI on the finalization PR is the recorded link)

| Gate | Result |
|---|---|
| `pnpm check` (web lint/typecheck/test/build + shared build + api typecheck/test/build) | exit 0 (574 API unit / 396 web unit) |
| Full live-PG integration | **43 files / 365 tests** |
| `scripts/upgrade-proof.sh` | PASSED |
| `inspections-owned-facts` + `inspection-evidence-tenant-fk` abort proofs | PASSED (both) |
| `test:e2e:api:legacy` / `test:e2e:api:outbox` | 21 passed each (5 skipped module-mode specs) |
| `test:e2e:api:allmodules` | **27 passed** (every module-mode spec active at once) |
| `test:e2e:api:allmodules:outbox` | **27 passed** |
| Module-boundary + registry + tenant-isolation checks | green (inside `pnpm check` + integration: boundary.test.ts, module-registry.test.ts, isolation suites) |
| CI | the finalization PR's checks on `claude/phase2-task10-finalize` (api / web / e2e / api-e2e / upgrade-proof) |

## 8. Residual risks & flagged items (for the reviewer)

- **Media stays a live read** — no module projection serializes Media; the snapshot photo layer
  recomposes per request (standing exemption, pinned by the SET NULL coverage table). A future
  media module would follow the established extraction pattern.
- **One-time e2e flake** — a single `test:e2e:api:allmodules:outbox` run saw the pillar-chain
  checklist submit stay `idle` (a swallowed click during the post-upload refresh burst); it did not
  reproduce on the immediate rerun (27/27) and no product change was made for it. Recorded here so
  a recurrence is judged with history.
- **Inbox rows not yet assignee-scoped** — the matrix notes `eng-checklist` targets the engineer
  ROLE, not a specific assignee; unchanged in Phase 2 (product decision deferred).
- **Two matrix rows are non-event-driven by design** — override-expiry (time-based, filtered
  against the read's `now`) and the demo photos tile; both are read-time derivations, immune to
  staleness by construction.
- **Client-side composition of Inbox/Dashboard** — deliberate: their per-viewer, i18n-labelled
  action semantics live in the frontend selectors over module-read-fed slices; a server-side inbox
  endpoint would duplicate UI concerns without changing the data path (every input is already a
  module contract). The reviewer may treat this as the standing architecture decision to confirm.

## 9. Vision alignment

One project is one site; every cross-cutting surface derives from module-owned reads whose facts
have exactly one canonical owner. Projections remain rebuildable read models — never sources of
truth — now with an operator repair whose diagnosis can neither cry wolf on healthy lag nor miss a
served contradiction, and whose every action is attributable (operator identity + reason, durable).
Human approvals stay attributable end-to-end; drafts stay weightless and author-private everywhere
including the portfolio rollup; tenant isolation is database-enforced and re-proven against live
PostgreSQL in this battery. All migrations remain additive; the cutover procedure is written down,
gated, and reversible at every step.

## 10. Final-review P1 correction — the decisions upgrade path (fix-forward from `c94aee3`)

**The finding (independent review of #183):** a production database upgraded to #183 can carry an
ACTIVE, CAUGHT-UP `decisions.inbox` generation holding a **non-empty SUBSET** of the canonical
decision register — the residue of the pre-#183 per-event consumer, which materialized only the
decisions that had post-bootstrap events. The merged read path serves it as authoritative:
`readServableGeneration` sees healthy + caught-up, and the read-side hollow guard passes on ANY
non-empty row set. The #183 full-refresh consumer repairs it only on the NEXT `decision.*` event;
until then the Decision Log silently hides the missing decisions. The operator rebuild could not
repair it either: `decisions.inbox` was not in `REBUILDABLE_PROJECTIONS` (`diagnose` threw, the
default `run()` covered only `drawings.inbox` + `daily-log.inbox`) and the runbook rebuilt only
those two.

**Immutable SHAs:** base `main` @ `c94aee3` (the merge of #183) · implementation `6e4d105` on
`claude/phase2-finalize-correction` · merge SHA recorded on merge.

**The correction (one focused fix-forward; no rollback, no re-opened extraction):**

- `REBUILDABLE_PROJECTIONS` now covers **all five** production projection consumers, explicitly —
  no reflection over the consumer registry. The default operator run (no `--consumer`) rebuilds all
  five; the CLI registers all five factories, asserted against the registry so they cannot drift.
- The adapter interface generalizes to `stored`/`canonical` comparables. For the four composite
  (per-project single-row) projections the comparable is the stored dto vs the module serializer's
  recompute, unchanged in substance. For `decisions.inbox` — a per-decision ROW SET — both sides
  are the **complete normalized row set**: `decisionId`, `status`, `publishedAt` (explicit ISO
  string on both sides; a raw `Date` would stringify as `{}` under the key-order-independent
  compare), `authorId` AND the `dto`, ordered deterministically by `decisionId`. Both readers
  (`computeDecisionRows` canonical / `storedDecisionRows` stored) live in the decisions module and
  go through `serializeDecision` — the module's one canonical serializer; no decision-persistence
  read leaves the owning module.
- `docs/RUNBOOK.md` step 3 now rebuilds ALL FIVE consumers and is explicitly gated **before**
  enabling all module-query reads (`VITE_*_READ=moduleQuery`) and before outbox sender mode.

**Reproduce-first evidence** (`apps/api/test/integration/projection-rebuild-upgrade.test.ts`, live
PostgreSQL 16):

- The legacy state is manufactured faithfully: 3 canonical decisions that PREDATE the event stream
  (seed/import), one FOREIGN event establishing the committed head, an active `cursorStatus='live'`
  generation with `appliedPosition = head` holding 1 byte-correct row (built with the real
  serializer — the defect is purely the missing rows).
- **RED @ `c94aee3`** (three source files checked out at base under the identical probe): all 6
  tests fail with `decisions.inbox is not an operator-rebuildable projection` — and the
  reproduction assertions BEFORE that throw pass, i.e. at `c94aee3` the merged read serves the
  1-of-3 subset as `source: 'projection'` with no repair path. A default `ops.run` there reports
  only the two registered consumers.
- **GREEN @ `6e4d105`**: the same probe proves the partial generation is served as authoritative
  (the reproduce step), diagnoses `corrupt`, and the DEFAULT `run()` — **without any decision
  event** — repairs it: the complete register is served as `source: 'projection'`,
  live == projection == rebuild (`moduleDecisions` ≡ `snapshotSlice`), diagnosis `current-match`,
  and the invocation + all five per-consumer outcome rows are audited (`projection.rebuild`,
  `projection.rebuild.result` — the decisions outcome reads `ok: generation N current-match
  (before: corrupt)`).
- **State coverage** for the decisions diagnostic: zero-decision (noop-bootstrapped empty
  generation over an empty register → `current-match`), complete (full manufactured set →
  `current-match`, which also pins the ISO normalization on both sides), partial (subset →
  `corrupt`), lagging (head advance → `lagging`, row comparison never consulted; drain →
  `current-match`), corrupt (tampered key column with identical dto → `corrupt`, repaired by the
  run). The existing rebuild-operations suite's audit pin was widened from two consumers to five.

**Gates for this correction:** recorded in the PR (pnpm check; the complete live-PG integration
suite — 44 files / 371 tests; `scripts/upgrade-proof.sh` PASSED; `test:e2e:api:allmodules` and
`test:e2e:api:allmodules:outbox` 27/27 each; the focused probe red @ `c94aee3` / green @ head).
One legacy-mode `allmodules` run flaked on `project-scope.spec.ts`'s SECOND project switch — the
§8-recorded switcher-dropdown race family, at a one-shot open-and-pick the #183 hardening had not
covered. The four remaining one-shot switcher picks in the e2e specs now use the same cleared
one-unit `toPass()` retry (test-only; no product change).
