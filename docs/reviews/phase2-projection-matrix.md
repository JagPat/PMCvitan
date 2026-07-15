# Phase 2 Task 1 — Characterization Baseline

**Baseline:** `main` @ `d2361a4bd5d878f55630ec6756f1b4805712cb2c` (the actual `origin/main` SHA recorded at PR time, per the plan's Task 1 Step 1 — no hardcoded value in the plan). Test-only + this analysis document; **no schema, runtime, contract or behavior change.**

**What is test-enforced vs. what is a design reference (corrected per re-review):**

| Artifact | Status | Enforced by |
|---|---|---|
| Snapshot top-level shape, per-role gating, author-private drafts, nested DTO shapes | **test-enforced** | `apps/api/test/integration/phase2-snapshot-shape.test.ts` (live PG) + `apps/web/tests/snapshot-shape.test.ts` (exact client contract) |
| Cross-module edge set (§1) | **test-enforced** | `apps/api/src/common/cross-module-graph.test.ts` — an exhaustive classifier that fails on any unknown OR missing foreign write; its `SERVICES` map mirrors §1 |
| Per-mutation consequence set (§3) | **test-enforced** | `apps/api/test/integration/phase2-consequences.test.ts` (live PG) — every pillar mutation, real socket + push capture, exact audit/notification/roles/cross-domain/rollback |
| Command-inventory route surface (§4) | **test-enforced (count)** | `cross-module-graph.test.ts` pins the exact mutating-route count per controller (63 total) — a new undocumented route fails until §4 is updated |
| Projection dependency matrix (§2) event→consumer→authz→rebuild mapping | **design reference** | not directly executable — it is the contract Tasks 3/4 (event catalog) and Tasks 9/10 (projection cutover) implement and test; each projection ships with its own rebuild + authz tests then |

This satisfies canonical spec §21 and the plan's Task 1 Steps 2–6. Downstream tasks that change any test-enforced line here must update the pinning test in the **same** PR.

---

## §1. Cross-module edge decision table (plan finding 4)

Today the backend is one flat `AppModule` (`apps/api/src/app.module.ts:46-102`, 15 controllers + 24 providers). Modules reach into each other by writing another domain's tables through the shared `PrismaService`. Each edge is assigned **exactly one** Phase-2 mechanism — **synchronous query/validation** (permitted in the initiating transaction, spec §6), **atomic workflow contract** (transaction-bound participants, one unit of work), **database FK action**, or **asynchronous event**. Task 7's boundary CI check enforces this; no edge is an indefinite waiver.

| # | Edge (writer → foreign domain) | Site | What it does today | Phase-2 mechanism | Rationale |
|---|---|---|---|---|---|
| 1 | `activities.complete` → **Inspection** | `activities.service.ts:302` (`tx.inspection.create`) | Creates the closing Inspection in the SAME transaction as the activity→`awaiting_signoff` CAS | **Atomic workflow contract** | Phase 1 invariant: activity + its closing inspection commit or roll back together. Cannot be an async event. |
| 2 | `inspections.decide` (approve) → **Activity** | `inspections.service.ts:169,178` | Closing-inspection approval writes Activity `done`+`doneAt` atomically | **Atomic workflow contract** | Same sign-off unit of work as #1. |
| 3 | `inspections.decide` (reject) → **Activity** | `inspections.service.ts:282` | Rejection reverts Activity `awaiting_signoff\|done`→`in_progress`, clears `doneAt` | **Atomic workflow contract** | Same sign-off unit of work; a half-reverted activity is forbidden. |
| 4 | `daily-log.flagMismatch` → **Activity** | `daily-log.service.ts:43` | Sets linked Activity `gateMaterial='fail'`, `status='blocked'`, `block` under the readiness lock | **Atomic workflow contract** (material→readiness) | One transaction under the per-project advisory lock. |
| 5 | `activities.remove` → **Drawing** | `activities.service.ts:159` | Nulls `Drawing.activityId` for drawings linked to the deleted activity | **Database FK action** (`ON DELETE SET NULL`) | Referential cleanup, not a business consequence. |
| 6 | `phases.remove` → **Activity** | `phases.service.ts:56` (`prisma.activity.updateMany`) | Nulls `Activity.phaseId` for activities of the removed phase | **Database FK action** (`ON DELETE SET NULL`) | Referential unfiling — declared in the schema. |
| 7 | `nodes.remove` → **Activity, Inspection, Media, Drawing, SiteMaterial** | `nodes.service.ts:99-103` (five `updateMany`) | Nulls the `(projectId,nodeId)` FK across five domains (composite FKs are `NO ACTION` today) | **Database FK action** (`ON DELETE SET NULL`) | Referential unfiling. (Decisions are the one reference `remove` refuses to null — `nodes.service.ts:89-92` — a guard, not a write.) |
| 8 | `orgs.createProject` → **ProjectNode, Phase, Activity, Inspection** | `orgs.service.ts` copyStructure/instantiateModules | Directly writes four foreign domains to instantiate a new project | **Atomic workflow contract** (module initializer contracts, one unit of work) | No partially-initialized project. |

**Read + signal coupling** (not table writes, but coupling Phase 2 formalizes): `SnapshotService` and `RealtimeGateway` are injected into all eight mutating services; every mutation ends by rebuilding the full snapshot and emitting the content-free `changed` signal (**exactly 30** `notifyChanged(` call sites — pinned per file by the classifier test). Task 6 moves the signal + Web Push behind the per-consumer outbox; Task 9 replaces the full-snapshot read with the shell summary + module queries. The synchronous read validations `resolveProjectNode`/`resolveProjectRef` and the `FOR UPDATE` membership reads are **permitted** same-transaction queries (spec §6) and stay synchronous.

---

## §2. Projection dependency matrix (plan finding 6)

The three cross-cutting read surfaces the Task-4 event catalog must feed and Tasks 9/10 must serve from rebuildable projections. **The five pillar events are NOT enough** — every canonical source below must emit a versioned event (`type@version`, all `@1` at Task-1 baseline) before a read path switches. Every projection also keeps a **query-time authorization check** (a projection is never an RBAC bypass). Columns: **Consumer** = the projection that subscribes; **Rebuild query** = the executable derivation that regenerates the row from canonical records.

### Inbox — `selectActionItems(state)` (`apps/web/src/store/selectors.ts:252-318`)

| Projection row · subject | Source (collection · fields) | Events `type@version` | Consumer | Query-time authz | Rebuild query (pseudocode) |
|---|---|---|---|---|---|
| `pending` · project | `decisions` where `status='pending' && !draft` (`:255`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `inbox` | role ∈ {client,pmc} (pending never leaks) | `SELECT id,title,ageDays FROM decision WHERE projectId=:p AND status='pending' AND publishedAt IS NOT NULL` |
| `reapprove`/`change` · project | `decisions` where `status='change' && !draft` (`:256`) | `decision.change_requested@1`, `decision.change_withdrawn@1`, `decision.reapproved@1` | `inbox` | role ∈ {client,pmc,contractor} | `… WHERE status='change' AND publishedAt IS NOT NULL` |
| `drafts` · **author** | `decisions.draft` ⧺ `drawings.draft` (`:258`) | `decision.drafted@1`, `decision.published@1`, `drawing.drafted@1`, `drawing.published@1` | `inbox` | **author** (`authorId===userId`) — author-private | `SELECT id FROM decision WHERE projectId=:p AND publishedAt IS NULL AND authorId=:u` (∪ drawing) |
| `ack` · per-user | `drawings` `!draft && current.status='for_construction' && !ackedByMe && recipientOfCurrent` (`:262`) + consultant discipline bucket (`:312`) | `drawing.issued@1`, `drawing.published@1`, `drawing.revised@1`, `drawing.recipients_frozen@1`, `drawing.acknowledged@1` | `inbox` | role ∈ {engineer,contractor,consultant}; per-user `ackedByMe` over the **frozen recipient set ∩ active members** | `governing rev per drawing; recipients = DrawingRecipient(revId) ∩ active membership; row when :u ∈ recipients AND no DrawingAck(revId,:u)` |
| `blocked` · project | `activities` where `status='blocked'` (`:263`) | `activity.readiness_changed@1`, `material.mismatch_flagged@1` | `inbox` | role=pmc | `SELECT id FROM activity WHERE projectId=:p AND status='blocked'` |
| `reviews` · project | `reviews` (submitted, undecided) (`:288`) | `inspection.submitted@1`, `inspection.decided@1`, `inspection.reinspection_created@1` | `inbox` | role=pmc (queue pmc-only) | `SELECT id FROM inspection WHERE projectId=:p AND submitted AND NOT decided` |
| `eng-checklist` · project | `checklist` = the **first** `submitted:false` checklist SnapshotService returns, **no assignee filter** (`snapshot.service.ts:214`) | `inspection.created@1`, `inspection.submitted@1` | `inbox` | role=engineer | `SELECT … FROM inspection WHERE projectId=:p AND kind='checklist' AND NOT submitted ORDER BY id LIMIT 1` — **NB: not assignee-scoped today; a per-engineer projection is a Phase-2 product decision, not the current behavior** |
| `eng-log` · project | `dailyLog` (`.submitted`, `.checkedIn`) (`:277`) | `dailylog.started@1`, `dailylog.submitted@1` | `inbox` | role=engineer | latest `dailyLog` by `(logDate,createdAt,id)`; row when `NOT submitted` |
| `drawing-gate` · project | `activities` `status='not-started'` × `readinessFor(a).drawing ∈ {wait,fail}` (`:293-298`) | `activity.readiness_changed@1`, `drawing.issued@1`/`published@1`/`revised@1`/`acknowledged@1` | `inbox` | role=pmc | recompute drawing gate per activity via `deriveReadiness`; row when `not-started AND drawingGate∈{wait,fail}` |
| `override-expiry` · project | `activities[].overrides` expiring ≤7d (`:300-305`) | `activity.override_granted@1`, `activity.override_revoked@1`, **+ a scheduled clock tick** | `inbox` | role=pmc | `SELECT … FROM gateOverride WHERE projectId=:p AND expiresAt BETWEEN now() AND now()+7d` — **time-driven: crossing the 7-day threshold fires NO mutation event, so this projection needs a scheduled refresh (a daily clock tick / cron consumer), not only event-driven invalidation** |
| consultant scope · per-user | membership `discipline` (`:308-315`) | `membership.role_changed@1`, `membership.discipline_changed@1` | `inbox` | membership on `activeProjectId`; discipline from `memberships` | `SELECT role,discipline FROM membership WHERE projectId=:p AND userId=:u AND status='active'` |

### Dashboard (single-project surface, `screens/DashboardScreen.tsx` + `selectors.ts`) — **every rendered field**

| Row · field | Source (selector/store · file:line) | Events `type@version` | Consumer | Authz | Rebuild query |
|---|---|---|---|---|---|
| project identity `name/descriptor/stage/siteCode` | store project meta (`DashboardScreen.tsx:23-26`) | `project.updated@1` | `dashboard-shell` | project (all roles) | `SELECT name,descriptor,stage,siteCode FROM project WHERE id=:p` |
| `milestonePct` | store (`:27`) | `project.updated@1`, `phase.*@1` | `dashboard-shell` | project (all roles) | `project.milestonePct` |
| milestone strip: phase `name`+`donePct` | `phases[]` (`:28,32`) | `phase.created@1`, `phase.removed@1`, `activity.*@1` | `dashboard-phases` | project (all roles) | `SELECT name, donePct FROM phase WHERE projectId=:p ORDER BY order` |
| daily-log status `checkedIn/submitted/workers/materials/progress` | `dailyLog.checkedIn/submitted/crew/materials/progress` (`:16-19`) + `selectTotalWorkers` (`selectors.ts:214`) | `dailylog.started@1`, `dailylog.submitted@1`, `material.added@1` | `dashboard-site` | project (all roles) | latest `dailyLog`; `workers=Σ crew.count`; `materials=count(siteMaterial in log)`; `progress=dailyLog.progress` |
| pending tile `count` + **decision ageing** | `selectPending` (`selectors.ts:20`) + `pending[].ageDays` (`:38`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `dashboard-inbox` | pmc/client | `SELECT count(*), max(ageDays) FROM decision WHERE projectId=:p AND status='pending' AND publishedAt IS NOT NULL` |
| review tile `count` + **review title** | `selectReviewPending` (`:68`) + `selectActiveReview.title` (`:60`) | `inspection.submitted@1`, `inspection.decided@1` | `dashboard-inbox` | pmc | `count + first-review title FROM inspection WHERE submitted AND NOT decided` |
| failed tile `failedCount` | `selectFailedCount` (`:81`) — `reinspectionCreated`, `reviews[].items[].result='FAIL'`/`rejected` | `inspection.decided@1`, `inspection.reinspection_created@1` | `dashboard-inbox` | pmc | derived per §3 fail ternary |
| photos tile + highlights `id/url/kind/takenAt` | `selectPhotoStats` (`:227`) + `photos[]` (`:30`, rendered id/url/kind/takenAt) | `media.uploaded@1`, `media.refiled@1`, `media.removed@1` | `dashboard-photos` | project (all roles) | `SELECT id,url,kind,takenAt,nodeId FROM media WHERE projectId=:p AND kind∈{progress,inspection,material}` |

_(Correction: `selectSchToday` (`selectors.ts:161`) is **not** rendered by the Dashboard — the "View Schedule" button only navigates; it belongs to the Schedule screen, not this projection.)_

### Portfolio (cross-project, `orgs.service.portfolio(userId)` `orgs.service.ts:845-903`; `PortfolioProject` type `:21-38`) — **every field**

| Row field | Canonical source (file:line) | Events `type@version` | Consumer | Authz | Rebuild query |
|---|---|---|---|---|---|
| `projectId` | `project.id` (`:884`) | project.* | `portfolio` | per-user | membership/reach set (below) |
| `name` / `short` / `stage` | `project.name/short/stage` (`:885-887`) | `project.updated@1` | `portfolio` | per-user × per-project | `SELECT name,short,stage FROM project` |
| `role` | `Membership.role`, or `'pmc'` for org owner/admin reach (`:888,859`) | `membership.added@1`, `membership.role_changed@1`, `orgMembership.*@1` | `portfolio` | per-user | `membership.role` (owner/admin → pmc) |
| `orgName` | `project.org.name` (`:889`) | `org.updated@1` | `portfolio` | per-user × per-project | `SELECT org.name FROM project JOIN org` |
| `milestonePct` | `project.milestonePct` (`:899`) | `project.updated@1` | `portfolio` | per-user × per-project | `project.milestonePct` |
| `activityTotal/done/inProgress/blocked/notStarted/donePct` | `Activity.status` aggregate (`:874,879-895`) | `activity.created@1`, `activity.started@1`, `activity.completion_requested@1`, `inspection.approved@1`, `inspection.rejected@1`, `activity.readiness_changed@1`, `activity.deleted@1` | `portfolio` | per-project | `SELECT count(*) FILTER(status=…) FROM activity WHERE projectId=:p` |
| `openReviews` | `Inspection.count(submitted, !decided)` (`:875`) | `inspection.submitted@1`, `inspection.decided@1` | `portfolio` | per-project | `SELECT count(*) FROM inspection WHERE submitted AND NOT decided` |
| `pendingDecisions` | `Decision.count(pending)` **RBAC-gated** `canSeePending=role∈{pmc,client}` (`:872,876`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `portfolio` | per-user × per-project (0 for non-pmc/client) | `IF role∈{pmc,client}: count(pending) ELSE 0` |
| `phaseCount` | `Phase.count` (`:877`) | `phase.created@1`, `phase.removed@1` | `portfolio` | per-project | `SELECT count(*) FROM phase WHERE projectId=:p` |
| project-list rows / archive filter | active `Membership` (`:846`) + org owner/admin reach (`:854-861`); `!project.archivedAt` (`:851`) | `membership.added@1`, `membership.removed@1`, `membership.role_changed@1`, `project.archived@1`, `project.restored@1` | `portfolio` | **per-user**; a `membership.removed@1` must invalidate the user's rows (query-time membership check remains) | `active memberships ∪ (owner/admin → all non-archived org projects)` |

**Cross-cutting authz note:** pending-decision visibility derives from the SAME rule in two places — the snapshot's `hidePending = role∉{pmc,client}` (`snapshot.service.ts:110`) and portfolio's `canSeePending` (`orgs.service.ts:872`). Any projection for either preserves that rule at query time, and a `membership.removed@1`/`membership.role_changed@1` event must invalidate or replace the affected user-specific rows without leaking the prior view.

---

## §3. Per-mutation consequence set (plan Task 1 Step 4)

The consequence bundle each pillar mutation produces today (the set Tasks 3–6 reproduce via the DomainEvent envelope + per-consumer outbox). **Actor column** distinguishes `resolveActor` (real `actorId`, `common/actor.ts:21`) from a **bare** `actor: user.role` (null `actorId`) — the attribution split Task 3 closes. **Every row is asserted behaviorally** in `phase2-consequences.test.ts` (33 cases, real socket + push capture).

| Mutation | Canonical write | Audit (action · actor) | DecisionEvent | Notification | `changed` push roles | Cross-domain |
|---|---|---|---|---|---|---|
| `decisions.create` (publish) | Decision + options | `decision.create` · **resolveActor** | issued | yes | `['client']` | — |
| `decisions.create` (draft) | Decision + options | `decision.draft` · **resolveActor** | drafted | — | **no signal at all** | — |
| `decisions.publish` | Decision.publishedAt | `decision.publish` · **resolveActor** | issued | yes | `['client']` | — |
| `decisions.approve` | Decision→approved (CAS) | `decision.approve` · **resolveActor** | approved\|reapproved | yes | `['pmc','contractor','engineer']` | — |
| `decisions.requestChange` | Decision→change + ChangeRequest | `decision.change` · **resolveActor** | change_requested | — | bare `changed` (no push) | — |
| `decisions.withdrawChange` | Decision→approved | `decision.change_withdraw` · **resolveActor** | change_withdrawn | — | bare `changed` | — |
| `activities.create` | Activity | `activity.create` · **bare role** | — | — | `['engineer','contractor']` | — |
| `activities.update` | Activity | `activity.update` · **bare role** | — | — | bare `changed` | — |
| `activities.remove` | Activity delete | `activity.delete` · **bare role** | — | — | bare `changed` | **Drawing** (edge 5) |
| `activities.start` | Activity CAS→in_progress | `activity.start` · **bare role** | — | — | bare `changed` | — |
| `activities.complete` | Activity CAS→awaiting_signoff | `activity.complete_requested` · **resolveActor** | — | yes | `['pmc']` | **Inspection** (edge 1) |
| `activities.override` | GateOverride create | `activity.override` · **resolveActor** | — | — | `['engineer','contractor']` | — |
| `activities.revokeOverride` | GateOverride delete | `activity.override_revoke` · **resolveActor** | — | — | bare `changed` | — |
| `phases.create` | Phase | `phase.create` · **bare role** | — | — | bare `changed` | — |
| `phases.remove` | Phase delete | `phase.delete` · **bare role** | — | — | bare `changed` | **Activity** (edge 6) |
| `inspections.create` | Inspection + items | `inspection.create` · **resolveActor** | — | yes | `['engineer']` | — |
| `inspections.submit` | Inspection CAS→submitted + items | `inspection.submit` · **resolveActor** | — | — | bare `changed` | — |
| `inspections.decide` (approve) | Inspection→decided | `inspection.approve` + `activity.signoff` · **resolveActor** | — | yes | `['contractor','client']` | **Activity** done+doneAt (edge 2) |
| `inspections.decide` (reject) | Inspection→decided + reinspection child | `inspection.reject` + `activity.signoff_rejected` · **resolveActor** | — | yes | `['engineer']` | **Activity** →in_progress (edge 3) |
| `drawings.issue` | Drawing/Revision + frozen recipients | `drawing.issue\|revise` · **resolveActor** | — | — | `['engineer','contractor']` (if published) | — |
| `drawings.publish` | Drawing→published | `drawing.publish` · **resolveActor** | — | — | `['engineer','contractor']` | — |
| `drawings.acknowledge` | DrawingAck (first only) | `drawing.ack` · **resolveActor** | — | — | `['pmc']` (first only) | — |
| `drawings.setNode` | Drawing.nodeId | `drawing.refile` · **resolveActor** | — | — | bare `changed` | — |
| `drawings.remove` | Drawing delete | `drawing.remove` · **resolveActor** | — | — | bare `changed` | — |
| `daily-log.start` | DailyLog + crew | `dailylog.start` · **bare role** | — | — | bare `changed` | — |
| `daily-log.addMaterial` | SiteMaterial | `material.add` · **bare role** | — | — | bare `changed` | — |
| `daily-log.flagMismatch` | SiteMaterial.matched=false | `material.mismatch` · **bare role** | — | yes | `['pmc','contractor']` | **Activity** gate/status/block (edge 4) |
| `daily-log.submit` | DailyLog→submitted + crew | `dailylog.submit` · **bare role** | — | — | bare `changed` | — |
| `nodes.{create,publish,rename,move,remove}` | ProjectNode | **none** (no audit) | — | — | bare `changed` | remove → 5 domains (edge 7) |
| `media.{create,setNode,remove}` | Media | **none** (no audit) | — | — | bare `changed` | — |

**Attribution split (the finding Task 3 closes):** `decisions.*`, `inspections.*`, `drawings.*`, `activities.{complete,override,revokeOverride}` use `resolveActor` (real `actorId`); `activities.{create,update,remove,start}`, `phases.*`, and all of `daily-log.*` write a **bare** `actor: user.role` with null `actorId`; `nodes.*` and `media.*` write **no audit row at all**. There is **no audit READ API** — audit is write-only today.

---

## §4. Command inventory (plan finding 5 — the checklist Task 10's gate verifies fully migrated)

Every state-changing HTTP route (**63 total**, count pinned per controller by `cross-module-graph.test.ts`). Columns per the Task-5 ledger design: **scopeKind** (`project`|`org`) + the subject id(s) the `CommandExecution` partial unique index keys on; **idempotency-key source** (only `media.create` has one today — the rest gain one from the frontend offline-outbox op id where a command exists); **request-hash inputs** (the validated request DTO fields hashed for the same-key/different-payload → 409 rule); **result ref** (the entity the committed command's `resultRef` resolves to, replayed to the same actor+scope); **task** = the Phase-2 task that migrates the route onto the ledger. Rows with no frontend command note it as an **exclusion** with rationale.

### Project-scoped commands (`scopeKind='project'`, subject `(projectId, actorId, commandType, key)`)

| Command · path | `@Roles` | key source | request-hash inputs | result ref | task |
|---|---|---|---|---|---|
| `decisions.create` POST `/projects/:p/decisions` | pmc | outbox op id | `{title,room,nodeId?,options[],publish}` | `Decision.id` | 8 |
| `decisions.publish` POST `…/decisions/:id/publish` | pmc | outbox op id | `{decisionId}` | `Decision.id` | 8 |
| `decisions.approve` POST `…/decisions/:id/approve` | client,pmc | outbox op id | `{decisionId, optionIndex}` | `Decision.id` | 8 |
| `decisions.requestChange` POST `…/decisions/:id/change` | pmc,client,contractor,engineer,consultant | outbox op id | `{decisionId, reason, costImpact, timeImpactDays}` | `ChangeRequest.id` | 8 |
| `decisions.withdrawChange` POST `…/decisions/:id/change/withdraw` | pmc,client,contractor,engineer,consultant | outbox op id | `{decisionId}` | `Decision.id` | 8 |
| `activities.create` POST `/projects/:p/activities` | pmc | outbox op id | `{name,zone,plannedStart,plannedEnd,…}` | `Activity.id` | 10 |
| `activities.update` PATCH `…/activities/:id` | pmc | outbox op id | `{activityId, …patch}` | `Activity.id` | 10 |
| `activities.remove` DELETE `…/activities/:id` | pmc | outbox op id | `{activityId}` | `Activity.id` | 10 |
| `activities.start` POST `…/activities/:id/start` | engineer,pmc | outbox op id | `{activityId}` | `Activity.id` | 10 |
| `activities.complete` POST `…/activities/:id/complete` | engineer,pmc | outbox op id | `{activityId}` | `Activity.id` (+ closing `Inspection.id`) | 10 (workflow contract) |
| `activities.override` POST `…/activities/:id/override` | pmc | outbox op id | `{activityId, gate, state, reason, expiresAt, evidenceMediaId?}` | `GateOverride.id` | 10 |
| `activities.revokeOverride` DELETE `…/activities/:id/override/:oid` | pmc | outbox op id | `{overrideId}` | `Activity.id` | 10 |
| `phases.create` POST `/projects/:p/phases` | pmc | outbox op id | `{name,plannedStart,plannedEnd}` | `Phase.id` | 10 |
| `phases.remove` DELETE `…/phases/:id` | pmc | outbox op id | `{phaseId}` | `Phase.id` | 10 |
| `inspections.create` POST `/projects/:p/inspections` | pmc | outbox op id | `{title,zone,items[],nodeId?,activityId?}` | `Inspection.id` | 10 |
| `inspections.submit` POST `…/inspections/:id/submit` | engineer,pmc | outbox op id | `{inspectionId, items[]}` | `Inspection.id` | 10 |
| `inspections.decide` POST `…/inspections/:id/decide` | pmc | outbox op id | `{inspectionId, approve, rejectedItemIds[], assigneeId?, dueInDays?}` | `Inspection.id` (+ child on reject) | 10 (workflow contract) |
| `drawings.issue` POST `/projects/:p/drawings` | pmc | outbox op id | `{number,title,discipline,rev,status,mime,data\|storageKey,…}` | `DrawingRevision.id` | 10 |
| `drawings.publish` POST `…/drawings/:id/publish` | pmc | outbox op id | `{drawingId}` | `Drawing.id` | 10 |
| `drawings.presign` POST `…/drawings/presign` | pmc | **exclusion** — pre-upload URL mint, not a state change (no canonical write); records only an upload session | (n/a) | 10 (documented exclusion) |
| `drawings.acknowledge` POST `…/drawings/rev/:rid/ack` | pmc,engineer,contractor | outbox op id | `{revisionId}` | `DrawingAck.id` | 10 |
| `drawings.setNode` PATCH `…/drawings/:id/node` | pmc | outbox op id | `{drawingId, nodeId?}` | `Drawing.id` | 10 |
| `drawings.remove` DELETE `/drawings/:id` | pmc | outbox op id | `{drawingId}` | `Drawing.id` | 10 |
| `daily-log.start` POST `/projects/:p/daily-log/start` | engineer,pmc | outbox op id | `{}` (server derives the civil day) | `DailyLog.id` | 10 |
| `daily-log.addMaterial` POST `…/daily-log/materials` | engineer,pmc | outbox op id | `{name,qty,zone,decisionId?,swatch,nodeId?}` | `SiteMaterial.id` | 10 |
| `daily-log.flagMismatch` POST `…/daily-log/flag-mismatch` | engineer,pmc | outbox op id | `{decisionId}` | `SiteMaterial.id` | 10 (workflow contract) |
| `daily-log.submit` POST `…/daily-log/submit` | engineer,pmc | outbox op id | `{checkedIn,checkinTime,progress,crew[]}` | `DailyLog.id` | 10 |
| `nodes.create` POST `/projects/:p/nodes` | pmc | outbox op id | `{name,kind,parentId?,publish}` | `ProjectNode.id` | 10 |
| `nodes.rename` PATCH `…/nodes/:id` | pmc | outbox op id | `{nodeId,name}` | `ProjectNode.id` | 10 |
| `nodes.move` POST `…/nodes/:id/move` | pmc | outbox op id | `{nodeId, parentId, order?}` | `ProjectNode.id` | 10 |
| `nodes.publish` POST `…/nodes/:id/publish` | pmc | outbox op id | `{nodeId}` | `ProjectNode.id` | 10 |
| `nodes.remove` DELETE `…/nodes/:id` | pmc | outbox op id | `{nodeId}` | `ProjectNode.id` | 10 (FK actions) |
| `media.create` POST `/projects/:p/media` | pmc,engineer | **`clientKey`** (exists today, `contracts.ts:130`) | `{kind,mime,data,decisionId?,inspectionId?,inspectionItemId?,nodeId?,…}` | `Media.id` | 10 (already keyed — the ledger adopts `clientKey`) |
| `media.setNode` PATCH `…/media/:id/node` | pmc,engineer | outbox op id | `{mediaId, nodeId?}` | `Media.id` | 10 |
| `media.remove` DELETE `/media/:id` | pmc,engineer | outbox op id | `{mediaId}` | `Media.id` | 10 |
| `members.add` POST `/projects/:p/members` | MEMBERS_AUTHZ | outbox op id | `{userId\|email, role, discipline?}` | `Membership.id` | 10 |
| `members.updateRole` PATCH `…/members/:uid` | MEMBERS_AUTHZ | outbox op id | `{userId, role, discipline?}` | `Membership.id` | 10 |
| `members.remove` DELETE `…/members/:uid` | MEMBERS_AUTHZ | outbox op id | `{userId}` | `Membership.id` | 10 |
| `companies.add` POST `/projects/:p/companies` | COMPANIES_AUTHZ | outbox op id | `{name,kind,contact…}` | `ProjectCompany.id` | 10 |
| `companies.update` PATCH `…/companies/:id` | COMPANIES_AUTHZ | outbox op id | `{companyId, …patch}` | `ProjectCompany.id` | 10 |
| `companies.remove` DELETE `…/companies/:id` | COMPANIES_AUTHZ | outbox op id | `{companyId}` | `ProjectCompany.id` | 10 |
| `push.subscribe` POST `/projects/:p/push/subscribe` | JwtGuard only | **exclusion** — device push-subscription registration, per-endpoint idempotent already (`endpoint` unique); not a project fact | (n/a) | 10 (documented exclusion) |

### Org-scoped commands (`scopeKind='org'`, subject `(organizationId, actorId, commandType, key)`, `projectId` NULL)

| Command · path | `@Roles` | key source | result ref | task |
|---|---|---|---|---|
| `orgs.createOrg` POST `/orgs` | pmc,client,engineer,contractor | outbox op id | `Org.id` | 10 |
| `orgs.addOrgMember` POST `/orgs/:o/members` | ORG_AUTHZ | outbox op id | `OrgMembership.id` | 10 |
| `orgs.updateOrgMemberRole` PATCH `/orgs/:o/members/:uid` | ORG_AUTHZ | outbox op id | `OrgMembership.id` | 10 |
| `orgs.removeOrgMember` DELETE `/orgs/:o/members/:uid` | ORG_AUTHZ | outbox op id | `OrgMembership.id` | 10 |
| `orgs.createProject` POST `/orgs/:o/projects` | ORG_AUTHZ | outbox op id | `Project.id` | 10 (workflow contract) |
| `orgs.updateProject` PATCH `/orgs/:o/projects/:p` | ORG_AUTHZ | outbox op id | `Project.id` | 10 |
| `orgs.deleteProject` DELETE `/orgs/:o/projects/:p` | ORG_AUTHZ | outbox op id | `Project.id` | 10 |
| `orgs.restoreProject` POST `/orgs/:o/projects/:p/restore` | ORG_AUTHZ | outbox op id | `Project.id` | 10 |
| `orgs.createModule` POST `/orgs/:o/modules` | ORG_AUTHZ | outbox op id | `TemplateModule.id` | 10 |
| `orgs.archiveModule` DELETE `/orgs/:o/modules/:id` | ORG_AUTHZ | outbox op id | `TemplateModule.id` | 10 |
| `orgs.createTemplate` POST `/orgs/:o/templates` | ORG_AUTHZ | outbox op id | `ProjectTemplate.id` | 10 |
| `orgs.archiveTemplate` DELETE `/orgs/:o/templates/:id` | ORG_AUTHZ | outbox op id | `ProjectTemplate.id` | 10 |

### Auth commands — **excluded from the ledger, with rationale**

`auth.switch`, `auth.session`, `auth.login`, `auth.otp/request`, `auth.otp/verify`, `auth.worker/token`, `auth.email/request`, `auth.email/verify`, `auth.google` (`auth.controller.ts`, 9 routes, all `@Public`/`@AllowAnyRole` behind `ThrottleGuard`). **Exclusion rationale:** these mint session tokens and carry **no `projectId`/`organizationId` subject** and no canonical project/org write, so they cannot key a `CommandExecution` row; OTP replay-safety is handled by the OTP store + rate limiter, not command idempotency. They are listed for completeness so the inventory is exhaustive (9 + 12 org + 42 project = 63 routes) and are **not** migrated onto the ledger. Task 10's gate treats these nine as approved exclusions.

---

_Task 1 stops here for its mandatory independent review. Task 2 does not begin until this review clears._
