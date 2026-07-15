# Phase 2 Task 1 — Characterization Baseline

**Baseline:** `main` @ `d2361a4bd5d878f55630ec6756f1b4805712cb2c` (the actual `origin/main` SHA recorded at PR time, per the plan's Task 1 Step 1 — no hardcoded value in the plan). Test-only + this analysis document; **no schema, runtime, contract or behavior change**. Every table below is enforced by a companion test so it cannot silently drift:

| Artifact | Enforced by |
|---|---|
| Snapshot top-level shape + per-role gating | `apps/api/test/integration/phase2-snapshot-shape.test.ts` (live PG) + `apps/web/tests/snapshot-shape.test.ts` (client contract) |
| Cross-module edge decision table (below §1) | `apps/api/src/common/cross-module-graph.test.ts` (source tripwire) |
| Per-mutation consequence set (below §3) | `apps/api/test/integration/phase2-consequences.test.ts` (live PG) |
| Projection dependency matrix (§2) + command inventory (§4) | this document (referenced by later tasks; the command inventory is the checklist Task 10's gate verifies fully migrated) |

This satisfies canonical spec §21 ("the existing … paths require characterization tests before refactoring") and the plan's Task 1 Steps 2–6. Downstream tasks that change any observable line here must update the pinning test in the **same** PR.

---

## §1. Cross-module edge decision table (plan finding 4)

Today the backend is one flat `AppModule` (`apps/api/src/app.module.ts:46-102`, 15 controllers + 24 providers). Modules reach into each other by writing another domain's tables through the shared `PrismaService`. Each edge below is assigned **exactly one** Phase-2 mechanism — **synchronous query/validation** (permitted in the initiating transaction, spec §6), **atomic workflow contract** (transaction-bound participants, one unit of work), **database FK action**, or **asynchronous event**. This is the contract Task 7's boundary CI check enforces; no edge is an indefinite waiver.

| # | Edge (writer → foreign domain) | Site | What it does today | Phase-2 mechanism | Rationale |
|---|---|---|---|---|---|
| 1 | `activities.complete` → **Inspection** | `activities.service.ts:302` (`tx.inspection.create`) | Creates the closing Inspection in the SAME transaction as the activity→`awaiting_signoff` CAS | **Atomic workflow contract** | Phase 1 invariant: activity + its closing inspection commit or roll back together (no half-created closing). Cannot be an async event. |
| 2 | `inspections.decide` (approve) → **Activity** | `inspections.service.ts:169,178` (`tx.activity.updateMany`/`update`) | Closing-inspection approval writes Activity `done`+`doneAt` atomically | **Atomic workflow contract** | Same sign-off unit of work as #1; "done means signed off" must stay one commit. |
| 3 | `inspections.decide` (reject) → **Activity** | `inspections.service.ts:282` (`tx.activity.updateMany`) | Rejection reverts Activity `awaiting_signoff\|done`→`in_progress`, clears `doneAt` | **Atomic workflow contract** | Same sign-off unit of work; a half-reverted activity is the forbidden state. |
| 4 | `daily-log.flagMismatch` → **Activity** | `daily-log.service.ts:43` (`tx.activity.update`) | Sets the linked Activity's stored `gateMaterial='fail'`, `status='blocked'`, `block` | **Atomic workflow contract** (material→readiness) | The material-mismatch → readiness-lock protocol is one transaction under the per-project advisory lock; the stored material gate is written with the mismatch. |
| 5 | `activities.remove` → **Drawing** | `activities.service.ts:159` (`prisma.drawing.updateMany`) | Nulls `Drawing.activityId` for drawings linked to the deleted activity | **Database FK action** (`ON DELETE SET NULL`) | A referential cleanup, not a business consequence — belongs in the schema as a declared FK action. |
| 6 | `nodes.remove` → **Activity, Inspection, Media, Drawing, SiteMaterial** | `nodes.service.ts:99-103` (five `updateMany`) | Nulls the `(projectId,nodeId)` FK across five domains in the delete transaction (composite FKs are `NO ACTION`) | **Database FK action** (`ON DELETE SET NULL`) | Same: referential unfiling. (Decisions are the one reference `remove` refuses to null — `nodes.service.ts:89-92` — a guard, not a write.) |
| 7 | `orgs.createProject` → **ProjectNode, Phase, Activity, Inspection** | `orgs.service.ts:697/714/721/746` (copyStructure) + `545/572/591/598/620` (instantiateModules) | Directly writes four foreign domains to instantiate a new project's structure | **Atomic workflow contract** (module initializer contracts, one unit of work) | Each module exposes an initializer the create-project workflow invokes in one transaction — no partially-initialized project. |

**Read + signal coupling (not table writes, but coupling Phase 2 formalizes):** `SnapshotService` and `RealtimeGateway` are injected into all eight mutating services (`decisions`, `activities`, `phases`, `inspections`, `drawings`, `daily-log`, `nodes`, `media`); every mutation ends by rebuilding the full snapshot and emitting the content-free `changed` socket signal (~30 `notifyChanged(` call sites). Task 6 moves the signal (and Web Push) behind the per-consumer outbox; Task 9 replaces the full-snapshot read with the shell summary + module queries. The synchronous read validations `resolveProjectNode`/`resolveProjectRef` and the `FOR UPDATE` membership reads are **permitted** same-transaction queries (spec §6) and stay synchronous.

---

## §2. Projection dependency matrix (plan finding 6)

The three cross-cutting read surfaces the Task-6 event catalog must feed and Task 9/Task 10 must serve from rebuildable projections. **The five pillar events are NOT enough** — every canonical source below must emit a versioned event before a read path switches. Every projection also keeps a **query-time authorization check** (a projection is never an RBAC bypass).

### Inbox — `selectActionItems(state)` (`apps/web/src/store/selectors.ts:252-318`)

| Projection row (per role) | Canonical source (collection · fields) | Event(s) that must exist | Authorization (subject scope + query-time check) |
|---|---|---|---|
| `client-pending` / `pmc-pending` | `decisions` where `status='pending' && !draft` (`:255`) | `decision.published`, `decision.approved`, `decision.change_requested`, `decision.draft_created` | project + role ∈ {client, pmc}; pending never leaks to other roles |
| `client-reapprove` / `pmc-change` / `con-change` | `decisions` where `status='change' && !draft` (`:256`) | `decision.change_requested`, `decision.change_withdrawn`, `decision.reapproved` | project + role ∈ {client, pmc, contractor} |
| `pmc-drafts` | drafts = `decisions.draft` ⧺ `drawings.draft` (`:258`) | `decision.draft_created/published`, `drawing.draft_created/published` | project + **author** (`authorId===userId`) — drafts are author-private |
| `eng-ack` / `con-ack` / `cons-review` | `drawings` where `!draft && current.status='for_construction' && !ackedByMe && recipientOfCurrent` (`:262`) + consultant discipline bucket (`:312`) | `drawing.issued`, `drawing.published`, `drawing.superseded`, `drawing.acknowledged`, `drawing.recipients_frozen` | project + role + per-user `ackedByMe`/`recipientOfCurrent` (frozen recipients ∩ active members) |
| `pmc-blocked` | `activities` where `status='blocked'` (`:263`) | `activity.readiness_changed`, `activity.blocked`, `material.mismatch_flagged` | project + role=pmc |
| `pmc-reviews` | `reviews` (submitted, undecided) (`:288`) | `inspection.submitted`, `inspection.decided`, `inspection.reinspection_created` | project + role=pmc (queue is pmc-only) |
| `eng-checklist` | `checklist` (`.submitted`, `.items`) (`:276`) | `inspection.created`, `inspection.submitted` | project + role=engineer (the assigned engineer's checklist) |
| `eng-log` | `dailyLog` (`.submitted`, `.checkedIn`) (`:277`) | `dailylog.started`, `dailylog.submitted` | project + role=engineer |
| `pmc-drawing-gate` | `activities` `status='not-started'` × `readinessFor(a).drawing ∈ {wait,fail}` (`:293-298`) | `activity.readiness_changed`, `drawing.*` (governing revision changes) | project + role=pmc |
| `pmc-override-expiry` | `activities[].overrides` expiring ≤7d (`:300-305`) | `activity.override_granted`, `activity.override_revoked` | project + role=pmc |
| _all rows_ | live drawing-gate recompute via shared `deriveReadiness` (`:114-133`) | (consumes the above; no new event) | membership on `activeProjectId`; consultant `discipline` from `memberships` (`:308-315`) → also needs `membership.role_changed`/`membership.discipline_changed` |

### Dashboard (single-project selectors, `selectors.ts`)

| Row | Source · fields | Events | Authz |
|---|---|---|---|
| pending count `selectPending` (`:20-23`) | `decisions` `status='pending' && !draft` | decision.* | project + pmc/client |
| review-pending `selectReviewPending` (`:68-70`) | `reviews` `!decided` | inspection.submitted/decided | project + pmc |
| failed count `selectFailedCount` (`:81-85`) | `reinspectionCreated`, `reviews[].items[].result='FAIL'`, `rejected` | inspection.decided/reinspection_created | project + pmc |
| schedule today `selectSchToday` (`:161-167`) | `activities[].status` | activity.* (status transitions) | project (all roles) |
| phase rollup `phaseRollup` (`:193-201`) | `activities[].phaseId + status` (adds `awaitingSignoff`) | activity.*, phase.created/removed | project (all roles) |
| photo stats `selectPhotoStats` (`:227-230`) | `photos[].nodeId + length` | media.uploaded/refiled/removed | project (all roles) |

### Portfolio (cross-project, `orgs.service.portfolio(userId)` `orgs.service.ts:845-903`)

| Row field | Canonical source | Events | Authz |
|---|---|---|---|
| project list | `membership` (`status='active'`, `:846`) + org owner/admin reach (`:854-861`) | membership.added/removed/role_changed, orgMembership.* | **per-user**; a removed membership must invalidate the user's row (query-time membership check remains) |
| archive filter | `project.archivedAt` (`:851`) | project.archived, project.restored | per-user × per-project |
| activity rollup `done/inProgress/blocked/notStarted/donePct` | `activity.status` (`:874,879-895`) | activity.* | per-project |
| `openReviews` | `inspection.count(submitted, !decided)` (`:875`) | inspection.submitted/decided | per-project |
| `pendingDecisions` | `decision.count(pending)` **RBAC-gated** `canSeePending=role∈{pmc,client}` (`:872,876`) | decision.* | per-user × per-project (0 for non-pmc/client) |
| `phaseCount` | `phase.count` (`:877`) | phase.created/removed | per-project |

**Cross-cutting authz note:** pending-decision visibility derives from the SAME rule in two places — the snapshot's `hidePending = role∉{pmc,client}` (`snapshot.service.ts:110`) and portfolio's `canSeePending` (`orgs.service.ts:872`). A projection for either must preserve that rule at query time, and a `membership.removed`/`role_changed` event must invalidate or replace the affected user-specific rows without leaking the prior view.

---

## §3. Per-mutation consequence set (plan Task 1 Step 4)

The consequence bundle each pillar mutation produces today (the set Tasks 3–6 reproduce via the DomainEvent envelope + per-consumer outbox). **Actor column** distinguishes `resolveActor` (real `actorId`, `common/actor.ts:21`) from a **bare** `actor: user.role` (null `actorId`) — the attribution split Task 3 closes. Full table below; the representative rows (approve, complete, create) are asserted behaviorally in `phase2-consequences.test.ts`.

| Mutation | Canonical write | Audit (action · actor) | DecisionEvent | Notification | `changed` roles | Cross-domain |
|---|---|---|---|---|---|---|
| `decisions.create` | Decision + options | `decision.create\|draft` · **resolveActor** | drafted\|issued | if publish | `['client']` (if publish) | — |
| `decisions.publish` | Decision.publishedAt | `decision.publish` · **resolveActor** | issued | yes | `['client']` | — |
| `decisions.approve` | Decision→approved (CAS) | `decision.approve` · **resolveActor** | approved\|reapproved | yes | `['pmc','contractor','engineer']` | — |
| `decisions.requestChange` | Decision→change + ChangeRequest | `decision.change` · **resolveActor** | change_requested | — | bare `changed` | — |
| `decisions.withdrawChange` | Decision→approved | `decision.change_withdraw` · **resolveActor** | change_withdrawn | — | bare `changed` | — |
| `activities.create` | Activity | `activity.create` · **bare role** | — | — | `['engineer','contractor']` | — |
| `activities.update` | Activity (may set stored gates) | `activity.update` · **bare role** | — | — | bare `changed` | — |
| `activities.remove` | Activity delete | `activity.delete` · **bare role** | — | — | bare `changed` | **Drawing** (edge 5) |
| `activities.start` | Activity CAS→in_progress | `activity.start` · **bare role** | — | — | bare `changed` | — |
| `activities.complete` | Activity CAS→awaiting_signoff | `activity.complete_requested` · **resolveActor** | — | yes | `['pmc']` | **Inspection** (edge 1) |
| `activities.override` | GateOverride create | `activity.override` · **resolveActor** | — | — | `['engineer','contractor']` | — |
| `activities.revokeOverride` | GateOverride delete | `activity.override_revoke` · **resolveActor** | — | — | bare `changed` | — |
| `inspections.create` | Inspection + items | `inspection.create` · **resolveActor** | — | yes | `['engineer']` | — |
| `inspections.submit` | Inspection CAS→submitted + items | `inspection.submit` · **resolveActor** | — | — | bare `changed` | — |
| `inspections.decide` (approve) | Inspection→decided | `inspection.approve` + `activity.signoff` · **resolveActor** | — | yes | `['contractor','client']` | **Activity** done+doneAt (edges 2) |
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

**Attribution split (the finding Task 3 closes):** `decisions.*`, `inspections.*`, `drawings.*`, `activities.{complete,override,revokeOverride}` use `resolveActor` (real `actorId`); `activities.{create,update,remove,start}` and all of `daily-log.*` write a **bare** `actor: user.role` with null `actorId`. There is **no audit READ API** — audit is write-only today.

---

## §4. Command inventory (plan finding 5 — the checklist Task 10's gate verifies fully migrated)

Every state-changing HTTP route. `scope` = the Task-5 `CommandExecution` scope (`project` unless noted `org`). **Only `media.create` carries a client idempotency key today** (`clientKey`, `contracts.ts:130`, `@@unique([projectId, clientKey])`); the rest have no dedupe key and must gain one (from the offline outbox op id where a frontend command exists) as they migrate onto the ledger. "Migrating task" is the Phase-2 task that puts the route behind the ledger.

### Project-scoped commands

| Command (method · path) | `@Roles` | scope | client key today | migrating task |
|---|---|---|---|---|
| `decisions.create` POST `/projects/:p/decisions` | pmc | project | — | 8 (decisions first) |
| `decisions.publish` POST `…/decisions/:id/publish` | pmc | project | — | 8 |
| `decisions.approve` POST `…/decisions/:id/approve` | client,pmc | project | — | 8 |
| `decisions.requestChange` POST `…/decisions/:id/change` | pmc,client,contractor,engineer,consultant | project | — | 8 |
| `decisions.withdrawChange` POST `…/decisions/:id/change/withdraw` | pmc,client,contractor,engineer,consultant | project | — | 8 |
| `activities.create` POST `/projects/:p/activities` | pmc | project | — | 10 |
| `activities.update` PATCH `…/activities/:id` | pmc | project | — | 10 |
| `activities.remove` DELETE `…/activities/:id` | pmc | project | — | 10 |
| `activities.start` POST `…/activities/:id/start` | engineer,pmc | project | — | 10 |
| `activities.complete` POST `…/activities/:id/complete` | engineer,pmc | project | — | 10 (workflow contract) |
| `activities.override` POST `…/activities/:id/override` | pmc | project | — | 10 |
| `activities.revokeOverride` DELETE `…/activities/:id/override/:oid` | pmc | project | — | 10 |
| `phases.create` POST `/projects/:p/phases` | pmc | project | — | 10 |
| `phases.remove` DELETE `…/phases/:id` | pmc | project | — | 10 |
| `inspections.create` POST `/projects/:p/inspections` | pmc | project | — | 10 |
| `inspections.submit` POST `…/inspections/:id/submit` | engineer,pmc | project | — | 10 |
| `inspections.decide` POST `…/inspections/:id/decide` | pmc | project | — | 10 (workflow contract) |
| `drawings.issue` POST `/projects/:p/drawings` | pmc | project | — | 10 |
| `drawings.publish` POST `…/drawings/:id/publish` | pmc | project | — | 10 |
| `drawings.presign` POST `…/drawings/presign` | pmc | project | — | 10 |
| `drawings.acknowledge` POST `…/drawings/rev/:rid/ack` | pmc,engineer,contractor | project | — | 10 |
| `drawings.setNode` PATCH `…/drawings/:id/node` | pmc | project | — | 10 |
| `drawings.remove` DELETE `/drawings/:id` | pmc | project | — | 10 |
| `daily-log.start` POST `/projects/:p/daily-log/start` | engineer,pmc | project | — | 10 |
| `daily-log.addMaterial` POST `…/daily-log/materials` | engineer,pmc | project | — | 10 |
| `daily-log.flagMismatch` POST `…/daily-log/flag-mismatch` | engineer,pmc | project | — | 10 (workflow contract) |
| `daily-log.submit` POST `…/daily-log/submit` | engineer,pmc | project | — | 10 |
| `nodes.create` POST `/projects/:p/nodes` | pmc | project | — | 10 |
| `nodes.rename` PATCH `…/nodes/:id` | pmc | project | — | 10 |
| `nodes.move` POST `…/nodes/:id/move` | pmc | project | — | 10 |
| `nodes.publish` POST `…/nodes/:id/publish` | pmc | project | — | 10 |
| `nodes.remove` DELETE `…/nodes/:id` | pmc | project | — | 10 (FK actions) |
| `media.create` POST `/projects/:p/media` | pmc,engineer | project | **`clientKey`** | 10 |
| `media.setNode` PATCH `…/media/:id/node` | pmc,engineer | project | — | 10 |
| `media.remove` DELETE `/media/:id` | pmc,engineer | project | — | 10 |
| `members.add` POST `/projects/:p/members` | AllowAnyRole (MEMBERS_AUTHZ) | project | — | 10 |
| `members.updateRole` PATCH `…/members/:uid` | AllowAnyRole | project | — | 10 |
| `members.remove` DELETE `…/members/:uid` | AllowAnyRole | project | — | 10 |
| `companies.add` POST `/projects/:p/companies` | AllowAnyRole (COMPANIES_AUTHZ) | project | — | 10 |
| `companies.update` PATCH `…/companies/:id` | AllowAnyRole | project | — | 10 |
| `companies.remove` DELETE `…/companies/:id` | AllowAnyRole | project | — | 10 |
| `push.subscribe` POST `/projects/:p/push/subscribe` | AllowAnyRole (JwtGuard only) | project | — | 10 |

### Org-scoped commands (`scopeKind='org'`, `projectId` NULL in the ledger)

| Command | `@Roles` | migrating task |
|---|---|---|
| `orgs.createOrg` POST `/orgs` | pmc,client,engineer,contractor | 10 |
| `orgs.addOrgMember` POST `/orgs/:o/members` | AllowAnyRole (ORG_AUTHZ) | 10 |
| `orgs.updateOrgMemberRole` PATCH `/orgs/:o/members/:uid` | AllowAnyRole | 10 |
| `orgs.removeOrgMember` DELETE `/orgs/:o/members/:uid` | AllowAnyRole | 10 |
| `orgs.createProject` POST `/orgs/:o/projects` | AllowAnyRole | 10 (workflow contract) |
| `orgs.updateProject` PATCH `/orgs/:o/projects/:p` | AllowAnyRole | 10 |
| `orgs.deleteProject` DELETE `/orgs/:o/projects/:p` | AllowAnyRole | 10 |
| `orgs.restoreProject` POST `/orgs/:o/projects/:p/restore` | AllowAnyRole | 10 |
| `orgs.createModule` POST `/orgs/:o/modules` | AllowAnyRole | 10 |
| `orgs.archiveModule` DELETE `/orgs/:o/modules/:id` | AllowAnyRole | 10 |
| `orgs.createTemplate` POST `/orgs/:o/templates` | AllowAnyRole | 10 |
| `orgs.archiveTemplate` DELETE `/orgs/:o/templates/:id` | AllowAnyRole | 10 |

### Auth commands (identity, not project/org data — session issuance)

`auth.switch`, `auth.session`, `auth.login`, `auth.otp/request`, `auth.otp/verify`, `auth.worker/token`, `auth.email/request`, `auth.email/verify`, `auth.google` (`auth.controller.ts:38-115`, all `@Public`/`@AllowAnyRole` behind `ThrottleGuard`). These mint tokens; they are **out of the project/org command ledger's scope** (no `projectId`/`organizationId` subject) and are noted here for completeness so the inventory is exhaustive — they are not migrated onto `CommandExecution`.

---

_Task 1 stops here for its mandatory independent review. Task 2 does not begin until this review clears._
