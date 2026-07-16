# Phase 2 Tasks 6-7 Fix-Forward Remediation Design

**Status:** Approved design direction; implementation is blocked until this written specification is reviewed.

**Baseline:** `JagPat/PMCvitan` `main` at `cf038be810790a351fa1d4d9a7e29e56b427472e`.

**Reviewed work:** Task 6 PR #158 (`3e30874`, merged `720e7d8`) and Task 7 PR #159 (`3b84b64`, merged `cf038be`).

## 1. Purpose

Preserve the Phase 2 event store, command ledger, outbox, module manifests, workflow participants, database FK actions, and all production data while correcting the Task 6 and Task 7 review findings at their architectural roots.

This is a **forward remediation**. It does not revert Tasks 6 or 7, rewrite published history, delete committed events, discard deliveries, or reset production data.

In this document, **transaction rollback** has one precise meaning: when a requested operation fails before commit, PostgreSQL must leave none of that operation's writes visible. It does not mean rolling back a deployment, migration, feature, or existing record.

## 2. Trust Invariants

After this remediation:

1. A project and its requested starting structure either commit completely or do not exist.
2. A canonical Notification row commits with the command that caused it or neither commits.
3. Every persisted DomainEvent creates a durable obligation for every active outbox consumer.
4. Every ordered consumer accounts for every project stream position, including positions irrelevant to its business projection.
5. Registering a consumer after events already exist cannot lose those historical events, including during a rolling deployment or process crash.
6. An OutboxDelivery cannot claim project or stream coordinates different from its DomainEvent.
7. Switching external effects to the outbox cannot silently remove or invent socket/push behavior.
8. A dead delivery or blocked cursor is visible and safely retryable; resolution never skips a canonical event silently.
9. Every Prisma model has one declared owner, every compiled route contribution is unambiguous, and runtime persistence writes cannot evade the boundary check merely by moving to another file type.

## 3. Constraints and Non-Goals

- PostgreSQL 16 remains the supported database target. The Task 7 column-list `ON DELETE SET NULL (<column>)` constraints remain unchanged.
- DomainEvent remains append-only. Dispatch progress must not require updating event rows.
- Existing event IDs, stream positions, command receipts, notifications, deliveries, and project data remain intact.
- Migrations are additive or constraint-strengthening and diagnostic-first. They abort on contradictory data rather than guessing.
- The relay remains in-process and lease-based. The design must continue to support multiple API instances and later extraction into a worker without a rewrite.
- Redis remains optional and is not introduced by this remediation.
- Project initialization is low-frequency; correctness is preferred over minimizing the duration of its transaction.
- Projection implementation, frontend module-query migration, and backend module extraction remain Tasks 8-10 and are not pulled into this work.
- No per-tenant module installation model is introduced. `enabledModules` remains all compiled registered modules.

## 4. Delivery Shape: Three Correction PRs, One Review Gate

The remediation is split into three independently testable PRs. Task 8 remains blocked until all three are merged and one consolidated independent review clears the combined result.

### PR A: Atomic Command and Project Initialization

Owns findings concerning canonical transaction boundaries and malformed project structure.

### PR B: Gap-Safe Durable Outbox Foundation

Owns consumer catalog durability, ordered no-op delivery, full-envelope expansion, coordinate integrity, and dead-letter operations.

### PR C: External-Effect Cutover and Boundary Enforcement

Owns complete socket/push intent migration, cutover proof, outbox-mode acceptance, and stronger module boundary CI.

The PR split is for reviewability, not partial acceptance. The gate verdict is issued only after PR C, against all three effective runtime merges.

## 5. PR A Design: Atomic Commands and Project Initialization

### 5.1 Published Decision Notification

`decisions.create` with `publish=true` must write these facts inside the same `executeCommand(...run(tx))` transaction:

- Decision and DecisionOption rows;
- DecisionEvent;
- AuditLog;
- canonical Notification;
- DomainEvent and its current-catalog OutboxDelivery rows;
- successful CommandExecution receipt when an idempotency key is supplied.

Only post-commit legacy socket/push dispatch remains outside the transaction during rollout. A Notification insertion failure therefore aborts the Decision, event, deliveries, audit, and receipt together.

