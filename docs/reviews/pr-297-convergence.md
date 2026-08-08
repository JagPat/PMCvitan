# PR #297 convergence audit — 7B-i, and what a new consumer costs

Two finding-bearing heads (`a3a0f56`, `98d92c4`) trigger the convergence rule.
Six P2s, no P1s, and they fall into two roots — one a recurrence this phase has
now named four times, one new and, I think, the more useful of the pair.

## Every finding, in one table

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `a3a0f56` | P2 | `useApiSync`'s realtime refresh reloads the snapshot plus Materials and Labour, not Commercial |
| 2 | Codex | `a3a0f56` | P2 | The `loadShell().catch` failure transition flips idle Materials/Labour loads to `error`; Commercial stays `idle`, so a cold bookmarked `/commercial` renders a permanent "loading" with no Retry |
| 3 | Codex | `a3a0f56` | P2 | The commitments tab rendered SUPERSEDED attributions as current, double-counting a re-attributed PO line under both the head it left and the head it moved to |
| 4 | Codex | `98d92c4` | P2 | `commercial.money_moved` is `invalidate: false`, and the socket consumer dispatches only on `invalidate` — so finding 1's fix never fires for commercial's own writes |
| 5 | Codex | `98d92c4` | P2 | Four separate HTTP reads assemble one page from four database moments |
| 6 | Codex | `98d92c4` | P2 | `openExceptions` is documented in the contract as "the Inbox action count (§B)" and nothing read it — a PMC saw "all caught up" over a live breach |
| — | self | in-branch | — | Importing the attribution serializer from `commercial.service` closed a runtime cycle Nest reports as an unresolvable dependency; a `doesNotMatch` that could never match; `node:fs` in a web test the tsconfig has no types for |

## Root A — the integration surface was already written down

Findings 1, 2 and 6 are one thing: **the codebase already said what a new hub
owes, and I built beside those statements instead of reading them.**

- The other two capability-gated hubs are wired into the realtime refresh and the
  shell-failure transition. That set is not a convention I had to infer — it is
  visible in the two hubs I was explicitly cloning.
- `CommercialBudgetDto.openExceptions` carries the comment *"the Inbox action
  count (§B)"*. The contract stated the obligation; the hub ignored it.

This is `pr-289-convergence.md`'s root A — a hand-written set standing in for a
derived one — in its fourth appearance this phase. The closure follows the form
that finally worked in 7A: **make the source the checker.** `SCREEN_CAPABILITY`
already names every capability-gated hub, so the closure derives the hub set from
it and requires each hub's loader at each integration point. Mutation-tested:
removing any one wiring turns exactly one closure test red, and the derivation is
pinned to contain exactly the three loaders so it cannot pass by scanning nothing.

Finding 6 is not covered by that closure and is honestly outside it: an Inbox
action is a product decision, not a wiring point, and a test that demanded one per
hub would be inventing a rule. What closes it is the probe, and the note that the
DTO comment was the specification all along.

## Root B — a decision is only correct relative to the consumers that existed

Findings 4 and 5 are new, and they share a shape worth naming.

**Finding 4 is my own 7A decision arriving at its consequence.** 7A made
`commercial.money_moved` weightless (`invalidate: false`) so that Task 1's
justification — "no external effect AND no consumer" — kept its first half
literally true after round 4 retired the second. The comment I wrote there says,
in as many words:

> Nothing is sent to any client: no socket invalidation, no push. The commercial
> screens (Task 7B) refresh from their own reads.

That sentence was true when written and false three commits later, because 7B-i's
"own reads" are driven by the socket ping the weightless flag suppresses. The
repair is the same move round 4 made: **when the grounds of a justification fall,
change the declaration** — not build a client-side poll around a declaration that
stopped being true.

**Finding 5 is the same shape without the event.** Four reads were unremarkable
until you ask whether the four moments agree — and the server had already answered
that question one layer down: `readBudget` is repeatable-read because "a PO issue
committing between the fold and the exception read returns healthy headroom
alongside the freshly opened exception for that same head — a page that
contradicts itself." Four reads over one page is that defect with a wider window.
I read that comment while writing this hub and did not carry the rule up.

So the root:

> A decision is correct relative to the consumers that existed when it was made.
> **Becoming a new consumer of something is the signal to re-check its
> declaration** — not waiting for someone to change it.

7B-i is the first client of the §J event, the first client of four commercial
reads at once, and the first client of `openExceptions`. Every one of those three
firsts produced a finding. That is not a coincidence; it is the root stated as a
prediction, and it is the thing to carry into 7B-ii and 7B-iii, which are the
first clients of the claim-lifecycle reads and of the commercial write path.

