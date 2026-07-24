# Phase 4 Task 2 — correction ROUND 3 review packet (coherent requisition terminal state + enforced T2C preflight)

**Directive:** fix-forward the round-2 re-review's terminal-state finding — a post-closure default left a
CLOSED requisition containing an OPEN child line — and enforce the T2C preflight in the production
runner. Reproduce first. Do NOT roll back PR #222; keep migrations `20270201000000` and `20270205000000`
byte-for-byte unchanged; do NOT begin Task 3.

- **Base / merged `main`:** `c09b1ac` (merge of PR #222)
- **Correction branch:** `claude/phase4-task2-correction3` (from `main` `c09b1ac`)
- **No migration change** — SERVICE-logic (one method + one helper) + an ENFORCEMENT edit to
  `scripts/migrate.sh` + a new production-runner proof + tests/docs. The `t2c` repair engine and its
  abort matrix are UNCHANGED.

## The terminal-state defect (reproduced RED at `c09b1ac`)

Round 2 made `closeRequisition` derive live allocation, but a default that lands AFTER a clean closure
still reopened the child line to `open` while the parent requisition stayed `closed` — an incoherent
terminal state (a closed parent containing an open, uncovered child).

`test/integration/phase4-t2-correction3.test.ts` PROBE (RED at `c09b1ac`): commit capacity → close the
requisition (line fully covered → closes) → default the commitment. RED result: requisition `closed`,
line `open`. GREEN after: requisition reopened to `approved`, `closedAt` cleared, line `open`.

## The policy (one coherent terminal-state rule)

When a default REMOVES required coverage, `defaultCapacity` atomically reopens the requisition
(`closed → approved`, `closedAt` cleared, the affected line left `open`), under the same
`lockProjectReadiness` advisory lock, via a CAS transition, with attributable audit evidence
(`labour.requisition.reopen`). A requisition still fully covered by another live PO is left closed.

- new `reopenRequisitionIfUncovered(tx, projectId, requisitionId, actor)` — only a `closed` parent can
  become incoherent; it derives `liveAllocation` per non-cancelled line, and reopens only when a line is
  uncovered, via `updateMany({status:'closed'} → {status:'approved', closedAt:null})` (CAS — a concurrent
  transition never double-applies) + `recordAudit`.
- `defaultCapacity` calls it after `refreshOrderedFlag`, with the defaulted PO line's `requisitionId`.

### Tests (`phase4-t2-correction3.test.ts` 2/2 + `phase4-t2-correction.test.ts` barrier)

- reproduce probe (single-line): post-closure default reopens the requisition; line `open`, parent
  `approved`, `closedAt` null.
- multi-line: defaulting line A reopens the requisition; line A `open`, sibling line B still `ordered`.
- deterministic barrier `default vs closeRequisition`, BOTH orderings, asserting parent AND child:
  - default wins → close REJECTED (409); parent `approved`, `closedAt` null, child `open`;
  - close wins → the later coverage-removing default REOPENS (parent `approved`, `closedAt` null, child
    `open`) — never a closed parent with an open child.
- same-key replay: the coverage-removing default (with an idempotency key) reopens with EXACTLY ONE
  `labour.requisition.reopen` audit; replaying the SAME key returns the cached success — no second
  transition, no second audit.

## Enforced T2C preflight in the production runner

`scripts/migrate.sh` now runs the COMPILED `dist/labour/t2c/t2c.cli.js preflight` AFTER the compiled T45
preflight and BEFORE `prisma migrate deploy`:

- a missing compiled artifact FAILS CLOSED (a broken build never deploys);
- a dirty ELIGIBLE database prints the named report and exits non-zero, so Prisma NEVER starts and
  `20270205` is never recorded as failed;
- a fresh / pre-Task-2 database ("not applicable") and a clean / already-applied database continue.

## Production-runner proof (`scripts/phase4-t2-correction2-production-runner-proof.sh` — PASSED)

Drives the ACTUAL `scripts/migrate.sh` (compiled artifacts, never tsx) over every required state:

1. fresh empty → T2C preflight not-applicable; migrate deploy applies all;
2. pre-Task-2 (LabourPurchaseOrderLine absent) → not-applicable; migrations run;
3. clean pre-correction Task-2 → applicable + clean; `20270205` applies;
4. dirty **F5 / F3 / F2 / F4** (each on its own clone): the runner NAMES the finding, exits non-zero,
   `Applying migration` never appears, and `20270205` is never recorded; the compiled `t2c` repair then
   lets the SAME runner redeploy cleanly;
5. already-corrected → applicable + clean + `state: applied`; a clean no-op.

## Gate battery

- `pnpm check` — EXIT 0 (web 432/432, API 642/642; build clean).
- Full PostgreSQL integration — **65 files / 561 tests** on a clean DB (+3 for `phase4-t2-correction3.test.ts`;
  the barrier suite gains the reopen assertions + the same-key replay test). (An interleaved run over a
  DB polluted by the runner/abort proofs' scratch activity showed the documented outbox/cutover-singleton
  flake; the suite is 561/561 on a clean run and the affected suites pass in isolation.)
- `scripts/upgrade-proof.sh` — PASSED (no migration changed; every prior seal survives).
- `scripts/phase4-t2-correction-abort-proof.sh` — PASSED (round-1 F5); `scripts/phase4-t2-correction2-abort-proof.sh` —
  PASSED (round-2 F5/F3/F2/F4 independent + fabrication refusal) — the abort matrix is PRESERVED.
- `scripts/phase4-t2-correction2-production-runner-proof.sh` — PASSED (see above).
- `test:e2e:api:allmodules` — 31/31; `:outbox` — 25/25 (6 skipped, the documented outbox-mode set).

## Scope

Service-logic (`defaultCapacity` + the `reopenRequisitionIfUncovered` helper) + the `migrate.sh`
enforcement edit + a new production-runner proof + tests/docs only. Migrations `20270201000000` /
`20270205000000` and the `t2c` repair engine are byte-for-byte unchanged. Task 3 (§F bound-3 +
allocation/attendance/work facts) remains blocked.
