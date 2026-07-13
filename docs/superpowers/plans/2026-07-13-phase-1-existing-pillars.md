# Phase 1 — Complete the Existing Product Pillars

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not begin Task 1 until the independent Codex review of THIS PLAN clears.**

**Goal:** Make design intent, client consent, controlled drawings, field inspection, rejection, corrective work, reinspection and final sign-off one attributable information chain — so that procurement and payment (Phases 3/5) can later consume approved specification and accepted work, never editable flags.

**Architecture:** Preserve the existing React/Zustand + NestJS/Prisma/PostgreSQL modular monolith. Phase 1 completes the DOMAIN of the four existing pillars (decisions, drawings, inspections, activities) — it does not introduce the Phase 2 module registry, transactional outbox or projection framework. Lifecycle facts are recorded once in their owning module with real actor identity and **explicit requirement/recipient relationships**; readiness is derived from those linked facts at serialize time — never inferred from co-location; every state machine is **concurrency-safe at the database level**, not just service-guarded.

**Tech Stack:** pnpm workspace, React 19, Zustand 5, Vitest 4, Playwright 1.61, NestJS 11, Prisma 6, PostgreSQL 16, TypeScript.

**Planning baseline:** `main` at `5d6f08b4c39737972b115dcfabf1bebbb25e0e10` (Phase 0 gate cleared — [final verdict](https://github.com/JagPat/PMCvitan/pull/96#issuecomment-4954752823)). **Plan corrected** per the [independent Phase 1 plan review](https://github.com/JagPat/PMCvitan/pull/97#issuecomment-4955048088) (5 findings: explicit requirement/recipient edges; database-level transition concurrency; offline evidence durability; complete same-project/containment constraints; modeled completion attribution) and the [narrow correction review](https://github.com/JagPat/PMCvitan/pull/98#issuecomment-4955627010) (4 findings: deterministic multi-drawing truth tables with a recipient-snapshot discriminator; partial-reference containment CHECK; no evidence deletion without confirmed persistence; eligible-role corrective assignment).

---

## Phase Intent (restated per the canonical spec's Phase Intent Map)

Decisions, drawings, inspections and activities already exist, but their change, evidence and completion loops are incomplete. Phase 1 exists so that design intent, client consent, field execution, rejection, corrective work and final sign-off form one auditable loop on a real site. It consumes the Phase 0 facts — trustworthy project identity, live authorization, same-project references, real civil dates — and produces the facts Phase 2+ need: locked/re-approved specifications, governing drawing revisions with acknowledged recipients, evidence-backed inspection outcomes linked to the work they accept, and completion that means "accepted", not "claimed".

## Current-State Revalidation (against `main` @ `5d6f08b`)

Every Phase 1 concept was revalidated against current code and tests before this plan was written. Verdicts: **COMPLETE** (works and is pinned by tests), **PARTIAL** (exists with material gaps), **INCORRECT** (exists but violates the invariant), **ABSENT** (does not exist).

### Decisions

| Concept | Verdict | Evidence |
|---|---|---|
| Lock after approval | PARTIAL | Re-approve of an `approved` decision → 409 (`decisions.service.ts:105`); no edit/delete route exists at all (`decisions.controller.ts` has only create/publish/approve/change). BUT the server-side lock has **zero test coverage** — no API test hits the 409 — and the pre-read status guard is **not concurrency-safe** (two simultaneous requests can both pass it). |
| Change control with mandatory re-approval | ABSENT (as an invariant) | `requestChange` creates a `ChangeRequest` row and flips status to `change` (`decisions.service.ts:128-142`) — but `ChangeRequest` is a **write-only table**: its `status` is never read or transitioned anywhere in the repo, nothing requires or tracks client re-approval, and "for client re-approval" is a UI flash string (`store.ts:718`), not a rule. No test anywhere touches the ChangeRequest row. |
| Immutable lifecycle events | PARTIAL | `DecisionEvent` rows are appended at all four transitions (`decisions.service.ts:65,87,117,136`) and no update/delete path exists — but the table is **never read or surfaced**, the schema-declared `locked` type is never emitted, the emitted `drafted` type is undocumented, and only `drafted` has a test (`decisions.service.test.ts:61`). |
| Attribution of approvals | INCORRECT | The approver is a hardcoded demo string — `user.role === 'client' ? 'Mr. Shah' : 'PMC'` (`decisions.service.ts:109`) — written to `Decision.approver`, `DecisionEvent.actor` and `AuditLog.actor`. The real user identity (`user.sub`) is captured only as `authorId` at create. `store.test.ts:37` pins the fake string. |

### Drawings

| Concept | Verdict | Evidence |
|---|---|---|
| Controlled issue (PMC-only, immutable revisions) | COMPLETE | Issue/publish/presign/setNode/delete are `@Roles('pmc')`, drift-guarded (`route-policy.test.ts:179-184`); no revision edit/delete path exists; supersede is transactional and tested (`drawings.service.test.ts:141-151`). Caveats: immutability is emergent (no guard), and no `@@unique([drawingId, rev])` prevents duplicate rev labels. |
| Governing-revision selection | PARTIAL | `current` = latest non-superseded rev (`snapshot.service.ts:217`) **regardless of status** — issuing a `for_review` rev supersedes a `for_construction` rev and becomes governing. The "field only builds from for_construction" invariant (schema comment, docs, register subtitle) is not enforced. |
| Distribution | ABSENT | No recipient/transmittal concept exists; only a transient hardcoded push audience `['engineer','contractor']` on issue (`drawings.service.ts:142`). `DrawingRevision` carries no `projectId`, so no composite tenant constraint can reference it today. |
| Acknowledgement tracking | COMPLETE | Per-revision `DrawingAck` (`@@unique([revisionId,userId])`), idempotent upsert, client/worker refused, audited, surfaced (`acks[]`, `ackedByMe`), fresh round on supersession — well tested. Gap: acks are **online-only** (not in the outbox; failure just flashes, `store.ts:948`). |
| Stale-revision protection | ABSENT | Nothing prevents starting/completing work governed by a superseded, unacknowledged or `for_review` drawing; there is no drawing gate (`transitions.ts:21`); the unacked-inbox nudge is advisory and ignores `for_review` currents (`selectors.ts:216`). |

### Inspections

| Concept | Verdict | Evidence |
|---|---|---|
| Real media evidence on items | ABSENT | `InspectionItem.photos` is an **integer counter** (`schema.prisma:555`); `swatch` is a CSS-gradient key; `Media` has **no** `inspectionId`/`inspectionItemId`; the engineer's "Add photo" is `it.photos += 1` (`store.ts:737`); the PMC review renders a gradient with a literal "PHOTO" badge (`InspectionReviewScreen.tsx:101-102`). |
| Rejection → corrective work → linked reinspection | ABSENT | The reject branch flips `rejected:true` on items of the SAME inspection and marks it `decided` (`inspections.service.ts:110-111`). **No re-inspection row, no parent/child link field, no assignee, no due date exists anywhere.** The notification "N re-inspection task(s) created with due dates" (`:112`) has no backing record. Only a derived display boolean `reinspectionCreated` (`snapshot.service.ts:175-177`). |
| Activity↔inspection requirement link | ABSENT | An inspection carries only an optional location `nodeId`; **nothing records which Activity an inspection is required for or accepts** — the only activity linkage anywhere is the string pattern `INSP-<activityId>-close`. |
| Closing inspection authority over completion | ABSENT | `complete()` writes `status:'done'` and creates the closing inspection **in the same transaction** (`activities.service.ts:205-216`); the inspection has no `activityId` back-reference; `decide()` never touches Activity; and because the closing inspection has **zero items it can only be approved, never rejected** (`inspections.service.ts:104-106`). Completion is unconditional; sign-off is advisory. |
| Submit/decide state machine | COMPLETE (single-request) | P2-3 guards (resubmit, decide-before-submit, re-decide, empty checklist, fail-needs-photos) are enforced and pinned (`inspections.service.test.ts:30-94`) — but they are pre-read service guards with **no database-level concurrency protection**. |
| Attribution | INCORRECT | `Inspection.by` is never populated by submit (seed-only); audit actor is `user.role` — a role string, not an identity. |

### Activities, gates, audit, events, offline

| Concept | Verdict | Evidence |
|---|---|---|
| Readiness derived from canonical facts | PARTIAL/INCORRECT | Only the Decision gate is derived (`transitions.ts:11-14`). `gateInspection`/`gateTeam` are stored flags settable by PMC PATCH (`contracts.ts:477-479`) with **zero linkage** to inspection facts; `gateMaterial` derives only downward (mismatch → `fail`, `daily-log.service.ts:33`). `start()` enforces the four-gate rule (`activities.service.ts:170-172`); `complete()` enforces nothing. There is no drawing readiness at all. |
| Completion attribution | ABSENT | Activity records no assigned engineer and no completion-request identity — `complete()` writes only dates/status; "who claimed this work finished" is not a fact anywhere. |
| Append-only attributable audit | PARTIAL | Only `.create` call sites exist (append-only holds); but `actor` is a role string or display label — **no `actorId` column**; and members, companies, media, nodes, orgs and drawing-issue are entirely unaudited. No audit read API. |
| Idempotent offline replay | PARTIAL | No idempotency keys anywhere. Replay safety rides on ordered progress-committed flush + terminal-4xx drop + server state guards (pinned: `outbox.test.ts:283` — approve applied once). **`uploadMedia` is a non-idempotent create with real duplicate-row risk.** Ops that aren't queued (drawing ack, issue flows) just fail offline. |
| Offline outbox durability | PARTIAL/INCORRECT for media | The queue is serialized whole to `localStorage`; **quota/storage errors are swallowed** (`store.ts:475-480`) and the UI still reports "Photo saved offline" (`store.ts:1503-1513`). A normal phone photo (base64, up to the 12 MB API limit) can exceed localStorage capacity, vanish on refresh, and still have been reported as saved. |
| Role-targeted notifications derived from events | PARTIAL | Ad-hoc per-site strings; `Notification` has no target column; role targeting exists only on the push channel; the in-app feed is filtered on read by a text-prefix heuristic (`snapshot.service.ts:321-323`). |
| Server-side ActivitiesService tests | ABSENT | There is **no `activities.service.test.ts`** — start/complete guards, the closing-inspection creation and its atomicity are untested at the service level. |

**Drift notice vs. older chat/audit summaries:** the parked "audit plan PRs 2–6" predate Phase 0 remediation; their premises were revalidated rather than revived. Two cited problems no longer exist as described: latest-log lexical ordering (fixed; `logDate` ordering pinned) and inspection state-machine holes (P2-3 guards shipped and tested). The remainder are confirmed and absorbed into the tasks below.

---

## Global Constraints

- Read `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` first; it is the canonical product/architecture specification. This plan implements its **Phase 1** row only.
- Preserve and evolve the existing application; no rewrite, no microservices, no broad UI redesign.
- One fact, one owner: lifecycle facts (events, evidence, sign-offs, overrides, requirement/recipient links) are recorded once in their owning module; readiness and Inbox items are **derived** from those explicit links — **never inferred from location co-residence or role guesswork** — and are rebuildable, never stored as independently editable copies.
- Preserve human authority: the client approves/re-approves design choices; the architect/PMC issues drawings and performs technical sign-off; field evidence supports decisions but never auto-approves them; every override carries actor, reason, evidence and expiry.
- **Concurrency:** every lifecycle transition (approve/change/withdraw, submit/decide, complete/sign-off) must be atomic under concurrent requests — an atomic compare-and-set (`updateMany` guarded on the expected prior state, count-checked) or row lock inside the transaction that also writes the events and children, plus database-enforced cardinality (partial unique indexes) for "exactly one open X" invariants. A pre-read service guard alone is NOT acceptable.
- Additive migrations only; **diagnostic-first** (abort on ambiguous legacy data — never guess); backfill and verify before enforcing constraints; never `prisma db push`. Every migration must be proven against a fresh database AND a representative upgraded copy carrying pre-Phase-1 rows (legacy `done` activities, zero-item closing inspections, write-only ChangeRequests, counter-only inspection items, revision rows without `projectId`).
- Every new mutation records real actor identity (`actorId = user.sub` + display name + role) — role strings alone are no longer acceptable attribution.
- **Tenant isolation and containment:** every new reference gets service-level validation AND a database constraint. Where the referenced model lacks the columns for a composite FK, this plan adds them (e.g. `DrawingRevision.projectId`). Containment inside a project (item ∈ inspection) is also database-enforced via composite keys — same-project service checks alone are insufficient against raw SQL.
- **Offline durability:** media bytes queued offline live in IndexedDB (capacity-tested), never in the JSON `localStorage` outbox; persistence success is part of the command result — the UI may claim "saved offline" only after a durable write confirms; idempotency keys are project-scoped.
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

Reject a design in self-review when it: stores a second editable copy of a lifecycle fact; lets a status flag assert what an evidence record must prove; **infers a requirement or recipient from location or role instead of an explicit recorded edge**; replaces an attributable human approval with an automatic transition; adds a screen without a canonical record; or makes the field workflow slower without product approval.

## Required Execution Order and Review Stops

Tasks 1–7 in order; each task is one PR unless noted. **Review stops (wait for independent review before continuing): after Task 1, Task 3, Task 5 and Task 7.** Dependencies:

```text
Task 1 (characterization baseline)
  -> Task 2 (decision change-control)        [depends on 1]
  -> Task 3 (controlled drawing lifecycle)   [depends on 1; independent of 2]
  -> Task 4 (inspection evidence + requirement link + reinspection) [depends on 1]
  -> Task 5 (closing sign-off / completion)  [depends on 4]
  -> Task 6 (derived readiness + projections)[depends on 2, 3, 4, 5]
  -> Task 7 (acceptance suite + review packet) [depends on all]
```

## File Structure (primary touch points)

| File | Responsibility |
|---|---|
| `apps/api/src/activities/activities.service.test.ts` | NEW — server-side characterization of start/complete (currently untested). |
| `apps/api/src/decisions/decisions.service.ts` + `.test.ts` | Change-control state machine (CAS transitions), real attribution, event emission. |
| `apps/api/src/common/actor.ts` | NEW — one helper resolving `{ actorId, actorName, actorRole }` from `AuthUser` (+ optional on-behalf-of). |
| `apps/api/src/drawings/drawings.service.ts` + `.test.ts` | Governing-revision semantics, frozen recipients, issue audit, rev uniqueness. |
| `apps/api/src/inspections/inspections.service.ts` + `.test.ts` | Evidence validation, activity requirement link, CAS decide, reinspection creation, attribution. |
| `apps/api/src/media/media.service.ts` | Inspection-item evidence linkage + project-scoped idempotent upload. |
| `apps/api/src/domain/transitions.ts` + `.test.ts` | Derived inspection/drawing readiness truth tables; override resolution; completion states. |
| `apps/api/src/snapshot/snapshot.service.ts` | Serialize derived readiness, change-request state, evidence URLs, sign-off state. |
| `apps/api/prisma/migrations/2026091*–2026093*` | One additive diagnostic-first migration per schema-changing task (named per task below). |
| `apps/api/test/integration/*.test.ts` | New suites per task: change-control (+concurrency probes), recipients/ack, evidence/containment/reinspection, sign-off, readiness, idempotency — all against live PostgreSQL. |
| `packages/shared/src/domain/{types,policy}.ts` | Status unions, new capabilities (`decision.reapprove`, `activity.signoff`, `activity.override`), role matrix. |
| `apps/web/src/data/evidenceStore.ts` | NEW — IndexedDB-backed durable store for offline media bytes (metadata stays in the JSON outbox). |
| `apps/web/src/store/store.ts` + `apps/web/src/data/apiGateway.ts` | New commands, outbox ops (+ project-scoped `clientKey`), evidence upload, sign-off flows. |
| `apps/web/src/screens/{InspectionReview,EngineerChecklist,SiteSchedule,DecisionLog,ClientDecisions,Drawings}Screen.tsx` | UI workflows per task. |
| `apps/web/tests/e2e-api/pillar-chain.spec.ts` | NEW — the Phase 1 end-to-end acceptance chain. |
| `docs/reviews/phase-1-review-packet.md` | The independent review packet (Task 7). |

---

## Task 1: Baseline and Characterization Tests

**Business outcome:** Every behavior Phase 1 will change is pinned as it exists today, so each later task proves an intentional change rather than an accidental one, and the plan's revalidation table above stays true in CI.

**Canonical fact owner:** none (test-only task — no schema, no runtime change).

**Commands/events:** none added. Characterizes: `POST /decisions/:id/approve|change`, `POST /inspections/:id/submit|decide`, `POST /activities/:id/start|complete`, drawing issue/ack.

**Schema and migration:** none. **Permissions:** none changed; the existing `EXPECTED_ROLES` drift table is extended with comments marking rows Phase 1 will touch. **UI workflow:** none.

- [ ] **Step 1: Record the baseline.** `git fetch origin && git rev-parse origin/main`, clean tree, `pnpm check` green, integration suite green, acceptance suite green. Record SHAs in the PR.
- [ ] **Step 2: Create `apps/api/src/activities/activities.service.test.ts`** pinning today's server truth: start refuses non-`not_started` (409) and unready gates (409); start derives the decision gate live; **complete writes `done` + closing inspection in one transaction with zero items and no activity back-reference**; complete performs no readiness or inspection check and records no completer identity.
- [ ] **Step 3: Extend `decisions.service.test.ts`** to pin: approve → 409 when already approved; approve stamps the hardcoded `'Mr. Shah'|'PMC'` approver (characterized as CURRENT behavior, replaced in Task 2); change → 409 unless approved; change flips status to `change` and status-`change` decisions are re-approvable; ChangeRequest row is written with status `pending` and never read.
- [ ] **Step 4: Extend `inspections.service.test.ts`** to pin: reject flips `rejected` flags and decides the SAME row, creating no new inspection; a zero-item inspection cannot be rejected (400); `by` is not populated on submit; no activity linkage exists beyond the closing-id string pattern.
- [ ] **Step 5: Extend `drawings.service.test.ts`** to pin: a `for_review` issue supersedes a `for_construction` rev and becomes `current` (characterized as CURRENT behavior, changed in Task 3); `DrawingRevision` rows carry no `projectId`.
- [ ] **Step 6: Integration characterization** (`test/integration/phase1-baseline.test.ts`): against live PostgreSQL, one flow per pillar exactly as it behaves today (approve→lock 409; reject→no new row; complete→done immediately), PLUS a **concurrency characterization**: two simultaneous `requestChange` calls against one approved decision — record today's actual outcome (expected: both succeed / duplicate rows; this pins the defect Task 2 closes).
- [ ] **Step 7: Verify and commit.**

Run: `pnpm check` · `DATABASE_URL=<test-db> JWT_SECRET=integration-test-secret pnpm --filter api exec vitest run --config vitest.integration.config.ts`

**Tests:** as above (unit + integration). **Rollback:** revert the PR (test-only). **Risks:** none beyond CI time.

**Done criteria:** `pnpm check` + integration green; new `activities.service.test.ts` exists; every behavior named in the revalidation table that a later task changes has a test that will FAIL when that task lands (forcing an explicit update in the same PR that changes it).

## Task 2: Decision Change-Control and Mandatory Re-approval

**Business outcome:** A client's approval is locked, attributable and re-obtained through a formal change loop: a change request reopens the specification, downstream readiness reverts immediately, and only the client's (or PMC-on-behalf, recorded as such) re-approval closes it — and the "exactly one open change request" rule holds under concurrent requests because the database enforces it.

**Canonical fact owner:** `Decision` owns the specification + status machine; `ChangeRequest` owns one reopening (reason, impacts, resolution); `DecisionEvent` owns the append-only lifecycle history.

**Commands/events:**

```text
POST /projects/:id/decisions/:decisionId/approve        (existing — now also RESOLVES the open ChangeRequest when status='change')
POST /projects/:id/decisions/:decisionId/change          (existing — now refuses when a ChangeRequest is already open)
POST /projects/:id/decisions/:decisionId/change/withdraw (NEW — the requester or PMC withdraws; decision returns to approved/locked)
DecisionEvent types emitted: drafted | issued | approved | change_requested | change_withdrawn | reapproved
AuditLog actions: decision.approve | decision.change | decision.change_withdraw (all with actorId)
```

**Schema and migration** (`20260910000000_phase1_change_control`, additive, diagnostic-first):

```prisma
ChangeRequest.status        // 'open' | 'resolved' | 'withdrawn' — CAS-enforced in service, cardinality DB-enforced
ChangeRequest.requestedById String?
ChangeRequest.resolvedById  String?
ChangeRequest.resolvedAt    DateTime?
ChangeRequest.resolution    String?   // 'reapproved' | 'withdrawn'
DecisionEvent.actorId       String?
DecisionEvent.actorName     String?
AuditLog.actorId            String?
Decision.approvedById       String?   // the real identity behind `approver`
Decision.onBehalfOf         String?   // 'client' when a PMC approves for the client
-- raw SQL in the migration (Prisma cannot express partial uniques):
CREATE UNIQUE INDEX "ChangeRequest_one_open_per_decision"
  ON "ChangeRequest" ("decisionId") WHERE status = 'open';
```

Backfill (before the index): `status='pending'` → `'open'` **only when the decision's status is still `change`**; all other `pending` rows → `'resolved'` (`resolution` null, documented as legacy). Diagnostics first: report every decision with more than one would-be-`open` row.

**Concurrency contract:** every transition is an atomic compare-and-set inside the transaction that also writes the events/children — `updateMany({ where: { id, projectId, status: <expected> }, data: { status: <next>, ... } })`, and if `count === 0` the transaction throws `ConflictException` (409). `requestChange` additionally relies on the partial unique index: a concurrent duplicate insert surfaces as `P2002`, translated to 409. No transition may read status outside its own transaction and act on it.

**State machine:** `pending → approved(locked)`; `approved → change` only via `requestChange` (opens ONE ChangeRequest); `change → approved` only via `approve` (emits `reapproved`, resolves the ChangeRequest with resolver identity) or `change/withdraw` (restores `approved`, resolution `withdrawn`). **Attribution:** replace the `'Mr. Shah'|'PMC'` hardcode with the caller's real name (DB lookup, fallback role label) + `approvedById = user.sub`; a PMC approving on behalf of the client records `onBehalfOf='client'`.

**Permissions:** approve/reapprove: `client, pmc` (unchanged); change: unchanged five roles; withdraw: `pmc` + the requesting role. New capability rows in `ROLE_POLICY` + `EXPECTED_ROLES` in the same PR.

**UI workflow:** Decision Log/Client Decisions show `change` decisions as "Change requested — awaiting client re-approval" with reason/cost/time; the client's Decisions Waiting includes a Re-approve CTA; PMC can withdraw. Offline: `approve`/`change` ops already queue; add `changeWithdraw` op (CAS-guarded server-side → replay-safe).

**Ordered steps:**

- [ ] **Step 1: Failing tests first.** Unit: state machine (double-open → 409; withdraw restores `approved`; reapprove resolves the request with resolver identity; attribution fields written; every transition emits its DecisionEvent with actorId). Integration (`test/integration/change-control.test.ts`, live PG): full open→reapprove and open→withdraw loops; **concurrency probes** — `Promise.all` of two simultaneous `change` requests → exactly one ChangeRequest row + one `change_requested` event + one 409; same shape for two simultaneous re-approvals and an approve-vs-withdraw race.
- [ ] **Step 2: Migration.** Diagnostics (report multi-open candidates) → backfill → partial unique index → columns. **STOP condition:** if diagnostics find a decision whose legacy rows cannot be resolved to at most one open request, abort and report the rows — do not pick a winner silently.
- [ ] **Step 3: Service.** `actor.ts` helper; CAS transitions per the concurrency contract; P2002→409 translation; withdraw route/DTO; events + audit with actorId.
- [ ] **Step 4: Contracts/policy.** Shared types, `ROLE_POLICY`, `EXPECTED_ROLES`, route wiring.
- [ ] **Step 5: Web.** Re-approve/withdraw flows; `changeWithdraw` outbox op; update Task-1 characterization tests to the new contract in this PR; seed strings updated for demo parity.
- [ ] **Step 6: Verify.**

Run: `pnpm --filter api exec vitest run src/decisions` · `DATABASE_URL=<test-db> JWT_SECRET=integration-test-secret pnpm --filter api exec vitest run --config vitest.integration.config.ts test/integration/change-control.test.ts` · full integration suite · `pnpm check` · upgraded-DB fixture run (legacy `pending` ChangeRequest backfilled correctly).

**Tests:** as in Step 1 + permission-matrix rows + cross-project probe (change request against another project's decision → 403/404). **Rollback:** revert API + web; additive columns stay; the partial unique index is kept (it enforces a true invariant) — dropping it requires an operator-reviewed forward migration. **Risks:** approver display changes for future approvals (historic rows untouched); backfill ambiguity handled by the STOP condition.

**Done criteria:** the database refuses a second open ChangeRequest; two concurrent transitions yield exactly one winner + one event, deterministically; re-approval resolves with real identity; snapshot exposes the open request; all gates green.

## Task 3: Controlled Drawing Lifecycle

**Business outcome:** The field always knows the governing construction revision and exactly WHO must build to it: a review copy can never displace the construction set, recipients are frozen per revision at issue time as database rows, acknowledgements work offline, and every issue is audited.

**Canonical fact owner:** `Drawing`/`DrawingRevision` own the issued intent; `DrawingRecipient` owns who a revision was issued to (frozen at issue); `DrawingAck` owns who confirmed building to it.

**Commands/events:**

```text
POST /projects/:id/drawings                    (existing issue — now audited, recipients frozen, supersede scoped)
POST /projects/:id/drawings/rev/:revId/ack     (existing — now offline-queueable)
AuditLog: drawing.issue | drawing.revise | drawing.publish | drawing.ack | drawing.remove | drawing.refile (all with actorId)
```

**Schema and migration** (`20260915000000_phase1_drawing_control`, additive, diagnostic-first):

```prisma
DrawingRevision.projectId  String            // NEW — backfilled from the parent Drawing, then NOT NULL
DrawingRevision.recipientsFrozenAt DateTime? // NEW — stamped when the recipient snapshot executes, EVEN when it
                                             // freezes an empty set; null = revision predates recipient snapshots.
                                             // This distinguishes "snapshot ran and was empty" from "legacy" —
                                             // the two get different readiness rows (Task 6 truth table).
DrawingRevision            @@unique([projectId, id])    // composite identity for tenant-safe references
DrawingRevision            @@unique([drawingId, rev])   // after a duplicate-label diagnostic

DrawingRecipient  id, projectId, revisionId, userId, roleAtIssue, createdAt
                  @@unique([revisionId, userId])
                  -- composite FK (projectId, revisionId) -> DrawingRevision(projectId, id)
                  -- composite FK (projectId, userId)     -> Membership(projectId, userId)  [NO ACTION]
```

**Recipient semantics (frozen at issue):** when a revision is issued/published, the service snapshots the project's **active members holding `engineer` or `contractor` roles at that moment** as `DrawingRecipient` rows and stamps `recipientsFrozenAt` — **even when the frozen set is empty** (PMC may extend the set in the issue request; later slices can refine selection — the FROZEN-ROWS model is the contract). Membership churn does not rewrite recipient rows; how churn affects readiness is defined by the Task 6 truth table, computed as `recipients ∩ currently-active members`. Legacy revisions (issued before this task) keep `recipientsFrozenAt` null — the migration must not invent snapshots.

**Semantics changes:** (a) a `for_construction` issue supersedes prior non-superseded `for_construction` revisions; **a `for_review` issue supersedes nothing** — it coexists as a review copy; (b) `governing` (serialized as `current`) = latest non-superseded **`for_construction`** revision; a drawing with only `for_review` revisions serializes `current: null` and the register labels it "In review — not for construction"; (c) the unacked-Inbox nudge derives from the viewer's own recipient rows.

**Permissions:** unchanged (issue/publish PMC; ack pmc/engineer/contractor). **Offline:** add `ackDrawing` outbox op — the server ack is already an idempotent upsert on `(revisionId, userId)`, making it the model replayable op.

**Ordered steps:**

- [ ] **Step 1: Failing tests first.** Unit: supersede scoping (`for_review` never supersedes; `for_construction` supersedes only `for_construction`); governing selection with review copies present; recipients frozen at issue (correct member set, PMC extension); duplicate `(drawingId, rev)` → 409; audit rows for issue/revise. Integration (`test/integration/drawing-control.test.ts`, live PG): recipient rows carry the composite FKs — **raw-SQL forgeries** (recipient pointing at another project's revision; recipient naming a non-member) rejected by PostgreSQL; upgraded-DB: every existing revision receives the correct backfilled `projectId`; a legacy drawing whose only rev is `for_review` serializes `current: null`.
- [ ] **Step 2: Migration.** Diagnostics: report duplicate `(drawingId, rev)` pairs AND any revision whose parent drawing is missing. **STOP condition:** either diagnostic reporting rows aborts the migration — resolve by hand, never auto-rename or auto-delete. Then: add `projectId` (backfill from parent, NOT NULL), unique keys, `DrawingRecipient` table + FKs.
- [ ] **Step 3: Service.** Supersede scoping; recipient freezing inside the issue transaction; audit for issue/revise/remove/refile with actorId; normalized audit action names.
- [ ] **Step 4: Snapshot/UI.** `current` = governing `for_construction`; register review-copy labeling; issue modal For-review checkbox; recipient-aware ack block.
- [ ] **Step 5: Web offline.** `ackDrawing` outbox op; replay test (queues offline, replays once, terminal-4xx drops).
- [ ] **Step 6: Verify.**

Run: `pnpm --filter api exec vitest run src/drawings` · integration `test/integration/drawing-control.test.ts` · full integration suite · `pnpm check` · upgraded-DB fixture run.

**Tests:** as above + permission rows + web outbox test. **Rollback:** revert services; recipient table + `projectId` column stay (inert); the unique constraints are kept unless an operator-reviewed forward migration removes them. **Risks:** the governing-selection change alters `current` for drawings whose latest rev is `for_review` (upgraded-DB test bounds the blast radius; consumers already null-guard); the recipient freeze at issue makes distribution explicit — projects with no engineer/contractor members at issue time produce zero recipients (readiness consequence defined in Task 6's truth table).

**Done criteria:** a `for_review` issue can never displace the construction set; `current` is always `for_construction` or null; recipients are frozen, database-constrained rows; acks replay offline idempotently; drawing issue is audited; all gates green.

## Task 4: Inspection Evidence, Requirement Link, Correction and Reinspection

**Business outcome:** "Inspected" means evidence exists AND names the work it accepts: a checklist is explicitly linked to the Activity it is required for, a failed item carries real durable photos, rejection creates exactly one assignable, dated, linked reinspection, and the whole chain survives offline capture without ever lying about durability.

**Canonical fact owner:** `Media` owns evidence bytes/metadata (one row per photo, containment-constrained to its inspection item); `Inspection` owns the checklist/review lifecycle AND the explicit `activityId` requirement edge; a reinspection is a new `Inspection` whose `reinspectionOfId` names its predecessor and which **inherits the predecessor's `activityId`**.

**Commands/events:**

```text
POST /projects/:id/media                        (existing — now accepts inspectionId + inspectionItemId, idempotent per (projectId, clientKey))
POST /projects/:id/inspections                  (existing create — now accepts optional activityId, the explicit requirement edge)
POST /projects/:id/inspections/:id/submit       (existing — fail items now require LINKED Media evidence; submitter identity stamped)
POST /projects/:id/inspections/:id/decide       (existing — CAS-guarded; reject CREATES the linked reinspection with assignee + due date)
AuditLog: inspection.create | inspection.submit | inspection.approve | inspection.reject — all with actorId
```

**Schema and migration** (`20260920000000_phase1_inspection_evidence`, additive, diagnostic-first):

```prisma
Inspection.activityId       String?   // the requirement edge — composite FK (projectId, activityId) -> Activity(projectId, id)
Inspection.reinspectionOfId String?   // composite FK (projectId, reinspectionOfId) -> Inspection(projectId, id)
Inspection.assigneeId       String?   // composite FK (projectId, assigneeId) -> Membership(projectId, userId) [NO ACTION]
Inspection.dueDate          DateTime? @db.Date
Inspection.submittedById/submittedByName  String?
Inspection.decidedById/decidedByName      String?
Inspection                  @@unique([projectId, id])          // add if not already present (referenced identity)

InspectionItem              @@unique([inspectionId, id])       // containment identity

Media.inspectionId          String?   // composite FK (projectId, inspectionId) -> Inspection(projectId, id)
Media.inspectionItemId      String?   // composite FK (inspectionId, inspectionItemId) -> InspectionItem(inspectionId, id)
Media.clientKey             String?
Media                       @@unique([projectId, id])          // referenced identity (used by Task 6 override evidence)
Media                       @@unique([projectId, clientKey])   // PROJECT-SCOPED idempotency — never a global unique
-- raw SQL: one direct reinspection child per rejected inspection
CREATE UNIQUE INDEX "Inspection_one_reinspection_child"
  ON "Inspection" ("reinspectionOfId") WHERE "reinspectionOfId" IS NOT NULL;
-- raw SQL: MATCH SIMPLE partial-reference guard — under PostgreSQL's default composite-FK
-- semantics a row with a non-null itemId and a NULL inspectionId would bypass the
-- (inspectionId, inspectionItemId) FK entirely; forbid the partial reference outright
ALTER TABLE "Media" ADD CONSTRAINT "Media_item_requires_inspection"
  CHECK ("inspectionItemId" IS NULL OR "inspectionId" IS NOT NULL);
```

The two Media composite FKs **chain containment at the database level**: `(projectId, inspectionId)` proves the inspection belongs to the project, and `(inspectionId, inspectionItemId)` proves the item belongs to THAT inspection — raw SQL cannot pair inspection A with an item of inspection B even inside the same project, **and the CHECK closes the `MATCH SIMPLE` escape** where a NULL `inspectionId` beside a non-null `inspectionItemId` would skip the composite FK. Inspection-level media (an `inspectionId` with no item) remains valid. `InspectionItem.photos` becomes a derived display count; the column is retained as a deprecated derivative.

**Concurrency contract:** `submit` and `decide` are CAS transitions (`updateMany` guarded on `submitted=false` / `decided=false`, count-checked → 409); `decide(reject)` creates the reinspection **in the same transaction**, with the partial unique index guaranteeing that two racing rejects cannot both create a child.

**Offline evidence durability (replaces the localStorage-only design):**

- NEW `apps/web/src/data/evidenceStore.ts` — an IndexedDB store holding media **bytes** keyed by `(userScope, projectId, clientKey)`; the JSON outbox op carries only metadata + `clientKey`, never the bytes.
- **Persistence is part of the command result:** the capture flow `await`s the durable IndexedDB write and shows "Photo saved offline" ONLY on success; a quota/write failure (`QuotaExceededError` or any rejection) surfaces as an explicit failure state ("Could not save this photo on the device — free space and retake") and queues nothing.
- **Size/compression policy:** client-side downscale before storage (longest edge ≤ 2048 px, JPEG re-encode) targeting ≤ ~1.5 MB per photo; a photo that still exceeds a hard cap (4 MB) is refused with an explicit message — never silently truncated.
- **Lifecycle:** replay reads bytes from IndexedDB by `clientKey` and uploads with the same `clientKey` (server dedupes per project). The IndexedDB entry is deleted ONLY on **confirmed server persistence** — a 2xx, or a dedupe conflict on the same `(projectId, clientKey)` proving an earlier upload already landed — or on the **user's explicit deletion**. Any other terminal 4xx must NOT silently drop the photo: the outbox op leaves the queue, but the bytes move to a persistent **failed-evidence state** surfaced in the UI with explicit Retry / Delete choices; retry re-queues with the same `clientKey`, delete requires the user's acknowledgement. User-cancelled captures delete immediately; entries survive reload and are keyed by user+project scope so a project/user switch neither loses nor leaks them.

**Behavior:** submit validates each `fail` item has ≥1 linked Media row (replacing the counter check) and stamps `submittedById/Name`; decide(reject) creates the reinspection (`kind:'checklist'`, items = rejected items with fresh IDs, `reinspectionOfId`, **inherited `activityId`**, `assigneeId` defaulting per Task 5's recorded completer or the original submitter — the default applies only while that identity resolves to an ACTIVE, role-ELIGIBLE membership (validated in service, constrained by the Membership FK), else the request must name an eligible assignee explicitly), `dueDate` = decide-day + N civil days via the injected Clock (PMC-overridable); decide stamps `decidedById/Name`; notifications become truthful. **Assignment eligibility:** a corrective/reinspection assignee (defaulted OR explicit) must hold an active membership in the project's **`engineer` or `contractor`** role — the roles that execute corrective site work (a PMC may assign themselves explicitly); an inactive or role-ineligible assignee is a 400. The PMC review screen renders actual evidence photos (signed URLs).

**Permissions:** unchanged role sets; media upload with inspection linkage: engineer/pmc.

**Ordered steps:**

- [ ] **Step 1: Failing tests first.** Unit: submit evidence rule; reject creates the linked child (items/assignee/due date/inherited activityId); zero-rejected reject still 400 for ordinary inspections; attribution stamped; assignee-not-a-member → 400; assignee with an INELIGIBLE role (e.g. client) → 400. Integration (`test/integration/inspection-evidence.test.ts`, live PG): full reject→reinspection chain; `(projectId, clientKey)` dedupe — same key twice → one row, same key in ANOTHER project → its own row; **raw-SQL forgeries**: cross-project media↔inspection, cross-INSPECTION item pairing (same project), **partial reference — non-null `inspectionItemId` with NULL `inspectionId` → rejected by the CHECK** (the `MATCH SIMPLE` bypass), reinspection child naming another project's parent, assignee without membership — each rejected by PostgreSQL; **concurrency probes**: two simultaneous rejects → one child + one 409; reject-vs-approve race → one winner; upgraded-DB: legacy counter-based inspections still render and can be decided.
- [ ] **Step 2: Migration.** Diagnostics: report any InspectionItem whose inspection is missing; report `(projectId, clientKey)` pre-collisions (there are none — column is new — keep the check as a template invariant); report legacy `INSP-*-close` ids that match no activity (informational here; used by Task 5). **STOP condition:** containment diagnostics reporting rows abort the migration.
- [ ] **Step 3: API services.** Media linkage + project-scoped idempotency; inspection create with `activityId` requirement edge (service-validated + composite FK); CAS submit/decide; reinspection creation in-transaction; attribution; truthful notifications.
- [ ] **Step 4: Web evidence store.** `evidenceStore.ts` (IndexedDB); capture flow with durable-write-then-confirm; size policy; upload replay wiring; per-item thumbnails + queued badges; PMC evidence grid.
- [ ] **Step 5: Web tests.** Browser/unit tests for: reload before replay (bytes survive, op replays once), quota/write failure (explicit failure, nothing queued, no "saved" message), two photos on one item, project/user scope switch isolation, exactly-once IndexedDB cleanup after confirmed upload, dedupe-conflict cleanup (409 on the same key deletes the bytes — the server already has them), and **terminal-4xx recovery** (a non-dedupe 4xx retains the bytes in the failed-evidence state, surfaces Retry/Delete, deletes only on the user's acknowledgement, and retry re-uses the same `clientKey`).
- [ ] **Step 6: Verify.**

Run: `pnpm --filter api exec vitest run src/inspections src/media` · integration `test/integration/inspection-evidence.test.ts` · full integration suite · `pnpm check` · upgraded-DB fixture run.

**Tests:** as above + permission rows. **Rollback:** revert API/web; additive columns/null links stay; evidence rows persist harmlessly; the one-child index is kept. **Risks:** submit is stricter (fail without real photo → 400) — the capture flow must stay one-tap (explicit product constraint); IndexedDB availability in embedded webviews (feature-detect; unavailable → fail explicitly, never fall back to a store that lies).

**Done criteria:** a failed item without linked evidence cannot be submitted; the requirement edge is explicit and database-constrained (including the partial-reference CHECK); a rejection yields exactly one linked, assigned, dated reinspection under concurrency, assigned only to an active eligible role; uploads are idempotent per project; an offline photo is durably stored and uploaded exactly once, held in an explicit failed state awaiting the user's Retry/Delete, or reported as NOT saved at capture time — **bytes are never deleted without confirmed server persistence or the user's explicit decision**; all gates green.

## Task 5: Closing Sign-off Controls Activity Completion

**Business outcome:** "Done" means accepted: an engineer's completion claim is an attributable fact that parks the activity in `awaiting_signoff`; only the PMC's approval of the linked closing inspection makes it `done`; rejection sends it back to execution with corrective work assigned to the recorded completer — never a guess.

**Canonical fact owner:** `Activity.status` owns the work state; `Activity.completionRequestedBy*` owns the completion claim; the linked closing `Inspection` owns the sign-off record; the transition `awaiting_signoff → done` is owned by the inspection decide command (the PMC's attributable technical acceptance).

**Commands/events:**

```text
POST /projects/:id/activities/:id/complete      (existing — CAS to awaiting_signoff; records completer identity; creates the LINKED closing inspection with a default sign-off item)
POST /projects/:id/inspections/:id/decide       (existing — approving a closing inspection sets its activity done; rejecting returns it to in_progress + Task 4 chain)
AuditLog: activity.complete_requested | activity.signoff | activity.signoff_rejected — with actorId
```

**Schema and migration** (`20260925000000_phase1_closing_signoff`, additive, diagnostic-first):

```prisma
Inspection.closing          Boolean @default(false)   // unambiguous marker (id-pattern matching retired)
Activity.status             // union gains 'awaiting_signoff' (shared types + contracts updated)
Activity.doneAt             DateTime? @db.Date        // sign-off civil day; actualEndDate remains the claimed work-end day
Activity.completionRequestedById  String?             // composite FK (projectId, completionRequestedById) -> Membership(projectId, userId) [NO ACTION]
Activity.completionRequestedByName String?
Activity.completionRequestedAt     DateTime?
```

Backfill: `Inspection.activityId` (column exists from Task 4) + `closing=true` derived from the deterministic legacy id pattern `INSP-<activityId>-close` **only where exactly one matching same-project activity exists**; ambiguous or foreign matches are left null/false and reported. **Legacy `done` activities stay `done`** — no retroactive reopening.

**Behavior:** `complete()` is a CAS (`in_progress → awaiting_signoff`, count-checked → 409) recording `completionRequestedBy*` (validated active membership) and creating — in the same transaction — the closing inspection WITH one default item ("Work complete and acceptable"), `closing=true`, `activityId`, `submittedById` = the completer. `decide(approve)` on a closing inspection → activity `done` + `doneAt` (same transaction, CAS on `awaiting_signoff`); `decide(reject)` → activity `in_progress` (CAS) + item flags + the Task 4 reinspection chain with **assignee defaulted to `completionRequestedById` ONLY when that identity still holds an active membership with an assignment-eligible role (`engineer` or `contractor` — Task 4's eligibility rule); otherwise — removed, OR role changed to an ineligible one (e.g. engineer→client/consultant) — the reject request MUST name an explicit assignee who is active and eligible** (400 with an explicit message if omitted or ineligible). Both removal and role change between claim and rejection are therefore defined behavior, not guesses. Legacy zero-item closings (`closing=true`, no items) may be rejected (special-cased on the `closing` flag). Ordinary inspections behave as in Task 4.

**Permissions:** `activity.complete` stays engineer/pmc (it now means "request sign-off"); the sign-off itself is `inspection.decide` = pmc only. No new route.

**Ordered steps:**

- [ ] **Step 1: Failing tests first.** Unit: complete → `awaiting_signoff` + linked item-bearing closing inspection + completer identity recorded; approve → `done` + `doneAt`; reject → `in_progress` + chain assigned to the recorded completer; completer no longer active OR role-ineligible → reject without explicit assignee is 400, with an explicit eligible assignee succeeds, with an ineligible explicit assignee still 400; legacy zero-item closing paths. Integration (`test/integration/closing-signoff.test.ts`, live PG): full complete→approve and complete→reject loops; **concurrency probes** — two simultaneous completes → one transition + one 409; two simultaneous closing decides → one winner; approve-vs-reject race → one outcome; upgraded-DB: legacy `done` stays `done`; backfilled `activityId`/`closing` correct; **membership-churn tests**: (a) REMOVE the completer between claim and rejection → explicit-assignee path exercised; (b) CHANGE the completer's role engineer→client between claim and rejection → the default is refused and an explicit eligible assignee is required.
- [ ] **Step 2: Migration.** Backfill diagnostics per above. **STOP condition:** any `INSP-*-close` id matching multiple activities or an activity in another project aborts with a report — never auto-link ambiguously.
- [ ] **Step 3: API services.** CAS complete; closing decide → activity transitions in-transaction; assignee resolution rule; audit actions with actorId.
- [ ] **Step 4: Shared/web.** Status union + contracts; schedule "Awaiting sign-off" state; PMC review labels closing inspections with their activity; selectors (`phaseRollup`, action items) count `awaiting_signoff` as NOT done (pinned).
- [ ] **Step 5: Update Task-1 characterizations** to the new contract in this PR; seed/demo flows updated.
- [ ] **Step 6: Verify.**

Run: `pnpm --filter api exec vitest run src/activities src/inspections` · integration `test/integration/closing-signoff.test.ts` · full integration suite · `pnpm check` · upgraded-DB fixture run · acceptance suite.

**Tests:** as above. **Rollback:** revert API/web; the new status value only exists on rows written by the new code — rollback includes one operator-reviewed forward migration mapping `awaiting_signoff → in_progress` (documented in DEPLOY notes for this task). **Risks:** the biggest behavior change of the phase — completion is no longer instant `done` (product-visible; acceptance suite and seed updated in the same PR).

**Done criteria:** no path writes `done` except closing-inspection approval; the completion claim is an attributable, membership-validated fact; rejection assigns corrective work from that fact or demands an explicit assignee; concurrency probes prove single-winner transitions; legacy data proven stable on an upgraded copy; all gates green.

## Task 6: Readiness Derived from Explicit Links + Projections

**Business outcome:** A gate dot is a conclusion drawn from explicit recorded relationships: Decision readiness from the linked decision's lock state, Inspection readiness from inspections **linked to this activity** (never from sharing a room), Drawing readiness from the governing revision's **frozen recipients** — and any manual override is an attributable, expiring, evidenced record.

**Canonical fact owner:** readiness is a **derivation** owned by `domain/transitions.ts` (serialized in the snapshot); `GateOverride` owns each manual exception; the edges it derives from are owned by Tasks 2–5 (`Decision.status`, `Inspection.activityId` chains, `DrawingRecipient` ∩ `DrawingAck`).

**Commands/events:**

```text
POST /projects/:id/activities/:id/override      (NEW — { gate, state, reason, evidenceMediaId?, expiresAt } ; pmc only)
DELETE /projects/:id/activities/:id/override/:overrideId (NEW — pmc; revoke early)
AuditLog: activity.override | activity.override_revoke — with actorId
```

**Schema and migration** (`20260930000000_phase1_derived_readiness`, additive):

```prisma
GateOverride  id, projectId, activityId, gate ('decision'|'material'|'team'|'inspection'|'drawing'),
              state GateState, reason String, actorId String, actorName String,
              evidenceMediaId String?, expiresAt DateTime, createdAt
              -- composite FK (projectId, activityId)      -> Activity(projectId, id)
              -- composite FK (projectId, evidenceMediaId) -> Media(projectId, id)   [Task 4 added the unique key]
```

**Truth-table evaluation rule (both tables):** rows are ordered by precedence and evaluated **top-down; the FIRST matching row wins**. States are therefore mutually exclusive by construction — no outcome may depend on unstated evaluation order.

**Inspection-gate truth table** (inputs: the set `R` of NON-closing inspections with `activityId = A.id`; a **chain** is a decided-rejected member of R plus its transitive reinspection children, which inherit `activityId` and so belong to R; co-located inspections with a different or null `activityId` are **invisible** to this gate):

| # | Condition (first match wins) | Gate |
|---|---|---|
| 1 | R is empty (no linked inspection) | `na` |
| 2 | Any chain in R is OPEN — its most recent reinspection child is unsubmitted, undecided, or itself rejected without a child yet | `fail` |
| 3 | Any member of R OUTSIDE an open chain is not yet submitted or not yet decided (open requirement) | `wait` |
| 4 | Otherwise — every chain is closed by an approved reinspection and every other member of R is approved | `ok` |

An **open reinspection child matches row 2 and ONLY row 2** — row 2 precedes the generic open-requirement row 3, so a chain in progress reads `fail` (the requirement was failed and its correction is not yet accepted), never a plain `wait`. An unrelated inspection sharing only the node/room matches no row's input set (proven by test).

**Drawing-gate derivation.** An Activity may be governed by **several drawings** (`Drawing.activityId` is many-to-one). The gate is computed **per linked drawing** by the table below, then **aggregated across all linked, published drawings with worst-state-wins precedence `fail > wait > ok`**; an activity with no linked drawings is `na`. Example: one fully-acknowledged construction drawing (`ok`) + one review-only drawing (`fail`) → `fail`.

Per-drawing inputs: governing revision `G` = the drawing's latest non-superseded `for_construction` revision; recipient set `P` = `DrawingRecipient(G)`; `active(P)` = P ∩ currently-active project members; `G.recipientsFrozenAt` distinguishes a revision whose snapshot RAN (possibly freezing an empty set) from a legacy revision that predates snapshots:

| # | Condition (first match wins) | Per-drawing state |
|---|---|---|
| 1 | No governing `for_construction` revision (review-only or superseded-out) | `fail` |
| 2 | `G.recipientsFrozenAt` is null (legacy revision — predates recipient snapshots) | `ok` if ≥1 ack exists on G, else `wait` (documented legacy rule; the migration must not invent recipients) |
| 3 | Snapshot ran and `active(P)` is empty (froze zero recipients, or every recipient has since left the project) | `wait` — nobody currently on the project has confirmed the governing set; re-issue or override |
| 4 | Some member of `active(P)` has not acknowledged G (incl. partial acknowledgement) | `wait` |
| 5 | Every member of `active(P)` has acknowledged G | `ok` |

Membership-churn consequences (derivable from the rows, pinned by tests): a recipient **removed** after issue drops out of `active(P)` and cannot block (rows 3–5); a member **added** after issue is not in P and is not required until the next revision freezes a new set; a **superseding** `for_construction` issue replaces G and P — the gate recomputes against the fresh snapshot (unacked → `wait` via row 4).

**Other gates:** Decision — unchanged derivation (`change` status ⇒ `wait`, so Task 2's reopening reverts readiness automatically). Material — unchanged this phase (mismatch ⇒ `fail` stays; full derivation is Phase 3). Team — unchanged stored flag (Phase 4). Both documented as `stored` sources in the serialized payload. `gateInspection` is removed from `updateActivitySchema` (breaking contract change — characterized in Task 1) and retained as a deprecated column. **Overrides:** an unexpired `GateOverride` supersedes the derivation for its gate; expiry restores the derived value; every override is audited and surfaced. `start()` requires all five readiness values (`ok|na`), overrides considered.

**Snapshot/projection:** activity DTO gains a `readiness` object (five gates: value + source `derived|stored|override` + reason); the web's `gatesFor`/`activityReady`/action-items consume it (demo mode keeps parity via shared logic). Inbox items: "Blocked: drawing unacknowledged", "Override expiring <date>".

**Permissions:** override = pmc only; new `ROLE_POLICY`/`EXPECTED_ROLES` rows.

**Ordered steps:**

- [ ] **Step 1: Failing tests first.** Unit: BOTH truth tables row-by-row (every numbered row above is one test case) PLUS the four disambiguation cases the tables were corrected for — **an open reinspection child reads `fail`, not `wait`** (row-2-over-row-3 precedence); **two linked drawings with mixed states aggregate worst-wins** (acked construction + review-only → `fail`); **a newly issued revision that froze zero recipients** reads `wait` (row 3); **a legacy revision with no recipient rows** follows the legacy rule (row 2) — the two are distinguished ONLY by `recipientsFrozenAt`; plus override precedence + expiry and the start guard on drawing readiness. Integration (`test/integration/derived-readiness.test.ts`, live PG): approve→gate flips; reject→`fail` until the linked reinspection passes; **an unrelated same-node inspection does not move the gate**; unacked governing rev blocks start; recipient-removed and member-added-after-issue rows; multi-drawing aggregation; override with expiry admits start then lapses; GateOverride cross-project forgeries (activity and evidence media) rejected by PostgreSQL.
- [ ] **Step 2: Migration** (GateOverride + FKs) and the **stored-vs-derived delta report**: a diagnostic listing every activity whose stored `gateInspection` disagrees with the derivation. **STOP condition:** if the delta report surfaces a discrepancy CLASS the truth tables above do not cover, stop and bring it back to review — do not invent a new derivation rule mid-implementation.
- [ ] **Step 3: API.** Derivations in `transitions.ts`; override routes/service; `updateActivitySchema` change; snapshot `readiness` serialization with sources.
- [ ] **Step 4: Web.** Selectors/action items consume `readiness`; override UI (reason/evidence/expiry); schedule/Inbox surfacing.
- [ ] **Step 5: Update Task-1 characterizations**; permission rows.
- [ ] **Step 6: Verify.**

Run: `pnpm --filter api exec vitest run src/domain src/activities` · integration `test/integration/derived-readiness.test.ts` · full integration suite · `pnpm check` · acceptance suite · upgraded-DB fixture run (delta report attached to the PR).

**Tests:** as above + permission matrix + web selector tests. **Rollback:** revert API/web (derivations are read-time; stored columns still hold legacy values); override table stays. **Risks:** activities start-able under manual flags may become blocked (drawing/inspection truth) — this is the point; the delta report + override mechanism give a controlled path. Perf: derivations join linked inspections/recipients/acks per snapshot — bounded per project; measured in the task.

**Done criteria:** no route can set `gateInspection`; readiness derives ONLY from explicit edges and names its source; both truth tables are fully test-covered — first-match precedence, the open-reinspection-child case, multi-drawing worst-wins aggregation, the zero-recipient vs legacy discriminator, and the unrelated-same-node probe; overrides expire; all gates green.

## Task 7: End-to-End Acceptance Suite and Review Packet

**Business outcome:** One repeatable browser-level proof that the full pillar chain works on the real stack, and one honest evidence packet for the independent gate.

**Canonical fact owner:** none (test + docs).

- [ ] **Step 1: `apps/web/tests/e2e-api/pillar-chain.spec.ts`** — the complete chain against compiled API + seeded PostgreSQL: PMC issues a decision → client approves (attributed) → PMC issues a `for_construction` drawing (recipients frozen) → engineer acknowledges → PMC issues a checklist LINKED to the activity → activity becomes ready and starts → engineer fails an item WITH a real photo → PMC rejects → the linked reinspection (assignee, due date) appears in the engineer's Inbox → engineer passes it with evidence → activity complete → `awaiting_signoff` → PMC approves the closing inspection → `done`. Then the change loop: change request on the approved decision → readiness reverts → client re-approves → ready again. Negative scenarios: a `for_review` issue does not displace the governing set; **an unrelated inspection on the same room does not block the activity**; a second linked review-only drawing degrades the aggregated drawing gate; a non-PMC cannot override; a second project sees none of it (isolation re-proof on every new table); an offline-queued evidence photo survives a page reload and replays exactly once; an oversized/quota-failing capture reports failure and queues nothing; a non-dedupe terminal 4xx on replay lands the photo in the failed-evidence state with Retry/Delete instead of silently deleting it.
- [ ] **Step 2: representative upgraded-database CI evidence** — a scripted legacy fixture (pre-Phase-1 shapes: done activities, zero-item closings, pending ChangeRequests, counter-only items, revisions without projectId) migrated through all Phase 1 migrations with the diagnostic outputs attached; assertions that legacy meaning is preserved.
- [ ] **Step 3: `docs/reviews/phase-1-review-packet.md`** — same discipline as Phase 0 (learned the hard way): base + reviewed head AND merge SHAs in separate columns per PR, migration checksums, command outputs with totals, direct green CI URLs for heads AND merges, acceptance-criteria checklist mapped to spec §25 rows this phase covers, residual risks. Written AFTER the merges it cites; refreshed docs-only if the gate finds drift.
- [ ] **Step 4: durable docs** — ARCHITECTURE/DATA_MODEL invariants updated to implemented-behavior statements (locked decisions + change loop, governing revision + frozen recipients, evidence/containment chain, sign-off authority, derived readiness truth tables + overrides); ROADMAP Phase 1 rows checked with PR links.

**Done criteria:** acceptance suite green in CI (`api-e2e`), upgraded-DB job green, packet complete, docs true. Phase 1 is complete only when the independent review clears.

---

## Human Authority (phase-wide invariants)

- The **client** approves and re-approves design choices (Task 2); a PMC acting on behalf is recorded as `onBehalfOf`, never disguised.
- The **architect/PMC** issues drawings (Task 3) and performs technical sign-off (Task 5); both are attributable commands, never automatic.
- **Field evidence** (photos, submissions) supports decisions but cannot approve anything by itself — no evidence upload transitions any approval state (Tasks 4–6).
- **Overrides** require actor, reason, evidence and expiry (`GateOverride`, Task 6) — no silent flag-flips remain.

## Rollout and Rollback Rules

1. Deploy each task's migration before its API build; every migration is diagnostic-first and aborts on ambiguous legacy data rather than guessing (STOP conditions per task).
2. Take a verified backup before Tasks 3, 5 and 6 reach production (constraint + semantics changes).
3. Additive columns/tables are never auto-reverted; invariant-bearing unique indexes (one-open-request, one-reinspection-child, rev labels) are kept on rollback unless an operator-reviewed forward migration removes them. Application rollback = prior build + kept schema. Task 5 documents the forward-mapping migration required if rolled back after `awaiting_signoff` rows exist.
4. After each deploy, smoke-test: approve→lock, change→re-approve, issue→ack, fail-with-photo→reject→reinspection, complete→sign-off, one override, one cross-project 403, and one offline photo capture→reload→replay.

## Claude Code Handoff Prompt

```text
Work in JagPat/PMCvitan from the latest origin/main. Read CLAUDE.md, the canonical spec, and docs/superpowers/plans/2026-07-13-phase-1-existing-pillars.md. Revalidate the plan's current-state table against main and report drift before editing.

Execute Phase 1 only, Tasks 1-7 in order, one PR per task, following each task's ordered steps and honoring its STOP conditions — a failed relationship/cardinality assumption stops work and comes back for review, it is never improvised around. TDD with characterization-first; additive diagnostic-first migrations; database-enforced cardinality and CAS transitions for every lifecycle state machine; real actor identity on every new mutation; composite-key tenant AND containment constraints proven against PostgreSQL with raw-SQL forgery probes; durable IndexedDB offline evidence that never reports an unsaved photo as saved; project-scoped idempotency keys.

Do not add procurement, inventory, labour, billing, portals, RedBracket, microservices or unrelated cleanup. Stop for independent review after Tasks 1, 3, 5 and 7. Completion evidence is PostgreSQL integration + concurrency probes + permission-matrix + isolation/containment + idempotency + API-backed browser tests, and the Phase 1 review packet.
```

## Independent Codex Review Gate

Provide the PR URL, base/head/merge SHAs and `docs/reviews/phase-1-review-packet.md`. Codex verifies at minimum: the change loop cannot be bypassed and cannot double-open under concurrency (database-enforced); no review copy governs construction; recipients are frozen rows with a persisted snapshot discriminator, and readiness follows the first-match truth tables — including the open-reinspection-child precedence, multi-drawing worst-wins aggregation, churn rows and the zero-recipient vs legacy distinction; failed items carry linked, containment-constrained evidence (composite FKs plus the partial-reference CHECK, raw-SQL proven); rejection always yields exactly one linked reinspection assigned to an active, role-eligible assignee; nothing but closing-inspection approval writes `done`, and the corrective assignee comes from the recorded completion claim only while that identity remains active AND role-eligible; readiness derives only from explicit edges (unrelated-same-node probe); offline photo bytes are never deleted without confirmed server persistence or the user's explicit decision — non-dedupe terminal failures dead-letter with Retry/Delete — and replay is exactly-once per project-scoped key; every new reference is isolation- and containment-proven by raw-SQL probes; legacy data survives the upgrade with meaning intact. Any failed item reopens its originating task.
