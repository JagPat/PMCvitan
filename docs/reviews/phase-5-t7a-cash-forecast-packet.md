# Phase 5 Task 7A — the §J cash forecast, and the eighth rebuildable projection

Base: `main` `95adf15` (the Task-6 completion record, after 6A/6B-i/6B-ii/6C
merged and were cleared).

## Vision alignment

A construction practice does not run out of money because it made a bad decision.
It runs out because seven different obligations were each visible somewhere and
nowhere together: a purchase order outstanding, material received and not yet
billed, a claim sitting unverified, a certificate approved but unpaid. Phase 5
built each of those facts canonically. §J is the section that adds them up.

The whole difficulty of adding them up is that the obvious way is wrong. A ₹100
order that has been delivered and billed is not ₹300 of exposure — it is ₹100 that
has moved twice. So **every §J bucket is a RESIDUAL**: each subtracts the one
downstream of it, and the seven partition the money rather than counting it. Two
earlier revisions of that section got `budget` wrong in opposite directions before
landing on the category correction — budget is the CEILING the six exposure
buckets are measured against, never a seventh addend.

This unit completes the arithmetic (the last two buckets), proves the partition,
and stores the result as the eighth rebuildable projection so the Inbox, the
dashboard and the portfolio roll-up can ask "what does this project owe" without
folding four modules on every page load.

## Review unit

- Base SHA: `95adf15`
- Scope: ONE architectural concern — §J's money picture, server-side only.
- Split: **7A is server, 7B is the surface.** 7B carries the §M Commercial hub,
  the real-browser pilot chain in both capability states, and the consolidated
  Phase-5 packet — the FINAL Phase-5 review stop. No frontend is in this PR.
- Not here: nothing from Task 6 is reopened.

## What is in it

1. **The last two §J buckets.** `approved` is `APPROVED − PAID` and `paid` is
   `PAID` — §J calls the latter "the only raw fold, because paid cash is where the
   money stops". Naming `approved` after `APPROVED(bill)` would report ₹140 across
   two buckets for one ₹100 payable with ₹40 paid, which is the defect the residual
   rule exists to prevent, arriving at the last two buckets in the chain.

2. **`exposure` is the sum of the six; `headroom` is `budget − exposure`.** The
   sum is rounded ONCE from the full-precision total, and headroom derives from
   that rounded figure rather than from six separately-rounded buckets whose
   half-paisa errors could add to a phantom cent of breach.

3. **ONE serializer.** `CommercialBudgetQuery.serializedPositionsFor` now produces
   the per-head rows for BOTH the live `commercial.budget` read and the forecast.
   The projection therefore cannot disagree with the live read about what a bucket
   MEANS, because it does not know: it asks. `computeCashForecastDto` adds exactly
   one thing on top — the project roll-up.

4. **The EIGHTH rebuildable projection** (`commercial.cash-forecast`),
   recompute-only, deriving NO domain events. A rebuild emits zero events and zero
   notifications. `live == projection == rebuild` holds by construction because
   every path — the ordered consumer, the rebuild seed, the read, and the operator
   rebuild diagnostic — calls `computeCashForecastDto`.

5. **The `commercial.cash-forecast` read**, capability-gated, serving the
   projection when its generation is servable and falling back to the LIVE compute
   otherwise. `refreshedAt` is the projection's row timestamp and is NULL on the
   live path — a live answer is honestly undated rather than stamped `now`.

6. **Commercial announces its money movements** (`commercial.money_moved`), which
   is round 4's correction and is described in its own section below.

## Commercial's ONE event, and why the write-through path is gone

The first four heads of this unit refreshed the forecast WRITE-THROUGH, on the
strength of `commercial.producesEvents: []` — justified in the manifest since Task
1 as *"an internal accounting fact with no external effect and no consumer"*.

That produced **six review findings from one place** across four rounds: an
overwrite race, a discovery race, a false `corrupt` verdict, an unlocked repair
sweep, a refresh obligation hung on the wrong predicate, and finally a genuine
lock-order inversion between the rebuild's activation barrier and the relay.

