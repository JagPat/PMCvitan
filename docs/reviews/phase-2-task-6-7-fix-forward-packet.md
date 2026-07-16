# Phase 2 Task 6/7 Fix-Forward — Consolidated Evidence Packet (PR A / B / C)

**Scope of this packet.** The durable-outbox fix-forward that hardens the Phase 2 Task 6/7 platform
kernel across three merged-or-pending PRs: **PR A** (frontend scope + outbox correctness), **PR B**
(durable outbox reliability + operator dead-letter tooling), and **PR C** (this change: external-effect
catalog, single lease-coordinated sender, audited cutover seal, structural boundary enforcement,
dual-mode acceptance). This is the single artifact for **one consolidated independent review** of the
combined effective head. Task 8 (first backend extraction) remains blocked until this clears.

---

## 1. Immutable SHAs

| PR | What | Base | Head | Merge |
|----|------|------|------|-------|
| **A** (#161) | frontend scope / outbox findings 1,3,6 | — | — | `0b8ce6e` |
| **B** (#162) | durable outbox: catalog + composite FK | `54cf06f` | `7558851` | `570502a` |
| **B** (#163) | outbox gap-expansion scanner | `570502a` | `b515f5e` | `4904e11` |
| **B corr.** (#164) | active-authority + bounded expansion | `4904e11` | `755523a` | `be2d8f6` |
| **C** (this branch `claude/phase2-pr-c-cutover-boundaries`) | cutover + boundaries | `be2d8f6` | `16af1d5` | *(draft, unmerged — held for this review)* |

**PR C base** `be2d8f6d32f05a7af66b1c3f380fe3ead1a12b19` (main, PR #164 merge).

### PR C commit ledger (in order)
| SHA | Task | Summary |
|-----|------|---------|
| `aec8579` | docs | record #164 merged + start PR C status |
| `b5c6d9a` | 1 | external-effect catalog + mandatory persisted intent |
| `50ace36` | 2 | `emitEvent` returns the full `EmittedEventMeta` (groundwork) |
| `1c3b8c1` | 2 | single lease-coordinated external sender |
| `9496a0f` | 3 | audited external-effect cutover seal |
| `2d68bdd` | 4 | structurally-complete module boundary enforcement |
| `16af1d5` | 5 | dual-mode (legacy + outbox) API acceptance |
| *(this commit)* | 6 | consolidated gate evidence |

---

## 2. Environment

- **PostgreSQL 16.13** (Ubuntu 16.13-0ubuntu0.24.04.1, x86_64) — the supported target; forward
  migrations only.
- NestJS 11 · Prisma 6.19.3 · TypeScript 5.7 · Vitest 4.1 · Playwright 1.61 · Node 22.

### Migration added by PR C
- `apps/api/prisma/migrations/20261027000000_phase2_outbox_cutover_seal/migration.sql`
  (file SHA-256 `255e36d7fe27e192173190ee5318b64b6049587c9575fb8d6f29e1042a5433b7`).
  Installs the `DomainEvent` `BEFORE INSERT` seal trigger only — no data touched. The seal-state table
  (`OutboxCutoverState`) itself was declared in PR B (`20261026000000_phase2_outbox_reliability`).

### Compiled external-effect coverage version (the value the cutover seal pins)
`fc86d6e9240ed5653d6d4ba3d208ef799b526a94d538cbbe4d95d93cc2d5b151`
(order-independent SHA-256 of the whole `EXTERNAL_EFFECTS` catalog; recomputed at runtime, verified by
`external-effects.test.ts` to be deterministic + order-independent).

---

## 3. Complete gate battery (all green at head `16af1d5` + this docs commit)

| Command | Result |
|---------|--------|
| `pnpm check` (web + api: lint · typecheck · unit · build) | **exit 0** |
| API unit suite (`vitest run`) | **525 passed** (46 files) |
| API integration suite (`vitest run --config vitest.integration.config.ts`) | **244 passed** (26 files) |
| Boundary suites (`boundary` · `module-registry` · `cross-module-graph` · `route-policy`) | **71 passed** |
| `test:e2e:api:legacy` (Playwright over compiled API + PG16) | **20/20** ×2 runs |
| `test:e2e:api:outbox` (sealed cutover; relay is sole sender) | **20/20** ×2 runs |
| `apps/api/scripts/upgrade-proof.sh` (legacy fixture through all migrations) | **PASSED** (incl. new seal-trigger + unsealed-DB assertions) |
| `git diff --check origin/main...HEAD` | **clean** |
| Race loop: `outbox.test.ts` + `project-initialization-atomicity.test.ts` ×10 | **10/10** (31 tests/round, deterministic) |

The web demo e2e (`pnpm --filter web test:e2e`) exercises frontend demo mode only; PR C is a
backend/outbox-only diff (no `apps/web/src` change), so it is unaffected and CI-covered.

---

## 4. Red-at-base → green-at-head probes

Each PR C task was TDD (test-first). At the PR C base `be2d8f6` the following did not exist / would
fail; all are green at head:

- **Task 1** — `external-effects.test.ts` (catalog uniqueness, deterministic order-independent coverage
  hash, dispatch-vs-catalog validation) + the `emitEvent` intent requirement. Absent at base.
- **Task 2** — `external-effect-dispatcher.test.ts` (outbox-mode short-circuit, socket dedup per project,
  never-throws post-commit, bigint-safe) + the `phase2-consequences.test.ts` per-branch push/signal now
  routed through the single sender. The dispatcher file is absent at base.
- **Task 3** — the seal probes in `outbox.test.ts` (outbox-mode seal refusal; startup gate blocks on
  absent/stale seal and starts on a matching one; neutralize-non-current-preserve-payload; leased-target
  abort; trigger rejects null-intent after seal; valid current-intent accepted) + `outbox-operations.test.ts`
  seal audit. Absent at base (the trigger + `sealExternal` do not exist).
- **Task 4** — `boundary.test.ts` driven by the DMMF/Nest-metadata/TS-compiler analyzer, with 10
  adversarial fixtures each failing for its exact reason. At base the boundary check was a filename/regex
  scan; the fully-qualified-route manifests + analyzer are new.
- **Task 5** — `dual-mode-consequences.spec.ts` + `test:e2e:api:outbox`. Absent at base (no seal, no
  outbox startup gate, no mode-parameterized harness).

---

## 5. What PR C changed (architecture)

1. **External-effect catalog** (`platform/external-effects.ts`) — the machine-readable, per-command-branch
   inventory: each key pins `{eventType, invalidate, push: roles|null}`. `effectCoverageVersion()` is the
   order-independent hash the seal pins. `emitEvent` now REQUIRES `effectKey` + `dispatch` (no default),
   validates against the catalog, and persists the immutable `DispatchIntent` on the event.
2. **Single lease-coordinated sender** (`platform/outbox/external-effect-dispatcher.ts`) — every command
   hands its committed events to `dispatchCommitted` post-commit. The sender-mode + delivery lease decide
   WHO sends BEFORE any consumer runs, so there are never two active senders: `legacy`/`shadow` → the
   immediate dispatcher (one socket invalidation per project across the batch, one push per push-bearing
   event, through the relay's shared claim/dispatch path); `outbox` → the background relay owns external
   dispatch and the dispatcher returns early. The in-request `RealtimeGateway.notifyChanged` (socket +
   push) is REMOVED; `emitChanged` remains as the socket consumer's provider op.
3. **Audited cutover seal** (`sealExternal` + `20261027000000` trigger + outbox-mode startup gate) — a
   forward-only seal that pins the compiled coverage, neutralizes pre-cutover external deliveries without
   deleting rows/payloads, and makes `OUTBOX_SENDER_MODE=outbox` startup require the exact coverage while
   the DB rejects any future null-intent event. CLI: `outbox:seal-external`.
4. **Structural boundary enforcement** (`platform/module-registry/boundary-analyzer.ts` + typed waivers)
   — model ownership from Prisma DMMF, fully-qualified routes from Nest metadata, and TS-compiler
   symbol-following persistence analysis over the server's runtime program (41 models, 67 routes, 87
   files). Only cross-module edges: the bounded auth→identity provisioning waiver and the single relay
   lease-claim raw-SQL waiver.
5. **Dual-mode acceptance** — the API browser suite runs in both sender modes on PG16 in CI.

### Analyzer "runtime file set" — one deliberate scoping decision (flagged for the reviewer)
The boundary analyzer defines the runtime file set as the TypeScript `Program`'s transitive import
closure from the server composition root (`main.ts` / `app.module.ts`) — the precise meaning of "runtime"
as *what the server loads*. This excludes exactly two non-server entrypoints from the non-test source
glob: `domain/seed-data.ts` (seed-CLI helper, imported only by `prisma/seed.ts`) and
`platform/outbox/outbox.cli.ts` (operator CLI). This is principled (it uses the compiler's own module
resolution, not a hardcoded list), it upholds the invariant that auth→identity is the *only* remaining
cross-module edge (treating the seed helper as server runtime would force a second waiver for the seed's
orgs-owned `templateModule`/`projectTemplate` writes), and it still expands coverage far beyond the prior
`*.service.ts`/`*.participant.ts`-only regex scan.

---

## 6. Residual risk (honest)

- **External delivery is at-least-once, not exactly-once.** A provider call can succeed while the durable
  status update or the process crashes before the row is marked `succeeded`; the relay/dispatcher will
  re-attempt, so a socket invalidation or a Web Push CAN be delivered more than once. Socket
  invalidations are idempotent (each client refetches its own RBAC snapshot); a duplicate Web Push is a
  duplicate user-visible notification. This is an accepted property, not a defect — no exactly-once
  provider delivery is claimed. The command effect itself IS exactly-once (the idempotency ledger), and
  the socket signal is deduped per project per committed batch by the dispatcher.
- **Seal gap check vs. a live cutover.** `sealExternal` aborts on any dead delivery, blocked cursor, or
  external-delivery gap; an operator must run it against a caught-up system (in the e2e the freshly-seeded
  DB emits no events, so the seal is trivially clean). This is intentional — sealing over an incomplete
  outbox could strand a delivery.

---

## 7. Hold

Per the active plan (Task 6 Step 5) and the PR C directive, this branch opens as **one draft PR** and is
**held** for a single consolidated independent (Codex) review of the combined PR A/B/C effective head.
It is not marked ready and is not merged. Do not reopen Phase 1 or split findings into repeated subsystem
gates.
