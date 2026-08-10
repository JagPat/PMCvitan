# PR #317 — convergence audit (Phase 5 Task 7B-iv)

Three finding-bearing heads, nine findings. Written because a third isolated patch is exactly what
this repository's convergence rule exists to stop — and because most of them are recurrences of
roots already named in this lineage, which is worth saying plainly rather than filing as new.

**Round 3 outcome: the §I payment-rule grant surface is PARKED as 7B-v, not patched a third time.**
Rationale in §"Round 3" below and in `docs/reviews/phase-5-t7b-v-parked-findings.md`.

| # | Head | Finding | Root |
|---|---|---|---|
| F1 | `be53825` | advances survive a project switch (state **and** load status) | teardown coverage |
| F2 | `be53825` | `deduct` does not yield to a pending `approve` | **coverage** (named in #316) |
| F3 | `be53825` | the payment-rule grant has no surface at all | **new-value-vs-new-control** |
| F4 | `be53825` | freshness compared without direction | **temporal** (named in #316) |
| A | `2a2f66a` | the payment-rule grant carries *certification's* window | **new-value-vs-new-control** |
| B | `2a2f66a` | the grant key blocks behind transitions, not fold writes | **coverage** (named in #316) |
| F1 | `46464da` | the grant gate arbitrates on status, ignoring the revision it pins | **coverage** / fidelity |
| F2 | `46464da` | the payment window admits claims with zero approvable left | **coverage** |
| F3 | `46464da` | the picker offers actors the rule cannot excuse (needs a SERVER guard) | **coverage** |

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

## Round 3 — the audit above committed the error it was describing

Round 2 (this document, one head earlier) ended with:

> *when a control gains a second rule, re-derive every precondition per rule — the window it is
> legal in, the conflicts that invalidate it, and the sentence that explains the refusal.*

Three preconditions, enumerated, and called the rule. Round 3 then found three more on the same
surface: the **revision pin** (F1), the **remaining approvable headroom** (F2), and **who the rule
can excuse** (F3). So the rule written to fix a coverage failure was itself a coverage failure —
a list of the preconditions I had in mind, presented as the set. This lineage has recorded that
shape once before, in `pr-310-convergence.md`: *fix the instance not the class … again in round 4
INSIDE the round that named it.* This is its second occurrence, and enumerating a fourth time is
the move that has now failed twice.

**What replaces enumeration.** A grant's preconditions are not a list to remember; they are
derivable from what the server does when the grant is SPENT. A payment-rule authorisation is
issuable only if it could actually be consumed at spend time: the act is legal, a positive amount
remains approvable, the actor IS the certifier the rule blocks, and the pins still match the
server's current reading. One predicate, one place for a fifth condition to land.

**Why parked rather than fixed here.** F3 needs a **server guard** — `approve()` consumes a grant
only when `certificate.certifiedById === actor`, and a command that accepts an unspendable grant is
the defect whether or not a form offers it. PR #317 is read + UI over already-cleared facts, so a
server authority change does not belong in it. That is the 7B-iii-h / 7B-iii-g seam, drawn for the
identical reason (R5-2 needed a schema change), and it is also why 7B-iii-f split this very surface
out at its round 5. Three units in a row is no longer a coincidence to note — it is the seam.

The surface is parked WHOLE at the reviewed head with all five findings named and unfixed
(`claude/phase5-task7b-v-sod-payment-parked`), so nothing known-broken ships and nothing is
reconstructed from memory. PR #317's form issues the certification rule only and **says so on the
surface**; the payments tab still reports the payment-rule refusal accurately. An accurate refusal
with no in-app remedy is a gap, stated in the screen and here. A form that offers the authority and
writes a grant nobody can spend is a defect. This takes the gap.

## Verification

Round 2's findings were reproduced RED at `2a2f66a` before either fix — 6 failing assertions, each
on its own finding — then GREEN. Round 2's finding B (the grant conflict set) **stays fixed** in
this PR: it applies to the certification rule too, and its probes are unchanged. Round 2's finding A
leaves with the parked surface, since it was the payment rule's window.

Web suites 732/732 after the park.