They were not six defects. `docs/reviews/pr-295-convergence.md` names the one:

> The platform's projection machinery assumes **every input to a projection is
> announced by a domain event.** Seven projections satisfied it, so it was never
> written down.

Three mechanisms rest on it, and each breaks silently without it — `diagnose`
freezes its window by locking `ProjectEventStream` (which only stops writers that
emit); a rebuild's catch-up repairs the seed's blind spot by REPLAYING EVENTS
(which repairs nothing when there are none); staleness is otherwise invisible.

**The Task-1 justification had two grounds, and only one of them stopped being
true.** *No external effect* still holds. *No consumer* stopped holding the moment
§J stored a forecast. So round 4 makes the declaration match reality rather than
building a fifth lock to defend it:

- commercial emits ONE event, `commercial.money_moved`, from the same DERIVED seam
  (`evaluate`) plus the three seams that write a forecast input without moving
  headroom;
- the catalog entry is **weightless** — `invalidate: false, push: null` — so
  nothing is sent to any client, no command gains an `ExternalEffectDispatcher`,
  and commercial's services stay at **zero dispatch sites** (the cross-module
  tripwire pins this). The event exists for the durable `OutboxDelivery` that
  `emitEvent` materializes in the writer's own transaction, and nothing else;
- the write-through path, the per-(project, consumer) advisory lock,
  `cashForecastLockKey`, `lockCashForecast`, the `Rebuildable.lockFor` hook and its
  `diagnose` plumbing are all **deleted**. `refreshCashForecast` takes a REQUIRED
  `generationId`, computes and upserts, and takes no lock at all.

This projection is now ordinary. Every mechanism above works for the same reason
it works for the other seven.

**CLOSURE E** (`module-registry.test.ts`) changed shape with it. Its first version
demanded a compensating `lockFor` from an event-less owner; it now requires that
every rebuildable projection's owning module ANNOUNCES its facts, and says in its
own failure message that this is necessary rather than sufficient. Both sides
derived; mutation-tested RED against the round-3 tree.

## Where the seams are, and why they are DERIVED

The announcement seam is **not a list of writers**. It is
`CommercialBudgetService.evaluate`, and that is a derivation:

> §B headroom is `BUDGET − Σ(the six §J exposure buckets)`. So *"this write moved
> headroom"* and *"this write moved a §J bucket"* are **the same predicate** — not
> two lists that happen to agree today.

Every money writer already calls `evaluate`; CLOSURE 2 (`FOLD_INPUTS`) fails the
build if one does not. So a writer cannot satisfy §B and forget §J: there is one
call site and one rule.

Three other seams exist and each is there for a stated reason rather than by
enumeration: `commercial.costHead.define` and §L activation write `CostHead` rows
without moving money, and the two partition-only payment writes move a bucket
without moving the total.

**CLOSURE C** pins that there is no fifth. It extracts the `tx.<model>` reads from
the compute path's own method bodies, requires every model to be CLASSIFIED
against the write path that announces it, and then SCANS every commercial file for
a write to a classified model — a classification naming a method is a claim about
one site, and the obligation is about all of them. A model added to the compute
without a classification fails; a classification whose named site no longer
announces fails; a classification for a model the compute no longer reads fails.
All three arms were mutation-tested RED before this was committed.

### The seam was ALMOST right, and the gap was found by a probe rather than a review

7A's first spelling hung the refresh off `evaluate` and stopped there. That is wrong, and
the way it is wrong is instructive: *"moved headroom"* and *"moved a §J bucket"* are
**almost** the same predicate, and they come apart at exactly the `partitionOnly` rows.
Paying moves `approved` into `paid` without moving the total, so it is rightly exempt from
§B's evaluator — and was therefore silently exempt from §J too.