The notification text is computed once and passed to both the Notification row and the event's external-effect intent. The two representations cannot drift.

### 5.2 Project Initialization Unit of Work

`OrgsService.createProject` becomes one serializable interactive transaction covering:

- the Project row;
- creator Membership;
- trigger-created ProjectEventStream;
- `project.created` DomainEvent and deliveries;
- copied location nodes, phases, activities, and checklist definitions;
- selected module and template instantiation;
- every NodeInitParticipant, ActivityParticipant, and InspectionParticipant write.

The initialization helpers accept a `Prisma.TransactionClient`. They do not call `this.prisma`, open nested transactions, or perform writes after the outer transaction commits.

The transaction uses at most three total attempts. It retries Prisma `P2034` serialization conflicts and one narrowly identified concurrency outcome: a real Prisma `P2002` on the single-column `Activity.id` or `Inspection.id` primary key after the entire initialization transaction has rolled back. The latter handles the stale-snapshot case described below; no other `P2002`, plain error object, database error, or participant error is retried. Backoff is bounded to 25 ms then 75 ms plus 0-25 ms jitter. The project ID and normalized request are allocated once before the first attempt and remain stable across retries.

Before allocating the legacy global `ACT-###` and `INSP-###` display IDs, the transaction takes fixed-order transaction advisory locks for those two namespaces and performs the ID scans through the same transaction client. PostgreSQL can retain the serializable snapshot established before a blocking advisory-lock statement finishes waiting; if that stale snapshot selects an ID committed by the prior lock holder, the primary key rejects the write, the whole attempt rolls back, and only that exact primary-key conflict restarts with a fresh snapshot. This preserves uniqueness without pulling the deferred internal-PK/data-model work into this remediation.

Initializer participants are database-only during this transaction. Email, push, socket, file upload, and other external I/O are forbidden inside participant implementations; post-commit effects must be represented by the event outbox instead.

### 5.3 Structure Validation

All selected templates, modules, and source-project structure are read and authoritatively revalidated within the initialization transaction. Before the first Project write, the server validates a normalized initialization graph:

- node keys are unique within each module copy;
- every non-null parent key resolves within that copy;
- no node is its own parent;
- the parent graph is acyclic and every node is reachable from a root;
- hierarchy is `zone -> room -> element`; invalid kind parentage is rejected;
- every activity and inspection `nodeKey` resolves;
- every activity `phaseName` resolves when supplied;
- duplicate phase names within one module are rejected; ID-distinct phases from a source project remain distinct and source activities retain their exact phase attachment; module phases coalesce with another module or source phase only when normalized name and schedule definition match exactly, otherwise the conflict is rejected rather than first/last-write-wins;
- requested module/template rows belong to the organization and remain unarchived;
- `structureFrom` belongs to the organization and remains unarchived.

The existing `break` behavior for unresolved parentage is removed. Any unresolved remainder throws a `BadRequestException` naming the module and invalid key. No node, project, membership, event, activity, phase, or inspection commits.

### 5.4 PR A Proof

Live-PostgreSQL tests must first fail at `cf038be`, then pass:

1. Inject a failure after at least one initializer participant write; assert zero Project, Membership, ProjectEventStream, DomainEvent, OutboxDelivery, node, phase, activity, and inspection rows for the attempted project.
2. Inject a Notification failure into one-step decision publish; assert zero Decision, DecisionOption, DecisionEvent, Notification, AuditLog, DomainEvent, OutboxDelivery, and CommandExecution rows for the command.
3. Submit orphan, cycle, duplicate-key, invalid-kind, missing-nodeKey, and missing-phaseName module payloads; each returns 400 and creates no project.
4. Run successful copy-plus-template-plus-explicit-modules initialization and assert the complete union commits once.
5. Run two concurrent equivalent project creates and prove no mixed or half-initialized structure survives.

## 6. PR B Design: Gap-Safe Durable Outbox

### 6.1 Persistent Consumer Catalog

Add `OutboxConsumerCatalog` as the durable source of consumer obligations:

```text
OutboxConsumerCatalog
  consumer        text primary key
  consumerKind    'ordered' | 'unordered'
  consumerEffect  'db' | 'external'
  catalogVersion  integer not null
  active          boolean not null default true
  registeredAt    timestamptz not null
  updatedAt       timestamptz not null
```

