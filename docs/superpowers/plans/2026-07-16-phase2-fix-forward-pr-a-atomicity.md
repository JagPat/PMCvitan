# Phase 2 Fix-Forward PR A: Atomicity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make published-decision notification and complete project initialization commit as indivisible PostgreSQL units without reverting Tasks 6 or 7.

**Architecture:** Keep the existing command ledger, event kernel, module participants, and data model. Move one-step decision notification into the existing command transaction, then normalize and validate all requested project structure before the first project write and instantiate it through one serializable transaction using transaction-bound participants.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 16, TypeScript, Vitest 4.

## Global Constraints

- Forward remediation only: do not revert Tasks 6 or 7, rewrite history, delete production data, or discard events/deliveries.
- PostgreSQL 16 is the supported database target.
- DomainEvent remains append-only.
- Project initialization retries Prisma `P2034` plus only a genuine single-column `Activity.id`/`Inspection.id` Prisma `P2002` caused by the serializable advisory-lock stale-snapshot race. It makes at most three total attempts, with 25 ms then 75 ms backoff plus 0-25 ms jitter; every other error fails immediately.
- All project-init writes use one `Prisma.TransactionClient`; participant code performs database I/O only.
- Existing user-visible project, decision, template, and module behavior remains unchanged except malformed input now returns 400 atomically.
- Use TDD: each production behavior change starts with a focused failing test and records the expected red failure.

---

### Task 1: Pin Published-Decision Notification Atomicity

**Files:**
- Modify: `apps/api/src/decisions/decisions.service.test.ts`
- Modify: `apps/api/test/integration/phase2-consequences.test.ts`
- Test: `apps/api/test/integration/command-ledger.test.ts`

**Interfaces:**
- Consumes: `executeCommand(prisma, { run(tx) })`, `pendingDecisionNotice(title)`, `emitEvent(tx, input)`.
- Produces: failing proof that `publish:true` cannot leave Decision/Event/receipt rows when Notification insertion fails.

- [ ] **Step 1: Add a unit assertion for the transaction boundary**

Add a transaction-aware mock that records whether `notification.create` runs while the `executeCommand` callback is active. Assert `create(...publish:true...)` records exactly one Notification inside the callback and that draft creation records none.

- [ ] **Step 2: Add the live-PostgreSQL failure probe**

In `phase2-consequences.test.ts`, install a disposable trigger that raises `decision notification fault` only for a unique marker in `Notification.text`. Submit `decisions.create` with `publish:true` and an `Idempotency-Key`, assert the request fails, then assert unchanged counts for Decision, DecisionOption, DecisionEvent, Notification, AuditLog, DomainEvent, OutboxDelivery, and CommandExecution. Drop the trigger in `finally`.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter api test -- src/decisions/decisions.service.test.ts
pnpm --filter api test:integration -- test/integration/phase2-consequences.test.ts
```

Expected: the unit test shows `notification.create` happens after the transaction; the PostgreSQL probe shows canonical rows survive the injected notification failure.

### Task 2: Move the Notification into the Command Transaction

**Files:**
- Modify: `apps/api/src/decisions/decisions.service.ts`
- Modify: `apps/api/src/domain/notifications.ts`
- Test: `apps/api/src/decisions/decisions.service.test.ts`
- Test: `apps/api/test/integration/phase2-consequences.test.ts`

**Interfaces:**
- Consumes: Task 1 failing tests.
- Produces: `publish:true` command transaction containing Decision, options, lifecycle event, audit, Notification, DomainEvent/deliveries, and receipt.

- [ ] **Step 1: Compute one canonical notice**

At the start of `DecisionsService.create`, compute `const notice = pendingDecisionNotice(input.title)`. Inside `run(tx)`, write `tx.notification.create(...)` only when `input.publish`, and pass the same `notice` to the event notification intent.

- [ ] **Step 2: Remove the post-commit Notification write**

Keep the fresh-only legacy external signal after commit, but delete the top-level `this.prisma.notification.create(...)`. Replay remains silent.

- [ ] **Step 3: Align draft publish text**

Use `pendingDecisionNotice(d.title)` for both the Notification row and event notification intent in `publish()` so the two representations cannot drift.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```bash
pnpm --filter api test -- src/decisions/decisions.service.test.ts
pnpm --filter api test:integration -- test/integration/phase2-consequences.test.ts test/integration/command-ledger.test.ts
```

Expected: all selected tests pass and the injected failure leaves no command rows.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/decisions apps/api/src/domain/notifications.ts apps/api/test/integration/phase2-consequences.test.ts
git commit -m "fix(api): make decision publication notification atomic"
```

### Task 3: Add Pure Project-Initialization Validation and Retry Helpers

**Files:**
- Create: `apps/api/src/orgs/project-initialization.ts`
- Create: `apps/api/src/orgs/project-initialization.test.ts`
- Modify: `apps/api/src/orgs/orgs.service.ts`

**Interfaces:**
- Produces:
  - `validateInitializationGraph(label, graph): void`
  - `lockInitializationDisplayIds(tx): Promise<void>`
  - `runSerializableProjectInit(prisma, run, sleep?, random?): Promise<T>`
- `graph` contains normalized nodes, phases, activities, and inspections with source labels and stable input ordering.

- [ ] **Step 1: Write pure validator tests**

Cover valid `zone -> room -> element`, duplicate key, orphan parent, self-parent, multi-node cycle, invalid parent kind, missing activity/inspection `nodeKey`, duplicate phase name, missing `phaseName`, and conflicting same-name cross-source phase windows. Assert errors name the source and offending key/name.

- [ ] **Step 2: Run validator tests and confirm RED**

