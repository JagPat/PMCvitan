# Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` rebuild: review packet

**Base:** `main` `10713f1`. **Replaces:** #513 (closed at the two-finding-bearing-head limit; its
findings, and #512's, are folded here — see "Lineage"). **Board call:** the A/B rubric
(2026-08-28 §3), applied by JagPat on #514 on 2026-09-02 — *product beats paper*: ONE PR that is
the implementation unit plus its STATUS, not another STATUS-only fold.

## Vision alignment

One fact has one canonical owner, and a derived register is repaired from that owner, never edited.
4c-iii enabled `consultation` for every project while the drain prerequisite was unmet; a pre-4c-ii
worker still serving in that window could have written a v1-serialized DTO into the DERIVED
`decisions.inbox` register (the canonical `Decision` rows were never at risk), and no claimant audit
can establish whether one did. The remedy is therefore unconditional and mechanical — rebuild the
register from canonical truth under the current serializer — and this unit makes it a property of
the deployment rather than a step a person performs and reports: the loop clears its own directive
by merging, which is the autonomy rule as written.

## What this delivers

- **The step** (`apps/api/src/platform/projections/phase6-t4c-iiir.ts`) and its **compiled
  entrypoint** (`phase6-t4c-iiir.cli.ts`), run by `scripts/migrate.sh` as the LAST step on both
  success paths (ordinary and P3005) — after Prisma and the three seal verifiers, before
  `node dist/main.js`. A missing artifact is refused before Prisma, like every other artifact.
- **Identity from outside the connection.** `PHASE6_4C_IIIR_ANCHOR_PROJECT_ID` (a production
  `Project.id` that must exist in the connected database) and `PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS`
  (a floor the live count must meet), BOTH required — unset refuses before any database access.
  Checked on EVERY start, marker or not. Exactly `0` is the explicit fresh-install allowance (an
  empty database passes with no rebuild and no marker; the anchor is not consulted; a warning is
  logged); production sets 1 or more.
- **Exactly once across concurrent replica starts.** A transaction-level advisory lock inside ONE
  pinned interactive transaction spans marker-check → rebuild → verify → marker-write; the lock is
  released by exactly the commit that publishes the marker or by the rollback of a refusal. The
  loser blocks, then re-reads the marker under the lock.
- **Fail closed, success not execution.** `ok: true`, `corruptAfter: 0`, `failures: 0`, one result
  per project, `projects === count(Project)` read under the lock. Anything else — or a rebuild that
  throws — refuses naming the offending pairs, rolls back, writes no marker, exits non-zero.
- **The marker is an `OutboxOperatorAction` row** (`action = 'phase6.t4c-iiir.rebuild-completed'`),
  attributable to `deploy`, beside the rebuild's own invocation and per-pair rows. **No migration.**
- **The client refresh is structural**: the container restart that carries the rebuild disconnects
  every client and `useApiSync` refreshes on `connect`.
- **Operator surface:** `docs/RUNBOOK.md §P6-4C-IIIR`; `pnpm --filter api phase6:iiir`.
- **STATUS:** the drain directive cleared on JagPat's verbatim attestation; #511's false attribution
  withdrawn in place; the remediation directive recorded as delivered on this PR, still named in
  the Now block until the post-merge fold.

## Three places the implementation decided differently from the spec's wording

1. **A 0 floor exists.** The spec said "≥ 1". A first install has no project to anchor. `0` is an
   EXPLICIT allowance, never a default, logged loudly, and never a production value.
2. **Transaction-level, not session-level, advisory lock.** Same serialization; the guarantee is
   stronger — no instant in which the lock is released and the marker not yet visible.
3. **The marker is a ledger row, not a table.** The ledger the rebuild already writes to is the
   right home for its completion, and the unit ships no migration.

## Lineage — the findings this head folds

- **#512 round 1** — a prose "standing gate" cannot bind a resolver that parses only the Now YAML
  → the remediation is the Now-block `blocking_directive`.
- **#512 round 2 (F1) / #513 round 1** — a directive only the operator can clear parks the loop
  behind a human-only transition → the directive is an executable unit, this one, cleared by merge.
