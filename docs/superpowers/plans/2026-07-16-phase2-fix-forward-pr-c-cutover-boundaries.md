# Phase 2 Fix-Forward PR C: Cutover and Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every approved socket/push consequence onto explicit persisted intent, cut over with one lease-coordinated sender, and make module boundary CI structurally complete.

**Architecture:** A machine-readable effect catalog is the compile-time inventory and coverage-version source. Every event persists a catalog key plus dispatch intent; a single dispatcher and background relay compete through the same delivery lease. A database cutover seal neutralizes legacy history and rejects future intent-less events. Module enforcement reads Prisma DMMF, Nest metadata, and TypeScript symbols instead of filename/regex approximations.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 16, TypeScript compiler API, Vitest 4, Playwright 1.61.

## Global Constraints

- Preserve all Task 6/7 data, events, deliveries, manifests, participants, and migrations.
- PostgreSQL 16 is the supported target; forward migrations only.
- No event producer receives a default effect key or dispatch shape.
- Private drafts, replay branches, and true no-ops create no external send.
- External delivery remains at-least-once; do not claim exactly-once provider delivery.
- A sender calls a provider only while it owns the durable delivery lease.
- `OUTBOX_SENDER_MODE=outbox` fails startup without an exact persisted coverage seal.
- The seal never deletes an event, delivery, or historical payload.
- Boundary checks cover every Prisma model, registered controller route, and runtime TypeScript file.
- Existing API/UI behavior and role targeting remain unchanged.
- Use TDD; the consequence matrix and API-backed browser suite are acceptance authorities.

---

### Task 1: Create the External-Effect Catalog and Make Event Intent Mandatory

**Files:**
- Create: `apps/api/src/platform/external-effects.ts`
- Create: `apps/api/src/platform/external-effects.test.ts`
- Modify: `apps/api/src/platform/events.ts`
- Modify: `packages/shared/src/platform/events.ts`
- Modify: `apps/api/test/integration/phase2-consequences.test.ts`
- Modify: all service files containing `emitEvent(...)` under `apps/api/src`.

**Interfaces:**
- Produces:

```ts
type ExternalEffectKey = keyof typeof EXTERNAL_EFFECTS;
type DispatchIntent = {
  effectKey: ExternalEffectKey;
  coverageVersion: string;
  invalidate: boolean;
  push?: { body: string; roles?: string[] };
};
effectCoverageVersion(): string;
```

- `emitEvent(tx,{...,effectKey,dispatch})` persists `dispatchIntent` and returns complete event metadata.

- [ ] **Step 1: Write catalog and coverage tests and confirm RED**

Assert keys are unique, canonical sorting produces a stable SHA-256, every catalog event type exists in the shared event catalog, role sets are valid, and a dispatch contradicting its catalog entry is rejected. Add a source inventory assertion that every `emitEvent` call supplies both properties.

- [ ] **Step 2: Encode the Task 1 consequence matrix**

Create one entry for every event-producing mutation branch in `phase2-consequences.test.ts`. Each entry declares event type, invalidation boolean, push capability, and allowed roles. Draft keys declare no invalidation/push; shared mutations invalidate; existing push branches retain exact role sets.

- [ ] **Step 3: Require and persist intent**

Remove `notification?:` from `EmitInput`. Require `effectKey` plus dispatch, validate static shape against the catalog, add coverage version, persist to `DomainEvent.dispatchIntent`, pass it in `EmittedEventMeta`, and derive outbox delivery plans from it.

- [ ] **Step 4: Migrate every event producer via compiler errors**

Run API typecheck, then update every reported call site in decisions, activities/phases, inspections, drawings, daily-log, nodes, media, orgs, and members. Replay/no-op branches remain event-free. Use the exact bodies/roles pinned in `phase2-consequences.test.ts`.

- [ ] **Step 5: Run catalog and consequence tests**

