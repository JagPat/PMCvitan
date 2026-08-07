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

Probes 36 and 37 were verified RED with the two `refreshCashForecast` calls
removed, so neither is passing on the consumer path by accident.

## Gates

- `pnpm check` **EXIT 0** — web 543/543, API 751/751, build clean.
- The Task-6/7A money-fold suite **44/44** on live PostgreSQL.
- Full integration suite on a pristine migrated database — see the PR body for the
  head's exact file/test totals.
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