At bootstrap, each compiled consumer upserts its catalog row before the relay starts. A changed kind/effect is a startup error requiring an explicit migration; bootstrap never silently changes ordering semantics.

`catalogVersion` is the consumer contract version, not an application release number. Bootstrap requires the persisted and compiled versions to match exactly. Changing a consumer's kind, effect, or contract version requires an explicit forward migration so mixed-version instances fail visibly instead of interpreting the same row differently. Database checks admit only the supported pairs `ordered/db` and `unordered/external`; a delivery's `(consumer, consumerKind)` has a restrictive composite FK to the same fields on the catalog row. The first migration seeds the two existing consumers (`socket.invalidation`, `webpush.notify`) before adding that FK.

The durable obligation is the relational pair:

```text
active OutboxConsumerCatalog row x DomainEvent row
```

For every such pair, exactly one OutboxDelivery must exist. This avoids mutating append-only DomainEvent rows while still making missing expansion discoverable after a crash.

### 6.2 One Delivery Per Event and Consumer

`OutboxConsumer.deliveryFor()` no longer returns `null`. It returns a plan:

```ts
type DeliveryPlan =
  | { action: 'dispatch'; payload?: Prisma.InputJsonValue }
  | { action: 'noop' };
```

Persist that result in a required `OutboxDelivery.deliveryAction` column with the closed values `dispatch | noop`; no alternative or inferred representation is permitted.

Every registered consumer receives a delivery row for every event:

- `dispatch` rows invoke the consumer;
- `noop` rows record that the event was deliberately irrelevant;
- ordered no-op rows are created `pending`, then atomically create ProcessedEvent and advance ProjectionCursor;
- unordered no-op rows are created already `succeeded`, with their deliberate suppression recorded in the row.

An ordered consumer can therefore never wait behind a stream position for which no row exists.

### 6.3 Persisted Dispatch Intent

Add an additive `DomainEvent.dispatchIntent Json?` column populated at event creation:

```ts
interface DispatchIntent {
  effectKey: string;
  coverageVersion: string;
  invalidate: boolean;
  push?: { body: string; roles?: string[] };
}
```

This is immutable event metadata, not a projection result. It records what external consequences the command requested at commit time. Existing events receive `NULL`, meaning pre-intent legacy history; the migration does not invent historical pushes.

Database projection consumers derive relevance from the full persisted event envelope. External consumers derive socket/push plans from `dispatchIntent`. A scanner can therefore reproduce current and future delivery plans without transient in-memory command arguments.

For the bounded legacy exception, an external delivery whose event has `dispatchIntent=NULL` is always handled as no-op even if its pre-migration row initially says `dispatch`. The relay records it as `noop/succeeded`; it never replays a historical push from an old payload. The explicit cutover seal in PR C normalizes every remaining legacy row in one operation.

### 6.4 Expansion Scanner

The relay gains a lease-safe expansion pass that:

1. reads every active catalog consumer;
2. queries DomainEvents with no delivery for that consumer in bounded stream-position batches;
3. constructs complete `EmittedEventMeta`, including event type, organization, entity, payload, and dispatch intent;
4. creates dispatch/no-op deliveries with `createMany(...skipDuplicates)`;
5. repeats on the normal relay interval, not only at startup.

This closes all timing windows:

- an event committed by an old instance during rolling deployment;
- a new consumer registered after historical events;
- a crash after catalog registration but before expansion;
- concurrent scanners on multiple instances.

The existing one-time `backfillPreCutover` becomes the same scanner entry point rather than a separate partial-envelope implementation.

The scanner does not trust a mutable high-water mark for correctness: every batch selects the earliest missing catalog/event pairs with `NOT EXISTS`, using covering indexes and a fixed batch limit. A crash repeats safe work, and an incorrectly advanced cursor cannot hide a missing delivery. Consumer deactivation stops creating new obligations but does not delete or rewrite existing deliveries.

### 6.5 Delivery Coordinate Integrity

Add a unique candidate key on DomainEvent `(eventId, projectId, streamPosition)` and replace the delivery's event-only FK with a composite FK:

