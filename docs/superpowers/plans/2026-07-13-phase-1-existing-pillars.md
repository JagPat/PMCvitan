# Phase 1 — Complete the Existing Product Pillars

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not begin Task 1 until the independent Codex review of THIS PLAN clears.**

**Goal:** Make design intent, client consent, controlled drawings, field inspection, rejection, corrective work, reinspection and final sign-off one attributable information chain — so that procurement and payment (Phases 3/5) can later consume approved specification and accepted work, never editable flags.

**Architecture:** Preserve the existing React/Zustand + NestJS/Prisma/PostgreSQL modular monolith. Phase 1 completes the DOMAIN of the four existing pillars (decisions, drawings, inspections, activities) — it does not introduce the Phase 2 module registry, transactional outbox or projection framework. Lifecycle facts are recorded once in their owning module with real actor identity; readiness is derived from those facts at serialize time; the frontend consumes them through the existing snapshot and offline outbox.

**Tech Stack:** pnpm workspace, React 19, Zustand 5, Vitest 4, Playwright 1.61, NestJS 11, Prisma 6, PostgreSQL 16, TypeScript.

**Planning baseline:** `main` at `5d6f08b4c39737972b115dcfabf1bebbb25e0e10` (Phase 0 gate cleared — [final verdict](https://github.com/JagPat/PMCvitan/pull/96#issuecomment-4954752823)).

---

## Phase Intent (restated per the canonical spec's Phase Intent Map)

Decisions, drawings, inspections and activities already exist, but their change, evidence and completion loops are incomplete. Phase 1 exists so that design intent, client consent, field execution, rejection, corrective work and final sign-off form one auditable loop on a real site. It consumes the Phase 0 facts — trustworthy project identity, live authorization, same-project references, real civil dates — and produces the facts Phase 2+ need: locked/re-approved specifications, governing drawing revisions with acknowledgements, evidence-backed inspection outcomes, and completion that means "accepted", not "claimed".

## Current-State Revalidation (against `main` @ `5d6f08b`)

Every Phase 1 concept was revalidated against current code and tests before this plan was written. Verdicts: **COMPLETE** (works and is pinned by tests), **PARTIAL** (exists with material gaps), **INCORRECT** (exists but violates the invariant), **ABSENT** (does not exist).

### Decisions

| Concept | Verdict | Evidence |
|---|---|---|
| Lock after approval | PARTIAL | Re-approve of an `approved` decision → 409 (`decisions.service.ts:105`); no edit/delete route exists at all (`decisions.controller.ts` has only create/publish/approve/change). BUT the server-side lock has **zero test coverage** — no API test hits the 409. |
| Change control with mandatory re-approval | ABSENT (as an invariant) | `requestChange` creates a `ChangeRequest` row and flips status to `change` (`decisions.service.ts:128-142`) — but `ChangeRequest` is a **write-only table**: its `status` is never read or transitioned anywhere in the repo, nothing requires or tracks client re-approval, and "for client re-approval" is a UI flash string (`store.ts:718`), not a rule. No test anywhere touches the ChangeRequest row. |
| Immutable lifecycle events | PARTIAL | `DecisionEvent` rows are appended at all four transitions (`decisions.service.ts:65,87,117,136`) and no update/delete path exists — but the table is **never read or surfaced**, the schema-declared `locked` type is never emitted, the emitted `drafted` type is undocumented, and only `drafted` has a test (`decisions.service.test.ts:61`). |
| Attribution of approvals | INCORRECT | The approver is a hardcoded demo string — `user.role === 'client' ? 'Mr. Shah' : 'PMC'` (`decisions.service.ts:109`) — written to `Decision.approver`, `DecisionEvent.actor` and `AuditLog.actor`. The real user identity (`user.sub`) is captured only as `authorId` at create. `store.test.ts:37` pins the fake string. |

### Drawings

| Concept | Verdict | Evidence |
|---|---|---|
| Controlled issue (PMC-only, immutable revisions) | COMPLETE | Issue/publish/presign/setNode/delete are `@Roles('pmc')`, drift-guarded (`route-policy.test.ts:179-184`); no revision edit/delete path exists; supersede is transactional and tested (`drawings.service.test.ts:141-151`). Caveats: immutability is emergent (no guard), and no `@@unique([drawingId, rev])` prevents duplicate rev labels. |
| Governing-revision selection | PARTIAL | `current` = latest non-superseded rev (`snapshot.service.ts:217`) **regardless of status** — issuing a `for_review` rev supersedes a `for_construction` rev and becomes governing. The "field only builds from for_construction" invariant (schema comment, docs, register subtitle) is not enforced. |
| Distribution | ABSENT | No recipient/transmittal concept exists; only a transient hardcoded push audience `['engineer','contractor']` on issue (`drawings.service.ts:142`). |
| Acknowledgement tracking | COMPLETE | Per-revision `DrawingAck` (`@@unique([revisionId,userId])`), idempotent upsert, client/worker refused, audited, surfaced (`acks[]`, `ackedByMe`), fresh round on supersession — well tested. Gap: acks are **online-only** (not in the outbox; failure just flashes, `store.ts:948`). |
| Stale-revision protection | ABSENT | Nothing prevents starting/completing work governed by a superseded, unacknowledged or `for_review` drawing; there is no drawing gate (`transitions.ts:21`); the unacked-inbox nudge is advisory and ignores `for_review` currents (`selectors.ts:216`). |

### Inspections

| Concept | Verdict | Evidence |
|---|---|---|
| Real media evidence on items | ABSENT | `InspectionItem.photos` is an **integer counter** (`schema.prisma:555`); `swatch` is a CSS-gradient key; `Media` has **no** `inspectionId`/`inspectionItemId`; the engineer's "Add photo" is `it.photos += 1` (`store.ts:737`); the PMC review renders a gradient with a literal "PHOTO" badge (`InspectionReviewScreen.tsx:101-102`). |
| Rejection → corrective work → linked reinspection | ABSENT | The reject branch flips `rejected:true` on items of the SAME inspection and marks it `decided` (`inspections.service.ts:110-111`). **No re-inspection row, no parent/child link field, no assignee, no due date exists anywhere.** The notification "N re-inspection task(s) created with due dates" (`:112`) has no backing record. Only a derived display boolean `reinspectionCreated` (`snapshot.service.ts:175-177`). |
| Closing inspection authority over completion | ABSENT | `complete()` writes `status:'done'` and creates the closing inspection **in the same transaction** (`activities.service.ts:205-216`); the inspection has no `activityId` back-reference; `decide()` never touches Activity; and because the closing inspection has **zero items it can only be approved, never rejected** (`inspections.service.ts:104-106`). Completion is unconditional; sign-off is advisory. |
| Submit/decide state machine | COMPLETE | P2-3 guards (resubmit, decide-before-submit, re-decide, empty checklist, fail-needs-photos) are enforced and pinned (`inspections.service.test.ts:30-94`). |
| Attribution | INCORRECT | `Inspection.by` is never populated by submit (seed-only); audit actor is `user.role` — a role string, not an identity. |

### Activities, gates, audit, events, offline

| Concept | Verdict | Evidence |
|---|---|---|
| Readiness derived from canonical facts | PARTIAL/INCORRECT | Only the Decision gate is derived (`transitions.ts:11-14`). `gateInspection`/`gateTeam` are stored flags settable by PMC PATCH (`contracts.ts:477-479`) with **zero linkage** to inspection facts; `gateMaterial` derives only downward (mismatch → `fail`, `daily-log.service.ts:33`). `start()` enforces the four-gate rule (`activities.service.ts:170-172`); `complete()` enforces nothing. There is no drawing readiness at all. |
| Append-only attributable audit | PARTIAL | Only `.create` call sites exist (append-only holds); but `actor` is a role string or display label — **no `actorId` column**; and members, companies, media, nodes, orgs and drawing-issue are entirely unaudited. No audit read API. |
| Idempotent offline replay | PARTIAL | No idempotency keys anywhere. Replay safety rides on ordered progress-committed flush + terminal-4xx drop + server state guards (pinned: `outbox.test.ts:283` — approve applied once). **`uploadMedia` is a non-idempotent create with real duplicate-row risk.** Ops that aren't queued (drawing ack, issue flows) just fail offline. |
| Role-targeted notifications derived from events | PARTIAL | Ad-hoc per-site strings; `Notification` has no target column; role targeting exists only on the push channel; the in-app feed is filtered on read by a text-prefix heuristic (`snapshot.service.ts:321-323`). |
| Server-side ActivitiesService tests | ABSENT | There is **no `activities.service.test.ts`** — start/complete guards, the closing-inspection creation and its atomicity are untested at the service level. |

**Drift notice vs. older chat/audit summaries:** the parked "audit plan PRs 2–6" predate Phase 0 remediation; their premises were revalidated rather than revived. Two cited problems no longer exist as described: latest-log lexical ordering (fixed; `logDate` ordering pinned) and inspection state-machine holes (P2-3 guards shipped and tested). The remainder are confirmed and absorbed into the tasks below.

---

## Global Constraints

- Read `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` first; it is the canonical product/architecture specification. This plan implements its **Phase 1** row only.
- Preserve and evolve the existing application; no rewrite, no microservices, no broad UI redesign.
- One fact, one owner: lifecycle facts (events, evidence, sign-offs, overrides) are recorded once in their owning module; readiness and Inbox items are **derived** and rebuildable, never stored as independently editable copies.
- Preserve human authority: the client approves/re-approves design choices; the architect/PMC issues drawings and performs technical sign-off; field evidence supports decisions but never auto-approves them; every override carries actor, reason, evidence and expiry.
- Additive migrations only; backfill and verify before enforcing constraints; never `prisma db push`. Every migration must be proven against a fresh database AND a representative upgraded copy carrying pre-Phase-1 rows (legacy `done` activities, zero-item closing inspections, write-only ChangeRequests, counter-only inspection items).
- Every new mutation records real actor identity (`actorId = user.sub` + display name + role) — role strings alone are no longer acceptable attribution.
- Tenant isolation for every new reference: service-level `resolveProjectRef`-style validation + composite `(projectId, ref)` FKs where the referenced model carries `projectId`.
- Offline behavior: queued ops replay in order under the pinned scope (Phase 0 contract); new replayable creates carry a client-generated idempotency key the server deduplicates on.
- **Out of scope (explicitly):** procurement, inventory/stock, vendor comparison; labour management; commercial control, billing, payment; supplier/contractor portals; RedBracket/accounting integrations; microservices; the Phase 2 module registry/outbox/projection framework; broad UI redesign; unrelated cleanup.
- Do not merge a task until its focused tests, `pnpm check`, the PostgreSQL integration suite and (where the task says so) the API-backed acceptance suite pass.

## Product Intent Claude Must Preserve

Before each PR, include a five-line vision-alignment statement with concrete values:

```text
User decision improved: <role> can <decision> because <fact chain>.
Canonical fact owner: <module/record>.
Information flow: <source> -> <consumers>.
Human work removed: <copying/checking eliminated>.
Trust invariant: <what can no longer silently happen>.
```

Reject a design in self-review when it: stores a second editable copy of a lifecycle fact; lets a status flag assert what an evidence record must prove; replaces an attributable human approval with an automatic transition; adds a screen without a canonical record; or makes the field workflow slower without product approval.

## Required Execution Order and Review Stops

Tasks 1–7 in order; each task is one PR unless noted. **Review stops (wait for independent review before continuing): after Task 1, Task 3, Task 5 and Task 7.** Dependencies:

```text
Task 1 (characterization baseline)
  -> Task 2 (decision change-control)        [depends on 1]
  -> Task 3 (controlled drawing lifecycle)   [depends on 1; independent of 2]
  -> Task 4 (inspection evidence + reinspection) [depends on 1]
  -> Task 5 (closing sign-off / completion)  [depends on 4]
  -> Task 6 (derived readiness + projections)[depends on 2, 3, 4, 5]
  -> Task 7 (acceptance suite + review packet) [depends on all]
```

## File Structure (primary touch points)

| File | Responsibility |
|---|---|
| `apps/api/src/activities/activities.service.test.ts` | NEW — server-side characterization of start/complete (currently untested). |
| `apps/api/src/decisions/decisions.service.ts` + `.test.ts` | Change-control state machine, real attribution, event emission. |
| `apps/api/src/common/actor.ts` | NEW — one helper resolving `{ actorId, actorName, actorRole }` from `AuthUser` (+ optional on-behalf-of). |
| `apps/api/src/drawings/drawings.service.ts` + `.test.ts` | Governing-revision semantics, transmittals, issue audit, rev uniqueness. |
| `apps/api/src/inspections/inspections.service.ts` + `.test.ts` | Evidence validation, reinspection creation, attribution, closing-inspection decide. |
| `apps/api/src/media/media.service.ts` | Inspection-item evidence linkage + idempotent upload (`clientKey`). |
| `apps/api/src/domain/transitions.ts` + `.test.ts` | Derived inspection/drawing readiness; override resolution; completion states. |
| `apps/api/src/snapshot/snapshot.service.ts` | Serialize derived readiness, change-request state, evidence URLs, sign-off state. |
| `apps/api/prisma/migrations/2026091*` | One additive migration per task that changes schema (named per task below). |
| `apps/api/test/integration/*.test.ts` | New suites per task: change-control, transmittal/ack, evidence/reinspection, sign-off, readiness, idempotency — all against live PostgreSQL. |
| `packages/shared/src/domain/{types,policy}.ts` | Status unions, new capabilities (`decision.reapprove`, `activity.signoff`, `activity.override`), role matrix. |
| `apps/web/src/store/store.ts` + `apps/web/src/data/apiGateway.ts` | New commands, outbox ops (+ `opKey`), evidence upload, sign-off flows. |
| `apps/web/src/screens/{InspectionReview,EngineerChecklist,SiteSchedule,DecisionLog,ClientDecisions,Drawings}Screen.tsx` | UI workflows per task. |
| `apps/web/tests/e2e-api/pillar-chain.spec.ts` | NEW — the Phase 1 end-to-end acceptance chain. |
| `docs/reviews/phase-1-review-packet.md` | The independent review packet (Task 7). |

---

## Task 1: Baseline and Characterization Tests

**Business outcome:** Every behavior Phase 1 will change is pinned as it exists today, so each later task proves an intentional change rather than an accidental one, and the plan's revalidation table above stays true in CI.

**Canonical fact owner:** none (test-only task — no schema, no runtime change).

**Commands/events:** none added. Characterizes: `POST /decisions/:id/approve|change`, `POST /inspections/:id/submit|decide`, `POST /activities/:id/start|complete`, drawing issue/ack.

**Schema and migration:** none.

**Permissions:** none changed; the existing `EXPECTED_ROLES` drift table is extended with comments marking rows Phase 1 will touch.

**UI workflow:** none.

- [ ] **Step 1: Record the baseline.** `git fetch origin && git rev-parse origin/main`, clean tree, `pnpm check` green, integration suite green, acceptance suite green. Record SHAs in the PR.
- [ ] **Step 2: Create `apps/api/src/activities/activities.service.test.ts`** pinning today's server truth: start refuses non-`not_started` (409) and unready gates (409); start derives the decision gate live; **complete writes `done` + closing inspection in one transaction with zero items and no activity back-reference**; complete performs no readiness or inspection check.
- [ ] **Step 3: Extend `decisions.service.test.ts`** to pin: approve → 409 when already approved; approve stamps the hardcoded `'Mr. Shah'|'PMC'` approver (characterized as CURRENT behavior, replaced in Task 2); change → 409 unless approved; change flips status to `change` and status-`change` decisions are re-approvable; ChangeRequest row is written with status `pending` and never read.
- [ ] **Step 4: Extend `inspections.service.test.ts`** to pin: reject flips `rejected` flags and decides the SAME row, creating no new inspection; a zero-item inspection cannot be rejected (400); `by` is not populated on submit.
- [ ] **Step 5: Extend `drawings.service.test.ts`** to pin: a `for_review` issue supersedes a `for_construction` rev and becomes `current` (characterized as CURRENT behavior, changed in Task 3).
- [ ] **Step 6: Integration characterization** (`test/integration/phase1-baseline.test.ts`): against live PostgreSQL, one flow per pillar exactly as it behaves today (approve→lock 409; reject→no new row; complete→done immediately).
- [ ] **Step 7: Verify and commit.** All suites green. Done criteria: every behavior named in the revalidation table that a later task changes has a test that will FAIL when that task lands (forcing an explicit update in the same PR that changes it).

**Tests:** as above (unit + integration). **Rollback:** revert the PR (test-only). **Risks:** none beyond CI time.

**Done criteria:** `pnpm check` + integration green; new `activities.service.test.ts` exists; each characterized behavior maps 1:1 to a row in the revalidation table.

## Task 2: Decision Change-Control and Mandatory Re-approval

**Business outcome:** A client's approval is locked, attributable and re-obtained through a formal change loop: a change request reopens the specification, downstream readiness reverts immediately, and only the client's (or PMC-on-behalf, recorded as such) re-approval closes it. Procurement (Phase 3) will consume `approved specification`, so "approved" must be unambiguous.

**Canonical fact owner:** `Decision` owns the specification + status machine; `ChangeRequest` owns one reopening (reason, impacts, resolution); `DecisionEvent` owns the append-only lifecycle history.

**Commands/events:**

```text
POST /projects/:id/decisions/:decisionId/approve        (existing — now also RESOLVES the open ChangeRequest when status='change')
POST /projects/:id/decisions/:decisionId/change          (existing — now refuses when a ChangeRequest is already open)
POST /projects/:id/decisions/:decisionId/change/withdraw (NEW — the requester or PMC withdraws; decision returns to approved/locked)
DecisionEvent types emitted: drafted | issued | approved | change_requested | change_withdrawn | reapproved
AuditLog actions: decision.approve | decision.change | decision.change_withdraw (all with actorId)
```

**Schema and migration** (`20260910000000_phase1_change_control`, additive):

```prisma
ChangeRequest.status        // 'open' | 'resolved' | 'withdrawn' — enforced in service
ChangeRequest.requestedById String?
ChangeRequest.resolvedById  String?
ChangeRequest.resolvedAt    DateTime?
ChangeRequest.resolution    String?   // 'reapproved' | 'withdrawn'
DecisionEvent.actorId       String?
DecisionEvent.actorName     String?
AuditLog.actorId            String?
Decision.approvedById       String?   // the real identity behind `approver`
Decision.onBehalfOf         String?   // 'client' when a PMC approves for the client
```

Backfill: existing `ChangeRequest.status='pending'` rows → `'open'` **only when their decision status is still `change`**, else `'resolved'` with `resolvedAt = decision.date` best-effort null; legacy events/audit keep null actorId (documented). Diagnostics first; abort on ambiguity.

**State machine (service-enforced):** `pending → approved(locked)`; `approved → change` only via `requestChange` (opens ONE ChangeRequest; a second concurrent request → 409); `change → approved` only via `approve` (records `reapproved` event, resolves the ChangeRequest with resolver identity) or `change/withdraw` (restores `approved`, resolution `withdrawn`). Approve of a `pending` decision emits `approved`; of a `change` decision emits `reapproved`. **Attribution:** replace the `'Mr. Shah'|'PMC'` hardcode with the caller's real name (DB lookup, fallback role label) + `approvedById = user.sub`; when a PMC approves on behalf of the client, record `onBehalfOf='client'` — display keeps the human-readable approver line.

**Permissions:** approve/reapprove: `client, pmc` (unchanged); change: unchanged five roles; withdraw: `pmc` + the requesting role. New capability rows in `ROLE_POLICY` + `EXPECTED_ROLES` in the same PR.

**UI workflow:** Decision Log/Client Decisions show `change` decisions as "Change requested — awaiting client re-approval" with the request's reason/cost/time; the client's Decisions Waiting includes them with a Re-approve CTA (existing approve modal, relabelled); PMC sees open change requests in the Inbox (exists) and can withdraw. Offline: `approve` and `change` ops already queue; add `changeWithdraw` op (guarded server-side → replay-safe).

**Tests:** unit (state machine incl. double-open 409, withdraw restore, attribution written); integration (live PG: full open→reapprove and open→withdraw loops; upgraded-DB fixture with a legacy `pending` ChangeRequest backfilled correctly); permission matrix rows; cross-project probe (change request against another project's decision → 403/404); web store + outbox replay (reapprove idempotent via 409-drop); update Task-1 characterization tests to the NEW contract in this PR.

**Rollback:** revert API + web; additive columns stay (null-tolerated). **Risks:** approver display strings change for future approvals (historic rows untouched); double-approve races resolved by the existing 409; seed strings updated to keep demo parity.

**Done criteria:** a decision cannot be in `change` without exactly one open ChangeRequest; re-approval resolves it with real identity; every transition has a DecisionEvent with actorId; snapshot exposes the open request; all gates green.

## Task 3: Controlled Drawing Lifecycle

**Business outcome:** The field always knows the governing construction revision: a review copy can never silently displace the construction set, issues are distributed to named roles with a persisted record, acknowledgements work offline, and every issue is audited.

**Canonical fact owner:** `Drawing`/`DrawingRevision` own the issued intent; `DrawingTransmittal` owns who a revision was issued to; `DrawingAck` owns who confirmed building to it.

**Commands/events:**

```text
POST /projects/:id/drawings                    (existing issue — now audited, transmittals recorded, supersede scoped)
POST /projects/:id/drawings/rev/:revId/ack     (existing — now offline-queueable)
AuditLog: drawing.issue | drawing.revise | drawing.publish | drawing.ack | drawing.remove | drawing.refile (all actions normalized, actorId)
```

**Schema and migration** (`20260915000000_phase1_drawing_control`, additive):

```prisma
DrawingRevision  @@unique([drawingId, rev])          // after a duplicate-label diagnostic
DrawingTransmittal id, projectId, revisionId (FK cascade), role, createdAt
                 @@unique([revisionId, role])
```

**Semantics changes:** (a) issuing a `for_construction` revision supersedes prior non-superseded revisions (unchanged); issuing a `for_review` revision **does not supersede anything** — it coexists as a review copy; (b) `governing` (serialized to the snapshot as `current`) = latest non-superseded **`for_construction`** revision; a drawing with only `for_review` revisions has `current: null` and the register labels it "In review — not for construction"; (c) transmittals default to `['engineer','contractor']` at issue (matching today's push audience) and are persisted, so "who was this issued to" is a fact; (d) the unacked-Inbox nudge derives from transmittals for the viewer's role.

**Permissions:** unchanged (issue/publish PMC; ack pmc/engineer/contractor). **Offline:** add `ackDrawing` outbox op — server ack is already an idempotent upsert on `(revisionId, userId)`, making it the model replayable op.

**UI workflow:** register shows governing vs review revisions distinctly; viewer's ack block unchanged; issue modal gains a For-review checkbox (UI currently hardcodes `for_construction`).

**Tests:** unit (supersede scoping, governing selection with for_review present, transmittal rows, duplicate-rev 409, audit rows for issue/revise); integration (live PG: transmittal cross-project isolation via composite/project checks; upgraded-DB: existing drawings keep their current rev; a legacy drawing whose only rev is `for_review` serializes `current:null` — characterized change from Task 1); permission rows; web outbox test (offline ack queues, replays once, terminal-4xx drops); acceptance touchpoint deferred to Task 7.

**Rollback:** revert services; transmittal table stays (unread). The `@@unique([drawingId,rev])` constraint is not auto-reverted — operator-reviewed forward fix if duplicate labels must be re-permitted.

**Risks:** the governing-selection change alters `current` for drawings whose latest rev is `for_review` (upgraded-DB test proves the blast radius; snapshot consumers null-guard `current` already); duplicate-rev diagnostic may block the migration on dirty data — deliberate.

**Done criteria:** a `for_review` issue can never displace the construction set; `current` is always `for_construction` or null; transmittals persisted and serialized; acks replay offline idempotently; drawing issue is audited; all gates green.

## Task 4: Inspection Evidence, Correction and Reinspection

**Business outcome:** "Inspected" means evidence exists: a failed checklist item carries real photos, rejection creates an assignable, dated, linked reinspection, and the correction loop is a chain of records — not a counter, a flag and a misleading toast.

**Canonical fact owner:** `Media` owns evidence bytes/metadata (one row per photo, linked to its inspection item); `Inspection` owns the checklist/review lifecycle; a reinspection is a new `Inspection` whose `reinspectionOfId` names its predecessor.

**Commands/events:**

```text
POST /projects/:id/media                        (existing — now accepts inspectionId + inspectionItemId, idempotent via clientKey)
POST /projects/:id/inspections/:id/submit       (existing — fail items now require LINKED Media evidence, not a counter)
POST /projects/:id/inspections/:id/decide       (existing — reject now CREATES the linked reinspection with assignee + due date)
AuditLog: inspection.create | inspection.submit | inspection.approve | inspection.reject (renamed from reinspect) — all with actorId
```

**Schema and migration** (`20260920000000_phase1_inspection_evidence`, additive):

```prisma
Media.inspectionId       String?   // composite (projectId, inspectionId) FK
Media.inspectionItemId   String?   // FK to InspectionItem; service validates item ∈ inspection
Media.clientKey          String?  @unique   // client-generated idempotency key for replayable uploads
Inspection.reinspectionOfId String? // composite (projectId, reinspectionOfId) self-FK
Inspection.assigneeId    String?
Inspection.dueDate       DateTime? @db.Date
Inspection.submittedById String?
Inspection.submittedByName String?
Inspection.decidedById   String?
Inspection.decidedByName String?
```

Backfill: none required (legacy items keep their counters as display-only; legacy inspections keep null links). `InspectionItem.photos` becomes a **derived count** of linked media for new submissions; the column is retained as a deprecated derivative (Data-model conventions section updated).

**Behavior:** submit validates each `fail` item has ≥1 linked Media row (replacing the `photos>0` counter check in `checklistSubmitError`) and stamps `submittedById/Name`; decide(reject) creates — in one transaction — a new `Inspection` (`kind:'checklist'`, items = the rejected items with fresh IDs, `reinspectionOfId` = original, `assigneeId` = the original submitter by default, `dueDate` = decide-day + N civil days via the injected Clock, PMC-overridable in the request) plus truthful notifications; decide stamps `decidedById/Name`. The engineer's "Add photo" becomes a real capture: camera/file input → `uploadMedia` with `inspectionItemId` + `clientKey` (offline-queued; server dedupes on `clientKey`, closing the known duplicate-upload risk). The PMC review screen renders the actual evidence photos (signed URLs) instead of the gradient-with-"PHOTO"-badge.

**Permissions:** unchanged role sets; media upload with inspection linkage: engineer/pmc. **Tenant isolation:** composite FKs + `resolveProjectRef` for `inspectionId`; item↔inspection containment validated in service (item table has no projectId — documented transitive guarantee).

**UI workflow:** engineer checklist gets per-item photo capture with thumbnails + queued-upload badges; review screen shows evidence grid per item, reject flow gains assignee/due-date fields (defaulted); Inbox shows "Reinspection due <date>" for the assignee.

**Tests:** unit (submit evidence rule; reject creates linked row with items/assignee/due date; zero-rejected reject still 400 for ordinary inspections; attribution stamped); integration (live PG: full reject→reinspection chain; media clientKey dedupe — same key twice → one row; cross-project media↔inspection forgery → 400 + P2003; upgraded-DB: legacy counter-based inspections still render and can be decided); permission rows; web (photo capture queues `uploadMedia` with stable `clientKey`; replay after simulated double-flush yields one row via API test); notifications text truthful.

**Rollback:** revert API/web; additive columns/null links stay; evidence rows persist harmlessly. **Risks:** submit is stricter (fail without real photo → 400) — field workflow gains a capture step (mobile-first UI must keep it one tap; explicit product constraint); media payload sizes on site connections (existing 12 MB limit + offline queue mitigate).

**Done criteria:** a failed item without linked evidence cannot be submitted; a rejection always yields a linked, assigned, dated reinspection row; uploads are idempotent by key; attribution is real identity; all gates green.

## Task 5: Closing Sign-off Controls Activity Completion

**Business outcome:** "Done" means accepted: an engineer's completion claim parks the activity in `awaiting_signoff`; only the PMC's approval of the linked closing inspection makes it `done`; rejection sends it back to execution with the Task 4 correction chain. Payment certification (Phase 5) will trust `done`.

**Canonical fact owner:** `Activity.status` owns the work state; the linked closing `Inspection` owns the sign-off record; the transition `awaiting_signoff → done` is owned by the inspection decide command (the PMC's attributable technical acceptance).

**Commands/events:**

```text
POST /projects/:id/activities/:id/complete      (existing — now transitions to awaiting_signoff, creates the LINKED closing inspection with a default sign-off item)
POST /projects/:id/inspections/:id/decide       (existing — approving a closing inspection sets its activity done; rejecting returns it to in_progress + reinspection chain)
AuditLog: activity.complete_requested (renamed intent) | activity.signoff | activity.signoff_rejected — with actorId
```

**Schema and migration** (`20260925000000_phase1_closing_signoff`, additive):

```prisma
Inspection.activityId  String?   // composite (projectId, activityId) FK — the closing link
Activity.status        // union gains 'awaiting_signoff' (string column; shared types + contracts updated)
Activity.doneAt        DateTime? @db.Date   // the sign-off civil day; actualEndDate remains the claimed work-end day
```

Backfill: `Inspection.activityId` derived from the deterministic legacy id pattern `INSP-<activityId>-close` where the activity exists (diagnostic-first); **legacy `done` activities stay `done`** — no retroactive reopening (upgraded-DB test pins this).

**Behavior:** `complete()` → `status:'awaiting_signoff'`, keeps writing `actualEndDate` (the claim), creates the closing inspection WITH one default item ("Work complete and acceptable") and `activityId` set, so it can genuinely fail; `decide(approve)` on a closing inspection → activity `done` + `doneAt` (transactional); `decide(reject)` → activity `in_progress`, item flags + the Task 4 reinspection chain (assignee = activity's engineer/original completer), truthful notification; ordinary (non-closing) inspections behave as in Task 4. The zero-item reject trap disappears for new closings; legacy zero-item closings may be rejected when `activityId` is present (special-cased) or approved as before.

**Permissions:** `activity.complete` stays engineer/pmc (it now means "request sign-off"); the sign-off itself is `inspection.decide` = pmc only (technical acceptance stays the architect's). New `awaiting_signoff` surfaces in policy/`EXPECTED_ROLES` untouched (no new route).

**UI workflow:** schedule/activity chip shows "Awaiting sign-off" (distinct color); PMC review queue labels closing inspections with their activity; approving shows "Signed off — activity complete"; rejecting returns the activity to running with the block reason. Offline: `completeActivity` op unchanged (guarded); decide already queueable.

**Tests:** unit (complete → awaiting_signoff + linked item-bearing inspection; approve → done + doneAt; reject → in_progress + chain; legacy zero-item closing paths); integration (live PG: full complete→approve and complete→reject loops; upgraded-DB: legacy done stays done, backfilled activityId correct, orphan `INSP-*-close` without a matching activity left null by the diagnostic); characterization updates from Task 1 in this PR; web store/status-union updates + selectors (`phaseRollup`, action items) counting `awaiting_signoff`.

**Rollback:** revert API/web; the new status value only exists on rows written by the new code — a rollback leaves them stranded in `awaiting_signoff`, so the rollback procedure includes one operator-reviewed forward migration mapping `awaiting_signoff → in_progress` (documented in DEPLOY notes for this task).

**Risks:** the biggest behavior change of the phase — completion is no longer instant `done` (product-visible; the acceptance suite and seed/demo flows updated in the same PR); portfolio/phase rollups must not count `awaiting_signoff` as done (pinned).

**Done criteria:** no path writes `done` except closing-inspection approval; rejection restores execution with a linked correction chain; legacy data proven stable on an upgraded copy; all gates green.

## Task 6: Readiness Derived from Canonical Facts + Projections

**Business outcome:** A gate dot is a conclusion, not an assertion: Decision readiness from the locked/re-approved decision, Inspection readiness from actual inspection outcomes, Drawing readiness from the governing revision + acknowledgements — and any manual override is an attributable, expiring, evidenced record. The Inbox and schedule read the same derived truth.

**Canonical fact owner:** readiness is a **derivation** owned by `domain/transitions.ts` (serialized in the snapshot); `GateOverride` owns each manual exception.

**Commands/events:**

```text
POST /projects/:id/activities/:id/override      (NEW — { gate, state, reason, evidenceMediaId?, expiresAt } ; pmc only)
DELETE /projects/:id/activities/:id/override/:overrideId (NEW — pmc; revoke early)
AuditLog: activity.override | activity.override_revoke — with actorId
```

**Schema and migration** (`20260930000000_phase1_derived_readiness`, additive):

```prisma
GateOverride  id, projectId, activityId (composite FK), gate ('decision'|'material'|'team'|'inspection'|'drawing'),
              state GateState, reason String, actorId String, actorName String,
              evidenceMediaId String?, expiresAt DateTime, createdAt
```

**Derivations (replacing stored flags at read/guard time):**

- **Decision** — unchanged (derived; `change` status ⇒ `wait`, so Task 2's reopening reverts readiness automatically).
- **Inspection** — derived: `ok` when every non-closing inspection linked to the activity's node/scope required by the checklist chain has no undecided or failed-without-passed-reinspection outcome; `fail` while a rejection's reinspection chain (Task 4) is open; `na` when no inspection touches it. `gateInspection` becomes a deprecated stored column: removed from `updateActivitySchema` (breaking contract change — characterized in Task 1), retained for legacy display parity during the phase.
- **Drawing** — NEW derivation: `ok` when the activity has no linked drawing, or its governing `for_construction` revision exists and is acknowledged per its transmittals; `wait` when unacknowledged; `fail` when the drawing has no governing revision (review-only or superseded-out).
- **Material** — unchanged this phase (mismatch ⇒ `fail` stays; full derivation is Phase 3). **Team** — unchanged stored flag (Phase 4). Both documented as such in the serialized readiness payload.
- **Overrides** — an unexpired `GateOverride` supersedes the derivation for its gate; expiry restores the derived value silently; every override is audited and surfaced ("overridden by <name> until <date>: <reason>").
- `start()` requires all five readiness values (`ok|na`), overrides considered; `complete()` (now sign-off request) requires the inspection chain to be closable.

**Snapshot/projection:** activity DTO gains a `readiness` object (five gates: value + source `derived|stored|override` + reason); the web's `gatesFor`/`activityReady`/action-items consume it instead of re-deriving locally (demo mode keeps local derivation parity via shared logic). Inbox items: "Blocked: drawing unacknowledged", "Override expiring <date>".

**Permissions:** override = pmc only; new `ROLE_POLICY`/`EXPECTED_ROLES` rows.

**Tests:** unit (each derivation truth-table incl. override precedence + expiry; start guard on drawing readiness); integration (live PG: approve→gate flips; reject→inspection gate fails until reinspection passes; unacked governing rev blocks start; override with expiry admits start then lapses); permission matrix; cross-project probes for `GateOverride` composite FK; upgraded-DB (legacy stored `gateInspection:'ok'` rows: derivation takes over — the migration diagnostic REPORTS activities whose stored flag disagrees with the derivation so the operator sees the delta, and the serialized `source` field keeps the discrepancy visible rather than silently rewriting history); web selector/action-item tests; acceptance in Task 7.

**Rollback:** revert API/web (derivations are read-time; stored columns still hold legacy values); override table stays. **Risks:** activities that were start-able under manual flags may become blocked (drawing/inspection truth) — this is the point; the operator delta report + override mechanism give a controlled path. Perf: derivations join inspections/acks per snapshot — bounded per project; measured in the task.

**Done criteria:** no route can set `gateInspection`; readiness in the snapshot names its source; overrides expire; start/sign-off guards consume derived truth; all gates green.

## Task 7: End-to-End Acceptance Suite and Review Packet

**Business outcome:** One repeatable browser-level proof that the full pillar chain works on the real stack, and one honest evidence packet for the independent gate.

**Canonical fact owner:** none (test + docs).

- [ ] **Step 1: `apps/web/tests/e2e-api/pillar-chain.spec.ts`** — the complete chain against compiled API + seeded PostgreSQL: PMC issues a decision → client approves (attributed) → PMC issues a `for_construction` drawing (transmitted) → engineer acknowledges → activity becomes ready and starts → engineer fails a checklist item WITH a real photo → PMC rejects → linked reinspection with assignee/due date appears in the engineer's Inbox → engineer passes it with evidence → activity complete → `awaiting_signoff` → PMC approves the closing inspection → `done`. Then the change loop: PMC requests a change on the approved decision → activity readiness reverts to blocked → client re-approves → ready again. Negative scenarios: `for_review` issue does not displace the governing set; a non-PMC cannot override; a second project sees none of it (isolation re-proof on the new tables); an offline-queued evidence upload replays exactly once.
- [ ] **Step 2: representative upgraded-database CI evidence** — a scripted legacy fixture (pre-Phase-1 shapes: done activities, zero-item closings, pending ChangeRequests, counter-only items) migrated through all Phase 1 migrations with the diagnostic outputs attached; assertions that legacy meaning is preserved.
- [ ] **Step 3: `docs/reviews/phase-1-review-packet.md`** — same discipline as Phase 0 (learned the hard way): base + reviewed head AND merge SHAs in separate columns per PR, migration checksums, command outputs with totals, direct green CI URLs for heads AND merges, acceptance-criteria checklist mapped to spec §25 rows this phase covers, residual risks. Written AFTER the merges it cites; refreshed docs-only if the gate finds drift.
- [ ] **Step 4: durable docs** — ARCHITECTURE/DATA_MODEL invariants updated to implemented-behavior statements (locked decisions + change loop, governing revision, evidence chain, sign-off authority, derived readiness + overrides); ROADMAP Phase 1 rows checked with PR links.

**Done criteria:** acceptance suite green in CI (`api-e2e`), upgraded-DB job green, packet complete, docs true. Phase 1 is complete only when the independent review clears.

---

## Human Authority (phase-wide invariants)

- The **client** approves and re-approves design choices (Task 2); a PMC acting on behalf is recorded as `onBehalfOf`, never disguised.
- The **architect/PMC** issues drawings (Task 3) and performs technical sign-off (Task 5); both are attributable commands, never automatic.
- **Field evidence** (photos, submissions) supports decisions but cannot approve anything by itself — no evidence upload transitions any approval state (Tasks 4–6).
- **Overrides** require actor, reason, evidence and expiry (`GateOverride`, Task 6) — no silent flag-flips remain.

## Rollout and Rollback Rules

1. Deploy each task's migration before its API build; every migration is diagnostic-first and aborts on ambiguous legacy data rather than guessing.
2. Take a verified backup before Tasks 3, 5 and 6 reach production (constraint + semantics changes).
3. Additive columns/tables are never auto-reverted; application rollback = prior build + kept schema. Task 5 documents the one forward-mapping migration required if rolled back after `awaiting_signoff` rows exist.
4. After each deploy, smoke-test: approve→lock, change→re-approve, issue→ack, fail-with-photo→reject→reinspection, complete→sign-off, one override, and one cross-project 403.

## Claude Code Handoff Prompt

```text
Work in JagPat/PMCvitan from the latest origin/main. Read CLAUDE.md, the canonical spec, and docs/superpowers/plans/2026-07-13-phase-1-existing-pillars.md. Revalidate the plan's current-state table against main and report drift before editing.

Execute Phase 1 only, Tasks 1-7 in order, one PR per task. TDD with characterization-first; additive diagnostic-first migrations; real actor identity on every new mutation; tenant isolation proven against PostgreSQL for every new reference; offline replay idempotent by key where a replay can create rows. Preserve client approval, PMC technical sign-off and evidenced overrides as attributable human actions.

Do not add procurement, inventory, labour, billing, portals, RedBracket, microservices or unrelated cleanup. Stop for independent review after Tasks 1, 3, 5 and 7. Completion evidence is PostgreSQL integration + permission-matrix + isolation + idempotency + API-backed browser tests, and the Phase 1 review packet.
```

## Independent Codex Review Gate

Provide the PR URL, base/head/merge SHAs and `docs/reviews/phase-1-review-packet.md`. Codex verifies at minimum: the change loop cannot be bypassed (no path re-approves without resolving the open request); no review copy governs construction; failed items carry linked evidence; rejection always yields a linked assigned reinspection; nothing but closing-inspection approval writes `done`; readiness sources are named and overrides expire; new references are isolation-proven; replayable creates are deduplicated; legacy data survives the upgrade with meaning intact. Any failed item reopens its originating task.
