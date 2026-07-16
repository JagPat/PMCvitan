# Phase 2 Fix-Forward PR B: Durable Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every consumer/event obligation durable, gap-safe, coordinate-bound, observable, and recoverable without mutating canonical events.

**Architecture:** Add a persistent consumer catalog and explicit dispatch/no-op delivery plans. A repeated `NOT EXISTS` expansion pass repairs rolling-deployment and crash gaps; ordered no-ops advance the same cursor transaction as real projection work. Composite foreign keys bind copied delivery coordinates to their event, while audited operator commands expose and retry dead work without skipping.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 16, TypeScript, Vitest 4.

## Global Constraints

- Forward, diagnostic-first migrations only; abort on coordinate contradictions and never guess corrections.
- PostgreSQL 16 is the supported database target.
- DomainEvent remains append-only; dispatch progress never updates it.
- Outbox semantics are at-least-once externally and effectively-once for database consumers.
- Every active `OutboxConsumerCatalog` row paired with every DomainEvent is a durable obligation.
- Ordered consumers account for every project stream position through either dispatch or no-op.
- External legacy events with null dispatch intent never replay historical pushes.
- Operator recovery never advances or skips a canonical event.
- Use TDD and real PostgreSQL for ordering, concurrency, constraint, migration, and retry proofs.

---

### Task 1: Add the Durable Outbox Schema and Diagnostic Migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261026000000_phase2_outbox_reliability/migration.sql`
- Modify: `apps/api/scripts/upgrade-proof.sh`
- Test: `apps/api/test/integration/outbox.test.ts`

**Interfaces:**
- Produces Prisma delegates `outboxConsumerCatalog`, `outboxOperatorAction`, `outboxCutoverState` and fields `DomainEvent.dispatchIntent`, `OutboxDelivery.deliveryAction`.

- [ ] **Step 1: Write live constraint probes and confirm RED**

Add tests that direct-insert a delivery with forged project/position, invalid delivery action, invalid catalog kind/effect, and mismatched delivery/catalog kind. Assert current PostgreSQL accepts or lacks these constraints before the migration.

- [ ] **Step 2: Declare exact Prisma models**

Add:

```text
OutboxConsumerCatalog(consumer PK, consumerKind, consumerEffect, catalogVersion,
  active default true, registeredAt, updatedAt, UNIQUE(consumer,consumerKind))
OutboxOperatorAction(id UUID PK, action, deliveryId?, consumer?, projectId?, eventId?,
  operatorIdentity, reason, priorError?, at)
OutboxCutoverState(key PK, coverageVersion, sealedAt, sealedBy, reason, updatedAt)
```

Add nullable `DomainEvent.dispatchIntent`, candidate key `(eventId,projectId,streamPosition)`, required `OutboxDelivery.deliveryAction default 'dispatch'`, composite event FK, and composite catalog FK. Preserve existing IDs, payloads, attempts, and statuses.

- [ ] **Step 3: Write the migration diagnostic and DDL**

The migration must:

1. add nullable/additive columns and tables;
2. seed `socket.invalidation` and `webpush.notify` as version 1 `unordered/external` consumers;
3. abort with counts/samples if delivery coordinates disagree with DomainEvent;
4. replace the event-only FK with `(eventId,projectId,streamPosition)`;
5. add `(consumer,consumerKind)` catalog FK;
6. add CHECKs for status, delivery action, kind/effect, allowed kind/effect pair, and cutover singleton key;
7. leave historical payloads and event rows unchanged.

- [ ] **Step 4: Regenerate Prisma and run schema tests**

```bash
pnpm --filter api prisma:generate
pnpm --filter api typecheck
pnpm --filter api test:integration -- test/integration/outbox.test.ts
```

Expected: constraint probes pass by PostgreSQL rejection.

- [ ] **Step 5: Prove abort, repair, and upgrade**