```text
OutboxDelivery(eventId, projectId, streamPosition)
  -> DomainEvent(eventId, projectId, streamPosition)
```

The migration first aborts if any existing delivery coordinates disagree with its event. It then adds the candidate key and composite FK. No coordinate is corrected automatically.

Relay code uses canonical event coordinates after the join; copied delivery coordinates exist only for indexed claiming and are database-proven identical.

### 6.6 Dead-Letter Operations

Add `OutboxOperationsService`, a durable `OutboxOperatorAction` audit row, and production-safe operator commands:

```text
pnpm --filter api outbox:status
pnpm --filter api outbox:retry --delivery <uuid> --operator <identity> --reason <text>
```

`outbox:status` reports aggregate pending, leased, dead, blocked, oldest-pending age, consumer, project, position, attempts, and last error. It does not print push subscription secrets or event payloads by default.

`outbox:retry` runs in one transaction and locks the delivery. It accepts only `dead`; verifies the event coordinates, active catalog row, and registered consumer; then resets it to `pending` with attempts zero, clears lease/error fields, and sets `nextAttemptAt=now()`. For an ordered consumer, it changes a blocked cursor back to live only when that delivery occupies the cursor's exact next expected position; any other position is a conflict requiring investigation. It never advances or skips the cursor. The same transaction inserts `OutboxOperatorAction` with the delivery, consumer, project, event, operator identity, reason, prior error, and timestamp. Structured logs repeat that audit identifier without exposing event payloads.

The relay emits a structured warning when a delivery becomes dead or a cursor becomes blocked. `/health` exposes aggregate `outboxDead`, `outboxBlocked`, and `outboxOldestPendingSeconds` without event contents. These fields are diagnostic and keep HTTP 200 so the liveness probe does not create a restart loop; alerting treats nonzero dead/blocked values as degraded readiness.

### 6.7 PR B Proof

Live-PostgreSQL tests must prove:

1. ordered consumer skips position 0 and handles position 1 as a no-op/dispatch pair without waiting;
2. adjacent dispatches raced by two relay instances advance contiguously;
3. a new filtered consumer registered after events receives historical dispatch and no-op rows;
4. a crash after catalog upsert but before expansion is repaired on the next scanner pass;
5. an old instance emitting during new-consumer deployment is repaired by the scanner;
6. forged project/stream coordinates are rejected by PostgreSQL;
7. a dead exact-next delivery blocks visibly, operator retry reapplies it, and the cursor resumes without skipping;
8. concurrent scanners create one delivery per event/consumer.

## 7. PR C Design: Complete External Cutover and Boundary Enforcement

### 7.1 Explicit External Effects at Every Event Site

Create one machine-readable `external-effects` catalog keyed by the Task 1 command inventory's exact mutation branches. Each entry declares its event type, whether it invalidates the project snapshot, and whether it can push to named roles. A canonical SHA-256 of the sorted catalog is the compiled coverage version.

`emitEvent` requires both an `effectKey` from that catalog and a `dispatch` argument. Neither has a default:

```ts
effectKey: ExternalEffectKey;
dispatch: {
  invalidate: boolean;
  push?: { body: string; roles?: string[] };
}
```

`emitEvent` rejects a dispatch shape that contradicts its catalog entry and persists `effectKey`, the compiled coverage version, and the dispatch data in `DomainEvent.dispatchIntent`. The consequence tests consume the same catalog, so adding or removing a command branch changes the version and fails coverage until its behavior is declared and tested.

Every mutation is migrated against the Task 1 consequence matrix:

- private decision and drawing drafts use `invalidate:false` and no push;
- ordinary shared mutations use `invalidate:true`;
- every legacy push-producing activity, inspection, drawing, decision, and material-mismatch command carries its exact body and roles;
- replay/no-op branches emit no new event and therefore no new intent;
- Notification DB-row behavior remains independent and transactional.

Socket delivery is no longer unconditional for every event. The socket consumer dispatches only when `invalidate=true`; otherwise it receives a deliberate no-op delivery.

