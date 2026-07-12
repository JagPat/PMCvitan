# PMCvitan Modular Construction Control Platform

**Status:** Proposed for implementation review  
**Date:** 12 July 2026  
**Repository baseline:** `b2ff3dc581c72bb17198b890a2e3783a41fb74c9`  
**Canonical scope:** Stage 1 PMCvitan architecture and migration. RedBracket integration is Stage 2.

## 1. Purpose

PMCvitan is the operating record for an architect-led Project Management Consultancy. It connects the architect/PMC, client, site engineer, contractor, consultants and suppliers around construction work designed by the practice.

The product must answer, from one traceable information chain:

- What was decided, by whom, and what changed?
- What is designed and which drawing revision governs the work?
- What work is planned, ready, blocked, running or complete?
- What materials, labour, equipment and approvals are required?
- What has been ordered, delivered, accepted, stored, reserved, issued, consumed, returned or wasted?
- What was inspected, rejected, corrected and signed off?
- What is committed, billed, certified, payable and paid?
- What will delay the project and what funds will be required?

The initial success target is reliable daily use on one or two Vitan sites. The architecture must then support external contractors and architectural practices without a rewrite.

### Implementation North Star

The current application began as a high-fidelity single-site prototype and has grown into a multi-project product. The next stage is not about adding the largest number of screens. It is about making PMCvitan trustworthy enough to become the default operating system for a real architectural practice and its construction sites.

Construction delays and disputes rarely come from one missing list. They come from disconnected facts: a client decision does not reach procurement, a drawing revision does not reach the person building, material arrives without being tied to planned work, labour waits for unavailable material, rejected work appears complete, and a vendor bill cannot be traced to accepted supply or measured work. PMCvitan exists to keep those facts connected.

The product vision is therefore:

> Record a fact once, at its responsible source; let it travel through every authorized process; add evidence and decisions as work progresses; derive readiness, time, cost and accountability from the same chain.

The system should reduce clerical work while preserving human authority. It automates copying, matching, calculation, forecasting, reminders and draft preparation. It does not automate client consent, technical judgment, physical acceptance, certification or payment authority.

Field usability is a primary architectural constraint. A site engineer or storekeeper must be able to record the real event quickly on a phone, including during unreliable connectivity. The office should receive structured information without asking the field to re-enter it in a spreadsheet or message.

### Decision Test for Claude Code

Before proposing or implementing any change, Claude Code must answer:

1. Which real construction user and site decision does this help?
2. What is the canonical fact, and which module owns it?
3. Is the fact project/site scoped and protected from another tenant?
4. Which existing and future modules consume it, preferably through a versioned event?
5. Which duplicate human entry, spreadsheet or message does this eliminate?
6. Which approval must remain human, attributable and auditable?
7. Can the workflow recover from offline use, retries, partial failure and later scale?

A change that adds UI without establishing a canonical record and downstream information flow is incomplete. A change that copies a fact into several modules instead of referencing its owner is architectural regression. A change that makes the field workflow slower requires explicit product approval.

## 2. Decisions

1. Keep the existing React, NestJS, Prisma and PostgreSQL product. Do not rewrite it.
2. Evolve it into an event-driven modular monolith before considering microservices.
3. Keep organization-wide methods and portfolio views global; keep all operational records project-scoped.
4. Adopt hybrid tenancy: Vitan-owned projects with guest collaborators initially, promotable to company-owned organizations later.
5. Use Activities as the coordination spine without making Activity a god object.
6. Give each module ownership of its records, commands, queries, policies, events, projections, routes and tests.
7. Connect modules through versioned domain events written through a transactional outbox.
8. Store each canonical fact once; use references downstream and immutable snapshots only for issued contractual documents.
9. Derive readiness, dashboards, portfolio metrics, forecasts and Inbox items from canonical records and events.
10. Keep statutory accounting, GST returns, bank reconciliation and the general ledger outside PMCvitan initially. PMCvitan owns operational commercial control and payment certification.
11. Preserve a Stage 2 integration boundary for RedBracket through APIs, events and external identity mapping. Never couple databases directly.

## 3. Non-goals for Stage 1

- A complete accounting or tax product.
- Runtime installation of untrusted third-party plugins.
- Microservices or a database per module.
- Full Primavera/MS Project replacement.
- Automatic contractual approvals without a responsible human.
- Direct synchronization with RedBracket before PMCvitan is stable on pilot sites.

## 4. Scope and Ownership Invariants

