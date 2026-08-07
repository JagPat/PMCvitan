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
| — | self | in-branch | — | Paying was exempt from §J's refresh; `APPROVED` was misclassified as a headroom mover; PROBE 41 asserted a proxy |

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

**The mechanical closure — CLOSURE E** (`module-registry.test.ts`). The
precondition is now EXPLICIT and checked: a rebuildable projection whose owning
module declares `producesEvents: []` must supply `lockFor`, which is the
declaration that it serializes its own writers. Both sides are derived — the
projection set from `REBUILDABLE_PROJECTIONS`, the emitting-ness from the owning
manifest — and the test asserts both that the event-less set is non-empty (so it
cannot pass by seeing nothing) and that the event-driven set is non-empty (so it
is discriminating rather than a blanket demand). Mutation-tested RED.

The next event-less module that adds a projection is stopped at the desk, not
three review rounds later.

## Root C — an artefact that claims more than it does

Findings 9 and 10 are small and share a shape worth naming, because it is the
shape that survives review most easily: **the code says something true-sounding
that nothing checks.**

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
2. **Root B has a name now, and CLOSURE E enforces it.** "Every projection input
   is announced by an event" was true for seven and is a precondition, not a law.
3. **A concurrency probe is not evidence until it has been run RED.** Three for
   three this phase.