```bash
pnpm --filter api test -- src/orgs/project-initialization.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement graph validation**

Implement deterministic maps plus depth-first color marking. Roots must have no parent, every non-root parent must resolve, and allowed edges are exactly `zone->room` and `room->element`. Identical normalized phase names coalesce only when order/window fields match; conflicting definitions throw `BadRequestException`.

- [ ] **Step 4: Write retry and lock tests**

Assert `runSerializableProjectInit` retries `P2034` twice then succeeds, retries a genuine `Activity.id`/`Inspection.id` primary-key `P2002` only after whole-attempt rollback, stops after attempt three, rejects every unrelated or merely P2002-shaped error, and uses delays in the ranges 25-50 ms then 75-100 ms. Assert `lockInitializationDisplayIds` executes `ACT` then `INSP` transaction advisory locks in fixed order.

- [ ] **Step 5: Implement retry and display-ID locks**

Use `$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })`. Generate project ID before calling this helper. Lock with `pg_advisory_xact_lock(hashtextextended('project-init-display-id:activity',0))` followed by inspection, then scan/allocate IDs through the same transaction. Because a blocking lock statement can retain a pre-wait serializable snapshot, narrowly restart only a real Prisma `P2002` whose model is `Activity`/`Inspection` and whose target is the single `id` primary key; the failed attempt is already fully rolled back and the restart obtains a fresh snapshot.

- [ ] **Step 6: Run helper tests and confirm GREEN**

```bash
pnpm --filter api test -- src/orgs/project-initialization.test.ts
```

Expected: all helper tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/orgs/project-initialization.ts apps/api/src/orgs/project-initialization.test.ts
git commit -m "feat(api): validate project initialization graphs"
```

### Task 4: Collapse Project Creation into One Serializable Transaction

**Files:**
- Modify: `apps/api/src/orgs/orgs.service.ts`
- Modify: `apps/api/src/orgs/orgs.service.test.ts`
- Test: `apps/api/src/orgs/project-initialization.test.ts`

**Interfaces:**
- Consumes: Task 3 helpers and existing `NodeInitParticipant`, `ActivityParticipant`, `InspectionParticipant` methods.
- Produces: one `runSerializableProjectInit` callback that reads, validates, creates, copies, and instantiates through the supplied `tx`.

- [ ] **Step 1: Rewrite unit-test transaction stubs and confirm RED**

Move template/module/source/target/ID reads onto each helper's `tx` mock, assert every participant receives that exact object, and assert `$transaction` is called once with `Serializable`. Add rollback emulation to the project-init fixtures and a participant throw after one node create; assert every created collection returns to its original length.

- [ ] **Step 2: Replace split helpers with transaction-bound helpers**

Change `assertSourceProject`, `assertPlaceable`, `templateSelections`, source loading, module loading, `copyStructure`, and `instantiateModules` to accept `Prisma.TransactionClient`. They must not call `this.prisma` or open `$transaction`.

- [ ] **Step 3: Normalize and validate before creating Project**

Inside each serializable attempt, reload the template, selected modules, source project, source rows, and module payloads. Normalize all copies/selections in stable request order, run `validateInitializationGraph`, acquire display-ID locks, and allocate IDs. Only then create Project and Membership, append `project.created`, and invoke participants.

- [ ] **Step 4: Reject unresolved creation state**

Replace both `break` paths with invariant errors. Never substitute unresolved `nodeKey`, `parentKey`, or `phaseName` with null. Preserve deliberate source merging and draft/published semantics.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
pnpm --filter api test -- src/orgs/orgs.service.test.ts src/orgs/project-initialization.test.ts
```

Expected: all project/template/module tests pass with one transaction per create.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/orgs
git commit -m "fix(api): initialize projects in one transaction"
```

### Task 5: Prove Atomic Project Initialization on PostgreSQL

**Files:**
- Create: `apps/api/test/integration/project-initialization-atomicity.test.ts`
- Modify: `apps/api/test/integration/fixtures.ts` only if cleanup order needs the new test data.

**Interfaces:**
- Consumes: real `OrgsService`, participant implementations, Prisma migrations, and PostgreSQL triggers.
- Produces: adversarial acceptance proof for all PR A invariants.

- [ ] **Step 1: Add after-write failure probe**

Create a module containing at least one valid node and a uniquely titled inspection. Install a disposable `Inspection` trigger that raises for that title. Record model counts, call `createProject`, then assert every Project/Membership/ProjectEventStream/DomainEvent/OutboxDelivery/node/phase/activity/inspection count is unchanged. Drop the trigger in `finally`.

- [ ] **Step 2: Add malformed graph probes**

Insert module payloads directly for orphan, cycle, duplicate key, invalid kind, missing nodeKey, and missing phaseName. Each `createProject` call must reject with `BadRequestException` and leave no project with the unique attempted name.

- [ ] **Step 3: Add union and concurrency probes**

Create a source project plus template and explicit module, then assert the target contains the complete union exactly once. Start two project creations concurrently; assert both complete or one honestly conflicts, neither has partial structure, and all `ACT-*`/`INSP-*` IDs remain unique.

- [ ] **Step 4: Run PostgreSQL proofs**

```bash
pnpm --filter api test:integration -- test/integration/project-initialization-atomicity.test.ts test/integration/module-boundaries.test.ts test/integration/phase2-consequences.test.ts test/integration/command-ledger.test.ts
```

Expected: all selected integration tests pass.

- [ ] **Step 5: Run PR A gate**

```bash
pnpm --filter api typecheck
pnpm check
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/integration/project-initialization-atomicity.test.ts apps/api/test/integration/fixtures.ts
git commit -m "test(api): prove atomic project initialization"
```
