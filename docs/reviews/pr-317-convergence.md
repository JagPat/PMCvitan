# PR #317 — convergence audit (Phase 5 Task 7B-iv)

Five finding-bearing heads, thirteen findings — the review lifecycle's limit. Written because
repeated isolated patching is exactly what this repository's convergence rule exists to stop, and
because nearly all of these are recurrences of roots already named in this lineage.

**The unit is now SPLIT**, at the seam this document named at round 4: 7B-iv was three workflows
wide. The §I payment-rule grant surface is parked as **7B-v** and the vendor advance as **7B-vi**,
each whole at its reviewed head with its findings named. What remains is one workflow — the
approver's authority.

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
| F1 | `0b4376a` | the self-approval remedy names an option the park removed | **coverage**, inside the park |
| F2 | `0b4376a` | the advance surface shows totals, never the rows | scope (advance as supporting character) |
| F3 | `0b4376a` | the advance key coalesces two distinct advances by vendor | **enumeration** |
| — | `be2ba1c` | the widened advance key still omits method/reference | **enumeration**, inside its own fix |

## Root 1 — coverage, for the third time in this lineage

`pr-316-convergence.md` named it: *a rule reached the controls I was holding in mind, not the set.*
Round-1 F2 left the deduct↔approve conflict half-closed after an earlier round had established that
conflicts are not one-directional unless the bounds make them so. Round-2 B blocked a grant behind
`isBillTransitionPending` — the movers I had in mind — when `resolveGrantForRule` pins
`(status, lifecycleVersion)` and every *fold* write moves the revision too; the set is
`isClaimMoneyPending`.

B is widened for **both** §I rules, not only the one named, because the pinning is `asOf` rather
than the rule. Fixing only the named rule would have reproduced this root inside the patch closing
it — what #310's audit recorded happening once already.

## Root 2 — a second rule on a shared control is a second control

7B-iv added `certifier-may-not-approve` to the §I grant form. I treated it as a new **value** of an
existing control; it is a new **control**, because an authorisation's preconditions belong to the
act it authorises and the two rules authorise different acts. Round-1 F3 was the value missing
entirely; round-2 A was the value present but inheriting `BILL_CERTIFY_FROM`, whose window closes
exactly when a payment exception is needed.

What A cost that F3 did not: F3 was visibly missing, A *looked* finished. The option rendered, the
form validated, and a test asserted it enabled — on a `verified` claim, where the grant pins a
status certification is about to move. **That test asserted the defect.** Corrected, not deleted.

## The observation across three units, not one