The consequence would have been a stored forecast reporting money as authorised-and-unpaid
forever after it left the bank — and at the time, with **no event a consumer could have
missed**. That is the exact failure mode the RUNBOOK note above describes, arriving inside
the unit that wrote the note, and it is one of the six that round 4 traced to a single
cause.

The fix keeps the derivation and moves the obligation to the whole of the table it was
already using: `payments.record` and `payments.reverse` announce directly, and CLOSURE 2 now
pins that **every** `FOLD_INPUTS` writer announces — through an evaluator or directly —
rather than only the non-exempt ones. A partition-only row is exempt from §B, never from §J.
Mutation-tested RED at both writers; PROBE 39 proves it at runtime.

### `APPROVED` is partition-only too, and a 6A probe is what proved it

Task 6A classified `APPROVED` as a headroom mover and asserted, in PROBE 20, that approving
CLEARS the exception it healed. That was true against 6A's fold: §J's subtraction was in
place with nowhere for the subtracted money to go, so approving genuinely lowered the total.

7A added the `approved` bucket §J always specified, and PROBE 20 failed immediately. **The
failure is the correct answer.** Money a practice has authorised is money it still owes; a
budget that healed the moment a payable was approved would report room exactly when the
practice committed to spending. `certified-payable` and `approved` sum to `NET_PAYABLE −
PAID` for every value of `APPROVED`, which is the same identity `PAID` already carried one
step down the chain.

So `FOLD_INPUTS` reclassifies the row, PROBE 20 now asserts the partition (and that the
standing exception is neither cleared nor re-raised by an exposure-neutral write), and the
`payment_approval` §B label stays wired for the reason `measurement` does — the closure's
rule is mechanical, and carving out an exception on the strength of my own arithmetic is
what went wrong twice in Task 2.

### CI then found root A twice more, in the operator-rebuild suites

Adding the eighth projection made two integration suites fail, and both for exactly
the reason CLOSURE C exists. `projection-rebuild-operations.test.ts` asserted the
default run's consumer set against a **hand-written list of seven**, and
`projection-rebuild-upgrade.test.ts` did the same through a constant literally
named `ALL_FIVE` **that already held seven entries**.

The name is the whole argument. Both assertions are about COMPLETENESS — *"the
default operator run skips no projection"* — and a hand-kept copy of the registry
answers a different question: *"does the run cover the ones I remembered."* That
question stays green while a new projection goes unrebuilt on every production
upgrade, which is precisely the defect the assertion was written to catch.
`ALL_FIVE` had gone stale twice before this unit found it a third time.

Both now derive the expected set from `REBUILDABLE_PROJECTIONS`, with the registry
pinned by name so "derived" cannot decay into "whatever happens to be registered,
including nothing". Recorded rather than quietly fixed, because the count is the
point: that is occurrence six and seven of the same root inside one phase, and the
second one was carrying its own staleness in its identifier.

That framing is `docs/reviews/pr-289-convergence.md` root A applied ahead of a
finding rather than after one. This phase has found *a hand-written list standing
in for a derived set* five separate times, most recently inside the very file
corrected for it the round before. The meta-lesson recorded there is **fix the
class, not the member**, and a sixth instance was not worth the fold it would have
saved.

## `building` generations — how round 4 made the question go away

Rounds 1–3 spent three heads on this: a commercial write landing between a
rebuild's canonical seed and its activation barrier emitted nothing for the
catch-up phase to apply, so the rebuild would activate a generation holding a
pre-write money picture — **the repair making the projection worse**, which is the
one thing a repair must never do. The successive fixes were a row lock, then an
advisory lock with discovery under it, then a total order over that lock and the
stream row.

With the announcement, the window closes itself. A commercial write allocates a
stream position, so it is either **before** the seed (visible to its compute) or
**after** it (position > `seededThrough`, replayed by catch-up — which is what
catch-up is for). `refreshCashForecast` writes exactly ONE generation, the one its
caller is responsible for, and takes no lock; the seed's `seededThrough` is read
BEFORE the compute so it can only under-state what the seeded row contains, never
over-state it.

