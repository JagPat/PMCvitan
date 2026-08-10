# PR #316 — convergence audit

Two finding-bearing heads, thirteen findings. The protocol says stop patching and say what is
actually going wrong. One root explains nine of the thirteen, and it is not "I forgot a check".

| Head | Findings |
|---|---|
| `979b49d` | 7 — the release third of the child-key division · reason required for judgement withholdings · the advance key had no release path · approve with no live payable · payment over its approval · reversal over its payment · release over its withholding |
| `df8c1bb` | 6 — withholding not gated on net payable · payment from a superseded authority · `Number` loses paisa on large values · approve from a stale claim copy · certifier self-approving · advance requires a claim to exist |

---

## Root — I applied each rule to the controls I was thinking about, not to the set

Six controls, and roughly five preconditions each: authority, pending-conflict, viewed-fact
freshness, shape, and **balance**. Thirty rule-applications. I wrote them **control by control**, so
every rule I discovered was applied to the controls in front of me at that moment and to no others.

The evidence is that the same rule keeps arriving twice:

| Rule | Applied first at | Missed at | Found by |
|---|---|---|---|
| a child-keyed command must be visible to the fold rule | payment, reversal | **release** | round 1, F1 |
| every new coalesce key needs a settling read | deduction, approve, release, pay, reverse | **advance** | round 1, F3 |
| compare the typed amount against the ledger balance | approve, pay, reverse, release (round 1) | **deduction** | round 2 |
| act only from an authoritative claim copy | the §I grant form, one unit earlier | **approve** | round 2 |

Round 1's own packet called F4–F7 "one mistake made four times" and fixed it in four places —
**and left the fifth control out of the sweep it had just named.** That is the root stated as
precisely as I can: the fix travelled to the instances I was holding in mind, and the sweep was a
sentence rather than a mechanism.

### Two of the misses are rules from the *previous* unit

- **round 1 F3** is 7B-iii-g's F2 (*a key with no release path is not pending, it is stuck*),
  recurring on a key I added one unit later.
- **round 2's stale-copy finding** is the same `arbitrateBillCopy` gate 7B-iii-g added to the §I
  grant form after its own review named it.

A lesson recorded in a packet does not travel by itself. It travels when a mechanism carries it.

---

## What changes, rather than a promise to sweep harder

**One precondition table for all six controls.** Every gate is computed in a single block keyed by
control, so a rule is written once as a row and every control that needs it takes it there. A
control missing a rule becomes a visible hole in a table instead of an absence nobody can see. This
is the same instrument round 4 of PR #312 arrived at — enumerate the artifact against every guard —
applied here at the point the enumeration is *executed* rather than described.

**Exact decimal comparison, from the module that already had it.** `lib/decimal.ts` exposes
bigint-scaled `decGt`/`decSub`; my round-1 helper converted through `Number` and lost paisa on large
values. The right tool was one import away, and reaching for `Math.round(Number(v) * 100)` on a
money surface is the same class of mistake as the rest of this audit: solving locally what the
codebase had already solved.

**The advance control moves off the claim panel.** `payAdvance` takes a `vendorId` and exists for
cash paid *before* any claim — deriving the vendor from an open claim made the workflow unreachable
in exactly the case it is for. That is not a missing check; it is a control placed inside the wrong
scope, and the table made it obvious because the advance row needs none of the claim preconditions.

**Checkable form, for the next unit:** *when a rule is discovered, apply it by editing the table row
it belongs to — never by editing the control that revealed it.*

---

## What this head does NOT do

It does not add a client-side model of §I standing. The certifier-self-approval gate compares
`certifyPreflight.callerActorId` with the certificate's own `certifiedById` — two facts the server
already put in the bundle — and refuses that pairing unless a live grant is reported. It does not
attempt to decide whether an override *would* be granted; that remains the server's, per 7B-iii-g's
F6.
