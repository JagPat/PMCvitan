# Phase 5 Task 7B-vi — the §H vendor advance surface

**The last unit of Phase 5.** One user workflow: paying an advance to a counterparty, and seeing
what each counterparty already holds.

Base `main` `fe662ba`. Discharges `docs/reviews/phase-5-t7b-vi-parked-findings.md`; the surface is
recovered from the parked head `be2ba1c` rather than rebuilt from memory, which is what parking it
whole was for.

## Constraint 1 — the READ lands first, and that ordering is the finding

`GET commercial/advances` and `listAdvances` were removed with the control at the 7B-iv split, so
`POST commercial/advances` was all that survived. That left the control's write-ahead key with **no
settling read**: an advance names a counterparty and no claim, so no other commercial read can clear
it. A key with no release path is not "pending" — it is stuck, and the button never re-enables.
That is 7B-iii-g's F2 for the third time in this phase.

So the read lands with the control, and the settling path lands before both:

- `readClearsKey` gains an `advances` arm; `CommercialRead` gains an `{ read: 'advances' }` variant.
  The union is discriminated, so **adding a read without deciding what it settles does not compile.**
- The arm clears every `com:advance:` key rather than one row's, because the read carries the whole
  project's advances — settling only the row a caller named is how a key whose row did not survive
  gets stuck (round 4's lesson on the payer's keys).

## Constraint 2 — the identity is DERIVED, not enumerated

`pr-317-convergence.md` records this lineage failing **four times** at hand-listing the facts that
define a row: round 2 listed three preconditions and called it the rule, round 3 found three more,
round 4 widened the advance key to `(vendor, amount, reason)`, round 5 found the two that list
omitted. A hand-picked subset always looks complete from the inside — which is why a fifth list
would fail the same way.

```
payloadCoalesceKey(action, scope, input) = `com:${action}:${scope}:${canonicalPayload(input)}`
```

For a command whose identity IS its payload, two dispatches are the same action only if they are the
same input. `canonicalPayload` is injective: object keys sorted so field order cannot change the
identity, strings JSON-escaped so no value can impersonate a separator. **`method` and `reference`
join because they are in the input, and so would a sixth field.**

### Why the scope prefix survives

The obvious reading of "derive the whole key" produces an opaque hash — and that would have
satisfied the identity requirement while silently breaking every predicate that reads the key's
*shape*. `isBudgetPendingForHead` asks "any budget set for this head, at any amount" by prefix.

Stable prefix for the predicates, derived tail for the identity. Neither half is droppable, and that
only surfaced by reading what **consumes** the key rather than the key's own definition.

## A second command had the same defect

The parked ledger told this unit to check whether any other append-only §M command shared the shape.
`setBudgetSchema` carries `costHeadCode`, `amount` **and** `reason`; `budgetCoalesceKey` enumerated
the first two. Correcting a head's reason at the same amount coalesced with the pending first and
was silently dropped.

Fixed through the same helper — the class, not the member. Worth noting *how* it was found: by a
question a previous round wrote down for its successor, not by a review round finding it. That is
the parked-ledger practice doing the job it exists for.

## The project-scope teardown is an enumeration too

`projectScope.ts` lists the fields a project switch clears, one by one. Advances are cash paid to a
counterparty **on this project**, so both the value and its load status join all four places it
enumerates.

Stated rather than quietly fixed, because **nothing would have caught the omission**: the compiler
accepts a missing key in a teardown literal built from a wider type, no existing probe switches
projects with advances loaded, and the leak only shows with two projects and real cash on both. Same
shape as this unit's own root, one layer away from the keys it was written to fix.

## The control

Renders the **rows**, not only each counterparty's position. Every other way cash leaves this
project has a certificate or an approval explaining it; an advance has neither, so its row *is* that
evidence — when a balance moved, how, and under what reference. A total cannot be audited back to a
payment.

The form offers `reference`, which the parked version did not. `reference` is part of the command and
therefore part of its derived identity, so a form that could never set it would leave half the fix
unreachable from the app — and a fix you cannot exercise is hard to distinguish from one that is not
there. The button keys on the same object the command carries, so the disable test and the outbox
entry cannot describe two different actions.

## Verification

Every probe **mutation-tested** against the round-4 enumeration (`vendor:amount:reason`) — restoring
it turns them red. They assert the **property** (a field added joins the identity) rather than the
field list, because asserting the list would be the same enumeration one level up, in the test.

| Gate | Result |
|---|---|
| web `commercial` · `commercial-verification` · `commercial-screen` | see PR body |
| `pnpm check` | see PR body |
| full integration (live PG) | see PR body |
| `test:automation` | 200/200 |

**No migration, no schema change.** One additive contract type (`VendorAdvanceListDto`), one
restored read, one derived-identity helper, one control.

## A correction to an earlier claim in this branch's history

Commit `3fcd9c7`'s message on PR #321 said the `open_pr: PRNUM` placeholder "fails `automation` by
design, so the number cannot be forgotten". **That is false** — `test:automation` passes 200/200 with
the placeholder in place. Nothing catches it; filling in the number is a deliberate step, not an
enforced one. Recorded here because an unchecked claim about what a gate enforces is exactly the
class of error this phase's convergence audits are about, and it would otherwise sit in the history
as a guarantee that does not exist.