## Codex round 1 — five findings on head `484cb5f`, all fixed forward

Every one is real, and four of the five are the same shape: **a claim about the world that no
mechanism was checking.**

**F1 (P1) — the labour PO event names.** `FORECAST_EVENTS` spelled the family `labour_po.*`; the
catalog declares `labour.po.*`. The consequence was worse than a missed refresh: an unrecognised
type is a NO-OP delivery, and a no-op **still advances the ordered cursor to the stream head**. So
the generation stayed SERVABLE while silently omitting every labour commitment, and the read served
it as authoritative rather than falling back live — a money page confidently short by every labour
order on the project. Root A once more, in a hand-typed list of strings.

The fix is the TYPE: the array is `readonly DomainEventType[]`, so a name the catalog does not
declare cannot be written there at all. CLOSURE D pins the behaviour a type cannot — that every
declared type actually resolves to `dispatch`, that the four repaired names are present, and that an
unrelated event is still a no-op. Mutation-tested RED.

**F2 (P1) — the upgrade path.** Completing §J's partition RAISES exposure on every head carrying an
approval, because exposure gains back exactly the `APPROVED` that `certified-payable` subtracts. A
head that was breached, approved, and had its exception CLEARED by 6A's code now reads
`headroom = -50` with nothing open — the budget read recomputes headroom live so the number is
right, but the Inbox counts the register and misses the breach until some unrelated write touches
that head. Which could be never.

No migration can repair it: the fold spans procurement, inventory, labour and four commercial folds,
none of it expressible in SQL. So the repair is an operator sweep, `commercial:reevaluate`, shaped
like the projection rebuild beside it in the runbook — idempotent (one open exception per head is a
partial unique; a healthy database is a no-op), attributable (audited invocation, and every row
carries the new `fold_correction` label), and complete (every head of every commercial-enabled
project, derived from the capability rows). It needed a NEW `HeadroomMover`: none of the ten
existing labels describes *"the definition of exposure changed"*, and reusing one would be exactly
the label drift §B's round 4 removed. All three enumerations of the label set — the DTO union,
`HeadroomMover`, and the DB CHECK — widen together, which CLOSURE 10 already pins.

**F3 (P1) — the activation CLI.** `evaluate` now refreshes, so every caller needs
`bindCashForecastDeps`. `capability.cli.ts` builds its own graph outside the Nest container, so
activating a project **with live PO lines** — the exact case §L exists for — threw
`cash-forecast projection deps not bound` before the capability row could commit. The comment beside
that graph already said why it must match the container's: *"a CLI that builds a DIFFERENT object
from the one the container builds is how a code path stops being the path that was tested."*

**F4 (P2) — activation's own `CostHead` writes.** CLOSURE C classified `costHead` as "refreshed by
`commercial.costHead.define`" and checked that one method. But `CommercialActivationService.activate`
upserts `CostHead` rows itself, and with no live PO lines it never reaches `evaluate` either — so a
project with a servable forecast row from earlier foreign events kept being served the old empty
head list.

The fix is not just the call. **CLOSURE C now DERIVES the writer sites**: every commercial file is
scanned for a write to a classified model, and each writing file must refresh. A classification
naming a method is a claim about one site; the obligation is about all of them. Mutation-tested RED.

**F5 (P1) — the rebuild-seed race.** The seed and a write-through refresh both target the same
`building` generation, and compute-then-write let them interleave: the seed computes an old picture,
a concurrent payment commits the new one, the seed resumes and upserts its older DTO over it.
Catch-up cannot repair that, because the commercial write emitted no event to replay — so the
rebuild would ACTIVATE a stale generation, the repair making the projection worse. `refreshCashForecast`
now takes the target generation rows `FOR UPDATE` **before** computing, in ascending `id` order so
the seed (one generation) and the write-through (up to two) acquire the shared subset in the same
sequence and cannot deadlock.

## Codex round 2 — five more findings on head `f345d2c`

