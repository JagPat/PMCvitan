# Phase 6 unit 4c-iii — the enablement transition: review packet

**Base:** `main` `2cec61f` (the drain-directive clearance)
**Plan:** `docs/superpowers/plans/2026-08-29-decision-workflow-4c.md` §D, review rounds 18/20/21/24/26
**Unit:** ONE migration + the reset-contract entry it obliges + probes. No service change, no contract change, no route change.

## Vision alignment

One fact has one canonical owner, and the capability row is that fact for "may this project consult?".
Until now it was a per-project pilot latch an operator opened. 4c-iii is the point where consultation
stops being a pilot and becomes part of the decision workflow — so the row stops being an operator's
choice and becomes a property of a project's existence, produced by the database for every create
path that ever runs. Nothing about the product's behaviour changes here: the gate reads stay in
place and authoritative, they simply always find a row. That is what makes this unit separately
revertible and what makes 4c-iv (the read removal) a pure service change.

## What this delivers

ONE migration, `20271120000000_phase6_t4c_iii_enablement`, doing three inseparable things in ONE
transaction in the order §D mandates:

1. **The reservation gives way to the PRESERVATION seal** (round 24). The 4c-i/4c-ii reservation
   refused every `consultation` row; the seal that replaces it refuses every *removal* of one.
   Three arms, by enumeration over the mechanism rather than over what a reviewer tried (round 26):
   row `DELETE`, row `UPDATE` of the sealed key, statement `TRUNCATE`.
2. **An `AFTER INSERT` trigger on `Project`**, so every project created from now on carries the row
   — produced by the *database*, so every create path produces it, the previous release's and the
   new one's alike. There is no build to upgrade before coverage is complete.
3. **…and THEN the backfill** for every existing project, `ON CONFLICT DO NOTHING`.

Order is load-bearing (round 21): `CREATE TRIGGER` takes ACCESS EXCLUSIVE on `Project` inside the
transaction, so a concurrent create blocks until commit and is covered by the trigger, or committed
earlier and is covered by the backfill. Backfilling first would leave a project visible to neither.

The migration closes by **checking its own claim**: if any project still lacks the row at that
moment, it raises and the transaction does not commit. The every-project guarantee is the unit, so
it is verified rather than asserted.

## The one deliberate deviation from §D, argued rather than taken silently

§D says the seal rejects "EVERY way PostgreSQL offers to remove that row". **This unit scopes the
DELETE arm to a LIVE project** and changes `ProjectCapability_projectId_fkey` from the delivered
`ON DELETE RESTRICT` to `ON DELETE CASCADE` to make that scoping exact.

**Why the literal reading is not viable.** After this unit's own backfill every project carries a
`consultation` row. Under `RESTRICT`, deleting a `Project` requires deleting that row first — which
an absolute seal refuses. The combination makes a `Project` row **undeletable forever**. That is
inert in production (nothing in `src/` deletes a project; they are archived via `archivedAt`) but
not in the repository, where **36 test files plus the shared `fixtures.ts` teardown** delete the
projects they create. §D declares this unit migration-only with no reset change scheduled, so the
literal seal cannot be delivered as specified without a repo-wide harness change this unit is not
supposed to carry.

**Why the scoped seal preserves the invariant.** The hazard the seal exists for is the split brain
between gate-reading and gate-blind instances **for a project**: a 4c-iv instance accepts a
consultation write while a still-serving 4c-ii/4c-iii instance refuses the same project because its
gate read finds no row. A project that no longer exists has no such state — no route resolves for
it, no instance can accept or refuse anything against it. Every removal that could produce the
hazard is still refused; the one that cannot is permitted.