```bash
pnpm --filter api test -- src/platform/external-effects.test.ts
pnpm --filter api typecheck
pnpm --filter api test:integration -- test/integration/phase2-consequences.test.ts test/integration/event-catalog.test.ts test/integration/outbox.test.ts
```

Expected: all tests pass and no event call lacks explicit intent.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/platform/events.ts apps/api/src apps/api/test/integration/phase2-consequences.test.ts apps/api/test/integration/event-catalog.test.ts apps/api/test/integration/outbox.test.ts
git commit -m "feat(api): persist explicit external effect intent"
```

### Task 2: Route Immediate and Background Sends Through One Delivery Lease

**Files:**
- Create: `apps/api/src/platform/outbox/external-effect-dispatcher.ts`
- Create: `apps/api/src/platform/outbox/external-effect-dispatcher.test.ts`
- Modify: `apps/api/src/platform/commands.ts`
- Modify: `apps/api/src/platform/outbox/relay.service.ts`
- Modify: `apps/api/src/platform/outbox/consumers.ts`
- Modify: `apps/api/src/realtime/realtime.gateway.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: every service currently calling `RealtimeGateway.notifyChanged(...)`.
- Modify: affected service unit tests.

**Interfaces:**
- Produces:
  - `ExternalEffectDispatcher.dispatchCommitted(events: EmittedEventMeta[]): Promise<void>`
  - `OutboxRelay.dispatchExternalForEvent(eventId): Promise<void>`
  - fresh command outcomes carry `events`, replay outcomes carry `events: []`.

- [ ] **Step 1: Write lease-race and replay tests and confirm RED**

Compete immediate dispatcher and `runOnce()` for the same event. Assert one provider call, one succeeded row, and no duplicate. Assert replay outcomes never dispatch; outbox mode never invokes immediate dispatch; provider failure leaves retryable/dead durable state while the API command result remains successful.

- [ ] **Step 2: Thread committed event metadata through commands**

Extend `CommandResult`/`ExecuteOutcome` with `events: EmittedEventMeta[]`. Fresh transaction callbacks return emitted events in causal order; receipt replay returns an empty list and does not re-emit.

- [ ] **Step 3: Implement one lease-coordinated dispatcher**

Extract claim/success/failure transitions in `OutboxRelay` so specific-event and background dispatch share them. In legacy/shadow, `ExternalEffectDispatcher` attempts new rows immediately and catches/logs external failure after durable state is updated. In outbox mode it returns without claiming; background relay owns dispatch. Consumers send whenever invoked because lease/mode selection happens before invocation.

- [ ] **Step 4: Remove direct service consequences**

Replace every service `RealtimeGateway` dependency and `notifyChanged` call with post-commit `dispatchCommitted(events)`. Keep `RealtimeGateway.emitChanged(projectId)` as the socket consumer's provider operation; only the push consumer calls `PushService.notifyProject`.

- [ ] **Step 5: Add shadow comparison**

Before the immediate shadow send, compare the persisted delivery action/payload for the event with the catalog-derived expected socket/push plan. Record structured mismatches by event ID and coverage version; do not send twice.

- [ ] **Step 6: Run focused suites**

```bash
pnpm --filter api test -- src/platform/outbox/external-effect-dispatcher.test.ts src/platform/outbox/registry.test.ts
pnpm --filter api test:integration -- test/integration/outbox.test.ts test/integration/phase2-consequences.test.ts test/integration/command-ledger.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test/integration
git commit -m "fix(api): coordinate external sends through outbox leases"
```

### Task 3: Add the Audited External-Effect Cutover Seal

**Files:**
- Create: `apps/api/prisma/migrations/20261027000000_phase2_outbox_cutover_seal/migration.sql`
- Modify: `apps/api/src/platform/outbox/outbox-operations.service.ts`
- Modify: `apps/api/src/platform/outbox/outbox-operations.test.ts`
- Modify: `apps/api/src/platform/outbox/outbox.cli.ts`
- Modify: `apps/api/src/platform/outbox/outbox.bootstrap.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/test/integration/outbox.test.ts`
- Modify: `apps/api/scripts/upgrade-proof.sh`

