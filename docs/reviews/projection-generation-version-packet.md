# Projection generation catalog version — the serve-side fence (implementation packet)

`Replaces: #497`

## Vision alignment

One fact has one canonical owner, and a read must never present something as authoritative that
is not. A projection generation is a cache of canonical truth; this unit makes it record **which
code built it**, so a read can tell a generation this release materialized from one an older
release did. Nothing about the product changes — the machinery is installed, probed, and inert
until a consumer's serializer actually changes.

## Review unit

- Base: `main` `1d6c4ff1`
- Scope: **only** the two findings the closed PR #497 never resolved (P1, P2 below). None of that
  unit's consultation work is carried here.
- One architectural concern: "a generation knows which serializer wrote its rows, and an older
  one is not served."
- Migration/service seam: **inseparable** — the stamp trigger and the serve-gate comparison are
  two halves of one rule, and shipping either alone is either a column nothing reads or a read
  against a column that may be NULL.

## Why this exists

`ProjectionGeneration` rows carry no record of the code that materialized them, so a projection
read cannot distinguish a generation built by the running release from one built by an older
release whose serializer produced a different DTO shape.

The concrete hazard is the standalone `projection-rebuild` CLI. It constructs `ProjectionRebuilder`
and registers projection consumers **directly** — it never calls `syncConsumerCatalog`, so the
startup contract assertion that fences out a stale binary taking up service never runs for it. A
previous release's CLI, run against a database an upgraded release is serving, rebuilds a
projection with **its** serializer and ACTIVATES the result: a read-model missing whatever the
newer serializer adds, swapped in by a *supported* command, at exactly the moment something already
looks wrong enough for an operator to be reaching for a rebuild.

## The two findings this carries (from the closed #497, head `1c719152`)

The obvious fence is a `NOT NULL` column with **no default**: the new code supplies it, and a
binary that does not know the column exists cannot insert at all. That was the shape in #497, and
it is wrong in two ways — both ordinary documented operations, not edge cases.

### P1 — it breaks a still-running previous release

`scripts/migrate.sh` applies migrations **before** the new processes start, so there is a window in
which the column exists and the OLD binary is still serving. In that window the old
`lockActiveGeneration` lazily bootstraps a generation for any `(consumer, project)` that has none
yet, with an INSERT naming no version. A no-default `NOT NULL` rejects it and **stalls that ordered
projection** while the previous release is still supposed to be working. Backfilling existing rows
does not help — the exposed case is precisely the pair that has no row yet.

### P2 — it breaks the documented 4a repair

`20270810000000_phase6_t4a_withdraw` is rerunnable **by design**; the RUNBOOK prescribes replaying
it to repair a stale decisions projection. Its repair block inserts a replacement generation with an
**explicit column list**, which cannot name a column added later, so against a no-default `NOT NULL`
the replay fails instead of repairing. Merged migrations are not edited to accommodate later ones,
so the later one accommodates.

## The correction

**The refusal moves to the read.** `readServableGeneration` — the one gate every module's projection
read already crosses — returns `null` for a generation stamped below the running code's compiled
`catalogVersion`, and the caller falls back to the canonical live read. That is the same answer the
function already gives a lagging or blocked generation, and the live read is always current, so the
fallback costs correctness nothing. The old CLI can still build and activate an old-serializer
generation; what it cannot do is get it **served**, which is the harm.

**The stamp is a trigger, not `DEFAULT 1`.** A default fixes P1. It does not fix P2 in the way that
matters: the 4a repair's replacement generation COPIES its rows from the generation it retires, so
its true version *is* that generation's; stamping it `1` leaves a correctly repaired projection
permanently unservable and turns a targeted, cleared repair into "repair, and then run a full
rebuild as well". So `ProjectionGeneration_stamp_version` inherits in exactly the case where
inheriting is true:

> an INSERT that names no version, in a transaction that has **already retired** a sibling
> generation of the same `(consumer, projectId)`, takes that sibling's version; every other
> un-versioned INSERT takes 1.

