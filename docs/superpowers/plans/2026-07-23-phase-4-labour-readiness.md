# Phase 4 — Labour Readiness

**Status: PLANNING (docs-only) — round-1 architecture-review correction. The independent Codex architecture review returned CONDITIONAL NO-GO (direction accepted; the plan copied the material-stock model too literally). This revision replaces the stock-bucket analogy with a time-capacity model and resolves all eight findings; it awaits the narrow re-review. NO implementation code exists; Phase 4 Task 1 does not begin until this plan is CLEARED and JagPat gives an explicit implementation GO.**

Planning baseline: `JagPat/PMCvitan` `main` @ `1f0caa3` (Phase 3 CLEARED; the round-0 plan merged as PR #211). This plan **builds on** the cleared Phase 1–3 platform and **does not rewrite or duplicate** it. Vision source: `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` — §11 (`ActivityRequirement.type` already lists `labour`), §14 (Labour: "required, committed, allocated, present and productive crew; attendance does not imply availability unless allocated to the Activity"), §17, §24 Phase 4 + Phase Intent Map row 4, §25.

---

## Independent Architecture Review Corrections (round 1 — how each finding is resolved)

The review accepted the purpose, reuse strategy, UI direction, capability isolation and combined-readiness objective, and named eight architecture corrections. Each is resolved below and carried into the design (§ references are to this revised plan).

- **F1 (P1) — labour conservation not globally enforceable.** The round-0 ledger keyed movements partly by `activityId`, so one crew could be allocated to two activities in the same date+shift. **Resolved (§C):** capacity is conserved **at the source**, globally, by `(projectId, capacitySourceId, civilDate, shift)` **before** any activity assignment. A partial-unique / exclusion constraint makes a second live allocation of the same source for the same date+shift **unrepresentable**; the competing-activity crew race (a required probe) proves exactly one activity wins.
- **F2 (P1) — mixed units.** The round-0 model moved one `qty` through `committed→allocated→present→deployed`, conflating headcount and man-days. **Resolved (§B/§C):** readiness is measured in **person-shift / headcount**; actual work is a **separate** fact in **worked-minutes / man-days**. Attendance (a presence observation) and deployment (an effort observation) are **distinct immutable facts with distinct units — never transfers of the same quantity**.
- **F3 (P1) — requirement ownership + capability routing.** **Resolved (§B/§D):** **Activities** owns the requirement root/revision/events; **Labour** owns `LabourRequirementSpec`, written in the SAME transaction through an explicit `LabourParticipant` (the owner-aligned participant channel). The requirement command routes **by type**: `type='material'` asserts the `materials` capability and writes the material detail; `type='labour'` asserts the `labour` capability and writes the labour detail via the participant. The root `type` is immutable and PostgreSQL enforces **exactly one** correct detail record per revision.
- **F4 (P1) — revisions strand/reuse allocations.** **Resolved (§B/§C):** every commitment/allocation/satisfaction pins the exact `(projectId, requirementId, revision, labourSpecFingerprint)`; coverage counts only capacity matching the **current head** fingerprint (or an ACTIVE, current-fingerprint-bound, revocable skill substitution). A revision to an incompatible spec produces a new head fingerprint, so stale allocations **no longer satisfy** it (the activity re-derives to at-risk/blocked until re-allocated) — the requirement-revision-invalidation probe proves it.
- **F5 (P1) — trusted attendance identity.** **Resolved (§H):** a first-class project-contained `Worker` with active dates + revocation; `WorkerDevice` binds to a `Worker` by FK (free-text device name/trade is never readiness evidence); attendance is project-contained with evidence containment; a partial-unique gives **one attendance per `(worker, civilDate, shift)`** and the §C exclusion gives **no overlapping worker allocation**. Legacy aggregate `CrewRow` counts never influence readiness.
- **F6 (P1) — contradictory readiness table.** **Resolved (§A):** **two** deterministic first-match tables — **execution truth** (same-day, project timezone, injected clock; used by `activities.start`) requires allocation **and** presence; **forecast truth** (future need date; used by the projection/Inbox) requires allocation, with commitment→at-risk. When the labour capability is active, Team derives **entirely** from canonical coverage + unresolved mismatch facts; `Activity.gateTeam` is **legacy-only** (mutation rejected on capability-enabled projects), never a second writable truth.
- **F7 (P2) — duplicated supplier identity.** **Resolved (§F):** the round-0 `LabourSupplier` is **dropped**; the business party is the existing `Vendor`/`ProjectVendor`. Phase 4 adds only a labour-specific `VendorLabourProfile` (trades/skills supplied) and **separate** labour commercial documents (labour RFQ/PO — the commercial lines differ).
- **F8 (P2) — productivity has no numerator.** **Resolved (§I):** the Daily-Log `progress`/photo counters are NOT measured output. Phase 4 defines an immutable **`ActivityWorkOutput`** fact (quantity + UOM + evidence); productivity is a derived read of measured output ÷ actual effort. Productivity is the **last** task and is explicitly deferrable if the reviewer prefers — nothing else depends on it.
- **Mandatory review stop (instruction 12):** a **narrow review stop after Task 4** (the readiness core), **before** Daily-Log reconciliation and frontend integration.

---

## Phase Intent (restated per the spec's Phase Intent Map, row 4)

- **Why now:** material availability alone does not make work executable; crew demand, commitment and attendance must align with the same Activity and date.
- **What changes:** planned crew demand, supplier/source commitment, allocation, attendance and productivity determine **labour readiness** (the **Team** gate) and expose **material-vs-labour mismatches** before work is lost.
- **What it unlocks:** cost and payment evaluation (Phase 5) require actual labour and progress evidence, not only plans.

Phase 4 fills the **Team** readiness gate — today a stored stub — with the same canonical, transactional, lock-protected discipline Phase 3 gave the **Material** gate, but over a **time-bounded, expiring capacity** model rather than a stock ledger, and joins the two into one activity-start verdict.

---

## Facts consumed from earlier phases (the cleared spine Phase 4 reuses, never rebuilds)

1. **Type-neutral demand contract.** `ActivityRequirement` is append-only, revisioned, root-anchored, CAS-guarded, provenance-carrying, and its `type` enum **already contains `labour`**. Labour demand is a `type='labour'` revision row.
2. **Five-gate readiness + the readiness lock.** `deriveReadiness` composes `decision·material·team·inspection·drawing`; `readinessReady` requires all five (the accepted worst-gate composition); `lockProjectReadiness(projectId)` serialises readiness-affecting writes; the §A tripwire enumerates the locked command set. The **Team gate is the last stored stub**.
3. **Canonical coverage-authority pattern.** `InventoryService.coverageFor` returns a per-requirement verdict read **in-tx under the lock** by `activities.start`; `deriveMaterialReading` is the single shared verdict→gate map reused by start, read-bake and projection (live == projection == rebuild).
4. **Platform kernel.** Command ledger (`executeCommand`, idempotency, source-command provenance), durable outbox (`emitEvent` + shared `DOMAIN_EVENT_TYPES` + external-effect catalog + reseal), generation-swap rebuildable projections (six today), per-project capability activation (`ProjectCapability` + `capability:enable`), canonical audit (`recordAudit` + `Actor`), membership-authoritative auth, additive + diagnostic-first migrations proven by `upgrade-proof.sh`.
5. **Org-party tenancy + supply state machines.** `Vendor(orgId,id)` + `ProjectVendor` dual-composite-FK containment; the procurement CAS chain + the three §F allocation bounds + frozen versioned snapshots + append-only promises; the cycle-exempt cross-module **participant** channel.
6. **Frontend module-owned pattern.** The capability-gated Materials hub (honest load states, `SCREEN_CAPABILITY`, `enabledScreensFor`), the durable write-ahead outbox client (`runWriteAhead`, `newIdempotencyKey`, coalesce keys, terminal-drop reconcile), the Inbox action-queue.

Phase 4 adds a **labour** module that parallels the *readiness discipline* — not the stock mechanics — of this spine. No existing owner moves; no primitive is duplicated.

---

## Current-State Revalidation (against `main` @ `1f0caa3`)

Grounded anchors the tasks build on. **Readiness:** `ActivityRequirementRoot`/`ActivityRequirement` (`type RequirementType` enum incl. `labour`; append-only, `@@unique([projectId,requirementId,revision])`) + `MaterialRequirementSpec` (`apps/api/prisma/schema.prisma`); `RequirementsService.create/revise/cancel` (`apps/api/src/activities/requirements.service.ts` — currently hardcodes `MATERIALS_CAPABILITY`, `type:'material'`, and the `MaterialRequirementSpec` write; Task 1 introduces type routing here); `InventoryService.coverageFor` + `coverage.ts`; `deriveMaterialReading` (`apps/api/src/activities/material-readiness.ts`, `VERDICT_TO_GATE`/`SEVERITY`, mismatch-first); `deriveReadiness` (`packages/shared/src/domain/readiness.ts` — Team is `{ v: input.gateTeam, source:'stored', reason:'…team present' }`, the seam Phase 4 replaces; `OverridableGate` includes `'team'`); `activities.service.ts start` (post-`lockProjectReadiness` gate-replacement block); `lockProjectReadiness` (`apps/api/src/common/readiness-lock.ts`); the §A tripwire `readiness-lock-coverage.test.ts` (`SECTION_A_COMMANDS`, `toHaveLength(22)`); `MaterialReadinessProjection` = sixth `REBUILDABLE_PROJECTIONS` entry (`apps/api/src/activities/material-readiness.projection.ts`, `rebuild-operations.ts`). **Platform:** `executeCommand`/`CommandExecution`/`synthesizeKeyWhenAbsent`/`COMMAND_KEY_ENFORCED` (`apps/api/src/platform/commands.ts`); `emitEvent` + `DOMAIN_EVENT_TYPES` (`packages/shared/src/platform/events.ts`) + `EXTERNAL_EFFECTS` + reseal; projection base/rebuilder/CLI; `CapabilitiesService`/`ProjectCapability`/`capability.cli.ts` (`MATERIALS_CAPABILITY='materials'`); shell `capabilities:string[]`; `recordAudit`/`Actor`/`actorKind`; membership-auth; `Membership.role`+`.discipline`. **Tenancy/supply:** `Vendor(orgId,id)`/`ProjectVendor` dual-composite-FK (`schema.prisma`; `20261218000000_phase3_procurement`); the procurement CAS chain + §F bounds + frozen snapshots + append-only `DeliveryPromise`; cross-module `*.participant.ts` (owner-aligned, leaf, cycle-exempt); `cross-module-graph.test.ts`. **Identity:** `WorkerDevice` (`schema.prisma:~869` — free-text `name`/`trade`, **no Worker FK**; a device token, not readiness evidence); the account-less worker-token field path. **Daily log:** `DailyLog`/`CrewRow{trade,count}` (`schema.prisma:~1884`; `progress`/photos are NOT measured output). **Frontend:** `MaterialsScreen.tsx` template; `lib/screens.ts` (`SCREEN_CAPABILITY`/`enabledScreensFor`); the write-ahead outbox client; `selectActionItems` (`material-shortage`); i18n `dictionary.ts` (`accessDict`/`tradeLabels`/`workerTradeLabels`). The schedule renders **five** gates (`D·M·T·I·Drawings`).

---

## Architecture (the corrected time-capacity design decisions)

### §A. Labour-readiness truth (execution vs forecast) + combined readiness + lock protocol

**Command authority is canonical, transactional and locked.** A new `LabourService.coverageFor(tx, projectId, requirements, asOf)` returns a per-labour-requirement verdict, read **in-tx under `lockProjectReadiness`** — the SAME lock material coverage takes, so labour and material writes on one project serialise on one advisory lock and `start` sees a consistent five-gate snapshot. `asOf` is the project-timezone civil date from an **injected clock** (never `new Date()`), so execution truth is deterministic and testable. `deriveTeamReading` maps the verdict to the gate (sibling of `deriveMaterialReading`). The labour-readiness projection (§G) feeds UI/Inbox/Dashboard/forecast ONLY.

**Team-gate replacement + legacy isolation (F6/instruction 9).** When the `labour` capability is **active**, `deriveReadiness`'s Team gate derives **entirely** from canonical labour coverage + unresolved labour-mismatch facts (§E); `Activity.gateTeam` is **not read** and **its mutation is rejected** (no second writable truth). When the capability is **disabled** (legacy projects), `gateTeam` remains exactly the stored stub it is today — byte-identical. A `GateOverride{gate:'team'}` (authority + reason + evidence + expiry) still supersedes, unchanged.

**Readiness is measured in person-shift / headcount** (integer count of workers of the required trade/skill for a `(civilDate, shift)`), never man-days. Actual effort (§I) is a separate unit.

**Execution truth — the deterministic first-match table `activities.start` uses (asOf = project-tz civil today; per activity; worst-wins across the activity's demand slices due today):**

| # (first match) | Condition | `gt` |
|---|---|---|
| 1 | an unresolved labour-mismatch fact exists for the activity | `fail` |
| 2 | the activity has no `type='labour'` requirement | `na` |
| 3 | for every required `(trade/skill, shift)` slice due today: **allocated AND present** capacity (head fingerprint or active substitution) ≥ required person-shifts | `ok` |
| 4 | every slice is **allocated** ≥ required but at least one required worker is not yet **present** (muster pending) | `wait` |
| 5 | otherwise (a slice is under-allocated) | `fail` |

**Forecast truth — the deterministic first-match table the projection/Inbox/Dashboard uses (for a future need date; per activity/slice; worst-wins):**

| # (first match) | Condition | forecast verdict |
|---|---|---|
| 1 | an unresolved labour-mismatch fact exists | `blocked` |
| 2 | no labour requirement | `not-required` |
| 3 | **allocated** capacity (head fingerprint / active substitution) ≥ required for the slice | `ready` |
| 4 | shortfall covered by a `CapacityCommitment` of the fingerprint dated ≤ `requiredBy` | `at-risk` |
| 5 | otherwise | `blocked` |

The two tables differ **only** in whether presence is required (execution) or allocation suffices (forecast) — resolving F6. Actual work already performed against the activity counts as satisfied capacity for that activity (the labour analogue of "issued material counts as coverage"; deploying an allocated crew never un-readies the activity).

**Combined material-and-labour activity readiness (accepted worst-gate composition).** Material and Team are independent derived gates; the activity is ready iff all five gates are `ok` (`readinessReady`). Material × Team subset (other gates `ok`):

| Material | Team | `start` | Surfaced |
|---|---|---|---|
| `ok` | `ok` | **allowed** | ready |
| `ok` | `wait` | refused | material available, **labour crew allocated but not mustered** |
| `ok` | `fail` | refused | **material available, labour BLOCKED** (under-allocated / no commitment) |
| `wait`/`fail` | `ok` | refused | labour available, material at-risk/blocked |
| `na` | `ok` | allowed¹ | no material demand |
| `ok` | `na` | allowed¹ | no labour demand |

¹ subject to the other three gates; a per-gate `pmc` override supersedes its row.

**Lock-coverage extension (the §A tripwire).** Every Phase-4 command that can move the Team gate takes `lockProjectReadiness` and joins `SECTION_A_COMMANDS`/`COVERAGE` in `readiness-lock-coverage.test.ts` (bumping `toHaveLength(22)` to the new count): labour-requirement `{create,revise,cancel}` (via the routed requirement command); `capacity.commit/revise/default`; `allocation.allocate/release`; `attendance.record/revoke`; `work.record` (does not move the gate but is lock-consistent); `labour_mismatch.resolve`. Concurrency probes (live PG, both orderings under the lock): **competing-activity crew allocation** (two activities, same worker/date/shift → exactly one wins); allocation-release vs `start`; attendance-record vs `start`; labour-requirement revision vs `start`; commitment-default vs `start`; plus the cross-gate probe (a material reservation and a labour allocation on one project serialise; `start` sees a consistent snapshot).

### §B. Labour demand identity + units + type routing + fingerprint

| Element | Definition |
|---|---|
| Demand row (Activities-owned) | `ActivityRequirement { type:'labour' }` — the SAME append-only, root-anchored, CAS-guarded, provenance-carrying revision material uses. The requirement command routes **by type** (F3/instruction 5): `type='material'` asserts `materials` + writes the material detail; `type='labour'` asserts `labour` + writes the labour detail through `LabourParticipant.writeRequirementSpec(tx, …)` in the same transaction. The root `type` is **immutable** (trigger). |
| `LabourRequirementSpec` (Labour-owned, one per labour revision) | `{ tradeCode, skillCode?, shift, requiredHeadcount:Int, workWindow:[startDate,endDate] }` — the labour detail hanging off `(projectId, requirementId, revision)` (the exact FK triple `MaterialRequirementSpec` uses), immutable by trigger. Demand is expressed as **person-shift slices**: `requiredHeadcount` of `(tradeCode[/skillCode], shift)` for each civil date in `[startDate,endDate]`. A spec change appends a new revision (CAS), never an update. |
| DB type↔detail correspondence (F3) | a trigger/CHECK enforces **exactly one** detail per revision: `type='material'` ⟺ a `MaterialRequirementSpec` row and no `LabourRequirementSpec`; `type='labour'` ⟺ a `LabourRequirementSpec` row and no `MaterialRequirementSpec`. |
| Readiness unit | **person-shift / headcount** (`Int`), declared by the requirement; coverage arithmetic runs only in this unit. Man-days/worked-minutes are a **separate** actual-effort fact (§I), never added to or transferred from headcount (F2). |
| `labourSpecFingerprint` | SHA-256 over ONLY the normalized labour identity `(tradeCode, skillCode, shift)` — one shared pure function in `@vitan/shared`, identical on API + web. Provenance (decision) is stored, not hashed. Every commitment/allocation/satisfaction pins `(projectId, requirementId, revision, labourSpecFingerprint)` (F4). |
| Satisfaction rule | allocated/committed capacity satisfies a demand slice ONLY when its `labourSpecFingerprint` equals the requirement's **current head** fingerprint, OR an ACTIVE `ApprovedSkillSubstitution { requirementId, fromFingerprint, toFingerprint, approvedById, reason, at, revokedAt? }` exists whose `fromFingerprint` equals the **current head** (the Phase-3 T6-F2 rule verbatim), pmc-authored, audited, revocable. A revision to an incompatible spec changes the head fingerprint, so stale allocations no longer satisfy it. |

### §C. Time-bounded capacity conservation (NOT a stock ledger — F1/F2/instructions 1–3)

Labour is expiring capacity, so the model is **four immutable, append-only fact families with distinct units** — not one mixed-unit quantity moved through buckets:

1. **`CapacityCommitment`** (inbound, forecast) — a source (a `Vendor` labour supplier via §F, or an in-house crew) commits `headcount` person-shifts of a `labourSpecFingerprint` for a `(civilDate range, shift)`. Unit: person-shift. Immutable; a revision appends a new dated promise (append-only, §F).
2. **`CrewAllocation`** (assignment; the conserved fact) — assigns a specific **capacity source** (`workerId` or `crewId`) for a `(civilDate, shift)` to exactly ONE `(activityId, requirementId, revision, labourSpecFingerprint)`. Unit: person-shift. **Global conservation is enforced at the SOURCE, before any activity assignment (F1/instruction 2):** a partial-unique / `EXCLUDE` constraint on `(projectId, capacitySourceId, civilDate, shift) WHERE releasedAt IS NULL` makes a second live allocation of the same source for the same date+shift **unrepresentable in PostgreSQL**. `allocate` takes `lockProjectReadiness` + `SELECT … FOR UPDATE` on the capacity source, checks the source is active for the date (§H) and the fingerprint matches the requirement head, then INSERTs; the loser of a race gets a deterministic 409/constraint violation. `release` appends a `releasedAt` (never deletes) and frees the source for re-allocation.
3. **`Attendance`** (presence observation — a DISTINCT fact, not a transfer) — worker `W` present on `(projectId, civilDate, shift)`, with a `Worker` FK + `WorkerDevice` binding + evidence (§H). Unit: headcount (1 per worker). A partial-unique on `(projectId, workerId, civilDate, shift)` gives **one attendance per worker/date/shift** (F5). Attendance does **not** consume or move an allocation; coverage joins attendance to allocation at read time.
4. **`ActivityWorkOutput` / actual effort** (work observation — a DISTINCT fact, distinct unit) — worked-minutes / man-days of effort (and, for productivity, measured output quantity + UOM + evidence, §I) recorded against `(projectId, activityId, civilDate)`. Unit: worked-minutes / man-days. Deployment is an **observation of effort**, never a transfer of the presence headcount (F2).

There is **no current-quantity column and no bucket ledger.** Coverage (§A) is derived by *reading* these facts: allocated = live `CrewAllocation` rows for the slice/fingerprint; present = allocated whose worker has an `Attendance` for the slice; committed = `CapacityCommitment` for the fingerprint dated ≤ requiredBy. Immutability + append-only + no-double constraints are DB-enforced (triggers, partial-uniques, `EXCLUDE`), never convention.

### §D. Pilot activation + type-based capability routing (F3/instruction 5)

A new `'labour'` capability. Labour routes call `capabilities.assertEnabled(projectId, 'labour')` (404 off-pilot). **Type-based routing:** a `type='material'` requirement requires `materials`; a `type='labour'` requirement requires `labour` — the requirement command asserts the capability that matches the row's immutable `type`. The shell adds enabled capabilities to `capabilities[]`; `SCREEN_CAPABILITY` gates the Labour screen; the SAME `capability:enable` CLI turns it on. **Capability-off byte identity (a required probe):** off-pilot there is no labour route, no nav, no event, and `gateTeam` remains the legacy stored stub — the project's Team gate + readiness responses are byte-for-byte identical to today.

### §E. Daily-Log reconciliation + labour mismatch (F5/F6)

- **The aggregate stays but never drives readiness.** `DailyLog.crew` (`CrewRow{trade,count}` steppers, QR self check-in, `selectTotalWorkers`) remains the site's daily headline and the non-pilot daily-log response is byte-identical — but on a pilot project it is a **display aggregate only** and **does not influence the Team gate** (F5/F7). Canonical presence is the per-worker `Attendance` fact (§C).
- **Labour mismatch is a canonical fact, not a stored flag (F6/instruction 9).** When mustered attendance does not match the allocated trade/skill (e.g. a present worker of the wrong trade, or a shortfall recorded on site), an append-only, unique-per-observation **`LabourMismatch`** fact is recorded; the Daily-Log READS labour presence + mismatch from the labour contract (identity joined, nothing copied). The derived Team gate reads **unresolved `LabourMismatch` facts directly** (first-match `fail`, §A). A pilot-gated, pmc-only `labour.resolveMismatch` closes exactly ONE `matched:false` observation with an append-only resolution register row (the observation is never edited) and clears the block only when no unresolved mismatch remains for the decision; one `activity.labour_unblocked` signal.

### §F. Supplier identity (reuse `Vendor`) + labour commitment documents (F7/instruction 10)

- **Reuse the existing party.** The labour supplier/subcontractor **is** a `Vendor(orgId,id)` bound per project by `ProjectVendor` — no `LabourSupplier`. Phase 4 adds only a labour-specific **`VendorLabourProfile`** (trades/skills the vendor supplies; org-admin authority, like vendor CRUD) and a per-project labour binding flag where needed.
- **Separate labour commercial documents** (their lines differ from material): `LabourRfq → SupplierLabourQuote → labour comparison → LabourPurchaseOrder(+version) → CapacityCommitment(+append-only arrival/rate promise)`. CAS machines (`updateMany(id,projectId,status)`, deterministic 409); the three §F allocation bounds re-homed to person-shifts: (1) requirement → labour-requisition ≤ required headcount; (2) requisition → labour-PO ≤ remaining; (3) committed/allocated ≤ ordered + `approvedOverage` (a `LabourSupplierParticipant.lockCommitmentForAllocation` + `applyProgress`, one lock/one bound/one tx). Frozen rate snapshots (rate per person-shift, shift premium) with column-freeze triggers; amendment issues a NEW version retaining the prior verbatim; append-only `seq`-monotone promise register (`CHECK seq=1 OR reason NOT NULL`), the latest promise driving §A forecast at-risk dating. In-house crews commit capacity directly (no vendor chain) — the same `CapacityCommitment` fact from an in-house source.

### §G. Module edges + event catalog (acyclic by construction)

- **New `labour` module** owns `LabourRequirementSpec`, `LabourTrade/Skill`, `Worker`/`Crew`, `CapacityCommitment`, `CrewAllocation`, `Attendance`, `ActivityWorkOutput`, `LabourMismatch`, `ApprovedSkillSubstitution`, the labour commercial documents, and `VendorLabourProfile`. `dependsOn: ['activities','decisions','procurement']` (reads requirement identity/provenance + the `Vendor` party). Manifests (`ownsModels/producesEvents/workflowParticipants/permissions`) join `MODULE_MANIFESTS`; `cross-module-graph.test.ts` `MODEL_OWNER` gains the labour models and asserts zero foreign writes.
- **Acyclicity.** `activities → labour` is a read edge (`activities.start` calls `LabourService.coverageFor`), exactly like `activities → inventory`. The reverse writes — the Activities requirement command writing `LabourRequirementSpec`; an allocation validating its activity target; clearing the Team block — go through the **cycle-exempt participant** channel (`LabourParticipant.writeRequirementSpec`; `ActivityParticipant.labourTarget`/`clearLabourMismatchBlock`), keeping `dependsOn` acyclic — the inventory↔activities resolution verbatim.
- **Event family** (added to shared `DOMAIN_EVENT_TYPES` + `EXTERNAL_EFFECTS`, all signal-only `invalidate:true, push:null`, emitted via `emitEvent` in the command tx): `labour_requirement.created/revised/cancelled`, `skill_substitution.approved/revoked`, `labour_rfq.*`/`labour_po.*`, `capacity.committed/revised/defaulted`, `allocation.made/released`, `attendance.recorded/revoked`, `work.recorded`, `labour_mismatch.recorded/resolved`, `activity.labour_unblocked`. **Derived facts get NO event** (coverage/verdicts derive nothing); the labour-readiness projection derives no domain event (a rebuild emits zero events + zero notifications). A catalog change forces an external-effect reseal.
- **The seventh rebuildable projection.** `LabourReadinessProjection` (per-project, recompute-only, **forecast** truth) with its own `compute…Dto` (`loadLabourCoverageRequirements` → `LabourService.coverageFor(asOf=forecast)` → `deriveTeamReading`), the SEVENTH `REBUILDABLE_PROJECTIONS` entry + bootstrap registration + CLI factory; command authority (`start`) reads **execution** coverage in-tx, never the projection. `live == projection == rebuild` for the forecast dto by the one-shared-function construction.

### §H. Trusted workforce identity + authorization + containment + concurrency (F5/instruction 7)

- **`Worker` (new, first-class, project-contained)** — `{ projectId, id, name, tradeCode, skillCodes[], activeFrom, activeTo?, revokedAt?, revokedById? }`; a capacity source. **`Crew`/`Gang`** — a named set of workers under an in-charge (`mistri`), an atomic capacity source. **`WorkerDevice` binds to a `Worker` by FK** (F5): the field attendance token carries a `workerId` FK; free-text device `name`/`trade` are display-only and **never** readiness evidence. Attendance requires a Worker FK + an active device binding + evidence; the attendance evidence (selfie/GPS/QR) is project-contained and delete-sealed while cited (the media-disposable participant pattern).
- **Constraints (DB-enforced):** one attendance per `(projectId, workerId, civilDate, shift)` (partial-unique); no overlapping allocation per `(projectId, capacitySourceId, civilDate, shift)` (the §C `EXCLUDE`/partial-unique); a worker/crew allocated only within its active dates; cross-project worker/device references rejected by same-project composite FKs (a required forgery probe).
- **Containment.** Every labour operational row is project-contained; the `Vendor` party reaches a project only through `ProjectVendor`; same-project relational constraints for every cross-reference.
- **Permissions** (added to `ROLE_POLICY` + manifest + `@RolesFor`/`RolesGuard`, fail-closed; final set fixed at Task 1, pinned by permission-matrix tests): illustratively `labour.requirement.manage:[pmc]`, `labour.read:[pmc,engineer]`, `allocation.manage:[pmc,engineer]`, `attendance.record:[pmc,engineer,contractor]` (+ the worker-device self check-in path), `labour.commit.manage:[pmc]`, `labour.override:[pmc]`. `VendorLabourProfile` is org-admin authority (like `Vendor`). Minimal segregation-of-duty (request vs certify split) per spec §18; fuller SoD deferred.
- **Audit + concurrency.** Every labour command records via `recordAudit` with the resolved `Actor`; the same `Actor` feeds `emitEvent`. Concurrency = `lockProjectReadiness` + `FOR UPDATE` on the capacity source + the §C `EXCLUDE`/partial-uniques + §F CAS — no new lock primitive. Every state-changing command carries a client idempotency key through `executeCommand`.

### §I. Planned vs actual + productivity (F8/instruction 11)

- **Planned** = the requirement's `requiredHeadcount` person-shifts by activity/date/shift. **Actual attendance** = the `Attendance` facts. **Actual effort** = the `ActivityWorkOutput` worked-minutes / man-days fact. **Measured output** = an immutable `ActivityWorkOutput` `{ quantity, uom, evidence }` fact (NOT the Daily-Log photo/progress counter, F8). **Productivity** = measured output ÷ actual effort — a DERIVED read, never a stored column, recomputed from canonical facts. Variance (attendance vs planned, effort vs planned) feeds the forecast projection.
- **Productivity is the LAST task and is explicitly deferrable** — nothing else depends on it; if the reviewer prefers, Phase 4 ships planned-vs-actual (headcount + effort) and defers the output-based productivity metric until the measured-output fact is prioritised.

### §J. Frontend surfaces + offline/idempotent field ops (extend-vs-new)

- **ONE new Labour hub** (`LabourScreen.tsx`), capability-gated (`SCREEN_CAPABILITY:{ labour:'labour' }`), cloning the Materials hub (tabbed, honest `reading/unavailable/stale` states, server-plan single-command actions). Tabs: **readiness · demand · suppliers · commitments · allocation · attendance · productivity**.
- **Offline/idempotent field ops.** Every labour command (allocate, record attendance, record work, raise labour requisition) dispatches ONE write-ahead outbox op with a fresh `newIdempotencyKey()` + a deterministic coalesce key (a new `labourKeys.ts` mirroring `materialsKeys.ts`), coalesced while pending, retried under the same key on a lost response, terminal-drop reconciled, scope-guarded, hydration-normalised — the PR-#208/#209 lifecycle. Attendance capture (GPS/selfie/QR) reuses the daily-log field-capture + the durable client outbox so an offline muster replays exactly once.

| Surface | File | Phase 4 |
|---|---|---|
| Labour hub (readiness/demand/suppliers/commitments/allocation/attendance/productivity) | `apps/web/src/screens/LabourScreen.tsx` | **NEW** (clone of `MaterialsScreen`) |
| Capability gate + nav | `apps/web/src/lib/screens.ts` | EXTEND — `labour` `SCREEN_META`/`SCREEN_CAPABILITY`, `screensFor` pmc/engineer |
| Store labour slice + reads/commands | `store/store.ts`, new `store/labour.ts`, `data/apiGateway.ts`, new `lib/labourKeys.ts` | EXTEND pattern — NEW parallel slice/reads/`OutboxOp` variants |
| Site Schedule Team gate | `screens/ScheduleScreen.tsx`, `store/selectors.ts gatesFor` | EXTEND — the `T` dot becomes **derived** (execution truth) when the capability is on |
| Daily Log attendance | `screens/DailyLogScreen.tsx`, `modals/QrModal.tsx` | EXTEND — per-worker `Attendance` (Worker FK + device binding); the aggregate `CrewRow` stays display-only |
| Team roster | `screens/TeamScreen.tsx` | EXTEND — `Worker`/`Crew`/in-charge section |
| Team Access onboarding | `screens/TeamAccessScreen.tsx` | EXTEND — worker/crew onboarding + device binding reuses trade pickers |
| Inbox | `store/selectors.ts selectActionItems` | EXTEND — NEW `labour-shortage` card (clone of `material-shortage`, `screen:'labour'`, forecast impact) |
| i18n | `packages/shared/src/i18n/dictionary.ts` | EXTEND — labour labels + trade/skill rows, en/hi/gu |

**No genuinely new screen beyond the ONE Labour hub.**

---

## Required Execution Order and Review Stops

One task = one held PR; the full battery gates every PR; reproduce-first tests (RED→GREEN) for every invariant; additive + diagnostic-first migrations; `upgrade-proof.sh` extended. **A mandatory narrow review stop after Task 4** (instruction 12), plus stops after Tasks 1 and the final task.

1. **Labour capability + type-routed demand + trusted workforce identity (§B/§D/§H).** The `'labour'` capability + capability-off byte-identity proof; type-based requirement routing (material→`materials`, labour→`labour`) with the immutable root `type`, the DB type↔detail correspondence, and `LabourParticipant.writeRequirementSpec`; `LabourRequirementSpec` (+ `labourSpecFingerprint`, immutability); `LabourTrade/Skill`; first-class `Worker`/`Crew` with active dates + revocation + `WorkerDevice`→`Worker` FK binding; labour event family; shared contracts + `labour.read` policy. **Review stop.**
2. **Supplier reuse + labour commitment documents (§F).** `VendorLabourProfile` on the existing `Vendor`; `LabourRfq→quote→comparison→LabourPO(+version)→CapacityCommitment(+promise)`; §F bounds 1–2; frozen rate snapshots; append-only promises; the requirement→requisition bound under a barrier race.
3. **Time-capacity conservation: commitment + allocation + attendance + actual-work facts (§C).** The four immutable fact families with DISTINCT units; the source-level global conservation (`EXCLUDE`/partial-unique on `(project, capacitySource, civilDate, shift)`); one-attendance-per-worker/date/shift; §F bound-3 (committed/allocated ≤ ordered+overage) via the labour-supplier participant lock; source-command provenance; the **competing-activity crew race**, duplicate-allocation, and duplicate-attendance proofs under a deterministic barrier.
4. **Canonical labour coverage + the Team gate + combined readiness + the seventh projection (§A/§G).** `LabourService.coverageFor(asOf)`; `deriveTeamReading`; `activities.start` reads **execution** truth in-tx and composes the five-gate verdict, rejecting `gateTeam` mutation when the capability is on; the §A tripwire extended (22→new count); the `LabourReadinessProjection` (forecast, recompute-only); the execution-vs-forecast tables, the material-ready/labour-blocked start refusal, the requirement-revision-invalidation, and all §A concurrency races; `live == projection == rebuild`. **MANDATORY narrow review stop — before Daily-Log and frontend integration.**
5. **Daily-Log reconciliation (§E) + planned-vs-actual + productivity (§I).** The per-worker attendance read + `LabourMismatch` fact + pmc-only resolution (append-only, activity-block clear); the aggregate `CrewRow` made display-only on pilot projects; the immutable `ActivityWorkOutput` fact + planned-vs-actual + the (deferrable) productivity read.
6. **Frontend surfaces + pilot acceptance chain + consolidated Phase-4 packet (§J).** The Labour hub + the extended Schedule/DailyLog/Team/Inbox/TeamAccess surfaces + the `labour-shortage` Inbox action + offline/idempotent field ops; the real-browser live-PG acceptance chain (labour requirement → supplier commitment → allocation → same-day attendance → **execution Team gate green** → combined start → work-output → productivity) in BOTH capability states; the §25 mapping packet. **Final review stop.**

The principal Phase-4 vertical acceptance test: *labour requirement → comparison and labour-PO → capacity commitment → allocation → same-day attendance → labour execution-readiness green → combined material+labour start → recorded work → productivity*, proven end-to-end in a real browser on a pilot project, and provably inert on a non-pilot project.

## Required plan probes (every one reproduce-first, live PG unless noted)

Competing-activity crew race (two activities, one worker, same date/shift → exactly one wins); duplicate worker allocation rejected; duplicate attendance rejected; cross-project worker/device forgery rejected; requirement-revision invalidation (a shift/trade/skill revision strands the old-fingerprint allocation, activity re-derives); future-vs-today truth tables (forecast `ready` on allocation; execution `wait` until present); material-ready/labour-blocked start refusal; capability-off byte identity; projection `live == rebuild`.

---

## Out of scope (Phase 4)

Payroll and worker payment (a labour-cost input to Phase 5, not a payroll system — spec §14). Biometric identity beyond the existing selfie/QR device path. Org-level shared workforce pools across projects (Stage-2 scaling). Equipment readiness (a later `type='equipment'`). Commercial certification of labour bills (Phase 5). Nothing changes Phases 1–3 owners, schemas or verdicts; the Team gate is the only readiness change and it is capability-gated (non-pilot projects byte-identical).

## Verification battery (every PR)

`pnpm check` EXIT 0 (web + API + shared). Live-PostgreSQL integration: domain, **permission-matrix**, event-contract, **projection rebuild (live == projection == rebuild)**, cross-project/cross-org **isolation**, migration, and the §A/§C/§F **concurrency races** (both orderings under lock/`EXCLUDE`/CAS). `apps/api/scripts/upgrade-proof.sh` EXTENDED with labour fixtures + `assert_rejects` (labour tables/constraints exist and wrote ZERO rows over the legacy DB; hostile inserts — cross-project allocation, double-allocation, double-attendance, forged worker/device, over-bound commitment, forged fingerprint — rejected by the DB seals). `test:e2e:api:allmodules` + `:outbox` (the acceptance chain, both sender modes + both capability states). Reproduce-first RED→GREEN for every invariant; the cross-module-graph + lock-coverage + manifest-registry tripwires updated in the same PR that changes them. Additive migrations only; each diagnostic-first (ABORTS on ambiguous legacy data); Prisma-inexpressible constraints (partial-uniques, `EXCLUDE`, CHECKs, append-only + immutability triggers, type↔detail triggers, composite FKs) as raw SQL; legacy databases upgrade row-free.

## Vision alignment

Phase 4 completes the readiness promise (spec §11/§14): an activity is executable only when its demand is met on **every** dimension for the **same** activity and date. Phase 3 gave the Material gate canonical, transactional, lock-protected truth over *stock*; Phase 4 gives the **Team** gate the identical discipline over *expiring, time-bounded capacity* — conserved at the worker/crew source per civil date and shift, observed (not transferred) as attendance and work, split into deterministic execution and forecast truth, and derived entirely from canonical facts when the pilot is on. "Material is here but the crew is not," and "the crew is here but the material is not," both surface as an honest, forecast-bearing, Inbox-actionable block **before** a day of work is lost. It reuses the cleared spine — the type-neutral requirement, the readiness lock, the coverage-authority + shared-verdict-map pattern, the command ledger, the outbox + event catalog, the rebuildable projection, the `Vendor` party, the participant channel, and the capability-gated module-owned frontend — so labour readiness is a thin, correct parallel of proven machinery, not a mis-modelled copy of stock. One fact keeps one owner; command authority reads canonical facts under the project readiness lock, never a projection; the pilot is provably inert off-capability; and every physical-truth invariant — global capacity conservation, one-attendance-per-worker, no-overlapping-allocation, fingerprint-pinned satisfaction, type↔detail correspondence — is enforced by PostgreSQL, not convention.

---

_Docs-only round-1 correction. The narrow re-review is the next stop; Phase 4 Task 1 does not begin until this plan is cleared and JagPat gives an explicit implementation GO._