`executeCommand` returns the ordered list of committed event metadata on a fresh execution as an internal-only value; replay outcomes contain none. Non-ledger mutations use the same post-commit result shape. A single `ExternalEffectDispatcher` receives those events after commit. Services no longer call `RealtimeGateway` or `PushService` directly, which gives legacy/shadow/outbox one correlated control point without changing API response DTOs.

The dispatcher and background relay use the same atomic delivery-lease operation and the same success/backoff/dead transitions. In `legacy` and `shadow`, the dispatcher tries to lease and send the new event's external rows immediately after commit; the background relay is only recovery if the immediate attempt loses the race, crashes, or fails. In `outbox`, only the background relay attempts them. A sender never calls the socket or push provider unless it owns the delivery lease. External failure is recorded on the durable delivery and does not turn an already committed API command into a false failure response.

### 7.2 Cutover Safety

Retain `OUTBOX_SENDER_MODE=legacy|shadow|outbox`, but make cutover fail closed:

- CI has an exact command/effect matrix covering every mutation branch;
- startup refuses `OUTBOX_SENDER_MODE=outbox` unless the compiled external-effect coverage version equals a persisted cutover seal;
- shadow mode uses the immediate leased send, records the correlated event ID plus requested socket/push intent, and compares it to the persisted delivery plans without sending twice;
- outbox mode silences legacy socket/push and sends only through deliveries;
- an emergency fallback to legacy mode changes only the sender flag and does not revert code, data, or migrations.

The persisted seal is a singleton `OutboxCutoverState` row written by:

```text
pnpm --filter api outbox:seal-external --operator <identity> --reason <text>
```

The seal command is run only after every old instance has drained. In one transaction it takes a `SHARE ROW EXCLUSIVE` lock on `DomainEvent`, row-locks all affected external deliveries, aborts if any is still `leased`, verifies the catalog/scanner has no unexplained gaps or dead/blocked rows, changes every legacy external delivery (null intent or a coverage version other than the compiled current version) to recorded `noop/succeeded` without deleting its payload or row, and records the compiled coverage version plus operator/reason. Concurrent claims skip the locked rows; a claim that won before the seal makes the seal abort and retry after that lease settles. A database trigger then rejects any future `DomainEvent` whose `dispatchIntent` is null while the seal exists. The table lock waits for in-flight legacy inserts and prevents a late old instance from slipping an intent-less event across the boundary. New-code events remain valid because they always carry current intent.

Resealing for a later coverage version uses the same command while the deployment is in `legacy` or `shadow`; outbox-mode startup remains blocked until the new seal matches. This makes an emergency sender fallback a configuration change while keeping forward cutover explicit and auditable.

The API-backed Playwright job is run once in legacy mode and once in outbox mode. The outbox run enables the relay and uses condition-based waits for invalidation; it does not use fixed sleeps.

### 7.3 Boundary Enforcement

Strengthen the module registry checks without changing the approved module ownership model:

1. Parse `schema.prisma` and assert the exact camel-case Prisma delegate set equals the union of every manifest's `ownsModels`. Undeclared and multiply declared models fail CI.
2. Derive fully qualified routes from Nest controller metadata (`METHOD /controller/path`) using the controller classes registered in the application modules, and compare them with manifest routes. Duplicate or missing route contributions fail CI.
3. Replace the service/participant filename filter with a TypeScript compiler-API scan over every runtime `.ts` file under `apps/api/src`, excluding only `*.test.ts`, `*.spec.ts`, and generated output.
4. Follow compiler symbols for `PrismaService`, `PrismaClient`, and `Prisma.TransactionClient` receivers so delegate writes are detected through constructor fields, parameters, local aliases, and destructuring, regardless of whether they occur in a service, participant, controller, job, bootstrap, or helper.
5. Treat raw SQL containing `INSERT`, `UPDATE`, `DELETE`, `MERGE`, DDL, or writable CTEs as persistence and require an explicit bounded waiver or platform migration location.
6. Reject dynamic bracket access to Prisma delegates in domain runtime code because ownership cannot be statically established.
7. Preserve the existing auth-to-identity bounded waiver and continue to fail the Phase 2 final gate until Task 10 removes it.

Runtime raw-SQL waivers live in one typed list and name an exact file, enclosing class/function symbol, platform owner, and reason. Wildcards are forbidden, every waiver must match exactly one detected site, and unused waivers fail CI. Prisma migration SQL is the only path-based exclusion.