| Scope | Canonical records |
|---|---|
| Platform | identities, organizations, companies, module registry, integrations |
| Organization | members, reusable methods/modules/presets, policies, company directory |
| Portfolio | rebuildable cross-project projections only |
| Project | dashboard, activities, decisions, drawings, inspections, daily logs, procurement, stock, labour, commercial records |
| Site/location | buildings/areas/rooms/elements, stores and all placed operational records |
| Personal | assignments, Inbox projection, preferences and private project drafts |

Required invariants:

- A project belongs to exactly one owning organization.
- A project may contain one or more sites. The current one-project/one-site behavior becomes the default, not a permanent restriction.
- Operational records must carry `projectId` and cannot reference another project's entities.
- A user is a global identity. Project access comes only from active memberships or explicit organization authority.
- A draft operational record belongs to one project and author. Organization method drafts belong to the method library, not the project Drafts workspace.
- Templates are reusable methods. Instantiated content receives new project-owned IDs and never remains live-linked to its template.
- Cross-module projections are never the source of truth and must be rebuildable.
- Issued approvals, purchase orders, drawing revisions, bills and certificates are immutable versions.

## 5. Existing Product Modules

The existing work is retained and corrected, not discarded.

| Module/surface | Responsibility after modularization |
|---|---|
| Identity and Access | sign-in, organization membership, project membership and authority |
| Projects and Team | project ownership, parties, people, companies and collaboration |
| Site Map | canonical spatial structure and location-based aggregation |
| Activities and Schedule | work plan, dependencies, requirements, readiness and forecast |
| Decisions | client choices, approved specification, change control and audit |
| Drawings | controlled revisions, transmittals, acknowledgements and governing intent |
| Inspections | checklists, evidence, rejection, corrective work, reinspection and final sign-off |
| Daily Log | attendance, deliveries, material issues, progress, incidents and site actuals |
| Drafts | cross-module author-private projection, not an independent domain |
| Inbox | role-specific action projection across modules |
| Notifications | delivery and escalation of domain events |
| Dashboard | one-project operational projection |
| Portfolio | multi-project management projection |
| Templates | versioned organization methods and project starting structures |
| Audit and Reports | immutable attribution, report drafts and published report versions |

Existing behavior that must be replaced rather than preserved:

- fixed June 2026 schedule offsets;
- manually edited readiness gates;
- inspection photo counters without media evidence;
- simulated reinspection tasks;
- activity completion before closing inspection approval;
- hardcoded Ambli facts and simulated reports in API mode;
- unresolved decision change requests;
- incomplete project-switch state replacement.

## 6. Target Modular Monolith

```text
platform/
  identity
  organizations
  companies
  projects
  collaboration
  files
  audit
  events
  module-registry
  integrations

modules/
  activities
  decisions
  drawings
  inspections
  daily-log
  procurement
  inventory
  labour
  commercial
  reporting
```

Dependency rules:

- Modules may depend on the platform kernel and declared public contracts.
- Modules must not import another module's persistence internals or update its tables.
- Cyclic module dependencies are prohibited.
- Synchronous calls are limited to queries or validations that must complete in the initiating transaction.
- Cross-module consequences use domain events and idempotent consumers.
- Reporting reads module projections rather than joining arbitrary transactional tables.

The initial registry is compile-time. Runtime third-party plugins may be designed later only after internal module contracts have proven stable.

## 7. Module Contract

Every module declares:

```text
id and version
dependencies
capabilities
permissions
commands and command schemas
queries and response schemas
published domain events
event subscriptions
API routes
frontend routes and navigation contributions
projections
scheduled jobs
report contributions
database migrations
health checks
```

The registry validates uniqueness, dependencies, cycles, event compatibility, migrations, permissions and route contributions during startup and CI.

`ModuleInstallation` enables modules and configuration per organization/project. It must not be used to hide missing authorization checks.

## 8. Hybrid Tenancy and Collaboration

Separate a business party from an application tenant:

```text
Company
  legal/business identity: Vitan, client, contractor, supplier, consultant

Organization
  PMCvitan tenant/workspace, optionally linked to a Company

ProjectParty
  Company participation in a Project with role and contract context

User
  global human identity

OrganizationMembership
  user authority within an Organization

ProjectMembership
  user authority within a Project, optionally representing a ProjectParty
```

Initially, contractors and suppliers may be unclaimed Companies invited as project guests. Later, a Company can claim or create an Organization without changing historical project records. Project operational records remain owned by the project-owning organization; participants receive permissioned access.

External suppliers may see only their RFQs, quotes, purchase orders, delivery commitments, receipts, disputes, bills and payment statuses. They must not see competing quotes, internal budgets or another supplier's records.

## 9. Integration Backbone

The write path is:

```text
validated command
  -> owning module transaction
  -> canonical record and audit entry
  -> transactional outbox event
  -> asynchronous idempotent consumers
  -> read-model projections, Inbox, notifications and forecasts
```

Every event includes:

```text
eventId
eventType
payloadVersion
organizationId
projectId
siteId when applicable
actorId
entityId
occurredAt
correlationId
causedByEventId
payload
```

Consumers record processed event IDs. Retry uses backoff; exhausted failures enter an operator-visible dead-letter queue. Projections expose rebuild status and can be regenerated from canonical records/events.

The design uses canonical state plus append-only events, not full event sourcing. Current state remains queryable in normal relational tables.

## 10. One Information Chain

The material lineage is:

```text
approved Decision specification
  -> ActivityRequirement
  -> MaterialRequisition
  -> RFQ and VendorQuoteLine
  -> approved QuoteComparison
  -> PurchaseOrderLine
  -> DeliveryCommitment
  -> GoodsReceiptLine and quality result
  -> StockLot
  -> ActivityReservation
  -> MaterialIssue
  -> Consumption, Return or Wastage
  -> Measurement
  -> VendorBillLine
  -> BillVerification and Certification
  -> PaymentApproval
  -> PaymentRecord or accounting synchronization
```

Every step references its source. Users do not retype specification, activity, location, vendor or agreed rate. Issued commercial documents retain frozen snapshots for legal and historical accuracy.

## 11. Activities and Requirements

`ActivityRequirement` is the common demand contract:

```text
projectId
siteId
activityId
locationId
type: material | labour | equipment | decision | drawing | inspection
resource/specification reference
required quantity and unit
requiredBy date
responsible party
criticality
tolerance
status
```

Type-specific modules own detailed records. Activity does not contain procurement, stock or payroll internals.

Readiness is a projection with `ready`, `at-risk`, `blocked` and `not-required`, plus owner, needed-by date, evidence, explanation and forecast impact. Manual overrides require authority, reason, evidence and expiry.

Examples:

- Decision readiness comes from a published, locked decision or approved change.
- Drawing readiness comes from the current issued revision and required acknowledgements.
- Material readiness comes from accepted, reserved stock sufficient for the planned work window.
- Labour readiness comes from committed allocation and same-day verified attendance.
- Inspection readiness comes from the required passed inspection.
- Completion requires approved closing inspection; rejection keeps the Activity incomplete.

## 12. Procurement

Workflow:

```text
MaterialRequisition
  -> approval
  -> RFQ
  -> VendorQuote
  -> technical/commercial comparison
  -> vendor selection
  -> PurchaseOrder
  -> DeliverySchedule
  -> receipt and quality acceptance
```

Vendor comparison includes base rate, tax, freight, landed cost, approved make/specification, sample compliance, available stock, lead time, delivery promise, quote validity, payment terms, warranty and historical delivery/quality performance.

Selection records authority and reason, including why a non-lowest offer was selected. Purchase-order issuance creates committed cost and delivery expectations.

## 13. Inventory and Site Stores

Inventory uses an immutable stock transaction ledger. No module directly overwrites current quantity.

Transactions include receipt, acceptance, rejection, transfer, reservation, issue, return, vendor return, consumption, wastage and audited adjustment.

```text
onHand = accepted receipts + transfers in + returns - issues - transfers out - write-offs
reserved = allocations to upcoming activities
available = onHand - reserved
projected(date) = available + confirmed inbound before date - requirements due before date
```

`StockLot` preserves vendor, purchase order, receipt, batch, specification, location, acceptance result and evidence. Stage 1 supports project-site stores and staging locations. Organization warehouses can be added later through the same transfer model.

## 14. Labour

The Labour module distinguishes required, committed, allocated, present and productive crew. Attendance does not imply availability unless the worker/crew is allocated to the Activity.

It tracks trade, contractor, crew, planned dates, shift, attendance evidence, allocation, output and productivity. It contributes labour readiness and future labour demand but does not become a payroll system in Stage 1.

## 15. Inspections and Evidence

Inspection items own real media evidence, not counters. Required evidence captures file, timestamp, location, actor and optional annotation.

Rejection creates explicit corrective work and linked reinspection records with assignee, due date, predecessor, required evidence and status. Closing inspection approval transitions the linked Activity to `done`; rejection retains an incomplete/awaiting-signoff state.

## 16. Commercial Control

Workflow:

```text
BudgetLine
  -> Commitment from PO/work order
  -> accepted receipt or measured work
  -> VendorBill
  -> three-way verification
  -> PMC certification
  -> payment approval
  -> payment recorded/synchronized
```

Three-way verification compares ordered quantity/rate, accepted delivery or measured work, and billed quantity/rate. Exceptions require responsible review.