**The discriminator is exact, not heuristic.** Under `CASCADE`, PostgreSQL performs the child delete
in a later command than the parent's, so the row trigger sees the parent already invisible; a direct
delete of the capability row leaves the parent plainly visible. Verified on PostgreSQL 16 and probed
from **both** sides (arm 1 refuses the direct delete; the cascade probe permits the project's own).

**What the deviation costs.** `ON DELETE CASCADE` is a real semantic change to a delivered Phase-3
FK: deleting a project now removes its capability rows instead of refusing. In production that path
does not exist. If a future unit introduces project deletion as a product operation, this is the
behaviour it inherits, and that is stated here rather than discovered later.

## The obligation this unit does carry

Round 29 established that a statement-level `TRUNCATE` arm brings `ProjectCapability` into the
sealed set and therefore into the reset contract. That obligation is discharged in the same unit:

- `TRUNCATE_SEALS` in `prisma/sanctioned-reset.ts` gains the entry — one line, and no suite changes,
  which is the whole point of that registry.
- `prisma/seed.ts` moves `ProjectCapability` from an unfiltered `deleteMany()` into `RESET_TABLES`,
  so the wipe runs through the sanctioned bypass that disables the seal by name inside its own
  guarded transaction.

"A seal whose only artifact is its migration is not finished" is the plan's own rule for 4c-0; it
applies here for the same reason.

## Probes that were RED at `2cec61f`

`apps/api/test/integration/phase6-t4c-iii-enablement.test.ts` — **8 of 9 fail at base**, verified on
a scratch database migrated to the base head. The ninth is the precision control, which must pass on
both sides: it asserts the seal never touches any other capability value, so a version of it that
failed at base would mean the seal was already too broad.

| Probe | What it pins |
|---|---|
| every pre-existing project carries the row | the database-wide invariant, non-vacuous (fixture projects exist before it runs) |
| a project created after the transition carries it | the `AFTER INSERT` trigger, through a create path naming no capability |
| a concurrent create still ends with its row | the property the trigger-first ordering buys |
| the reservation no longer refuses, and its trigger is gone | dropped, not merely bypassed |
| ARM 1 — direct DELETE refused | the seal's row arm |
| ARM 2 — re-key refused | `capability` is mutable with no freeze trigger |
| ARM 3 — TRUNCATE refused | row triggers never fire for TRUNCATE |
| the seal is PRECISE | the Board pin: no vocabulary whitelist |
| the seal is SCOPED TO A LIVE PROJECT | the deviation, from its permitted side |

**The backfill's own evidence is in `upgrade-proof.sh`, not here**, and the probe says so. A suite
runs after the migration, so its projects are covered by the trigger. `p1`/`p2` in the legacy
fixture were inserted before any migration ran — they are the only projects in the repository that
can prove a backfill happened. The new upgrade-proof arms assert exactly that, plus all three seal
arms, the permitted cascade, and precision, on the fully migrated legacy database.

## Delivered suites re-pointed, not deleted

`phase6-t4c-ii-consultation.test.ts` had three probes asserting a **gate-OFF project**, which this
unit abolishes. Each is rewritten to the truth that replaces it, because a probe left asserting the
old behaviour would be testing a state the product no longer has:

| Probe | Was | Now |
|---|---|---|
| P23 §D inertness | gate-off sibling 404s on both routes, shell offers no capability | the sibling reaches both routes with **no operator action**, and both shells offer the capability |
| F3 byte-identity | a gate-off project's approved decision gains neither key | an approved decision with **no thread** gains neither key — the rule the probe existed for, re-pointed at the subject that still exists |
| the reservation, both doors | INSERT and re-key refused | the **handover pin**: reservation trigger gone AND both preservation triggers present, asserted together |

The fixture no longer plants the pilot row through a disabled reservation — it asserts 4c-iii
produced the row for both projects. The teardown no longer deletes capability rows: the project
delete cascades them, which is the seal's permitted arm.

## Pre-review checks

- **concurrency-serialization** — the ordering IS the concurrency argument: `CREATE TRIGGER` takes
  ACCESS EXCLUSIVE on `Project` inside the transaction, so no create can land between the backfill's
  snapshot and the trigger's existence. Probed by a two-connection concurrent create.
- **old-release-migration-compatibility** — the transition is produced by the DATABASE, so a
  still-serving previous release creates projects with the row exactly as the new one does. The gate
  reads are unchanged and still authoritative; behaviour does not change, which is why this unit is
  separately revertible.
- **trigger-alternate-writers** — the seal's three arms are the alternate-writer answer, each
  hostile-probed in the integration suite and again in upgrade-proof on the migrated legacy DB.
- **authorization-tenancy** — no read or write path changes. The row is per-project and produced
  per-project; no cross-tenant surface is touched.
- **ci-reproduce-first** — 8/9 RED at `2cec61f`, GREEN here; the ninth is the stated control.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | none — no authorization surface, route or query changes; the row is created per-project by a per-row trigger | full integration battery; the 4c-ii suite's authorization probes unchanged and green |
| civil-time-lifecycle | none — no dated or lifecycle logic is touched | as above |
| concurrency-idempotency | a create landing in the gap between backfill and trigger would be covered by neither, and its routes would stay gate-off until 4c-iv despite the every-project claim | trigger created BEFORE the backfill takes ACCESS EXCLUSIVE on `Project` for the transaction; two-connection concurrent-create probe; the migration's closing DO block refuses to commit if any project lacks the row |
| data-integrity-conservation | the row's ABSENCE is the hazard once the reservation is gone — a deleted or re-keyed row makes a gate-reading instance refuse a project a gate-blind one accepts | the preservation seal in all three arms (row DELETE, row UPDATE of the key, statement TRUNCATE), each RED at base and probed twice — integration suite and upgrade-proof over the migrated legacy database |
| offline-reconciliation | none — no client, queue or command path is touched | no `src/` change in this unit |
| ui-server-parity | the client reads `capabilities` from the shell, so a row the server has and the client does not (or vice versa) would render affordances that 404 | both shells asserted to contain `consultation`; the gate reads are unchanged on both sides and retire together in 4c-iv |

## Verification

Recorded per head, and stating what did NOT run as plainly as what did.

**Head `<this head>`** (base `2cec61f`):

- `pnpm check` — **EXIT 0**. Web 985/985 across 62 files; API 804/804 across 58 files; both builds clean.
- Full integration battery — **102 files / 1382 tests, 0 failures, 0 skipped**, on a database
  dropped and re-migrated from this branch's own migrations immediately beforehand.
- `scripts/upgrade-proof.sh` — **PASSED**, including all nine new 4c-iii arms. The load-bearing one
  is `the backfill reached EVERY pre-existing legacy project`: `p1`/`p2` were inserted into the
  legacy fixture before any migration ran, so they are the only projects in the repository that can
  evidence a backfill rather than the trigger.
- Focused reproduce-first — **8 of 9 RED at `2cec61f`** on a scratch database migrated to the base
  head, 9/9 GREEN here. The ninth is the stated precision control.
- Automation suite — 296/296.

**Two tripwires this unit had to advance, both deliberate and both caught by CI-equivalent checks
rather than by inspection:**

- `scripts/pg-parse.test.mjs` corpus pin 95 → 96. The migration parses under PostgreSQL's own
  grammar; only the count needed moving, which is what the pin is for.
- `sanctioned-reset-coverage.test.ts` — the ARM-3 `TRUNCATE` probe is registered in `PROBE_FILES`,
  not routed through the helper. Routing it through would disable the very seal under test and
  leave a vacuous green assertion, which is precisely what that tripwire exists to prevent.

**One pre-existing assertion improved rather than bumped.** `upgrade-proof.sh` asserted the
consultation family by a bare `LIKE '%t4c%'` COUNT, which failed here at 12 vs 14 — for a reason
that has nothing to do with whether 4c-i's seals are armed. It is now asserted BY NAME, which the
file already argued is strictly more precise for its retry probe: a missing seal still fails, and a
renamed one now fails too, where a count silently absorbed it. A second assertion pins that the
reservation is gone.

**NOT RUN, and not claimed: the two browser e2e senders.** This sandbox's pre-provisioned Playwright
browsers are build `1194` while the pinned `@playwright/test` requires `1228`, so every browser test
fails at launch (`Executable doesn't exist … chrome-headless-shell`) regardless of the diff —
23 failures, all identical, all before any test body. Installing browsers is not available here. CI
is the authority for these two gates. The exposure is low and checkable rather than asserted: this
unit changes no service, route, contract or UI file, and **no e2e spec in the repository references
`capabilities` or `consultation`** (`grep` over `apps/web/tests/e2e-api/` returns zero files). If CI
disagrees, that is this unit's to fix.
