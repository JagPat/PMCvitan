# PR #317 — convergence audit (Phase 5 Task 7B-iv)

Two finding-bearing heads, six findings. Written because a third isolated patch is exactly what
this repository's convergence rule exists to stop — and because four of the six are recurrences of
roots already named in this lineage, which is worth saying plainly rather than filing as new.

| # | Head | Finding | Root |
|---|---|---|---|
| F1 | `be53825` | advances survive a project switch (state **and** load status) | teardown coverage |
| F2 | `be53825` | `deduct` does not yield to a pending `approve` | **coverage** (named in #316) |
| F3 | `be53825` | the payment-rule grant has no surface at all | **new-value-vs-new-control** |
| F4 | `be53825` | freshness compared without direction | **temporal** (named in #316) |
| A | `2a2f66a` | the payment-rule grant carries *certification's* window | **new-value-vs-new-control** |
| B | `2a2f66a` | the grant key blocks behind transitions, not fold writes | **coverage** (named in #316) |

## Root 1 — coverage, for the third time in this lineage

`pr-316-convergence.md` named it: *a rule reached the controls I was holding in mind, not the set.*
F2 and B are the same defect at two different levels, and neither is a new lesson.

- **F2**: round 4 established that a conflict between two commands is not one-directional unless
  the bounds make it so, and closed supersede/pay both ways. This pair was left half-closed.
- **B**: the grant conflict rule blocked behind `isBillTransitionPending` — the movers I had in
  mind. But `resolveGrantForRule` pins `(status, lifecycleVersion)`, and the revision advances on
  every *fold* write too. The set is "everything that moves the pinned facts", which is
  `isClaimMoneyPending`.

The correction widens B for **both** §I rules, not only the payment rule the finding named, because
the pinning is rule-independent — it is `asOf`, not the rule. Fixing only the rule named would have
reproduced this very root inside the patch that closes it, which is what #310's audit recorded
happening once already ("fix the instance not the class … again in round 4 INSIDE the round that
named it").

## Root 2 — a second rule on a shared control is a second control

This is the new one, and F3 and A are one root at two distances from it.

7B-iv added `certifier-may-not-approve` to the §I grant form. I treated it as a new **value** of an
existing control. It is a new **control**: an authorisation's preconditions belong to the act it
authorises, and the two rules authorise different acts.

- **F3** — the value did not exist at all, so the payments surface named a remedy with no path.
- **A** — the value existed but inherited the first rule's precondition. `certifiable` is derived
  from `BILL_CERTIFY_FROM = ['verified']`, and a payment exception is needed once the claim is
  **certified** — precisely when that window has closed. The windows are disjoint at exactly the
  state that matters, so the one grant a one-person pilot cannot do without was unreachable.

What A cost that F3 did not: F3 was visibly missing, A *looked* finished. The option rendered, the
form validated, and a test asserted it enabled — on a `verified` claim, where a payment grant pins
a status certification is about to move and could never be spent. **That test asserted the defect.**
It is corrected here rather than deleted, and the two states are now asserted separately.

The rule this leaves behind: *when a control gains a second rule, re-derive every precondition per
rule — the window it is legal in, the conflicts that invalidate it, and the sentence that explains
the refusal. Inheriting any of the three from the first rule is a silent assumption that the two
rules authorise the same act.*

## The observation across three units, not one

The §I grant surface has now drawn the majority of findings in **three** consecutive units:
7B-iii-f (five rounds, then split out whole as 7B-iii-h), 7B-iii-g, and 7B-iv. That is not three
unrelated accidents.

A grant is an authorisation *about another act*. Every one of its properties — who may issue it,
when it is legal, what invalidates it, what it pins — is therefore tempting to borrow from that
act instead of deriving it for the grant itself. Borrowing is right for some (who may be named is
genuinely the act's authority, which is why the candidate list is computed server-side beside the
predicate) and wrong for others (the window, the conflict set). The surface is hard because that
line has to be drawn property by property, and nothing about the code makes the borrowed ones look
different from the derived ones.

## Verification

Both findings reproduced RED at `2a2f66a` before either fix — 6 failing assertions, each on its own
finding — then GREEN. Web suites 736/736.
