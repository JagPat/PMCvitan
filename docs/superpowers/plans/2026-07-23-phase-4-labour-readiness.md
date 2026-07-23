# Phase 4 — Labour Readiness

**Status: PLANNING (docs-only). Awaiting independent Codex architecture review. No implementation code in this PR; Phase 4 Task 1 does not begin until this plan is CLEARED and JagPat gives an explicit implementation GO.**

Planning baseline: `JagPat/PMCvitan` `main` @ `5c34d5b` (Phase 3 CLEARED — GREEN SIGNAL at PR #210). This plan **builds on** the cleared Phase 1–3 platform and **explicitly does not rewrite or duplicate** any of it. Every Phase-4 structure named below is a parallel of, or an additive extension to, an existing cleared structure, cited by file path in "Current-State Revalidation".

Vision source of truth: `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` — §11 (Activities and Requirements — the `ActivityRequirement.type` contract already lists `labour`), §14 (Labour), §17 (Automation — "crew commitment and attendance update labour readiness"), §24 Phase 4 + Phase Intent Map row 4, §25 (Pilot Acceptance — "supply/labour shortages produce forecast impact and Inbox actions").

---

## Phase Intent (restated per the spec's Phase Intent Map, row 4)

- **Why now:** material availability alone does not make work executable; crew demand, commitment and attendance must align with the same Activity and date.
- **What changes:** planned crew demand, contractor/supplier commitment, allocation, attendance and productivity determine **labour readiness** (the fourth gate, "Team") and expose **material-vs-labour mismatches** before work is lost.
- **What it unlocks:** cost and payment evaluation (Phase 5) require actual labour and progress evidence, not only plans.

Phase 4 fills the **Team** readiness gate — today a stored stub — with the same canonical, transactional, lock-protected discipline Phase 3 gave the **Material** gate, and joins the two into one activity-start verdict.

---

## Facts consumed from earlier phases (the cleared spine Phase 4 reuses, never rebuilds)

Phase 4 is a thin, parallel module over machinery that is already merged and independently cleared:

1. **Type-neutral demand contract.** `ActivityRequirement` is append-only, revisioned, root-anchored, CAS-guarded, with server-resolved decision provenance, and its `type` enum **already contains `labour`** (Phase 3 Task 1 made it type-neutral for exactly this phase). Labour demand is a `type='labour'` revision row with a labour-specific detail table — the material machinery is reused, not copied.
2. **The five-gate readiness model + the readiness lock.** `deriveReadiness` composes five gates (`decision · material · team · inspection · drawing`); `readinessReady` requires all five; `lockProjectReadiness(projectId)` serialises every readiness-affecting write; the §A lock-coverage tripwire enumerates the exact command set. The **Team gate is presently the one remaining stored stub** (`source:'stored'`).
3. **Canonical coverage authority pattern.** `InventoryService.coverageFor(tx, projectId, requirements)` returns a per-requirement `ready | at-risk | blocked` verdict, read **in-tx under the lock** by `activities.start`; `deriveMaterialReading` is the single shared verdict→gate map reused by start, read-bake and projection so live == projection == rebuild.
4. **Platform kernel.** Command ledger (`executeCommand`, idempotency, source-command provenance), durable outbox (`emitEvent` + the shared `DOMAIN_EVENT_TYPES` catalog + external-effect catalog + reseal gate), generation-swap rebuildable projections (six today), per-project capability activation (`ProjectCapability` + `capability:enable`), canonical audit (`recordAudit` + `Actor`), membership-authoritative auth, and the additive + diagnostic-first migration convention proven by `upgrade-proof.sh`.
5. **Org-party tenancy + supply state machines.** `Vendor(orgId,id)` + `ProjectVendor` dual-composite-FK containment; the procurement CAS chain (requisition → RFQ → quote → comparison → PO → delivery commitment) with the three §F allocation bounds and frozen versioned snapshots; the immutable §C stock ledger (append-only, bucket-fold, no current-quantity column, reversal-inverse, `FOR UPDATE` + readiness lock + refuse-negatives); the cycle-exempt cross-module **participant** channel.
6. **Frontend module-owned pattern.** The capability-gated Materials hub (honest load states, `SCREEN_CAPABILITY`, `enabledScreensFor`), the durable write-ahead outbox client (`runWriteAhead`, `newIdempotencyKey`, coalesce keys, terminal-drop reconcile), and the Inbox action-queue (`selectActionItems`, the `material-shortage` card).

Phase 4 adds a **labour** module that parallels each of these for the Team gate. **No existing owner moves; no primitive is duplicated.**

---

## Current-State Revalidation (against `main` @ `5c34d5b`)

Grounded from a four-way source read of the working tree. Exact anchors the tasks build on:

**Readiness spine.** `apps/api/prisma/schema.prisma`: `ActivityRequirementRoot` (project-contained lineage, `@@unique([projectId,id])`), `ActivityRequirement` (`type RequirementType @default(material)`; enum `RequirementType` = `material · labour · equipment · decision · drawing · inspection`; append-only, `@@unique([projectId,requirementId,revision])`), `MaterialRequirementSpec` (material-only detail hanging off the `(projectId,requirementId,revision)` triple). `Activity.gateMaterial/gateTeam/gateInspection : GateState` (stored gate columns); `enum GateState { ok wait fail na }`. `RequirementsService` (`apps/api/src/activities/requirements.service.ts`) `create/revise/cancel` — capability-gated, `lockProjectReadiness` + `lockRootHead` CAS + append-only, provenance via `decisionsQuery.approvedRef`. `InventoryService.coverageFor` (`apps/api/src/inventory/inventory.service.ts`) + `coverage.ts` types. `deriveMaterialReading` (`apps/api/src/activities/material-readiness.ts`) — `VERDICT_TO_GATE = { blocked:'fail', 'at-risk':'wait', ready:'ok' }`, `SEVERITY fail>wait>ok>na`, mismatch-first, zero-requirements→`na`. `deriveReadiness` (`packages/shared/src/domain/readiness.ts`) — the **Team gate is `{ v: input.gateTeam, source:'stored', reason:'Stored site flag — team present' }`** (the seam Phase 4 replaces); `OverridableGate` already includes `'team'`. `activities.service.ts` `start` — after `lockProjectReadiness`, replaces the stored material gate with live `coverageFor` only when the capability is on and no unexpired override wins (lines ~348–350; the identical insertion point for the Team gate). `lockProjectReadiness` (`apps/api/src/common/readiness-lock.ts`) — `pg_advisory_xact_lock`. The §A tripwire `apps/api/src/common/readiness-lock-coverage.test.ts` — `SECTION_A_COMMANDS` asserts exactly **22** locked commands. `MaterialReadinessProjection` — the **sixth** rebuildable projection (`apps/api/src/activities/material-readiness.projection.ts`, recompute-only, no event on rebuild); `REBUILDABLE_PROJECTIONS` (`apps/api/src/platform/projections/rebuild-operations.ts`).

**Platform primitives.** `executeCommand` + `CommandExecution` (`apps/api/src/platform/commands.ts`; `synthesizeKeyWhenAbsent`, `COMMAND_KEY_ENFORCED` evaluated before synthesis; `CommandRunContext.commandId` threaded into `run`). `emitEvent` (`apps/api/src/platform/events.ts`) + shared `DOMAIN_EVENT_TYPES` (`packages/shared/src/platform/events.ts`) + `EXTERNAL_EFFECTS` (`apps/api/src/platform/external-effects.ts`, `effectCoverageVersion` reseal) + relay/registry/`OutboxDelivery`/cutover seal. Projection base (`generation.ts`, `rebuilder.service.ts`, `projection-rebuild.cli.ts`). `CapabilitiesService` + `ProjectCapability` + `capability.cli.ts` (`MATERIALS_CAPABILITY='materials'`); shell `capabilities:string[]` (`apps/api/src/snapshot/project.controller.ts`). `recordAudit` + `Actor/actorKind` (`apps/api/src/platform/audit.ts`, `apps/api/src/common/actor.ts`). Membership-auth (`apps/api/src/common/auth.ts`, `project-access.service.ts`); `Membership.role` + `.discipline`. `Vendor(orgId,id)`/`ProjectVendor` dual-composite-FK (`schema.prisma`; migration `20261218000000_phase3_procurement`). `upgrade-proof.sh`.

**Procurement/inventory state machines.** `Requisition/RequisitionLine/Rfq/VendorQuote/QuoteComparison/PurchaseOrder/PurchaseOrderVersion/PurchaseOrderLine/DeliveryCommitment/DeliveryPromise`; CAS via `updateMany(id,projectId,status)`; §F bounds 1–3 (`procurement.service.ts assertAllocationFits`, `purchase-orders.service.ts lockLineAndAssertOrderFits`, `procurement.participant.ts assertReceiptFits`); frozen line snapshots + `phase3_po_line_frozen` trigger; append-only `DeliveryPromise` (`seq`, `CHECK seq=1 OR reason NOT NULL`). Inventory §C: `StockLot`/`StockTransaction` (append-only, no current-qty; `foldBuckets` per `(projectId,storeLocation,stockLotId)`; movement CHECKs; `phase3_stock_reversal_inverse`; `lockLot` FOR UPDATE + readiness lock + `assertMovementLegal` refuse-negatives; bound-3 via `ProcurementParticipant.lockPoLineForReceipt`/`applyReceiptProgress`). Cross-module `*.participant.ts` (owner-aligned, leaf, cycle-exempt); `cross-module-graph.test.ts` (`MODEL_OWNER`, zero foreign writes); manifests (`ownsModels/producesEvents/dependsOn/workflowParticipants/permissions`).

**Frontend surfaces.** `MaterialsScreen.tsx` (tabbed, honest `reading/unavailable/stale` states, server-plan cover actions); `lib/screens.ts` (`SCREEN_META/SCREEN_CAPABILITY/SCREEN_MODULE/enabledScreensFor/screensFor`); store (`capabilities`, `materialsPending`, `loadMaterials`, `dispatchMaterials`, `runWriteAhead`, `flushOutbox`, `hydrateOutbox`); `apiGateway.ts` (module reads + `cmd()` idempotency + `OutboxOp`/`replayOutboxOp`/`newIdempotencyKey`); `lib/materialsKeys.ts` (coalesce keys). `TeamAccessScreen.tsx` (who/trade/phone/otp/badge/jobcard/tradehome; `Worker`, `pickWorker`→`workerToken`; `WorkerDevice` lives API-side only). `TeamScreen.tsx` (members/roster/companies; `ROLES`, discipline). `DailyLogScreen.tsx` + `modals/QrModal.tsx` (check-in GPS/selfie, `CrewRow{trade,count}` steppers, QR self check-in, `selectTotalWorkers`). `ScheduleScreen.tsx` + `selectors.ts gatesFor` (FIVE dots `D/M/T/I/DRW`; Team `T` = stored `a.gt`; `OVERRIDE_GATES` includes `team`). `selectors.ts selectActionItems` (`material-shortage`). i18n `packages/shared/src/i18n/dictionary.ts` (`accessDict` en/hi/gu, `tradeLabels`, `workerTradeLabels`) + `useT`.

**Two premise corrections carried into the design:** (a) the requirement contract is already type-neutral, so **no schema widening is needed to represent labour demand** — only a labour detail table; (b) the schedule already renders **five** gates including Drawings, so "Team" is one of five, not one of four.

---

## Architecture (the design decisions, explicit)

Ten decisions, §A–§J. Each states the invariant, the reused mechanism, and — where a reviewer would probe correctness — a truth table or constraint.

### §A. Labour-readiness truth + combined activity readiness + lock protocol

**Command authority is canonical, transactional and locked — never the projection.** A new `LabourService.coverageFor(tx, projectId, requirements)` (shape-identical to inventory's) returns a per-labour-requirement `ready | at-risk | blocked` verdict; `activities.start` (and any command whose guard consults the Team gate) calls it on the SAME transaction client, after `lockProjectReadiness(tx, projectId)` — the **same lock** material coverage already takes, so a labour attendance/allocation write and a material reservation write on one project serialise on one advisory lock and `start` sees a consistent snapshot of BOTH gates. A `deriveTeamReading` sibling of `deriveMaterialReading` maps the verdict to the gate; the labour-readiness projection (§G) feeds UI/Inbox/Dashboard/forecast ONLY.

**Team-gate replacement.** `deriveReadiness` (`readiness.ts`) currently hard-codes `team: { v: input.gateTeam, source:'stored', … }`. Phase 4 replaces the *literal* with a derived reading exactly as `material` is layered in `activities.service.ts start` (capability-gated; an unexpired `GateOverride{gate:'team'}` still supersedes; the stored `gateTeam` flag remains a first-match `fail` for an unresolved muster mismatch, §E). No new gate, no new override mechanism.

**Labour coverage verdict — per requirement, evaluated in-tx (§C buckets):**

| Verdict | Definition (planned window `[requiredBy − duration, requiredBy]`, trade/skill-matched) | `gt` |
|---|---|---|
| `ready` | crew of the required trade/skill **allocated** to THIS activity ≥ required headcount for the window **AND**, when the window includes the civil today, **present** (same-day verified attendance) ≥ required — allocation without same-day attendance on the day is not yet ready (spec §11: "committed allocation AND same-day verified attendance") | `ok` |
| `at-risk` | shortfall covered only by a confirmed supplier **deployment-commitment** dated before `requiredBy`, OR allocated for a FUTURE window not yet arrived (attendance verified on the day) | `wait` |
| `blocked` | shortfall with no covering allocation or commitment, OR an unresolved muster mismatch (§E) | `fail` |
| `not-required` | no `type='labour'` requirement for the activity | `na` |

Worst-wins across the activity's labour requirements (`SEVERITY fail>wait>ok>na`); mismatch-first (evaluated before coverage). Deployed/worked crew counts as coverage for the activity that consumed it — the labour analogue of the §A guardrail "issued material counts as coverage" (deploying allocated crew must never make the activity artificially unready).

**Combined material-and-labour activity readiness.** The Material gate and Team gate are **independent derived gates**; the activity's overall readiness is the existing `readinessReady` = all five gates `ok`. No new joint computation — the composition is the existing worst-gate rule. The Material × Team subset (other three gates held `ok`), directly answering "material available but labour not, or vice versa":

| Material gate | Team gate | `activities.start` | Surfaced reason / forecast |
|---|---|---|---|
| `ok` | `ok` | **allowed** | ready |
| `ok` | `wait` | refused | **material available, labour AT-RISK** — crew committed, not yet mustered/arriving |
| `ok` | `fail` | refused | **material available, labour BLOCKED** — no covering crew/commitment |
| `wait` | `ok` | refused | labour available, **material at-risk** |
| `fail` | `ok` | refused | labour available, **material blocked** |
| `wait` | `wait` | refused | both at-risk |
| `fail` | `fail` | refused | both blocked |
| `na` | `ok` | allowed¹ | labour-only activity; no material demand |
| `ok` | `na` | allowed¹ | material-only activity; no labour demand |

¹ subject to the other three gates. A `pmc` override on either gate supersedes its row (authority + reason + evidence + expiry, unchanged).

**Lock-coverage extension (the §A tripwire).** Every Phase-4 command that can move the Team gate takes `lockProjectReadiness` and is added to both `COVERAGE` and `SECTION_A_COMMANDS` in `readiness-lock-coverage.test.ts`, bumping the `toHaveLength(22)` assertion — an uncovered labour command is a failing test, not a review finding. New §A commands: labour-requirement `{create,revise,cancel}`; labour-supplier deployment-commitment `{commit,revise,default,fulfil,closeShort}`; allocation `{allocate,release}`; attendance `{muster,markAbsent}`; deployment `{deploy,reverse}`; adjustment; muster-mismatch resolution. (The exact final count is set by Task 4 and pinned by the test.)

**Concurrency probes (all in the readiness-connect task, live PG, both orderings under the lock):** allocation-release vs `start`; attendance-muster vs `start`; labour-requirement revision vs `start`; deployment vs `start`; supplier-commitment default vs `start` — each proves either order serialises and the loser observes the winner's state; plus the cross-gate probe: a material reservation and a labour muster on the same activity/project serialise on the one lock and `start` sees a consistent five-gate snapshot.

### §B. Labour demand identity + units + trade/skill taxonomy

| Element | Definition |
|---|---|
| Demand row | `ActivityRequirement { type:'labour' }` — the SAME append-only, root-anchored, CAS-guarded, provenance-carrying revision row material uses. `requiredQty`/`baseUom` carry the labour quantity + unit; `requiredBy : Date`; `responsible` (membership FK); `criticality`; `tolerance`. Provenance is server-resolved (the governing decision/plan), never caller-authored. |
| `LabourRequirementSpec` (new, one per labour revision) | The labour-only detail hanging off `(projectId, requirementId, revision)` (the exact FK triple `MaterialRequirementSpec` uses): `{ tradeCode, skillCode?, crewSize, shift, plannedManDays: Decimal, workWindowDays: Int }` — written once at revision creation, immutable by trigger (the `MaterialRequirementSpec` immutability pattern). A spec change appends a new revision (§F CAS), never an update. |
| Unit (`baseUom`) | one canonical labour unit per requirement — **`man-day`** (`Decimal numeric(18,6)`) for effort, or **`headcount`** (`nos`) for muster-count requirements; declared once per requirement, ledger + coverage arithmetic run in that unit only. No cross-unit conversion (labour has no purchase-UOM/base-UOM split — this is a deliberate simplification vs material §B). |
| Trade/skill taxonomy | `tradeCode`/`skillCode` reference a project- or org-scoped `LabourTrade`/`LabourSkill` reference table seeded from the existing trade label maps (`tradeLabels`, `workerTradeLabels`); en/hi/gu labels reuse the i18n dictionary. A trade is the coarse pool (mason/electrician/…); a skill is an optional finer competency. |
| Satisfaction rule | crew satisfies a labour requirement when its `tradeCode` matches AND (if the requirement names a `skillCode`) the crew carries that skill. **Skill-substitution** (a higher skill covering a lower requirement) is modelled as an ACTIVE, pmc-authored, audited, event-bearing `ApprovedSkillSubstitution { requirementId, fromSkill, toSkill, … revokedAt? }` — the exact revocable-substitution shape material §B uses, resolved by the activities caller into `acceptableSkills` and passed to `LabourService.coverageFor` (labour never reads the substitution table — keeps the graph acyclic, §G). If skill-substitution proves out of scope for the pilot, Task 1 ships trade-exact matching only and the substitution table is deferred — the reviewer decides. |

### §C. Labour deployment ledger conservation (parallels inventory §C)

Labour supply is tracked in an **immutable, append-only ledger** with **no current-headcount / current-man-day column anywhere** — every bucket is a fold over the ledger, exactly like `StockTransaction`. This preserves the audit-first, conservation-guaranteed property material earned.

- **`Crew`/`Muster` identity (new).** A received/committed crew batch is a `CrewCommitmentLot` (analogue of `StockLot`) — immutable, carrying its supplier/labour-PO/commitment provenance FKs and its trade/skill identity; NO quantity column. Man-days/headcount live only in the ledger.
- **`LabourTransaction` (new, append-only).** Moves `qty` (man-days or headcount) from `fromBucket` → `toBucket` for a `(projectId, activityId, requirementId?, date, shift)` key, citing `sourceCommandId` (the `CommandExecution`, §D reuse). Immutable by trigger; `qty > 0` CHECK; per-type shape CHECKs (the §C movement-equation pattern).
- **Buckets per labour key** (all folded, no stored column):

| Bucket | Meaning | Material analogue |
|---|---|---|
| `committed` | supplier deployment-commitment headcount/man-days inbound (before allocation) | inbound commitment |
| `allocated` | crew claimed (reserved) to a NAMED activity for a date/shift | `reserved` |
| `present` | same-day verified attendance (muster) of allocated crew | `acceptedOnHand` |
| `deployed` | man-days actually worked on the referenced activity | `issuedToActivity` |
| `released` / `no_show` | allocation released, or committed-but-absent | (freed headroom) |
| derived `availableForActivity` | `allocated + present + deployed` for the activity (present verifies same-day; deployed counts as coverage) | `reserved + issued` |

- **Movement legality.** Every command begins `lockProjectReadiness`, then `SELECT … FOR UPDATE` on the affected `CrewCommitmentLot` (the §C rule-i per-key lock), re-derives the touched buckets from the ledger + candidate, and **refuses any negative bucket** (`assertMovementLegal` analogue). Reversals are trigger-verified exact inverses, reversible at most once (`phase3_stock_reversal_inverse` analogue).
- **`allocate`** consumes `committed`→`allocated` (the §C `freeAvailable ≥ qty` guard is the fold refusal); **`muster`** (attendance) moves `allocated`→`present`; **`deploy`** moves `present`→`deployed` against the referenced activity (the deploy CHECK arms cannot name a non-activity bucket — structural no-double-count); **`release`**/**`markAbsent`** free headroom; **`adjust`** needs a reason. Attendance is a `muster` row, NOT a `deploy` row — "attendance is not deployment" (the §E-canonical distinction, mirroring "an issue is not a delivery").

### §D. Pilot activation (parallels material §D)

A new `'labour'` capability string. Every labour route calls `capabilities.assertEnabled(projectId, 'labour')` (404 off-pilot); the shell adds `'labour'` to `capabilities[]`; `SCREEN_CAPABILITY` gates the Labour screen; the SAME `capability:enable` operator CLI turns it on for a pilot project. Off-pilot the module is provably inert — no route, no nav, no event, no gate change (`gateTeam` stays the stored stub) — byte-for-byte identical to today. A Task-1 inertness proof (two projects, one org: labour enabled on one, absent on the other; the other's Team gate + readiness unchanged) mirrors the material Task-1 proof.

### §E. Daily-Log reconciliation (attendance ↔ allocation; parallels material §E)

- **The aggregate stays.** `DailyLog.crew` (`CrewRow{trade,count}` steppers, `selectTotalWorkers`, QR self check-in) is the site's daily muster headline and is **not fabricated or removed**; the non-pilot daily-log response stays byte-identical.
- **Per-worker attendance feeds readiness.** On a pilot project, an attendance `muster` row (per-worker or per-crew, tied to an allocation) is the canonical labour presence fact the Daily-Log READS from the labour module's contract (the `stock.issues`-style read: identity joined, custody derived, nothing copied into daily-log rows). Attendance without allocation to an activity does not imply availability (spec §14).
- **Muster mismatch resolution.** When mustered crew does not match the allocated/required trade/skill (e.g. a plumber mustered against a masonry allocation), a `daily-log.resolveMismatch`-style, pilot-gated, pmc-only command closes exactly ONE `matched:false` muster observation with an append-only, unique-per-observation resolution register row (the observation is never edited), and clears the activity's Team block through the labour participant ONLY when no unresolved muster mismatch remains — the stored `gateTeam` falling back to `wait` (never a fabricated `ok`). One `activity.labour_unblocked` signal (mirroring `activity.material_unblocked`).

### §F. Labour requirement + supplier-commitment state machines (parallels procurement §F)

For **subcontracted** crew, the commitment chain mirrors procurement exactly (in-house/direct allocation skips the supplier chain and allocates straight from a project workforce — see §H):

`LabourRequisition → approval → LabourRfq → SupplierQuote → crew comparison → LabourPurchaseOrder(+version) → DeploymentCommitment(+arrival promise) → muster/attendance → deployment`

- **Tenancy.** `LabourSupplier(orgId, id)` (org-level party, `@@unique([orgId,id])`, the ONE deliberate org-scoped exception like `Vendor`) + `ProjectLabourSupplier` dual-composite-FK binding (`(orgId,projectId)→Project(orgId,id)` AND `(orgId,supplierId)→LabourSupplier(orgId,id)`, so a cross-org binding is unrepresentable). Every downstream labour-supplier row reaches the supplier THROUGH the binding.
- **CAS machines.** Every transition is `updateMany(id, projectId, status)` — one winner, the loser gets a deterministic 409 (the procurement pattern verbatim).
- **Three allocation bounds** (the §F discipline, re-homed to labour):
  1. **requirement → requisition ≤ required headcount/man-days** (raise the ceiling with a requirement revision, never an override) — the `assertAllocationFits` analogue under `lockRootHead`/revision lock.
  2. **requisition → labour-PO ≤ remaining** — `FOR UPDATE` on the requisition line, sum live PO-line allocations, the `lockLineAndAssertOrderFits` analogue.
  3. **mustered/deployed ≤ committed + `approvedOverage`** — the §F bound-3 analogue enforced through a `LabourSupplierParticipant.lockCommitmentForMuster` + `applyMusterProgress` (one lock, one bound, one transaction, like `applyReceiptProgress`); `approvedOverage` settable only at PO issue/amend with a reason (DB CHECK).
- **Frozen rate snapshots + append-only arrival promises.** The labour-PO version freezes the commercial snapshot (rate per man-day, shift premium, `committedAmountBase`) with a column-freeze trigger (`phase3_po_line_frozen` analogue); amendment issues a NEW version retaining the prior verbatim (`supersedesVersion`); the deployment-commitment's expected-arrival history is an append-only `seq`-monotone promise register (`CHECK seq=1 OR reason NOT NULL`), the LATEST promise driving §A at-risk dating. Cancel only with zero mustered; else close-short with reason.

### §G. Module edges + event catalog (acyclic by construction; parallels §G)

- **New `labour` module** owns `LabourRequirementSpec`, `LabourTrade/Skill`, `CrewCommitmentLot`, `LabourTransaction`, the labour-supplier chain models, and (with procurement's precedent) the supplier commitment tables. `dependsOn: ['activities','decisions']` (reads requirement identity + provenance). Its `ownsModels/producesEvents/workflowParticipants/permissions` join `MODULE_MANIFESTS`; `cross-module-graph.test.ts` `MODEL_OWNER` gains the labour models and asserts zero foreign writes.
- **Acyclicity.** `activities → labour` is a read edge (`activities.start` calls `LabourService.coverageFor`), exactly like `activities → inventory`. The reverse write (`labour → activities`, e.g. an allocation validating its activity target, or clearing the Team block) goes through the **cycle-exempt `ActivityParticipant`** channel (`materialTarget`/`clearMaterialMismatchBlock` analogues → `labourTarget`/`clearLabourMismatchBlock`), so the `dependsOn` graph stays acyclic — the identical resolution inventory↔activities uses.
- **Event family** (added to the shared `DOMAIN_EVENT_TYPES` + `EXTERNAL_EFFECTS`, all `invalidate:true, push:null` signal-only, emitted via `emitEvent` inside the command tx): `labour_requirement.created/revised/cancelled`, `skill_substitution.approved/revoked` (if §B ships it), `labour_requisition.submitted/approved`, `labour_comparison.approved`, `labour_po.issued/amended/cancelled/closed_short`, `deployment.committed/revised/defaulted/fulfilled`, `labour.transacted` (one per ledger row), `muster.recorded`, `labour_mismatch.resolved`, `activity.labour_unblocked`. **Derived facts get NO event** — buckets are derived, and the labour-readiness projection derives no domain event (a rebuild emits zero events + zero notifications), the §G discipline verbatim. A catalog change forces an external-effect reseal.
- **The seventh rebuildable projection.** `LabourReadinessProjection` (per-project, recompute-only) with its own `compute…Dto` (`loadLabourCoverageRequirements` → `LabourService.coverageFor` → `deriveTeamReading`), registered as the SEVENTH `REBUILDABLE_PROJECTIONS` entry + bootstrap registration + CLI factory; command authority (`start`) still reads coverage in-tx, never the projection. `live == projection == rebuild` by the one-shared-function construction.

### §H. Workforce identity + authorization + containment + concurrency

- **Workforce identities.** In-house crew is a project-contained `Worker`/`CrewMember` roster row (trade/skill, optional link to the existing account-less `WorkerDevice` field identity used for attendance) grouped into a named `Crew`/`Gang` under an in-charge (`mistri`). Subcontracted crew belongs to an org-level `LabourSupplier` (the Vendor analogue), bound per project. The existing `WorkerDevice` + worker-token field-auth path is reused for attendance capture; no worker account is minted. (Org-level workforce sharing across projects is deferred to the Stage-2 scaling path, mirroring org warehouses; the pilot keeps in-house workforce project-contained.)
- **Containment.** Every labour operational row is project-contained (`projectId` + composite candidate keys); org-level parties (`LabourSupplier`) reach a project ONLY through the dual-composite-FK binding; same-project relational constraints for every cross-reference (the platform invariant). Project operational records never become global.
- **Permissions (added to `ROLE_POLICY` + manifest + `@RolesFor`/`RolesGuard`, fail-closed).** Illustrative matrix (final set fixed at Task 1, pinned by permission-matrix tests): `labour.requisition.submit: [pmc, engineer]`, `labour.requisition.approve: [pmc]`, `labour.manage: [pmc]`, `labour.read: [pmc, engineer]`, `allocation.manage: [pmc, engineer]`, `attendance.record: [pmc, engineer, contractor]` (+ the worker device path for self check-in), `labour.override: [pmc]`. `LabourSupplier` CRUD is **org-admin authority** (not in the project matrix), exactly like `Vendor`. Configurable segregation-of-duty (one person not requesting + mustering + certifying) is noted per spec §18; enforced minimally in the pilot (request vs certify split), fuller SoD deferred.
- **Audit attribution.** Every labour command records via `recordAudit` with the resolved `Actor` (`actorKind: human|system`); the same `Actor` feeds `emitEvent`, so audit and event agree on attribution. Worker-device attendance is attributed to the device identity + the mustering engineer.
- **Concurrency.** `lockProjectReadiness` (readiness serialisation) + `FOR UPDATE` lot/commitment locks (§C/§F) + CAS transitions (§F) — no new lock primitive. Every state-changing command carries a client idempotency key through `executeCommand` (source-command provenance on every ledger row via `synthesizeKeyWhenAbsent` for server-initiated rows).

### §I. Planned versus actual labour + productivity

- **Planned** = the labour requirement's `plannedManDays` (§B), by activity/date/shift. **Actual** = the `deployed` fold (§C man-days worked). **Productivity** = recorded output (progress quantity, joined from the activity/daily-log progress fact) ÷ actual man-days — a DERIVED read, never a stored/authoritative column, recomputed from canonical facts (the "no derived domain event" discipline). Variance (`actual − planned`, `productivity vs planned rate`) feeds the labour-readiness projection's forecast and the shortage forecast (an activity trending over-planned man-days with unfilled demand is a labour risk).
- **Future labour demand** (spec §14) = the sum of open (`allocated + committed` short of `required`) labour requirements across upcoming activities — a read projection for the Dashboard/portfolio, not an authoritative store.

### §J. Frontend surfaces + offline/idempotent field ops (parallels the Materials hub)

- **ONE new Labour hub screen** (`LabourScreen.tsx`), capability-gated (`SCREEN_CAPABILITY: { labour: 'labour' }`), cloning the Materials hub: tabbed, module-query panels with honest `reading/unavailable/stale` states, and server-plan-driven single-command actions. Tabs: **readiness · demand · suppliers · commitments · allocation · attendance · productivity**. A pmc/engineer planning surface (`screensFor('pmc'|'engineer')` gains `'labour'`).
- **Offline/idempotent field ops.** Every labour command (allocate, muster/attend, deploy, raise labour requisition, record consumption) dispatches ONE write-ahead outbox op with a FRESH `newIdempotencyKey()` + a deterministic coalesce key (a new `labourKeys.ts` mirroring `materialsKeys.ts`), coalesced while pending, retried under the same key on a lost response, terminal-drop reconciled, scope-guarded, and hydration-normalised — the exact PR-#208/#209 lifecycle. Attendance capture (GPS/selfie/QR) reuses the daily-log field-capture + the durable client outbox so a muster taken offline replays exactly once.

**Extend-vs-new (the explicit answer to "which screens are extended vs genuinely new"):**

| Surface | File | Phase 4 |
|---|---|---|
| Labour hub (demand/suppliers/commitments/allocation/attendance/productivity/readiness) | `apps/web/src/screens/LabourScreen.tsx` | **NEW** (clone of `MaterialsScreen`) |
| Capability gate + nav | `apps/web/src/lib/screens.ts` | EXTEND — add `labour` `SCREEN_META`/`SCREEN_CAPABILITY`, `screensFor` pmc/engineer |
| Store labour slice + reads/commands | `store/store.ts`, new `store/labour.ts`, `data/apiGateway.ts` | EXTEND pattern — NEW parallel slice, reads, `OutboxOp` variants, `labourKeys.ts` |
| Site Schedule Team gate | `screens/ScheduleScreen.tsx`, `store/selectors.ts gatesFor` | EXTEND — the `T` dot becomes **derived** from labour readiness (like `M`/`DRW`), not the stored `a.gt` |
| Daily Log attendance | `screens/DailyLogScreen.tsx`, `modals/QrModal.tsx` | EXTEND — per-worker/per-allocation muster feeding readiness; the aggregate `CrewRow` stays |
| Team roster | `screens/TeamScreen.tsx` | EXTEND — crew/gang + in-charge section (mirrors `CompaniesSection`) |
| Team Access onboarding | `screens/TeamAccessScreen.tsx` | EXTEND — labour identity/onboarding reuses trade pickers + `badge`/`jobcard`/`tradehome` |
| Inbox | `store/selectors.ts selectActionItems`, `screens/InboxScreen.tsx` | EXTEND — NEW `labour-shortage` card (clone of `material-shortage`, `screen:'labour'`) |
| i18n | `packages/shared/src/i18n/dictionary.ts`, `apps/web/src/i18n/useT.ts` | EXTEND — labour labels + any new trade/skill rows, en/hi/gu |

**No genuinely new screen is required beyond the ONE Labour hub.** Everything else extends a cleared surface.

---

## Required Execution Order and Review Stops

One task = one held PR; the full verification battery gates every PR; reproduce-first tests (RED before, GREEN after) for every invariant. Additive migrations only; each is diagnostic-first and `upgrade-proof.sh` is extended (never widened destructively). **Review stops after Tasks 1, 3, and the final task** (mirroring the Phase-3 cadence; the reviewer may re-cut the stops).

1. **Labour capability + demand + workforce identity + taxonomy.** The `'labour'` capability (§D) + inertness proof; `LabourRequirementSpec` on the type-neutral requirement (§B) with immutability triggers, server-resolved provenance, CAS revisions; `LabourTrade/Skill` taxonomy seeded from the trade maps; project-contained `Worker`/`Crew`/in-charge identities linked to `WorkerDevice` (§H); the labour event family registered (§G); shared contracts + `labour.read` policy; the two-projects-one-org inertness proof (Team gate + readiness unchanged off-pilot). **Review stop.**
2. **Labour-supplier tenancy + commitment chain (§F).** `LabourSupplier(orgId,id)` + `ProjectLabourSupplier` dual-composite-FK; `LabourRequisition→RFQ→quote→comparison→LabourPO(+version)→DeploymentCommitment(+promise)`; §F bounds 1–2; frozen rate snapshots; append-only arrival promises; the labour-supplier event set; the requirement→requisition bound proven under a barrier race.
3. **Labour deployment ledger (§C) + allocation + attendance + deployment + §F bound-3.** `CrewCommitmentLot` + append-only `LabourTransaction` (movement CHECKs, reversal-inverse, no current-qty), the generic fold, per-key `FOR UPDATE` + readiness lock + refuse-negatives; `allocate/release`, `muster/markAbsent`, `deploy/reverse`, `adjust`; bound-3 (`mustered/deployed ≤ committed + approvedOverage`) via the labour-supplier participant lock; source-command provenance on every row; the §C conservation + both bound-3 race shapes under a deterministic barrier. **Review stop (Tasks 2+3 reviewed together, as Materials Tasks 4+5 were).**
4. **Canonical labour coverage + the Team gate + combined readiness (§A) + the seventh projection (§G).** `LabourService.coverageFor` (in-tx, lock-held); `deriveTeamReading`; `activities.start` reads it and composes the five-gate verdict; the §A lock-coverage tripwire extended (22 → new count) with the command-level enumeration; the `LabourReadinessProjection` (recompute-only, no event on rebuild); the combined material×labour truth-table probes + the cross-gate + all §A concurrency races. **Review stop candidate (the reviewer may fold this into the final stop).**
5. **Daily-Log reconciliation (§E) + planned-vs-actual + productivity (§I).** The attendance↔allocation read, muster-mismatch resolution (pmc-only, append-only, activity-block clear), the planned-vs-actual + productivity read model + future-demand projection.
6. **Frontend surfaces + pilot acceptance chain + consolidated Phase-4 review packet (§J).** The Labour hub + the extended Schedule/DailyLog/Team/Inbox surfaces + the `labour-shortage` Inbox action + offline/idempotent field ops; the real-browser live-PG acceptance chain (labour requirement → supplier commitment → allocation → attendance/muster → **Team gate green** → combined-readiness start → deployment → productivity) in BOTH capability states; the §25 mapping packet. **Final review stop.**

The principal Phase-4 vertical acceptance test (extending the spec §21 material chain): *labour requirement → comparison and labour-PO → deployment commitment → allocation → same-day muster → labour readiness becomes green → combined material+labour start → deployment → Daily-Log actual → productivity*, proven end-to-end in a real browser on a pilot project, and provably inert on a non-pilot project.

---

## Out of scope (Phase 4)

Payroll, wage rates as payable amounts, and worker payment (a labour-cost input to Phase 5 Commercial Control, not a payroll system — spec §14). Biometric/face-recognition identity beyond the existing selfie/QR device path. Org-level shared workforce pools across projects (Stage-2 scaling path). Equipment readiness (a later `type='equipment'` requirement). Commercial certification of labour bills (Phase 5). Nothing in this plan changes Phases 1–3 owners, schemas or verdicts; the Team gate is the only readiness change and it is capability-gated (non-pilot projects unaffected).

---

## Verification battery (every PR)

- `pnpm check` EXIT 0 (web + API + shared: lint, typecheck, unit, build).
- Live-PostgreSQL integration tests: domain, **permission-matrix**, event-contract, **projection rebuild (live == projection == rebuild)**, cross-project/cross-org **isolation**, migration, and the §A/§C/§F **concurrency races** (both orderings under the lock/CAS/FOR UPDATE).
- `apps/api/scripts/upgrade-proof.sh` EXTENDED with labour fixtures + `assert`/`assert_rejects` (additive proof: labour tables/indexes/CHECKs/triggers/dual-composite-FKs exist and wrote ZERO rows over the legacy DB; hostile inserts — cross-project ledger, cross-org supplier binding, forged provenance, negative bucket, over-bound muster — rejected by the DB seals).
- `test:e2e:api:allmodules` + `:outbox` (the real-browser acceptance chain in both sender modes and both capability states).
- Reproduce-first RED→GREEN for every invariant; the cross-module-graph + lock-coverage + manifest-registry tripwires updated in the same PR that changes them.

Additive migrations only; each diagnostic-first (ABORTS on ambiguous legacy data rather than guessing); constraints Prisma cannot express (partial uniques, CHECKs, append-only + reversal-inverse triggers, dual-composite tenant FKs) are raw SQL inside the migration; legacy databases upgrade row-free.

---

## Vision alignment

Phase 4 completes the readiness promise the spec makes in §11 and §14: an activity is executable only when its demand is met on **every** dimension for the **same** activity and date. Phase 3 gave the Material gate canonical, transactional, lock-protected truth; Phase 4 gives the **Team** gate the identical treatment and joins them — so "material is here but the crew is not," and "the crew is here but the material is not," both surface as an honest, forecast-bearing, Inbox-actionable block **before** a day of work is lost, instead of a manually-toggled flag. It reuses the cleared platform spine end to end — the type-neutral requirement, the readiness lock, the coverage-authority + shared-verdict-map pattern, the command ledger, the outbox + event catalog, the rebuildable projection, the org-party tenancy, the immutable ledger, the participant channel, and the capability-gated module-owned frontend — so labour readiness is a **thin parallel** of proven machinery, not a second construction. One fact keeps one owner; command authority reads canonical facts under the project readiness lock, never a projection; the pilot is provably inert off-capability; and every physical-truth invariant is enforced by PostgreSQL, not convention.

---

_Docs-only planning deliverable. Independent Codex architecture review is the next stop; Phase 4 Task 1 does not begin until this plan is cleared and JagPat gives an explicit implementation GO._