The §I grant surface has drawn the majority of findings in **three** consecutive units: 7B-iii-f
(five rounds, split out whole as 7B-iii-h), 7B-iii-g, and 7B-iv. A grant is an authorisation *about
another act*, so every property — who may issue it, when it is legal, what invalidates it, what it
pins — is tempting to borrow from that act rather than derive for the grant. Borrowing is right for
some (who may be named IS the act's authority) and wrong for others (the window, the conflict set),
and nothing in the code makes the borrowed ones look different from the derived ones.

## Round 3 — the audit above committed the error it was describing

Round 2 ended by telling itself to *"re-derive every precondition per rule — the window, the
conflicts, and the sentence that explains the refusal"*: three preconditions, enumerated, called
the rule. Round 3 found three more on the same surface — the **revision pin**, the **remaining
approvable headroom**, and **who the rule can excuse**. The rule written to fix a coverage failure
was itself one. `pr-310-convergence.md` records this shape once already; this is its second
occurrence, and enumerating a fourth time is the move that has now failed twice.

**What replaces enumeration** (detail in `phase-5-t7b-v-parked-findings.md`): derive the
preconditions from what the server does when the grant is SPENT, as ONE predicate rather than a
list — the act is legal, a positive amount remains approvable, the actor IS the certifier the rule
blocks, and the pins still match. One place for a fifth condition to land.

**Why parked rather than fixed here.** F3 needs a **server guard** (`approve()` consumes a grant
only when `certificate.certifiedById === actor`), and this unit is read + UI over cleared facts —
the 7B-iii-h/g seam, drawn for the identical reason. 7B-iii-f split this same surface at its round
5, so three units in a row is the seam, not a coincidence. Parked WHOLE at the reviewed head with
all five findings named, so nothing known-broken ships. The form issues the certification rule only
and says so; an accurate refusal with no in-app remedy is a gap, and a form that writes a grant
nobody can spend is a defect. This takes the gap.

## Round 4 — the park's own loose end, and why the advance was NOT parked too

Three findings on `0b4376a`. One is the park's loose end and two are the advance.

**F1 — the remedy copy.** The payments tab still told a self-approving certifier to use an option
round 3 had just removed. My round-3 commit claimed that tab "still reports the payment-rule refusal
accurately"; the *refusal* was accurate and the *remedy* was not. **Coverage again, inside the
park** — I updated the form's copy and not the copy pointing at it. It now names the API path and
7B-v, which is what is true.

**F2/F3 — the advance.** The surface rendered only the aggregated position, never the rows (an
advance has no certificate or approval behind it, so its row *is* the evidence for cash leaving);
and its coalesce key was vendor-only, so a second legitimate advance to one counterparty was
undispatchable — PR #208's finding 1 in a new place. The value now joins the identity exactly as
`budgetCoalesceKey` does.

**Why the advance was not parked too — a call round 5 REVERSED, left here rather than rewritten.**
The reasoning was that the round-3 park earned its place on five findings plus a server change,
while these two were client-only, small and precedented, and comment prose could fund them without
touching logic. That was defensible on the evidence then available and wrong on the next head: the
key fix reproduced the same enumeration root one round later, which is exactly what "two findings
on one surface" was signalling. Recorded as a reversal because a decision log that quietly deletes
its wrong calls teaches nothing.

**The honest root of all of it.** Four rounds and twelve findings on one unit is not four unrelated
lapses; it is a unit that was three workflows wide. Merging `7B-iii-d-ii` into `7B-iv` was my
recommendation, and produced a PR carrying contract facts, an approval chain, a vendor advance, a
browser chain and a packet. The parks and trims correct that scoping call, not the code.

## Round 5 — the enumeration failed again, in the fix for the enumeration failure

One finding: the advance key I had just widened to `(vendor, amount, reason)` still omits `method`
and `reference`, so two advances differing only in those collapse to one key and the second is
dropped.

That is the same root for the fourth time, and this time inside its own correction. Round 2 listed
three preconditions and called it the rule; round 3 found three more; round 4 listed two
row-defining facts; round 5 found the two that list omitted. **This document told itself two rounds
ago that "enumerating a fourth time is the move that has now failed twice", and round 4 enumerated
anyway.** Writing the rule down did not prevent the behaviour, because a hand-listed subset always
*looks* complete from the inside — that is the property that makes this root recur.

The fix is not to add the two missing fields. It is the one this document already prescribed:
**derive the identity, do not enumerate it.** For an append-only fact with no server ceiling, two
dispatches are the same action only if they are the same payload, so the coalesce identity should
be a deterministic function of the WHOLE command input. A sixth field then joins automatically,
which is the property every enumeration here lacked. That work is 7B-vi's.

### The split, taken rather than argued with

This head reached the review lifecycle's limit — **5 finding-bearing heads, 13 findings** — and the
orchestrator advised splitting. The unit is now split at the seam this document named two rounds
ago: **7B-iv was three workflows wide.** The vendor advance is parked whole as **7B-vi**
(`claude/phase5-task7b-vi-advance-parked`, at the reviewed head `be2ba1c`) with its finding named
and the derived-identity prescription recorded, exactly as 7B-v was.

What remains in #317 is one workflow — the approver's authority: the two contract facts
(`lifecycleVersion`, `approvePreflight`), the approve control gated on them, and the pilot chain.
17 files, 1,147 lines. §H advances stay fully available through the API, which is how the chain
exercises them; the §M surface simply does not offer that control until 7B-vi lands.

**The decision was pre-registered.** Before this round's findings arrived, the standing instruction
for "if round 5 produces findings" already said to split rather than patch a fifth time — written
down precisely so the choice would not be made under pressure with a nearly-full budget. Following
it cost nothing that arguing for one more patch would have saved.

## Verification

Round 5 is answered by the split: the advance surface and its open finding leave whole, so nothing
known-broken ships and no fifth enumeration was attempted. Round 4's F1 (the remedy copy) stays
fixed here — it is the approve chain's. Round 4's F2 and F3 were reproduced RED at `0b4376a` before
either fix, each on its own finding, and leave with the parked surface. Round 2's findings were reproduced RED at `2a2f66a` before either fix — 6 failing assertions, each
on its own finding — then GREEN. Round 2's finding B (the grant conflict set) **stays fixed** in
this PR: it applies to the certification rule too, and its probes are unchanged. Round 2's finding A
leaves with the parked surface, since it was the payment rule's window.

Web suites 732/732 after the park.
