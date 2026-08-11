# PR #322 — convergence audit (Phase 5 Task 7B-vi)

Four finding-bearing heads, twelve findings, on the unit written to end enumeration — **and nine
of the twelve are enumeration, twice in the corrections for it.**

| # | Head | Finding | Root |
|---|---|---|---|
| 1 | `985af6b` | `this.get` does not exist on `ApiGateway` | a check that could not fail |
| 2 | `985af6b` | `VendorAdvanceListDto` unimported (API) | same |
| 3 | `985af6b` | the read served but not declared in `COMMERCIAL_QUERIES` | **hand-kept registry** |
| 4 | `4b6ab9c` | `payAdvance` missing from `COMMERCIAL_OUTBOX_OP_TYPES` | **hand-kept registry** |
| 5 | `4b6ab9c` | `payAdvance` missing from `COMMERCIAL_OP_PERMISSION` | **hand-kept registry** |
| 6 | `4b6ab9c` | the flush never re-read advances, so the key could stick | **coverage** |
| 7 | `4b6ab9c` | one failed read was terminal; Refresh did not cover it | **coverage** |
| 8 | `4b6ab9c` | Pay enabled while the position was unknown | **enumerated precondition** |
| 9 | `66f16ec` | the `error` retry looped: error → effect → loading → error | **created by fix 7** |
| 10 | `66f16ec` | the socket path never refreshed an opened advances list | **coverage**, 3rd registry |
| 11 | `66f16ec` | Pay re-enabled by editing a field while an advance was queued | **created by fix 8** |
| 12 | `b1c4e40` | the socket refresh I added was INERT — `payAdvance` announced nothing | **created by fix 10** |

## Round 3 — I wired a consumer to a producer that does not produce

Fix 10 added `loadCommercialAdvances()` to the realtime path. It could never fire: `payAdvance`
emitted no invalidating signal, so the refresh I added for cross-client staleness did not address
cross-client staleness. **Third time in this PR a correction created the next finding**, and the
sharpest of the three, because the wiring *looked* like the guarantee was in place.

**What I nearly got wrong, and why it is worth recording.** I grepped for `events: [` and found all
nineteen commercial commands returning `events: []`, concluded commercial emits nothing by design
(§K, a sink), and began drafting an escalation asking whether to make advances the first
event-emitting commercial command — an architectural question. That grep was conclusive-looking and
wrong: the mechanism is a separate in-transaction `announceMoneyMoved(...)` call, already used by
budget, cost-head, payment and reversal. **A grep that answers the question you asked is not the
same as a grep that answers the question you have.**

The fix is therefore the established mechanism, not a widening: `payAdvance` announces
`commercial.money_moved` with `costHeadCodes: []` and `reason: 'advance'`. That does not contradict
the deliberate decision recorded beside it — no `reDerive`, no headroom evaluation, because those
are §B/§F **observations** labelled against heads and claims an advance genuinely does not move.
This is the §J **invalidation** signal, and what it states is true: cash left the project, and no
head's exposure moved. Mutation-tested: removing the announcement fails the probe.

## The root: I fixed instances of a class I had already named, in the same unit

This unit's whole subject is that **a hand-picked subset always looks complete from the inside**.
It replaced an enumerated coalesce key with a payload-derived identity, and its commit messages say
so at length.

Then it shipped `payAdvance` into a system with **four** hand-kept registries and registered it in
none: `COMMERCIAL_QUERIES`, `COMMERCIAL_OUTBOX_OP_TYPES`, `COMMERCIAL_OP_PERMISSION`, and the
realtime refresh list in `useApiSync.ts`. The key was derived; the registrations were enumerated.

**And I had already noticed.** Head 1 fixed the project-scope teardown — another hand-kept list —
and its commit message says: *"nothing would have caught the omission… the same shape as this
unit's own root, one layer away from the keys it was written to fix."* I wrote that, fixed that one
instance, and did not go looking for the other four.

> **Naming a root is not searching for it.** The search is a separate act, and it is the one that
> pays. After finding one instance of a class, enumerate the class — grep for the other registries,
> the other teardown lists, the other places the same fact must be written twice.

**What replaces it.** `COMMERCIAL_OP_PERMISSION` moved into `commercialKeys.ts` beside
`COMMERCIAL_OUTBOX_OP_TYPES` — two registries that must agree, now in one file — and
`commercial.test.ts` asserts the two sets are **identical**, plus that every declared permission is
one `ROLE_POLICY` actually defines. An op half-wired into one registry now fails a test rather than
shipping.

## Root 2 — my corrections created the next round's findings

Findings 9 and 11 are consequences of fixes 7 and 8. That is the second occurrence in two units:
`pr-321-convergence.md` records the same thing (round 1's fix taught the command a condition it did
not teach the read).

- **9**: fix 7 made a failed read retryable by triggering on `advancesLoad === 'error'` — a **state
  the retry itself reproduces**. Error → effect → loading → error, hammering the endpoint.
  *An effect gated on a state its own action recreates is a loop by construction.* Retry now fires
  on the **event** of entering the tab, never on the state.
- **11**: fix 8 asked "is the read ready?" Codex found two more ways that can be true while the list
  is wrong — another client's advance, and the operator's own queued one. Adding two conjuncts would
  have been this unit's root a third time, so the question is derived instead: **the position is
  current exactly when the list reflects every advance that exists**, which it cannot if the read
  never landed or one of ours is still queued.

## Self-caught while fixing round 2

The retry rewrite dropped `tab === 'payments'` from the idle branch, so the screen fetched advances
from **every** tab on mount. Caught by two unrelated attribution tests failing — not by reading the
diff. Recorded because it is the third time in this PR that a fix introduced a defect, and the
pattern in all three is the same: I edited a condition without re-reading the whole condition.

## Verification

- `pnpm check` EXIT 0 — web 737/737, API 781/781 (head 2); re-run on head 3.
- web `commercial` · `commercial-screen` · `commercial-verification` **194/194**.
- The derived-key probes are mutation-tested against the round-4 enumeration; restoring it turns
  them red. They assert the **property** (a field added joins the identity), not the field list.
- The registry-agreement probes fail if an op is added to either list alone — verified by removing
  `payAdvance` from each in turn.

## Findings 1–2, and the check that could not fail

`this.get` and the missing import were ordinary mistakes. What made them reach CI was the
verification line: `npx tsc … | grep … ; echo TSC-DONE`. **`echo` runs unconditionally**, so the
success marker was independent of the thing checked, and I read it as a pass twice.

Same family as a probe that cannot fail, and as the earlier `pnpm check | grep` reporting exit 0
while the real exit was 2. **A check is only evidence if its output could have come out
differently.** Gating runs now capture `$?` directly. Also: `tsc -p <project>` reported clean where
`tsc -b` — what `pnpm check` runs — did not.