Extend `upgrade-proof.sh` to seed one valid historical delivery and assert catalog/action defaults after migration. Separately apply the migration to a disposable database with one forged coordinate, assert the diagnostic aborts, correct only the fixture, redeploy, and assert success.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/scripts/upgrade-proof.sh apps/api/test/integration/outbox.test.ts
git commit -m "feat(api): add durable outbox catalog constraints"
```

### Task 2: Make Consumer Registration and Delivery Planning Total

**Files:**
- Modify: `apps/api/src/platform/outbox/registry.ts`
- Modify: `apps/api/src/platform/outbox/consumers.ts`
- Modify: `apps/api/src/platform/outbox/outbox.bootstrap.ts`
- Modify: `apps/api/src/platform/events.ts`
- Create: `apps/api/src/platform/outbox/registry.test.ts`
- Modify: `apps/api/test/integration/outbox.test.ts`

**Interfaces:**
- Produces:
  - `DeliveryPlan = { action:'dispatch'; payload? } | { action:'noop' }`
  - `OutboxConsumer.catalogVersion: number`
  - `syncConsumerCatalog(prisma): Promise<void>`
  - total `deliveryFor(meta): DeliveryPlan`
- Consumes complete `EmittedEventMeta`, including `dispatchIntent`.

- [ ] **Step 1: Write registry tests and confirm RED**

Assert consumers cannot return null, unordered no-op materializes `succeeded/noop`, ordered no-op materializes `pending/noop`, catalog sync creates missing rows, and sync rejects kind/effect/version drift instead of overwriting it.

- [ ] **Step 2: Implement total delivery plans**

Socket returns dispatch only when persisted intent has `invalidate:true`; push returns dispatch only for a valid persisted push body; all other events return no-op. A null-intent legacy event is external no-op regardless of an old delivery payload.

- [ ] **Step 3: Persist and validate the catalog before relay start**

Bootstrap registers compiled consumers, synchronizes catalog rows, fails startup on contract mismatch, runs expansion, then starts the relay. Do not catch and downgrade catalog/expansion initialization failure to a warning.

- [ ] **Step 4: Materialize explicit actions in the emit transaction**

`materializeDeliveries` writes one row for every compiled consumer and sets action/status deterministically. Until PR C supplies the final per-command catalog key, `emitEvent` persists a compatibility intent with `effectKey:'compat.task6'`, `coverageVersion:'compat-task6'`, the current socket behavior, and its existing decision notification argument. This makes scanner reconstruction honest without claiming complete cutover coverage. The unique `(eventId,consumer)` remains the concurrency backstop.

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
pnpm --filter api test -- src/platform/outbox/registry.test.ts
pnpm --filter api test:integration -- test/integration/outbox.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform/events.ts apps/api/src/platform/outbox apps/api/test/integration/outbox.test.ts
git commit -m "fix(api): make outbox delivery planning total"
```

### Task 3: Add Continuous Full-Envelope Expansion and Ordered No-Ops

**Files:**
- Modify: `apps/api/src/platform/outbox/relay.service.ts`
- Modify: `apps/api/src/platform/outbox/registry.ts`
- Modify: `apps/api/src/platform/outbox/outbox.bootstrap.ts`
- Modify: `apps/api/test/integration/outbox.test.ts`

**Interfaces:**
- Produces `OutboxRelay.expandMissingDeliveries(batchSize = 200): Promise<number>`.
- `runOnce()` invokes expansion before claiming delivery work.

- [ ] **Step 1: Write gap and no-op probes and confirm RED**

Add live-PG tests for: ordered no-op at position 0 then dispatch at position 1; consumer registered after events; simulated crash after catalog upsert; old-instance event after registration; two concurrent scanners; and filtered consumer receiving historical dispatch plus no-op rows. Use barriers rather than sleeps.

- [ ] **Step 2: Implement the repeated scanner**

For each active catalog row, select the earliest full DomainEvent envelopes lacking its delivery with `NOT EXISTS`, ordered by project and stream position, limited to the batch. Resolve the compiled consumer, derive the plan, and `createMany(...skipDuplicates)`. Repeat batches until no rows or the caller's bounded pass ends.

- [ ] **Step 3: Dispatch no-ops correctly**

