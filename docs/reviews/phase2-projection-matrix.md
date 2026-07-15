# Phase 2 Task 1 — Characterization Baseline

**Baseline:** the Task-1 characterization was taken against `main` @ `d2361a4bd5d878f55630ec6756f1b4805712cb2c`; this document + its pinning tests were re-verified against `main` @ `0963776` (the base of this correction). Test-only + this analysis document; **no schema, runtime, contract or behavior change.**

**What is test-enforced vs. what is a design reference (corrected per the Task-1 re-review, findings 1–6):**

| Artifact | Status | Enforced by |
|---|---|---|
| Snapshot top-level shape (16 keys), per-role gating, author-private drafts, AND the exact nested key/optionality/nullability of every DTO | **test-enforced** | `apps/api/test/integration/phase2-snapshot-shape.test.ts` (live PG) — a SOURCE SCAN of `snapshot/types.ts` pins each DTO's keys + `?`-optional + `\| null`-nullable set, and a RUNTIME conformance check asserts a fully-populated snapshot carries EXACTLY those keys with nulls only where allowed, for all 16 top-level keys; plus `apps/web/tests/snapshot-shape.test.ts` (exact client contract) |
| Cross-module edge set (§1) — COUNTED | **test-enforced** | `apps/api/src/common/cross-module-graph.test.ts` — an exhaustive classifier that auto-discovers every `*.service.ts` (a new file fails until triaged) and asserts each service's foreign writes as a model→**count** map (removing one of two writes to the same foreign model fails), the ordered `notifyChanged` push signature + one-emit-per-method, and each service's edge set mirrors §1 |
| Per-mutation consequence set (§3) | **test-enforced** | `apps/api/test/integration/phase2-consequences.test.ts` (live PG) — **42 isolated tests, one per semantic branch**, each in a fresh capture window asserting the exact canonical write, audit action+actor, DecisionEvent, notification, socket payload `{ projectId }`, push body+roles, the NO-side-effect facts (no push / no signal / no audit where none is due) and rollback |
| Command-inventory route surface (§4) — SIGNATURES | **test-enforced** | `cross-module-graph.test.ts` pins the exact **ordered route signatures** per controller (66 total) — replacing one route with another (same count) fails; a new controller with a mutating route fails until documented |
| Auth PROVISIONING writes (§4) | **test-enforced** | `cross-module-graph.test.ts` pins `auth.service.ts` writes = `{ user, membership, workerDevice }` — the fact that verify/worker-token provisioning writes project/org-scoped identity rows (finding 1), not "auth writes nothing" |
| Projection dependency matrix (§2) event→consumer→authz→rebuild mapping | **design reference** | not directly executable — it is the contract Tasks 3/4 (event catalog) and Tasks 9/10 (projection cutover) implement and test; each projection ships with its own rebuild + authz tests then. Every event named below is an EXACT `type@version` (no wildcards). |

This satisfies canonical spec §21 and the plan's Task 1 Steps 2–6. Downstream tasks that change any test-enforced line here must update the pinning test in the **same** PR.

---

## §0. Event catalog (design reference for §2) — every event is an exact `type@version`

Phase 2 Task 4 declares the DomainEvent catalog. Every projection in §2 subscribes to EXACT event types (all `@1` at the Task-1 baseline); there are **no wildcards** — a `phase.*` would not be an implementable subscription. The complete per-aggregate vocabulary the pillars will emit:

- **decision:** `decision.drafted@1`, `decision.published@1`, `decision.approved@1`, `decision.reapproved@1`, `decision.change_requested@1`, `decision.change_withdrawn@1`
- **activity:** `activity.created@1`, `activity.updated@1`, `activity.deleted@1`, `activity.started@1`, `activity.completion_requested@1`, `activity.signed_off@1`, `activity.signoff_rejected@1`, `activity.override_granted@1`, `activity.override_revoked@1`, `activity.readiness_changed@1`
- **phase:** `phase.created@1`, `phase.removed@1`
- **inspection:** `inspection.created@1`, `inspection.submitted@1`, `inspection.approved@1`, `inspection.rejected@1`, `inspection.reinspection_created@1`
- **drawing:** `drawing.issued@1`, `drawing.revised@1`, `drawing.published@1`, `drawing.recipients_frozen@1`, `drawing.acknowledged@1`, `drawing.refiled@1`, `drawing.removed@1`
- **dailylog / material:** `dailylog.started@1`, `dailylog.submitted@1`, `material.added@1`, `material.mismatch_flagged@1`
- **node:** `node.created@1`, `node.published@1`, `node.renamed@1`, `node.moved@1`, `node.removed@1`
- **media:** `media.uploaded@1`, `media.refiled@1`, `media.removed@1`
- **project:** `project.created@1`, `project.updated@1`, `project.archived@1`, `project.restored@1`
- **membership (project) / orgMembership (org):** `membership.added@1`, `membership.role_changed@1`, `membership.discipline_changed@1`, `membership.removed@1`; `orgMembership.added@1`, `orgMembership.role_changed@1`, `orgMembership.removed@1`
- **org:** `org.created@1`, `org.updated@1`

**Membership drives drawing eligibility (finding 3):** a drawing's ack + drawing-gate projections intersect the revision's FROZEN recipient set with the ACTIVE membership set, so `membership.added@1` / `membership.removed@1` / `membership.role_changed@1` MUST invalidate those projections — a removed engineer stops owing an ack; a newly-added one may begin owing it.

---

## §1. Cross-module edge decision table (plan finding 4)

