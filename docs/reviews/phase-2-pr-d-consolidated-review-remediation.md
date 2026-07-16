# Phase 2 PR D — Consolidated-Review Remediation Packet

**What this is.** The independent consolidated review of the merged PR A/B/C effective head
(`main` `ce623f1`, the PR #165 merge) was run as a five-reviewer adversarial panel, each attacking one
dimension and instructed to *refute* the correctness claims. It returned a **conditional pass** — no
P0, no data-corruption, no security or tenancy defect, and the core guarantees (exactly-once command
effect, non-destructive audited seal, additive/legacy-safe migration, tenant isolation, clean secrets
scan) re-verified — but it did not fully clear two headline claims. This packet records the findings,
the remediation, and the fresh gate battery. It supersedes the residual-risk note of
`phase-2-task-6-7-fix-forward-packet.md` (§6) where noted.

---

## 1. Immutable SHAs

| What | SHA |
|------|-----|
| Consolidated-review base (PR #165 merge, `main`) | `ce623f1` |
| PR D code remediation (this branch `claude/phase2-pr-c-cutover-boundaries`) | `a37de18` |
| PR D docs (this commit) | *(this commit)* |

PR D adds **no migration** — the external-effect cutover seal migration
(`20261027000000_phase2_outbox_cutover_seal`) is unchanged. The compiled coverage version the seal
pins is likewise unchanged: `fc86d6e9240ed5653d6d4ba3d208ef799b526a94d538cbbe4d95d93cc2d5b151`.

---

## 2. Findings and remediation

Severity is the review panel's adjudicated rating (P0 highest). Each finding was independently
re-verified against the code before fixing.

### ① + ② [P2] The external sender was mode-coordinated, not lease-coordinated
The immediate `ExternalEffectDispatcher` called the provider **without owning the delivery lease**
(`dispatchOne` never claimed), and in legacy/shadow the relay skipped external deliveries entirely.
One root cause, two consequences:
- **② mixed-mode double-send** — a rolling deploy across the cutover (a legacy/shadow instance + an
  outbox instance on one Postgres) could have both send the same pending push.
- **① legacy drop** — a failed immediate attempt was left `pending` with no retrier in legacy mode:
  *at-most-once*, contradicting the stated at-least-once guarantee. (Not a regression — the removed
  in-request `notifyChanged` was also single-attempt — but the claim overstated it.)

**Fix** (`external-effect-dispatcher.ts`, `relay.service.ts`, `registry.ts`): the delivery lease is now
the single arbiter in every mode. The dispatcher **claims the lease (`claimOne`) before it sends**, so
a racing outbox-mode relay loses the claim and does not double-send. The relay owns external
**retries and recovery** in legacy/shadow (`claimExternalRecovery`: a due retry `attempts≥1`, an
expired lease, or a fresh row stranded past the lease window from a crash/DB-blip), while leaving a
recent first attempt to the dispatcher — so external delivery is **at-least-once in every mode**
without the relay racing the happy path. The post-commit dispatch body is fully guarded so a DB blip
can't throw into an already-committed command.
**Tests**: `external-effect-dispatcher.test.ts` (claim-before-send; mixed-mode claim-loses ⇒ no send;
post-commit DB error swallowed) + `outbox.test.ts` live-PG probes (relay leaves a fresh row; retries a
failed one; recovers a stranded one; `claimOne` atomic single-winner).

### ③ [P1-latent] Boundary analyzer soundness holes
The analyzer only recorded `prisma.<model>.<method>()` call-expressions, so a **nested** write
(`data: { <relation>: { create|update|delete } }`) to a foreign model was invisible — a future
cross-module write could ship green. It also missed the `*AndReturn` write methods and
`TRUNCATE`/`MERGE`/`COPY…FROM`/interpolated-`UPDATE` raw statements, and treated param-name-only route
collisions as distinct. All latent (no current runtime code triggered them), but they undercut the
"structurally complete / not gameable" claim.
**Fix** (`boundary-analyzer.ts`, `boundary-waivers.ts`): nested writes are attributed to the related
model via a DMMF relation map (recursively); `WRITE_METHODS` gains `createManyAndReturn` /
`updateManyAndReturn`; `isWriteSql` gains TRUNCATE / MERGE INTO / COPY…FROM / interpolated-UPDATE; a
param-name-insensitive `route-structural-duplicate` check is added. Adversarial fixtures cover each
class. The fix surfaced the sender fix's new `claimExternalRecovery` raw write — a genuine own-module
platform raw write — now declared in `RAW_SQL_WRITE_WAIVERS` alongside `claim`; those two are the only
runtime raw writes.

### ④ [P3] Dual-mode e2e over-claimed
`dual-mode-consequences.spec.ts` asserts on the **synchronous** `Notification` row, and the seed
creates no push subscriptions, so it validates the exactly-once command effect + draft privacy
mode-agnostically — not the asynchronous socket/push external delivery (which the API doesn't surface).
**Fix**: the spec docstring now states its scope honestly and points to the unit/integration suites
that DO exercise the relay-as-sole-sender external path. (No live push subscription was seeded into the
e2e: without a delivery sink it would add flakiness, not assurance; the relay external path is better
covered at integration level.)

### ⑤ [P3] Packet boundary-suite count — the "71" was correct
The review's static enumeration counted 43 `it()` in the four named suites and flagged the packet's
"71 passed" as inflated. Re-running the four suites empirically returns **71** (pre-fix) — the static
recount was the artifact (it under-counted). No packet correction was needed; PR D's five new analyzer
fixtures bring the true runtime count to **76**, recorded in §3.

### ⑥ ⑦ ⑧ [P3] Cleanups
- **⑥** the shadow plan-vs-catalog comparison no longer false-warns when a push-capable key
  legitimately emits without a body (a closing-inspection approval deferring its push to
  `activity.signed_off`); only a push body on a push-forbidding key warns.
- **⑦** the stale `OutboxSenderMode` doc (which still described the removed in-request `notifyChanged`)
  is corrected, and the now-dead `legacyPathSends()` / `outboxPathSends()` helpers removed.
- **⑧** the cutover-seal `$transaction` gets an explicit 120s timeout so a large-history gap scan under
  the `SHARE ROW EXCLUSIVE` lock can't hit Prisma's 5s default and roll back mid-cutover.

---

## 3. Gate battery (all green at `a37de18` + this docs commit)

| Command | Result |
|---------|--------|
| `pnpm check` (web + api: lint · typecheck · unit · build) | **exit 0** |
| API unit suite | **533 passed** (was 525; +8 dispatcher/boundary probes) |
| API integration suite (live PostgreSQL 16) | **248 passed** (was 244; +4 lease-coordination probes) |
| Boundary suites (`boundary` · `module-registry` · `cross-module-graph` · `route-policy`) | **76 passed** (was 71; +5 analyzer fixtures) |
| `test:e2e:api:legacy` (Playwright over compiled API + PG16) | **20/20** |
| `test:e2e:api:outbox` (sealed cutover; relay is sole sender) | **20/20** |
| `apps/api/scripts/upgrade-proof.sh` | **PASSED** |
| `git diff --check` | **clean** |

---

## 4. Residual risk (honest — supersedes PR C packet §6 on the at-least-once point)

- **External delivery is now at-least-once in EVERY mode** — legacy/shadow included, not only after an
  outbox cutover: a failed or stranded external delivery is re-attempted by the relay's recovery claim.
  It is still **at-least-once, not exactly-once**: a provider call can succeed while the durable status
  update or the process crashes before the row is marked `succeeded`, so a socket invalidation
  (idempotent) or a Web Push (a duplicate user-visible notification) can be delivered more than once.
  The command effect itself is exactly-once (the idempotency ledger); the socket signal is deduped per
  project per committed batch by the dispatcher, and the delivery lease makes exactly one sender own
  each delivery, mixed-mode fleets included.
- **Boundary analyzer nested-write coverage** now attributes nested writes recursively via the DMMF
  relation map, following object/array literals and one level of variable initializer. A write payload
  built entirely through an opaque helper the analyzer can't follow would still be unattributed — but a
  dynamic delegate already yields a `dynamic-delegate` finding, and the raw-SQL path is waiver-complete,
  so the escape surface is narrow and no runtime site exercises it.
- **Seal gap check vs. a live cutover** (unchanged): `sealExternal` still aborts on any dead delivery,
  blocked cursor, or external-delivery gap; an operator must seal against a caught-up system. The
  transaction now has a generous timeout so a large history is scanned rather than rolled back at 5s.

---

## 5. Disposition

PR D remediates the consolidated review's actionable findings on the merged effective head. The two
headline claims now hold as stated — the external sender is genuinely lease-coordinated (exactly one
sender per delivery, at-least-once in every mode), and the boundary analyzer detects the nested/return/
raw-SQL write classes it previously missed. This branch opens as one draft PR and is **held** for the
reviewer to confirm the remediation before the first backend extraction (Task 8) proceeds.