### Round 3 confirmed root B — against me, one head later

The audit above was written on `ca185b0` and predicted the next failure. Codex
found it on that same head.

I fixed finding 4 by flipping `commercial.money_moved` to `invalidate: true`.
That changed the declaration — and I did not then re-check what the NEW
declaration requires of its producers. It requires post-commit dispatch: every
commercial service returns `events: []` and injects no `ExternalEffectDispatcher`,
and in the DEFAULT `legacy` sender mode `OutboxRelay.claimExternalRecovery()`
deliberately holds fresh external deliveries for the lease window because the
immediate dispatcher is expected to have sent them. So a flipped flag alone
delivers the invalidation late, and never under `OUTBOX_RELAY_AUTOSTART=false`.

**A half-wired external effect is worse than a weightless one.** The flag went
back, and the wiring — `evaluate` returning its meta, ~15 command sites across 10
services threading it, ten dispatcher injections, the tripwires — is scheduled as
its own unit in `docs/STATUS.md`, ahead of 7B-ii.

What closes the trap is not the revert but the pin: `commercial.contract.test.ts`
now asserts the flag and the wiring **together**, mutation-tested in both
directions — flipping the flag with no dispatcher fails, and adding a dispatcher
while the flag is weightless fails. Neither half can land alone again.

The lesson is the audit's own root, and I am the third instance of it in three
heads: **changing a declaration is itself becoming a new consumer — of everything
that declaration now obliges.** Root B does not only apply to code you did not
write.

### Round 4 — root A's other direction, and a state machine that would have skipped its own fix

**The manifest pin only looked one way.** `commercial/money-position` reached the
web gateway while `COMMERCIAL_QUERIES` still enumerated only the older reads,
because the contract test walks the DECLARED set and checks each has a route — so
an UNDECLARED route is invisible to it. The manifest promised less than the
controller served: the stale-manifest class this contract exists to prevent,
arriving from the direction it was not looking. The fix is root A's answer once
more, applied to the open direction: the CONTROLLER is the source, every
commercial `@Get` must be declared. Mutation-tested — removing the entry now
fails BOTH pins.

Writing that pin immediately earned its keep: it exposed a duplicate key I had
left in the query-site map two edits earlier, which the first mutation attempt
silently survived.

**And the Now block would have skipped the unit it had just scheduled.**
`next_task` still pointed at `phase-5-task-7b-ii` while the table added in the
same diff said 7B-i-a "must land before 7B-ii". `assessRunnerState` resolves
`next_task` after a merge clears `work_item`/`open_pr`, so the runner would have
started the claim-lifecycle unit and left the staleness gap open beneath it. Two
statements about order in one file, disagreeing — the same shape as the
`open_pr`/`work_item` defects PR #296 spent three heads on, and a reminder that
scheduling a unit in prose is not scheduling it.

## The self-inflicted ones, recorded because two are process

**A runtime cycle from a pure function.** Importing `serializeAttribution` from
`commercial.service` closed budget-service → commercial-service → participant →
budget-service, which Nest reports as "can't resolve dependencies of
CommercialService … argument at index [2]" — several layers from the edit. A pure
row→DTO mapper has no business creating that edge; it now lives in a leaf both
callers reach. Worth noting *what caught it*: the live-PG integration suite, not
`pnpm check`. A DI cycle is invisible to the type checker.

**A negative assertion that could not fail.** `doesNotMatch(/Runner next
step:\s*`pr:296`/)` against text rendering `**Runner next step:** …` — the same
defect `pr-296-convergence.md` recorded, reappearing one PR later in my own hand.
The rule stands and I did not apply it: **a negative assertion needs a positive
twin over the same text.** Both probes here have one.

**`node:fs` in a web test.** The web tsconfig carries no node types, so the source
scan had to use Vite's `?raw` loader — which two tests in the same directory
already do. `pnpm check` caught it before CI. Same shape as root A, one floor
down: the answer was already in the room.

## What carries forward

1. **Becoming a consumer is the signal to re-check the declaration.** 7B-ii and
   7B-iii are first clients of three more things; that is where to look first.
2. **Make the source the checker.** Root A's fourth appearance, closed the way
   7A's finally worked: derive the set from the thing that already names it.
3. **A rule learned at one layer is not automatically applied one layer up.** The
   server made its budget fold repeatable-read for exactly the reason the hub
   needed one request.
4. **A negative assertion needs a positive twin over the same text.** Second
   consecutive PR.
5. **Changing a declaration makes you its newest consumer.** Root B applied to
   my own edit, one head after I wrote it down. A flag that describes an external
   effect is a contract with the producers, not a switch.
