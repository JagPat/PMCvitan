# PR #295 convergence audit — Phase 5 Task 7A, the §J cash forecast

Two finding-bearing heads (`484cb5f`, `f345d2c`) trigger the convergence rule, and
the rule is explicit that the next head must be an architectural audit rather than
another isolated patch. This is that audit.

## Every finding, in one table

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `484cb5f` | P1 | `FORECAST_EVENTS` spelled the labour PO family `labour_po.*`; the catalog declares `labour.po.*` |
| 2 | Codex | `484cb5f` | P1 | No repair for databases whose exposure definition the §J completion changed |
| 3 | Codex | `484cb5f` | P1 | `capability.cli.ts` builds its own graph and never bound the projection deps |
| 4 | Codex | `484cb5f` | P2 | `CommercialActivationService.activate` writes `CostHead` and never refreshes |
| 5 | Codex | `484cb5f` | P1 | The rebuild seed could overwrite a newer write-through DTO |
| 6 | Codex | `f345d2c` | P1 | Target discovery ran before any lock that could stop a generation appearing |
| 7 | Codex | `f345d2c` | P2 | `diagnose` raced the write-through into a false `corrupt` verdict |
| 8 | Codex | `f345d2c` | P2 | The repair sweep took no readiness lock |
| 9 | Codex | `f345d2c` | P2 | The sweep's report compared totals, hiding a raise that cancelled a clear |
| 10 | Codex | `f345d2c` | P2 | `--reason` was required, then discarded |
| — | CI | `1bf577f` | — | Two operator-rebuild coverage lists, one named `ALL_FIVE` holding seven entries |
| 11 | Codex | `ce015a1` | P1 | The advisory lock inverted against `ProjectEventStream` — barrier and PO issue take the pair in opposite order |
| 12 | Codex | `ce015a1` | P2 | The sweep read the orgs-owned `User` table directly to validate `--operator` |
| 13 | Codex | `93a9217` | P1 | The round-3 order was still cyclic against the RELAY: `dispatchProjection` locks the active `ProjectionGeneration` and then calls the handler, which took the stream row; the barrier takes them the other way round |
| — | self | in-branch | — | Paying was exempt from §J's refresh; `APPROVED` was misclassified as a headroom mover; PROBE 41 asserted a proxy; PROBE 42's first comment claimed a 40P01 the test does not show |

## Root A — a hand-written list standing in for a derived set

Findings 1 and 4, both CI-caught lists, and the partition-only refresh gap are one
root, and it is the root `pr-289-convergence.md` already named. This is its sixth,
seventh and eighth occurrence in one phase.

That recurrence is the finding. The earlier closures were not wrong; they were
**scoped to the substrate that had just failed** — `FOLD_INPUTS` derives the mover
set from what the fold reads, CLOSURE A derives the seal set from the migrations,
CLOSURE B derives the `PAID` twins from the SQL text. Each closed its own
substrate and none generalised, so the class walked into the next one:

- **1** — a list of event-type STRINGS, checked against nothing. The catalog was
  right there.
- **4** — a classification naming ONE method (`commercial.costHead.define`) when
  the obligation was about every writer of that model. `activate` was the second.
- **CI's two** — hand-kept copies of the projection registry, in tests whose whole
  purpose is to prove the operator run skips no projection. `ALL_FIVE` had gone
  stale twice before this unit found it a third time, and was carrying its own
  staleness in its identifier.
- **the partition-only gap** — the refresh obligation hung on §B's mover
  predicate, which is *almost* the §J bucket predicate and differs at exactly the
  exempt rows.

**What this unit did differently:** it made the SOURCE the checker rather than
adding a ninth list-comparison.

- `FORECAST_EVENT_TYPES` is `readonly DomainEventType[]`, so a name the catalog
  does not declare cannot be written. The compiler is the closure; CLOSURE D pins
  the behaviour a type cannot express (that each declared type dispatches).
- CLOSURE C no longer trusts a classification's prose: it SCANS every commercial
  file for a write to a classified model and requires each writing file to
  refresh. A classification naming a method is a claim about one site; the
  obligation is about all of them.
- Both operator-rebuild suites derive their expected set from
  `REBUILDABLE_PROJECTIONS`, with the registry pinned by name so "derived" cannot
  decay into "whatever happens to be registered, including nothing".

## Root B — an unstated precondition, satisfied by every prior instance

**This is the new root, and it is the story of the unit.** Findings 5, 6, 7, 8 and
the partition-only gap are one architectural fact:

> The platform's projection machinery assumes **every input to a projection is
> announced by a domain event.** Seven projections satisfied it, so it was never
> written down — and everything built on top relied on it.

Three separate mechanisms rest on that assumption, and each became a defect the
moment the eighth projection broke it:

- **`diagnose` locks `ProjectEventStream` and calls the window frozen.** It is
  frozen only against writers that emit. A payment committing between the stored
  read and the canonical recompute was reported as `corrupt` — blaming the very
  write that made the row current (finding 7).