Bill statuses:

```text
draft
submitted
under-verification
disputed
verified
certified
approved-for-payment
part-paid
paid
rejected
```

The module tracks advance recovery, retention, deductions, variations and tax metadata. Cash projections distinguish budget, committed, received-not-billed, awaiting certification, certified payable, approved and paid.

## 17. Automation and Human Authority

Automate propagation, calculations, draft generation, matching, forecasting, reminders and escalation. Keep human approval for contractual or judgment-bearing actions.

Automatic examples:

- Decision approval updates requirements and readiness.
- Activity date changes recalculate needed-by dates and procurement risk.
- Delivery delay updates material readiness and schedule forecast.
- Accepted receipt creates stock and satisfies reservations.
- Material issue reduces stock and prefills the Daily Log.
- Crew commitment and attendance update labour readiness.
- Inspection approval satisfies readiness or closes work.
- Vendor bill submission runs PO/receipt/measurement matching.
- Certified bills update cash forecasts.

Human decisions remain for client approval, technical/sample approval, vendor selection, physical receipt and rejection, work measurement, wastage/adjustment, bill certification, payment approval and overrides.

## 18. Authorization

Authorization combines organization authority, project membership, represented Company, module capability, record scope, workflow state and approval limit.

Default role templates include PMC administrator, project manager, architect, site engineer, storekeeper, procurement manager, commercial manager, client, contractor, supplier and finance.

Configurable segregation-of-duty rules may prevent one person from requesting, receiving and certifying the same transaction. Exceptions require stronger authority and an audit record.

Every server route enforces authorization. UI visibility is convenience, never enforcement.

## 19. Frontend and API Evolution

- Replace the single project store with module-owned query/state boundaries.
- Replace the full snapshot with project-shell summaries and paginated module queries.
- Keep project identity and shell state atomic during sign-in and project switching.
- Generate navigation from enabled module manifests and effective permissions.
- Use optimistic UI only for retry-safe commands with idempotency keys.
- Show explicit loading, empty, offline, stale and error states; never substitute demo records in API mode.
- Keep Inbox, Dashboard and Portfolio as projections fed by module events.

## 20. Reliability and Security

Every state-changing command requires a client-generated idempotency key, project/actor scope, optimistic version, explicit transition, audit entry and transactional event.

Required controls:

- live membership/project-status enforcement or short-lived access tokens with refresh/revocation;
- project- and user-partitioned offline file caches purged on sign-out/access loss;
- authenticated realtime rooms;
- shared OTP/rate-limit state using Redis and cryptographic OTP generation;
- invitation/enrollment capability before provisioning project membership;
- private object storage with short-lived authorized delivery;
- same-project relational constraints for every cross-reference;
- secrets and production instructions excluded from agent-authoritative documents;
- observable event retries, dead letters, projection lag and failed integrations.

## 21. Verification

Each module requires domain tests, permission-matrix tests, PostgreSQL integration tests, event contract tests, projection rebuild tests, cross-project/company isolation tests, migration tests and browser workflow tests.

CI must start PostgreSQL, apply migrations from zero, boot the API and run API-backed browser flows.

The principal Stage 1 vertical test is:

```text
Activity requirement
  -> comparison and PO
  -> accepted receipt
  -> stock reservation
  -> material readiness becomes green
  -> material issue
  -> Daily Log actual
  -> bill match and certification
```

The existing decision-change, inspection-reinspection, closing-signoff, project-switch and multi-tenant authorization paths require characterization tests before refactoring.

## 22. Scaling Path

Pilot infrastructure:

- stateless NestJS API;
- managed PostgreSQL with backups and connection pooling;
- Redis for queues, OTP, limits and coordination;
- S3/R2 object storage;
- separate background worker;
- central logs, metrics, traces and error reporting.

External adoption adds multiple API instances, independently scaled workers, tenant-aware caching, paginated APIs, measured indexes, CDN delivery, quotas, retention/export policies and operational dashboards.

Extract services only on measured need. Likely first candidates are media processing, report generation, notifications and integration synchronization. Core transactional modules remain together until load or team ownership justifies separation.

## 23. Stage 2 RedBracket Boundary

Stage 1 must expose stable versioned APIs/events and `ExternalSystemLink` records containing provider, external tenant/entity IDs, sync direction, last version, status and error metadata.

Potential future integration areas are organization/company identity, user SSO, projects, clients, contacts, document references and published reports. The exact mapping requires a separate audit of RedBracket's authenticated product/API; the public URLs currently expose no usable product model.

Stage 2 rules:

- no shared database;
- no copied credentials;
- no direct internal-table access;
- explicit ownership per synchronized fact;
- idempotent import/export with reconciliation;
- versioned contracts and audit history;
- conflict policy defined per entity before synchronization.

## 24. Delivery Sequence

### Phase 0 - Safety baseline

Fix authenticated project identity, complete project-state replacement, project-scoped references, real dates, API/PostgreSQL integration CI and removal of demo fallbacks in API mode.

### Phase 1 - Complete existing product pillars

Finish decision change/reapproval, inspection evidence/reinspection, closing inspection completion, event-derived readiness and controlled drawing distribution.

### Phase 2 - Platform modularization

Introduce the shared kernel, module registry, command/query contracts, audit/event envelope, transactional outbox, workers, projection framework and module-owned frontend state. Extract existing modules incrementally without changing their working user flows unnecessarily.

### Phase 3 - Material Readiness pilot

Deliver requirements, requisitions, vendor comparison, purchase orders, delivery commitments, receipts, site stock, reservations, issues and automatic material readiness for one pilot project.

### Phase 4 - Labour Readiness

Connect crew demand, commitments, allocations, attendance and productivity to Activity readiness and Daily Logs.

### Phase 5 - Commercial Control

Add budget, commitments, measurement, vendor bills, verification, certification, payment approval and cash forecast.

### Phase 6 - External collaboration

Add supplier/contractor portals and promotion of guest Companies to their own Organizations.

### Phase 7 - Accounting and RedBracket integrations

Implement reviewed adapters after each external contract and ownership model is separately approved.

## 25. Pilot Acceptance Criteria

The pilot is successful when:

- one site operates without a separate material spreadsheet;
- every upcoming pilot Activity has dated resource requirements and accountable owners;
- every accepted receipt changes traceable stock through ledger transactions;
- every material issue traces to an Activity and location;
- readiness changes automatically from evidence;
- supply/labour shortages produce forecast impact and Inbox actions;
- inspection rejection produces assignable corrective work and reinspection;
- completion requires closing sign-off;
- project dashboards contain no manually entered operational counts;
- weekly coordination and report drafts are generated from the same records;
- cross-project and cross-company access tests pass;
- every commercial amount traces from requirement through payment status.

## 26. Claude Code Execution Protocol

Claude Code must not implement this specification as one PR.

For each phase:

1. Read this specification, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/TENANCY.md`, `docs/TEMPLATES.md`, `docs/ROADMAP.md` and relevant current code/tests.
2. Write a short vision-alignment statement naming the real user problem, canonical fact owner, downstream information flow, human action removed and trust invariant protected.
3. Revalidate every cited current-state problem against current `main`; report drift before planning.
4. Produce a phase plan with business outcome, invariants, schema changes, migrations, APIs/events, UI changes, tests, rollback and explicit out-of-scope items.
5. Split the phase into small vertical PRs. Prefer one invariant or end-to-end capability per PR.
6. Add characterization tests before modifying existing behavior.
7. Use additive migrations first; backfill and enforce constraints only after verification.
8. Never mix unrelated cleanup with a phase PR.
9. Update this spec or create an ADR when implementation changes an approved decision.
10. Do not mark a phase complete until PostgreSQL integration, permission, tenant-isolation and browser tests pass.
11. Preserve a review packet for independent verification.

Required first deliverable: a Phase 0 implementation plan only. No feature implementation begins until that plan is reviewed.

## 27. Independent Review Packet

After each PR or phase, Claude Code must provide:

```text
repository and branch
base commit and reviewed commit
PR URL
phase and acceptance criteria addressed
files changed, grouped by module
schema and migration summary
new/changed API and event contracts
authorization changes
tests added and exact commands/results
manual browser scenarios and evidence
known limitations and deferred work
data migration/rollback procedure
security/privacy impact
performance impact
architecture/ADR updates
```

Codex should then independently:

1. Fetch the exact reviewed commit from `JagPat/PMCvitan`.
2. Compare the diff with this specification and the PR's declared scope.
3. Re-run typecheck, lint, unit, PostgreSQL integration and API-backed browser tests.
4. Inspect migrations against fresh and representative upgraded databases.
5. Verify project/company isolation, permissions, idempotency, retries and audit events.
6. Exercise the complete vertical workflow affected by the PR.
7. Check projection rebuilds and failure recovery.
8. Report findings first by severity with exact file/line evidence.
9. Explicitly list acceptance criteria verified, not verified or contradicted.
10. Approve only when no required work remains; otherwise return a bounded correction list to Claude Code.

The preferred handoff to Codex is the PR URL plus the completed review packet. Chat summaries alone are not an adequate source of truth.
