# Phase 4 — Labour Readiness — Consolidated Review Packet

The final Phase-4 review stop (plan `docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md`,
execution item 6). This packet maps the plan's design decisions §A–§J and the design spec's §25
pilot acceptance criteria to delivered, independently reviewed evidence across Tasks 1–6.

Phase 4 fills the "Team" readiness gate — a stored stub before this phase — with the same
canonical, transactional, lock-protected discipline Phase 3 gave the "Material" gate, on the
TIME-CAPACITY model the Codex architecture review demanded: labour is expiring, time-bound
capacity; attendance and work are observations with distinct units, never stock-bucket transfers.

## 1. Delivery record (merges + reviews)

| Task | PR lineage | Final state |
|---|---|---|
| Plan (docs-only) | #211 → #212 (`e8b9805`) → #213 (`b7918c8`) → #214 (`4602d5f`) | **GREEN SIGNAL: PHASE 4 ARCHITECTURE PLAN CLEARED**; explicit Task-1 implementation GO |
| 1 — capability + type-routed demand + trusted identity (§B/§D/§H) | #215 (`296db92`) → #216 (`b627359`) → #217 (`ecde661`) → #218 (`25a5ad5`) → #219 (head `8bd60c2`, merge `b080e2e`) | **GREEN SIGNAL: PHASE 4 TASK 1 IS CLEARED** — `docs/reviews/phase-4-t1-*.md` |
| 2 — labour commercial chain (§F) | #220 (`aae0711`) → #221 (`81e43ed`) → #222 (`c09b1ac`) → #223 (head `45ac885`, merge `83971b7`) | **GREEN SIGNAL: PHASE 4 TASK 2 IS CLEARED** — `docs/reviews/phase-4-t2-*.md` |
| 3 — time-capacity conservation (§C) | #224 (`cb589dd`) → corrections through #230 (`33d37a3`); STATUS flip #237, orchestrator completion #238 (`93fe2c3`) | **DELIVERED AND CLEARED** — `docs/reviews/phase-4-t3-*.md` |
| 4 — coverage + Team gate + seventh projection + LEAF graph (§A/§G) | #242 (`861b622`), two Codex correction rounds folded in-branch, fresh clean +1 | **CLEARED — the plan's MANDATORY post-Task-4 review stop satisfied** — `docs/reviews/phase-4-t4-readiness-packet.md` |
| 5 — Daily-Log reconciliation (§E) + productivity (§I) | #245 (head `119816b`, merge `d8a9c50`), twelve findings across three in-branch Codex rounds all fixed reproduce-first | **MERGED with a fresh clean Codex +1 on the exact head** — `docs/reviews/phase-4-t5-reconciliation-packet.md` |
| 6 — frontend surfaces + pilot acceptance chain (§J) | draft PR #246 (branch `claude/phase4-task6` from `d8a9c50`) | **THIS review stop** — `docs/reviews/phase-4-t6-frontend-packet.md` |

Every PR rode the exact-head `codex-current-head` gate (draft → CI green → orchestrator promotes →
Codex reviews the exact SHA → clean +1 → auto-merge); no human technical approval substituted for
the gate at any point.

## 2. Design decisions §A–§J → evidence

### §A — Execution vs forecast truth tables (split, first-match, never vacuous)

- `LabourCoverageService.coverageFor` implements the EXECUTION first-match table literally per
  `(civilDate, shift)` slice — before-window `wait`, overdue-unfulfilled `fail`, present-or-worked
  `ok` (union counting: `covered = |present ∪ worked|`), allocated-not-mustered `wait`,
  under-allocated `fail` — with explicit before/within/overdue rows so an empty due-today set can
  never yield `ok`. `forecastFor` never consults presence; a live same-slice commitment with
  undrawn quantity and a promise ≤ the slice date makes a shortfall `at-risk` dated at the promise.
  (Task 4; probes in `phase4-t4-labour-readiness.test.ts` 16/16.)