Round 1's fixes were accepted. Round 2 found five more, and three of them are the same lesson
arriving from a different direction: **a projection whose module emits no events falls outside every
serialization the platform provides by default.**

**Round-2 F1 (P1) — target discovery outran generation creation.** Round 1's F5 fix locked the
generation rows it had ALREADY FOUND, which closes the overwrite race and leaves a second one open:
the rebuilder allocates its `building` generation in its OWN transaction, so a row can APPEAR
between a writer's discovery and its commit. Locking rows cannot prevent a row from appearing. The
write would then refresh only the id it captured, the seed would have run on pre-write money, and
the stale generation would activate with nothing for catch-up to replay.

The fix replaces the row lock with a per-(project, consumer) **advisory lock taken as the first
statement**, with the target set discovered under it. Every writer reaches `refreshCashForecast`,
including the rebuild seed, so whichever side goes second discovers the other's committed generation
and computes with its money visible. One lock, always first — no acquisition order exists to invert.
*(Superseded by round 4: with the announcement, a write is either before the seed or replayed by
catch-up, and the lock is gone.)*

**Round-2 F2 (P2) — the operator diagnosis raced the write-through.** `diagnose` holds the project's
`ProjectEventStream` row, which freezes event emission — and for seven of the eight projections that
IS the whole write path. Commercial's writers emit nothing, so a payment could commit between the
stored read and the canonical recompute and be reported as `corrupt`, blaming the very write that
made the row current. `Rebuildable` gains an optional `lockFor` hook; cash-forecast supplies the same
advisory lock, and the other seven are untouched because they do not need it.
*(Superseded by round 4: commercial's writers emit, so the stream lock reaches them and the `lockFor`
hook is deleted.)*

**Round-2 F3 (P2) — the sweep took no readiness lock.** `commercial:reevaluate` is a headroom mover
like any other, and §B's rule is that every one of them locks first. Without it the fold is torn: the
sweep reads a ₹50 budget, a concurrent `budget.set` raises it to ₹500 and commits, and the sweep
writes a `fold_correction` breach against a budget that no longer exists — an upgrade repair
corrupting the register it exists to repair.

**Round-2 F4 (P2) — net counting hid real movement.** The report compared open-exception TOTALS
before and after, so a project that reopens one stale breach while clearing another reports
`raised: 0, cleared: 0` while two durable rows moved. It now diffs the open row IDs. The first
spelling claimed in its own comment to count "from the register rather than from what the sweep
believes it did" — and counting the wrong thing from the register is not better than believing.

**Round-2 F5 (P2) — the required reason was discarded.** The CLI demands `--reason` and then dropped
it from the audit, so every reopened exception said only `fold_correction` plus an operator id.
Nothing distinguished the mandated §J upgrade repair from an accidental rerun. A required flag that
is thrown away is a required flag that lies about being required.

### The probe for round-2 F1 asserted a proxy first — the third time this phase

PROBE 41's first spelling drove the rebuild through the operator wrapper `ops.run`, and it **PASSED
against a build with the advisory lock removed from `refreshCashForecast`**. The barrier was
satisfied by a different mechanism than the one under test: `ops.run` diagnoses before rebuilding,
and diagnosis takes the same lock through the `lockFor` hook round-2 F2 had just added.

This is the same defect as 6B-ii's PROBE 19(b) (a barrier satisfied by a foreign key rather than the
trigger under test) and 6C's PROBE 24 (a gate blocked by the service's own lock rather than the
seal's). Three times, and the shape is identical every time: **the probe asserts that SOMETHING
blocked, and something always does.**

It now drives `ProjectionRebuilder.rebuild` directly — allocate → seed → catch-up → barrier, with no
diagnosis anywhere — so the only thing that can wait on the lock is the seed's own refresh. Verified
RED (`barrier timeout: nothing ever blocked`) with the lock removed. *(Round 4 retired this probe
with the lock it tested; PROBE 41 now asserts the property the lock stood in for.)*