Today the backend is one flat `AppModule` (`apps/api/src/app.module.ts:46-102`, 15 controllers + 24 providers). Modules reach into each other by writing another domain's tables through the shared `PrismaService`. Each edge is assigned **exactly one** Phase-2 mechanism — **synchronous query/validation** (permitted in the initiating transaction, spec §6), **atomic workflow contract** (transaction-bound participants, one unit of work), **database FK action**, or **asynchronous event**. Task 7's boundary CI check enforces this; no edge is an indefinite waiver. The classifier counts the write SITES per foreign model (the `writes` column), so a rerouted single write of a multi-write edge is visible.

| # | Edge (writer → foreign domain) | Site · writes | What it does today | Phase-2 mechanism | Rationale |
|---|---|---|---|---|---|
| 1 | `activities.complete` → **Inspection** | `activities.service.ts:302` · 1 | Creates the closing Inspection in the SAME transaction as the activity→`awaiting_signoff` CAS | **Atomic workflow contract** | Phase 1 invariant: activity + its closing inspection commit or roll back together. Cannot be an async event. |
| 2 | `inspections.decide` (approve) → **Activity** | `inspections.service.ts:169,178` · 2 | Closing-inspection approval writes Activity `done`+`doneAt` (CAS + a legacy-doneAt fallback) atomically | **Atomic workflow contract** | Same sign-off unit of work as #1. |
| 3 | `inspections.decide` (reject) → **Activity** | `inspections.service.ts:282` · 1 | Rejection reverts Activity `awaiting_signoff\|done`→`in_progress`, clears `doneAt` | **Atomic workflow contract** | Same sign-off unit of work; a half-reverted activity is forbidden. (inspections writes Activity at **3** sites total — the count the classifier pins.) |
| 4 | `daily-log.flagMismatch` → **Activity** | `daily-log.service.ts:43` · 1 | Sets linked Activity `gateMaterial='fail'`, `status='blocked'`, `block` under the readiness lock | **Atomic workflow contract** (material→readiness) | One transaction under the per-project advisory lock. |
| 5 | `activities.remove` → **Drawing** | `activities.service.ts:159` · 1 | Nulls `Drawing.activityId` for drawings linked to the deleted activity | **Database FK action** (`ON DELETE SET NULL`) | Referential cleanup, not a business consequence. |
| 6 | `phases.remove` → **Activity** | `phases.service.ts:56` · 1 | Nulls `Activity.phaseId` for activities of the removed phase | **Database FK action** (`ON DELETE SET NULL`) | Referential unfiling — declared in the schema. |
| 7 | `nodes.remove` → **Activity, Inspection, Media, Drawing, SiteMaterial** | `nodes.service.ts:99-103` · 1 each | Nulls the `(projectId,nodeId)` FK across five domains (composite FKs are `NO ACTION` today) | **Database FK action** (`ON DELETE SET NULL`) | Referential unfiling. (Decisions are the one reference `remove` refuses to null — a guard, not a write.) |
| 8 | `orgs.createProject` → **ProjectNode, Phase, Activity, Inspection** | `orgs.service.ts` · projectNode 3, phase 2, activity 2, inspection 2 | Directly writes four foreign domains to instantiate a new project | **Atomic workflow contract** (module initializer contracts, one unit of work) | No partially-initialized project. |

Plus an identity-boundary reach the classifier pins separately: **`auth.signInOrProvision` / `auth.workerToken` → User + Membership + WorkerDevice** (the orgs-owned identity tables), the provisioning writes §4 documents.

**Read + signal coupling** (not table writes, but coupling Phase 2 formalizes): `SnapshotService` and `RealtimeGateway` are injected into all eight emitting services; every mutation ends by rebuilding the full snapshot and emitting the content-free `changed` signal — **exactly 30** `notifyChanged(` call sites, now pinned per file by their **ordered push signature** (silent / exact roles / dynamic) AND a one-emit-per-method invariant (a moved signal fails, not just a count change). Task 6 moves the signal + Web Push behind the per-consumer outbox; Task 9 replaces the full-snapshot read with the shell summary + module queries. The synchronous read validations `resolveProjectNode`/`resolveProjectRef` and the `FOR UPDATE` membership reads are **permitted** same-transaction queries (spec §6) and stay synchronous.

---

## §2. Projection dependency matrix (plan finding 6)

The three cross-cutting read surfaces the Task-4 event catalog must feed and Tasks 9/10 must serve from rebuildable projections. Every event below is an **exact `type@version`** from §0 — no wildcards. Every projection also keeps a **query-time authorization check** (a projection is never an RBAC bypass). Columns: **Consumer** = the projection that subscribes; **Rebuild query** = the executable derivation that regenerates the row from canonical records.

### Inbox — `selectActionItems(state)` (`apps/web/src/store/selectors.ts:252-318`)