- `activities.start` reads execution truth in-tx under `lockProjectReadiness` after the material
  block; worst-gate composition proven both directions; the stored team flag is neither writable
  nor read on-pilot (a hostile stored 'ok' cannot start an under-allocated activity). (Task 4 +
  the Task-5 mismatch-first extension: an unresolved `LabourMismatch` is a first-match `fail`.)
- The §A readiness-lock command enumeration advanced 22→34 across the phase (tripwire).
- UI: the Labour hub shows the FORECAST verdicts from `labour.readiness`; the derived EXECUTION
  Team gate reaches the Schedule through the server-baked `ActivityReadiness.team`. The browser
  derives neither. (Task 6.)

### §B — Fingerprinted labour spec identity + explicit demand slices

- `labourSpecFingerprint` over `(tradeCode, skillCode, shift)` — ONE shared pure function; the
  DB recomputes the canonical SHA-256 in SQL at commit (Task-1 F2 durable demand seal, re-checked
  on later-transaction slice appends).
- Explicit `(civilDate, shift, personShiftQty)` slices carried requirement → requisition → PO →
  commitment → allocation; every §F bound stated per slice AND in total; capacity for one slice
  never satisfies another. Neutral-row `baseUom`/`qty`/`requiredBy` DERIVED from the slices.
- Revocable pmc-authored skill substitution widens satisfaction (`ApprovedSkillSubstitution`),
  bound to the current head fingerprint; carry-forward proven (responsible-only preserves;
  trade/skill/shift revision strands; headcount increase preserves + shortfall). (Tasks 1/3/4.)

### §C — Time-capacity conservation (no bucket ledger)

- Four fact families with DISTINCT units: frozen-identity CAS `WorkerAllocation` (person-shift),
  append-only revocable `LabourAttendance` (headcount), immutable `LabourWorkFact`
  (worked-minutes), revocable `ApprovedSkillSubstitution`. No current-quantity column anywhere.
- Worker-level global conservation: partial unique on `(projectId, workerId, civilDate, shift)
  WHERE status='active'`; crew allocation EXPANDS transactionally per active member under stable
  ascending-`workerId` `FOR UPDATE` (deadlock-free by the overlapping-crews barrier race);
  cumulative `Σ workedMinutes ≤ shiftMinutes` re-derived under the worker lock. (Task 3, 17/17 +
  the four-finding correction — allocation↔activity coherence FK, trusted attendance evidence,
  serialized bound-3 trigger, cancelled-demand refusal.)

### §D — Per-project capability pilot (off = byte-identical)

- The `labour` `ProjectCapability` via the same operator CLI as `materials`; two-projects-one-org
  capability-off byte-identity proof (Task 1); every labour route 404s off-pilot.
- Frontend: `SCREEN_CAPABILITY.labour` gates the nav; `loadLabour` is a no-op off-pilot;
  `labourView` null keeps the Daily-Log/Team/Inbox extensions absent, so a non-pilot project
  renders byte-identically. The e2e INERT test proves no nav + 404 in a real browser; the web
  suite proves materials↔labour capabilities gate independently. (Task 6.)

### §E — Daily-Log reconciliation (observation ≠ resolution; steppers display-only)

- Labour-owned append-only `LabourMismatch` (`wrong_trade` names the worker; `shortfall`
  structurally cannot) + the pmc-only UNIQUE-per-observation resolution register; the block
  transitions are CAS with banner handover to/from the material block; `labour.presence` joins
  worker identity server-side. (Task 5, 15/15.)
- UI: the Daily-Log pilot section renders per-worker musters + unresolved mismatches from
  `labour.presence` (en/hi/gu), display-only; the aggregate `CrewRow` steppers are untouched and
  never drive the Team gate. The hub's attendance tab records the pmc-attributable MANUAL
  exception only — the trusted path is the worker's own bound device. (Task 6.)

### §F — The labour commercial chain + the three bounds