**Interfaces:**
- Produces `OutboxOperationsService.sealExternal({operatorIdentity,reason}): Promise<{coverageVersion:string;auditId:string}>` and `outbox:seal-external`.

- [ ] **Step 1: Write seal, trigger, and startup probes and confirm RED**

Prove: absent/stale seal blocks outbox-mode startup; seal preserves rows/payloads but marks null-intent and `compat-task6` external deliveries `noop/succeeded`; leased legacy row aborts seal; an event insert held before the table lock finishes first; a later null-intent insert is rejected; a valid current-intent insert succeeds.

- [ ] **Step 2: Add the seal-aware database trigger**

Create a `BEFORE INSERT` trigger on DomainEvent that checks singleton key `external-effects`. When sealed, `NEW.dispatchIntent IS NULL` raises a diagnostic exception. Existing rows remain untouched.

- [ ] **Step 3: Implement the seal transaction**

Require mode legacy/shadow, operator, and reason. `LOCK TABLE "DomainEvent" IN SHARE ROW EXCLUSIVE MODE`; row-lock external deliveries for null or non-current coverage intent; abort if any is leased or if gaps/dead/blocked rows exist; mark them noop/succeeded without clearing payload; upsert the exact compiled version; insert operator audit.

- [ ] **Step 4: Gate outbox startup**

Before relay start in outbox mode, require singleton coverageVersion equals the compiled catalog hash. Legacy/shadow remain available for a forward deployment and later reseal.

- [ ] **Step 5: Run migration and seal proofs**

```bash
pnpm --filter api prisma:generate
pnpm --filter api test -- src/platform/outbox/outbox-operations.test.ts
pnpm --filter api test:integration -- test/integration/outbox.test.ts
bash apps/api/scripts/upgrade-proof.sh
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src/platform/outbox apps/api/package.json apps/api/test/integration/outbox.test.ts apps/api/scripts/upgrade-proof.sh
git commit -m "feat(api): seal external effect cutover"
```

### Task 4: Make Module Boundary Enforcement Structurally Complete

**Files:**
- Create: `apps/api/src/platform/module-registry/boundary-analyzer.ts`
- Create: `apps/api/src/platform/module-registry/boundary-waivers.ts`
- Modify: `apps/api/src/platform/module-registry/boundary.test.ts`
- Modify: `packages/shared/src/platform/module-registry.ts`
- Modify: `apps/api/src/platform/module-registry/registry.ts`
- Modify: every `*.manifest.ts` under API source.
- Modify: `apps/api/src/common/cross-module-graph.test.ts`
- Test: `apps/api/src/common/route-policy.test.ts`

**Interfaces:**
- Produces:
  - exact manifest `routes: Array<'METHOD /fully/qualified/path'>`
  - typed `RAW_SQL_WRITE_WAIVERS` entries `{file,symbol,owner,reason}`
  - analyzer findings for model ownership, route ownership, Prisma writes, dynamic delegates, and raw SQL.

- [ ] **Step 1: Write adversarial analyzer fixtures and confirm RED**

Create in-memory/temp TypeScript fixtures for controller write, helper write, transaction alias, destructured delegate, raw `INSERT`, writable CTE, dynamic bracket delegate, duplicate route, missing model owner, and unused waiver. Assert each produces an exact finding.

- [ ] **Step 2: Replace model regex with Prisma DMMF**

Read `Prisma.dmmf.datamodel.models`, convert model names to Prisma delegate names, and require exact equality with the union of manifest `ownsModels`. Reject absent and duplicate ownership.

- [ ] **Step 3: Derive full routes from Nest metadata**

Walk controllers registered by application modules; combine controller and method PATH metadata plus METHOD metadata into canonical `METHOD /path`. Require exact manifest equality and reject duplicate contributions.

- [ ] **Step 4: Implement compiler-symbol persistence analysis**