- **The rebuild's catch-up phase repairs whatever the seed missed, by REPLAYING
  EVENTS.** With no events, "catch-up will fix it" is simply false, so every
  window between seed and activation becomes permanent (findings 5 and 6).
- **A stale projection is normally detectable as an undelivered event.** With
  none, staleness has no signal at all — which is why a forgotten refresh here is
  invisible to every consumer, and why the closures around it carry more weight
  than they would anywhere else.

Finding 8 is the same root in §B's vocabulary: the repair sweep is a headroom
mover, and every mover takes the readiness lock — but a sweep does not look like a
site write, so it did not take one.

Finding 3 is Root B's sibling in a different dimension: the DI container binds
`bindCashForecastDeps` at boot, so every caller inside it works. A CLI that builds
its own graph is outside that guarantee, and nothing said so.

**The mechanical closure — CLOSURE E** (`module-registry.test.ts`), and round 4
corrected its SHAPE. Its first version demanded a compensating lock (`lockFor`)
from an event-less owner. That accommodated a false declaration instead of
requiring the declaration to be true, and round 4 is the bill for it — see below.
It now states the precondition itself: **every rebuildable projection's owning
module must announce its facts.** Both sides derived — the projection set from
`REBUILDABLE_PROJECTIONS`, the emitting-ness from the owning manifest — and the
message says plainly that this is NECESSARY, not sufficient: the sufficient half
is per-module (CLOSURE C for §J). Mutation-tested RED against the round-3 tree.

The next module that adds a projection without announcing its facts is stopped at
the desk, not four review rounds later.

### Round 3 confirmed Root B, from the outside

A third head drew two more findings, and the P1 is Root B seen from the platform's
side rather than the module's.

Round 2's fix introduced a per-(project, consumer) advisory lock and its comment
claimed *"one lock, always first, so no acquisition order exists to invert."* That
was true of the two cash-forecast callers and **false of the system.** The real
ordering graph includes `ProjectEventStream` — which `emitEvent` locks to allocate
a position, and which the rebuild's activation barrier holds while replaying the
tail:

- the **barrier** holds the stream row, replays a forecast-relevant tail event,
  and waits for the advisory lock;
- a concurrent **PO issue** takes the advisory lock through `evaluate`, then calls
  `emitEvent` and waits for the stream row.

Opposite sequences on the same pair — PostgreSQL resolves it by killing the
operator's rebuild or a live purchase order.

This is Root B because the hazard exists only for a projection whose writers do
not emit: for the other seven, the write-through path does not exist, so no
transaction ever holds a projection lock while reaching for a stream position. The
fix is a **total order** rather than a rule callers must remember —
`lockProjectReadiness < ProjectEventStream < cash-forecast advisory` — achieved by
taking the stream row inside `refreshCashForecast`, before the advisory lock. Every
holder of the advisory lock then already holds the stream row and cannot be waiting
for it, whatever the caller does afterwards.

The second finding (P2) is an ordinary boundary miss: the sweep validated
`--operator` by reading the orgs-owned `User` table directly, in a CLI file the
boundary analyzer cannot see. `OrgsParticipant.resolveUserIdentity` exists so that
"whether email is unique, whether a disabled or merged account still resolves"
changes once rather than per module, and the §L activation path beside it already
routes through it. The stakes are durable: this sweep stamps `raisedById` on
append-only observations.

### Round 4 ended it — the root, not the fifth lock

Round 4 found ONE P1, and it is round 3's fix being wrong in the same way round
2's was. Round 3 built a total order over the two locks it could see — readiness,
stream, advisory. The order it could not see is the RELAY's:

- `dispatchProjection` locks the ACTIVE `ProjectionGeneration` row `FOR UPDATE`
  and **then** invokes the handler, which took the stream row;
- the activation barrier holds the STREAM row and then locks that same generation
  row (`replayInto` → `applyEvent`).

`generation → stream` against `stream → generation` — a real cycle, resolved by
PostgreSQL killing the operator's rebuild or a live delivery.

Three heads of lock-ordering, three findings. At that point the lock ordering is
not the defect; **it is the cost of the false declaration underneath it.**
`producesEvents: []` was justified on TWO grounds — *no external effect* and *no
consumer*. The first is still true. The second stopped being true the moment §J
added a stored forecast, and every mechanism in findings 5–8 and 11 and 13 was
machinery built to make a projection work without the announcement the platform
assumes it has.

So round 4 does not add a lock. It makes the declaration true:

- commercial emits ONE event, `commercial.money_moved`, from the seam already
  derived in Root A's answer (`evaluate`) plus the three seams that write a
  forecast input without moving headroom;
- the catalog entry is **weightless** (`invalidate: false, push: null`), so the
  first ground — *no external effect* — stays literally true, no client is sent
  anything, and commercial's services stay at zero dispatch sites;
- and the write-through path, the advisory lock, `cashForecastLockKey`,
  `lockCashForecast`, the `Rebuildable.lockFor` hook and its `diagnose` plumbing
  are all **deleted**. `refreshCashForecast` takes a required `generationId`,
  computes, upserts, and takes no lock at all — a projection that holds no lock
  cannot invert one.