- `VendorLabourProfile` on the REUSED procurement `Vendor`/`ProjectVendor` (no `LabourSupplier`);
  `LabourRfq → SupplierLabourQuote → comparison → LabourPurchaseOrder(+version) →
  CapacityCommitment(+append-only promise register)`; frozen rate snapshots; CAS machines.
  (Task 2.)
- Bound 1 (requirement→requisition ≤ demand per slice) and bound 2 (requisition→PO ≤ remaining
  per slice) proven under deterministic barrier races; bound 3 (allocated ≤ committed == ordered —
  labour overage headroom is structurally zero) enforced by the service under the commitment
  `FOR UPDATE` AND a serialized DB trigger (Task-3 correction F3, two-client hostile race 10×).
- The Task-2 correction lineage sealed the DB truths (single transactional commitment lifecycle,
  frozen line identity FKs, four-FK quote provenance, `committedQty ≤ personShiftQty`, the
  reopen-on-default terminal-state policy, the executable `t2c` operator repair + production
  runner proof). UI: the hub's suppliers/commitments tabs render the chain; the demand tab raises
  ONE requisition carrying the slices. (Tasks 2 + 6.)

### §G — The LEAF module graph (acyclic by construction)

- `labour.dependsOn: []`; the only graph edge is `activities → labour` (+ `orgs → labour` for the
  device bind read); every reverse interaction is a cycle-exempt participant edge
  (`writeRequirementSpec`, `labourTarget`, `labourRequirementHead`, `assertMediaDisposable`,
  `ProcurementParticipant`) or async `requirement.*` consumption into the labour-owned read-model
  (`foldLabourRequirementHeads` — the first non-empty `consumesEvents`).
- The §G acceptance test pins the exact edge sets + Kahn's topological sort over the LIVE
  manifests (RED against the round-2 cyclic manifest); the boundary analyzer's nested-read
  detection (Task-1 F1) guards the read encapsulation, with the inverse fixture flagged.
  (Tasks 1/4.)
- Task 6 adds NO server edge — the frontend consumes module-owned HTTP reads only.

### §H — Trusted workforce identity

- Project-contained `LabourTrade`/`LabourSkill`/`Worker`/`Crew`/`CrewMembership` with
  active-window CHECKs + revocation; `WorkerSkill` normalized with real FK concurrency semantics
  (the Task-1 correction-3 TOCTOU fix, both orderings proven 10×); `WorkerDevice`→`Worker`
  composite FK; the bind command in the OWNING orgs module; attendance evidence requires the
  worker's OWN bound device or an explicit pmc `manualReason` (DB-sealed). Anonymous QR/tap
  onboarding byte-identical throughout. (Tasks 1/3.)
- UI: the Team-screen labour roster (workforce + catalog reads, pmc onboarding, device binding);
  the e2e onboards a worker through the browser and confirms it in the workforce register.
  TeamAccess itself is deliberately unchanged (the §J deviation, documented in the Task-6
  packet): it is the AUTH surface whose anonymous flow the §D/§H proofs pin. (Task 6.)

### §I — Measured output + derived productivity

- Activities-owned immutable `ActivityWorkOutput` (evidence FK-sealed, delete-guarded);
  productivity is the DERIVED join composed Activities-side through `LabourQuery.effortFor` in
  `Prisma.Decimal` end-to-end (zero effort → null, never a fabricated rate); Labour never reads
  `ActivityWorkOutput`. (Task 5.)
- UI: the hub's productivity tab renders the planned/present/worked/output/per-hour rows; the e2e
  drives work through the browser, lands an output, and sees the join. (Task 6.)

### §J — Frontend surfaces + offline/idempotent field ops