Build a TypeScript `Program` over all runtime `.ts` files except tests/generated output. Follow symbols originating from `PrismaService`, `PrismaClient`, or `Prisma.TransactionClient` through fields, parameters, aliases, and destructuring. Detect create/createMany/update/updateMany/upsert/delete/deleteMany and raw write SQL in every file. Reject dynamic bracket delegate access.

- [ ] **Step 5: Add exact waivers and update manifests**

Runtime raw SQL requires one waiver naming exact file, enclosing symbol, platform owner, and reason. No wildcards; zero or multiple site matches and unused waivers fail. Prisma migration SQL is the only path exclusion. Preserve the bounded auth-to-identity waiver and its Task 10 removal gate.

- [ ] **Step 6: Run boundary suites**

```bash
pnpm --filter api test -- src/platform/module-registry/boundary.test.ts src/platform/module-registry/module-registry.test.ts src/common/cross-module-graph.test.ts src/common/route-policy.test.ts
```

Expected: all current runtime sites and manifests pass; every adversarial fixture fails for the intended reason.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/platform/module-registry.ts apps/api/src/platform/module-registry apps/api/src/**/*.manifest.ts apps/api/src/common/cross-module-graph.test.ts
git commit -m "fix(api): enforce complete module boundaries"
```

### Task 5: Run API Acceptance in Legacy and Outbox Modes

**Files:**
- Modify: `scripts/test-api-e2e.sh`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/web/tests/e2e-api/*.spec.ts` only for condition-based synchronization required by real outbox delivery.

**Interfaces:**
- Produces scripts `test:e2e:api:legacy` and `test:e2e:api:outbox`; CI runs both on PostgreSQL 16.

- [ ] **Step 1: Parameterize the harness**

Legacy mode starts with relay recovery enabled and immediate dispatch. Outbox mode migrates/seeds, runs the seal command in legacy mode, then starts the API with `OUTBOX_SENDER_MODE=outbox` and relay enabled. Do not use fixed sleeps; poll health and user-visible conditions.

- [ ] **Step 2: Add exactly-one consequence assertions**

Run the pillar chain in each mode and assert private drafts stay private, published decisions notify once, drawing/inspection/activity/material flows invalidate once logically, and retries do not create duplicate canonical rows.

- [ ] **Step 3: Run both suites twice**

```bash
pnpm test:e2e:api:legacy
pnpm test:e2e:api:outbox
pnpm test:e2e:api:legacy
pnpm test:e2e:api:outbox
```

Expected: 18/18 (or current discovered total) passes on every run with no relay timeout.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-api-e2e.sh package.json .github/workflows/ci.yml apps/web/tests/e2e-api
git commit -m "test: gate legacy and outbox sender modes"
```

### Task 6: Run the Consolidated Task 6-7 Gate

**Files:**
- Create or update: `docs/reviews/phase-2-task-6-7-fix-forward-packet.md`

- [ ] **Step 1: Run the complete battery**

```bash
pnpm check
pnpm --filter api test:integration
pnpm --filter web test:e2e
pnpm test:e2e:api:legacy
pnpm test:e2e:api:outbox
bash apps/api/scripts/upgrade-proof.sh
git diff --check origin/main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Run focused races repeatedly**

```bash
for i in {1..10}; do pnpm --filter api test:integration -- test/integration/outbox.test.ts test/integration/project-initialization-atomicity.test.ts || exit 1; done
```

- [ ] **Step 3: Write the evidence packet**

Record base/head/merge SHAs for PR A/B/C, migration checksums, diagnostic outputs, PostgreSQL version, exact test totals, legacy/outbox browser runs, red-at-`cf038be`/green-at-head probes, and residual at-least-once provider duplication risk.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/reviews/phase-2-task-6-7-fix-forward-packet.md
git commit -m "docs: record task 6-7 fix-forward evidence"
```

- [ ] **Step 5: Stop for one consolidated independent review**

Task 8 remains blocked until the combined PR A/B/C effective head and packet clear one independent review. Do not reopen Phase 1 or split findings into repeated subsystem gates.