This is structural, and the structure was **checked rather than assumed**: `ProjectionRebuilder`
INSERTs its new generation in one transaction (`rebuilder.service.ts:72-80`) and retires the
incumbent in a **later** one (`:96-116`) — logic that predates this change, so the previous
release's CLI has the same shape and can never satisfy the same-transaction condition; it always
stamps 1, which is what keeps it refusable. The relay's lazy bootstrap retires nothing. The 4a
repair retires-then-inserts in a single transaction and is the only writer that inherits. `xmin` is
the right instrument for precisely this claim — "written by the transaction that retired the
predecessor" — and is asked to prove nothing wider.

## What this unit does NOT do

- **It bumps no consumer's `catalogVersion`.** Every consumer stays where it is, so the serve-side
  comparison is false for every generation on every deployed database and **no read changes
  behaviour today**. The first consumer to change its serializer arms the fence, in the migration
  that changes that serializer.
- **It carries none of #497's consultation work.** The commands, routes, audience widening,
  projection thread, push families, UI and approval-provenance seal return as their own unit, on a
  `main` that already has this fence.

## Pre-review checks

1. `pnpm check` — **EXIT 0**: automation (pg-parse corpus pin 93→94, the one tripwire this unit
   advances), web 976/976 across 61 files, API 804/804 across 58, lint/typecheck/builds clean.
2. Focused reproduce-first — `test/integration/projection-generation-version.test.ts` **4/4**
   against live PostgreSQL.
3. Full integration battery on a pristine migrated database — recorded in the PR body.
4. `scripts/upgrade-proof.sh` — **PASSED**, with four new arms on the fully-migrated database.
5. Tripwires advanced: the pg-parse corpus pin only. No route, command, event, manifest, policy or
   dispatch-site count changes — this unit adds no surface.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | none — the fence is per `(consumer, projectId)` and changes no audience; a refused generation falls back to the live read, which applies the same per-viewer rule | the 4a suite's pmc/engineer slice equality across the repair replay, unchanged |
| civil-time-lifecycle | a repaired generation stamped wrongly is unservable forever, silently degrading a cleared repair into "repair then rebuild" | the three DELIVERED 4a repair probes go red when the stamp trigger is dropped, and green with it — including the non-UTC arm |
| concurrency-idempotency | the stamp must not depend on statement order within the writer's transaction, and must not inherit across transactions | the inheritance probe asserts BOTH halves on one fixture: a rebuild beside an already-retired v2 sibling takes 1; a same-transaction retire-then-insert takes 2 |
| data-integrity-conservation | an old-serializer generation served as authoritative presents a read-model missing what the newer serializer adds; a version acquired by omission would understate or overstate what built a row | the serve-gate probe (red without the one-line fence); `NOT NULL` with NO DEFAULT asserted, so nothing acquires a version by omission; the backfill reads the PERSISTED catalog rather than defaulting |
| offline-reconciliation | not applicable — no client surface, no outbox op, no command | no client change in this unit |
| ui-server-parity | a read that refuses a generation must not show less than the live read would | the refusal returns `null`, which every caller already handles by reading live; the 4a slice-equality probes cover the served result |

## Evidence, by removal rather than by argument

- Dropping `ProjectionGeneration_stamp_version` turns **5** tests red: the three DELIVERED 4a
  repair probes (P2, reproduced against `main`'s own tests) plus both new stamp probes.
- Removing the one-line serve fence turns the serve-gate probe red
  (`expected { id: … } to be null`).
- `upgrade-proof.sh` exercises all of it on the **fully migrated** database — the state that
  matters, and the one its pre-existing generation insert never reaches, since that runs before
  this column exists.
- `projection-rebuild-upgrade`'s planted legacy generation is stamped at the consumer's CURRENT
  compiled version, with the reason recorded: that probe is about a COMPLETENESS defect (a
  caught-up generation holding a non-empty subset) which is orthogonal to serializer version, and
  its rows go through the real serializer. Stamping it lower would let the new fence refuse it
  before the subset was ever reached, quietly converting a cleared probe into a test of something
  else.