Unordered no-op is already succeeded and never invokes a handler. Ordered no-op enters the same transaction as ProcessedEvent/cursor advancement but skips business projection code. A pre-intent external dispatch row is converted to `noop/succeeded` when encountered.

- [ ] **Step 4: Make ordered claim project-safe**

Claim in consumer/project/stream order and preserve short leases. When position N+1 arrives before N, release it to pending without treating the wait as progress. A dead exact-next row blocks the cursor visibly.

- [ ] **Step 5: Run race tests repeatedly**

```bash
pnpm --filter api test:integration -- test/integration/outbox.test.ts
for i in {1..10}; do pnpm --filter api test:integration -- test/integration/outbox.test.ts || exit 1; done
```

Expected: all runs pass without fixed-tick timing assumptions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform/outbox apps/api/test/integration/outbox.test.ts
git commit -m "fix(api): repair outbox gaps continuously"
```

### Task 4: Add Audited Dead-Letter Operations and Health Diagnostics

**Files:**
- Create: `apps/api/src/platform/outbox/outbox-operations.service.ts`
- Create: `apps/api/src/platform/outbox/outbox-operations.test.ts`
- Create: `apps/api/src/platform/outbox/outbox.cli.ts`
- Modify: `apps/api/src/platform/outbox/relay.service.ts`
- Modify: `apps/api/src/health.controller.ts`
- Create: `apps/api/src/health.controller.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/test/integration/outbox.test.ts`

**Interfaces:**
- Produces:
  - `OutboxOperationsService.status(): Promise<OutboxStatus>`
  - `OutboxOperationsService.retry({deliveryId,operatorIdentity,reason}): Promise<{auditId:string}>`
  - scripts `outbox:status` and `outbox:retry`.

- [ ] **Step 1: Write operation tests and confirm RED**

Assert status aggregates pending/leased/dead/blocked/oldest age and redacts/truncates errors. Retry must reject non-dead/inactive/missing/mismatched rows; reset an unordered dead row; and unblock an ordered cursor only when the row is exact-next. Assert one durable audit row in the same transaction.

- [ ] **Step 2: Implement status and retry transactions**

Use explicit row locking. Retry sets pending, attempts 0, `nextAttemptAt=now`, clears lease/error, writes `OutboxOperatorAction`, and never changes `appliedPosition`. Require nonblank operator and reason.

- [ ] **Step 3: Add CLI entrypoint**

Create a Nest application context, parse exact required flags, print status JSON without payloads/secrets, run the operation, disconnect, and set nonzero exit code on validation or database failure.

- [ ] **Step 4: Add diagnostics without breaking liveness**

Inject operations into `HealthController`; return HTTP 200 with process uptime plus aggregate outbox fields. Catch diagnostic query failure and return `outboxAvailable:false` rather than causing a process restart loop. Relay dead/block transitions log structured identifiers and audit-safe errors.

- [ ] **Step 5: Run unit and PostgreSQL tests**

```bash
pnpm --filter api test -- src/platform/outbox/outbox-operations.test.ts src/health.controller.test.ts
pnpm --filter api test:integration -- test/integration/outbox.test.ts
```

Expected: all tests pass; CLI smoke against the disposable DB exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform/outbox apps/api/src/health.controller* apps/api/src/app.module.ts apps/api/package.json apps/api/test/integration/outbox.test.ts
git commit -m "feat(api): add audited outbox recovery operations"
```

### Task 5: Run the PR B Gate

**Files:**
- Modify only files required by failures caused by PR B.

- [ ] **Step 1: Run full API verification**

```bash
pnpm --filter api prisma:generate
pnpm --filter api typecheck
pnpm --filter api test
pnpm --filter api test:integration
bash apps/api/scripts/upgrade-proof.sh
```

- [ ] **Step 2: Run workspace verification**

```bash
pnpm check
git diff --check origin/main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 3: Record migration evidence**

Record the migration checksum, coordinate diagnostic result, consumer catalog rows, test totals, and the red-at-base/green-at-head probe map in the PR body/evidence packet.

- [ ] **Step 4: Commit gate-only corrections**

If verification required code corrections, commit only those corrections with their covering tests. Do not add unrelated refactors.