The check verifies declarations and actual compiled behavior. Moving a foreign write to another filename cannot make it pass.

### 7.4 PR C Proof

Tests must prove:

1. every push-producing row in the consequence matrix creates the exact outbox payload under `outbox` mode;
2. private drafts, replay branches, and no-op commands create no socket or push send;
3. legacy, shadow, and outbox modes produce at most one concurrent provider call per delivery, proven by competing the immediate dispatcher and background relay for the same lease;
4. a pre-intent delivery is preserved but neutralized by the seal, an in-flight legacy insert completes before the seal, and any later intent-less insert is rejected by PostgreSQL;
5. outbox startup refuses an absent or stale coverage seal;
6. API-backed browser acceptance passes in both legacy and outbox modes;
7. adding an undeclared Prisma model, duplicate full route, controller write, helper write, aliased transaction write, raw-SQL write, or dynamic delegate access makes boundary CI fail;
8. current manifests and the one bounded Task 10 auth waiver pass.

## 8. Migration and Production Safety

The remediation uses forward migrations only:

1. add `DomainEvent.dispatchIntent` nullable;
2. add `OutboxConsumerCatalog`, seed the two existing consumer contracts, and add the restrictive delivery-to-catalog FK;
3. add required `OutboxDelivery.deliveryAction` with a `dispatch | noop` CHECK, initially defaulting existing rows to `dispatch`;
4. add `OutboxOperatorAction` and singleton `OutboxCutoverState`;
5. run diagnostics for delivery/event coordinate mismatches;
6. add DomainEvent candidate key and composite OutboxDelivery FK;
7. add the seal-aware trigger that requires non-null dispatch intent only after cutover is sealed.

The migration does not backfill historical push intent. Existing DomainEvents with null dispatch intent receive no-op external plans when scanned, because inventing a historical notification would be false. Events produced during the staged PR B compatibility window carry an explicit non-current coverage version so the scanner can reconstruct the behavior PR B knows without pretending cutover is complete. Existing current-consumer OutboxDelivery rows retain their status and payload until the explicit seal transaction records every null/non-current external action as no-op/succeeded; no row or payload is deleted.

Before production deployment:

- confirm PostgreSQL server version is 16.x;
- take and verify a durable backup outside the application/database container;
- run coordinate mismatch diagnostics;
- deploy initially with `OUTBOX_SENDER_MODE=legacy`;
- observe catalog expansion and zero dead/blocked rows;
- run shadow comparison until every exercised consequence-matrix branch matches;
- drain all old application instances and run `outbox:seal-external`;
- switch to `outbox` only after the consolidated gate clears.

## 9. Verification Battery

Every PR runs its focused red-to-green tests and the full existing gates:

```text
pnpm check
pnpm --filter api test:integration
pnpm --filter web test:e2e
pnpm test:e2e:api                # legacy
OUTBOX_SENDER_MODE=outbox pnpm test:e2e:api
bash apps/api/scripts/upgrade-proof.sh
```

The final evidence packet records:

- base, head, and merge SHA for all three PRs;
- migration checksums and preflight diagnostics;
- each adversarial probe red at `cf038be` and green at the effective head;
- legacy and outbox acceptance results;
- a finding-to-fix-to-proof table;
- residual risks, including at-least-once external delivery duplication after provider send/before acknowledgement.

## 10. Stop Conditions and Completion

Implementation stops immediately if any of these occurs:

- project initialization still performs a write outside the shared transaction;
- malformed structure can be skipped or nulled silently;
- a canonical Notification is written after its causing command commits;
- an ordered consumer can lack a delivery for a project stream position;
- registering a consumer can leave a permanent event/delivery gap;
- PostgreSQL accepts mismatched delivery coordinates;
- outbox mode loses or invents an external consequence relative to the approved matrix;
- a dead delivery has no visible, non-skipping recovery path;
- a runtime persistence write can evade module ownership checks by file placement;
- either acceptance mode fails.

The remediation is complete only when all three PRs are merged, the evidence packet is current, and one consolidated independent review clears Tasks 6 and 7. Task 8 then resumes from the corrected platform foundation.