| Projection row · subject | Source (collection · fields) | Events `type@version` | Consumer | Query-time authz | Rebuild query (pseudocode) |
|---|---|---|---|---|---|
| `pending` · project | `decisions` where `status='pending' && !draft` (`:255`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `inbox` | role ∈ {client,pmc} (pending never leaks) | `SELECT id,title,ageDays FROM decision WHERE projectId=:p AND status='pending' AND publishedAt IS NOT NULL` |
| `reapprove`/`change` · project | `decisions` where `status='change' && !draft` (`:256`) | `decision.change_requested@1`, `decision.change_withdrawn@1`, `decision.reapproved@1` | `inbox` | role ∈ {client,pmc,contractor} | `… WHERE status='change' AND publishedAt IS NOT NULL` |
| `drafts` · **author** | `decisions.draft` ⧺ `drawings.draft` (`:258`) | `decision.drafted@1`, `decision.published@1`, `drawing.issued@1`, `drawing.published@1` | `inbox` | **author** (`authorId===userId`) — author-private | `SELECT id FROM decision WHERE projectId=:p AND publishedAt IS NULL AND authorId=:u` (∪ drawing) |
| `ack` · per-user | `drawings` `!draft && current.status='for_construction' && !ackedByMe && recipientOfCurrent` (`:262`) + consultant discipline bucket (`:312`) | `drawing.issued@1`, `drawing.published@1`, `drawing.revised@1`, `drawing.recipients_frozen@1`, `drawing.acknowledged@1`, **`membership.added@1`, `membership.removed@1`, `membership.role_changed@1`** | `inbox` | role ∈ {engineer,contractor,consultant}; per-user `ackedByMe` over the **frozen recipient set ∩ active members** | `governing rev per drawing; recipients = DrawingRecipient(revId) ∩ active membership; row when :u ∈ recipients AND no DrawingAck(revId,:u)` — a membership change re-computes eligibility |
| `blocked` · project | `activities` where `status='blocked'` (`:263`) | `activity.readiness_changed@1`, `material.mismatch_flagged@1` | `inbox` | role=pmc | `SELECT id FROM activity WHERE projectId=:p AND status='blocked'` |
| `reviews` · project | `reviews` (submitted, undecided) (`:288`) | `inspection.submitted@1`, `inspection.approved@1`, `inspection.rejected@1`, `inspection.reinspection_created@1` | `inbox` | role=pmc (queue pmc-only) | `SELECT id FROM inspection WHERE projectId=:p AND submitted AND NOT decided` |
| `eng-checklist` · project | `checklist` = the **first** `submitted:false` checklist SnapshotService returns, **no assignee filter** (`snapshot.service.ts:214`) | `inspection.created@1`, `inspection.submitted@1` | `inbox` | role=engineer | `SELECT … FROM inspection WHERE projectId=:p AND kind='checklist' AND NOT submitted ORDER BY id LIMIT 1` — **NB: not assignee-scoped today; a per-engineer projection is a Phase-2 product decision, not the current behavior** |
| `eng-log` · project | `dailyLog` (`.submitted`, `.checkedIn`) (`:277`) | `dailylog.started@1`, `dailylog.submitted@1` | `inbox` | role=engineer | latest `dailyLog` by `(logDate,createdAt,id)`; row when `NOT submitted` |
| `drawing-gate` · project | `activities` `status='not-started'` × `readinessFor(a).drawing ∈ {wait,fail}` (`:293-298`) | `activity.readiness_changed@1`, `drawing.issued@1`, `drawing.published@1`, `drawing.revised@1`, `drawing.acknowledged@1`, **`membership.added@1`, `membership.removed@1`, `membership.role_changed@1`** | `inbox` | role=pmc | recompute drawing gate per activity via `deriveReadiness`; row when `not-started AND drawingGate∈{wait,fail}` — the gate depends on the recipient∩membership set, so a membership change re-derives it |
| `override-expiry` · project | `activities[].overrides` expiring ≤7d (`:300-305`) | `activity.override_granted@1`, `activity.override_revoked@1`, **+ a scheduled clock tick** | `inbox` | role=pmc | `SELECT … FROM gateOverride WHERE projectId=:p AND expiresAt BETWEEN now() AND now()+7d` — **time-driven: crossing the 7-day threshold fires NO mutation event, so this projection needs a scheduled refresh (a daily clock tick / cron consumer), not only event-driven invalidation** |
| consultant scope · per-user | membership `discipline` (`:308-315`) | `membership.role_changed@1`, `membership.discipline_changed@1`, `membership.removed@1` | `inbox` | membership on `activeProjectId`; discipline from `memberships` | `SELECT role,discipline FROM membership WHERE projectId=:p AND userId=:u AND status='active'` |

### Dashboard (single-project surface, `screens/DashboardScreen.tsx` + `selectors.ts`) — **every rendered field**

| Row · field | Source (selector/store · file:line) | Events `type@version` | Consumer | Authz | Rebuild query |
|---|---|---|---|---|---|
| project identity `name/descriptor/stage/siteCode` | store project meta (`DashboardScreen.tsx:23-26`) | `project.updated@1` | `dashboard-shell` | project (all roles) | `SELECT name,descriptor,stage,siteCode FROM project WHERE id=:p` |
| `milestonePct` | store (`:27`) | `project.updated@1`, `activity.created@1`, `activity.deleted@1`, `activity.signed_off@1`, `inspection.approved@1` | `dashboard-shell` | project (all roles) | `project.milestonePct` (= done ÷ total activities) |
| milestone strip: phase `name`+`donePct` | `phases[]` (`:28,32`) | `phase.created@1`, `phase.removed@1`, `activity.created@1`, `activity.deleted@1`, `activity.signed_off@1`, `activity.signoff_rejected@1`, `activity.readiness_changed@1` | `dashboard-phases` | project (all roles) | `SELECT name, donePct FROM phase WHERE projectId=:p ORDER BY order` (donePct = done ÷ total in phase) |
| daily-log status `checkedIn/submitted/workers/materials/progress` | `dailyLog.checkedIn/submitted/crew/materials/progress` (`:16-19`) + `selectTotalWorkers` (`selectors.ts:214`) | `dailylog.started@1`, `dailylog.submitted@1`, `material.added@1` | `dashboard-site` | project (all roles) | latest `dailyLog`; `workers=Σ crew.count`; `materials=count(siteMaterial in log)`; `progress=dailyLog.progress` |
| pending tile `count` + **decision ageing** | `selectPending` (`selectors.ts:20`) + `pending[].ageDays` (`:38`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `dashboard-inbox` | pmc/client | `SELECT count(*), max(ageDays) FROM decision WHERE projectId=:p AND status='pending' AND publishedAt IS NOT NULL` |
| review tile `count` + **review title** | `selectReviewPending` (`:68`) + `selectActiveReview.title` (`:60`) | `inspection.submitted@1`, `inspection.approved@1`, `inspection.rejected@1` | `dashboard-inbox` | pmc | `count + first-review title FROM inspection WHERE submitted AND NOT decided` |
| failed tile `failedCount` | `selectFailedCount` (`:81`) — `reinspectionCreated`, `reviews[].items[].result='FAIL'`/`rejected` | `inspection.approved@1`, `inspection.rejected@1`, `inspection.reinspection_created@1` | `dashboard-inbox` | pmc | derived per §3 fail ternary |
| photos tile + highlights `id/url/kind/takenAt` | `selectPhotoStats` (`:227`) + `photos[]` (`:30`, rendered id/url/kind/takenAt) | `media.uploaded@1`, `media.refiled@1`, `media.removed@1` | `dashboard-photos` | project (all roles) | `SELECT id,url,kind,takenAt,nodeId FROM media WHERE projectId=:p AND kind∈{progress,inspection,material}` |

_(Correction: `selectSchToday` (`selectors.ts:161`) is **not** rendered by the Dashboard — the "View Schedule" button only navigates; it belongs to the Schedule screen, not this projection.)_

### Portfolio (cross-project, `orgs.service.portfolio(userId)` `orgs.service.ts:845-903`; `PortfolioProject` type `:21-38`) — **every field**

| Row field | Canonical source (file:line) | Events `type@version` | Consumer | Authz | Rebuild query |
|---|---|---|---|---|---|
| `projectId` | `project.id` (`:884`) | `project.created@1`, `project.archived@1`, `project.restored@1` | `portfolio` | per-user | membership/reach set (below) |
| `name` / `short` / `stage` | `project.name/short/stage` (`:885-887`) | `project.updated@1` | `portfolio` | per-user × per-project | `SELECT name,short,stage FROM project` |
| `role` | `Membership.role`, or `'pmc'` for org owner/admin reach (`:888,859`) | `membership.added@1`, `membership.role_changed@1`, `orgMembership.added@1`, `orgMembership.role_changed@1`, `orgMembership.removed@1` | `portfolio` | per-user | `membership.role` (owner/admin → pmc) |
| `orgName` | `project.org.name` (`:889`) | `org.updated@1` | `portfolio` | per-user × per-project | `SELECT org.name FROM project JOIN org` |
| `milestonePct` | `project.milestonePct` (`:899`) | `project.updated@1`, `activity.created@1`, `activity.deleted@1`, `activity.signed_off@1` | `portfolio` | per-user × per-project | `project.milestonePct` |
| `activityTotal/done/inProgress/blocked/notStarted/donePct` | `Activity.status` aggregate (`:874,879-895`) | `activity.created@1`, `activity.started@1`, `activity.completion_requested@1`, `activity.signed_off@1`, `activity.signoff_rejected@1`, `activity.readiness_changed@1`, `activity.deleted@1` | `portfolio` | per-project | `SELECT count(*) FILTER(status=…) FROM activity WHERE projectId=:p` |
| `openReviews` | `Inspection.count(submitted, !decided)` (`:875`) | `inspection.submitted@1`, `inspection.approved@1`, `inspection.rejected@1` | `portfolio` | per-project | `SELECT count(*) FROM inspection WHERE submitted AND NOT decided` |
| `pendingDecisions` | `Decision.count(pending)` **RBAC-gated** `canSeePending=role∈{pmc,client}` (`:872,876`) | `decision.published@1`, `decision.approved@1`, `decision.change_requested@1` | `portfolio` | per-user × per-project (0 for non-pmc/client) | `IF role∈{pmc,client}: count(pending) ELSE 0` |
| `phaseCount` | `Phase.count` (`:877`) | `phase.created@1`, `phase.removed@1` | `portfolio` | per-project | `SELECT count(*) FROM phase WHERE projectId=:p` |
| project-list rows / archive filter | active `Membership` (`:846`) + org owner/admin reach (`:854-861`); `!project.archivedAt` (`:851`) | `membership.added@1`, `membership.removed@1`, `membership.role_changed@1`, `orgMembership.added@1`, `orgMembership.removed@1`, `project.archived@1`, `project.restored@1` | `portfolio` | **per-user**; a `membership.removed@1` must invalidate the user's rows (query-time membership check remains) | `active memberships ∪ (owner/admin → all non-archived org projects)` |

**Cross-cutting authz note:** pending-decision visibility derives from the SAME rule in two places — the snapshot's `hidePending = role∉{pmc,client}` (`snapshot.service.ts:110`) and portfolio's `canSeePending` (`orgs.service.ts:872`). Any projection for either preserves that rule at query time, and a `membership.removed@1`/`membership.role_changed@1` event must invalidate or replace the affected user-specific rows without leaking the prior view.

---

## §3. Per-mutation consequence set (plan Task 1 Step 4)

The consequence bundle each pillar mutation produces today (the set Tasks 3–6 reproduce via the DomainEvent envelope + per-consumer outbox). **Actor column** distinguishes `resolveActor` (real `actorId`, `common/actor.ts:21`) from a **bare** `actor: user.role` (null `actorId`) — the attribution split Task 3 closes. **Every branch is asserted in its own isolated test with a fresh capture window** in `phase2-consequences.test.ts` (**42 tests**, real socket + push capture): the exact canonical write, audit, event, notification, socket payload `{ projectId }`, push body+roles, the no-side-effect facts, and rollback.

| Mutation | Canonical write | Audit (action · actor) | DecisionEvent | Notification | `changed` push roles | Cross-domain |
|---|---|---|---|---|---|---|
| `decisions.create` (publish) | Decision + options | `decision.create` · **resolveActor** | issued | +1 | `['client']` | — |
| `decisions.create` (draft) | Decision + options | `decision.draft` · **resolveActor** | drafted | none | **no signal at all** | — |
| `decisions.publish` | Decision.publishedAt | `decision.publish` · **resolveActor** | issued | +1 | `['client']` | — |
| `decisions.approve` | Decision→approved (CAS) | `decision.approve` · **resolveActor** | approved\|reapproved | +1 | `['pmc','contractor','engineer']` | — |
| `decisions.requestChange` | Decision→change + ChangeRequest | `decision.change` · **resolveActor** | change_requested | none | bare `changed` (no push) | — |
| `decisions.withdrawChange` | Decision→approved | `decision.change_withdraw` · **resolveActor** | change_withdrawn | none | bare `changed` | — |
| `activities.create` | Activity | `activity.create` · **bare role** | — | none | `['engineer','contractor']` | — |
| `activities.update` | Activity | `activity.update` · **bare role** | — | none | bare `changed` | — |
| `activities.remove` | Activity delete | `activity.delete` · **bare role** | — | none | bare `changed` | **Drawing** (edge 5) |
| `activities.start` | Activity CAS→in_progress | `activity.start` · **bare role** | — | none | bare `changed` | — |
| `activities.complete` | Activity CAS→awaiting_signoff | `activity.complete_requested` · **resolveActor** | — | +1 | `['pmc']` | **Inspection** (edge 1) |
| `activities.override` | GateOverride create | `activity.override` · **resolveActor** | — | none | `['engineer','contractor']` | — |
| `activities.revokeOverride` | GateOverride delete | `activity.override_revoke` · **resolveActor** | — | none | bare `changed` | — |
| `phases.create` | Phase | `phase.create` · **bare role** | — | none | bare `changed` | — |
| `phases.remove` | Phase delete | `phase.delete` · **bare role** | — | none | bare `changed` | **Activity** (edge 6) |
| `inspections.create` | Inspection + items | `inspection.create` · **resolveActor** | — | +1 | `['engineer']` | — |
| `inspections.submit` | Inspection CAS→submitted + items | `inspection.submit` · **resolveActor** | — | none | bare `changed` | — |
| `inspections.decide` (approve) | Inspection→decided | `inspection.approve` + `activity.signoff` · **resolveActor** | — | +1 | `['contractor','client']` | **Activity** done+doneAt (edge 2) |
| `inspections.decide` (reject) | Inspection→decided + reinspection child | `inspection.reject` + `activity.signoff_rejected` · **resolveActor** | — | +1 | `['engineer']` | **Activity** →in_progress (edge 3) |
| `drawings.issue` (publish) | Drawing/Revision + frozen recipients | `drawing.issue` · **resolveActor** | — | none | `['engineer','contractor']` | — |
| `drawings.issue` (draft) | Drawing/Revision, publishedAt null | `drawing.issue` · **resolveActor** | — | none | **no signal at all** (a draft reaches no one) | — |
| `drawings.issue` (revise on published) | new Revision, prior superseded | `drawing.revise` · **resolveActor** | — | none | `['engineer','contractor']` | — |
| `drawings.publish` | Drawing→published | `drawing.publish` · **resolveActor** | — | none | `['engineer','contractor']` | — |
| `drawings.acknowledge` (first) | DrawingAck + audit | `drawing.ack` · **resolveActor** | — | none | `['pmc']` | — |
| `drawings.acknowledge` (replay) | nothing (idempotent) | **none** | — | none | **no signal at all** | — |
| `drawings.setNode` | Drawing.nodeId | `drawing.refile` · **resolveActor** | — | none | bare `changed` | — |
| `drawings.remove` | Drawing delete | `drawing.remove` · **resolveActor** | — | none | bare `changed` | — |
| `daily-log.start` | DailyLog + crew | `dailylog.start` · **bare role** | — | none | bare `changed` | — |
| `daily-log.addMaterial` | SiteMaterial | `material.add` · **bare role** | — | none | bare `changed` | — |
| `daily-log.flagMismatch` | SiteMaterial.matched=false | `material.mismatch` · **bare role** | — | +1 | `['pmc','contractor']` | **Activity** gate/status/block (edge 4) |
| `daily-log.submit` | DailyLog→submitted + crew | `dailylog.submit` · **bare role** | — | none | bare `changed` | — |
| `nodes.{create,publish,rename,move,remove}` | ProjectNode | **none** (no audit) | — | none | bare `changed` | remove → 5 domains (edge 7) |
| `media.{create,setNode,remove}` | Media | **none** (no audit) | — | none | bare `changed` | — |

**Attribution split (the finding Task 3 closes):** `decisions.*`, `inspections.*`, `drawings.*`, `activities.{complete,override,revokeOverride}` use `resolveActor` (real `actorId`); `activities.{create,update,remove,start}`, `phases.*`, and all of `daily-log.*` write a **bare** `actor: user.role` with null `actorId`; `nodes.*` and `media.*` write **no audit row at all**. There is **no audit READ API** — audit is write-only today.

---

## §4. Command inventory (plan finding 5 — the checklist Task 10's gate verifies fully migrated)

Every state-changing HTTP route (**66 total**, ordered route signatures pinned per controller by `cross-module-graph.test.ts`). Columns per the Task-5 ledger design:

- **scopeKind** (`project`|`org`) + the subject id(s) the `CommandExecution` partial unique index keys on.
- **key source** — the client-supplied idempotency key that keys the ledger row. **The honest state today (finding 1):** the frontend offline outbox variants (`apiGateway.ts:688` `OutboxOp`) carry **no operation id**, and only `media.create` sends a `clientKey` (`contracts.ts:130`). So **no command except `media.create` is idempotent today** — every other row is annotated `none today → Task N key`, meaning the ledger's Task-5 schema plus the migrating task (Task 8 for decisions, Task 10 for the rest) must have the client GENERATE and send a stable per-command key; the ledger cannot adopt a key that does not yet exist.
- **request-hash inputs** — the EXACT validated request DTO fields (from `contracts.ts`, no `…`) hashed for the same-key/different-payload → 409 rule. Routes whose body is empty (id is in the path) hash the path subject.
- **result ref** — the entity the committed command's `resultRef` resolves to, replayed to the same actor+scope once a key exists.
- **task** = the Phase-2 task that migrates the route onto the ledger.

### Project-scoped commands (`scopeKind='project'`, subject `(projectId, actorId, commandType, key)`)

| Command · path | `@Roles` | key source | request-hash inputs (exact) | result ref | task |
|---|---|---|---|---|---|
| `decisions.create` POST `/projects/:p/decisions` | pmc | none today → Task 8 key | `{title, nodeId?, room, options:[{label?,material,delta,swatch,photoUrl?,recommended}], publish}` | `Decision.id` | 8 |
| `decisions.publish` POST `…/decisions/:id/publish` | pmc | none today → Task 8 key | path `{decisionId}` | `Decision.id` | 8 |
| `decisions.approve` POST `…/decisions/:id/approve` | client,pmc | none today → Task 8 key | `{decisionId, optionIndex}` | `Decision.id` | 8 |
| `decisions.requestChange` POST `…/decisions/:id/change` | pmc,client,contractor,engineer,consultant | none today → Task 8 key | `{decisionId, reason, costImpact, timeImpactDays}` | `ChangeRequest.id` | 8 |
| `decisions.withdrawChange` POST `…/decisions/:id/change/withdraw` | pmc,client,contractor,engineer,consultant | none today → Task 8 key | path `{decisionId}` | `Decision.id` | 8 |
| `activities.create` POST `/projects/:p/activities` | pmc | none today → Task 10 key | `{name, zone, plannedStart, plannedEnd, plannedStartDate?, plannedEndDate?, phaseId?, decisionId?, nodeId?, gateMaterial, gateTeam}` | `Activity.id` | 10 |
| `activities.update` PATCH `…/activities/:id` | pmc | none today → Task 10 key | `{activityId, name?, zone?, plannedStart?, plannedEnd?, plannedStartDate?, plannedEndDate?, phaseId?, decisionId?, nodeId?, gateMaterial?, gateTeam?}` | `Activity.id` | 10 |
| `activities.remove` DELETE `…/activities/:id` | pmc | none today → Task 10 key | path `{activityId}` | `Activity.id` | 10 |
| `activities.start` POST `…/activities/:id/start` | engineer,pmc | none today → Task 10 key | path `{activityId}` | `Activity.id` | 10 |
| `activities.complete` POST `…/activities/:id/complete` | engineer,pmc | none today → Task 10 key | path `{activityId}` | `Activity.id` (+ closing `Inspection.id`) | 10 (workflow contract) |
| `activities.override` POST `…/activities/:id/override` | pmc | none today → Task 10 key | `{activityId, gate, state, reason, evidenceMediaId?, expiresAt}` | `GateOverride.id` | 10 |
| `activities.revokeOverride` DELETE `…/activities/:id/override/:oid` | pmc | none today → Task 10 key | path `{activityId, overrideId}` | `Activity.id` | 10 |
| `phases.create` POST `/projects/:p/phases` | pmc | none today → Task 10 key | `{name, plannedStart, plannedEnd, plannedStartDate?, plannedEndDate?}` | `Phase.id` | 10 |
| `phases.remove` DELETE `…/phases/:id` | pmc | none today → Task 10 key | path `{phaseId}` | `Phase.id` | 10 |
| `inspections.create` POST `/projects/:p/inspections` | pmc | none today → Task 10 key | `{title, zone, items:[string], nodeId?, activityId?}` | `Inspection.id` | 10 |
| `inspections.submit` POST `…/inspections/:id/submit` | engineer,pmc | none today → Task 10 key | `{inspectionId, items:[{id,name,state,photos,note}]}` | `Inspection.id` | 10 |
| `inspections.decide` POST `…/inspections/:id/decide` | pmc | none today → Task 10 key | `{inspectionId, approve, rejectedItemIds:[string], assigneeId?, dueInDays?}` | `Inspection.id` (+ child on reject) | 10 (workflow contract) |
| `drawings.issue` POST `/projects/:p/drawings` | pmc | none today → Task 10 key | `{number, title, discipline, rev, status, mime, data?, storageKey?, sizeBytes?, note?, zone?, activityId?, decisionId?, nodeId?, publish}` | `DrawingRevision.id` | 10 |
| `drawings.publish` POST `…/drawings/:id/publish` | pmc | none today → Task 10 key | path `{drawingId}` | `Drawing.id` | 10 |
| `drawings.presign` POST `…/drawings/presign` | pmc | **exclusion** — pre-upload URL mint from `{mime}`, no canonical write (records only an upload session) | (n/a) | (n/a) | 10 (documented exclusion) |
| `drawings.acknowledge` POST `…/drawings/rev/:rid/ack` | pmc,engineer,contractor | already idempotent by `(revisionId,userId)` unique; a Task-10 key aligns the ledger | path `{revisionId}` | `DrawingAck.id` | 10 |
| `drawings.setNode` PATCH `…/drawings/:id/node` | pmc | none today → Task 10 key | `{drawingId, nodeId?}` (nullable) | `Drawing.id` | 10 |
| `drawings.remove` DELETE `/drawings/:id` | pmc | none today → Task 10 key | path `{drawingId}` | `Drawing.id` | 10 |
| `daily-log.start` POST `/projects/:p/daily-log/start` | engineer,pmc | none today → Task 10 key | `{}` (server derives the civil day) | `DailyLog.id` | 10 |
| `daily-log.addMaterial` POST `…/daily-log/materials` | engineer,pmc | none today → Task 10 key | `{name, qty, zone, decisionId?, swatch, nodeId?}` | `SiteMaterial.id` | 10 |
| `daily-log.flagMismatch` POST `…/daily-log/flag-mismatch` | engineer,pmc | none today → Task 10 key | `{decisionId}` | `SiteMaterial.id` | 10 (workflow contract) |
| `daily-log.submit` POST `…/daily-log/submit` | engineer,pmc | none today → Task 10 key | `{checkedIn, checkinTime, progress, crew:[{trade,count}]}` | `DailyLog.id` | 10 |
| `nodes.create` POST `/projects/:p/nodes` | pmc | none today → Task 10 key | `{name, kind, parentId?, publish}` | `ProjectNode.id` | 10 |
| `nodes.rename` PATCH `…/nodes/:id` | pmc | none today → Task 10 key | `{nodeId, name}` | `ProjectNode.id` | 10 |
| `nodes.move` POST `…/nodes/:id/move` | pmc | none today → Task 10 key | `{nodeId, parentId, order?}` (parentId nullable) | `ProjectNode.id` | 10 |
| `nodes.publish` POST `…/nodes/:id/publish` | pmc | none today → Task 10 key | path `{nodeId}` | `ProjectNode.id` | 10 |
| `nodes.remove` DELETE `…/nodes/:id` | pmc | none today → Task 10 key | path `{nodeId}` | `ProjectNode.id` | 10 (FK actions) |
| `media.create` POST `/projects/:p/media` | pmc,engineer | **`clientKey`** (exists today, `contracts.ts:130`) | `{kind, mime, data, decisionId?, dailyLogId?, inspectionId?, inspectionItemId?, clientKey?, nodeId?, geoLat?, geoLng?, takenAt?}` | `Media.id` | 10 (already keyed — the ledger adopts `clientKey`) |
| `media.setNode` PATCH `…/media/:id/node` | pmc,engineer | none today → Task 10 key | `{mediaId, nodeId?}` (nullable) | `Media.id` | 10 |
| `media.remove` DELETE `/media/:id` | pmc,engineer | none today → Task 10 key | path `{mediaId}` | `Media.id` | 10 |
| `members.add` POST `/projects/:p/members` | MEMBERS_AUTHZ | none today → Task 10 key | `{name, role, email?, phone?, discipline?}` | `Membership.id` | 10 |
| `members.updateRole` PATCH `…/members/:uid` | MEMBERS_AUTHZ | none today → Task 10 key | `{userId, role, discipline?}` | `Membership.id` | 10 |
| `members.remove` DELETE `…/members/:uid` | MEMBERS_AUTHZ | none today → Task 10 key | path `{userId}` | `Membership.id` | 10 |
| `companies.add` POST `/projects/:p/companies` | COMPANIES_AUTHZ | none today → Task 10 key | `{name, kind, contactName?, contactEmail?, contactPhone?, notes?}` | `ProjectCompany.id` | 10 |
| `companies.update` PATCH `…/companies/:id` | COMPANIES_AUTHZ | none today → Task 10 key | `{companyId, name?, kind?, contactName?, contactEmail?, contactPhone?, notes?}` | `ProjectCompany.id` | 10 |
| `companies.remove` DELETE `…/companies/:id` | COMPANIES_AUTHZ | none today → Task 10 key | path `{companyId}` | `ProjectCompany.id` | 10 |
| `push.subscribe` POST `/projects/:p/push/subscribe` | JwtGuard only | **exclusion** — device push-subscription registration, per-endpoint idempotent already (`endpoint` unique); not a project fact | `{subscription:{endpoint,keys:{p256dh,auth}}}` | (n/a) | 10 (documented exclusion) |

### Org-scoped commands (`scopeKind='org'`, subject `(organizationId, actorId, commandType, key)`, `projectId` NULL)

| Command · path | `@Roles` | key source | request-hash inputs (exact) | result ref | task |
|---|---|---|---|---|---|
| `orgs.createOrg` POST `/orgs` | pmc,client,engineer,contractor | none today → Task 10 key | `{name}` | `Org.id` | 10 |
| `orgs.addOrgMember` POST `/orgs/:o/members` | ORG_AUTHZ | none today → Task 10 key | `{name, email?, phone?, role}` | `OrgMembership.id` | 10 |
| `orgs.updateOrgMemberRole` PATCH `/orgs/:o/members/:uid` | ORG_AUTHZ | none today → Task 10 key | `{userId, role}` | `OrgMembership.id` | 10 |
| `orgs.removeOrgMember` DELETE `/orgs/:o/members/:uid` | ORG_AUTHZ | none today → Task 10 key | path `{userId}` | `OrgMembership.id` | 10 |
| `orgs.createProject` POST `/orgs/:o/projects` | ORG_AUTHZ | none today → Task 10 key | `{name, short, descriptor, stage, siteCode, location, projStart, projEnd, scheduleStartDate?, timeZone?, structureFrom?, modules?, templateId?}` | `Project.id` | 10 (workflow contract) |
| `orgs.updateProject` PATCH `/orgs/:o/projects/:p` | ORG_AUTHZ | none today → Task 10 key | `{pid, name?, short?, descriptor?, stage?, siteCode?, location?, projStart?, projEnd?}` | `Project.id` | 10 |
| `orgs.deleteProject` DELETE `/orgs/:o/projects/:p` | ORG_AUTHZ | none today → Task 10 key | path `{pid}` | `Project.id` | 10 |
| `orgs.restoreProject` POST `/orgs/:o/projects/:p/restore` | ORG_AUTHZ | none today → Task 10 key | path `{pid}` | `Project.id` | 10 |
| `orgs.createModule` POST `/orgs/:o/modules` | ORG_AUTHZ | none today → Task 10 key | `{name, category, description, payload?, fromProject?, fromNodeId?}` | `TemplateModule.id` | 10 |
| `orgs.archiveModule` DELETE `/orgs/:o/modules/:id` | ORG_AUTHZ | none today → Task 10 key | path `{moduleId}` | `TemplateModule.id` | 10 |
| `orgs.createTemplate` POST `/orgs/:o/templates` | ORG_AUTHZ | none today → Task 10 key | `{name, description, items?, fromProject?}` | `ProjectTemplate.id` | 10 |
| `orgs.archiveTemplate` DELETE `/orgs/:o/templates/:id` | ORG_AUTHZ | none today → Task 10 key | path `{templateId}` | `ProjectTemplate.id` | 10 |

### Auth / identity commands — split by whether they WRITE (finding 1)

The blanket "auth writes nothing" exclusion was wrong. The twelve `auth.controller.ts` routes divide into three mechanisms:

**(a) Pure session — no canonical write, correctly excluded from the ledger.** `auth.switch`, `auth.session`, `auth.login`, `auth.otp/request`, `auth.email/request` — mint/refresh a token or send an OTP; no project/org row is created, and there is no authenticated actor subject to key a `CommandExecution` row. OTP replay-safety is the OTP store's single-use property + the rate limiter, not command idempotency.

**(b) Identity PROVISIONING — conditional project/org-scoped writes, a SEPARATELY documented command mechanism.** These DO write and must not be dismissed:

| Command · path | Conditional write | Idempotency mechanism (not a CommandExecution row) |
|---|---|---|
| `auth.otp/verify` POST `otp/verify` | first sign-in on a new phone + `AUTH_ALLOW_PHONE_SIGNUP` → `User` + active `Membership` on `projectId` (`auth.service.ts:145-158`) | natural key: `User.phone` unique — a returning number reuses the account and creates NO second user/membership; the provision runs only in the `!user` branch |
| `auth.email/verify` POST `email/verify` | first sign-in on a new email + `AUTH_ALLOW_SIGNUP` → `User` + active `Membership` | natural key: `User.email` unique — same reuse-not-recreate guarantee |
| `auth.google` POST `google` | verified-email first sign-in + `AUTH_ALLOW_SIGNUP` → `User` + active `Membership` | natural key: `User.email` unique (Google email must be `emailVerified`) |
| `auth.worker/token` POST `worker/token` | always mints a `WorkerDevice` on `projectId` (`auth.service.ts:264`) | **intentionally NON-idempotent** — each QR enrollment is a distinct device; the natural safety is `WORKER_ENROLL_SECRET` + the active-project check, not command dedup |

The classifier test pins `auth.service.ts` writes = `{ user, membership, workerDevice }`, so this provisioning surface cannot silently be re-described as write-free. Task 10's identity-command work adopts the natural-key mechanism above (unique `User.email`/`User.phone`; single-use OTP) rather than a `CommandExecution` row — because at provisioning time the actor (the account) does not yet exist, so the ledger's `(scope, actorId, key)` subject is undefined. This is the documented identity-command mechanism the plan requires, distinct from the project/org `CommandExecution` ledger.

**(c) Password credential security — identity-scoped durable commands, separately audited.** `auth.password/request`, `auth.password/verify`, and `auth.password/complete` create or CAS-update `PasswordCredentialChallenge`, append `SecurityAuditEvent`, and on completion update the named `User` credential. They have no project/org subject and may run before an application session exists, so they do not fit the `(scope, actorId, key)` command ledger. Their mechanism is a generic public response, rate limiting, HMAC OTP, hashed setup token, single-use database CAS, credential-version revocation and an append-only security audit.

**Route accounting:** 42 project + 12 org + 12 auth = **66** mutating routes, the count and per-controller ordered signatures pinned by `cross-module-graph.test.ts`.

---

_Task 1 stops here for its mandatory independent review. Task 2 does not begin until this review clears._