### Convergence

Two finding-bearing heads triggered the convergence protocol, and rounds 3 and 4
kept it open. The architectural audit is `docs/reviews/pr-295-convergence.md`; it
names **Root B** — the platform's unstated precondition that every projection
input is announced by a domain event — as the single fact behind findings 5, 6, 7,
8, 11, 13 and the partition-only gap, and **CLOSURE E** now enforces the
precondition itself rather than a compensating lock.

## Codex round 3 — two findings on head `ce015a1`

**Round-3 F1 (P1) — the advisory lock inverted against `ProjectEventStream`.** Round 2's
comment claimed *"one lock, always first, so no acquisition order exists to invert"* —
true of the two cash-forecast callers, false of the system. The rebuild's activation
barrier holds the stream row and then replays a forecast-relevant tail event, which
waits for the advisory lock; a concurrent PO issue takes the advisory lock through
`evaluate` and then calls `emitEvent`, which waits for the stream row. Opposite
sequences on the same pair, resolved by PostgreSQL killing one of them.

Round 3's fix built a total order over the locks it could see —
`lockProjectReadiness < ProjectEventStream < cash-forecast advisory`. Round 4 found
the one it could not.

**Round-3 F2 (P2) — operator identity.** The sweep validated `--operator` by reading
the orgs-owned `User` table directly, in a CLI file the boundary analyzer cannot see.
`OrgsParticipant.resolveUserIdentity` exists so "whether a disabled or merged account
still resolves" changes once rather than per module, and the §L activation path beside
it already routes through it. The stakes are durable — this sweep stamps `raisedById`
on append-only observations. **Closed; not reopened by round 4.**

## Codex round 4 — one finding on head `93a9217`, and the end of the class

**Round-4 F1 (P1) — the round-3 order was still cyclic, against the RELAY.**
`OutboxRelay.dispatchProjection` locks the ACTIVE `ProjectionGeneration` row
`FOR UPDATE` and **then** invokes the projection handler, which round 3 had just
taught to take the stream row. The activation barrier holds the STREAM row and then
locks that same generation row (`replayInto` → `applyEvent`). So:

```
relay:   ProjectionGeneration → (handler) → ProjectEventStream
barrier: ProjectEventStream   →              ProjectionGeneration
```

A genuine cycle. PostgreSQL resolves it by killing the operator's rebuild or a live
delivery.

Three heads of lock ordering, three findings. **At that point the lock ordering is
not the defect; it is the cost of the declaration underneath it.** The correction is
described in *"Commercial's ONE event"* above: commercial announces, the write-through
path and every lock this projection owned are deleted, and findings 3, 5, 6, 7, 8, 11
and 13 close together on the mechanism that already closes them for the other seven.

## The probes

| # | § | What it proves |
| --- | --- | --- |
| 31 | §J | the partition identity `FOLD_INPUTS` cites by name: paying moves `approved`→`paid` and leaves `exposure` and `headroom` untouched; a reversal runs it backwards |
| 32 | §J | the six partition (`Σ six == exposure`) at every step of the chain, and `budget` is authority — the plan's 5o/5bm |
| 33 | §J | headroom goes NEGATIVE on over-commitment; RED against `BUDGET − COMMITTED`, which reports ₹100 of room for a fully-accepted order |
| 34 | §J | the partition survives tax and freight — the plan's 5t |
| 35 | §J/§G | `live == projection == rebuild`, and a rebuild emits ZERO events + ZERO notifications |
| 36 | §J | a COMMERCIAL-only write is ANNOUNCED — the event exists on the stream, its dispatching delivery was materialized in the writer's transaction, and the ordinary relay folds it to `live == projection` |
| 37 | §J | defining AND renaming a cost head announces the move — the second seam |
| 38 | §J/§D | the read falls back to LIVE for an absent generation (honestly dated `null`), serves the projection once one exists, and 404s off-pilot |
| 39 | §J | a PARTITION-ONLY write announces too — paying and reversing move the stored `paid`/`approved` through the relay like any other fact |
| 40 | §B/§J | the operator sweep REOPENS a breach the §J completion re-created, labels it `fold_correction`, is idempotent on a second run, and CLEARS again once the budget is corrected |
| 41 | §J/root B | an announced write leaves the generation's checkpoint BEHIND the stream head, so `readServableGeneration` refuses it and the read falls back live — staleness has a signal at all (RED: without the announcement `applied == head` and the generation stays servable) |
| 42 | §0b | the forecast handler takes NO lock, so the RELAY's order (generation → handler) and the BARRIER's (stream → generation) cannot close a cycle — two sessions, the real handler between them (RED: restoring the round-3 stream-row acquisition produces a real `40P01`) |
| CLOSURE E | §G | every rebuildable projection's owning module ANNOUNCES its facts — both sides derived, stated as necessary-not-sufficient, mutation-tested RED against the round-3 tree |
| CLOSURE D | §J | every forecast event type is catalog-declared AND resolves to `dispatch`; the labour family is present by name; an unrelated event stays a no-op |