Delivered in full by Task 6 (see `docs/reviews/phase-4-t6-frontend-packet.md`, incl. the §J
surface table, the TeamAccess→Team-roster deviation, and the honest residuals): the ONE Labour
hub with seven tabs; the store labour slice on the cleared materials discipline; `labourKeys.ts`
born with the PR-#208 two-key lifecycle (fresh idempotency key per action, deterministic coalesce
key while pending, same-key replay on a lost response, terminal-drop + transient reconcile, scope
guards, hydration normalization); the `labour-shortage` Inbox action; the Daily-Log presence
section; the Team roster; en/hi/gu labour labels; and NO new screen beyond the hub.

## 3. The principal Phase-4 vertical acceptance test

Plan: *labour requirement → comparison and labour-PO → capacity commitment → allocation →
same-day attendance → labour execution-readiness green → combined material+labour start →
recorded work → productivity*, in a real browser on a pilot project, provably inert on a
non-pilot project.

Delivered as `apps/web/tests/e2e-api/labour-pilot.spec.ts` test 1 (+ tests 2–4): the §F chain
runs API-side to a live commitment; the BROWSER allocates (visible AT-RISK → READY), musters
(manual exception, same day), `activities.start` succeeds through the in-tx execution Team gate
(the material gate composes as `na` — the activity carries no material requirement; the
material-ok-labour-not and labour-ok-material-not combined tables are integration-proven in
Task 4), the BROWSER records work, a §I output lands, and the productivity tab shows the derived
join. Ran clean twice consecutively in the harness DB; both sender modes run it inside the full
e2e suites (§5).

## 4. Design spec §25 — labour-relevant pilot acceptance criteria

| §25 criterion | Where proven |
|---|---|
| every upcoming pilot Activity has dated resource requirements and accountable owners | Type-routed `ActivityRequirement` (`type='labour'`) with explicit dated slices + `responsibleId` (Task 1); hub demand tab (Task 6) |
| readiness changes automatically from evidence | The derived Team gate from §C facts (Tasks 4–5); the browser-visible AT-RISK→READY transition on allocation; start authorized by presence (e2e test 1) |
| supply/labour shortages produce forecast impact and Inbox actions | `labour.readiness` forecast verdicts + covering dates (Task 4); the `labour-shortage` Inbox card, red/amber by impact (Task 6; e2e test 2) |
| project dashboards contain no manually entered operational counts | The stored team flag is rejected on-pilot (Task 4); every hub number is a server module read; crew steppers display-only (§E) |
| cross-project and cross-company access tests pass | Same-project composite FKs across all labour tables + forgery probes (Tasks 1–3); capability-off 404s + INERT browser proof (Task 6) |
| every commercial amount traces from requirement through payment status | The §F chain requirement→requisition→quote→comparison→PO→commitment with four-FK provenance (Task 2); *payment status itself is Phase 5 (Commercial Control) by design* |

The remaining §25 criteria are material/inspection/report criteria owned by Phase 3 (cleared —
`docs/reviews/phase-3-consolidated-review-packet.md`) or by later phases per §24.

## 5. Task-6 gate battery (the consolidated stop's evidence)

Delivered with PR #246 (details + the honest flake record in
`docs/reviews/phase-4-t6-frontend-packet.md` §3): `pnpm check` EXIT 0 (web 458/458 incl. 26 new
labour probes; API unit 680/680); full integration **71 files / 693 tests** on a pristine
migrated DB (API untouched); `upgrade-proof.sh` PASSED (no migration; all prior seals survive);
`test:e2e:api:allmodules` **35/35** AND `test:e2e:api:allmodules:outbox` **35/35** clean, both
including the labour-pilot acceptance chain; the labour-pilot spec additionally ran 4/4 twice
consecutively against the same DB.

## 6. Residuals and forward pointers

- The hub's manual muster ships without inline photo capture (`evidenceMediaId` is server-ready);
  crew-level allocation UI is deferred (the server expands crews; the hub allocates the atomic
  worker source) — both stated in the Task-6 packet §1.
- Phase 5 (Commercial Control) consumes the §F commercial chain + the §I productivity join, both
  shipped and cleared.
