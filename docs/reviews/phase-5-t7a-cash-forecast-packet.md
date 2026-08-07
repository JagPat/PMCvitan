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
   every path — the ordered consumer, the write-through refresh, the read, and the
   operator rebuild diagnostic — calls `computeCashForecastDto`.

5. **The `commercial.cash-forecast` read**, capability-gated, serving the
   projection when its generation is servable and falling back to the LIVE compute
   otherwise. `refreshedAt` is the projection's row timestamp and is NULL on the
   live path — a live answer is honestly undated rather than stamped `now`.

## The two refresh paths, and why this projection has them

Every other projection in this codebase refreshes purely from the outbox, because
every fact it derives from is announced by a domain event. This one cannot, and
the reason is a **declared architectural decision rather than an oversight**:
`commercial.producesEvents` is `[]`, justified in the manifest since Task 1 as "an
internal accounting fact with no external effect and no consumer". Certifying,
approving, paying, withholding and recovering an advance are the largest movers of
the §J buckets, and none of them emits anything.

Giving commercial an event family was considered and **put to JagPat rather than
chosen silently**, because it reverses a declared manifest decision, adds ~8 events
to the sealed external-effect catalog, and grows this unit past its review budget
on its own. The chosen design is write-through plus foreign events.

So the refresh is chosen by WHO OWNS the fact that moved:

- **Foreign facts** — the PO lifecycle, acceptance, measurement, delivery and
  capacity commitments, stock movements — already emit canonical events, and the
  ordered `db` consumer refreshes on them exactly as the other seven do.
- **Commercial facts** refresh WRITE-THROUGH, in the same transaction as the write.

**Two refresh paths is a real hazard — it is precisely how a projection acquires
two opinions.** What makes it safe here is that neither path computes anything.
Both call `computeCashForecastDto`. PROBE 36 exercises that directly rather than
leaving it to this paragraph.

## Where the seams are, and why they are DERIVED

The write-through seam is **not a list of writers**. It is
`CommercialBudgetService.evaluate`, and that is a derivation:

> §B headroom is `BUDGET − Σ(the six §J exposure buckets)`. So *"this write moved
> headroom"* and *"this write moved a §J bucket"* are **the same predicate** — not
> two lists that happen to agree today.

Every money writer already calls `evaluate`; CLOSURE 2 (`FOLD_INPUTS`) fails the
build if one does not. So a writer cannot satisfy §B and forget §J: there is one
call site and one rule.

There is exactly ONE other seam, `commercial.costHead.define`, and it exists
because defining or renaming a cost head changes what the forecast SAYS while
moving no money at all — §B's evaluation would never fire for it.

**CLOSURE C** pins that there is no third. It extracts the `tx.<model>` reads from
the compute path's own method bodies and requires every model to be CLASSIFIED
against the write path that refreshes it. A model added to the compute without a
classification fails; a classification whose named site no longer calls
`refreshCashForecast` fails; a classification for a model the compute no longer
reads fails. All three arms were mutation-tested RED before this was committed.

This matters more here than for any previous projection, and the reason is worth
stating plainly: **a commercial write that forgets to refresh emits no event that
could have been missed.** There is nothing for a consumer to notice. The only
things standing between "a writer forgot" and "the money page is wrong for a week"
are this closure and the operator diagnostic — which is why the RUNBOOK now says
so under step 3.

### The seam was ALMOST right, and the gap was found by a probe rather than a review

7A's first spelling hung the refresh off `evaluate` and stopped there. That is wrong, and
the way it is wrong is instructive: *"moved headroom"* and *"moved a §J bucket"* are
**almost** the same predicate, and they come apart at exactly the `partitionOnly` rows.
Paying moves `approved` into `paid` without moving the total, so it is rightly exempt from
§B's evaluator — and was therefore silently exempt from §J's refresh too.

The consequence would have been a stored forecast reporting money as authorised-and-unpaid
forever after it left the bank, with **no event a consumer could have missed**. That is the
exact failure mode the RUNBOOK note above describes, arriving inside the unit that wrote the
note.

The fix keeps the derivation and moves the obligation to the whole of the table it was
already using: `payments.record` and `payments.reverse` refresh directly, and CLOSURE 2 now
pins that **every** `FOLD_INPUTS` writer refreshes — through an evaluator or directly —
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

## Refreshing `building` generations, not only `active` ones

The write-through refresh targets every LIVE generation of the project — `active`
AND `building`, scoped to that project.

Both halves are load-bearing. A rebuild runs a `building` generation alongside the
serving one; a commercial write landing between the canonical seed and the
activation barrier emits nothing for the catch-up phase to apply, so refreshing
only the `active` generation would activate a generation holding a pre-write money
picture — **the rebuild making the projection worse**, which is the one thing a
repair must never do. And generations are per (consumer, project), so an unscoped
query would write this project's money into other projects' rows.

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

