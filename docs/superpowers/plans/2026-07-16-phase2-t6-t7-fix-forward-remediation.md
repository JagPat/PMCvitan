# Phase 2 Tasks 6–7 Fix-Forward Remediation — Executable Plan + Independent Verification

> **For agentic workers:** This plan implements the Codex-authored design
> `docs/superpowers/specs/2026-07-16-phase2-task6-task7-fix-forward-design.md`
> (branch `codex/phase2-t6-t7-fix-forward`, commit `1ab8bc8`), **as corrected by the
> independent verification recorded in §2 below.** Three correction PRs (A → B → C),
> then **one consolidated independent review**. Task 8 stays blocked until that review clears.

**Baseline:** `main` @ `cf038be` (merge of Task 7 PR #159). Reviewed work: Task 6 PR #158 (`3e30874`) and Task 7 PR #159 (`3b84b64`).

## 1. Why this exists

Task 6 (per-consumer transactional outbox + notification split) and Task 7 (module registry + manifests + boundary CI + edge workflow contracts) are both **mandatory review stops** in the active Phase 2 plan. Both merged before their independent review. This remediation is the review coming back: a **fix-forward** (no revert, no history rewrite, no data reset) that closes the confirmed defects at their roots before Task 8 builds the first module extraction on this foundation.

## 2. Independent verification (Claude, against `cf038be`)

Every defect the design claims was checked against the merged code by three independent read-only passes. **11 of 12 claims confirmed as real; 1 (C2) partially true.** One is an **active shipped bug** (C3), which is what makes the remediation genuinely load-bearing rather than cleanup.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| A1 | `createProject` is not one transaction | ✅ Confirmed | **Three** commits: core `orgs.service.ts:288`, then `copyStructure:775`, then `instantiateModules:622`. Mid-flight failure ⇒ committed project+PMC with partial structure. |
| A2 | malformed structure silently skipped | ✅ Confirmed | `break` on unresolved parentage (`orgs.service.ts:781`, `:656`) drops remaining nodes and nulls activity/inspection refs (`:699`, `:825`). |
| A3 | publish Notification outside the txn | ✅ Confirmed | One-step publish writes `Notification` post-commit (`decisions.service.ts:110`); two-step `publish()` writes it in-txn (`:140`). |
| A4 | global ACT-/INSP- ID race | ✅ Confirmed | read-max+1, no advisory lock, scan outside txn (`orgs.service.ts:612`, `:755`). |
| B1 | filtered event ⇒ no row ⇒ ordered cursor stalls | ✅ Confirmed (latent) | `deliveryFor→null` skips row (`registry.ts:110`); a filtered gap makes an ordered cursor **silently `wait` forever** (`relay.service.ts:164`), not even `blocked`. No shipped ordered+filtered consumer yet. |
| B2 | consumer catalog in-memory only | ✅ Confirmed | process `Map` (`registry.ts:77`); new-consumer coverage rides one-shot best-effort `backfillPreCutover`. |
| B3 | delivery coords unconstrained | ✅ Confirmed | event-only FK (`schema.prisma:150`); `projectId`/`streamPosition` copies have no composite FK; the ordered cursor trusts the copies. |
| B4 | no dead-letter operator tooling | ✅ Confirmed | no `outbox:status`/`retry`, no operator audit, `/health` returns only `{ok,uptime}`. |
| C1 | socket fires for every event; no event-level intent | ✅ Confirmed | `deliveryFor: () => ({})` (`consumers.ts:23`); private drafts still invalidate; no `dispatchIntent` column. |
| C2 | no dispatcher; mode enforcement scattered | ⚠️ Partially true | ~30 direct `RealtimeGateway` calls, no `ExternalEffectDispatcher` — true. But mode **is** centralized in 3 guards; the exactly-one-sender risk is coverage drift (C1+C3), not a scattered toggle. |
| C3 | cutover not fail-closed | ✅ Confirmed (**active bug**) | bare env read (`registry.ts:24`); only `decisions` passes `notification` to `emitEvent` — **9 of 12 push notifications have no delivery**, so `OUTBOX_SENDER_MODE=outbox` silently drops them today. |
| C4 | boundary check evadable | ✅ Confirmed | filename filter + text regex (`boundary.test.ts:44,69`); evaded by non-scanned files, raw SQL, dynamic bracket access, accessor aliasing. |

## 3. Corrections to fold into the design (framing fixes)

The direction is right; these keep the rationale and test assertions accurate:

1. **C3 is understated — it is live.** Treat as an active drop of 9/12 pushes, not a fail-open risk. PR C must (a) add the missing per-command intents *and* (b) the seal, with a regression test proving the current drop at `cf038be`.
2. **B1 is understated — silent `wait`, not `blocked`.** A missing row never surfaces as `blocked`; the fix's test asserts the stronger "ordered+filtered ⇒ a noop row exists / no silent wait," making the schema comment's "operator-visible degradation" true.
3. **A1:** participant writes already run on the txn — the defect is the **three commits**, not writes on a fresh connection.
4. **A3:** the outbox notification *intent* is already in the txn, so the risk is a **missing legacy `Notification` row** (and a possible double-notify), not "notification without decision" (unreachable). The fix moves the legacy row into the txn *and* guards the double-send.
5. **A4:** an ID collision is a **P2002 crash**, not silent duplicate rows — but that crash currently lands after the core commit, which is what makes A1 concrete. Keep the advisory-lock fix; describe the mechanism accurately.
6. **B3:** no live coordinate mismatch exists (normal + backfill copy from the real event) — the defect is *absence of enforcement*. Composite FK is still the right fix.
7. **C1:** push body/roles **are** durably persisted (on `OutboxDelivery.payload`), just not on the event. Only the socket effect has no intent basis today. `dispatchIntent`-on-event remains a sound design; don't claim the push intent is currently ephemeral.
8. **C2:** justify `ExternalEffectDispatcher` by coverage-drift (C1+C3), not "mode is scattered" — enforcement is already centralized in 3 guards.
9. **C4:** client-only aliasing (`const db = tx; db.activity.create()`) does **not** evade — the model token is still captured. State the precise evasion set (non-scanned files, raw SQL, bracket access, accessor aliasing). The AST fix is correct.

## 4. Delivery shape

Three independently testable PRs, then **one consolidated independent review** against all three effective merges. The split is for reviewability, not partial acceptance; Task 8 stays blocked until the gate clears.

- **PR A — Atomic Command & Project Initialization** (design §5, corrections 3–5): one serializable `createProject` unit of work (project + membership + stream + `project.created` event + copied/instantiated structure + every participant write) with ≤3 attempts retrying only `P2034`, fixed-order advisory locks for the `ACT-`/`INSP-` namespaces, in-transaction structure revalidation that **rejects** malformed graphs (no `break`), and the one-step decision publish writing its canonical `Notification` inside the command txn (guarding the double-notify).
- **PR B — Gap-Safe Durable Outbox** (design §6, corrections 2, 6): `OutboxConsumerCatalog` durable obligation; `deliveryAction` (`dispatch`|`noop`) so every active consumer × every event has exactly one row; `DomainEvent.dispatchIntent`; a continuous lease-safe expansion scanner (subsuming `backfillPreCutover`); composite `(eventId, projectId, streamPosition)` FK; `outbox:status`/`outbox:retry` + operator-action audit + `/health` metrics.
- **PR C — External Cutover & Boundary Enforcement** (design §7, corrections 1, 7–9): machine-readable `external-effects` catalog keyed to the Task-1 command inventory + coverage version; `emitEvent` requires an `effectKey` + `dispatch`; single `ExternalEffectDispatcher`; fail-closed `outbox` startup gated on a persisted cutover seal; boundary CI rewritten as a TypeScript compiler-API scan over all runtime files with a precise evasion set + typed raw-SQL waivers.

Each PR: focused red→green live-PG tests (fail at `cf038be`, pass at head) + `pnpm check` + `pnpm --filter api test:integration` + both acceptance suites + `upgrade-proof`; migrations additive/diagnostic-first.

## 5. Execution order + review stops

```text
PR A (atomic commands + project init)          — its own draft PR
  -> PR B (gap-safe durable outbox)             — its own draft PR
  -> PR C (external cutover + boundary AST)      — its own draft PR
  -> CONSOLIDATED INDEPENDENT REVIEW  ⟵ single gate over A+B+C
  -> Task 8 resumes only after the gate clears
```

## 6. Verification battery (per PR)

```text
pnpm check
pnpm --filter api test:integration            # live PostgreSQL (vitan_pmc_test locally)
pnpm --filter web test:e2e
pnpm test:e2e:api                             # legacy sender mode
OUTBOX_SENDER_MODE=outbox pnpm test:e2e:api   # (from PR C)
bash apps/api/scripts/upgrade-proof.sh
```

## 7. Vision-alignment statement

```text
User decision improved: every pillar flow (client approval → decision lock, engineer sign-off
  → activity done, material mismatch → block, published decision → client notified) stays
  byte-for-byte identical — both acceptance suites pass unchanged through all three PRs.
Canonical fact owner: platform/events owns the durable event + per-consumer delivery obligation;
  orgs owns atomic project initialization; each module owns its manifest and its own tables.
Information flow: a mutation -> its owning-module write + audit + DomainEvent(+dispatchIntent)
  + one OutboxDelivery per active consumer, all in ONE transaction -> lease-safe relay -> effects.
Human work removed: none this remediation (structural correctness); it makes the Phase-3
  connectors trustworthy so Materials can subscribe instead of joining another module's tables.
Trust invariant: a project can no longer half-initialize; a canonical Notification can no longer
  commit apart from its command; every event carries a durable obligation for every consumer;
  an ordered projection can no longer silently stall on a filtered gap; cutover can no longer
  silently drop a push; and a foreign persistence write can no longer evade the boundary check
  by changing file type.
```