- **#512 round 2 (F2)** — "ran" is not "succeeded" → the success criterion.
- **#513 round 1 (F3)** — the success fields are vacuous against an empty result set → superseded
  by identity from outside the connection.
- **#513 round 2 (F4)** — a self-count is vacuous over an empty or wrong database → the anchor and
  the floor, deploy-configured, both required.
- **#513 round 2 (F5)** — an unserialized marker claim races between replicas and collides on the
  generation unique key → the advisory lock across the whole step, proven by a barrier-controlled
  concurrent start and by two real processes.

## Pre-review checks

- [x] `concurrency-serialization` — the lock precedes every read; the concurrent-start probe uses an
  explicit barrier (the loser OBSERVED waiting in `pg_stat_activity` before the winner is released)
  and asserts the terminal invariant directly (one invocation, one marker, one active generation
  per project).
- [x] `old-release-migration-compatibility` — no migration; the step runs after Prisma over a schema
  at head and reads only `Project`, `OutboxOperatorAction` and the projection tables.
- [x] `trigger-alternate-writers` — no schema or trigger change; the marker table's existing
  triggers (none on `OutboxOperatorAction`) are untouched.
- [x] `authorization-tenancy` — no read or write path for users; the step is a deploy-time operator
  action attributed to `deploy`.
- [x] `ci-reproduce-first` — the vacuity defect (#513 F4) reproduces by reading `rebuild-operations.ts`
  `run()` (every reported field derives from `project.findMany`); the race (#513 F5) by reading
  `rebuilder.service.ts` (`generation = max + 1`, no cross-process lock). The step's probes are new
  behaviour on a new step; each proof state is named by the finding it answers.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | none — no user-facing read or write path; a deploy-time operator action | the marker row carries `operatorIdentity = 'deploy'`; no route, guard or policy touched |
| civil-time-lifecycle | none | no dated logic |
| concurrency-idempotency | two replicas rebuild concurrently and collide on the generation unique key; a second start rebuilds again | the advisory lock across the whole step; suite probe 6 (barrier-controlled: loser observed waiting, zero rebuilds before release, then one invocation / one marker / `completed` + `already-completed`); proof STATE H (two real processes, same terminal invariant); probe 3 and STATE D (re-run is a no-op) |
| data-integrity-conservation | a vacuous "success" over an empty or wrong database sets the marker and serves an unrepaired register; a partial repair is accepted | identity from outside the connection — probes 1–2 and STATES A/E/F (refused, no marker); the success criterion — probe 4 (throwing, failed-pair, short-result rebuilds refuse with no marker; the next run completes); a corrupt generation repaired — probe 5 and STATE G |
| offline-reconciliation | a client keeps the stale view after the register is repaired | the restart that carries the rebuild disconnects every client; `useApiSync` refreshes on `connect` (`apps/web/src/data/useApiSync.ts`) — structural, no client change |
| ui-server-parity | none | no UI or contract change |

## Verification

- `pnpm --filter api typecheck` — clean; `pnpm --filter api build` — clean; the compiled artifact
  `dist/platform/projections/phase6-t4c-iiir.cli.js` present.
- `test/integration/phase6-t4c-iiir.test.ts` — **7/7** on the live test database.
- `scripts/phase6-t4c-iiir-production-runner-proof.sh` — **PASSED, STATES A–J**, through the real
  `migrate.sh` over scratch databases.
- Sibling proofs that run `migrate.sh`, each re-run alone after the change: schema-enforcement
  production-runner proof — PASSED; T45 production-runner proof — PASSED; schedule B1 baseline
  proof — **PASSED** (re-run ALONE after the change; an earlier run of all three IN PARALLEL failed two of them: this
  unit's own proof holds the compiled artifact aside in STATE I, and the proofs share `dist/` —
  a parallel-run artefact, not a defect; every proof passes run alone).
- `pnpm -s test:automation` — **299/299** (the CI wiring pin now covers the new proof step).
- `pnpm check` — **EXIT 0** (web 985/985 across 62 files; API 804/804 unit tests; typecheck and build clean).