**Round-2 F2 (P2) — the operator diagnosis raced the write-through.** `diagnose` holds the project's
`ProjectEventStream` row, which freezes event emission — and for seven of the eight projections that
IS the whole write path. Commercial's writers emit nothing, so a payment could commit between the
stored read and the canonical recompute and be reported as `corrupt`, blaming the very write that
made the row current. `Rebuildable` gains an optional `lockFor` hook; cash-forecast supplies the same
advisory lock, and the other seven are untouched because they do not need it.

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
RED (`barrier timeout: nothing ever blocked`) with the lock removed.

### Convergence

Two finding-bearing heads triggered the convergence protocol. The architectural
audit is `docs/reviews/pr-295-convergence.md`; it names **Root B** — the platform's
unstated precondition that every projection input is announced by a domain event —
as the single fact behind findings 5, 6, 7, 8 and the partition-only gap, and adds
**CLOSURE E** so the next event-less module that adds a projection is stopped at
the desk rather than three review rounds later.

## The probes

| # | § | What it proves |
| --- | --- | --- |
| 31 | §J | the partition identity `FOLD_INPUTS` cites by name: paying moves `approved`→`paid` and leaves `exposure` and `headroom` untouched; a reversal runs it backwards |
| 32 | §J | the six partition (`Σ six == exposure`) at every step of the chain, and `budget` is authority — the plan's 5o/5bm |
| 33 | §J | headroom goes NEGATIVE on over-commitment; RED against `BUDGET − COMMITTED`, which reports ₹100 of room for a fully-accepted order |
| 34 | §J | the partition survives tax and freight — the plan's 5t |
| 35 | §J/§G | `live == projection == rebuild`, and a rebuild emits ZERO events + ZERO notifications |
| 36 | §J | the WRITE-THROUGH and CONSUMER paths agree — commercial-only writes store the right money with the relay never drained, and draining changes nothing |
| 37 | §J | defining AND renaming a cost head refreshes the forecast — the second seam |
| 38 | §J/§D | the read falls back to LIVE for an absent generation (honestly dated `null`), serves the projection once one exists, and 404s off-pilot |
| 39 | §J | a PARTITION-ONLY write refreshes the forecast too — paying and reversing move the stored `paid`/`approved` with nothing drained, because nothing was emitted |
| 40 | §B/§J | the operator sweep REOPENS a breach the §J completion re-created, labels it `fold_correction`, is idempotent on a second run, and CLEARS again once the budget is corrected |
| 41 | §J | the rebuild SEED serializes on the forecast advisory lock — a holder BLOCKS it (`pg_blocking_pids`, condition-based) and it completes on release |
| CLOSURE E | §G | a rebuildable projection whose owning module declares `producesEvents: []` MUST supply `lockFor` — both sides derived, both directions non-vacuous, mutation-tested RED |
| CLOSURE D | §J | every forecast event type is catalog-declared AND resolves to `dispatch`; the labour family is present by name; an unrelated event stays a no-op |

Probes 36 and 37 were verified RED with the two `refreshCashForecast` calls
removed, so neither is passing on the consumer path by accident. Probe 39 was RED
before `payments.record`/`reverse` refreshed at all, and the CLOSURE 2 pin behind
it was mutation-tested RED at both writers.

## Gates

- `pnpm check` **EXIT 0** — web 543/543, API 751/751, build clean.
- The Task-6/7A money-fold suite **44/44** on live PostgreSQL.
- Full integration suite on a pristine migrated database: **84 files / 1,014 tests**,
  zero failures.
- `upgrade-proof.sh` **PASSED** — `CashForecastProjection` arrives ROW-FREE over
  the legacy fixture with its `(generationId, projectId)` unique installed, and
  every prior Phase-1..Phase-5 rejection survives.
- `phase5-t6b-production-runner-proof.sh` — run by hand (CI structurally cannot),
  because this unit adds a migration.
- `test:e2e:api:allmodules` and `:outbox` — attributed to CI. This container's
  pre-baked Playwright browser is `chromium_headless_shell-1194` against a
  Playwright pinned to `-1228`, so every local browser test fails at launch; a gate
  claimed from a run that never started a browser is not evidence.
- Tripwires advanced in the same commits: the init delivery-count pin 36 → 40 (the
  cash forecast is the TENTH ordered consumer), `MODEL_OWNER` +1, the commercial
  manifest's owned/read-encapsulated sets, the query-site table, the RUNBOOK
  seven → eight, and 31 TRUNCATE lists.

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