Probes 41 and 42 were verified RED against the mechanism they test, not a proxy
for it: 41 with the announcement removed from `evaluate` (`expected 8 to be greater
than 8` — the stream head never moved), 42 with round 3's stream-row acquisition
restored to `refreshCashForecast` (`deadlock detected`, a real `40P01` between the
two sessions). Probe 39 was RED before `payments.record`/`reverse` announced at
all, and the CLOSURE 2 pin behind it was mutation-tested RED at both writers.

## Gates

- `pnpm check` **EXIT 0** — web 543/543, API 775/775, build clean.
- The Task-6/7A money-fold suite **48/48** on live PostgreSQL.
- Full integration suite on a pristine migrated database: **84 files / 1,016 tests**,
  zero failures.
- `upgrade-proof.sh` **PASSED** — `CashForecastProjection` arrives ROW-FREE over
  the legacy fixture with its `(generationId, projectId)` unique installed, and
  every prior Phase-1..Phase-5 rejection survives.
- `phase5-t6b-production-runner-proof.sh` **PASSED** — run by hand (CI structurally
  cannot), because this unit adds a migration.
- `test:e2e:api:allmodules` and `:outbox` — attributed to CI. This container's
  pre-baked Playwright browser is `chromium_headless_shell-1194` against a
  Playwright pinned to `-1228`, so every local browser test fails at launch; a gate
  claimed from a run that never started a browser is not evidence.
- Tripwires advanced in the same commits: the init delivery-count pin 36 → 40 (the
  cash forecast is the TENTH ordered consumer), `MODEL_OWNER` +1, the commercial
  manifest's owned/read-encapsulated sets, the query-site table, the RUNBOOK
  seven → eight, and 31 TRUNCATE lists. Round 4 adds `commercial.money_moved` to the
  shared event catalog, the external-effect catalog and `commercial.producesEvents`;
  commercial's dispatch-site count is UNCHANGED at zero, because the entry is
  weightless.

## Invariant matrix

| Invariant | Where it is enforced | Proof |
| --- | --- | --- |
| The six buckets partition the money | one fold, residual by construction | probes 32/34 (`Σ six == exposure` at every step) |
| `budget` is a ceiling, never an addend | `computeCashForecastDto` sums it separately | probes 32/33 |
| Paying moves no exposure | `approved + paid == APPROVED` identically | probe 31 |
| `live == projection == rebuild` | ONE `computeCashForecastDto` on all four paths | probes 35/36/38 |
| A rebuild derives no domain event | recompute-only consumer (§G) | probe 35 |
| No commercial write leaves the forecast stale | `evaluate` + `defineCostHead`, DERIVED | CLOSURE C (3 arms mutation-tested), probes 36/37 |
| The projection is never served stale | `readServableGeneration` + live fallback | probe 38 |
| Off-pilot projects are unaffected | `assertEnabled` on the read | probe 38 |