Findings 5, 6, 7, 8, 11 and 13 are closed by the same three lines, and each is
closed by the mechanism that closes it for the other seven projections rather
than by a bespoke one: the seed's blind spot is repaired by catch-up because
there is now an event to replay; `diagnose`'s stream lock reaches commercial
writers because they emit; staleness is a lagging checkpoint. Finding 3 goes with
them — no command path computes the forecast any more, so a CLI that builds its
own graph cannot be missing a binding it does not need.

**The general lesson, and it is the sharper form of "fix the class, not the
member":** when a repair keeps needing another repair of the same kind, the thing
to change is the declaration the repairs are defending, not the repairs.

## Root C — an artefact that claims more than it does

Findings 9 and 10 are small and share a shape worth naming, because it is the
shape that survives review most easily: **the code says something true-sounding
that nothing checks.**

- Round 2's lock comment claimed no order could be inverted, on the strength of
  looking at two callers rather than the graph. Round 3's finding 11 is that claim
  being wrong.
- PROBE 42's first comment asserted the RED failure was a `40P01` deadlock. The
  observed failure is the barrier timing out — the write simply never waits. The
  comment now says what the test shows and why a two-session probe cannot show the
  deadlock itself.
- The sweep's report compared open-exception TOTALS, so a project that reopened
  one breach while clearing another reported `raised: 0, cleared: 0`. The function
  carried a comment claiming it counted "from the register rather than from what
  the sweep believes it did" — and counting the wrong thing from the register is
  not better than believing.
- `--reason` was mandatory at the CLI and dropped before the audit row. A required
  flag that is thrown away is a required flag that lies about being required.

Both are now what they claimed: the report diffs open row IDs, and the reason is
persisted in the audit payload with the head count and the raise/clear tallies.

## The probes had this root too

PROBE 41 — the probe for finding 6 — **passed against a build with the fix
removed.** It drove the rebuild through `ops.run`, which diagnoses first, and
diagnosis takes the same lock that finding 7's fix had just added. The barrier was
satisfied by a different mechanism than the one under test.

That is the third time this phase: 6B-ii's PROBE 19(b) was satisfied by a foreign
key rather than the trigger, 6C's PROBE 24 by the service's own lock rather than
the seal. The shape is identical every time — **the probe asserts that SOMETHING
blocked, and something always does.** It now drives `ProjectionRebuilder.rebuild`
directly, where the seed is the only thing that can wait, and is verified RED
(`barrier timeout: nothing ever blocked`).

The rule this leaves: a concurrency probe must name WHICH statement waits, and be
run against a build with the mechanism removed. Asserting a wait is not asserting
the mechanism.

Round 4 rewrote both concurrency probes against the new mechanism, and the rule
above is what shaped them. PROBE 42 no longer asserts that something blocked: it
plays the RELAY (lock the active generation, then run the REAL handler) and the
BARRIER (hold the stream row, then reach for that same generation row) as two
sessions on two clients, with the relay signalling the instant it holds the
generation row so the barrier arrives while the handler is running. At `93a9217`
that is a 40P01 one side dies of; with the handler's locks deleted both commit.
Verified RED by restoring the stream-row acquisition to `refreshCashForecast` —
the mechanism removed, not a proxy for it. PROBE 41 stopped being a lock probe
altogether and asserts the property the lock was standing in for: an announced
write leaves the generation's checkpoint BEHIND the stream head, so the read
falls back live and staleness has a signal at all.

## One finding that was the code being right

PROBE 20 of the Task-6A suite failed when §J's partition completed, and the
failure was the correct answer. 6A classified `APPROVED` as a headroom mover and
asserted approving CLEARS the exception it healed — true while `approved` was not
yet a bucket, because the subtracted money had nowhere to go. §J always specified
where: `approved = APPROVED − PAID`. Adding it makes approving exposure-neutral.

**Money a practice has authorised is money it still owes.** A budget that healed
the moment a payable was approved would report room exactly when the practice
committed to spending. `FOLD_INPUTS` reclassifies the row, the probe now asserts
the partition, and the `payment_approval` §B label stays wired for the reason
`measurement` does — the closure's rule is mechanical, and carving out an
exception on the strength of my own arithmetic is what went wrong twice in Task 2.

## What carries forward

1. **Root A is not closed by another per-substrate closure.** The durable form is
   making the source the checker — a type, a scan, a registry read — not a second
   list to compare against the first.
2. **Root B has a name now, and CLOSURE E enforces it as a REQUIREMENT rather
   than as a compensating hook.** "Every projection input is announced by an
   event" was true for seven, and is a precondition of three separate platform
   mechanisms. A module that owns a projection announces its facts.
3. **When successive repairs are all of one kind, the declaration underneath them
   is the defect.** Three heads of lock ordering were paying for
   `producesEvents: []` being half-true. One weightless event deleted all of it.
4. **A concurrency probe is not evidence until it has been run RED.** Four for
   four this phase.
